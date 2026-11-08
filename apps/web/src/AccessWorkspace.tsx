import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ACCESS_STATUS, orderedAccounts, recoveryOutcome, utcInput, utcValue } from './access-model';
import { Badge, Button, Icon, MockBadge, Modal, download, useEscapeToCloseNav, useToast } from './shared';

type Data = Record<string, any>;
type View = 'incident' | 'sources' | 'lumen' | 'history';
type ModalState = { kind: 'plan' | 'reset' | 'json'; title: string; data?: Data; variant?: number } | null;
type State = {
  report: Data | null; view: View; tab: 'accounts' | 'repair' | 'scope'; filter: string; query: string; page: number;
  selected: Set<string>; window: { start: string; end: string; handler: string } | null; busy: boolean; error: string;
  modal: ModalState; plan: Data | null; ack: boolean; actor: string; approved: boolean; activePlanId: string | null;
  nav: boolean; lumenUser: string; gate: Data | null; handlerMode: string;
};

const initialState = (): State => ({ report: null, view: location.hash === '#lumen' ? 'lumen' : 'incident', tab: 'accounts', filter: 'all', query: '', page: 0, selected: new Set(), window: null, busy: false, error: '', modal: null, plan: null, ack: false, actor: 'demo-operator', approved: false, activePlanId: null, nav: false, lumenUser: '', gate: null, handlerMode: 'faulty' });
const escapeError = (error: unknown) => error instanceof Error ? error.message : 'Recovery request failed.';
const pretty = (data: unknown) => JSON.stringify(data, null, 2);

