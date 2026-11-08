import { useEffect, useRef, useState } from 'preact/hooks';
import { Modal, Badge, Button, Icon, MockBadge, download, useEscapeToCloseNav, useToast } from './shared';
import { isLiveMode, paymentLabel, safeReportHtml, statusLabel, statusTone, targetLabel } from './recovery-model';

type Data = Record<string, any>;
type Page = 'incident' | 'lumen' | 'lab';
type State = {
  report: Data | null; liveStatus: Data | null; error: string; busy: boolean; page: Page; selected: Set<string>;
  query: string; filter: string; offset: number; modal: 'plan' | 'evidence' | null; modalTitle: string;
  plan: Data | null; approved: boolean; ack: boolean; actor: string; nav: boolean; job: string | null;
  jobState: Data | null; detail: Data | null; gate: Data | null; detecting: boolean; incidentId: string | null;
  newIncident: boolean; triggerUser: string; incidentTime: string; windowStart: string; windowEnd: string;
  lumenUser: string; scenario: string; variant: number; fault: string; faultActive: boolean;
};
const stateFactory = (): State => ({ report: null, liveStatus: null, error: '', busy: false, page: location.hash === '#lumen' ? 'lumen' : 'incident', selected: new Set<string>(), query: '', filter: 'all', offset: 0, modal: null, modalTitle: '', plan: null, approved: false, ack: false, actor: '', nav: false, job: null, jobState: null, detail: null, gate: null, detecting: false, incidentId: null, newIncident: false, triggerUser: '', incidentTime: '', windowStart: '', windowEnd: '', lumenUser: '', scenario: 'stripe', variant: 0, fault: 'collector_outage', faultActive: false });
const statusOptions = ['confirmed', 'potential', 'activation_missing', 'access_not_delivered', 'healthy', 'inconclusive', 'policy_denial', 'legitimate_denial', 'outside_incident', 'restored', 'pending_verification', 'awaiting_client_action'];
const faults = [['collector_outage', 'Collector unavailable'], ['provider_outage', 'Provider unavailable'], ['probe_outage', 'Lumen probe unavailable'], ['suppress_customer_telemetry', 'Missing customer telemetry'], ['validation_timeout_after_commit', 'Validation timeout after commit'], ['rate_limit', 'Provider rate limit']];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Recovery request failed.';
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function RecoveryConsole() {
  const state = useRef(stateFactory());
  const [, setVersion] = useState(0);
  const redraw = () => setVersion(version => version + 1);
  const current = state.current;
  const { notify, node: toast } = useToast();
  useEscapeToCloseNav(current.nav, () => { current.nav = false; redraw(); });
  const eligible = () => (state.current.report?.accounts || []).filter((account: Data) => account.eligible === true);
  const selectedIds = () => [...state.current.selected].filter(id => eligible().some((account: Data) => account.id === id));
  const retryIds = () => {
    const report = state.current.report;
    if (!(report?.actions || []).some((action: Data) => ['failed', 'blocked', 'unknown_outcome', 'pending_verification'].includes(action.status))) return [];
    if (!report) return [];
    const unresolved = report.recovery?.unresolved_ids;
    const ids = Array.isArray(unresolved) ? unresolved : (report.actions || []).filter((action: Data) => ['failed', 'unresolved', 'pending_verification', 'awaiting_client_action'].includes(action.status)).map((action: Data) => action.account_id);
    return [...new Set(ids)].filter(id => eligible().some((account: Data) => account.id === id));
  };

  async function api(path: string, body?: unknown, timeoutMs = 12000, allowGateDenial = false): Promise<Data> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && !(allowGateDenial && response.status === 403 && data.allowed === false)) throw new Error(data.error || data.message || `Request failed (${response.status})`);
      if (allowGateDenial && !((response.status === 200 && data.allowed === true) || (response.status === 403 && data.allowed === false))) throw new Error('The app did not return a consistent gate decision. Access is unverified.');
      return allowGateDenial ? { ...data, http_status: response.status } : data;
    } finally { clearTimeout(timer); }
  }

  function reportPath(name: string) { return `/api/recovery/${name}${current.incidentId ? `?incident_id=${encodeURIComponent(current.incidentId)}` : ''}`; }
  async function refresh() {
    current.report = await api(reportPath('report'));
    current.incidentId = current.report.incident?.id || null;
    current.error = '';
    if (isLiveMode(current.report)) {
      current.liveStatus = null;
      try { current.liveStatus = await api('/api/recovery/live/status'); }
      catch { current.liveStatus = { ready: false }; throw new Error('Live source status is unavailable. Retry refresh before continuing.'); }
    }
  }

  async function waitForLiveIncident(userId: string, previousIncidentId: string | null, previousJobIds: Set<string>) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const report = await api('/api/recovery/report', undefined, Math.min(10000, Math.max(1, deadline - Date.now())));
        const incident = [report.incident, ...(report.incidents || [])].find((item: Data) => item?.id && item.id !== previousIncidentId && item.trigger_user_id === userId);
        if (incident) {
          const jobs = report.jobs || [];
          const job = jobs.find((item: Data) => item.incident_id === incident.id || item.result?.incident_id === incident.id)
            || jobs.find((item: Data) => !previousJobIds.has(item.id) && ['incident', 'scan'].includes(item.kind));
          if (job) { current.report = report; current.incidentId = incident.id; return { incident, job }; }
        }
      } catch (error) { if (Date.now() >= deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - Date.now()))));
    }
    throw new Error('The local gate denial was recorded, but no matching incident scan appeared within 30 seconds. Refresh to check the latest evidence.');
  }

  async function poll(id: string) {
    for (let index = 0; index < 90; index++) {
      const job = await api(`/api/recovery/jobs/${encodeURIComponent(id)}`, undefined, 10000);
      current.jobState = job; redraw();
      if (job.status === 'failed') throw new Error(job.error || 'The recovery job failed.');
      if (job.status === 'completed') { current.job = null; await refresh(); notify('Run complete. Current evidence has been refreshed.'); return; }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    throw new Error('The job is still running. Refresh to check its latest status.');
  }
  async function beginJob(response: Data) {
    if (response?.incident_id) current.incidentId = response.incident_id;
    current.newIncident = false;
    current.job = response?.job_id || response?.id || null;
    if (!current.job) return refresh();
    return poll(current.job);
  }
  async function refreshAndResume() {
    await refresh();
    const running = (current.report?.jobs || []).find((job: Data) => ['queued', 'running'].includes(job.status));
    if (running) await beginJob({ job_id: running.id });
  }
  async function work(action: () => Promise<void>) {
    if (current.busy) return;
    current.busy = true; redraw();
    try { await action(); }
    catch (error) { current.error = errorText(error); notify(current.error, true); }
    finally { current.busy = false; current.detecting = false; redraw(); }
  }
  function navigate(page: Page) {
    current.page = page; current.nav = false; location.hash = page === 'incident' ? '' : page; redraw(); window.scrollTo(0, 0);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#main-content')?.focus({ preventScroll: true }));
  }
  function closeModal() { current.modal = null; redraw(); }
  function openEvidence(title: string, data: Data) { current.detail = data; current.modalTitle = title; current.modal = 'evidence'; redraw(); }

  async function handle(action: string, extra: Data = {}) {
    if (action === 'nav' || action === 'nav-close') { current.nav = action === 'nav' && !current.nav; redraw(); return; }
    if (action === 'page') { navigate(extra.page as Page); return; }
    if (action === 'close') { if (!current.busy) closeModal(); return; }
    if (action === 'new-investigation') { current.newIncident = true; redraw(); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#trigger-user')?.focus()); return; }
    if (action === 'select-all') { current.selected = new Set<string>(eligible().map((account: Data) => account.id)); redraw(); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-action="preview"]')?.focus()); return; }
    if (action === 'clear-selection') { current.selected.clear(); redraw(); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-action="select-all"]')?.focus()); return; }
    if (action === 'previous' || action === 'next') { current.offset = Math.max(0, current.offset + (action === 'next' ? 20 : -20)); redraw(); return; }
    if (action === 'open-lumen') { navigate('lumen'); return; }
    if (action === 'lumen-export') {
      const userId = current.lumenUser;
      if (!userId) return;
      await work(async () => { current.gate = await api('/api/recovery/lumen/export', { user_id: userId }, 12000, true); current.page = 'lumen'; });
      return;
    }
    if (action === 'gate-download') { if (current.gate) download(current.gate, 'lumen-gate-receipt.json'); return; }
    if (action === 'incident-select') { current.incidentId = extra.id; current.selected.clear(); current.offset = 0; current.newIncident = false; await work(refresh); return; }
    if (action === 'export' || action === 'export-json') {
      await work(async () => {
        const data = await api(reportPath('audit'));
        if (action === 'export') download(safeReportHtml(data), 'payment-activation-recovery.html', 'text/html');
        else download(data, 'payment-activation-recovery.json');
      });
      return;
    }
    if (action === 'snapshot') {
      await work(async () => openEvidence('Incident evidence snapshot', await api(`/api/recovery/snapshots/${encodeURIComponent(current.report?.incident?.snapshot_id)}`)));
      return;
    }
    if (action === 'evidence') {
      await work(async () => openEvidence(`Evidence · ${extra.user}`, await api(`/api/recovery/evidence?user=${encodeURIComponent(extra.user)}`)));
      return;
    }
    if (action === 'history-detail') { openEvidence('Historical recovery run · read only', extra.data); return; }
    if (action === 'evidence-download') { download(current.detail, 'reconcile-recovery-evidence.json'); return; }

    if (action === 'investigate') {
      const body: Data = { user_id: current.triggerUser || current.report?.accounts?.find((account: Data) => account.status === 'activation_missing')?.id || current.report?.accounts?.[0]?.id || '' };
      if (!body.user_id) { notify('Enter the affected account ID.', true); return; }
      for (const [field, key] of [['incidentTime', 'occurred_at'], ['windowStart', 'window_start'], ['windowEnd', 'window_end']] as const) {
        const value = current[field];
        if (value) {
        const date = new Date(value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
          if (!Number.isFinite(date.getTime())) { notify('Enter a valid UTC date and time.', true); return; }
          body[key] = date.toISOString();
        }
      }
      await work(async () => { await beginJob(await api('/api/recovery/incidents', body)); await refresh(); });
      return;
    }
    if (action === 'scan') { await work(async () => { const result = await api('/api/recovery/scans', { incident_id: current.report?.incident?.id }); await beginJob(result); await refresh(); }); return; }
    if (action === 'preview' || action === 'retry') {
      const ids = action === 'retry' ? retryIds() : selectedIds();
      if (!ids.length) { if (action === 'retry') notify('No eligible unresolved accounts remain.', true); return; }
      await work(async () => { current.plan = await api('/api/recovery/plans', { ids, incident_id: current.report?.incident?.id }); current.ack = false; current.approved = false; current.modal = 'plan'; redraw(); });
      return;
    }
    if (action === 'approve') {
      await work(async () => {
        if (!current.plan) return;
        await api('/api/recovery/approvals', { plan_id: current.plan.id, plan_hash: current.plan.plan_hash, actor: current.actor.trim() });
        current.approved = true;
        const job = await api('/api/recovery/executions', { plan_id: current.plan.id, plan_hash: current.plan.plan_hash });
        current.modal = null; await beginJob(job); await refresh();
      });
      return;
    }
    if (action === 'reset') {
      if (!confirm('Reset this recovery scenario? Plans, approvals and action history will be cleared.')) return;
      await work(async () => { await api('/api/recovery/demo', { action: 'reset', scenario: current.scenario, variant: current.variant }, 60000); current.incidentId = null; current.newIncident = false; current.selected.clear(); await refresh(); });
      return;
    }
    if (action === 'advance') { await work(async () => { await api('/api/recovery/demo', { action: 'advance', seconds: 300 }); await refresh(); }); return; }
    if (action === 'fault') {
      await work(async () => { await api('/api/recovery/demo', { action: 'fault', fault: current.fault, active: current.faultActive }); notify(`Fault ${current.faultActive ? 'enabled' : 'disabled'}: ${current.fault.replaceAll('_', ' ')}`); });
      return;
    }
    if (action === 'refresh') { await work(refreshAndResume); return; }
    if (action === 'live-refresh') { await work(async () => { await api('/api/recovery/live/refresh', {}, 60000); await refreshAndResume(); notify('Adapty source refreshed.'); }); return; }
    if (action === 'live-incident') {
      await work(async () => {
        current.detecting = true; redraw();
        const previousIncidentId = current.report?.incident?.id || null;
        const previousJobIds = new Set<string>((current.report?.jobs || []).map((job: Data) => job.id));
        current.incidentId = null;
        const result = await api('/api/recovery/live/incident', { action: 'inject' }, 60000);
        current.gate = result.gate ? { ...result.gate, http_status: result.gate.status } : null;
        current.lumenUser = current.gate?.user_id || current.lumenUser;
        const detected = await waitForLiveIncident(current.lumenUser, previousIncidentId, previousJobIds);
        current.incidentId = detected.incident.id;
        await beginJob({ job_id: detected.job.id, incident_id: detected.incident.id });
        current.page = 'incident'; await refresh();
      });
      return;
    }
    if (action === 'investigate-gate') {
      const userId = current.lumenUser;
      if (!userId) return;
      await work(async () => { await beginJob(await api('/api/recovery/incidents', { user_id: userId })); await refresh(); current.page = 'incident'; });
    }
  }

  async function load() {
    try { await refreshAndResume(); }
    catch (error) { current.error = errorText(error); }
    redraw();
  }
  useEffect(() => { void load(); }, []);

  const report = current.report;
  const live = report ? isLiveMode(report) : false;
  const statusBadge = (label: string, tone = 'blue') => <Badge tone={tone}>{label}</Badge>;
  const actionButton = (label: string, action: string, primary = false, disabled = false, extra: Data = {}) => <Button action={action} primary={primary} disabled={current.busy || disabled} {...extra} onClick={() => void handle(action, extra)}>{label}</Button>;
  const heading = (title: string, subtitle: string, actions?: unknown) => <section class="page-heading"><div class="page-title"><h1>{title}</h1><p>{subtitle}</p></div><div class="heading-actions">{actions as any}</div></section>;
  const accountRows = report ? (report.accounts || []).filter((account: Data) => (current.filter === 'all' || account.status === current.filter) && `${account.id} ${account.reason || ''}`.toLowerCase().includes(current.query.toLowerCase())) : [];
  const visibleAccounts = accountRows.slice(current.offset, current.offset + 20);
  const title = current.page === 'lab' ? 'Demo Lab' : current.page === 'lumen' ? 'Lumen Demo' : live ? 'Access delivery incident' : 'Payment activation incident';

  if (!report) return <><main class="fatal-state"><h1>Payment Activation Recovery</h1><p>{current.error || 'Loading current evidence…'}</p>{current.error && actionButton('Try again', 'refresh', true)}</main>{toast}</>;

  const summary = report.summary || {}, recovery = report.recovery || {}, incident = report.incident;
  const retry = retryIds(), showNew = !incident || current.newIncident;
  const aside = <aside class={`sidebar ${current.nav ? 'open' : ''}`} id="primary-navigation" aria-label="Workspace navigation"><div class="sidebar-brand"><a class="brand" href="/recovery.html"><span class="brand-mark"><Icon name="logo" size={22} /></span>Reconcile</a><button type="button" class="btn-icon sidebar-close" aria-label="Close navigation" onClick={() => void handle('nav-close')}>×</button></div><div class="workspace-identity"><span class="app-icon">L</span><div><strong>{report.manifest?.app_title || current.liveStatus?.app_title || report.manifest?.app || 'Lumen'}</strong><span>{report.manifest?.environment || 'Environment unavailable'}</span></div></div><nav class="primary-nav" aria-label="Primary">{(['incident', 'lumen', 'lab'] as Page[]).map((page, index) => <button type="button" class={`nav-button ${current.page === page ? 'active' : ''}`} key={page} onClick={() => navigate(page)}>{['Incidents', 'Lumen Demo', 'Demo Lab'][index]}</button>)}</nav><div class="sidebar-bottom"><a class="nav-button nav-secondary" href="/analytics.html">Analytics</a><a class="nav-button nav-secondary" href="/access.html">Cancellation recovery</a><a class="nav-button nav-secondary" href="/legacy.html">Legacy lab</a></div></aside>;

  const accountTable = <section class="recovery-panel"><header><div><h2>Accounts in scope</h2><p>{summary.in_scope ?? 0} in scope · {summary.evaluated ?? 0} evaluated · {summary.confirmed ?? 0} confirmed · {summary.inconclusive ?? 0} inconclusive</p></div>{showNew ? live ? actionButton('Open Lumen demo', 'open-lumen', true) : actionButton('Start investigation', 'investigate', true) : actionButton('Refresh evidence', 'scan')}</header>
    {showNew && !live && <><p class="recovery-hint">Start with the affected customer account. The default window is five minutes before and after the event.</p><label class="field-label">Affected account <input id="trigger-user" value={current.triggerUser || report.accounts?.find((account: Data) => account.status === 'activation_missing')?.id || report.accounts?.[0]?.id || ''} placeholder="Account ID" onInput={event => { current.triggerUser = event.currentTarget.value; }} /></label><details class="snapshot-details"><summary>Adjust incident time window</summary><div class="account-controls"><label>Event time (UTC, optional)<input id="incident-time" type="datetime-local" value={current.incidentTime || ''} onInput={event => { current.incidentTime = event.currentTarget.value; }} /></label><label>Window start (UTC, optional)<input id="window-start" type="datetime-local" value={current.windowStart || ''} onInput={event => { current.windowStart = event.currentTarget.value; }} /></label><label>Window end (UTC, optional)<input id="window-end" type="datetime-local" value={current.windowEnd || ''} onInput={event => { current.windowEnd = event.currentTarget.value; }} /></label></div></details></>}
    <div class="account-controls"><label>Search <input id="search" type="search" value={current.query} placeholder="Account or reason" onInput={event => { current.query = event.currentTarget.value; current.offset = 0; redraw(); }} /></label><label>Outcome <select id="filter" value={current.filter} onChange={event => { current.filter = event.currentTarget.value; current.offset = 0; redraw(); }}><option value="all">All outcomes</option>{statusOptions.map(option => <option value={option} key={option}>{statusLabel(option)}</option>)}</select></label></div>
    {live && !eligible().length && <p class="recovery-hint">No accounts are currently eligible for a recovery plan.</p>}
    <div class="account-selection"><span>{selectedIds().length} selected</span>{actionButton(`Select all eligible (${eligible().length})`, 'select-all', false, !eligible().length)}{actionButton('Clear', 'clear-selection', false, !current.selected.size)}{retry.length === 0 && actionButton('Preview selected plan', 'preview', true, !selectedIds().length)}</div>
    <div class="table-scroll"><table class="data-table recovery-table"><thead><tr><th>Select</th><th>Account / evidence</th><th>Payment</th><th>Adapty</th><th>Client gate</th><th>Outcome</th></tr></thead><tbody>{visibleAccounts.length ? visibleAccounts.map((account: Data) => <tr key={account.id}><td><input type="checkbox" data-account={account.id} aria-label={`Select ${account.id}`} checked={current.selected.has(account.id)} disabled={!account.eligible || current.busy} onChange={event => { event.currentTarget.checked ? current.selected.add(account.id) : current.selected.delete(account.id); redraw(); }} /></td><th scope="row"><button type="button" class="text-button mono" data-user={account.id} onClick={() => void handle('evidence', { user: account.id })}>{account.id}</button><small>{statusLabel(account.reason || 'No reason recorded')}</small></th><td>{paymentLabel(account, report)}</td><td>{account.adapty_active === true ? 'Active' : account.adapty_active === false ? 'Inactive' : 'Unknown'}</td><td>{account.gate?.allowed === true ? 'Allows access' : account.gate?.allowed === false ? 'Denies access' : 'Unknown'}</td><td><Badge tone={statusTone(account.status)}>{statusLabel(account.status)}</Badge></td></tr>) : <tr><td colSpan={6}>No accounts match this view.</td></tr>}</tbody></table></div>
    <footer class="pagination"><span>Showing {accountRows.length ? current.offset + 1 : 0}–{Math.min(current.offset + 20, accountRows.length)} of {accountRows.length}</span>{actionButton('Previous', 'previous', false, current.offset === 0)}{actionButton('Next', 'next', false, current.offset + 20 >= accountRows.length)}</footer>
  </section>;

  const incidentContent = <>
    <section class="recovery-heading"><div><p class="eyebrow">{report.manifest?.app_title || report.manifest?.app || 'App'} · {report.manifest?.environment || 'Environment unavailable'}</p><h1>{live ? 'Access delivery incident' : title}</h1><p>{live ? 'Review source entitlement delivery and the local Lumen access gate. Payment state is not independently verified.' : 'Compare payment, entitlement and client evidence. Approve only the accounts in the reviewed plan.'}</p></div><div>{statusBadge(live ? 'LIVE ADAPTY · SEEDED DATA' : 'LOCAL SYNTHETIC DEMO', live ? 'amber' : 'blue')} {incident ? statusBadge(statusLabel(incident.status || 'Incident open'), incident.status === 'access_verified' ? 'green' : 'amber') : statusBadge('No incident', 'blue')}</div></section>
    {current.error && <div class="mock-error" role="alert">{current.error} {actionButton('Refresh', 'refresh')}</div>}
    {!live && (report.incidents || []).length > 0 && <div class="account-controls"><label>Incident<select id="incident-picker" value={current.incidentId || ''} onChange={event => void handle('incident-select', { id: event.currentTarget.value })}>{report.incidents.map((item: Data) => <option value={item.id} key={item.id}>{item.trigger_user_id} · {item.confirmed} confirmed · {statusLabel(item.status)}</option>)}</select></label>{actionButton('New investigation', 'new-investigation')}</div>}
    <section class="recovery-summary" aria-label="Incident summary"><article><span>Coverage</span><strong>{report.coverage?.complete === true ? 'Complete' : report.coverage?.complete === false ? 'Incomplete' : 'Unknown'}</strong><small>{(report.coverage?.gaps || []).length} evidence gaps</small></article><article><span>Evaluated</span><strong>{summary.evaluated ?? 0} / {summary.in_scope ?? 0}</strong><small>{summary.excluded ?? 0} excluded</small></article><article><span>{live ? 'Entitlement verified' : 'Activation verified'}</span><strong>{(live ? recovery.entitlement_verified : recovery.activation_verified) ?? 0}</strong><small>Evidence-backed checks</small></article><article><span>Access verified</span><strong>{recovery.access_verified ?? 0}</strong><small>{recovery.unresolved ?? 0} unresolved</small></article></section>
    {retry.length > 0 && <section class="recovery-panel"><header><div><h2>{recovery.unresolved} access {recovery.unresolved === 1 ? 'remains' : 'results remain'} unresolved</h2><p>Review a new plan for the remaining unresolved steps.</p></div>{actionButton(`Preview retry (${retry.length})`, 'retry', true)}</header></section>}
    <section class="recovery-context"><div><span>Incident</span><strong>{incident?.id || 'Not started'}</strong></div><div><span>Scope</span><strong>{report.manifest?.app_title || report.manifest?.app || 'App unavailable'} · {report.manifest?.environment || 'Unknown environment'}</strong></div><div><span>Root cause</span><strong>{statusLabel(recovery.root_cause_status || 'Unknown')} · {recovery.root_cause_certainty || 'certainty unavailable'}</strong></div><div><span>Timeline</span><strong>{incident?.window_start || 'Snapshot unavailable'} → {incident?.window_end || 'Snapshot unavailable'}</strong></div></section>
    {accountTable}
    <section class="recovery-actions"><header><div><h2>Recovery report</h2><p>{live ? 'Adapty entitlement delivery and local access are checked separately.' : 'Activation and delivered access are checked separately.'}</p></div>{actionButton('Download HTML report', 'export')}{actionButton('Download JSON audit', 'export-json')}</header><details class="snapshot-details"><summary>Action evidence and responsibilities ({(report.actions || []).length})</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>Owner</th><th>Target</th><th>Status</th><th>Time</th><th>Evidence</th><th>Next step</th></tr></thead><tbody>{(report.actions || []).map((action: Data, index: number) => <tr key={`${action.id || action.account_id}-${index}`}><td>{action.owner}</td><td>{targetLabel(action)}{action.account_id && <small>{action.account_id}</small>}</td><td><Badge tone={statusTone(action.status)}>{statusLabel(action.status)}</Badge></td><td>{action.started_at || action.finished_at || 'Not recorded'}</td><td>{action.evidence_ref || 'Not recorded'}</td><td>{action.next_step || 'No next step recorded'}</td></tr>)}{!report.actions?.length && <tr><td colSpan={6}>No recovery actions recorded.</td></tr>}</tbody></table></div></details></section>
    {incident && <details class="snapshot-details"><summary>Incident window and evidence snapshot</summary><p>{incident.window_start || 'Start unavailable'} to {incident.window_end || 'End unavailable'} · Snapshot {incident.snapshot_id || 'unavailable'} · {report.coverage?.observed_at || 'Observation time unavailable'}</p><ul>{(report.coverage?.gaps || []).map((gap: unknown, index: number) => <li key={index}>{typeof gap === 'string' ? gap : JSON.stringify(gap)}</li>)}{!report.coverage?.gaps?.length && <li>No reported coverage gaps.</li>}</ul>{incident.snapshot_id && actionButton('Open evidence snapshot', 'snapshot')}</details>}
  </>;

  const demoContent = live ? <><section class="recovery-heading"><div><p class="eyebrow">Live source status</p><h1>Demo Lab</h1><p>Read-only integration details for the isolated Lumen and Adapty demo.</p></div>{statusBadge(current.liveStatus?.ready ? 'Source ready' : 'Source unavailable', current.liveStatus?.ready ? 'green' : 'amber')}</section><section class="recovery-panel"><h2>Adapty and Lumen source</h2><p>{current.liveStatus?.active_count ?? 0} active entitlements · {current.liveStatus?.account_count ?? 0} seeded accounts · Last source read {current.liveStatus?.source_observed_at || 'not available'}</p><p>Source environment: {current.liveStatus?.source_environment || 'unavailable'} · App: {current.liveStatus?.app_title || current.liveStatus?.app || report.manifest?.app || 'Lumen'} · {current.liveStatus?.lumen_url || 'Local Lumen gate unavailable'}</p><p>Adapty CLI reads the catalog, Adapty API reads entitlements, and the server SDK reports local gate decisions.</p>{actionButton('Refresh source', 'live-refresh', true, current.liveStatus?.actions_allowed?.refresh !== true)}<details class="snapshot-details"><summary>Integration status</summary><pre>{pretty(current.liveStatus)}</pre></details></section></> : <><section class="recovery-heading"><div><p class="eyebrow">Synthetic scenario</p><h1>Demo Lab</h1><p>Reset clears this recovery run’s plans, approvals and action history.</p></div></section><section class="recovery-panel"><label class="field-label">Scenario <select value={current.scenario} onChange={event => { current.scenario = event.currentTarget.value; redraw(); }}>{['stripe', 'paddle', 'custom', 'apple', 'google', 'offline'].map(value => <option key={value}>{value}</option>)}</select></label><label class="field-label">Variant <select value={current.variant} onChange={event => { current.variant = Number(event.currentTarget.value); redraw(); }}><option value={0}>Default</option><option value={1}>Alternate</option></select></label>{actionButton('Reset recovery scenario', 'reset', true)}{actionButton('Advance scenario clock 5 minutes', 'advance')}{actionButton('Refresh report', 'refresh')}</section><section class="recovery-panel"><h2>Fault controls</h2><p>Local simulator only. One-shot faults clear after they are consumed.</p><label class="field-label">Fault <select value={current.fault} onChange={event => { current.fault = event.currentTarget.value; redraw(); }}>{faults.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label class="approval-ack"><input type="checkbox" checked={current.faultActive} onChange={event => { current.faultActive = event.currentTarget.checked; redraw(); }} /> Enable selected fault</label>{actionButton('Apply fault setting', 'fault')}</section><section class="recovery-panel"><h2>Regression demos</h2><a class="btn" href="/analytics.html">Analytics</a> <a class="btn" href="/access.html">Cancellation recovery</a> <a class="btn" href="/legacy.html">Legacy fixture lab</a></section></>;

  const accounts = report.accounts || [];
  const lumenContent = <><section class="recovery-heading"><div><p class="eyebrow">{live ? 'LIVE ADAPTY · SEEDED DATA' : 'Real local gate decision'}</p><h1>Lumen Demo</h1><p>{live ? 'Real Adapty reads and the real Lumen SDK gate use synthetic purchase records. No money was received or recovered.' : 'Try an actual premium export request for a selected account. A 403 response is shown as the gate outcome.'}</p></div>{live && statusBadge(current.liveStatus?.ready ? 'Source ready' : 'Source unavailable', current.liveStatus?.ready ? 'green' : 'amber')}</section>
    {live && <section class="recovery-panel"><h2>Local access incident</h2><p>Changes local Lumen client projections and runs one real premium export gate denial, affecting Lumen locally.</p><p>{current.liveStatus?.active_count ?? 0} active entitlements · {current.liveStatus?.account_count ?? 0} seeded accounts · Last checked {current.liveStatus?.source_observed_at || 'not available'}</p>{current.detecting && <p class="job-status" role="status" aria-live="polite">Incident requested; waiting for the detector…</p>}{actionButton('Simulate local access incident', 'live-incident', true, !current.liveStatus?.ready || current.detecting || current.liveStatus?.actions_allowed?.inject_incident !== true)}</section>}
    <section class="recovery-panel"><h2>Check the customer gate</h2><p>Test premium export access before and after recovery.</p><label class="field-label">Account <select id="lumen-user" value={current.lumenUser} onChange={event => { current.lumenUser = event.currentTarget.value; current.gate = null; redraw(); }}>{accounts.map((account: Data) => <option value={account.id} key={account.id}>{account.id}</option>)}</select></label>{accounts.length ? actionButton('Try premium export', 'lumen-export', !live) : <p>No account is available for the gate check.</p>}{live && <><p>Payment state is not independently verified.</p><p>Local gate: {current.liveStatus?.lumen_url || 'unavailable'}</p></>}{current.gate && <div class="gate-result" role="status"><strong>{current.gate.http_status === 403 || current.gate.allowed === false ? '403 · Access denied' : current.gate.http_status === 200 || current.gate.allowed === true ? '200 · Access allowed' : 'Gate result'}</strong><p>{current.gate.reason || current.gate.message || 'No reason returned'}</p><details><summary>Gate evidence</summary><pre>{pretty(current.gate)}</pre></details>{(current.gate.http_status === 403 || current.gate.allowed === false) && actionButton('Investigate this account', 'investigate-gate')}</div>}</section>
  </>;

  return <><div class="app-shell mock-app recovery-app">{current.nav && <div class="nav-backdrop" onClick={() => void handle('nav-close')} />}{aside}<div class="main-shell"><header class="topbar"><div class="toolbar-location"><button type="button" class="btn-icon mobile-nav-button" aria-label="Open navigation" aria-expanded={current.nav} aria-controls="primary-navigation" onClick={() => void handle('nav')}>☰</button><div class="breadcrumbs"><span>Workspace</span> / <strong>{title}</strong></div></div><div class="topbar-actions"><MockBadge>{live ? 'LIVE ADAPTY · SEEDED DATA' : 'LOCAL SYNTHETIC DEMO'}</MockBadge></div></header><main class="page" id="main-content" tabindex={-1}>{current.page === 'lab' ? demoContent : current.page === 'lumen' ? lumenContent : incidentContent}{current.job && <p class="job-status" role="status" aria-live="polite">{current.jobState?.status || 'queued'} · recovery job {current.job}</p>}</main></div></div>
    {current.modal === 'plan' && current.plan && <Modal title="Review recovery plan" labelledBy="plan-title" className="recovery-drawer" busy={current.busy} onClose={closeModal} footer={<>{actionButton('Approve & run', 'approve', true, current.approved || !current.ack || !current.actor.trim())}{actionButton('Close', 'close')}</>}>
      <p>{current.plan.ids?.length ?? selectedIds().length} {(current.plan.ids?.length ?? selectedIds().length) === 1 ? 'account is' : 'accounts are'} in this exact plan. Approval authorizes only these proposed steps.</p><dl><dt>Plan</dt><dd>{current.plan.id}</dd><dt>Expires</dt><dd>{current.plan.expires_at || 'Not specified'}</dd></dl><details><summary>Accounts in this plan</summary><p class="mono">{(current.plan.ids || selectedIds()).join(', ')}</p></details>
      <ol>{(current.plan.steps || []).map((step: Data, index: number) => <li key={index}><strong>{step.title || statusLabel(step.action)}</strong><p>{step.description || step.summary || ''}</p>{(step.owner || step.actor) && <small>Owner: {step.owner || step.actor}</small>}<details><summary>Technical details</summary><pre>{pretty(step)}</pre></details></li>)}{!current.plan.steps?.length && (current.plan.entries || []).map((entry: Data, index: number) => <li key={index}><strong>{statusLabel(entry.type || entry.action)}</strong><p>{targetLabel(entry)}</p><small>Owner: {entry.owner}</small><details><summary>Technical details</summary><pre>{pretty(entry)}</pre></details></li>)}</ol>
      <label class="approval-ack"><input type="checkbox" id="ack" checked={current.ack} disabled={current.busy} onChange={event => { current.ack = event.currentTarget.checked; redraw(); }} />I reviewed and approve this exact plan.</label><label class="field-label">Approval actor <input id="actor" value={current.actor} maxLength={100} placeholder="Name or role" disabled={current.busy} onInput={event => { current.actor = event.currentTarget.value; current.approved = false; redraw(); }} /></label>
    </Modal>}
    {current.modal === 'evidence' && <Modal title={current.modalTitle || 'Evidence details'} labelledBy="detail-title" className="recovery-drawer" busy={current.busy} onClose={closeModal} footer={<>{actionButton('Download evidence', 'evidence-download')}{actionButton('Close', 'close')}</>}><section class="mock-json-block"><pre>{pretty(current.detail)}</pre></section></Modal>}
    {toast}</>;
}
