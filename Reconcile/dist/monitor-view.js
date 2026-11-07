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

export function renderMonitor(data, {pollError = '', actionError = '', pending = false, requestMessage = ''} = {}) {
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
    return `<details class="incident" data-incident="${esc(item.id)}"><summary><span><b>${esc(item.title || 'Access incident')}</b><small>${statusName(item.status)}</small></span><span>${esc(item.affected_accounts ?? '—')}</span><span>${statusName(item.status)}${item.repaired_accounts != null ? ` · ${esc(item.repaired_accounts)} repaired` : ''}</span><span>${when(item.detected_at)}</span><span>${duration(item.duration_ms)}</span></summary><div class="incident-body"><p>${esc(item.description || 'No description provided.')}</p><dl><dt>Recovery</dt><dd>${esc(item.repair_summary || 'No recovery summary provided.')}</dd><dt>Detected</dt><dd>${when(item.detected_at)}</dd><dt>Recovery started</dt><dd>${when(item.repair_started_at)}</dd><dt>Repaired</dt><dd>${when(item.repaired_at)}</dd><dt>Source</dt><dd>${esc(item.source_provenance || 'Unavailable')}</dd><dt>Payment verification</dt><dd>${esc(item.payment_verification || 'Unavailable')}</dd>${item.status === 'unresolved' ? `<dt>Next step</dt><dd>${esc(item.next_step || 'Review the advanced tools.')}</dd>` : ''}</dl>${actions ? `<p class="action-status">${esc(actions)}</p>` : ''}</div></details>`;
  }).join('') : `<p class="empty">No incidents yet<span>${active ? 'Run a demo to watch automatic detection and recovery.' : '<a href="/recovery-console.html">Open advanced tools</a> to investigate manually.'}</span></p>`;
  const sim = data.simulation || {};
  const running = sim.status === 'running';
  const sourceReady = data.connection?.ready === true;
  const simulationControls = active ? `<button class="button primary" data-action="${running ? 'stop' : 'start'}" ${pending || (!running && !sourceReady) ? 'disabled' : ''}>${running ? 'Stop simulation' : 'Run demo'}</button><button class="button" data-action="once" ${pending || running || !sourceReady ? 'disabled' : ''}>Simulate once</button>` : '<a class="button" href="/recovery-console.html">Open advanced tools</a>';
  return `<div class="monitor-shell"><header class="monitor-header"><a class="brand" href="/recovery.html"><span class="brand-mark">R</span>Reconcile</a><div class="identity"><span class="app-icon">L</span><span><b>${esc(data.app?.title || 'Lumen')}</b><small>${esc(data.app?.environment || 'Environment unavailable')}</small></span></div><span class="live-badge">${data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Live Adapty · Seeded data' : 'Local demo'}</span><span class="connection ${sourceReady ? 'ready' : ''}">Source ${sourceReady ? 'ready' : 'unavailable'} · last check</span></header>
    <main><section class="intro"><div><p class="eyebrow">${active ? 'Automatic monitoring' : 'Manual mode'}</p><h1>Access recovery</h1><p>We detect access problems, restore verified access, and check the result.</p></div><div class="controls">${simulationControls}<button class="button" data-action="csv" ${incidents.length && !pending ? '' : 'disabled'}>Export CSV</button></div></section>
    ${pollError ? `<p class="notice" role="alert">${esc(pollError)} <button data-action="refresh">Retry</button></p>` : ''}${actionError ? `<p class="notice" role="alert">${esc(actionError)} <button data-action="dismiss-error">Dismiss</button></p>` : ''}${sim.status === 'failed' ? `<p class="notice" role="alert">Simulation failed: ${esc(sim.error || 'No details provided.')}</p>` : ''}${requestMessage ? `<p class="progress" role="status" aria-live="polite">${esc(requestMessage)}</p>` : running ? `<p class="progress" role="status" aria-live="polite">Simulation running · ${count(sim.completed)} of ${count(sim.total)} incidents completed</p>` : ''}
    <section class="summaries" aria-label="Incident summary"><article><span>Incidents</span><b>${count(data.summary?.incidents)}</b></article><article><span>Fixed</span><b>${count(data.summary?.fixed)}</b></article><article><span>Needs attention</span><b>${count(data.summary?.needs_attention)}</b></article></section>
    <section class="feed"><div class="feed-heading"><h2>Incident feed</h2><span>Newest first · refreshes automatically</span></div><div class="column-head" aria-hidden="true"><span>What happened</span><span>Accounts</span><span>Result</span><span>Detected</span><span>Recovery time</span></div>${rows}</section>
    <details class="integration"><summary>Integration details</summary><dl><dt>CLI version</dt><dd>${esc(data.connection?.cli_version || 'Unavailable')}</dd><dt>Products</dt><dd>${count(data.connection?.catalog_product_count)}</dd><dt>Monitored registry</dt><dd>${count(data.connection?.active_accounts)} active · ${count(data.connection?.total_accounts)} total accounts</dd><dt>Source readiness (last check)</dt><dd>${sourceReady ? 'Ready' : 'Unavailable'} · ${when(data.connection?.source_observed_at)}</dd><dt>SDK telemetry</dt><dd>${count(data.telemetry?.queued)} queued · ${count(data.telemetry?.dropped)} dropped · ${count(data.telemetry?.failed)} errors</dd></dl><p class="scope-note">${data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Counts reflect the selected seeded registry, not the full provider account population.' : 'Counts reflect the current demo scope.'}</p>${data.telemetry?.last_error ? `<p>${esc(data.telemetry.last_error)}</p>` : ''}<button class="button" data-action="json" ${incidents.length && !pending ? '' : 'disabled'}>Download JSON</button> <a href="/recovery-console.html">Advanced tools</a></details>
    </main></div>`;
}