export function AccessWorkspace() {
  const state = useRef(initialState());
  const [, setVersion] = useState(0);
  const redraw = () => setVersion(version => version + 1);
  const { notify, node: toast } = useToast(6500);
  const current = state.current;
  useEscapeToCloseNav(current.nav, () => { current.nav = false; redraw(); });
  const eligible = () => (state.current.report?.accounts || []).filter((account: Data) => account.eligible === true);
  const selectedIds = () => [...state.current.selected].filter(id => eligible().some((account: Data) => account.id === id));

  async function request(path: string, body?: unknown, allowDenied = false): Promise<Data> {
    if (!path.startsWith('/api/access/') && !path.startsWith('/mock/lumen/')) throw new Error('Only local recovery routes are available.');
    const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok && !(allowDenied && response.status === 403 && result.allowed === false)) {
      const error = new Error(result.error || `Recovery server returned ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function refresh() {
    const report = await request('/api/access/report');
    current.report = report;
    current.error = '';
    if (report.consumer) current.handlerMode = report.consumer.mode;
    if (!current.window) current.window = { start: utcInput(report.incident.window_start), end: utcInput(report.incident.window_end), handler: report.incident.handler_version };
    current.activePlanId = report.recovery.latest_plan_id || current.activePlanId;
    if (!current.lumenUser || !report.accounts.some((account: Data) => account.id === current.lumenUser)) current.lumenUser = orderedAccounts(report.accounts)[0]?.id || '';
    current.selected = new Set([...current.selected].filter(id => report.accounts.some((account: Data) => account.id === id && account.eligible)));
  }

  async function work(action: () => Promise<void>) {
    if (current.busy) return;
    current.busy = true; redraw();
    try { await action(); }
    catch (error) {
      current.error = escapeError(error);
      if ((error as { status?: number }).status === 409 && current.modal?.kind === 'plan') current.approved = false;
      notify(current.error, true);
    } finally { current.busy = false; redraw(); }
  }

  function navigate(view: View) {
    current.view = view; current.nav = false;
    location.hash = view === 'incident' ? '' : view;
    redraw(); window.scrollTo(0, 0);
  }
  function openModal(modal: ModalState) { current.modal = modal; redraw(); }
  function closeModal() { current.modal = null; current.plan = null; current.ack = false; current.approved = false; redraw(); }
  async function createPlan(ids: string[], retry = false) {
    current.plan = await request('/api/access/preview', { ids, ...(retry ? { retry_of: current.activePlanId } : {}) });
    current.ack = false; current.approved = false;
    openModal({ kind: 'plan', title: retry ? 'Review the fresh bounded retry' : 'Review the access repair plan' });
  }

  async function handle(action: string, extra: Data = {}) {
    if (action === 'close') { if (!current.busy) closeModal(); return; }
    if (action === 'nav' || action === 'nav-close') { current.nav = action === 'nav' && !current.nav; redraw(); return; }
    if (action === 'incident' || action === 'lumen' || action === 'sources' || action === 'history-page') { navigate(action === 'history-page' ? 'history' : action); return; }
    if (action === 'select-eligible') { current.selected = new Set(eligible().map((account: Data) => account.id)); redraw(); return; }
    if (action === 'clear-selection') { current.selected.clear(); redraw(); return; }
    if (action === 'previous' || action === 'next') { current.page = Math.max(0, current.page + (action === 'next' ? 1 : -1)); redraw(); return; }
    if (action === 'reset-preview' || action === 'variant-preview') { openModal({ kind: 'reset', title: 'Reset the access simulator', variant: action === 'variant-preview' ? 1 : 0 }); return; }
    if (action === 'modal-download') { if (current.modal?.data) download(current.modal.data, 'reconcile-access-evidence.json'); return; }
    if (action === 'gate-download') { if (current.gate) download(current.gate, 'lumen-gate-receipt.json'); return; }
    if (action === 'history') { openModal({ kind: 'json', title: 'Historical access run · read only', data: current.report!.history[Number(extra.index)] }); return; }
    await work(async () => {
      if (action === 'reload') await refresh();
      else if (action === 'inspect-plan') {
        const bundle = await request('/api/access/audit');
        const plans = Array.isArray(bundle.plans) ? bundle.plans : Object.values(bundle.plans || {});
        const plan = plans.find((item: Data) => item.id === extra.plan);
        if (!plan) throw new Error('The saved plan is unavailable in this access run.');
        openModal({ kind: 'json', title: 'Saved access repair plan', data: plan });
      } else if (action === 'preview') await createPlan([...current.selected]);
      else if (action === 'retry-preview') await createPlan(current.report!.recovery.unresolved_ids || [], true);
      else if (action === 'approve') {
        await request('/api/access/approve', { plan_id: current.plan!.id, plan_hash: current.plan!.plan_hash, actor: current.actor });
        current.approved = true; await refresh(); notify('Approval saved. No client licence or cache was changed.');
      } else if (action === 'apply' || action === 'repeat') {
        const planId = action === 'apply' ? current.plan!.id : current.activePlanId;
        const plan = action === 'apply' ? current.plan! : current.report!.plans.find((row: Data) => row.id === planId);
        const result = await request('/api/access/apply', { plan_id: planId, plan_hash: plan.plan_hash });
        current.activePlanId = planId; closeModal(); await refresh(); current.tab = 'repair'; current.view = 'incident'; redraw();
        notify(`${result.writes_accepted} local resyncs accepted. Verify the actual gates to establish restoration.`);
      } else if (action === 'verify') {
        await request('/api/access/verify', { plan_id: current.activePlanId }); await refresh();
        const recovery = current.report!.recovery; notify(`${recovery.verified_count} gate-verified / ${recovery.unresolved_count} unresolved. Root cause is tracked separately.`);
      } else if (action === 'evidence') openModal({ kind: 'json', title: `Evidence · ${extra.user}`, data: await request(`/api/access/evidence?user=${encodeURIComponent(extra.user)}`) });
      else if (action === 'journal') openModal({ kind: 'json', title: 'Collector journal · actual app operations', data: await request('/api/access/journal') });
      else if (action === 'registry') openModal({ kind: 'json', title: 'Known account registry', data: await request('/api/access/registry') });
      else if (action === 'export') download(await request('/api/access/audit'), 'reconcile-access-audit.json');
      else if (action === 'lumen-export') { current.gate = await request('/mock/lumen/export', { user_id: current.lumenUser, feature: 'premium_export' }, true); await refresh(); }
      else if (action === 'set-handler') { await request('/api/access/demo', { action: 'handler', mode: current.handlerMode }); await refresh(); notify('Future-event demo handler changed. Existing licences were not repaired.'); }
      else if (action === 'cancel') { await request('/api/access/demo', { action: 'cancel', ids: [current.lumenUser] }); current.gate = null; await refresh(); notify('Cancellation processed by the current demo handler. Inspect the resulting gate.'); }
      else if (action === 'reset') {
        const variant = current.modal?.variant || 0;
        await request('/api/access/demo', { action: 'reset', variant });
        closeModal(); current.window = null; current.activePlanId = null; current.selected.clear(); current.gate = null; current.tab = 'accounts'; await refresh(); navigate('incident'); notify('Synthetic 100-account access scenario reset.');
      }
    });
  }

  async function detect(event: SubmitEvent) {
    event.preventDefault();
    await work(async () => {
      const incidentWindow = current.window!;
      await request('/api/access/detect', { run_id: current.report!.manifest.run_id, window_start: utcValue(incidentWindow.start), window_end: utcValue(incidentWindow.end), handler_version: incidentWindow.handler, event_type: 'subscription_renewal_cancelled', feature: 'premium_export' });
      current.selected.clear(); current.page = 0; await refresh(); notify('Registry scan complete. Confirmed accounts and exclusions are backed by current gate probes.');
    });
  }

  useEffect(() => { void work(refresh); }, []);

  if (!current.report) return <><div class="fatal-state"><span class="boot-mark">R</span><h1>Paid Access Recovery</h1><p>{current.error || 'Reading the local Lumen state…'}</p>{current.error && <Button action="reload" primary onClick={() => void work(refresh)}>Try again</Button>}</div>{toast}</>;
  const report = current.report, recovery = report.recovery, summary = report.summary;
  const accounts = report.accounts as Data[];
  const visibleRows = orderedAccounts(accounts, current.filter, current.query);
  const maxPage = Math.max(0, Math.ceil(visibleRows.length / 20) - 1);
  current.page = Math.min(current.page, maxPage);
  const pageRows = visibleRows.slice(current.page * 20, (current.page + 1) * 20);
  const scanned = Boolean(report.incident?.id);
  const scopeStats = [['Accounts in scope', summary.in_scope, 'Known client registry'], ['Evaluated', scanned ? summary.evaluated : '—', 'Identity + fresh source'], ['Affected accounts', scanned ? recovery.target_count || summary.confirmed : '—', recovery.target_count ? 'Approved incident cohort' : scanned ? 'Confirmed by current gate' : 'Run detection first'], ['Inconclusive', scanned ? summary.inconclusive : '—', 'Excluded from all writes']];
  const actionButton = (label: string, action: string, primary = false, disabled = false, extra: Data = {}) => <Button action={action} primary={primary} disabled={current.busy || disabled} {...extra} onClick={() => void handle(action, extra)}>{label}</Button>;
  const heading = (title: string, subtitle: string, actions?: ComponentChildren) => <section class="page-heading"><div class="page-title"><h1>{title}</h1><p>{subtitle}</p></div><div class="heading-actions">{actions}</div></section>;
  const badge = (label: string, tone = 'plain') => <Badge tone={tone}>{label}</Badge>;
  const mock = <MockBadge />;
  const side = <>
    {current.nav && <div class="nav-backdrop" data-action="nav-close" onClick={() => void handle('nav-close')} />}
    <aside class={`sidebar ${current.nav ? 'open' : ''}`} id="primary-navigation" aria-label="Recovery workspace navigation"><div class="sidebar-brand"><a class="brand" href="/recovery.html"><span class="brand-mark"><Icon name="logo" size={22} /></span>Reconcile</a><button type="button" class="btn-icon sidebar-close" aria-label="Close navigation" onClick={() => void handle('nav-close')}>×</button></div>
      <div class="workspace-identity"><span class="app-icon">L</span><div><strong>Mock Lumen</strong><span>Paid Access Recovery</span></div></div>
      <nav class="primary-nav"><a class="nav-button" href="/analytics.html">▦ Cases<span class="count">2</span></a>{(['incident', 'sources', 'lumen', 'history'] as View[]).map((view, index) => <button type="button" class={`nav-button ${current.view === view ? 'active' : ''}`} key={view} onClick={() => navigate(view)}>{['◈ Access incident', '▱ Sources / Collector', '◇ Lumen / Demo Lab', '◷ Evidence / Runs'][index]}</button>)}<a class="nav-button" href="/recovery-console.html">Payment Activation Recovery</a></nav>
      <div class="sidebar-bottom"><div class="local-lock"><span>◈</span><div><strong>Real local gate decisions</strong><span>Synthetic licences · no provider writes</span></div></div><a class="nav-button" href="/analytics.html">← Analytics workspace</a></div>
    </aside>
  </>;
  const stats = <div class="access-stats">{scopeStats.map(([label, value, note]) => <section class="access-stat" key={String(label)}><span>{label}</span><strong>{value}</strong><small>{note}</small></section>)}</div>;
  const accountTable = <section class="list-panel"><div class="panel-toolbar access-account-toolbar"><label class="search-field"><input id="account-search" aria-label="Search accounts" placeholder="Search account ID or reason" value={current.query} onInput={event => { current.query = event.currentTarget.value; current.page = 0; redraw(); }} /></label><select id="account-filter" aria-label="Filter access accounts" value={current.filter} onChange={event => { current.filter = event.currentTarget.value; current.page = 0; redraw(); }}><option value="all">All outcomes</option>{Object.entries(ACCESS_STATUS).map(([id, [label]]) => <option value={id} key={id}>{label}</option>)}</select></div>
    <div class="access-selection"><span><strong>{current.selected.size}</strong> accounts selected</span>{actionButton(`Select all eligible (${eligible().length})`, 'select-eligible', false, !eligible().length)}{actionButton('Clear selection', 'clear-selection', false, !current.selected.size)}{actionButton('Preview selected repair', 'preview', true, !current.selected.size)}</div>
    <div class="table-scroll"><table class="data-table access-account-table"><thead><tr><th>Select</th><th>Account / evidence</th><th>Source entitlement</th><th>Actual client gate</th><th>Outcome</th></tr></thead><tbody>{pageRows.map(account => { const outcome = ACCESS_STATUS[account.status] || [account.status, 'plain']; return <tr key={account.id}><td><input type="checkbox" data-account={account.id} aria-label={`Select ${account.id} for repair`} checked={current.selected.has(account.id)} disabled={!account.eligible || current.busy} onChange={event => { event.currentTarget.checked ? current.selected.add(account.id) : current.selected.delete(account.id); redraw(); }} /></td><td><button type="button" class="text-button mono" onClick={() => void handle('evidence', { user: account.id })}>{account.id} ↗</button><small>{account.observed_customer_denial ? 'Observed customer denial' : 'No customer attempt established'}</small></td><td>{account.source_active === true ? 'Active' : account.source_active === false ? 'Inactive / expired' : 'Unknown'}<small>{account.source_freshness}{account.source_expires_at ? ` · expires ${account.source_expires_at.slice(0, 10)}` : ''}</small></td><td>{badge(account.gate?.allowed ? 'Allows access' : 'Denies access', account.gate?.allowed ? 'green' : 'plain')}<small>{account.gate?.reason || account.reason}</small></td><td>{badge(outcome[0], outcome[1])}<small>{account.reason}</small></td></tr>; })}{pageRows.length === 0 && <tr><td colSpan={5}><div class="empty-state">No accounts match this view.</div></td></tr>}</tbody></table></div>
    <div class="panel-footer"><span>{visibleRows.length ? current.page * 20 + 1 : 0}–{Math.min((current.page + 1) * 20, visibleRows.length)} of {visibleRows.length} accounts</span><div>{actionButton('Previous', 'previous', false, current.page === 0)}{actionButton('Next', 'next', false, current.page === maxPage)}</div></div></section>;
  const planList = (recovery.plans || []).length ? recovery.plans.slice().reverse().map((plan: Data) => <section class="receipt-row" key={plan.id}><div>{badge(plan.status || (plan.approved ? 'Approved' : 'Preview'))}<strong>{plan.id}</strong></div><p>{plan.entries?.length ?? plan.account_ids?.length ?? '—'} accounts · {plan.expires_at || ''}</p><dl><dt>Plan SHA-256</dt><dd>{plan.plan_hash}</dd></dl><div class="receipt-actions">{actionButton('Inspect plan', 'inspect-plan', false, false, { 'data-plan': plan.id })}</div></section>) : <div class="empty-state"><h3>No repair plan yet</h3><p>Select confirmed accounts in the Accounts tab and preview their exact resync.</p></div>;
  const pageContent = current.view === 'incident' ? <>
    {heading('Paid access denied after renewal cancellation', 'Find the affected accounts, approve a bounded resync and prove access at the app’s real gate.', <>{actionButton('Open Lumen app', 'lumen')}{actionButton('Export evidence bundle', 'export')}</>)}
    <div class="mock-case-meta">{badge('ACCESS-001')}{badge(recoveryOutcome(recovery)[0], recoveryOutcome(recovery)[1])}<span>{report.manifest.app}</span><span>Production · premium_export</span></div>{stats}
    <div class="access-cause"><span class="access-cause-icon">◈</span><div><strong>{recovery.root_cause_status === 'pending' ? 'Root cause pending' : `Demo consumer state: ${recovery.root_cause_status}`}</strong><p>Restoring a licence changes the current app projection and cache. It does not fix or deploy the consumer that caused the incident.</p></div></div>
    <form id="incident-form" class="access-window" onSubmit={event => void detect(event)}><div><h2>Incident window</h2><p>Business occurrence time in UTC. Candidate grouping is followed by a full registry scan.</p></div><label>From (UTC)<input type="datetime-local" step="1" id="window-start" value={current.window?.start || ''} required onInput={event => { current.window!.start = event.currentTarget.value; }} /></label><label>To (UTC)<input type="datetime-local" step="1" id="window-end" value={current.window?.end || ''} required onInput={event => { current.window!.end = event.currentTarget.value; }} /></label><label>Consumer version<select id="window-handler" value={current.window?.handler || ''} onChange={event => { current.window!.handler = event.currentTarget.value; }}><option value="cancel-handler-v1">Faulty v1</option><option value="cancel-handler-v2">Fixed v2</option></select></label><button class="btn btn-primary" type="submit" disabled={current.busy}>{current.busy ? 'Working…' : 'Detect blast radius'}</button></form>
    <div class="mock-flow"><span>1. Collect actual app events</span><i>→</i><span>2. Scan the registry</span><i>→</i><span>3. Preview & approve</span><i>→</i><span>4. Resync local licence</span><i>→</i><span>5. Probe the same gate</span></div>
    <div class="mock-tabbar" role="tablist" aria-label="Access case views">{(['accounts', 'repair', 'scope'] as const).map((tab, index) => <button type="button" role="tab" aria-selected={current.tab === tab} class={current.tab === tab ? 'active' : ''} key={tab} onClick={() => { current.tab = tab; redraw(); }}>{['Accounts', 'Repair & verify', 'Scope & exclusions'][index]}<span>{[accounts.length, recovery.target_count, summary.inconclusive][index]}</span></button>)}</div>
    {current.tab === 'accounts' ? accountTable : current.tab === 'repair' ? <><section class="access-recovery-card"><div><span class="lab-eyebrow">VERIFIED OUTCOMES</span><h2>{recovery.verified_count || 0}<small> / {recovery.target_count || 0} accounts verified at the gate</small></h2><p>{recovery.unresolved_count || 0} unresolved · {summary.inconclusive} inconclusive accounts remain excluded.</p></div>{badge(recoveryOutcome(recovery)[0], recoveryOutcome(recovery)[1])}<div class="receipt-actions">{actionButton('Verify actual gates', 'verify', true, !current.activePlanId)}{actionButton('Repeat approved apply', 'repeat', false, !current.activePlanId)}{actionButton(`Preview fresh retry (${(recovery.unresolved_ids || []).length})`, 'retry-preview', false, !(recovery.unresolved_ids || []).length)}{actionButton('Export evidence bundle', 'export')}</div></section><div class="source-intro-note"><div><strong>Write acceptance is not access restoration.</strong> Verification calls the same premium gate as the Lumen app. A successful projection write with stale cache remains unresolved. A retry needs a new preview, fresh checks and approval.</div></div>{planList}</> : <div class="access-scope-grid"><section class="mock-contract-card"><h2>Coverage and exclusions</h2><dl>{Object.entries(summary).map(([key, value]) => <><dt key={`${key}-dt`}>{key.replaceAll('_', ' ')}</dt><dd key={`${key}-dd`}>{String(value)}</dd></>)}</dl><p class="table-note">A previous payment is not proof of current access. Unknown identity, unavailable/stale entitlement, unsupported policy and incomplete processing never receive a repair.</p></section><section class="mock-contract-card"><h2>What this repair changes</h2><p>The current client projection and cache are refreshed from the current source entitlement. The original entitlement expiry stays unchanged.</p><p>Real charges, refunds, renewal choices and source licences are outside this local repair.</p><h2>Current incident</h2><pre class="access-inline-json">{pretty(report.incident)}</pre></section></div>}
  </> : current.view === 'lumen' ? <>
    {heading('Lumen · client app simulator', 'A small working client surface. Its premium export calls the same backend gate used by recovery verification.', actionButton('Back to incident', 'incident'))}
    <div class="lumen-layout"><section class="lumen-app-card"><div class="lumen-app-header"><span class="lumen-logo">L</span><div><strong>Lumen</strong><small>Synthetic photo workspace</small></div>{badge('Client simulator', 'blue')}</div><div class="lumen-canvas"><span class="lumen-sun" /><span class="lumen-hill one" /><span class="lumen-hill two" /><span class="lumen-canvas-label">Your next perspective.</span></div><div class="lumen-app-content"><label>Demo account<select id="lumen-user" value={current.lumenUser} onChange={event => { current.lumenUser = event.currentTarget.value; current.gate = null; redraw(); }}>{orderedAccounts(accounts).map(account => <option value={account.id} key={account.id}>{account.id} · {ACCESS_STATUS[account.status]?.[0] || account.status}</option>)}</select></label><div class="lumen-entitlement"><span>Source entitlement<strong>{accounts.find((account: Data) => account.id === current.lumenUser)?.source_active === true ? 'Active paid period' : accounts.find((account: Data) => account.id === current.lumenUser)?.source_active === false ? 'Inactive' : 'Unknown'}</strong></span><span>App access state<strong>{accounts.find((account: Data) => account.id === current.lumenUser)?.gate?.allowed ? 'Gate allows access' : 'Gate denies access'}</strong></span></div>{actionButton('Export premium preview', 'lumen-export', true, !current.lumenUser)}<p class="table-note">This is an actual local request and customer-attempt journal entry, not a prerecorded animation.</p>{current.gate && <div class={`lumen-gate-result ${current.gate.allowed ? 'allowed' : 'denied'}`} role="status"><strong>{current.gate.allowed ? '200 · Premium export allowed' : '403 · Premium export denied'}</strong><p>{current.gate.reason || current.gate.reason_code}</p><details><summary>Gate response and versions</summary><pre>{pretty(current.gate)}</pre></details>{current.gate.allowed ? actionButton('Download gate receipt', 'gate-download') : actionButton('Investigate this account', 'incident')}</div>}</div></section>
      <div><section class="mock-contract-card"><h2>Collector SDK</h2><p>Consumer events, projection changes, customer access decisions and resync results are signed and recorded by our server-side SDK.</p><div class="access-collector-count"><strong>{report.collector.event_count}</strong><span>recorded metadata events</span></div><p>Only allowlisted subscription/access metadata is accepted. No card details or payment credentials are collected.</p>{actionButton('Inspect collector journal', 'journal')}</section><section class="mock-contract-card"><h2>Demo controls</h2><p>Handler changes apply to future cancellation events. Resyncing an account does not deploy a root-cause fix.</p><label class="access-field">Future cancellation handler<select id="handler-mode" value={current.handlerMode} onChange={event => { current.handlerMode = event.currentTarget.value; redraw(); }}><option value="faulty">Faulty v1</option><option value="fixed">Fixed v2</option></select></label><div class="receipt-actions">{actionButton('Set demo handler', 'set-handler')}{actionButton('Send cancellation to selected account', 'cancel')}</div><div class="access-demo-reset"><p>Reset only this access run. Analytics evidence is preserved.</p>{actionButton('Reset 100-account scenario', 'reset-preview')}{actionButton('Use alternate 100-account seed', 'variant-preview')}</div></section></div></div>
  </> : current.view === 'sources' ? <>
    {heading('Sources / Collector', 'Separate source entitlement, client state and real gate decisions.', actionButton('Export evidence bundle', 'export'))}
    <div class="source-inventory">{[['Source entitlement', 'Synthetic Adapty-shaped current access observations. A payment amount alone never establishes entitlement.'], ['Client projection & cache', 'Independent revisioned state written by the Lumen consumer. Stale cache can deny access after a successful resync.'], ['Collector SDK journal', `${report.collector.event_count} signed metadata events generated by actual local app operations. Customer decisions and reconciliation probes carry separate initiators.`]].map(([title, note]) => <article class="inventory-card" key={title}><div class="inventory-heading"><strong>{title}</strong>{badge('Synthetic / local', 'blue')}</div><p>{note}</p></article>)}</div>
    <section class="mock-contract-card"><h2>Run manifest</h2><dl>{Object.entries(report.manifest).map(([key, value]) => <><dt key={`${key}-dt`}>{key}</dt><dd key={`${key}-dd`}>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></>)}</dl><div class="receipt-actions">{actionButton('View registry', 'registry')}{actionButton('View collector journal', 'journal')}</div></section>
  </> : <>
    {heading('Evidence / Run history', 'Recorded scans, gate checks and approval receipts stay tied to the access run.', actionButton('Export evidence bundle', 'export'))}
    <section class="list-panel"><div class="panel-toolbar"><strong>Access run history</strong><span>Latest 20 recorded operations</span></div>{report.history.length ? report.history.slice().reverse().map((row: Data, index: number) => <div class="access-history-row" key={index}><div><strong>{row.action || row.kind || row.type || 'Snapshot'}</strong><small>{row.at || row.id || row.created_at || row.scenario_now || ''}</small></div>{actionButton('Inspect record', 'history', false, false, { 'data-index': report.history.length - index - 1 })}</div>) : <div class="empty-state">Detect or verify an incident to record a snapshot.</div>}</section>
  </>;

  return <><div class="app-shell mock-app access-app">{side}<div class="main-shell"><header class="topbar"><div class="toolbar-location"><button type="button" class="btn-icon mobile-nav-button" aria-label="Open navigation" aria-expanded={current.nav} aria-controls="primary-navigation" onClick={() => void handle('nav')}>☰</button><div class="breadcrumbs"><a href="/analytics.html">Cases</a><span> / </span><strong>ACCESS-001</strong></div></div><div class="topbar-actions">{mock}</div></header><main class="page" id="main-content" tabindex={-1}>{current.error && <div class="mock-error" role="alert">{current.error} {actionButton('Refresh current state', 'reload')}</div>}{pageContent}</main><footer class="mock-footer"><span>Source entitlement → client projection → cache → actual premium gate</span><span>Local synthetic app · no payment credentials</span></footer></div></div>
    {current.modal?.kind === 'plan' && current.plan && <Modal title={current.modal.title} labelledBy="access-dialog-title" eyebrow="PAID ACCESS RECOVERY" busy={current.busy} onClose={closeModal} footer={<>{actionButton('Approve this repair plan', 'approve', false, !current.ack || !current.actor.trim())}{actionButton('Apply approved repair', 'apply', true, !current.ack || !current.approved)}{actionButton('Close', 'close')}</>}>
      <p class="overlay-intro">Review the exact accounts, unchanged entitlement expiry and proposed local projection/cache changes. Approval records a decision; Apply performs the resync.</p><div class="access-plan-summary">{badge(`${current.plan.entries.length} accounts selected`, 'blue')}<span>Valid until {current.plan.expires_at}</span></div><dl><dt>Plan ID</dt><dd>{current.plan.id}</dd><dt>Plan SHA-256</dt><dd>{current.plan.plan_hash}</dd></dl>
      {current.plan.entries.map((entry: Data, index: number) => <details class="access-plan-entry" key={index}><summary>{entry.account_id} · bounded current-state resync</summary><pre>{pretty(entry)}</pre></details>)}
      {current.plan.exclusions?.length > 0 && <section class="mock-json-block"><h3>Excluded accounts</h3><pre>{pretty(current.plan.exclusions)}</pre></section>}
      <label class="approval-ack"><input type="checkbox" id="access-ack" checked={current.ack} disabled={current.busy} onChange={event => { current.ack = event.currentTarget.checked; current.approved = false; redraw(); }} /><span>I reviewed the exact account scope and evidence. I approve this local licence/cache repair without extending source entitlements.</span></label>
      <label class="actor-field">Approval actor<input id="access-actor" value={current.actor} maxLength={100} disabled={current.busy} onInput={event => { current.actor = event.currentTarget.value; current.approved = false; redraw(); }} /></label>
      <p class="table-note">Plan expiry and source freshness use the explicit mock clock in UTC. Signature authentication uses actual wall-clock time.</p>
    </Modal>}
    {current.modal?.kind === 'reset' && <Modal title={current.modal.title} labelledBy="access-dialog-title" eyebrow="PAID ACCESS RECOVERY" busy={current.busy} onClose={closeModal} footer={<>{actionButton('Export current evidence first', 'export')}{actionButton('Reset access run', 'reset', true)}{actionButton('Close', 'close')}</>}><p class="overlay-intro">Reset the access simulator to {current.modal.variant ? 'a different synthetic 100-account population' : 'the default 100-account scenario'}? This clears this access run’s approvals, repairs and history. The analytics run is preserved.</p></Modal>}
    {current.modal?.kind === 'json' && <Modal title={current.modal.title} labelledBy="access-dialog-title" eyebrow="PAID ACCESS RECOVERY" busy={current.busy} onClose={closeModal} footer={<>{actionButton('Download evidence', 'modal-download')}{actionButton('Close', 'close')}</>}><section class="mock-json-block"><h3>{current.modal.title}</h3><pre>{pretty(current.modal.data)}</pre></section></Modal>}
    {toast}</>;
}
