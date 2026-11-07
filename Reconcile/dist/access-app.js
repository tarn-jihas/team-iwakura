import { h } from './mock-view.js';
import { STATUS, orderedAccounts, utcInput, utcValue, recoveryOutcome } from './access-view.js';

const root = document.getElementById('app'), overlay = document.getElementById('overlay-root');
const state = { report: null, view: location.hash === '#lumen' ? 'lumen' : 'incident', tab: 'accounts', filter: 'all', query: '', page: 0, selected: new Set(), window: null, busy: false, error: '', modal: null, plan: null, ack: false, actor: 'demo-operator', approved: false, activePlanId: null, nav: false, lumenUser: '', gate: null, handlerMode: 'faulty' };
let toastTimer, returnFocus;
const mark = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 4h9v4H5zM10 16h9v4h-9zM5 8v8h5M14 8h5v8M8 12h8"/></svg>';
const badge = (text, tone = 'plain') => `<span class="badge badge-${tone}">${h(text)}</span>`;
const mock = '<span class="mock-badge"><span class="status-dot"></span>FULL MOCK / SYNTHETIC DATA</span>';
const btn = (text, action, primary = false, disabled = false, extra = '') => `<button class="btn ${primary ? 'btn-primary' : ''}" data-action="${action}" ${state.busy || disabled ? 'disabled' : ''} ${extra}>${h(text)}</button>`;
const pretty = data => h(JSON.stringify(data, null, 2));
const summary = () => state.report.summary;
const eligible = () => state.report.accounts.filter(a => a.eligible);

