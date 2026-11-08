import { gateReasonLabel } from './access-view.js';

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
const stepName = value => ({'Verify the premium gate':'Test Premium access',
  'Resync Lumen access from Adapty':'Update app access from Adapty',
  'Repair the Adapty catalog mapping':'Fix the product mapping',
  'Validate the paid purchase':'Validate the purchase with Adapty'}[value] || value);
const sourceNames = {synthetic_extension:'Simulated provider data',synthetic_test_fixture:'Local test data',
  official_hackathon_synthetic:'Hackathon test data',live_adapty_seeded:'Adapty test profiles'};
const paymentNames = {not_independently_verified:'No real charge verified',
  unverified_synthetic_history:'Synthetic purchase history',not_observed:'Payment not checked'};
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
  return `<ol class="timeline">${steps.map((step, index) => {
    const recovered = step.status === 'failed' && steps.slice(index + 1).some(next => next.step === step.step && next.status === 'ok');
    const status = recovered ? 'ok' : step.status;
    return `<li class="step-${esc(status)}"><span class="step-mark" aria-hidden="true">${stepMark[status] || '•'}</span><div><b>${esc(stepName(step.step))}</b> <small>${esc(step.owner)}${step.at ? ` · ${when(step.at)}` : ''}</small>${recovered ? '<p><b>Passed on a later attempt.</b> Earlier result:</p>' : ''}<p>${esc(step.detail)}</p></div></li>`;
  }).join('')}</ol>`;
}
function renderFailure(failure) {
  if (!failure) return '';
  const accounts = (failure.accounts || []).slice(0, 6).map(item => esc(item.account)).join(', ');
  const reasons = [...new Set((failure.accounts || []).map(item => item.reason).filter(Boolean))].map(esc).join(' · ');
  const more = (failure.accounts || []).length > 6 ? ` and ${failure.accounts.length - 6} more` : '';
  const trace = failure.trace;
  const attempts = (trace?.attempts || []).map((attempt, index) => {
    const request = attempt.request;
    const response = request?.http_status ? `HTTP ${request.http_status}` : request?.error_kind || 'Response not recorded';
    const readback = attempt.readback;
    return `<li><b>${index ? 'Retry' : 'Initial check'}</b> · ${esc(request?.observed_at || attempt.at || 'Time not recorded')}<p>${request ? `<code>${esc(request.method)} ${esc(request.path)}</code> → ${esc(response)} · ${esc(request.duration_ms ?? '—')} ms` : 'Request details were not recorded for this older incident.'}</p>${readback ? `<p>Separate access readback: <b>${readback.allowed === true ? 'allow' : readback.allowed === false ? 'deny' : 'not recorded'}</b> · ${esc(gateReasonLabel(readback.reason))}. The final Premium request must still pass.</p>` : ''}<details data-evidence="${esc(attempt.action_id)}"><summary>Evidence reference</summary><code>${esc(attempt.action_id)}</code>${request?.error_kind ? `<p>${esc(request.error_kind)}</p>` : ''}</details></li>`;
  }).join('');
  return `<div class="stopped-at" role="note"><b>Needs action: ${esc(stepName(failure.step))}</b> <small>${esc(failure.owner)}</small>${failure.reason ? `<p>${esc(failure.reason)}</p>` : ''}${accounts ? `<p>Affected accounts: ${accounts}${more}</p>` : ''}${reasons ? `<p>Recorded result: ${reasons}</p>` : ''}${attempts ? `<p><b>Request history · ${esc(trace.account)}</b> · one account shown from ${count(trace.affected_count)} affected</p><ol class="trace-list">${attempts}</ol>` : ''}</div>`;
}

