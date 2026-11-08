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

export function renderMonitor(data, {pollError = '', actionError = '', pending = false, requestMessage = '', status = 'unresolved', fulfillments = [], traces = {}, range = {from:new Date(Date.now()-86400000).toISOString().slice(0,19),to:new Date(Date.now()+1000).toISOString().slice(0,19)}, page = 0} = {}) {
  if (!data) return `<main class="monitor-shell"><p class="notice" role="alert">${esc(pollError || 'Loading incident feed…')}</p><button data-action="refresh">Try again</button></main>`;
  const incidents = Array.isArray(data.incidents) ? [...data.incidents].sort((a,b) => String(b.detected_at||'').localeCompare(String(a.detected_at||''))) : [];
  const active = data.automation?.enabled === true;
  const rows = incidents.length ? incidents.map(item => {
    const actionSummary = new Map();
    for (const action of item.actions || []) {
      const label = `${action.owner || 'Owner unavailable'} · ${action.status || 'status unavailable'}`;
      actionSummary.set(label, (actionSummary.get(label) || 0) + 1);
    }
    const actions = [...actionSummary].map(([label, total]) => `${label} · ${total} ${total === 1 ? 'step' : 'steps'}`).join(' · ');
    const trace = traces[item.id];
    const traceNext = trace?.next_step || [...new Set(trace?.traces?.map(x => x.next_step).filter(Boolean) || [])].join(' · ');
    const traceHtml = trace ? `<h3>Activity</h3><p>Snapshot ${when(trace.snapshot_at || trace._loaded_at)} <button class="button" data-action="trace" data-id="${esc(item.id)}">Refresh activity</button></p>${trace.reason ? `<p>${esc(trace.reason)}</p>` : ''}${renderTrace(trace)}<p>Next action: ${esc(traceNext || 'No next action recorded.')}</p>` : `<button class="button" data-action="trace" data-id="${esc(item.id)}">View activity</button>`;
    return `<details class="incident" data-incident="${esc(item.id)}"><summary><span><b>${esc(item.title || 'Access incident')}</b><small>${statusName(item.status)}</small></span><span>${esc(item.affected_accounts ?? '—')}</span><span>${statusName(item.status)}${item.repaired_accounts != null ? ` · ${esc(item.repaired_accounts)} repaired` : ''}</span><span>${when(item.detected_at)}</span><span>${duration(item.duration_ms)}</span></summary><div class="incident-body"><p>${esc(item.description || 'No description provided.')}</p><dl><dt>Recovery</dt><dd>${esc(item.repair_summary || 'No recovery summary provided.')}</dd><dt>Detected</dt><dd>${when(item.detected_at)}</dd><dt>Recovery started</dt><dd>${when(item.repair_started_at)}</dd><dt>Repaired</dt><dd>${when(item.repaired_at)}</dd><dt>Source</dt><dd>${esc(item.source_provenance || 'Unavailable')}</dd><dt>Payment verification</dt><dd>${esc(item.payment_verification || 'Unavailable')}</dd>${item.status === 'unresolved' ? `<dt>Next step</dt><dd>${esc(item.next_step || 'Review the advanced tools.')}</dd>` : ''}</dl>${actions ? `<p class="action-status">${esc(actions)}</p>` : ''}${traceHtml}</div></details>`;
  }).join('') : `<p class="empty">${data.summary?.incidents ? status === 'unresolved' ? 'No incidents need attention' : 'No incidents in this view' : 'No incidents yet'}<span>${active ? 'Monitoring continues automatically.' : '<a href="/recovery-console.html">Open advanced tools</a> to investigate manually.'}</span></p>`;
  const sim = data.simulation || {};
  const bootstrap = sim.bootstrap_required === true;
  const running = sim.status === 'running';
  const waiting = running || sim.error ? String(sim.waiting_reason || sim.error || '').replaceAll('_',' ') : '';
  const sourceReady = data.connection?.ready === true;
  const legacy = sim.bootstrap_status === 'not_required';
  const primaryAction = running ? 'stop' : bootstrap ? 'bootstrap' : legacy ? 'start' : 'continuous';
  const primaryLabel = running ? 'Stop simulation' : bootstrap ? 'Start demo' : legacy ? 'Run demo' : 'Run continuously';
  const simulationControls = active ? `<button class="button primary" data-action="${primaryAction}" ${pending || (!running && !sourceReady) ? 'disabled' : ''}>${primaryLabel}</button>${bootstrap ? '' : `<button class="button" data-action="once" ${pending || running || !sourceReady ? 'disabled' : ''}>Run once</button>`}` : '<a class="button" href="/recovery-console.html">Open advanced tools</a>';
  return `<div class="monitor-shell"><header class="monitor-header"><a class="brand" href="/recovery.html"><span class="brand-mark">R</span>Reconcile</a><div class="identity"><span class="app-icon">L</span><span><b>${esc(data.app?.title || 'Lumen')}</b><small>${esc(data.app?.environment || 'Environment unavailable')}</small></span></div><span class="live-badge">${data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Live Adapty · Seeded data' : 'Local demo'}</span><span class="connection ${sourceReady ? 'ready' : ''}">Source ${sourceReady ? 'ready' : 'unavailable'} · last check</span></header>
    <main><section class="intro"><div><p class="eyebrow">${active ? 'Automatic monitoring' : 'Manual mode'}</p><h1>Access recovery</h1><p>We detect access problems, restore verified access, and check the result.</p></div><div class="controls">${simulationControls}</div></section>
    ${pollError ? `<p class="notice" role="alert">${esc(pollError)} <button data-action="refresh">Retry</button></p>` : ''}${actionError ? `<p class="notice" role="alert">${esc(actionError)} <button data-action="dismiss-error">Dismiss</button></p>` : ''}${sim.status === 'failed' ? `<p class="notice" role="alert">Simulation failed: ${esc(sim.error || 'No details provided.')}</p>` : ''}${requestMessage ? `<p class="progress" role="status" aria-live="polite">${esc(requestMessage)}</p>` : running ? `<p class="progress" role="status" aria-live="polite">${esc(waiting || (sim.continuous ? `Continuous run · ${count(sim.completed)} scenarios completed` : `Simulation running · ${count(sim.completed)} of ${count(sim.total)} scenarios completed`))}</p>` : waiting ? `<p class="progress" role="status" aria-live="polite">${esc(waiting)}</p>` : ''}
    <section class="summaries" aria-label="Incident summary"><article><span>Incidents</span><b>${count(data.summary?.incidents)}</b></article><article><span>Fixed</span><b>${count(data.summary?.fixed)}</b></article><article><span>Needs attention</span><b>${count(data.summary?.needs_attention)}</b></article></section>
    <section class="feed"><div class="feed-heading"><h2>${statusName(status)}</h2><span>${count(data.pagination?.total ?? data.summary?.needs_attention)} total · refreshes automatically</span></div><form class="filters" data-form="filters"><label>Status <select name="status"><option value="unresolved" ${status==='unresolved'?'selected':''}>Needs attention</option>${['detecting','repairing','repaired'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${statusName(s)}</option>`).join('')}</select></label><button class="button">Apply filter</button><span>${data.coverage?.waiting_reason ? esc(data.coverage.waiting_reason) : data.proactive?.waiting_reason ? esc(data.proactive.waiting_reason) : `Coverage ${data.coverage?.complete === true ? 'complete' : data.coverage?.complete === false ? 'incomplete' : 'unknown'} · Source ${data.coverage?.source_fresh === true ? 'fresh' : data.coverage?.source_fresh === false ? 'stale' : 'freshness unknown'}`}</span></form><div class="column-head" aria-hidden="true"><span>What happened</span><span>Accounts</span><span>Result</span><span>Detected</span><span>Recovery time</span></div>${rows}<div class="pager"><button data-action="page" data-page="${Math.max(0,page-1)}" ${page===0?'disabled':''}>Previous</button><span>Page ${page+1}${data.pagination?.total != null ? ` · ${count(data.pagination.total)} incidents` : ''}</span><button data-action="page" data-page="${page+1}" ${data.pagination?.next_cursor == null?'disabled':''}>Next</button></div></section>
    <section class="feed activity-feed"><div class="feed-heading"><h2>Activity</h2><span>Adapty recorded → Application applied → Access verified</span></div><details class="integration"><summary>Observed access updates · latest ${count(fulfillments.length)}</summary>${(fulfillments || []).map(f=>`<article class="fulfillment"><strong>${keyLabel(f.key)}</strong><span>${f.source_period && typeof f.source_period === 'object' ? `${when(f.source_period.starts_at)} → ${when(f.source_period.expires_at)}` : esc(f.source_period || 'Period unavailable')}</span><ol class="stages">${[['source_recorded','Adapty recorded','recorded'],['application_applied','Application applied','applied'],['access_verified','Access verified','verified']].map(([k,label,expected])=>{const stage=stageStatus(f.stages?.[k],expected);return `<li class="${stage.complete?'complete':'unknown'}">${label}: ${esc(stage.label)}</li>`}).join('')}</ol><p>${f.telemetry_gap ? 'Processing telemetry is incomplete.' : esc(f.reason || 'Status unavailable')}</p><p>Next action: ${esc(f.next_step || 'No next action recorded.')}</p></article>`).join('') || '<p class="empty">No recent activity recorded.</p>'}</details></section>
    <form class="export-range" data-form="export"><h2>Download activity</h2><label>From (UTC) <input name="from" type="datetime-local" step="1" value="${esc(range.from || '')}" required></label><label>To (UTC) <input name="to" type="datetime-local" step="1" value="${esc(range.to || '')}" required></label><button class="button" data-action="csv">Download CSV</button><button class="button" data-action="json">Download JSON</button></form>
    <details class="integration"><summary>Integration details</summary><dl><dt>CLI version</dt><dd>${esc(data.connection?.cli_version || 'Unavailable')}</dd><dt>Products</dt><dd>${count(data.connection?.catalog_product_count)}</dd><dt>Monitored registry</dt><dd>${count(data.connection?.active_accounts)} active · ${count(data.connection?.total_accounts)} total accounts</dd><dt>Source readiness (last check)</dt><dd>${sourceReady ? 'Ready' : 'Unavailable'} · ${when(data.connection?.source_observed_at)}</dd><dt>SDK telemetry</dt><dd>${count(data.telemetry?.queued)} queued · ${count(data.telemetry?.dropped)} dropped · ${count(data.telemetry?.failed)} errors</dd></dl><p class="scope-note">${data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Counts reflect the selected seeded registry, not the full provider account population.' : 'Counts reflect the current demo scope.'}</p>${data.telemetry?.last_error ? `<p>${esc(data.telemetry.last_error)}</p>` : ''}<a href="/recovery-console.html">Advanced tools</a></details>
    </main></div>`;
}
