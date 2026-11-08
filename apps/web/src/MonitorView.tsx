import type { ExportKind, IncidentStatus, SimulationAction } from './model';

type Json = Record<string, unknown>;
type Incident = Json & {
  id: string;
  title?: string;
  status?: string;
  affected_accounts?: string | number;
  repaired_accounts?: string | number;
  externally_restored_accounts?: string | number;
  detected_at?: string;
  repair_started_at?: string;
  repaired_at?: string;
  resolved_at?: string;
  duration_ms?: number;
  description?: string;
  repair_summary?: string;
  next_step?: string;
  source_provenance?: string;
  payment_verification?: string;
  actions?: Array<{ owner?: string; status?: string }>;
};
type Step = { name?: string; status?: string; owner?: string; result?: string; at?: string; gap?: boolean };
type Observation = {
  user_id?: string;
  transaction_id?: string;
  trace_id?: string;
  status?: string;
  created_at?: string;
  recorded_at?: string;
  steps?: Step[];
  next_step?: string;
};
export type Trace = {
  traces?: Observation[];
  processing_receipts?: Observation[];
  processing_receipts_truncated?: boolean;
  steps?: Step[];
  snapshot_at?: string;
  _loaded_at?: string;
  reason?: string;
  next_step?: string;
};
export type Fulfillment = {
  key?: string | { customer_id?: string; transaction_id?: string; access_level?: string; app?: string; store?: string };
  source_period?: string | { starts_at?: string; expires_at?: string };
  stages?: Record<string, unknown>;
  telemetry_gap?: boolean;
  telemetry_status?: string;
  reason?: string;
  next_step?: string;
};
export type MonitorFeed = {
  mode?: string;
  app?: { title?: string; environment?: string };
  automation?: { enabled?: boolean };
  connection?: { ready?: boolean; active_accounts?: number; checked_accounts?: number; total_accounts?: number; cli_version?: string; catalog_product_count?: number; source_observed_at?: string };
  summary?: { incidents?: number; fixed?: number; needs_attention?: number };
  telemetry?: { queued?: number; dropped?: number; failed?: number; last_error?: string };
  simulation?: { status?: string; available?: boolean; bootstrap_required?: boolean; bootstrap_status?: string; completed?: number; total?: number; continuous?: boolean; waiting_reason?: string; error?: string };
  pagination?: { total?: number; next_cursor?: string | number | null };
  coverage?: { complete?: boolean; source_fresh?: boolean; waiting_reason?: string };
  proactive?: { waiting_reason?: string };
  incidents?: Incident[];
};

const text = (value: unknown, fallback = '') => String(value ?? fallback);
const count = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const statusNames: Record<string, string> = { detecting: 'Detecting', repairing: 'Repairing', repaired: 'Repaired',
  resolved_externally:'Restored externally', unresolved: 'Needs attention' };