function renderAccessUpdates(fulfillments, synthetic) {
  const stages = [['source_recorded','Adapty recorded','recorded'],['application_applied','Application applied','applied'],['access_verified','Access verified','verified']];
  const state = f => f.access_state || (stages.every(([key,,expected]) => stageStatus(f.stages?.[key], expected).complete)
    ? 'verified' : f.status === 'discrepancy' ? 'discrepancy' : 'inconclusive');
  const healthy = fulfillments.filter(f => state(f) === 'verified');
  const expected = fulfillments.filter(f => ['expired','policy_restricted'].includes(state(f)));
  const review = fulfillments.filter(f => !['verified','expired','policy_restricted'].includes(state(f)));
  const gaps = healthy.filter(f => f.telemetry_gap).length;
  const row = f => {
    const key = f.key;
    const account = f.user_id || (key && typeof key === 'object' ? key.customer_id || 'Account unavailable' : key || 'Account unavailable');
    const accessState = state(f), good = accessState === 'verified';
    const normal = ['expired','policy_restricted'].includes(accessState);
    const label = ({'Source unavailable':'Check subscription data','Source stale':'Refresh subscription data'}[f.display_label])
      || f.display_label || ({verified:'Access verified',expired:'Subscription expired',policy_restricted:'Blocked by app rule',discrepancy:'Access mismatch',inconclusive:'Check source or identity'}[accessState]);
    const explanation = good ? 'Active entitlement matches the application; Premium access is allowed.'
      : normal ? f.reason || 'Access is denied as expected.' : f.reason || 'The source or customer identity could not be confirmed.';
    const period = f.source_period && typeof f.source_period === 'object' && f.source_period.expires_at
      ? `<p>Subscription period: ${when(f.source_period.starts_at)} → ${when(f.source_period.expires_at)}</p>` : '';
    return `<details class="fulfillment access-row" data-evidence="access:${esc(JSON.stringify(key))}"><summary><span>${esc(account)}</span><span class="${good || normal ? 'access-ok' : ''}">${esc(label)}</span></summary><p>${esc(explanation)}</p>${!good && (!normal || accessState === 'policy_restricted') ? `<p>What to do: ${esc(f.next_step || 'Check the subscription source and the app access decision again.')}</p>` : ''}${period}<p>${keyLabel(key)}</p></details>`;
  };
  return `<section class="feed activity-feed"><div class="feed-heading"><h2>Current access</h2><span>${synthetic ? 'Synthetic source · ' : ''}Current observations</span></div><details class="integration"><summary>Observed access updates · ${fulfillments.length} accounts</summary>${fulfillments.length ? `<p class="access-overview"><strong>${healthy.length} access verified</strong><strong>${expected.length} expected denials</strong><strong>${review.length} need investigation</strong></p>${review.length ? `<h3>Investigate these accounts</h3>${review.map(row).join('')}` : '<p>No access issues found.</p>'}${expected.length ? `<details data-evidence="expected-access"><summary>Expected denials (${expected.length}) · expired subscriptions or policy restrictions</summary>${expected.map(row).join('')}</details>` : ''}${healthy.length ? `<details data-evidence="verified-access"><summary>Verified accounts (${healthy.length}) · view details</summary>${healthy.map(row).join('')}</details>` : ''}${gaps ? `<details data-evidence="processing-coverage"><summary>Access confirmed by direct checks (${gaps})</summary><p>Premium access works for these accounts. ${synthetic ? 'They started this demo with access already active, so no initial processing event was generated in this run.' : 'Their earlier processing was not observed by Reconcile.'} No repair is needed.</p></details>` : ''}` : '<p class="empty">No access observations loaded.</p>'}</details></section>`;
}

