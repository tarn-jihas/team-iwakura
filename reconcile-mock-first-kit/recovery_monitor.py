"""Small live incident feed assembled from durable recovery records."""
from datetime import datetime, timezone
import json

import recovery_domain as domain
import recovery_live
import recovery_scenarios


def _time(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return None


def _cause(snapshot, incident):
    if not snapshot:
        return ('Checking the reported access problem',
                'Waiting for the incident scan to collect source and Lumen evidence.')
    clients = {row['user_id']: row for row in snapshot.get('lumen_accounts', [])}
    accounts = [row for row in snapshot.get('accounts', []) if row.get('status') == 'confirmed']
    if not accounts:
        return ('Access problem needs investigation',
                'The scan did not confirm an account with current source-backed access, so no cause or repair is claimed.')
    if all(account.get('payment_state') == 'paid' and account.get('adapty_active') is False
           for account in accounts):
        return ('Purchase recorded, but access was not activated',
                'At detection, provider records showed a current paid period, but the matching Adapty access was missing. The product-mapping and purchase-validation checks below show the recovery result.')
    local = [clients.get(row['id'], {}) for row in accounts]
    gates = [row.get('gate', {}) for row in local]
    observed = set()
    for account, client, gate in zip(accounts, local, gates):
        if gate.get('reason') == 'cache_stale':
            observed.add('cache')
        elif not client.get('access_active'):
            observed.add('projection')
        elif gate.get('reason') == 'subscription_expired' or (
                gate.get('allowed') is True and account.get('projection_matches_source_period') is False):
            observed.add('period')
        else:
            observed.add('access')
    if len(observed) > 1:
        return ('Multiple application access inconsistencies',
                'Individual accounts have different observed projection, cache or period mismatches. A shared cause has not been established.')
    if observed == {'period'} and any(gate.get('allowed') is True for gate in gates):
        return ('Lumen access period differs from Adapty',
                'The local period does not match the current source period, even though access is still allowed. No customer denial is claimed.')
    if observed == {'projection'}:
        return ('Lumen had not applied subscription access',
                'At detection, Adapty showed active subscription access, but Lumen had not saved it for these accounts. The recorded checks show what happened next.')
    if any(row.get('reason') == 'cache_stale' for row in gates):
        return ('Lumen checked an outdated copy of access',
                'At detection, Adapty showed active access, but Lumen used an outdated cached value and denied Premium export.')
    if any(row.get('reason') == 'subscription_expired' for row in gates):
        return ('Lumen used an outdated subscription expiry',
                'At detection, the subscription was active in Adapty, but Lumen used an earlier expiry date and denied Premium export.')
    return ('Active subscription, but Premium access was denied',
            'The scan confirmed active Adapty access and a denied Premium request in Lumen. The checks have not identified a more specific cause.')


STEP_LABELS = {
    'repair_catalog': ('Repair the Adapty catalog mapping', 'Adapty'),
    'validate_purchase': ('Validate the paid purchase', 'Adapty'),
    'resync_access': ('Resync Lumen access from Adapty', 'Lumen'),
    'verify_gate': ('Verify the premium gate', 'Lumen'),
}
STEP_ORDER = ('repair_catalog', 'validate_purchase', 'resync_access', 'verify_gate')
REASONS = {
    'cache_stale': 'Lumen cache was still stale',
    'subscription_inactive': 'Lumen still saw no active subscription',
    'probe_unavailable': 'Lumen gate could not be reached',
    'no_safe_targets': 'No account was safe to repair automatically',
    'fresh_assessment_has_no_safe_retry': 'A fresh check found no account that is safe to retry',
    'retry_left_unresolved_targets': 'The automatic retry finished, but some accounts are still denied',
    'retry_already_used': 'The single automatic retry was already used',
    'confirmed_targets_outside_safe_policy_scope': 'Some confirmed accounts are outside the automatic policy',
    'execution_result_unavailable': 'The repair result could not be read back',
    'job_failed': 'The repair job failed',
    'automatic_policy_scope_changed': 'The automatic policy scope changed',
}


def _reason(value):
    if not value:
        return None
    text = str(value)
    return REASONS.get(text, text.replace('_', ' '))


def _action_reason(action):
    try:
        result = json.loads(action['result']) if action and action.get('result') else {}
    except (TypeError, json.JSONDecodeError):
        result = {}
    if not isinstance(result, dict):
        return None
    return _reason(result.get('reason') or result.get('error'))


def _timeline(row, incident, snapshot, decisions, plans, actions_by_id, sdk_events, trigger_event):
    """Readable, ordered recovery steps built only from durable engine records."""
    if trigger_event is None:
        if incident.get('trigger_event_id'):
            first_step = {'step': 'Trigger event unavailable', 'owner': 'Reconcile',
                'status': 'failed', 'at': row['created_at'],
                'detail': 'The incident references a trigger event that is not available in its stored run scope.'}
        else:
            first_step = {'step': 'Incident opened manually', 'owner': 'Reconcile',
                'status': 'ok', 'at': row['created_at'],
                'detail': 'No triggering customer event is recorded for this incident.'}
    else:
        event_kind = trigger_event.get('kind')
        details = trigger_event.get('details') or {}
        at = trigger_event.get('occurred_at')
        if (event_kind == 'feature_access_decided' and details.get('decision') == 'deny'
                and details.get('initiator') == 'customer_demo'):
            first_step = {'step': 'Customer denied at the Lumen gate', 'owner': 'Lumen SDK',
                'status': 'ok', 'at': at,
                'detail': f"Collector stored a Lumen access denial for {trigger_event.get('app_user_id') or 'a customer'}; "
                          'this event opened the incident.'}
        elif event_kind == 'mobile_observation' and details.get('observation_kind') == 'purchase_succeeded':
            first_step = {'step': 'Purchase success was reported', 'owner': 'Customer observation',
                'status': 'ok', 'at': at,
                'detail': 'The mobile observation reported purchase_succeeded; payment was not independently verified.'}
        elif event_kind == 'mobile_observation' and details.get('observation_kind') == 'access_denied':
            first_step = {'step': 'Access denial was reported', 'owner': 'Customer observation',
                'status': 'ok', 'at': at,
                'detail': 'The mobile observation reported an access denial; it does not establish a Lumen gate decision.'}
        else:
            first_step = {'step': 'Incident trigger recorded', 'owner': 'Collector',
                'status': 'ok', 'at': at,
                'detail': f"Collector stored {event_kind or 'an event'} ({trigger_event.get('event_id')}); "
                          'the event opened this incident.'}
    steps = [first_step]
    if snapshot is None:
        steps.append({'step': 'Scan all accounts', 'owner': 'Reconcile', 'status': 'running',
                      'at': None, 'detail': 'Collecting payment, Adapty and Lumen evidence.'})
        return steps, None
    counts = {}
    for account in snapshot.get('accounts', []):
        counts[account.get('status')] = counts.get(account.get('status'), 0)+1
    total = sum(counts.values())
    steps.append({'step': 'Scan all accounts', 'owner': 'Reconcile', 'status': 'ok', 'at': None,
                  'detail': f"{total} accounts checked · {counts.get('confirmed', 0)} confirmed broken · "
                            f"{counts.get('inconclusive', 0)} excluded until source or identity is confirmed · "
                            f"{total-counts.get('confirmed', 0)-counts.get('inconclusive', 0)} not affected"})
    plans_by_id = {plan['id']: plan for plan in plans}
    failure = None
    probe_attempts = []
    for decision in decisions:
        selected = json.loads(decision.get('selected_ids') or '[]')
        try:
            outcome = json.loads(decision['outcome_json']) if decision.get('outcome_json') else {}
        except json.JSONDecodeError:
            outcome = {}
        label = 'Automatic decision' if not decision['attempt'] else 'Automatic retry decision'
        steps.append({'step': label, 'owner': 'Reconcile policy',
            'status': 'failed' if decision['status'] == 'unresolved' and not decision.get('plan_id') else
                      'running' if decision['status'] in ('queued', 'plan_created') else 'ok',
            'at': decision.get('created_at'),
            'detail': f"Policy {decision['policy_id']} approved {len(selected)} "
                      f"{'account' if len(selected) == 1 else 'accounts'} without a human."
                      if selected else 'No account was safe to repair automatically.'})
        plan = plans_by_id.get(decision.get('plan_id'))
        if plan:
            for kind in STEP_ORDER:
                entries = [entry for entry in plan['plan'].get('entries', []) if entry.get('type') == kind]
                if not entries:
                    continue
                label, owner = STEP_LABELS[kind]
                done, failed, waiting = 0, [], 0
                for entry in entries:
                    action = actions_by_id.get(entry['id'])
                    status = action['status'] if action else 'pending'
                    if kind == 'verify_gate' and action and action.get('started_at'):
                        result = json.loads(action['result']) if action.get('result') else {}
                        probe_attempts.append({'account': entry.get('account_id'),
                            'action_id': entry['id'], 'at': action['started_at'],
                            'status': status, 'request': result.get('probe_trace'),
                            'readback': result.get('readback_gate'), 'reason': _action_reason(action)})
                    if status == 'verified':
                        done += 1
                    elif status in ('failed', 'blocked', 'unknown_outcome'):
                        failed.append({'account': entry.get('account_id') or 'catalog',
                                       'reason': _action_reason(action) or status.replace('_', ' ')})
                    else:
                        waiting += 1
                detail = f'{done} of {len(entries)} done'
                if kind == 'resync_access' and sdk_events.get('access_projection_changed'):
                    detail += f" · Lumen SDK reported {sdk_events['access_projection_changed']} projection updates"
                if failed:
                    detail += ' · failed: ' + ', '.join(f"{item['account']} ({item['reason']})" for item in failed[:5])
                    if len(failed) > 5:
                        detail += f' and {len(failed)-5} more'
                steps.append({'step': label, 'owner': owner,
                    'status': 'failed' if failed else 'running' if waiting else 'ok',
                    'at': None, 'detail': detail, 'failed': failed})
                if failed:
                    failure = {'step': label, 'owner': owner, 'accounts': failed}
        reason = _reason(outcome.get('reason'))
        if decision['status'] == 'retry_scheduled':
            steps.append({'step': 'Schedule one automatic retry', 'owner': 'Reconcile policy', 'status': 'ok',
                          'at': decision.get('updated_at'),
                          'detail': f"{outcome.get('unresolved', 0)} account(s) were not verified; retrying only those."})
        elif decision['status'] == 'unresolved':
            failure = {**(failure or {'step': label, 'owner': 'Reconcile policy', 'accounts': []}),
                       'reason': reason or 'Automatic recovery could not verify access'}
    gate_steps = [step for step in steps if step['step'] == STEP_LABELS['verify_gate'][0]]
    if gate_steps and sdk_events.get('probe_allow'):
        # Counted once for the whole incident, after any retry.
        gate_steps[-1]['detail'] += (f" · collector received {sdk_events['probe_allow']} gate allows "
                                     'for this incident in total')
    if failure and failure.get('accounts'):
        account = failure['accounts'][0]['account']
        failure['trace'] = {'account': account,
            'attempts': [attempt for attempt in probe_attempts if attempt['account'] == account],
            'affected_count': len(failure['accounts'])}
    return steps, failure


def build(engine, cursor=None, limit=None, status=None):
    manifest = engine._manifest()
    live = bool(engine.live_config and manifest.get('scenario') == 'live_adapty')
    if not live and not engine.auto_repair:
        result = {'mode': 'FULL_MOCK', 'app': {'id': manifest.get('app'),
            'title': manifest.get('app_title'), 'environment': manifest.get('environment')},
            'automation': {'enabled': False, 'policy_id': None},
            'connection': {'ready': False, 'source_observed_at': None,
                'active_accounts': 0, 'total_accounts': 0, 'cli_version': None,
                'catalog_product_count': None},
            'summary': {'incidents': 0, 'fixed': 0, 'needs_attention': 0,
                        'affected_accounts': 0},
            'telemetry': {'queued': 0, 'accepted': 0, 'dropped': 0, 'failed': 0,
                          'retries': 0, 'last_error': None},
            'simulation': {'status': 'idle', 'completed': 0, 'total': 0, 'error': None},
            'incidents': []}
        if cursor is not None or limit is not None or status is not None:
            result['pagination'] = {'cursor': '0' if cursor is None else str(cursor),
                'limit': 0 if limit is None else limit, 'next_cursor': None,
                'total': 0, 'status': status}
        return result

    requested_status = status
    paged = cursor is not None or limit is not None or status is not None
    if status is not None and status not in ('needs_attention','detecting','repairing','repaired','unresolved'):
        raise ValueError('Unsupported monitor status')
    try:
        offset = int(cursor or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError('Invalid monitor cursor') from exc
    page_limit = 50 if limit is None and paged else limit
    if offset < 0 or page_limit is not None and (isinstance(page_limit,bool)
            or not isinstance(page_limit,int) or not 1 <= page_limit <= 200):
        raise ValueError('Invalid monitor page')
    if status is not None and not paged:
        paged = True
        page_limit = 50

    try:
        source = (engine._internal_request(engine.provider_url, 'GET', '/internal/live/status')
                  if live else {})
    except Exception:
        source = {}
    try:
        telemetry = engine._internal_request(engine.lumen_url, 'GET',
                                              '/internal/lumen/collector-coverage')
    except Exception:
        telemetry = {'queued': 0, 'accepted': 0, 'dropped': 0, 'failed': 0,
                     'retries': 0, 'last_error': 'collector_unavailable'}
    try:
        simulation = (engine._simulation_summary() if live else
                      {'status': 'idle', 'completed': 0, 'total': 0, 'error': None})
    except Exception:
        simulation = {'status': 'idle', 'completed': 0, 'total': 0, 'error': None}

    db = domain.connect(engine.db_path)
    trigger_events = {}
    try:
        incident_sql = 'SELECT id,incident_json,created_at FROM incidents ORDER BY created_at DESC,rowid DESC'
        incidents = [dict(row) for row in db.execute(incident_sql)]
        incident_ids = [row['id'] for row in incidents]
        if incident_ids:
            marks = ','.join('?' for _ in incident_ids)
            trigger_incidents = {}
            for incident_row in incidents:
                incident_data = json.loads(incident_row['incident_json'])
                if incident_data.get('trigger_event_id'):
                    trigger_incidents[incident_data['trigger_event_id']] = incident_data
            if trigger_incidents:
                trigger_marks = ','.join('?' for _ in trigger_incidents)
                for trigger_row in db.execute('SELECT event_json FROM collector_events WHERE event_id IN ('+
                                              trigger_marks+')', list(trigger_incidents)):
                    event = json.loads(trigger_row['event_json'])
                    incident_data = trigger_incidents.get(event.get('event_id'))
                    if incident_data and all(event.get(key) == incident_data.get(key)
                                             for key in ('run_id', 'app', 'environment')):
                        trigger_events[incident_data['id']] = event
            # The feed needs diagnosis fields, not every immutable source profile.
            snapshots = {row['id']: {
                'manifest': json.loads(row['manifest_json'] or '{}'),
                'accounts': json.loads(row['accounts_json']),
                'lumen_accounts': json.loads(row['clients_json'])}
                for row in db.execute('''SELECT s.id,
                    json_extract(s.snapshot_json,'$.manifest') AS manifest_json,
                    (SELECT json_group_array(json_object(
                        'id',json_extract(a.value,'$.id'),
                        'status',json_extract(a.value,'$.status'),
                        'projection_matches_source_period',json(a.value -> '$.projection_matches_source_period')))
                     FROM json_each(s.snapshot_json,'$.accounts') a) AS accounts_json,
                    (SELECT json_group_array(json_object(
                        'user_id',json_extract(c.value,'$.user_id'),
                        'access_active',json_extract(c.value,'$.access_active'),
                        'gate',json_extract(c.value,'$.gate')))
                     FROM json_each(s.snapshot_json,'$.lumen_accounts') c) AS clients_json
                    FROM snapshots s WHERE s.incident_id IN ('''+marks+')',incident_ids)}
            plans = [dict(row) for row in db.execute(
                'SELECT id,incident_id,plan_json,status,created_at_wall FROM plans '
                'WHERE incident_id IN ('+marks+') ORDER BY created_at_wall,rowid',incident_ids)]
            plan_ids = [row['id'] for row in plans]
            if plan_ids:
                plan_marks = ','.join('?' for _ in plan_ids)
                actions = [dict(row) for row in db.execute('SELECT * FROM actions WHERE plan_id IN ('+
                    plan_marks+') ORDER BY rowid',plan_ids)]
            else:
                actions = []
            decisions = [dict(row) for row in db.execute(
                'SELECT * FROM automatic_recovery WHERE incident_id IN ('+marks+') ORDER BY incident_id,attempt',incident_ids)]
            job_map = {}
            for incident_id in incident_ids:
                payload = json.dumps({'incident_id': incident_id}, ensure_ascii=False,
                                     separators=(',',':'))
                for row in db.execute('SELECT id,kind,status,payload,result,error,updated_at FROM jobs WHERE payload=?',
                                      (payload,)):
                    job_map[row['id']] = dict(row)
            related_job_ids = {value for row in decisions for value in
                               (row.get('auto_job_id'),row.get('execution_job_id')) if value}
            if related_job_ids:
                ids = list(related_job_ids)
                marks_jobs = ','.join('?' for _ in ids)
                for row in db.execute('SELECT id,kind,status,payload,result,error,updated_at FROM jobs '
                                      'WHERE id IN ('+marks_jobs+')',ids):
                    job_map[row['id']] = dict(row)
            jobs = list(job_map.values())
        else:
            snapshots,plans,actions,decisions,jobs = {},[],[],[],[]
            sdk_rows = []
        sdk_rows = [] if live else [json.loads(row[0]) for row in db.execute(
            "SELECT event_json FROM collector_events WHERE json_extract(event_json,'$.kind') "
            "IN ('access_projection_changed','feature_access_decided')")]
        fulfillment_coverage = domain._meta(db,'fulfillment_coverage',{})
        fulfillment_counts = {row['status']:row['count'] for row in db.execute(
            'SELECT status,COUNT(*) AS count FROM fulfillment_expectations GROUP BY status')}
    finally:
        db.close()
    decisions_by_incident = {}
    for row in decisions:
        decisions_by_incident.setdefault(row['incident_id'], []).append(row)
    plans_by_incident = {}
    for row in plans:
        row['plan'] = json.loads(row.pop('plan_json'))
        plans_by_incident.setdefault(row['incident_id'], []).append(row)
    actions_by_id = {row['id']: row for row in actions}
    jobs_by_incident = {}
    execution_results, execution_finished = {}, {}
    for job in jobs:
        try:
            payload = json.loads(job['payload'])
            result = json.loads(job['result']) if job['result'] else None
        except (TypeError, json.JSONDecodeError):
            continue
        if payload.get('incident_id'):
            jobs_by_incident.setdefault(payload['incident_id'], []).append(job)
        if job['kind'] == 'execution' and payload.get('plan_id') and isinstance(result, dict):
            execution_results[payload['plan_id']] = result
            execution_finished[payload['plan_id']] = job['updated_at']
    feed = []
    for row in incidents:
        incident = json.loads(row['incident_json'])
        snapshot = snapshots.get(incident.get('first_snapshot_id') or incident.get('snapshot_id'))
        if snapshot is None:
            snapshot = next((snapshots.get(plan['plan']['snapshot_id'])
                for plan in plans_by_incident.get(row['id'], [])
                if snapshots.get(plan['plan']['snapshot_id'])), None)
        account_rows = [] if snapshot is None else snapshot.get('accounts', [])
        affected = sorted({item['id'] for item in account_rows
                           if item.get('status') == 'confirmed'})
        incident_plans = plans_by_incident.get(row['id'], [])
        per_account, final_by_account = {}, {}
        for plan_row in incident_plans:
            final_result = execution_results.get(plan_row['id'])
            unresolved_ids = set(final_result.get('unresolved_ids', [])) if final_result else set()
            for entry in plan_row['plan'].get('entries', []):
                if entry.get('account_id'):
                    per_account.setdefault(entry['account_id'], {})[entry['type']] = actions_by_id.get(entry['id'])
                    if final_result:
                        final_by_account[entry['account_id']] = (
                            entry['account_id'] not in unresolved_ids
                            and final_result.get('access_verified', 0) > 0)
        repaired, resynced_accounts = set(), set()
        for plan_row in incident_plans:
            for entry in plan_row['plan'].get('entries', []):
                action = actions_by_id.get(entry['id'])
                if (entry.get('type') == 'resync_access' and entry.get('account_id')
                        and action and action['status'] == 'verified'):
                    resynced_accounts.add(entry['account_id'])
        for user_id in affected:
            user_actions = per_account.get(user_id, {})
            probe = user_actions.get('verify_gate')
            probe_result = json.loads(probe['result']) if probe and probe.get('result') else {}
            resync = user_actions.get('resync_access')
            if (probe and probe['status'] == 'verified' and probe_result.get('allowed') is True
                    and (resync is None or resync['status'] == 'verified')
                    and final_by_account.get(user_id) is True):
                repaired.add(user_id)
        incident_decisions = decisions_by_incident.get(row['id'], [])
        latest_decision = incident_decisions[-1] if incident_decisions else None
        try:
            policy_result = json.loads(latest_decision['outcome_json']) if latest_decision and latest_decision['outcome_json'] else {}
        except json.JSONDecodeError:
            policy_result = {}
        policy_repaired = bool(latest_decision and latest_decision['status'] == 'completed'
            and policy_result.get('access_verified') == policy_result.get('target_count')
            and not policy_result.get('unresolved')
            and affected and len(repaired) == len(affected))
        incident_jobs = jobs_by_incident.get(row['id'], []) + [job for job in jobs
            if any(decision['auto_job_id'] == job['id'] or decision.get('execution_job_id') == job['id']
                   for decision in ([latest_decision] if latest_decision else []))]
        active = any(job['status'] in ('queued', 'running') for job in incident_jobs)
        assessment_failed = next((job for job in reversed(incident_jobs)
                                  if job['kind'] in ('incident', 'scan')
                                  and job['status'] == 'failed'), None)
        if policy_repaired:
            assessment_failed = None
            status = 'repaired'
        elif assessment_failed:
            status = 'unresolved'
        elif incident.get('status') == 'queued' or snapshot is None:
            status = 'detecting'
        elif active or (latest_decision and latest_decision['status'] in
                        ('queued', 'plan_created', 'awaiting_execution', 'retry_scheduled')):
            status = 'repairing'
        elif affected and len(repaired) == len(affected):
            status = 'repaired'
        else:
            status = 'unresolved'
        title, description = _cause(snapshot or {}, incident)
        if assessment_failed:
            title = 'The incident scan did not complete'
            description = 'Source evidence could not be collected, so no access repair was attempted.'
        action_feed = []
        action_started = []
        for action in actions:
            if action['plan_id'] not in {plan['id'] for plan in incident_plans}:
                continue
            action_feed.append({key: action[key] for key in
                ('owner', 'status', 'started_at', 'finished_at', 'evidence_ref')})
            if action.get('started_at'):
                action_started.append(action['started_at'])
        detected_at = row['created_at']
        repair_started_at = min(action_started) if action_started else None
        repaired_at = None
        if status == 'repaired':
            if policy_repaired:
                repaired_at = latest_decision['updated_at']
            else:
                finished = [execution_finished[plan['id']] for plan in incident_plans
                            if plan['id'] in execution_finished]
                repaired_at = max(finished, key=lambda value: _time(value) or datetime.min.replace(tzinfo=timezone.utc)) if finished else None
        detected, repaired_time = _time(detected_at), _time(repaired_at)
        duration_ms = (max(0, round((repaired_time-detected).total_seconds()*1000))
                       if detected and repaired_time else None)
        snapshot_manifest = (snapshot or {}).get('manifest', {})
        provenance = snapshot_manifest.get('provenance')
        payment = snapshot_manifest.get('payment_verification') or (
            recovery_live.PAYMENT_VERIFICATION
            if provenance == recovery_scenarios.PROVENANCE else None)
        if status == 'repaired':
            next_step = 'None. Lumen access was verified.'
        elif status == 'unresolved':
            next_step = ('Restore source connectivity and rerun the incident scan.' if assessment_failed else
                         'Review the current Adapty entitlement, customer mapping and Lumen policy; retry after they agree.')
        elif status == 'repairing':
            next_step = 'Waiting for the Lumen gate verification to finish.'
        else:
            next_step = 'Waiting for enough source and customer event evidence to finish the scan.'
        if repaired:
            if resynced_accounts:
                summary = (f'Refreshed local Lumen entitlement projections from current Adapty evidence '
                           f'for {len(resynced_accounts)} accounts, then verified the premium gate for '
                           f'{len(repaired)} of {len(affected)} affected accounts.')
            else:
                summary = (f'Verified the premium gate for {len(repaired)} of '
                           f'{len(affected)} affected accounts after local access recovery.')
        elif assessment_failed:
            summary = 'No repair was attempted because the incident scan failed.'
        else:
            summary = 'No final Premium access check passed after recovery.' if affected else 'The checks did not confirm an account eligible for repair.'
        timeline, failure = None, None
        if not live:
            scoped_sdk_rows = [event for event in sdk_rows if all(event.get(key) == incident.get(key)
                for key in ('run_id', 'app', 'environment'))]
            affected_set = set(affected)
            sdk_events = {'access_projection_changed': sum(1 for event in scoped_sdk_rows
                    if event.get('kind') == 'access_projection_changed'
                    and event.get('app_user_id') in affected_set),
                'probe_allow': sum(1 for event in scoped_sdk_rows
                    if event.get('kind') == 'feature_access_decided'
                    and (event.get('details') or {}).get('initiator') == 'reconcile_probe'
                    and (event.get('details') or {}).get('decision') == 'allow')}
            actions_by_plan = {action['id']: action for action in actions}
            timeline, failure = _timeline(row, incident, snapshot, incident_decisions,
                                          incident_plans, actions_by_plan, sdk_events,
                                          trigger_events.get(row['id']))
            if status == 'unresolved' and failure is None:
                failure = {'step': 'Scan all accounts' if assessment_failed else 'Automatic recovery',
                           'owner': 'Reconcile', 'accounts': [], 'reason': next_step}
            if status != 'unresolved':
                failure = None
            if (failure and failure['step'] == 'Verify the premium gate'
                    and failure.get('accounts') and all(account.get('reason') ==
                        'independent gate probe unavailable' for account in failure['accounts'])):
                title = 'Premium access verification unavailable'
                summary = (f'Lumen resync succeeded for {len(resynced_accounts)} accounts; '
                           f'access remains unverified for {len(failure["accounts"])} accounts '
                           'because the independent gate probe was unavailable.')
                next_step = ('Check Lumen gate-probe availability and connectivity, then retry '
                             'verification for the listed accounts. The failed probe does not establish denied access.')
                failure['reason'] = 'Gate verification was unavailable after the automatic retry; current access is unknown.'
        feed.append({'id': row['id'], 'title': title, 'description': description,
            **({} if live else {'timeline': timeline, 'failure': failure}),
            'status': status, 'affected_accounts': len(affected),
            'repaired_accounts': len(repaired), 'detected_at': detected_at,
            'repair_started_at': repair_started_at, 'repaired_at': repaired_at,
            'duration_ms': duration_ms, 'repair_summary': summary,
            'next_step': next_step, 'source_provenance': provenance,
            'payment_verification': payment, 'actions': action_feed})
    all_feed = feed
    filtered_feed = [item for item in all_feed if requested_status is None
        or requested_status == 'needs_attention' and item['status'] != 'repaired'
        or item['status'] == requested_status]
    if paged:
        feed = filtered_feed[offset:offset+page_limit]
    else:
        feed = all_feed
    current = source.get('cli_catalog') or {}
    total_affected = sum(item['affected_accounts'] for item in all_feed)
    result = {'mode': 'FULL_MOCK' if not live else 'LOCAL_ADAPTY_FIXTURE' if manifest.get('provenance') == 'synthetic_test_fixture' else 'LIVE_ADAPTY_SEEDED',
        'app': {'id': manifest.get('app'), 'title': manifest.get('app_title'),
                'environment': manifest.get('environment')},
        'automation': {'enabled': bool(engine.auto_repair),
                       'policy_id': 'local-fulfillment-resync-v2' if engine.auto_repair else None},
        'connection': {'ready': True} if not live else {'ready': source.get('account_count') == 100
                and source.get('observed_count') == 100
                and source.get('identity_match_count') == 100,
            'source_observed_at': source.get('source_observed_at'),
            'active_accounts': source.get('active_count', 0),
            'total_accounts': source.get('account_count', 0),
            'cli_version': current.get('cli_version'),
            'catalog_product_count': current.get('product_count')},
        'summary': {'incidents': len(all_feed),
            'fixed': sum(item['status'] == 'repaired' for item in all_feed),
            'needs_attention': sum(item['status'] == 'unresolved' for item in all_feed),
            'affected_accounts': total_affected},
        'telemetry': {key: telemetry.get(key) for key in
            ('queued', 'accepted', 'dropped', 'failed', 'retries', 'last_error')},
        'simulation': simulation, 'incidents': feed,
        **({} if live else {'demo': {'trigger_user_id': 'u00000'}}),
        'coverage': {**(fulfillment_coverage or {}),
            'source_requests_total': source.get('source_requests_total', 0),
            'last_source_request_at': source.get('last_source_request_at'),
            'last_source_pass': source.get('last_source_pass')},
        'proactive': {'expectations': sum(fulfillment_counts.values()),
            'statuses': fulfillment_counts,
            'waiting_reason': (fulfillment_coverage or {}).get('waiting_reason'),
            'source_calls_last_pass': (fulfillment_coverage or {}).get('source_calls_last_pass', 0)}}
    if paged:
        next_offset = offset+len(feed)
        result['pagination'] = {'cursor': str(offset), 'limit': page_limit,
            'next_cursor': str(next_offset) if next_offset < len(filtered_feed) else None,
            'total': len(filtered_feed), 'status': requested_status}
    return result