const statusName = (value: unknown) => statusNames[text(value)] || 'Unknown';
const duration = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value) < 1000 ? `${Math.round(Number(value))} ms` : `${(Number(value) / 1000).toFixed(1)} s`;
const when = (value: unknown) => {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : `${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
};

function keyLabel(value: Fulfillment['key']) {
  if (value && typeof value === 'object') {
    return [value.customer_id, value.transaction_id, value.access_level, value.app, value.store].filter(Boolean).map(String).join(' · ') || 'Access update';
  }
  return text(value, 'Access update');
}

function stageStatus(value: unknown, expected: string) {
  const status = value && typeof value === 'object' ? text((value as Json).status) : typeof value === 'string' ? value : value === true ? expected : '';
  return { label: status || (value === false ? 'Not confirmed' : 'Unknown'), complete: status === expected || status === 'verified' };
}

function TraceDetails({ trace }: { trace: Trace }) {
  const observations = [...(trace.traces || []), ...(trace.processing_receipts || [])];
  if (trace.steps) observations.unshift({ steps: trace.steps, user_id: 'Incident' });
  const accounts = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = observation.user_id || observation.transaction_id || observation.trace_id || 'Incident';
    if (!accounts.has(key)) accounts.set(key, []);
    accounts.get(key)!.push(observation);
  }
  const labels: Record<string, string> = {
    verified_application: 'Access verified',
    discrepancy: 'Access mismatch',
    awaiting_application: 'Processing',
    inconclusive: 'Needs evidence',
  };
  return <>
    {trace.processing_receipts_truncated && <p>Processing activity is incomplete; additional receipts are not shown.</p>}
    {[...accounts].map(([account, entries]) => {
      const status = entries.filter(entry => entry.status).at(-1)?.status;
      const label = labels[status || ''] || status || 'Observed processing';
      return <details class="trace-account" key={account}>
        <summary>{account} · {label}</summary>
        {entries.map((entry, index) => <div key={`${account}-${index}`}>
          <p>{when(entry.created_at || entry.recorded_at)}</p>
          <ol class="trace-list">{(entry.steps || []).map((step, stepIndex) => <li key={`${step.name}-${stepIndex}`}>
            <b>{text(step.name, 'Step').replaceAll('_', ' ')}</b> · {text(step.status, 'Unknown')}
            <p>{text(step.owner, 'Owner unavailable')} · {text(step.result, 'Result unavailable')}{step.at ? ` · ${when(step.at)}` : ''}</p>
            {step.gap && <p>Telemetry incomplete</p>}
          </li>)}</ol>
        </div>)}
      </details>;
    })}
    {accounts.size === 0 && <p>Step details unavailable.</p>}
  </>;
}

type Props = {
  data: MonitorFeed | null;
  pollError: string;
  actionError: string;
  pending: boolean;
  requestMessage: string;
  status: IncidentStatus;
  selectedStatus: IncidentStatus;
  fulfillments: Fulfillment[];
  traces: Record<string, Trace>;
  range: { from: string; to: string };
  page: number;
  statusMessage: string;
  onRefresh: () => void;
  onAction: (action: SimulationAction) => void;
  onPage: (page: number) => void;
  onFilter: (status: IncidentStatus) => void;
  onFilterSelection: (status: IncidentStatus) => void;
  onTrace: (id: string) => void;
  onExport: (kind: ExportKind) => void;
  onRangeInput: (name: 'from' | 'to', value: string) => void;
  onDismissError: () => void;
};

export function MonitorView(props: Props) {
  const { data, pollError, actionError, pending, requestMessage, status, selectedStatus, fulfillments, traces, range, page, statusMessage } = props;
  if (!data) return <main class="monitor-shell">
    <p class="notice" role="alert">{pollError || 'Loading incident feed…'}</p>
    <button type="button" onClick={props.onRefresh}>Try again</button>
  </main>;

  const incidents = Array.isArray(data.incidents) ? [...data.incidents].sort((a, b) => text(b.detected_at).localeCompare(text(a.detected_at))) : [];
  const active = data.automation?.enabled === true;
  const sim = data.simulation || {};
  const bootstrap = sim.bootstrap_required === true;
  const running = ['queued', 'running', 'waiting'].includes(sim.status || '');
  const waiting = running || sim.error ? text(sim.waiting_reason || sim.error).replaceAll('_', ' ') : '';
  const sourceReady = data.connection?.ready === true;
  const simulationReady = sim.available !== false;
  const legacy = sim.bootstrap_status === 'not_required';
  const primaryAction: SimulationAction = running ? 'stop' : bootstrap ? 'bootstrap' : legacy ? 'start' : 'continuous';
  const primaryLabel = running ? 'Stop simulation' : bootstrap ? 'Start demo' : legacy ? 'Run demo' : 'Run continuously';
  const simulationControls = active
    ? <><button type="button" class="button primary" data-action={primaryAction} disabled={pending || !simulationReady || (!running && !sourceReady)} onClick={() => props.onAction(primaryAction)}>{simulationReady ? primaryLabel : 'Simulation unavailable'}</button>
      {!bootstrap && <button type="button" class="button" data-action="once" disabled={pending || running || !sourceReady || !simulationReady} onClick={() => props.onAction('once')}>Run once</button>}</>
    : <a class="button" href="/recovery-console.html">Open advanced tools</a>;

  return <>
    <div class="visually-hidden" role="status" aria-live="polite">{statusMessage}</div>
    <div class="monitor-shell">
      <header class="monitor-header">
        <a class="brand" href="/recovery.html"><span class="brand-mark">R</span>Reconcile</a>
        <div class="identity"><span class="app-icon">L</span><span><b>{text(data.app?.title, 'Lumen')}</b><small>{text(data.app?.environment, 'Environment unavailable')}</small></span></div>
        <span class="live-badge">{data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Live Adapty · Seeded data' : 'Local demo'}</span>
        <span class={`connection ${sourceReady ? 'ready' : ''}`}>Source {sourceReady ? 'ready' : 'unavailable'} · last check</span>
      </header>
      <main>
        <section class="intro"><div><p class="eyebrow">{active ? 'Automatic monitoring' : 'Manual mode'}</p><h1>Access recovery</h1><p>We detect access problems, restore verified access, and check the result.</p></div><div class="controls">{simulationControls}</div></section>
        {pollError && <p class="notice" role="alert">{pollError} <button type="button" onClick={props.onRefresh}>Retry</button></p>}
        {actionError && <p class="notice" role="alert">{actionError} <button type="button" onClick={props.onDismissError}>Dismiss</button></p>}
        {sim.status === 'failed' && <p class="notice" role="alert">Simulation failed: {text(sim.error, 'No details provided.')}</p>}
        {requestMessage && <p class="progress" role="status" aria-live="polite">{requestMessage}</p>}
        {!requestMessage && running && <p class="progress" role="status" aria-live="polite">{waiting || (sim.continuous ? `Continuous run · ${count(sim.completed)} scenarios completed` : `Simulation running · ${count(sim.completed)} of ${count(sim.total)} scenarios completed`)}</p>}
        {!requestMessage && !running && waiting && <p class="progress" role="status" aria-live="polite">{waiting}</p>}
        <section class="summaries" aria-label="Incident summary">
          <article><span>Incidents</span><b>{count(data.summary?.incidents)}</b></article>
          <article><span>Fixed</span><b>{count(data.summary?.fixed)}</b></article>
          <article><span>Needs attention</span><b>{count(data.summary?.needs_attention)}</b></article>
        </section>
        <section class="feed">
          <div class="feed-heading"><h2>{statusName(status)}</h2><span>{count(data.pagination?.total ?? data.summary?.needs_attention)} total · refreshes automatically</span></div>
          <form class="filters" data-form="filters" onSubmit={event => { event.preventDefault(); props.onFilter((new FormData(event.currentTarget).get('status') || 'unresolved') as IncidentStatus); }}>
            <label>Status <select name="status" value={selectedStatus} onChange={event => props.onFilterSelection(event.currentTarget.value as IncidentStatus)}>
              <option value="unresolved">Needs attention</option>
              {(['detecting', 'repairing', 'repaired'] as IncidentStatus[]).map(value => <option value={value} key={value}>{statusName(value)}</option>)}
            </select></label>
            <button class="button" type="submit">Apply filter</button>
            <span>{data.coverage?.waiting_reason ? text(data.coverage.waiting_reason) : data.proactive?.waiting_reason ? text(data.proactive.waiting_reason) : `Coverage ${data.coverage?.complete === true ? 'complete' : data.coverage?.complete === false ? 'incomplete' : 'unknown'} · Source ${data.coverage?.source_fresh === true ? 'fresh' : data.coverage?.source_fresh === false ? 'stale' : 'freshness unknown'}`}</span>
          </form>
          <div class="column-head" aria-hidden="true"><span>What happened</span><span>Accounts</span><span>Result</span><span>Detected</span><span>Recovery time</span></div>
          {incidents.length ? incidents.map(item => {
            const actionSummary = new Map<string, number>();
            for (const action of item.actions || []) {
              const label = `${action.owner || 'Owner unavailable'} · ${action.status || 'status unavailable'}`;
              actionSummary.set(label, (actionSummary.get(label) || 0) + 1);
            }
            const actions = [...actionSummary].map(([label, total]) => `${label} · ${total} ${total === 1 ? 'step' : 'steps'}`).join(' · ');
            const trace = traces[item.id];
            const traceNext = trace?.next_step || [...new Set(trace?.traces?.map(entry => entry.next_step).filter(Boolean) || [])].join(' · ');
            const outstanding = Math.max(0,count(item.affected_accounts)-count(item.repaired_accounts)-count(item.externally_restored_accounts));
            return <details class="incident" data-incident={item.id} key={item.id}>
              <summary><span><b>{text(item.title, 'Access incident')}</b><small>{statusName(item.status)}</small></span><span>{text(item.affected_accounts, '—')} affected</span><span>{item.repaired_accounts != null ? `${item.repaired_accounts} repaired` : statusName(item.status)}{count(item.externally_restored_accounts) ? ` · ${item.externally_restored_accounts} restored externally` : ''}{outstanding ? ` · ${outstanding} unresolved` : ''}</span><span>{when(item.detected_at)}</span><span>{duration(item.duration_ms)}</span></summary>
              <div class="incident-body">
                <p>{text(item.description, 'No description provided.')}</p>
                <dl><dt>Recovery</dt><dd>{text(item.repair_summary, 'No recovery summary provided.')}</dd><dt>Detected</dt><dd>{when(item.detected_at)}</dd><dt>Recovery started</dt><dd>{when(item.repair_started_at)}</dd><dt>{item.status === 'resolved_externally' ? 'Restored' : 'Repaired'}</dt><dd>{when(item.status === 'resolved_externally' ? item.resolved_at : item.repaired_at)}</dd><dt>Source</dt><dd>{text(item.source_provenance, 'Unavailable')}</dd><dt>Payment verification</dt><dd>{text(item.payment_verification, 'Unavailable')}</dd>{item.status === 'unresolved' && <><dt>Next step</dt><dd>{text(item.next_step, 'Review the advanced tools.')}</dd></>}</dl>
                {actions && <p class="action-status">{actions}</p>}
                {trace ? <><h3>Activity</h3><p>Snapshot {when(trace.snapshot_at || trace._loaded_at)} <button type="button" class="button" data-action="trace" data-id={item.id} onClick={() => props.onTrace(item.id)}>Refresh activity</button></p>{trace.reason && <p>{trace.reason}</p>}<TraceDetails trace={trace} /><p>Next action: {traceNext || 'No next action recorded.'}</p></> : <button type="button" class="button" data-action="trace" data-id={item.id} onClick={() => props.onTrace(item.id)}>View activity</button>}
              </div>
            </details>;
          }) : <p class="empty">{data.summary?.incidents ? status === 'unresolved' ? 'No incidents need attention' : 'No incidents in this view' : 'No incidents yet'}<span>{active ? 'Monitoring continues automatically.' : <><a href="/recovery-console.html">Open advanced tools</a> to investigate manually.</>}</span></p>}
          <div class="pager"><button type="button" data-action="page" data-page={Math.max(0, page - 1)} disabled={page === 0} onClick={() => props.onPage(Math.max(0, page - 1))}>Previous</button><span>Page {page + 1}{data.pagination?.total != null ? ` · ${count(data.pagination.total)} incidents` : ''}</span><button type="button" data-action="page" data-page={page + 1} disabled={data.pagination?.next_cursor == null} onClick={() => props.onPage(page + 1)}>Next</button></div>
        </section>
        <section class="feed activity-feed">
          <div class="feed-heading"><h2>Activity</h2><span>Adapty recorded → Application applied → Access verified</span></div>
          <details class="integration"><summary>Observed access updates · latest {count(fulfillments.length)}</summary>
            {fulfillments.map((fulfillment, index) => <article class="fulfillment" key={`${keyLabel(fulfillment.key)}-${index}`}>
              <strong>{keyLabel(fulfillment.key)}</strong><span>{fulfillment.source_period && typeof fulfillment.source_period === 'object' ? `${when(fulfillment.source_period.starts_at)} → ${when(fulfillment.source_period.expires_at)}` : text(fulfillment.source_period, 'Period unavailable')}</span>
              <ol class="stages">{([['source_recorded', 'Adapty recorded', 'recorded'], ['application_applied', 'Application applied', 'applied'], ['access_verified', 'Access verified', 'verified']] as const).map(([key, label, expected]) => {
                const stage = stageStatus(fulfillment.stages?.[key], expected);
                return <li class={stage.complete ? 'complete' : 'unknown'} key={key}>{label}: {stage.label}</li>;
              })}</ol>
              <p>{fulfillment.telemetry_gap ? 'Processing telemetry is incomplete.' : fulfillment.telemetry_status === 'unknown'
                ? 'Processing telemetry has not been checked.' : text(fulfillment.reason, 'Status unavailable')}</p><p>Next action: {text(fulfillment.next_step, 'No next action recorded.')}</p>
            </article>)}
            {fulfillments.length === 0 && <p class="empty">No recent activity recorded.</p>}
          </details>
        </section>
        <form class="export-range" data-form="export" onSubmit={event => event.preventDefault()}>
          <h2>Download activity</h2>
          <label>From (UTC) <input name="from" type="datetime-local" step="1" value={range.from} required onInput={event => props.onRangeInput('from', event.currentTarget.value)} /></label>
          <label>To (UTC) <input name="to" type="datetime-local" step="1" value={range.to} required onInput={event => props.onRangeInput('to', event.currentTarget.value)} /></label>
          <button class="button" type="button" data-action="csv" onClick={() => props.onExport('csv')}>Download CSV</button>
          <button class="button" type="button" data-action="json" onClick={() => props.onExport('json')}>Download JSON</button>
        </form>
        <details class="integration"><summary>Integration details</summary><dl>
          <dt>CLI version</dt><dd>{text(data.connection?.cli_version, 'Unavailable')}</dd>
          <dt>Products</dt><dd>{count(data.connection?.catalog_product_count)}</dd>
          <dt>Monitored registry</dt><dd>{count(data.connection?.checked_accounts ?? data.connection?.active_accounts)} profiles checked · {count(data.connection?.total_accounts)} total accounts</dd>
          <dt>Source readiness (last check)</dt><dd>{sourceReady ? 'Ready' : 'Unavailable'} · {when(data.connection?.source_observed_at)}</dd>
          <dt>SDK telemetry</dt><dd>{count(data.telemetry?.queued)} queued · {count(data.telemetry?.dropped)} dropped · {count(data.telemetry?.failed)} errors</dd>
        </dl>
          <p class="scope-note">{data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Counts reflect the selected seeded registry, not the full provider account population.' : 'Counts reflect the current demo scope.'}</p>
          {data.telemetry?.last_error && <p>{data.telemetry.last_error}</p>}
          <a href="/recovery-console.html">Advanced tools</a>
        </details>
      </main>
    </div>
  </>;
}
