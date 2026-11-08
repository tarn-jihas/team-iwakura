export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function csv(rows) {
  const fields = ['id','status','title','affected_accounts','repaired_accounts','detected_at','repair_started_at','repaired_at','duration_ms','description','repair_summary','next_step','source_provenance','payment_verification'];
  const cell = value => {
    let text = value == null ? '' : Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  return [fields.map(cell).join(','), ...rows.map(row => fields.map(key => cell(row[key])).join(','))].join('\r\n');
}

const when = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : `${new Intl.DateTimeFormat('en', {dateStyle:'medium', timeStyle:'short', timeZone:'UTC'}).format(date)} UTC`;
};
const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const statusName = value => ({detecting:'Detecting',repairing:'Repairing',repaired:'Repaired',unresolved:'Needs attention'}[value] || 'Unknown');
const duration = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value) < 1000 ? `${Math.round(Number(value))} ms` : `${(Number(value) / 1000).toFixed(1)} s`;
const keyLabel = value => value && typeof value === 'object' ? [value.customer_id, value.transaction_id, value.access_level, value.app, value.store].filter(Boolean).map(esc).join(' · ') || 'Access update' : esc(value || 'Access update');
const stageStatus = (value, expected) => {
  const status = typeof value === 'object' && value ? value.status : typeof value === 'string' ? value : value === true ? expected : '';
  return {label:status || (value === false ? 'Not confirmed' : 'Unknown'),complete:status === expected || status === 'verified'};
};

function renderTrace(trace) {
  const observations = [...(trace.traces || []), ...(trace.processing_receipts || [])];
  if (trace.steps) observations.unshift({steps:trace.steps,user_id:'Incident'});
  const accounts = new Map();
  for (const observation of observations) {
    const key = observation.user_id || observation.transaction_id || observation.trace_id || 'Incident';
    if (!accounts.has(key)) accounts.set(key, []);
    accounts.get(key).push(observation);
  }
  return [...accounts].map(([account, entries]) => {
    const status = entries.filter(entry => entry.status).at(-1)?.status;
    const label = {verified_application:'Access verified',discrepancy:'Access mismatch',awaiting_application:'Processing',inconclusive:'Needs evidence'}[status] || status || 'Observed processing';
    return `<details class="trace-account"><summary>${esc(account)} · ${esc(label)}</summary>${entries.map(entry => `<p>${when(entry.created_at || entry.recorded_at)}</p><ol class="trace-list">${(entry.steps || []).map(step => `<li><b>${esc(String(step.name || 'Step').replaceAll('_',' '))}</b> · ${esc(step.status || 'Unknown')}<p>${esc(step.owner || 'Owner unavailable')} · ${esc(step.result || 'Result unavailable')}${step.at ? ` · ${when(step.at)}` : ''}</p>${step.gap ? '<p>Telemetry incomplete</p>' : ''}</li>`).join('')}</ol>`).join('')}</details>`;
  }).join('') || '<p>Step details unavailable.</p>';
}

const stepMark = {ok:'✓', failed:'✗', running:'…'};
function renderTimeline(steps) {
  return `<ol class="timeline">${steps.map(step => `<li class="step-${esc(step.status)}"><span class="step-mark" aria-hidden="true">${stepMark[step.status] || '•'}</span><div><b>${esc(step.step)}</b> <small>${esc(step.owner)}${step.at ? ` · ${when(step.at)}` : ''}</small><p>${esc(step.detail)}</p></div></li>`).join('')}</ol>`;
}
function renderFailure(failure) {
  if (!failure) return '';
  const accounts = (failure.accounts || []).slice(0, 6).map(item => `${esc(item.account)} (${esc(item.reason)})`).join(', ');
  const more = (failure.accounts || []).length > 6 ? ` and ${failure.accounts.length - 6} more` : '';
  return `<div class="stopped-at" role="note"><b>Stopped at: ${esc(failure.step)}</b> <small>${esc(failure.owner)}</small>${failure.reason ? `<p>${esc(failure.reason)}</p>` : ''}${accounts ? `<p>Accounts: ${accounts}${more}</p>` : ''}</div>`;
}