export function renderMonitor(data, {pollError = '', actionError = '', pending = false, requestMessage = '', status = 'all', fulfillments = [], traces = {}, range = {from:new Date(Date.now()-86400000).toISOString().slice(0,19),to:new Date(Date.now()+1000).toISOString().slice(0,19)}, page = 0, demoTraffic = false, controllerBusy = false} = {}) {
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
    const outcome = item.repaired_accounts == null ? '' : item.status === 'unresolved'
      ? ` · ${esc(item.repaired_accounts)} access checks passed` : ` · ${esc(item.repaired_accounts)} repaired`;
    return `<details class="incident" data-incident="${esc(item.id)}"${watching ? ' open' : ''}><summary><span><b>${esc(item.title || 'Access incident')}</b><small>${item.failure ? `Needs action: ${esc(stepName(item.failure.step))}` : statusName(item.status)}</small></span><span>${esc(item.affected_accounts ?? '—')}</span><span>${statusName(item.status)}${outcome}</span><span>${when(item.detected_at)}</span><span>${duration(item.duration_ms)}</span></summary><div class="incident-body">${renderFailure(item.failure)}<p>${esc(item.description || 'The incident checks have not recorded a description yet.')}</p><dl><dt>Recovery result</dt><dd>${esc(item.repair_summary || 'Waiting for the recovery checks to finish.')}</dd><dt>Detected</dt><dd>${when(item.detected_at)}</dd><dt>Recovery started</dt><dd>${item.repair_started_at ? when(item.repair_started_at) : 'Not started'}</dd><dt>Access confirmed</dt><dd>${item.repaired_at ? when(item.repaired_at) : 'Not yet confirmed'}</dd><dt>Evidence source</dt><dd>${esc(sourceNames[item.source_provenance] || item.source_provenance || 'Not recorded')}</dd><dt>Payment evidence</dt><dd>${esc(paymentNames[item.payment_verification] || item.payment_verification || 'Not checked')}</dd><dt>What to do</dt><dd>${item.status === 'repaired' ? 'No action needed for this recorded recovery.' : esc(item.next_step || 'Inspect the recorded checks below before retrying.')}</dd></dl><p class="scope-note">This is a saved incident result. Current account checks below may be newer.</p>${Array.isArray(item.timeline) ? `<h3>Recorded recovery checks</h3>${renderTimeline(item.timeline)}` : `${actions ? `<p class="action-status">${esc(actions)}</p>` : ''}${traceHtml}`}</div></details>`;
  };
  const attention = incidents.filter(item => item.status === 'unresolved');
  const flowing = incidents.filter(item => item.status !== 'unresolved');
  const emptyMessage = incidents.length ? 'No other incidents' : data.pagination?.total ? 'No incidents on this page' : status === 'all' && !data.summary?.incidents ? 'No incidents yet' : 'No incidents match this filter';
  const rows = flowing.length ? flowing.map(row).join('') : `<p class="empty">${emptyMessage}<span>${active ? 'Run a demo scenario to see detection, repair and access verification.' : 'Automatic recovery is off. Review and approve a repair in the manual console.'}</span></p>`;
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
  const simulationControls = active && mock ? `<span class="scope-note">Synthetic demo traffic · ${demoTraffic ? 'On' : 'Off'}</span><button class="button" data-action="demo-traffic" aria-pressed="${demoTraffic}">${demoTraffic ? 'Stop demo traffic' : 'Start demo traffic'}</button><button class="button primary" data-action="once" ${pending || controllerBusy || inFlight ? 'disabled' : ''}>Run once</button>` : active ? `<button class="button primary" data-action="${primaryAction}" ${pending || (!running && !sourceReady) ? 'disabled' : ''}>${primaryLabel}</button>` : '';
  const connectionDetails = mock
    ? `<dt>Subscription source</dt><dd>Local simulated provider; Adapty CLI is not used in this mode.</dd><dt>Account checks</dt><dd>${fulfillments.length} loaded in Current access</dd>`
    : `<dt>CLI version</dt><dd>${esc(data.connection?.cli_version || 'Not recorded for this connection')}</dd><dt>Products</dt><dd>${count(data.connection?.catalog_product_count)}</dd><dt>Monitored registry</dt><dd>${count(data.connection?.active_accounts)} active · ${count(data.connection?.total_accounts)} total accounts</dd><dt>Source readiness (last check)</dt><dd>${sourceReady ? 'Ready' : 'Waiting for source data'} · ${when(data.connection?.source_observed_at)}</dd>`;
  const coverageNote = mock ? '' : `${esc(data.coverage?.waiting_reason || data.proactive?.waiting_reason ||
    `Account checks ${data.coverage?.complete === true ? 'complete' : data.coverage?.complete === false ? 'incomplete' : 'not yet complete'} · subscription data ${data.coverage?.source_fresh === true ? 'fresh' : data.coverage?.source_fresh === false ? 'stale' : 'not yet checked'}`)} · `;
  return `<div class="monitor-shell"><header class="monitor-header"><a class="brand" href="/recovery.html"><span class="brand-mark">R</span>Reconcile</a><div class="identity"><span class="app-icon">L</span><span><b>${esc(data.app?.title || 'Lumen')}</b><small>${mock ? 'Demo' : esc(data.app?.environment || 'Environment not recorded')}</small></span></div></header>
    <main><section class="intro"><div><p class="eyebrow">${active ? 'Automatic recovery enabled' : 'Manual mode'}</p><h1>Access recovery</h1><p>Find active subscribers who cannot use Premium. Reconcile updates app access and checks that the Premium request succeeds.</p><p class="scope-note">${data.mode === 'FULL_MOCK' ? 'Synthetic demo · no real charges' : data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Adapty seeded data · no real charges verified' : data.mode === 'LOCAL_ADAPTY_FIXTURE' ? 'Synthetic local fixture data · no real charges' : 'Connect a subscription source before investigating access.'}</p>${mock && active ? `<p class="scope-note">${demoTraffic ? 'A new access-failure scenario starts about every six seconds after the previous recovery finishes.' : 'Demo traffic is paused. Run once creates one simulated access failure and starts automatic recovery.'}</p>` : ''}</div><div class="controls">${simulationControls}</div></section>
    ${pollError ? `<p class="notice" role="alert">${esc(pollError)} <button data-action="refresh">Retry</button></p>` : ''}${actionError ? `<p class="notice" role="alert">${esc(actionError)} <button data-action="dismiss-error">Dismiss</button></p>` : ''}${delivering ? `<p class="progress" role="status" aria-live="polite">Delivering ${delivering} SDK ${delivering === 1 ? 'event' : 'events'} to the collector…</p>` : ''}${sim.status === 'failed' ? `<p class="notice" role="alert">Simulation failed: ${esc(sim.error || 'No details provided.')}</p>` : ''}${requestMessage ? `<p class="progress" role="status" aria-live="polite">${esc(requestMessage)}</p>` : running ? `<p class="progress" role="status" aria-live="polite">${esc(waiting || (sim.continuous ? `Continuous run · ${count(sim.completed)} scenarios completed` : `Simulation running · ${count(sim.completed)} of ${count(sim.total)} scenarios completed`))}</p>` : waiting ? `<p class="progress" role="status" aria-live="polite">${esc(waiting)}</p>` : ''}
    <section class="summaries" aria-label="Incident summary"><article><span>Incidents</span><b>${count(data.summary?.incidents)}</b></article><article><span>Fixed</span><b>${count(data.summary?.fixed)}</b></article><article><span>Needs attention</span><b>${count(data.summary?.needs_attention)}</b><button data-action="needs-attention">View needs attention</button></article></section>
    <form class="filters" data-form="filters"><label>Show <select name="status">${[['all','All activity'],['needs_attention','Needs attention'],['repaired','Fixed'],['detecting','Detecting'],['repairing','Repairing']].map(([value,label])=>`<option value="${value}"${status===value?' selected':''}>${label}</option>`).join('')}</select></label><button class="button">Apply filter</button></form>
    ${attention.length ? `<section class="feed attention" aria-label="Needs attention"><div class="feed-heading"><h2><span class="attention-mark" aria-hidden="true">!</span>Needs attention</h2><span>${count(data.summary?.needs_attention ?? attention.length)} total · automatic repair could not be verified</span></div><div class="column-head" aria-hidden="true"><span>What happened</span><span>Accounts</span><span>Result</span><span>Detected</span><span>Recovery time</span></div>${attention.map(row).join('')}</section>` : ''}
    <section class="feed live-feed" aria-label="Recovery history"><div class="feed-heading"><h2>Recovery history</h2><span>${coverageNote}Saved incident results · refreshes automatically</span></div><div class="column-head" aria-hidden="true"><span>What happened</span><span>Accounts</span><span>Result</span><span>Detected</span><span>Recovery time</span></div>${rows}</section>
    ${data.pagination ? `<nav class="pager" aria-label="Incident pages"><button class="button" data-action="page" data-page="${page-1}"${page===0?' disabled':''}>Previous</button><span>Page ${page+1} · ${count(data.pagination.total)} matching incidents</span><button class="button" data-action="page" data-page="${page+1}"${data.pagination.next_cursor==null?' disabled':''}>Next</button></nav>` : ''}
    ${renderAccessUpdates(fulfillments, mock && active)}
    <form class="export-range" data-form="export"><h2>Export incident history</h2><p class="scope-note">Choose a UTC period to download recorded incidents and recovery evidence.</p><label>From (UTC) <input name="from" type="datetime-local" step="1" value="${esc(range.from || '')}" required></label><label>To (UTC) <input name="to" type="datetime-local" step="1" value="${esc(range.to || '')}" required></label><button class="button" data-action="csv">Download CSV</button><button class="button" data-action="json">Download JSON</button></form>
    <details class="integration"><summary>Integration details</summary><dl>${connectionDetails}<dt>SDK event delivery</dt><dd>${count(data.telemetry?.queued)} waiting to send · ${count(data.telemetry?.dropped)} dropped · ${count(data.telemetry?.failed)} delivery errors</dd></dl><p class="scope-note">${data.mode === 'LIVE_ADAPTY_SEEDED' ? 'Only the configured test accounts are monitored.' : 'Counts apply to this demo run.'}</p>${data.telemetry?.last_error ? `<p>${esc(data.telemetry.last_error)}</p>` : ''}</details>
    </main></div>`;
}
