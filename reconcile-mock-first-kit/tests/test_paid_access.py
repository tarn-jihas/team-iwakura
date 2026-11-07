import json
import os
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import access_fixtures
import paid_access
from collector_sdk import KINDS


class PaidAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix='paid-access-test-')
        self.old_state, self.old_eval = paid_access.STATE, paid_access.EVAL
        root = Path(self.tmp.name)
        paid_access.STATE = root / 'runtime' / 'access_state.json'
        paid_access.EVAL = root / '_evaluation' / 'access_oracle.json'
        paid_access.seed()

    def tearDown(self):
        paid_access.STATE, paid_access.EVAL = self.old_state, self.old_eval
        self.tmp.cleanup()

    def detect(self, body=None):
        return paid_access.detect(body or {})

    def eligible_ids(self, report):
        return [account['id'] for account in report['accounts'] if account['eligible']]

    def make_plan(self, ids=None, retry_of=None):
        current = paid_access.report()
        if ids is None:
            ids = self.eligible_ids(current)
        result = paid_access.preview({'ids': ids, 'retry_of': retry_of})
        paid_access.approve({'plan_id': result['id'], 'plan_hash': result['plan_hash'],
                             'actor': 'test-reviewer'})
        return result

    @staticmethod
    def statuses(report):
        return {status: sum(account['status'] == status for account in report['accounts'])
                for status in ('confirmed', 'healthy', 'legitimate_denial',
                               'policy_denial', 'inconclusive', 'restored',
                               'pending_verification', 'outside_incident')}

    def test_100_account_scan_derives_exact_categories_and_scope(self):
        result = self.detect()
        self.assertEqual(len(result['accounts']), 100)
        self.assertEqual(result['summary']['in_scope'], 100)
        self.assertEqual(result['summary']['evaluated'], 94)
        self.assertEqual(tuple(result['summary'][key] for key in (
            'confirmed', 'healthy', 'legitimate_denial', 'policy_denial', 'inconclusive')),
            (24, 60, 6, 4, 6))
        self.assertEqual(set(self.eligible_ids(result)), set(access_fixtures.AFFECTED))
        self.assertEqual(sum(account['candidate'] for account in result['accounts']), 24)
        self.assertTrue(all(not account['observed_customer_denial'] for account in result['accounts']))
        self.assertTrue(all(account['candidate'] == account['eligible']
                            for account in result['accounts']
                            if account['status'] in ('confirmed', 'healthy', 'legitimate_denial',
                                                     'policy_denial', 'inconclusive')))
        self.assertEqual(result['incident']['event_type'], 'subscription_renewal_cancelled')
        self.assertIn('synthetic reconstruction', result['manifest']['provenance'])
        self.assertEqual(result['manifest']['logical_now'], access_fixtures.SCENARIO_NOW)
        self.assertEqual(result['consumer'], {'mode': 'faulty', 'handler_version': 'cancel-handler-v1'})

    def test_expired_and_policy_denials_are_never_repair_eligible(self):
        result = self.detect()
        by_status = {}
        for account in result['accounts']:
            by_status.setdefault(account['status'], []).append(account)
        self.assertTrue(all(not account['eligible'] for account in by_status['legitimate_denial']))
        self.assertTrue(all(not account['eligible'] for account in by_status['policy_denial']))
        self.assertTrue(all(not account['candidate'] for account in by_status['healthy']))
        blocked = [account['id'] for account in by_status['legitimate_denial'][:1]
                   + by_status['policy_denial'][:1]]
        with self.assertRaises(paid_access.APIError):
            paid_access.preview({'ids': blocked})
        with self.assertRaises(paid_access.APIError):
            paid_access.preview({'ids': ['not-in-registry']})
        state = paid_access.read()
        self.assertEqual(state['actions'], {})

    def test_second_variant_changes_registry_and_affected_cohort(self):
        variant1 = paid_access.seed(1)
        self.assertEqual(len(variant1['accounts']), 100)
        self.assertTrue(all(account['id'].startswith('v1-') for account in variant1['accounts']))
        result = paid_access.detect({})
        self.assertEqual(tuple(result['summary'][key] for key in (
            'confirmed', 'healthy', 'legitimate_denial', 'policy_denial', 'inconclusive')),
            (24, 60, 6, 4, 6))
        self.assertNotEqual(set(self.eligible_ids(result)), set(access_fixtures.AFFECTED))
        self.assertEqual(set(self.eligible_ids(result)),
                         set(access_fixtures.build_population(1)[0]['affected_ids']))

    def test_negative_windows_scope_and_malformed_detection_are_rejected(self):
        invalid = [
            {'window_start': '2026-11-03T00:05:00'},
            {'window_start': '2026-11-03T00:10:00Z', 'window_end': '2026-11-03T00:05:00Z'},
            {'run_id': 'old-run'},
            {'event_type': 'charge_refunded'},
            {'handler_version': 'unknown-handler'},
            {'feature': 'premium_everything'},
            [],
        ]
        before = paid_access.read()['collector']['events']
        for body in invalid:
            with self.subTest(body=body), self.assertRaises(paid_access.APIError):
                paid_access.detect(body)
        self.assertEqual(len(paid_access.read()['collector']['events']), len(before))

    def test_incomplete_processing_is_inconclusive_and_not_auto_repaired(self):
        state = paid_access.read()
        user_id = access_fixtures.AFFECTED[0]
        state['collector']['events'] = [
            event for event in state['collector']['events']
            if not (event['kind'] == 'handler_completed' and event['app_user_id'] == user_id)
        ]
        paid_access.save(state)
        result = self.detect()
        account = next(item for item in result['accounts'] if item['id'] == user_id)
        self.assertEqual(account['status'], 'inconclusive')
        self.assertEqual(account['reason'], 'cancellation_processing_incomplete')
        self.assertTrue(account['candidate'])
        self.assertFalse(account['eligible'])
        self.assertEqual(result['summary']['confirmed'], 23)
        self.assertEqual(result['summary']['evaluated'], 93)

    def test_full_registry_confirms_processed_causal_failure_without_webhook_candidate(self):
        state = paid_access.read()
        user_id = access_fixtures.AFFECTED[0]
        state['collector']['events'] = [
            event for event in state['collector']['events']
            if not (event['kind'] == 'webhook_received' and event['app_user_id'] == user_id)
        ]
        paid_access.save(state)
        result = self.detect()
        account = next(item for item in result['accounts'] if item['id'] == user_id)
        self.assertEqual(result['summary']['confirmed'], 24)
        self.assertFalse(account['candidate'])
        self.assertTrue(account['eligible'])
        self.assertEqual(sum(item['candidate'] for item in result['accounts']), 23)

    def test_scope_candidates_use_window_and_complete_causal_transitions(self):
        result = self.detect({'window_start': '2026-11-03T00:09:00Z',
                              'window_end': '2026-11-03T00:10:00Z'})
        self.assertEqual(result['summary']['confirmed'], 0)
        self.assertEqual(sum(account['candidate'] for account in result['accounts']), 0)
        self.assertTrue(all(not account['eligible'] for account in result['accounts']))

    def test_revoked_with_future_expiry_is_not_source_active_or_repairable(self):
        state = paid_access.read()
        user_id = access_fixtures.AFFECTED[0]
        state['source_entitlements'][user_id]['status'] = 'revoked'
        paid_access.save(state)
        result = self.detect()
        account = next(item for item in result['accounts'] if item['id'] == user_id)
        self.assertFalse(account['source_active'])
        self.assertEqual(account['status'], 'inconclusive')
        self.assertFalse(account['eligible'])
        with self.assertRaises(paid_access.APIError):
            paid_access.preview({'ids': [user_id]})

    def test_wrong_or_many_to_one_source_mapping_is_inconclusive_before_preview(self):
        user_id = access_fixtures.AFFECTED[0]
        state = paid_access.read()
        state['mappings'][user_id]['provider_user_id'] = 'different-provider-user'
        paid_access.save(state)
        result = self.detect()
        account = next(item for item in result['accounts'] if item['id'] == user_id)
        self.assertEqual(account['status'], 'inconclusive')
        self.assertEqual(account['reason'], 'mapping_source_identity_mismatch')
        self.assertFalse(account['eligible'])
        with self.assertRaises(paid_access.APIError):
            paid_access.preview({'ids': [user_id]})

        paid_access.seed()
        state = paid_access.read()
        other_id = access_fixtures.AFFECTED[1]
        provider_id = state['mappings'][user_id]['provider_user_id']
        state['mappings'][other_id]['provider_user_id'] = provider_id
        paid_access.save(state)
        result = self.detect()
        account = next(item for item in result['accounts'] if item['id'] == user_id)
        self.assertEqual(account['status'], 'inconclusive')
        self.assertEqual(account['reason'], 'ambiguous_or_many_to_one_identity_mapping')
        self.assertFalse(account['eligible'])

    def test_gate_uses_same_lumen_path_and_customer_denials_are_separate(self):
        self.detect()
        user_id = access_fixtures.AFFECTED[0]
        denied = paid_access.gate(user_id)
        self.assertFalse(denied['allowed'])
        self.assertEqual(denied['reason'], 'subscription_inactive')
        self.assertEqual(len(denied['event_hash']), 64)
        self.assertTrue(next(item for item in paid_access.report()['accounts']
                             if item['id'] == user_id)['observed_customer_denial'])
        plan = self.make_plan([user_id])
        paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        first = paid_access.verify({'plan_id': plan['id']})
        self.assertEqual((first['verified_count'], first['unresolved_count']), (0, 1))
        retry = self.make_plan(first['unresolved_ids'], retry_of=plan['id'])
        paid_access.apply({'plan_id': retry['id'], 'plan_hash': retry['plan_hash']})
        paid_access.verify({'plan_id': retry['id']})
        # Access is changed by the real shared gate state, not by source reads.
        allowed = paid_access.gate(user_id)
        self.assertTrue(allowed['allowed'])
        self.assertEqual(allowed['preview'], 'Lumen Premium export preview')
        journal = paid_access.journal({'user_id': user_id})['events']
        self.assertTrue(any(event['details'].get('initiator') == 'customer_demo'
                            and event['details']['decision'] == 'deny' for event in journal))
        self.assertTrue(any(event['details'].get('initiator') == 'reconcile_probe'
                            and event['details']['decision'] == 'deny' for event in journal))

    def test_preview_and_approval_do_not_write_lumen_state(self):
        result = self.detect()
        user_id = self.eligible_ids(result)[0]
        state = paid_access.read()
        original = (state['projection'][user_id], state['cache'][user_id])
        plan = paid_access.preview({'ids': [user_id]})
        after_preview = paid_access.read()
        self.assertEqual((after_preview['projection'][user_id], after_preview['cache'][user_id]), original)
        paid_access.approve({'plan_id': plan['id'], 'plan_hash': plan['plan_hash'], 'actor': 'human-reviewer'})
        after_approval = paid_access.read()
        self.assertEqual((after_approval['projection'][user_id], after_approval['cache'][user_id]), original)
        self.assertEqual(after_approval['actions'], {})

    def test_apply_requires_approval_and_stale_preflight_has_no_partial_writes(self):
        result = self.detect()
        ids = self.eligible_ids(result)[:2]
        plan = paid_access.preview({'ids': ids})
        before = paid_access.read()
        with self.assertRaises(paid_access.APIError):
            paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        self.assertEqual(paid_access.read()['projection'], before['projection'])
        self.assertEqual(paid_access.read()['actions'], {})
        paid_access.approve({'plan_id': plan['id'], 'plan_hash': plan['plan_hash'], 'actor': 'reviewer'})
        state = paid_access.read()
        state['source_entitlements'][ids[1]]['observed_at'] = '2026-11-02T20:00:00Z'
        paid_access.save(state)
        changed = paid_access.read()
        with self.assertRaises(paid_access.APIError) as error:
            paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        self.assertEqual(error.exception.status, 409)
        after = paid_access.read()
        self.assertEqual(after['projection'], changed['projection'])
        self.assertEqual(after['cache'], changed['cache'])
        self.assertEqual(after['actions'], {})

    def test_mapping_revision_policy_and_expiry_changes_all_block_apply(self):
        mutations = ('mapping', 'revision', 'policy', 'source_expiry',
                     'source_observation', 'expiry')
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                paid_access.seed()
                self.detect()
                user_id = access_fixtures.AFFECTED[0]
                plan = paid_access.preview({'ids': [user_id]})
                paid_access.approve({'plan_id': plan['id'], 'plan_hash': plan['plan_hash'], 'actor': 'reviewer'})
                state = paid_access.read()
                if mutation == 'mapping':
                    state['mappings'][user_id] = {'status': 'ambiguous', 'provider_user_ids': ['a', 'b']}
                elif mutation == 'revision':
                    state['projection'][user_id]['revision'] += 1
                elif mutation == 'policy':
                    state['feature_policy'][user_id]['enabled'] = False
                elif mutation == 'source_expiry':
                    state['source_entitlements'][user_id]['expires_at'] = '2027-07-04T00:00:00Z'
                elif mutation == 'source_observation':
                    state['source_entitlements'][user_id]['observed_at'] = '2026-11-03T00:12:03Z'
                else:
                    state['logical_elapsed_seconds'] += 301
                paid_access.save(state)
                before = paid_access.read()
                with self.assertRaises(paid_access.APIError) as error:
                    paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
                self.assertEqual(error.exception.status, 409)
                after = paid_access.read()
                self.assertEqual(after['projection'], before['projection'])
                self.assertEqual(after['cache'], before['cache'])
                self.assertEqual(after['actions'], {})

    def test_first_verify_is_23_of_24_and_repeated_apply_is_persisted_noop(self):
        detected = self.detect()
        source_before = paid_access.read()['source_entitlements']
        plan = self.make_plan(self.eligible_ids(detected))
        applied = paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        state_after = paid_access.read()
        collector_count = len(state_after['collector']['events'])
        repeat = paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        self.assertTrue(repeat['duplicate'])
        self.assertEqual(repeat['writes_accepted'], 0)
        self.assertEqual(repeat['receipts'], applied['receipts'])
        self.assertEqual(len(paid_access.read()['collector']['events']), collector_count)
        self.assertEqual(paid_access.read()['actions'], state_after['actions'])
        first = paid_access.verify({'plan_id': plan['id']})
        self.assertEqual((first['verified_count'], first['unresolved_count']), (23, 1))
        self.assertEqual(len(first['unresolved_ids']), 1)
        failed_id = first['unresolved_ids'][0]
        self.assertEqual(paid_access.gate(failed_id)['reason'], 'cache_stale')
        self.assertEqual(paid_access.report()['recovery']['target_count'], 24)
        self.assertEqual(paid_access.read()['source_entitlements'], source_before)

    def test_retry_is_new_approved_plan_and_reaches_24_without_unknown_repairs(self):
        detected = self.detect()
        original = self.make_plan(self.eligible_ids(detected))
        paid_access.apply({'plan_id': original['id'], 'plan_hash': original['plan_hash']})
        first = paid_access.verify({'plan_id': original['id']})
        self.assertEqual((first['verified_count'], first['unresolved_count']), (23, 1))
        retry_ids = first['unresolved_ids']
        retry = self.make_plan(retry_ids, retry_of=original['id'])
        self.assertNotEqual(retry['id'], original['id'])
        state_before_repeat = paid_access.read()
        duplicate = paid_access.apply({'plan_id': original['id'], 'plan_hash': original['plan_hash']})
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(paid_access.gate(retry_ids[0])['reason'], 'cache_stale')
        self.assertEqual(paid_access.read()['actions'], state_before_repeat['actions'])
        self.assertEqual((paid_access.report()['recovery']['verified_count'],
                          paid_access.report()['recovery']['unresolved_count']), (23, 1))
        applied_retry = paid_access.apply({'plan_id': retry['id'], 'plan_hash': retry['plan_hash']})
        self.assertEqual(applied_retry['writes_accepted'], 1)
        final = paid_access.verify({'plan_id': retry['id']})
        self.assertEqual((final['verified_count'], final['unresolved_count']), (24, 0))
        self.assertEqual(final['report']['recovery']['target_count'], 24)
        self.assertEqual(final['report']['summary']['inconclusive'], 6)
        self.assertEqual(final['report']['summary']['restored'], 24)
        self.assertEqual(final['report']['summary']['pending_verification'], 0)
        self.assertEqual(final['report']['recovery']['root_cause_status'], 'pending')
        self.assertEqual(paid_access.read()['source_entitlements'], state_before_repeat['source_entitlements'])
        state = paid_access.read()
        actions = {action['receipt']['action_id']: action for action in state['actions'].values()}
        events = {event['event_id']: event for event in state['collector']['events']}
        for observation in state['verification'].values():
            self.assertIn(observation['action_id'], actions)
            self.assertEqual(observation['applied_plan_id'], actions[observation['action_id']]['plan_id'])
            verified_event = events[observation['event_id']]
            gate_event = events[observation['gate_event_id']]
            self.assertEqual(verified_event['source_event_id'], observation['gate_event_id'])
            self.assertEqual(gate_event['payload_hash'], observation['gate_event_hash'])

    def test_previous_success_is_not_restored_after_source_context_changes(self):
        result = self.detect()
        plan = self.make_plan(self.eligible_ids(result))
        paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        paid_access.verify({'plan_id': plan['id']})
        state = paid_access.read()
        changed_id = next(user_id for user_id, value in state['verification'].items()
                          if value['allowed'])
        state['source_entitlements'][changed_id]['status'] = 'revoked'
        paid_access.save(state)
        after = paid_access.report()
        account = next(item for item in after['accounts'] if item['id'] == changed_id)
        self.assertEqual(account['status'], 'pending_verification')
        self.assertEqual(account['reason'], 'verification_context_stale')
        self.assertFalse(account['source_active'])
        self.assertEqual(after['recovery']['verified_count'], 22)

    def test_missing_source_after_apply_stays_unresolved_without_aborting_cohort(self):
        result = self.detect()
        plan = self.make_plan(self.eligible_ids(result))
        paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        state = paid_access.read()
        removed_id = access_fixtures.AFFECTED[1]
        del state['source_entitlements'][removed_id]
        paid_access.save(state)
        verified = paid_access.verify({'plan_id': plan['id']})
        self.assertEqual((verified['verified_count'], verified['unresolved_count']), (22, 2))
        account = next(item for item in verified['report']['accounts'] if item['id'] == removed_id)
        self.assertEqual(account['status'], 'pending_verification')
        self.assertEqual(account['reason'], 'verification_context_stale')
        self.assertIsNone(paid_access.read()['verification'][removed_id]['source_hash'])

    def test_all_collector_kinds_hashes_and_public_outputs_are_sanitized(self):
        result = self.detect()
        plan = self.make_plan(self.eligible_ids(result))
        paid_access.apply({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        paid_access.verify({'plan_id': plan['id']})
        state = paid_access.read()
        kinds = {event['kind'] for event in state['collector']['events']}
        self.assertEqual(kinds, KINDS)
        self.assertTrue(all(len(event['payload_hash']) == 64 for event in state['collector']['events']))
        report = paid_access.report()
        audit = paid_access.audit()
        evidence = paid_access.evidence(access_fixtures.AFFECTED[0])
        public = json.dumps([report, audit, evidence, paid_access.registry(), paid_access.journal({})])
        self.assertNotIn(state['_collector_key'], public)
        self.assertNotIn('private_fixture_oracle', public)
        self.assertNotIn('_fault_controls', public)
        self.assertEqual(report['collector']['event_count'], len(state['collector']['events']))
        self.assertIn('native_source_entitlement', evidence)
        self.assertEqual(evidence['source_hash'], evidence['native_source_entitlement']['source_hash'])
        self.assertIn(access_fixtures.AFFECTED[0], audit['native_source_entitlements'])
        self.assertIn(access_fixtures.AFFECTED[0], audit['current_projection'])
        self.assertIn(access_fixtures.AFFECTED[0], audit['current_cache'])
        self.assertFalse(any(event['details'].get('initiator') == 'customer_demo'
                             for event in state['collector']['events']
                             if event['details'].get('initiator') == 'reconcile_probe'))

    def test_external_collector_rejects_bad_signature_without_mutation(self):
        before = paid_access.read()
        envelope = {'event': {}, 'sent_at': int(time.time())}
        with self.assertRaises(paid_access.APIError) as error:
            paid_access.collector(envelope, 'invalid-signature')
        self.assertEqual(error.exception.status, 401)
        after = paid_access.read()
        self.assertEqual(after['collector'], before['collector'])

    @unittest.skipUnless(os.name == 'posix', 'POSIX file modes only')
    def test_access_state_and_private_evaluation_files_are_owner_only(self):
        self.assertEqual(stat.S_IMODE(Path(paid_access.STATE).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(Path(paid_access.EVAL).stat().st_mode), 0o600)
        paid_access.save(paid_access.read())
        self.assertEqual(stat.S_IMODE(Path(paid_access.STATE).stat().st_mode), 0o600)

    def test_fixture_oracle_is_not_read_by_detector(self):
        paid_access.EVAL.write_text('not json and not accessible to detection')
        result = self.detect()
        self.assertEqual(result['summary']['confirmed'], 24)

    def test_demo_actions_are_bounded_and_handler_changes_root_cause_only(self):
        self.detect()
        with self.assertRaises(paid_access.APIError):
            paid_access.demo({'action': 'advance', 'seconds': 86401})
        changed = paid_access.demo({'action': 'handler', 'mode': 'fixed'})
        self.assertEqual(changed['report']['recovery']['root_cause_status'], 'resolved')
        self.assertEqual(changed['consumer']['handler_version'], 'cancel-handler-v2')
        self.assertEqual(changed['report']['consumer'], changed['consumer'])
        advanced = paid_access.demo({'action': 'advance', 'seconds': 60})
        self.assertEqual(advanced['scenario_now'], '2026-11-03T00:13:04Z')
        reset = paid_access.demo({'action': 'reset', 'variant': 0})
        self.assertEqual(reset['consumer'], {'mode': 'faulty', 'handler_version': 'cancel-handler-v1'})


if __name__ == '__main__':
    unittest.main()