export function renderMonitor(data, {pollError = '', actionError = '', pending = false, requestMessage = '', status = 'unresolved', fulfillments = [], traces = {}, range = {from:new Date(Date.now()-86400000).toISOString().slice(0,19),to:new Date(Date.now()+1000).toISOString().slice(0,19)}, page = 0} = {}) {
  if (!data) return `<main class="monitor-shell"><p class="notice" role="alert">${esc(pollError || 'Loading incident feed…')}</p><button data-action="refresh">Try again</button></main>`;
  const incidents = Array.isArray(data.incidents) ? [...data.incidents].sort((a,b) => String(b.detected_at||'').localeCompare(String(a.detected_at||''))) : [];
  const active = data.automation?.enabled === true;
  const row = item => {
    const actionSummary = new Map();
    for (const action of item.actions || []) {
      const label = `${action.owner || 'Owner unavailable'} · ${action.status || 'status unavailable'}`;
      actionSummary.set(label, (actionSummary.get(label) || 0) + 1);
    }
    const actions = [...actionSummary].map(([label, total]) => `${label} · ${total} ${total === 1 ? 'step' : 'steps'}`).join(' · ');
    const trace = traces[item.id];
    const traceNext = trace?.next_step || [...new Set(trace?.traces?.map(x => x.next_step).filter(Boolean) || [])].join(' · ');
    const traceHtml = trace ? `<h3>Activity</h3><p>Snapshot ${when(trace.snapshot_at || trace._loaded_at)} <button class="button" data-action="trace" data-id="${esc(item.id)}">Refresh activity</button></p>${trace.reason ? `<p>${esc(trace.reason)}</p>` : ''}${renderTrace(trace)}<p>Next action: ${esc(traceNext || 'No next action recorded.')}</p>` : `<button class="button" data-action="trace" data-id="${esc(item.id)}">View activity</button>`;
    const watching = item === incidents[0] && ['detecting','repairing'].includes(item.status);
    return `<details class="incident" data-incident="${esc(item.id)}"${watching ? ' open' : ''}><summary><span><b>${esc(item.title || 'Access incident')}</b><small>${item.failure ? `Stopped at: ${esc(item.failure.step)}` : statusName(item.status)}</small></span><span>${esc(item.affected_accounts ?? '—')}</span><span>${statusName(item.status)}${item.repaired_accounts != null ? ` · ${esc(item.repaired_accounts)} repaired` : ''}</span><span>${when(item.detected_at)}</span><span>${duration(item.duration_ms)}</span></summary><div class="incident-body">${renderFailure(item.failure)}<p>${esc(item.description || 'No description provided.')}</p><dl><dt>Recovery</dt><dd>${esc(item.repair_summary || 'No recovery summary provided.')}</dd><dt>Detected</dt><dd>${when(item.detected_at)}</dd><dt>Recovery started</dt><dd>${when(item.repair_started_at)}</dd><dt>Repaired</dt><dd>${when(item.repaired_at)}</dd><dt>Source</dt><dd>${esc(item.source_provenance || 'Unavailable')}</dd><dt>Payment verification</dt><dd>${esc(item.payment_verification || 'Unavailable')}</dd>${item.status === 'unresolved' ? `<dt>Next step</dt><dd>${esc(item.next_step || 'Review the step trace below.')}</dd>` : ''}</dl>${Array.isArray(item.timeline) ? `<h3>What happened, step by step</h3>${renderTimeline(item.timeline)}` : `${actions ? `<p class="action-status">${esc(actions)}</p>` : ''}${traceHtml}`}</div></details>`;
  };
  const attention = incidents.filter(item => item.status === 'unresolved');
  const flowing = incidents.filter(item => item.status !== 'unresolved');
  const rows = flowing.length ? flowing.map(row).join('') : `<p class="empty">${data.summary?.incidents ? 'No other incidents' : 'No incidents yet'}<span>${active ? 'Monitoring continues automatically.' : 'Automatic recovery is off.'}</span></p>`;
  const sim = data.simulation || {};
  const bootstrap = sim.bootstrap_required === true;
  const running = sim.status === 'running';
  const waiting = running || sim.error ? String(sim.waiting_reason || sim.error || '').replaceAll('_',' ') : '';
  const sourceReady = data.connection?.ready === true;
  const legacy = sim.bootstrap_status === 'not_required';
  const primaryAction = running ? 'stop' : bootstrap ? 'bootstrap' : legacy ? 'start' : 'continuous';
  const primaryLabel = running ? 'Stop' : 'Run';
  const mock = data.mode === 'FULL_MOCK';
  const delivering = mock ? count(data.telemetry?.queued) : 0;
  const inFlight = delivering > 0 || incidents.some(item => ['detecting','repairing'].includes(item.status));
  const simulationControls = active && mock ? `<button class="button primary" data-action="once" ${pending || inFlight ? 'disabled' : ''}>Run</button>` : active ? `<button class="button primary" data-action="${primaryAction}" ${pending || (!running && !sourceReady) ? 'disabled' : ''}>${primaryLabel}</button>` : '';
  return `<div class="monitor-shell"><header class="monitor-header"><a class="brand" href="/recovery.html"><span class="brand-mark">R</span>Reconcile</a><div class="identity"><span class="app-icon">L</span><span><b>${esc(data.app?.title || 'Lumen')}</b><small>${esc(data.app?.environment || 'Environment unavailable')}</small></span></div></header>
    <main><section class="intro"><div><p class="eyebrow">${active ? 'Automatic monitoring' : 'Manual mode'}</p><h1>Access recovery</h1><p>We detect access problems, restore verified access, and check the result.</p></div><div class="controls">${simulationControls}</div></section>
    ${pollError ? `<p class="notice" role="alert">${esc(pollError)} <button data-action="refresh">Retry</button></p>` : ''}${actionError ? `<p class="notice" role="alert">${esc(actionError)} <button data-action="dismiss-error">Dismiss</button></p>` : ''}${delivering ? `<p class="progress" role="status" aria-live="polite">Delivering ${delivering} SDK ${delivering === 1 ? 'event' : 'events'} to the collector…</p>` : ''}${sim.status === 'failed' ? `<p class="notice" role="alert">Simulation failed: ${esc(sim.error || 'No details provided.')}</p>` : ''}${requestMessage ? `<p class="progress" role="status" aria-live="polite">${esc(requestMessage)}</p>` : running ? `<p class="progress" role="status" aria-live="polite">${esc(waiting || (sim.continuous ? `Continuous run · ${count(sim.completed)} scenarios completed` : `Simulation running · ${count(sim.completed)} of ${count(sim.total)} scenarios completed`))}</p>` : waiting ? `<p class="progress" role="status" aria-live="polite">${esc(waiting)}</p>` : ''}
    <section class="summaries" aria-label="Incident summary"><article><span>Incidents</span><b>${count(data.summary?.incidents)}</b></article><article><span>Fixed</span><b>${count(data.summary?.fixed)}</b></article><article><span>Needs attention</span><b>${count(data.summary?.needs_attention)}</b></article></section>
    ${attention.length ? `<section class="feed attention" aria-label="Needs attention"><div class="feed-heading"><h2><span class="attention-mark" aria-hidden="true">!</span>Needs attention</h2><span>${count(data.summary?.needs_attention ?? attention.length)} total · automatic repair could not be verified</span></div><div class="column-head" aria-hidden="true"><span>What happened</span><span>Accounts</span><span>Result</span><span>Detected</span><span>Recovery time</span></div>${attention.map(row).join('')}</section>` : ''}
    <section class="feed live-feed" aria-label="Live feed"><div class="feed-heading"><h2>Live feed</h2><span>${mock ? '' : `${data.coverage?.waiting_reason ? esc(data.coverage.waiting_reason) : data.proactive?.waiting_reason ? esc(data.proactive.waiting_reason) : `Coverage ${data.coverage?.complete === true ? 'complete' : data.coverage?.complete === false ? 'incomplete' : 'unknown'} · Source ${data.coverage?.source_fresh === true ? 'fresh' : data.coverage?.source_fresh === false ? 'stale' : 'freshness unknown'}`} · `}refreshes automatically</span></div><div class="column-head" aria-hidden="true"><span>What happened</span><span>Accounts</span><span>Result</span><span>Detected</span><span>Recovery time</span></div>${rows}</section>
    <section class="feed activity-feed"><div class="feed-heading"><h2>Activity</h2><span>Adapty recorded → Application applied → Access verified</span></div><details class="integration"><summary>Observed access updates · latest ${count(fulfillments.length)}</summary>${(fulfillments || []).map(f=>`<article class="fulfillment"><strong>${keyLabel(f.key)}</strong><span>${f.source_period && typeof f.source_period === 'object' ? `${when(f.source_period.starts_at)} → ${when(f.source_period.expires_at)}` : esc(f.source_period || 'Period unavailable')}</span><ol class="stages">${[['source_recorded','Adapty recorded','recorded'],['application_applied','Application applied','applied'],['access_verified','Access verified','verified']].map(([k,label,expected])=>{const stage=stageStatus(f.stages?.[k],expected);return `<li class="${stage.complete?'complete':'unknown'}">${label}: ${esc(stage.label)}</li>`}).join('')}</ol><p>${f.telemetry_gap ? 'Processing telemetry is incomplete.' : esc(f.reason || 'Status unavailable')}</p><p>Next action: ${esc(f.next_step || 'No next action recorded.')}</p></article>`).join('') || '<p class="empty">No recent activity recorded.</p>'}</details></section>
    <form class="export-range" data-form="export"><h2>Download activity</h2><label>From (UTC) <input name="from" type="datetime-local" step="1" value="${esc(range.from || '')}" required></label><label>To (UTC) <input name="to" type="datetime-local" step="1" value="${esc(range.to || '')}" required></label><button class="button" data-action="csv">Download CSV</button><button class="button" data-action="json">Download JSON</button></form>
    <details class="integration"><summary>Integration details</summary><dl><dt>CLI version</dt><dd>${esc(data.connection?.cli_version || 'Unavailable')}</dd><dt>Products</dt><dd>${count(data.connection?.catalog_product_count)}</dd><dt>Monitored registry</dt><dd>${count(data.connection?.active_accounts)} active · ${count(data.connection?.total_accounts)} total accounts</dd><dt>Source readiness (last check)</dt><dd>${sourceReady ? 'Ready' : 'Unavailable'} · ${when(data.connection?.source_observed_at)}</dd><dt>SDK telemetry</dt><dd>${count(data.telemetry?.queued)} queued · ${count(data.telemetry?.dropped)} dropped · ${count(data.telemetry?.failed)} errors</dd></dl><p class="scope-note">${data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Counts reflect the selected seeded registry, not the full provider account population.' : 'Counts reflect the current demo scope.'}</p>${data.telemetry?.last_error ? `<p>${esc(data.telemetry.last_error)}</p>` : ''}</details>
    </main></div>`;
}