async function request(path, body, allowDenied = false) {
  if (!path.startsWith('/api/access/') && !path.startsWith('/mock/lumen/')) throw new Error('Only local recovery routes are available.');
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok && !(allowDenied && response.status === 403 && result.allowed === false)) {
    const error = new Error(result.error || `Recovery server returned ${response.status}`); error.status = response.status; throw error;
  }
  return result;
}
async function refresh() {
  state.report = await request('/api/access/report'); state.error = '';
  const report = state.report;
  if (report.consumer) state.handlerMode = report.consumer.mode;
  if (!state.window) state.window = { start: utcInput(report.incident.window_start), end: utcInput(report.incident.window_end), handler: report.incident.handler_version };
  state.activePlanId = report.recovery.latest_plan_id || state.activePlanId;
  if (!state.lumenUser || !report.accounts.some(a => a.id === state.lumenUser)) state.lumenUser = orderedAccounts(report.accounts)[0]?.id || '';
  state.selected = new Set([...state.selected].filter(id => report.accounts.some(a => a.id === id && a.eligible)));
}
function notice(message, error = false) {
  clearTimeout(toastTimer); document.getElementById('toast-root').innerHTML = `<div class="toast ${error ? 'error' : ''}">${h(message)}</div>`;
  toastTimer = setTimeout(() => { document.getElementById('toast-root').innerHTML = ''; }, 6500);
}
async function work(action) {
  if (state.busy) return;
  state.busy = true; render();
  try { await action(); } catch (e) { state.error = e.message; if (e.status === 409 && state.modal?.kind === 'plan') state.approved = false; notice(e.message, true); }
  finally { state.busy = false; render(); }
}
function download(value, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function navigate(view) { state.view = view; state.nav = false; location.hash = view === 'incident' ? '' : view; render(); window.scrollTo(0, 0); }
function heading(title, subtitle, actions = '') { return `<section class="page-heading"><div class="page-title"><h1>${h(title)}</h1><p>${h(subtitle)}</p></div><div class="heading-actions">${actions}</div></section>`; }
function sidebar() {
  return `${state.nav ? '<div class="nav-backdrop" data-action="nav-close"></div>' : ''}<aside class="sidebar ${state.nav ? 'open' : ''}" id="primary-navigation" aria-label="Recovery workspace navigation"><div class="sidebar-brand"><a class="brand" href="/"><span class="brand-mark">${mark}</span>Reconcile</a><button class="btn-icon sidebar-close" data-action="nav-close" aria-label="Close navigation">×</button></div><div class="workspace-identity"><span class="app-icon">L</span><div><strong>Mock Lumen</strong><span>Paid Access Recovery</span></div></div><nav class="primary-nav"><a class="nav-button" href="/">▦ Cases<span class="count">2</span></a><button class="nav-button ${state.view === 'incident' ? 'active' : ''}" data-view="incident">◈ Access incident</button><button class="nav-button ${state.view === 'sources' ? 'active' : ''}" data-view="sources">▱ Sources / Collector</button><button class="nav-button ${state.view === 'lumen' ? 'active' : ''}" data-view="lumen">◇ Lumen / Demo Lab</button><button class="nav-button ${state.view === 'history' ? 'active' : ''}" data-view="history">◷ Evidence / Runs</button></nav><div class="sidebar-bottom"><div class="local-lock"><span>◈</span><div><strong>Real local gate decisions</strong><span>Synthetic licences · no provider writes</span></div></div><a class="nav-button" href="/">← Analytics workspace</a></div></aside>`;
}
function render() {
  const focusedId = document.activeElement?.id, cursor = document.activeElement?.selectionStart;
  const focusedAccount = document.activeElement?.dataset.account;
  if (!state.report) { root.innerHTML = `<div class="fatal-state"><span class="boot-mark">R</span><h1>Paid Access Recovery</h1><p>${h(state.error || 'Reading the local Lumen state…')}</p>${state.error ? btn('Try again', 'reload', true) : ''}</div>`; return; }
  root.innerHTML = `<div class="app-shell mock-app access-app">${sidebar()}<div class="main-shell"><header class="topbar"><div class="toolbar-location"><button class="btn-icon mobile-nav-button" data-action="nav" aria-label="Open navigation" aria-expanded="${state.nav}" aria-controls="primary-navigation">☰</button><div class="breadcrumbs"><a href="/">Cases</a><span> / </span><strong>ACCESS-001</strong></div></div><div class="topbar-actions">${mock}</div></header><main class="page" id="main-content">${state.error ? `<div class="mock-error" role="alert">${h(state.error)}${btn('Refresh current state', 'reload')}</div>` : ''}${state.view === 'incident' ? incidentPage() : state.view === 'lumen' ? lumenPage() : state.view === 'sources' ? sourcesPage() : historyPage()}</main><footer class="mock-footer"><span>Source entitlement → client projection → cache → actual premium gate</span><span>Local synthetic app · no payment credentials</span></footer></div></div>`;
  renderModal();
  const handlerMode = document.getElementById('handler-mode'); if (handlerMode) handlerMode.value = state.handlerMode;
  if (focusedId && !state.modal) { const field = document.getElementById(focusedId); field?.focus({ preventScroll: true }); if (typeof cursor === 'number' && field?.setSelectionRange) field.setSelectionRange(cursor, cursor); }
  else if (focusedAccount && !state.modal) root.querySelector(`input[data-account="${CSS.escape(focusedAccount)}"]`)?.focus({ preventScroll: true });
}
function scopeCards() {
  const s = summary(), r = state.report.recovery;
  const scanned = Boolean(state.report.incident.id);
  return `<div class="access-stats">${[['Accounts in scope', s.in_scope, 'Known client registry'], ['Evaluated', scanned ? s.evaluated : '—', 'Identity + fresh source'], ['Affected accounts', scanned ? r.target_count || s.confirmed : '—', r.target_count ? 'Approved incident cohort' : scanned ? 'Confirmed by current gate' : 'Run detection first'], ['Inconclusive', scanned ? s.inconclusive : '—', 'Excluded from all writes']].map(([label, value, note]) => `<section class="access-stat"><span>${label}</span><strong>${value}</strong><small>${note}</small></section>`).join('')}</div>`;
}
function incidentPage() {
  const r = state.report.recovery;
  return `${heading('Paid access denied after renewal cancellation', 'Find the affected accounts, approve a bounded resync and prove access at the app’s real gate.', `${btn('Open Lumen app', 'lumen')}${btn('Export evidence bundle', 'export')}`)}<div class="mock-case-meta">${badge('ACCESS-001')}${badge(...recoveryOutcome(r))}<span>${h(state.report.manifest.app)}</span><span>Production · premium_export</span></div>${scopeCards()}<div class="access-cause"><span class="access-cause-icon">◈</span><div><strong>${r.root_cause_status === 'pending' ? 'Root cause pending' : 'Demo consumer state: ' + r.root_cause_status}</strong><p>Restoring a licence changes the current app projection and cache. It does not fix or deploy the consumer that caused the incident.</p></div></div><form id="incident-form" class="access-window"><div><h2>Incident window</h2><p>Business occurrence time in UTC. Candidate grouping is followed by a full registry scan.</p></div><label>From (UTC)<input type="datetime-local" step="1" id="window-start" value="${h(state.window.start)}" required></label><label>To (UTC)<input type="datetime-local" step="1" id="window-end" value="${h(state.window.end)}" required></label><label>Consumer version<select id="window-handler"><option value="cancel-handler-v1" ${state.window.handler === 'cancel-handler-v1' ? 'selected' : ''}>Faulty v1</option><option value="cancel-handler-v2" ${state.window.handler === 'cancel-handler-v2' ? 'selected' : ''}>Fixed v2</option></select></label><button class="btn btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Working…' : 'Detect blast radius'}</button></form><div class="mock-flow"><span>1. Collect actual app events</span><i>→</i><span>2. Scan the registry</span><i>→</i><span>3. Preview & approve</span><i>→</i><span>4. Resync local licence</span><i>→</i><span>5. Probe the same gate</span></div><div class="mock-tabbar" role="tablist" aria-label="Access case views">${[['accounts', 'Accounts', state.report.accounts.length], ['repair', 'Repair & verify', r.target_count], ['scope', 'Scope & exclusions', summary().inconclusive]].map(([id, title, n]) => `<button role="tab" aria-selected="${state.tab === id}" class="${state.tab === id ? 'active' : ''}" data-tab="${id}">${title}<span>${n}</span></button>`).join('')}</div>${state.tab === 'accounts' ? accountsPage() : state.tab === 'repair' ? repairPage() : scopePage()}`;
}
function accountsPage() {
  const rows = orderedAccounts(state.report.accounts, state.filter, state.query), maxPage = Math.max(0, Math.ceil(rows.length / 20) - 1);
  state.page = Math.min(state.page, maxPage);
  const visible = rows.slice(state.page * 20, (state.page + 1) * 20);
  return `<section class="list-panel"><div class="panel-toolbar access-account-toolbar"><label class="search-field"><input id="account-search" aria-label="Search accounts" placeholder="Search account ID or reason" value="${h(state.query)}"></label><select id="account-filter" aria-label="Filter access accounts"><option value="all">All outcomes</option>${Object.entries(STATUS).map(([id, [label]]) => `<option value="${id}" ${state.filter === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="access-selection"><span><strong>${state.selected.size}</strong> accounts selected</span>${btn(`Select all eligible (${eligible().length})`, 'select-eligible', false, !eligible().length)}${btn('Clear selection', 'clear-selection', false, !state.selected.size)}${btn('Preview selected repair', 'preview', true, !state.selected.size)}</div><div class="table-scroll"><table class="data-table access-account-table"><thead><tr><th>Select</th><th>Account / evidence</th><th>Source entitlement</th><th>Actual client gate</th><th>Outcome</th></tr></thead><tbody>${visible.map(a => `<tr><td><input type="checkbox" data-account="${h(a.id)}" aria-label="Select ${h(a.id)} for repair" ${state.selected.has(a.id) ? 'checked' : ''} ${!a.eligible || state.busy ? 'disabled' : ''}></td><td><button class="text-button mono" data-action="evidence" data-user="${h(a.id)}">${h(a.id)} ↗</button><small>${a.observed_customer_denial ? 'Observed customer denial' : 'No customer attempt established'}</small></td><td>${a.source_active === true ? 'Active' : a.source_active === false ? 'Inactive / expired' : 'Unknown'}<small>${h(a.source_freshness)}${a.source_expires_at ? ' · expires '+h(a.source_expires_at.slice(0, 10)) : ''}</small></td><td>${badge(a.gate?.allowed ? 'Allows access' : 'Denies access', a.gate?.allowed ? 'green' : 'plain')}<small>${h(a.gate?.reason || a.reason)}</small></td><td>${badge(...(STATUS[a.status] || [a.status, 'plain']))}<small>${h(a.reason)}</small></td></tr>`).join('') || '<tr><td colspan="5"><div class="empty-state">No accounts match this view.</div></td></tr>'}</tbody></table></div><div class="panel-footer"><span>${rows.length ? state.page * 20 + 1 : 0}–${Math.min((state.page + 1) * 20, rows.length)} of ${rows.length} accounts</span><div>${btn('Previous', 'previous', false, state.page === 0)}${btn('Next', 'next', false, state.page === maxPage)}</div></div></section>`;
}
function repairPage() {
  const r = state.report.recovery, unresolved = r.unresolved_ids || [];
  const plans = state.report.plans || [];
  return `<section class="access-recovery-card"><div><span class="lab-eyebrow">VERIFIED OUTCOMES</span><h2>${r.verified_count || 0}<small> / ${r.target_count || 0} accounts verified at the gate</small></h2><p>${r.unresolved_count || 0} unresolved · ${summary().inconclusive} inconclusive accounts remain excluded.</p></div>${badge(...recoveryOutcome(r))}<div class="receipt-actions">${btn('Verify actual gates', 'verify', true, !state.activePlanId)}${btn('Repeat approved apply', 'repeat', false, !state.activePlanId)}${btn(`Preview fresh retry (${unresolved.length})`, 'retry-preview', false, !unresolved.length)}${btn('Export evidence bundle', 'export')}</div></section><div class="source-intro-note"><div><strong>Write acceptance is not access restoration.</strong> Verification calls the same premium gate as the Lumen app. A successful projection write with stale cache remains unresolved. A retry needs a new preview, fresh checks and approval.</div></div>${plans.length ? plans.slice().reverse().map(p => `<section class="receipt-row"><div>${badge(p.status || (p.approved ? 'Approved' : 'Preview'))}<strong>${h(p.id)}</strong></div><p>${p.entries?.length ?? p.account_ids?.length ?? '—'} accounts · ${h(p.expires_at || '')}</p><dl><dt>Plan SHA-256</dt><dd>${h(p.plan_hash)}</dd></dl><div class="receipt-actions">${btn('Inspect plan', 'inspect-plan', false, false, `data-plan="${h(p.id)}"`)}</div></section>`).join('') : '<div class="empty-state"><h3>No repair plan yet</h3><p>Select confirmed accounts in the Accounts tab and preview their exact resync.</p></div>'}`;
}
function scopePage() {
  const s = summary();
  return `<div class="access-scope-grid"><section class="mock-contract-card"><h2>Coverage and exclusions</h2><dl>${Object.entries(s).map(([key, value]) => `<dt>${h(key.replaceAll('_', ' '))}</dt><dd>${h(value)}</dd>`).join('')}</dl><p class="table-note">A previous payment is not proof of current access. Unknown identity, unavailable/stale entitlement, unsupported policy and incomplete processing never receive a repair.</p></section><section class="mock-contract-card"><h2>What this repair changes</h2><p>The current client projection and cache are refreshed from the current source entitlement. The original entitlement expiry stays unchanged.</p><p>Real charges, refunds, renewal choices and source licences are outside this local repair.</p><h2>Current incident</h2><pre class="access-inline-json">${pretty(state.report.incident)}</pre></section></div>`;
}
function lumenPage() {
  const account = state.report.accounts.find(a => a.id === state.lumenUser);
  return `${heading('Lumen · client app simulator', 'A small working client surface. Its premium export calls the same backend gate used by recovery verification.', btn('Back to incident', 'incident'))}<div class="lumen-layout"><section class="lumen-app-card"><div class="lumen-app-header"><span class="lumen-logo">L</span><div><strong>Lumen</strong><small>Synthetic photo workspace</small></div>${badge('Client simulator', 'blue')}</div><div class="lumen-canvas"><span class="lumen-sun"></span><span class="lumen-hill one"></span><span class="lumen-hill two"></span><span class="lumen-canvas-label">Your next perspective.</span></div><div class="lumen-app-content"><label>Demo account<select id="lumen-user">${orderedAccounts(state.report.accounts).map(a => `<option value="${h(a.id)}" ${a.id === state.lumenUser ? 'selected' : ''}>${h(a.id)} · ${h(STATUS[a.status]?.[0] || a.status)}</option>`).join('')}</select></label><div class="lumen-entitlement"><span>Source entitlement<strong>${account?.source_active === true ? 'Active paid period' : account?.source_active === false ? 'Inactive' : 'Unknown'}</strong></span><span>App access state<strong>${account?.gate?.allowed ? 'Gate allows access' : 'Gate denies access'}</strong></span></div>${btn('Export premium preview', 'lumen-export', true)}<p class="table-note">This is an actual local request and customer-attempt journal entry, not a prerecorded animation.</p>${state.gate ? `<div class="lumen-gate-result ${state.gate.allowed ? 'allowed' : 'denied'}" role="status"><strong>${state.gate.allowed ? '200 · Premium export allowed' : '403 · Premium export denied'}</strong><p>${h(state.gate.reason || state.gate.reason_code)}</p><details><summary>Gate response and versions</summary><pre>${pretty(state.gate)}</pre></details>${state.gate.allowed ? btn('Download gate receipt', 'gate-download') : btn('Investigate this incident', 'incident')}</div>` : ''}</div></section><div><section class="mock-contract-card"><h2>Collector SDK</h2><p>Consumer events, projection changes, customer access decisions and resync results are signed and recorded by our server-side SDK.</p><div class="access-collector-count"><strong>${state.report.collector.event_count}</strong><span>recorded metadata events</span></div><p>Only allowlisted subscription/access metadata is accepted. No card details or payment credentials are collected.</p>${btn('Inspect collector journal', 'journal')}</section><section class="mock-contract-card"><h2>Demo controls</h2><p>Handler changes apply to future cancellation events. Resyncing an account does not deploy a root-cause fix.</p><label class="access-field">Future cancellation handler<select id="handler-mode"><option value="faulty">Faulty v1</option><option value="fixed">Fixed v2</option></select></label><div class="receipt-actions">${btn('Set demo handler', 'set-handler')}${btn('Send cancellation to selected account', 'cancel')}</div><div class="access-demo-reset"><p>Reset only this access run. Analytics evidence is preserved.</p>${btn('Reset 100-account scenario', 'reset-preview')}${btn('Use alternate 100-account seed', 'variant-preview')}</div></section></div></div>`;
}
function sourcesPage() {
  const m = state.report.manifest;
  return `${heading('Sources / Collector', 'Separate source entitlement, client state and real gate decisions.', btn('Export evidence bundle', 'export'))}<div class="source-inventory">${[['Source entitlement', 'Synthetic Adapty-shaped current access observations. A payment amount alone never establishes entitlement.'], ['Client projection & cache', 'Independent revisioned state written by the Lumen consumer. Stale cache can deny access after a successful resync.'], ['Collector SDK journal', `${state.report.collector.event_count} signed metadata events generated by actual local app operations. Customer decisions and reconciliation probes carry separate initiators.`]].map(([title, note]) => `<article class="inventory-card"><div class="inventory-heading"><strong>${title}</strong>${badge('Synthetic / local', 'blue')}</div><p>${h(note)}</p></article>`).join('')}</div><section class="mock-contract-card"><h2>Run manifest</h2><dl>${Object.entries(m).map(([key, value]) => `<dt>${h(key)}</dt><dd>${h(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>`).join('')}</dl><div class="receipt-actions">${btn('View registry', 'registry')}${btn('View collector journal', 'journal')}</div></section>`;
}
function historyPage() {
  const history = state.report.history || [];
  return `${heading('Evidence / Run history', 'Recorded scans, gate checks and approval receipts stay tied to the access run.', btn('Export evidence bundle', 'export'))}<section class="list-panel"><div class="panel-toolbar"><strong>Access run history</strong><span>Latest 20 recorded operations</span></div>${history.length ? history.slice().reverse().map((row, i) => `<div class="access-history-row"><div><strong>${h(row.action || row.kind || row.type || 'Snapshot')}</strong><small>${h(row.at || row.id || row.created_at || row.scenario_now || '')}</small></div>${btn('Inspect record', 'history', false, false, `data-index="${history.length - i - 1}"`)}</div>`).join('') : '<div class="empty-state">Detect or verify an incident to record a snapshot.</div>'}</section>`;
}
function openModal(modal) { state.modal = modal; renderModal(); overlay.querySelector('button[data-action="close"]')?.focus(); }
function closeModal() { state.modal = null; state.plan = null; state.ack = false; state.approved = false; renderModal(); const selector = returnFocus && `[data-action="${CSS.escape(returnFocus)}"]`; (selector && root.querySelector(selector) || root.querySelector('[data-action="export"]'))?.focus(); }
function renderModal() {
  const focused = overlay.contains(document.activeElement) ? document.activeElement.id : '';
  root.inert = Boolean(state.modal); document.body.style.overflow = state.modal ? 'hidden' : '';
  if (!state.modal) { overlay.innerHTML = ''; return; }
  const modal = state.modal;
  let body, actions;
  if (modal.kind === 'plan') {
    const p = state.plan;
    body = `<p class="overlay-intro">Review the exact accounts, unchanged entitlement expiry and proposed local projection/cache changes. Approval records a decision; Apply performs the resync.</p><div class="access-plan-summary">${badge(`${p.entries.length} accounts selected`, 'blue')}<span>Valid until ${h(p.expires_at)}</span></div><dl><dt>Plan ID</dt><dd>${h(p.id)}</dd><dt>Plan SHA-256</dt><dd>${h(p.plan_hash)}</dd></dl>${p.entries.map(entry => `<details class="access-plan-entry"><summary>${h(entry.account_id)} · bounded current-state resync</summary><pre>${pretty(entry)}</pre></details>`).join('')}${p.exclusions?.length ? `<section class="mock-json-block"><h3>Excluded accounts</h3><pre>${pretty(p.exclusions)}</pre></section>` : ''}<label class="approval-ack"><input type="checkbox" id="access-ack" ${state.ack ? 'checked' : ''} ${state.busy ? 'disabled' : ''}><span>I reviewed the exact account scope and evidence. I approve this local licence/cache repair without extending source entitlements.</span></label><label class="actor-field">Approval actor<input id="access-actor" value="${h(state.actor)}" maxlength="100" ${state.busy ? 'disabled' : ''}></label>`;
    body += '<p class="table-note">Plan expiry and source freshness use the explicit mock clock in UTC. Signature authentication uses actual wall-clock time.</p>';
    actions = `${btn('Approve this repair plan', 'approve', false, !state.ack || !state.actor.trim())}${btn('Apply approved repair', 'apply', true, !state.ack || !state.approved)}`;
  } else if (modal.kind === 'reset') {
    body = `<p class="overlay-intro">Reset the access simulator to ${modal.variant ? 'a different synthetic 100-account population' : 'the default 100-account scenario'}? This clears this access run’s approvals, repairs and history. The analytics run is preserved.</p>`;
    actions = `${btn('Export current evidence first', 'export')}${btn('Reset access run', 'reset', true)}`;
  } else { body = `<section class="mock-json-block"><h3>${h(modal.title)}</h3><pre>${pretty(modal.data)}</pre></section>`; actions = btn('Download evidence', 'modal-download'); }
  overlay.innerHTML = `<div class="overlay-backdrop" data-action="close"></div><section class="drawer mock-drawer" role="dialog" aria-modal="true" aria-labelledby="access-dialog-title"><header class="drawer-header"><div class="drawer-title-row"><div><span class="lab-eyebrow">PAID ACCESS RECOVERY</span><h2 id="access-dialog-title">${h(modal.title)}</h2></div><button class="btn-icon" data-action="close" aria-label="Close dialog">×</button></div><div class="drawer-labels">${mock}${state.approved && modal.kind === 'plan' ? badge('Human approval saved', 'green') : ''}</div></header><div class="drawer-content">${body}</div><footer class="drawer-footer">${actions}${btn('Close', 'close')}</footer></section>`;
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  else overlay.querySelector('button[data-action="close"]')?.focus({ preventScroll: true });
}
async function createPlan(ids, retry = false) {
  const plan = await request('/api/access/preview', { ids, ...(retry ? { retry_of: state.activePlanId } : {}) });
  state.plan = plan; state.ack = false; state.approved = false; openModal({ kind: 'plan', title: retry ? 'Review the fresh bounded retry' : 'Review the access repair plan' });
}
document.addEventListener('click', async event => {
  const element = event.target.closest('[data-action],[data-view],[data-tab]'); if (!element || element.disabled) return;
  if (element.dataset.view) { navigate(element.dataset.view); return; }
  if (element.dataset.tab) { state.tab = element.dataset.tab; render(); return; }
  const action = element.dataset.action;
  if (action === 'close') { if (!state.busy) closeModal(); return; }
  if (action === 'nav' || action === 'nav-close') { state.nav = action === 'nav' && !state.nav; render(); return; }
  if (action === 'lumen' || action === 'incident') { navigate(action); return; }
  if (action === 'select-eligible') { state.selected = new Set(eligible().map(a => a.id)); render(); return; }
  if (action === 'clear-selection') { state.selected.clear(); render(); return; }
  if (action === 'previous' || action === 'next') { state.page += action === 'next' ? 1 : -1; render(); return; }
  if (['preview', 'retry-preview', 'evidence', 'journal', 'registry', 'inspect-plan', 'history', 'reset-preview', 'variant-preview'].includes(action)) returnFocus = action;
  if (action === 'reset-preview' || action === 'variant-preview') { openModal({ kind: 'reset', title: 'Reset the access simulator', variant: action === 'variant-preview' ? 1 : 0 }); return; }
  if (action === 'modal-download') { download(state.modal.data, 'reconcile-access-evidence.json'); return; }
  if (action === 'gate-download') { download(state.gate, 'lumen-gate-receipt.json'); return; }
  if (action === 'history') { openModal({ kind: 'json', title: 'Historical access run · read only', data: state.report.history[Number(element.dataset.index)] }); return; }
  await work(async () => {
    if (action === 'reload') await refresh();
    else if (action === 'inspect-plan') {
      const bundle = await request('/api/access/audit');
      const plans = Array.isArray(bundle.plans) ? bundle.plans : Object.values(bundle.plans || {});
      const plan = plans.find(p => p.id === element.dataset.plan);
      if (!plan) throw new Error('The saved plan is unavailable in this access run.');
      openModal({ kind: 'json', title: 'Saved access repair plan', data: plan });
    }
    else if (action === 'preview') await createPlan([...state.selected]);
    else if (action === 'retry-preview') await createPlan(state.report.recovery.unresolved_ids || [], true);
    else if (action === 'approve') {
      await request('/api/access/approve', { plan_id: state.plan.id, plan_hash: state.plan.plan_hash, actor: state.actor });
      state.approved = true; await refresh(); notice('Approval saved. No client licence or cache was changed.');
    } else if (action === 'apply' || action === 'repeat') {
      const planId = action === 'apply' ? state.plan.id : state.activePlanId;
      const p = action === 'apply' ? state.plan : state.report.plans.find(row => row.id === planId);
      const result = await request('/api/access/apply', { plan_id: planId, plan_hash: p.plan_hash });
      state.activePlanId = planId; closeModal(); await refresh(); state.tab = 'repair'; state.view = 'incident';
      notice(`${result.writes_accepted} local resyncs accepted. Verify the actual gates to establish restoration.`);
    } else if (action === 'verify') {
      await request('/api/access/verify', { plan_id: state.activePlanId }); await refresh();
      const r = state.report.recovery; notice(`${r.verified_count} gate-verified / ${r.unresolved_count} unresolved. Root cause is tracked separately.`);
    } else if (action === 'evidence') openModal({ kind: 'json', title: `Evidence · ${element.dataset.user}`, data: await request(`/api/access/evidence?user=${encodeURIComponent(element.dataset.user)}`) });
    else if (action === 'journal') openModal({ kind: 'json', title: 'Collector journal · actual app operations', data: await request('/api/access/journal') });
    else if (action === 'registry') openModal({ kind: 'json', title: 'Known account registry', data: await request('/api/access/registry') });
    else if (action === 'export') download(await request('/api/access/audit'), 'reconcile-access-audit.json');
    else if (action === 'lumen-export') { state.gate = await request('/mock/lumen/export', { user_id: state.lumenUser, feature: 'premium_export' }, true); await refresh(); }
    else if (action === 'set-handler') { await request('/api/access/demo', { action: 'handler', mode: state.handlerMode }); await refresh(); notice('Future-event demo handler changed. Existing licences were not repaired.'); }
    else if (action === 'cancel') { await request('/api/access/demo', { action: 'cancel', ids: [state.lumenUser] }); state.gate = null; await refresh(); notice('Cancellation processed by the current demo handler. Inspect the resulting gate.'); }
    else if (action === 'reset') {
      await request('/api/access/demo', { action: 'reset', variant: state.modal.variant }); closeModal(); state.window = null; state.activePlanId = null; state.selected.clear(); state.gate = null; state.tab = 'accounts'; await refresh(); navigate('incident'); notice('Synthetic 100-account access scenario reset.');
    }
  });
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'incident-form') return;
  event.preventDefault();
  await work(async () => {
    await request('/api/access/detect', { run_id: state.report.manifest.run_id, window_start: utcValue(state.window.start), window_end: utcValue(state.window.end), handler_version: state.window.handler, event_type: 'subscription_renewal_cancelled', feature: 'premium_export' });
    state.selected.clear(); state.page = 0; await refresh(); notice('Registry scan complete. Confirmed accounts and exclusions are backed by current gate probes.');
  });
});
document.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'account-search') { state.query = el.value; state.page = 0; render(); }
  if (el.id === 'window-start') state.window.start = el.value;
  if (el.id === 'window-end') state.window.end = el.value;
  if (el.id === 'access-actor') { state.actor = el.value; state.approved = false; overlay.querySelector('[data-action="apply"]').disabled = true; overlay.querySelector('[data-action="approve"]').disabled = !state.ack || !state.actor.trim(); }
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.dataset.account) { el.checked ? state.selected.add(el.dataset.account) : state.selected.delete(el.dataset.account); render(); }
  if (el.id === 'account-filter') { state.filter = el.value; state.page = 0; render(); }
  if (el.id === 'window-handler') state.window.handler = el.value;
  if (el.id === 'handler-mode') state.handlerMode = el.value;
  if (el.id === 'access-ack') { state.ack = el.checked; state.approved = false; renderModal(); }
  if (el.id === 'lumen-user') { state.lumenUser = el.value; state.gate = null; render(); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !state.busy) { if (state.modal) closeModal(); else { state.nav = false; render(); } }
  if (event.key === 'Tab' && state.modal) {
    const items = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),summary,a[href]')];
    const first = items[0], last = items.at(-1);
    if (!overlay.contains(document.activeElement) || !event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault(); }
    else if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault(); }
  }
});
render(); work(refresh);
