import { accountRow, escapeHtml as h, isLiveMode, statusLabel, statusTone, summaryView, safeReportHtml, targetLabel } from './recovery-view.js';

const root = document.querySelector('#app'), overlay = document.querySelector('#overlay-root');
const S = { report: null, liveStatus: null, error: '', busy: false, page: 'incident', tab: 'accounts', selected: new Set(), query: '', filter: 'all', offset: 0, modal: null, plan: null, approved: false, ack: false, actor: '', nav: false, job: null, detail: null, gate: null, detecting: false };
const statusOptions = ['confirmed','potential','activation_missing','access_not_delivered','healthy','inconclusive','policy_denial','legitimate_denial','outside_incident','restored','pending_verification','awaiting_client_action'];
const icon = '<path d="M5 4h9v4H5zM10 16h9v4h-9zM5 8v8h5M14 8h5v8"/>';
async function api(path, body, timeout = 12000, allowGateDenial = false) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(path, { cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    let data; try { data = await res.json(); } catch { data = {}; }
    if (!res.ok && !(allowGateDenial && res.status === 403)) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    if (allowGateDenial && !((res.status === 200 && data.allowed === true) || (res.status === 403 && data.allowed === false))) throw new Error('The app did not return a consistent gate decision. Access is unverified.');
    return allowGateDenial ? {...data, http_status: res.status} : data;
  } finally { clearTimeout(timer); }
}
let toastTimer;
const notice = (msg, error = false) => { const el = document.querySelector('#toast-root'); clearTimeout(toastTimer); el.innerHTML = `<div class="toast ${error ? 'error' : ''}" role="status">${h(msg)}</div>`; toastTimer = setTimeout(() => { el.innerHTML = ''; }, 6000); };
function reportPath(name) { return `/api/recovery/${name}${S.incidentId ? `?incident_id=${encodeURIComponent(S.incidentId)}` : ''}`; }
async function refresh() { S.report = await api(reportPath('report')); S.incidentId = S.report.incident?.id || null; S.error = ''; if (isLiveMode(S.report)) { S.liveStatus = null; try { S.liveStatus = await api('/api/recovery/live/status'); } catch { S.liveStatus = { ready: false }; throw new Error('Live source status is unavailable. Retry refresh before continuing.'); } } }
async function waitForLiveIncident(userId, previousIncidentId, previousJobIds) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const report = await api('/api/recovery/report', undefined, Math.min(10000, Math.max(1, deadline - Date.now())));
      const incident = [report.incident, ...(report.incidents || [])].find(item => item?.id && item.id !== previousIncidentId && item.trigger_user_id === userId);
      if (incident) {
        const jobs = report.jobs || [];
        const job = jobs.find(item => item.incident_id === incident.id || item.result?.incident_id === incident.id)
          || jobs.find(item => !previousJobIds.has(item.id) && ['incident', 'scan'].includes(item.kind));
        if (job) { S.report = report; S.incidentId = incident.id; return { incident, job }; }
      }
    } catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - Date.now()))));
  }
  throw new Error('The local gate denial was recorded, but no matching incident scan appeared within 30 seconds. Refresh to check the latest evidence.');
}
async function refreshAndResume() {
  await refresh();
  const running = (S.report.jobs || []).find(job => ['queued', 'running'].includes(job.status));
  if (running) await beginJob({job_id: running.id});
}
function focusSelector(element = document.activeElement) {
  if (!element || element === document.body) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  for (const name of ['account', 'user', 'action']) if (element.dataset?.[name]) return `[data-${name}="${CSS.escape(element.dataset[name])}"]`;
  return null;
}
function busy(task) {
  if (S.busy) return;
  const returnFocus = focusSelector();
  S.busy = true; render();
  Promise.resolve().then(task).catch(e => { S.error = e.message; notice(e.message, true); }).finally(() => {
    S.busy = false; S.detecting = false; render();
    if (!S.modal && returnFocus) (document.querySelector(returnFocus) || document.querySelector('#main-content'))?.focus({ preventScroll: true });
  });
}
function beginJob(response) { if(response?.incident_id) S.incidentId=response.incident_id; S.newIncident=false; S.job = response?.job_id || response?.id || null; if (!S.job) return refresh(); return poll(S.job); }
async function poll(id) {
  for (let i = 0; i < 90; i++) {
    const job = await api(`/api/recovery/jobs/${encodeURIComponent(id)}`, undefined, 10000); S.jobState = job; render();
    if (job.status === 'failed') throw new Error(job.error || 'The recovery job failed.');
    if (job.status === 'completed') { S.job = null; await refresh(); notice('Run complete. Current evidence has been refreshed.'); return; }
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw new Error('The job is still running. Refresh to check its latest status.');
}
function eligible() { return (S.report?.accounts || []).filter(a => a.eligible === true); }
function selectedIds() { return [...S.selected].filter(id => eligible().some(a => a.id === id)); }
function retryIds() {
  if (!(S.report?.actions || []).some(a => ['failed','blocked','unknown_outcome','pending_verification'].includes(a.status))) return [];
  const listed = S.report?.recovery?.unresolved_ids;
  const ids = Array.isArray(listed) ? listed : (S.report?.actions || []).filter(a => ['failed','unresolved','pending_verification','awaiting_client_action'].includes(a.status)).map(a => a.account_id);
  return [...new Set(ids)].filter(id => eligible().some(a => a.id === id));
}
function btn(label, action, primary = false, disabled = false) { return `<button class="btn ${primary ? 'btn-primary' : ''}" data-action="${action}" ${disabled || S.busy ? 'disabled' : ''}>${h(label)}</button>`; }
function badge(text, tone = 'blue') { return `<span class="badge badge-${tone}">${h(text)}</span>`; }
function sidebar() { return `<aside class="sidebar ${S.nav ? 'open' : ''}" id="primary-navigation" aria-label="Workspace navigation"><div class="sidebar-brand"><a class="brand" href="/recovery.html"><span class="brand-mark"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>Reconcile</a><button class="btn-icon sidebar-close" data-action="nav-close" aria-label="Close navigation">×</button></div><div class="workspace-identity"><span class="app-icon">L</span><div><strong>${h(S.report?.manifest?.app_title || S.liveStatus?.app_title || S.report?.manifest?.app || 'Lumen')}</strong><span>${h(S.report?.manifest?.environment || 'Environment unavailable')}</span></div></div><nav class="primary-nav" aria-label="Primary"><button class="nav-button ${S.page==='incident'?'active':''}" data-action="page" data-page="incident">Incidents</button><button class="nav-button ${S.page==='lumen'?'active':''}" data-action="page" data-page="lumen">Lumen Demo</button><button class="nav-button ${S.page==='lab'?'active':''}" data-action="page" data-page="lab">Demo Lab</button></nav><div class="sidebar-bottom"><a class="nav-button nav-secondary" href="/analytics.html">Analytics</a><a class="nav-button nav-secondary" href="/access.html">Cancellation recovery</a><a class="nav-button nav-secondary" href="/legacy.html">Legacy lab</a></div></aside>`; }
function title() { return S.page === 'lab' ? 'Demo Lab' : S.page === 'lumen' ? 'Lumen Demo' : isLiveMode(S.report) ? 'Access delivery incident' : 'Payment activation incident'; }
function incidentPage() {
  const r = S.report, inc = r.incident, summary = r.summary || {}, recovery = r.recovery || {};
  const live = isLiveMode(r);
  const retry = retryIds(), showNew = !inc || S.newIncident;
  const accounts = (r.accounts || []).filter(a => (S.filter === 'all' || a.status === S.filter) && `${a.id} ${a.reason || ''}`.toLowerCase().includes(S.query.toLowerCase()));
  const rows = accounts.slice(S.offset, S.offset + 20).map(a => accountRow(a, S.selected.has(a.id), S.busy, r)).join('');
  const cause = recovery.root_cause_status || 'Unknown';
  return `<section class="recovery-heading"><div><p class="eyebrow">${h(r.manifest?.app_title || r.manifest?.app || 'App')} · ${h(r.manifest?.environment || 'Environment unavailable')}</p><h1>${h(live ? 'Access delivery incident' : title())}</h1><p>${live ? 'Review source entitlement delivery and the local Lumen access gate. Payment state is not independently verified.' : 'Compare payment, entitlement and client evidence. Approve only the accounts in the reviewed plan.'}</p></div><div>${badge(live ? 'LIVE ADAPTY · SEEDED DATA' : 'LOCAL SYNTHETIC DEMO',live ? 'amber' : 'blue')} ${inc ? badge(statusLabel(inc.status || 'Incident open'), inc.status === 'access_verified' ? 'green' : 'amber') : badge('No incident', 'blue')}</div></section>
    ${S.error ? `<div class="mock-error" role="alert">${h(S.error)} ${btn('Refresh', 'refresh')}</div>` : ''}
    ${!live && (r.incidents || []).length ? `<div class="account-controls"><label>Incident<select id="incident-picker">${r.incidents.map(item => `<option value="${h(item.id)}" ${item.id === inc?.id ? 'selected' : ''}>${h(item.trigger_user_id)} · ${h(item.confirmed)} confirmed · ${h(statusLabel(item.status))}</option>`).join('')}</select></label>${btn('New investigation','new-investigation')}</div>` : ''}
    ${summaryView(r)}
    ${retry.length ? `<section class="recovery-panel"><header><div><h2>${h(recovery.unresolved)} access ${recovery.unresolved === 1 ? 'remains' : 'results remain'} unresolved</h2><p>Review a new plan for the remaining unresolved steps.</p></div>${btn(`Preview retry (${retry.length})`,'retry',true)}</header></section>` : ''}
    <section class="recovery-context"><div><span>Incident</span><strong>${h(inc?.id || 'Not started')}</strong></div><div><span>Scope</span><strong>${h(r.manifest?.app_title || r.manifest?.app || 'App unavailable')} · ${h(r.manifest?.environment || 'Unknown environment')}</strong></div><div><span>Root cause</span><strong>${h(statusLabel(cause))} · ${h(recovery.root_cause_certainty || 'certainty unavailable')}</strong></div><div><span>Timeline</span><strong>${h(inc?.window_start || 'Snapshot unavailable')} → ${h(inc?.window_end || 'Snapshot unavailable')}</strong></div></section>
    <section class="recovery-panel"><header><div><h2>Accounts in scope</h2><p>${escapeCount(summary.in_scope)} in scope · ${escapeCount(summary.evaluated)} evaluated · ${escapeCount(summary.confirmed)} confirmed · ${escapeCount(summary.inconclusive)} inconclusive</p></div>${showNew ? (live ? btn('Open Lumen demo', 'open-lumen', true) : btn('Start investigation', 'investigate', true)) : btn('Refresh evidence', 'scan')}</header>
      ${showNew && !live ? `<p class="recovery-hint">Start with the affected customer account. The default window is five minutes before and after the event.</p><label class="field-label">Affected account <input id="trigger-user" value="${h(r.accounts?.find(a => a.status === 'activation_missing')?.id || r.accounts?.[0]?.id || '')}" placeholder="Account ID"></label><details class="snapshot-details"><summary>Adjust incident time window</summary><div class="account-controls"><label>Event time (UTC, optional)<input id="incident-time" type="datetime-local"></label><label>Window start (UTC, optional)<input id="window-start" type="datetime-local"></label><label>Window end (UTC, optional)<input id="window-end" type="datetime-local"></label></div></details>` : ''}
      <div class="account-controls"><label>Search <input id="search" type="search" value="${h(S.query)}" placeholder="Account or reason"></label><label>Outcome <select id="filter"><option value="all">All outcomes</option>${statusOptions.map(x => `<option value="${x}" ${S.filter === x ? 'selected' : ''}>${h(statusLabel(x))}</option>`).join('')}</select></label></div>
      ${live && !eligible().length ? '<p class="recovery-hint">No accounts are currently eligible for a recovery plan.</p>' : ''}<div class="account-selection"><span>${selectedIds().length} selected</span>${btn(`Select all eligible (${eligible().length})`, 'select-all', false, !eligible().length)}${btn('Clear', 'clear-selection', false, !S.selected.size)}${retry.length ? '' : btn('Preview selected plan', 'preview', true, !selectedIds().length)}</div>
      <div class="table-scroll"><table class="data-table recovery-table"><thead><tr><th>Select</th><th>Account / evidence</th><th>Payment</th><th>Adapty</th><th>Client gate</th><th>Outcome</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No accounts match this view.</td></tr>'}</tbody></table></div><footer class="pagination"><span>Showing ${accounts.length ? S.offset + 1 : 0}–${Math.min(S.offset + 20, accounts.length)} of ${accounts.length}</span>${btn('Previous','previous',false,S.offset === 0)}${btn('Next','next',false,S.offset + 20 >= accounts.length)}</footer>
    </section>
    <section class="recovery-actions"><header><div><h2>Recovery report</h2><p>${live ? 'Adapty entitlement delivery and local access are checked separately.' : 'Activation and delivered access are checked separately.'}</p></div>${btn('Download HTML report','export')}${btn('Download JSON audit','export-json')}</header><details class="snapshot-details"><summary>Action evidence and responsibilities (${(r.actions || []).length})</summary>${actionsTable(r.actions || [])}</details></section>
    ${inc ? `<details class="snapshot-details"><summary>Incident window and evidence snapshot</summary><p>${h(inc.window_start || 'Start unavailable')} to ${h(inc.window_end || 'End unavailable')} · Snapshot ${h(inc.snapshot_id || 'unavailable')} · ${h(r.coverage?.observed_at || 'Observation time unavailable')}</p><ul>${(r.coverage?.gaps || []).map(g => `<li>${h(typeof g === 'string' ? g : JSON.stringify(g))}</li>`).join('') || '<li>No reported coverage gaps.</li>'}</ul>${inc.snapshot_id ? btn('Open evidence snapshot','snapshot') : ''}</details>` : ''}`;
}
const escapeCount = x => h(x ?? 0);
function actionsTable(actions) { return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Owner</th><th>Target</th><th>Status</th><th>Time</th><th>Evidence</th><th>Next step</th></tr></thead><tbody>${actions.map(a => `<tr><td>${h(a.owner)}</td><td>${h(targetLabel(a))}${a.account_id ? `<small>${h(a.account_id)}</small>` : ''}</td><td>${badge(statusLabel(a.status),statusTone(a.status))}</td><td>${h(a.started_at || a.finished_at || 'Not recorded')}</td><td>${h(a.evidence_ref || 'Not recorded')}</td><td>${h(a.next_step || 'No next step recorded')}</td></tr>`).join('') || '<tr><td colspan="6">No recovery actions recorded.</td></tr>'}</tbody></table></div>`; }
function demoPage() { if (isLiveMode(S.report)) { const s=S.liveStatus||{}; return `<section class="recovery-heading"><div><p class="eyebrow">Live source status</p><h1>Demo Lab</h1><p>Read-only integration details for the isolated Lumen and Adapty demo.</p></div>${badge(s.ready?'Source ready':'Source unavailable',s.ready?'green':'amber')}</section><section class="recovery-panel"><h2>Adapty and Lumen source</h2><p>${h(s.active_count ?? 0)} active entitlements · ${h(s.account_count ?? 0)} seeded accounts · Last source read ${h(s.source_observed_at || 'not available')}</p><p>Source environment: ${h(s.source_environment || 'unavailable')} · App: ${h(s.app_title || s.app || S.report.manifest?.app || 'Lumen')} · ${h(s.lumen_url || 'Local Lumen gate unavailable')}</p><p>Adapty CLI reads the catalog, Adapty API reads entitlements, and the server SDK reports local gate decisions.</p>${btn('Refresh source','live-refresh',true,s.actions_allowed?.refresh!==true)}<details class="snapshot-details"><summary>Integration status</summary><pre>${h(JSON.stringify(s,null,2))}</pre></details></section>`; } return `<section class="recovery-heading"><div><p class="eyebrow">Synthetic scenario</p><h1>${h(title())}</h1><p>Reset clears this recovery run’s plans, approvals and action history.</p></div></section><section class="recovery-panel"><label class="field-label">Scenario <select id="scenario">${['stripe','paddle','custom','apple','google','offline'].map(x => `<option>${x}</option>`).join('')}</select></label><label class="field-label">Variant <select id="variant"><option value="0">Default</option><option value="1">Alternate</option></select></label>${btn('Reset recovery scenario','reset',true)} ${btn('Advance scenario clock 5 minutes','advance')} ${btn('Refresh report','refresh')}</section><section class="recovery-panel"><h2>Fault controls</h2><p>Local simulator only. One-shot faults clear after they are consumed.</p><label class="field-label">Fault <select id="demo-fault">${[['collector_outage','Collector unavailable'],['provider_outage','Provider unavailable'],['probe_outage','Lumen probe unavailable'],['suppress_customer_telemetry','Missing customer telemetry'],['validation_timeout_after_commit','Validation timeout after commit'],['rate_limit','Provider rate limit']].map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label class="approval-ack"><input id="fault-active" type="checkbox"> Enable selected fault</label>${btn('Apply fault setting','fault')}</section><section class="recovery-panel"><h2>Regression demos</h2><a class="btn" href="/analytics.html">Analytics</a> <a class="btn" href="/access.html">Cancellation recovery</a> <a class="btn" href="/legacy.html">Legacy fixture lab</a></section>`; }
function lumenPage() { const accounts=S.report.accounts||[]; const live=isLiveMode(S.report), s=S.liveStatus||{}; return `<section class="recovery-heading"><div><p class="eyebrow">${live?'LIVE ADAPTY · SEEDED DATA':'Real local gate decision'}</p><h1>Lumen Demo</h1><p>${live?'Real Adapty reads and the real Lumen SDK gate use synthetic purchase records. No money was received or recovered.':'Try an actual premium export request for a selected account. A 403 response is shown as the gate outcome.'}</p></div>${live?badge(s.ready?'Source ready':'Source unavailable',s.ready?'green':'amber'):''}</section>${live?`<section class="recovery-panel"><h2>Local access incident</h2><p>Changes local Lumen client projections and runs one real premium export gate denial, affecting Lumen locally.</p><p>${h(s.active_count ?? 0)} active entitlements · ${h(s.account_count ?? 0)} seeded accounts · Last checked ${h(s.source_observed_at || 'not available')}</p>${S.detecting?'<p class="job-status" role="status" aria-live="polite">Incident requested; waiting for the detector…</p>':''}${S.error?`<div class="mock-error" role="alert">${h(S.error)}</div>`:''}${btn('Simulate local access incident','live-incident',true,!s.ready||S.detecting||s.actions_allowed?.inject_incident!==true)}</section>`:''}<section class="recovery-panel"><h2>Check the customer gate</h2><p>Test premium export access before and after recovery.</p><label class="field-label">Account <select id="lumen-user">${accounts.map(a=>`<option value="${h(a.id)}" ${S.lumenUser===a.id?'selected':''}>${h(a.id)}</option>`).join('')}</select></label>${accounts.length?btn('Try premium export','lumen-export',!live):'<p>No account is available for the gate check.</p>'}${live?`<p>Payment state is not independently verified.</p><p>Local gate: ${h(s.lumen_url || 'unavailable')}</p>`:''}${S.gate?`<div class="gate-result" role="status"><strong>${S.gate.http_status===403||S.gate.allowed===false?'403 · Access denied':S.gate.http_status===200||S.gate.allowed===true?'200 · Access allowed':'Gate result'}</strong><p>${h(S.gate.reason||S.gate.message||'No reason returned')}</p><details><summary>Gate evidence</summary><pre>${h(JSON.stringify(S.gate,null,2))}</pre></details>${S.gate.http_status===403||S.gate.allowed===false?btn('Investigate this account','investigate-gate'):''}</div>`:''}</section>`; }
function render() {
  if (!S.report) { root.innerHTML = `<main class="fatal-state"><h1>Payment Activation Recovery</h1><p>${h(S.error || 'Loading current evidence…')}</p>${S.error ? btn('Try again','refresh',true) : ''}</main>`; return; }
  root.innerHTML = `<div class="app-shell mock-app recovery-app">${sidebar()}<div class="main-shell"><header class="topbar"><div class="toolbar-location"><button class="btn-icon mobile-nav-button" data-action="nav" aria-label="Open navigation" aria-expanded="${S.nav}" aria-controls="primary-navigation">☰</button><div class="breadcrumbs"><span>Workspace</span> / <strong>${h(title())}</strong></div></div><div class="topbar-actions"><span class="mock-badge"><span class="status-dot"></span>${isLiveMode(S.report)?'LIVE ADAPTY · SEEDED DATA':'LOCAL SYNTHETIC DEMO'}</span></div></header><main class="page" id="main-content" tabindex="-1">${S.page === 'lab' ? demoPage() : S.page === 'lumen' ? lumenPage() : incidentPage()}${S.job ? `<p class="job-status" role="status" aria-live="polite">${h(S.jobState?.status || 'queued')} · recovery job ${h(S.job)}</p>` : ''}</main></div></div>`;
  renderModal();
}
function closeModal() { S.modal = null; render(); if (S.returnFocus) document.querySelector(S.returnFocus)?.focus({ preventScroll: true }); }
function renderModal() {
  root.inert = Boolean(S.modal); document.body.style.overflow = S.modal ? 'hidden' : '';
  if (!S.modal) { overlay.innerHTML = ''; return; }
  const p = S.plan, modal = S.modal;
  if (modal === 'plan') {
    overlay.innerHTML = `<div class="overlay-backdrop" data-action="close"></div>
      <section class="drawer recovery-drawer" role="dialog" aria-modal="true" aria-labelledby="plan-title">
      <header class="drawer-header"><h2 id="plan-title">Review recovery plan</h2><button class="btn-icon" data-action="close" aria-label="Close">×</button></header>
      <div class="drawer-content"><p>${h(p.ids?.length ?? selectedIds().length)} ${(p.ids?.length ?? selectedIds().length) === 1 ? 'account is' : 'accounts are'} in this exact plan. Approval authorizes only these proposed steps.</p>
      <dl><dt>Plan</dt><dd>${h(p.id)}</dd><dt>Expires</dt><dd>${h(p.expires_at || 'Not specified')}</dd></dl>
      <details><summary>Accounts in this plan</summary><p class="mono">${(p.ids || selectedIds()).map(h).join(', ')}</p></details>
      <ol>${(p.steps || []).map(step => `<li><strong>${h(step.title || statusLabel(step.action))}</strong><p>${h(step.description || step.summary || '')}</p>${step.owner || step.actor ? `<small>Owner: ${h(step.owner || step.actor)}</small>` : ''}<details><summary>Technical details</summary><pre>${h(JSON.stringify(step, null, 2))}</pre></details></li>`).join('') || (p.entries || []).map(entry => `<li><strong>${h(statusLabel(entry.type || entry.action))}</strong><p>${h(targetLabel(entry))}</p><small>Owner: ${h(entry.owner)}</small><details><summary>Technical details</summary><pre>${h(JSON.stringify(entry, null, 2))}</pre></details></li>`).join('')}</ol>
      <label class="approval-ack"><input type="checkbox" id="ack" ${S.ack ? 'checked' : ''} ${S.busy ? 'disabled' : ''}>I reviewed and approve this exact plan.</label>
      <label class="field-label">Approval actor <input id="actor" value="${h(S.actor)}" maxlength="100" placeholder="Name or role" ${S.busy ? 'disabled' : ''}></label></div>
      <footer class="drawer-footer">${btn('Approve & run','approve',true,S.approved || !S.ack || !S.actor.trim())}${btn('Close','close')}</footer></section>`;
  } else {
    overlay.innerHTML = `<div class="overlay-backdrop" data-action="close"></div><section class="drawer recovery-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><header class="drawer-header"><h2 id="detail-title">${h(S.modalTitle || 'Evidence details')}</h2><button class="btn-icon" data-action="close" aria-label="Close">×</button></header><div class="drawer-content"><pre>${h(JSON.stringify(S.detail, null, 2))}</pre></div><footer class="drawer-footer">${btn('Close','close')}</footer></section>`;
  }
  overlay.querySelector('button[data-action="close"]')?.focus();
}
root.addEventListener('input', e => { if (e.target.id === 'search') { S.query = e.target.value; S.offset = 0; render(); const input=document.querySelector('#search'); input?.focus(); input?.setSelectionRange(S.query.length,S.query.length); } });
root.addEventListener('change', e => { const focus = focusSelector(e.target); if(e.target.id==='incident-picker'){S.incidentId=e.target.value;S.selected.clear();S.offset=0;S.newIncident=false;busy(refresh);return;} if (e.target.id === 'lumen-user') { S.lumenUser=e.target.value;S.gate=null;render(); } if (e.target.id === 'filter') { S.filter = e.target.value; S.offset = 0; render(); } if (e.target.dataset.account) { e.target.checked ? S.selected.add(e.target.dataset.account) : S.selected.delete(e.target.dataset.account); render(); } if (focus) document.querySelector(focus)?.focus({ preventScroll: true }); });
overlay.addEventListener('input', e => { if(e.target.id==='actor'){S.actor=e.target.value; const button=overlay.querySelector('[data-action="approve"]'); if(button)button.disabled=!S.ack||!S.actor.trim()||S.approved||S.busy;} });
overlay.addEventListener('change', e => { if (e.target.id === 'ack') { S.ack = e.target.checked; const button=overlay.querySelector('[data-action="approve"]'); if(button)button.disabled=!S.ack||!S.actor.trim()||S.approved||S.busy; } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.modal && !S.busy) closeModal(); else if (e.key === 'Escape' && S.nav) { S.nav = false; render(); document.querySelector('[data-action="nav"]')?.focus(); } if (e.key === 'Tab' && S.modal) { const items = [...overlay.querySelectorAll('button,input,[href],select,[tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled); if (!items.length) return; if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); } } });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action],[data-user]'); if (!el) return;
  if (el.dataset.user) { S.returnFocus=`[data-user="${CSS.escape(el.dataset.user)}"]`; busy(async () => { S.detail = await api(`/api/recovery/evidence?user=${encodeURIComponent(el.dataset.user)}`); S.modal = 'evidence'; S.modalTitle = `Evidence · ${el.dataset.user}`; render(); }); return; }
  const a = el.dataset.action;
  if (a === 'new-investigation') { S.newIncident=true; render(); document.querySelector('#trigger-user')?.focus(); return; }
  if (a === 'close') { if (!S.busy) closeModal(); return; }
  if (a === 'nav' || a === 'nav-close') { S.nav = a === 'nav' && !S.nav; render(); return; }
  if (a === 'page') { S.page = el.dataset.page; S.nav = false; render(); document.querySelector('#main-content')?.focus(); return; }
  if (a === 'select-all') { S.selected = new Set(eligible().map(x => x.id)); render(); document.querySelector('[data-action="preview"]')?.focus(); return; }
  if (a === 'clear-selection') { S.selected.clear(); render(); document.querySelector('[data-action="select-all"]')?.focus(); return; }
  if (a === 'previous' || a === 'next') { S.offset = Math.max(0,S.offset + (a === 'next' ? 20 : -20)); render(); return; }
  if (a === 'refresh') { busy(refreshAndResume); return; }
  if (a === 'open-lumen') { S.page='lumen';render();document.querySelector('#main-content')?.focus();return; }
  if (a === 'live-refresh') { busy(async()=>{await api('/api/recovery/live/refresh',{},60000);await refreshAndResume();notice('Adapty source refreshed.');}); return; }
  if (a === 'live-incident') { busy(async()=>{S.detecting=true;render();const previousIncidentId=S.report.incident?.id||null,previousJobIds=new Set((S.report.jobs||[]).map(job=>job.id));S.incidentId=null;const result=await api('/api/recovery/live/incident',{action:'inject'},60000);S.gate=result.gate?{...result.gate,http_status:result.gate.status}:null;S.lumenUser=S.gate?.user_id||S.lumenUser;const detected=await waitForLiveIncident(S.lumenUser,previousIncidentId,previousJobIds);S.incidentId=detected.incident.id;await beginJob({job_id:detected.job.id,incident_id:detected.incident.id});S.page='incident';await refresh();}); return; }
  if (a === 'investigate') {
    const user_id = document.querySelector('#trigger-user')?.value.trim();
    if (!user_id) { notice('Enter the affected account ID.', true); return; }
    const body = {user_id};
    for (const [id,key] of [['incident-time','occurred_at'],['window-start','window_start'],['window-end','window_end']]) {
      const value = document.getElementById(id)?.value;
      if (value) {
        const date = new Date(value + 'Z');
        if (!Number.isFinite(date.getTime())) { notice('Enter a valid UTC date and time.', true); return; }
        body[key] = date.toISOString();
      }
    }
    busy(async () => { await beginJob(await api('/api/recovery/incidents',body)); await refresh(); }); return;
  }
  if (a === 'scan') { busy(async () => { const result = await api('/api/recovery/scans',{incident_id:S.report.incident.id}); await beginJob(result); await refresh(); }); return; }
  if (a === 'preview') { S.returnFocus='[data-action="preview"]'; busy(async () => { S.plan = await api('/api/recovery/plans',{ids:selectedIds(),incident_id:S.report.incident?.id}); S.ack=false; S.approved=false; S.modal='plan'; render(); }); return; }
  if (a === 'retry') { S.returnFocus='[data-action="retry"]'; const ids=retryIds(); if(!ids.length){notice('No eligible unresolved accounts remain.',true);return;} busy(async()=>{S.plan=await api('/api/recovery/plans',{ids,incident_id:S.report.incident?.id});S.ack=false;S.approved=false;S.modal='plan';render();});return; }
  if (a === 'approve') { busy(async () => { await api('/api/recovery/approvals',{plan_id:S.plan.id,plan_hash:S.plan.plan_hash,actor:S.actor.trim()}); S.approved=true; const job=await api('/api/recovery/executions',{plan_id:S.plan.id,plan_hash:S.plan.plan_hash}); S.modal=null; await beginJob(job); await refresh(); }); return; }
  if (a === 'reset') { const scenario=document.querySelector('#scenario').value, variant=Number(document.querySelector('#variant').value); if (!confirm('Reset this recovery scenario? Plans, approvals and action history will be cleared.')) return; busy(async () => { await api('/api/recovery/demo',{action:'reset',scenario,variant},60000); S.incidentId=null;S.newIncident=false;S.selected.clear(); await refresh(); }); return; }
  if (a === 'advance') { busy(async()=>{await api('/api/recovery/demo',{action:'advance',seconds:300});await refresh();}); return; }
  if (a === 'fault') { const fault=document.querySelector('#demo-fault').value, active=document.querySelector('#fault-active').checked; busy(async()=>{await api('/api/recovery/demo',{action:'fault',fault,active});notice(`Fault ${active?'enabled':'disabled'}: ${fault.replaceAll('_',' ')}`);}); return; }
  if (a === 'export') { busy(async () => { const data=await api(reportPath('audit')); const html=safeReportHtml(data); const link=document.createElement('a'); link.href=URL.createObjectURL(new Blob([html],{type:'text/html'})); link.download='payment-activation-recovery.html'; link.click(); setTimeout(()=>URL.revokeObjectURL(link.href),1000); }); }
  if (a === 'export-json') { busy(async()=>{const data=await api(reportPath('audit'));const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));link.download='payment-activation-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}); }
  if (a === 'snapshot') { S.returnFocus='[data-action="snapshot"]'; busy(async()=>{S.detail=await api(`/api/recovery/snapshots/${encodeURIComponent(S.report.incident.snapshot_id)}`);S.modal='evidence';S.modalTitle='Incident evidence snapshot';render();}); }
  if (a === 'lumen-export') { const user_id=document.querySelector('#lumen-user')?.value; if(!user_id)return; S.lumenUser=user_id; busy(async()=>{S.gate=await api('/api/recovery/lumen/export',{user_id},12000,true);S.page='lumen';}); return; }
  if (a === 'investigate-gate') { const user_id=S.lumenUser || document.querySelector('#lumen-user')?.value; if(!user_id)return; busy(async()=>{await beginJob(await api('/api/recovery/incidents',{user_id}));await refresh();S.page='incident';});return; }
});
if(location.hash==='#lumen') S.page='lumen';
refreshAndResume().then(render).catch(e => { S.error=e.message; render(); });
