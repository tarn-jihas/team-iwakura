import { CLASSES, h, money, groupStatus, receiptStatus } from './mock-view.js';

const root = document.getElementById('app');
const overlay = document.getElementById('overlay-root');
const S = { page: 'cases', tab: 'findings', report: null, access: null, caseType: 'all', audit: null, manifest: null, history: [], operations: [], samples: [], preview: null, selected: new Set(), acknowledged: false, busy: false, nav: false, search: '', filter: 'all', modal: null, error: '' };
const paths = {
  logo: '<path d="M5 4h9v4H5zM10 16h9v4h-9zM5 8v8h5M14 8h5v8M8 12h8"/>',
  cases: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16M8 14h8m-8 3h5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  flask: '<path d="M9 3h6m-5 0v7L4 20h16l-6-10V3M7 16h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  money: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  duplicate: '<rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/>',
  missing: '<path d="M7 3h10v18H7V3ZM3 12h18"/>',
  link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 7M4 12l2 7a8 8 0 0 0 13-2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
};
const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.cases}</svg>`;
const badge = (text, tone = 'plain') => `<span class="badge badge-${tone}">${h(text)}</span>`;
const mockBadge = () => '<span class="mock-badge"><span class="status-dot"></span>FULL MOCK / SYNTHETIC DATA</span>';
const button = (text, action, primary = false, disabled = false, extra = '') => `<button class="btn ${primary ? 'btn-primary' : ''}" data-action="${action}" ${S.busy || disabled ? 'disabled' : ''} ${extra}>${h(text)}</button>`;
const currencies = data => Object.entries(data || {}).map(([c, v]) => `<span class="money">${h(money(v, true))} <small>${h(c)}</small></span>`).join(' · ');
let focusReturn, toastTimer;

async function api(path, body) {
  if (!path.startsWith('/api/') && !path.startsWith('/mock/')) throw new Error('Only local mock routes are available.');
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || `Local server returned ${response.status}`); error.status = response.status; throw error; }
  return result;
}
function notify(text, error = false) {
  clearTimeout(toastTimer);
  document.getElementById('toast-root').innerHTML = `<div class="toast ${error ? 'error' : ''}">${icon(error ? 'search' : 'check')}<span>${h(text)}</span></div>`;
  toastTimer = setTimeout(() => { document.getElementById('toast-root').innerHTML = ''; }, 6000);
}
async function refresh() {
  const [report, manifest, audit, history, operations, samples, access] = await Promise.all([
    api('/api/report'), api('/api/manifest'), api('/api/audit'), api('/api/history'), api('/api/operations'), api('/api/samples'), api('/api/access/report').catch(error => { if (error.status === 404) return null; throw error; }),
  ]);
  Object.assign(S, { report, access, manifest, audit, history: history.runs, operations: operations.operations, samples: samples.samples, error: '' });
}
async function run(action) {
  if (S.busy) return;
  S.busy = true; render();
  try { await action(); } catch (e) { S.error = e.message; notify(e.message, true); }
  finally { S.busy = false; render(); }
}
function download(value, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function navigate(page) { S.page = page; S.nav = false; S.search = ''; S.filter = 'all'; render(); window.scrollTo(0, 0); }
function sidebar() {
  const nav = [['cases', 'cases', 'Cases'], ['sources', 'layers', 'Sources'], ['lab', 'flask', 'Demo Lab'], ['history', 'clock', 'Evidence / Runs']];
  return `${S.nav ? '<div class="nav-backdrop" data-action="close-nav"></div>' : ''}<aside class="sidebar ${S.nav ? 'open' : ''}" id="primary-navigation" aria-label="Workspace navigation"><div class="sidebar-brand"><a href="#cases" class="brand" data-page="cases"><span class="brand-mark">${icon('logo', 23)}</span>Reconcile</a><button class="btn-icon sidebar-close" data-action="nav-close" aria-label="Close navigation">${icon('close')}</button></div><div class="workspace-identity"><span class="app-icon">L</span><div><strong>Mock Lumen</strong><span>Subscription evidence</span></div></div><nav class="primary-nav">${nav.map(([page, glyph, text]) => `<button class="nav-button ${S.page === page || page === 'cases' && S.page === 'case' ? 'active' : ''}" data-page="${page}">${icon(glyph, 17)}${text}${page === 'cases' ? '<span class="count">2</span>' : ''}</button>`).join('')}<a class="nav-button" href="/recovery.html">Payment Activation Recovery</a></nav><div class="sidebar-bottom"><div class="local-lock">${icon('shield')}<div><strong>Everything stays local</strong><span>127.0.0.1 · no provider accounts</span></div></div><div class="storage-note">${icon('layers', 13)}State saved on this computer</div></div></aside>`;
}
function heading(title, description, actions = '') {
  return `<section class="page-heading"><div class="page-title"><h1>${h(title)}</h1><p>${h(description)}</p></div><div class="heading-actions">${actions}</div></section>`;
}
function render() {
  const focus = document.activeElement?.id;
  const selection = document.activeElement?.selectionStart;
  if (!S.report) {
    root.innerHTML = `<div class="fatal-state"><span class="boot-mark">R</span><h1>Reconcile</h1><p>${h(S.error || 'Reading the local mock workspace…')}</p>${S.error ? button('Try again', 'retry', true) : ''}</div>`;
    return;
  }
  const label = { cases: 'Cases', case: 'RCN-001', sources: 'Sources', lab: 'Demo Lab', history: 'Evidence / Runs' }[S.page];
  root.innerHTML = `<div class="app-shell mock-app">${sidebar()}<div class="main-shell"><header class="topbar"><div class="toolbar-location"><button class="btn-icon mobile-nav-button" data-action="nav" aria-label="Open navigation" aria-expanded="${S.nav}" aria-controls="primary-navigation">${icon('menu', 19)}</button><div class="breadcrumbs"><span class="workspace-crumb">Workspace</span><span> / </span><strong>${label}</strong></div></div><div class="topbar-actions">${mockBadge()}<span class="tick-label">${icon('clock', 12)}Tick ${S.report.clock}</span></div></header><main class="page" id="main-content">${S.error ? `<div class="mock-error" role="alert">${h(S.error)} ${button('Refresh state', 'reload')}</div>` : ''}${S.page === 'case' ? casePage() : S.page === 'cases' ? casesPage() : S.page === 'sources' ? sourcesPage() : S.page === 'lab' ? labPage() : historyPage()}</main><footer class="mock-footer"><span>Deterministic engine · Decimal arithmetic · Human approval</span><span>FULL MOCK · No external requests</span></footer></div></div>`;
  renderOverlay();
  if (focus) { const el = document.getElementById(focus); el?.focus({ preventScroll: true }); if (typeof selection === 'number' && el?.setSelectionRange) el.setSelectionRange(selection, selection); }
}
function counts() {
  const groups = S.report.groups;
  return { findings: groups.reduce((n, g) => n + g.findings.length, 0), repair: groups.filter(g => g.writes).length, pending: S.report.pending_count || 0 };
}
function stage() {
  if (counts().pending) return ['Pending ingestion', 'amber'];
  if (S.report.verification_status === 'readback_failed') return ['Readback failed', 'red'];
  if (['unresolved', 'open_findings'].includes(S.report.verification_status) && S.report.action_count) return ['Repair not verified', 'amber'];
  if (counts().repair) return ['Needs review', 'amber'];
  return ['Manual investigation remains', 'blue'];
}
function casesPage() {
  const [status, tone] = stage();
  const access = S.access, affected = access && (access.recovery.target_count || access.summary.confirmed);
  const accessCard = access ? `<div class="mock-case-entry"><div><span class="case-code mono">ACCESS-001 · PAID ACCESS</span><h2>Paid access denied after renewal cancellation</h2><p>Current entitlement ${icon('arrow', 12)} Lumen projection, cache & premium gate</p><div class="case-meta">${access.summary.in_scope} accounts in scope · ${access.incident.id ? `${affected} affected · ${access.summary.inconclusive} inconclusive` : 'Run detection to assess the incident'}</div></div><div class="case-entry-end">${badge(access.recovery.target_count ? `${access.recovery.verified_count} gate-verified / ${access.recovery.unresolved_count} unresolved` : 'Needs detection', access.recovery.target_count && !access.recovery.unresolved_count ? 'green' : 'amber')}<a class="btn btn-primary" href="/access.html">Open cancellation recovery</a><a class="text-button" href="/access.html#lumen">Open cancellation Lumen lab ↗</a><a class="text-button" href="/recovery.html">Open activation recovery ↗</a></div></div>` : '<div class="mock-case-entry"><div><span class="case-code mono">PAID ACCESS RECOVERY</span><h2>Restart the server to load the access module</h2><p>The analytics workspace remains available. Stop the older server and run npm start again to enable Lumen recovery.</p></div></div>';
  const analyticsCard = `<div class="mock-case-entry"><div><span class="case-code mono">RCN-001 · ANALYTICS</span><h2>When subscription events drift</h2><p>Adapty-shaped ledger ${icon('arrow', 12)} Mixpanel-shaped analytics</p><div class="case-meta">mock-lumen · mock-mixpanel-eu · Production · 9 sample accounts</div></div><div class="case-entry-end">${badge(status, tone)}<div class="case-money">${currencies(S.report.gap)}</div>${button('Open analytics case', 'open-case', true)}</div></div>`;
  return `${heading('Cases', 'Investigate access incidents and subscription data, with the evidence to act.')}<div class="overview-strip"><div class="overview-stat"><strong>${access ? 2 : 1}</strong><span class="stat-label">Available cases</span><span class="stat-icon">${icon('cases', 25)}</span></div><div class="overview-stat"><strong>${counts().findings}</strong><span class="stat-label">Analytics findings</span><span class="stat-icon">${icon('search', 25)}</span></div><div class="overview-stat"><strong>${access?.recovery.verified_count ?? '—'}</strong><span class="stat-label">Access gates verified</span><span class="stat-icon">${icon('shield', 25)}</span></div></div><section class="list-panel"><div class="panel-toolbar"><label>Case type <select id="case-type" aria-label="Filter case type"><option value="all">All cases</option><option value="access" ${S.caseType === 'access' ? 'selected' : ''}>Paid access</option><option value="analytics" ${S.caseType === 'analytics' ? 'selected' : ''}>Analytics</option></select></label>${mockBadge()}</div>${S.caseType !== 'analytics' ? accessCard : ''}${S.caseType !== 'access' ? analyticsCard : ''}<div class="panel-footer"><span>FULL MOCK · independent access and analytics state</span><span>Human-approved repairs</span></div></section>`;
}
function currencyCards(report = S.report) {
  return `<div class="currency-cards">${['USD', 'EUR'].map(c => `<section class="currency-card"><div class="currency-heading"><strong>${c}</strong><span>DESTINATION − SOURCE</span></div><div class="currency-gap">${h(money(report.gap[c], true))}<small>${c}</small></div><div class="currency-detail"><span>Source ledger<strong>${h(money(report.source_totals[c]))}</strong></span><span>Effective destination<strong>${h(money(report.destination_effective_totals[c]))}</strong></span></div></section>`).join('')}</div>`;
}
function casePage() {
  const [status, tone] = stage();
  return `<button class="back-link" data-page="cases">← All cases</button>${heading('When subscription events drift', 'Compare the source ledger with analytics. Repair only what the evidence supports.', `${button('Export report', 'export-report')}${button(S.busy ? 'Working…' : 'Detect', 'detect', true)}`)}<div class="mock-case-meta">${badge('RCN-001')}${badge(status, tone)}<span>mock-lumen</span><span>EU · mock-mixpanel-eu</span><span>Production</span></div>${currencyCards()}<div class="metric-contract">${icon('shield', 14)}<span><strong>Explicit effective metric:</strong> query-deduped events + signed reconcile_correction events. Raw history stays intact. This is a synthetic analytical difference.</span><button class="text-button" data-action="metric">View contract ↗</button></div>
    <div class="mock-flow"><span class="flow-done">${icon('check', 12)} Detect</span><i>→</i><span>Review & preview</span><i>→</i><span>Human approval</span><i>→</i><span${counts().pending ? ' class="flow-active"' : ''}>Apply & pending</span><i>→</i><span>Fresh verification</span></div>
    <div class="mock-workspace"><section class="mock-work-main"><div class="mock-tabbar" role="tablist" aria-label="Case views">${[['findings', 'Findings', counts().findings], ['operations', 'Operations', S.operations.length], ['receipt', 'Case receipt', S.report.action_count]].map(([id, label, n]) => `<button role="tab" aria-selected="${S.tab === id}" data-tab="${id}" class="${S.tab === id ? 'active' : ''}">${label}<span>${n}</span></button>`).join('')}</div>${S.tab === 'findings' ? findingsPage() : S.tab === 'operations' ? operationsTable() : receiptPage()}</section>${reviewPanel()}</div>`;
}
function findingsPage() {
  const definitions = [...Object.entries(CLASSES), ...S.report.groups.filter(g => !CLASSES[g.cls]).map(g => [g.cls, { title: g.cls.replaceAll('_', ' ').toLowerCase(), icon: 'search', note: g.why }])];
  const groups = definitions.filter(([cls, meta]) => `${cls} ${meta.title} ${S.report.groups.find(g => g.cls === cls)?.findings.map(f => `${f.txn} ${f.user}`).join(' ') || ''}`.toLowerCase().includes(S.search.toLowerCase()) && (S.filter === 'all' || S.filter === 'repair' && ['MISSING_IN_MIXPANEL', 'PRICE_MISMATCH', 'DUPLICATE_IN_MIXPANEL'].includes(cls) || S.filter === 'manual' && (cls === 'EXTRA_IN_MIXPANEL' || !CLASSES[cls])));
  return `<div class="mock-finding-toolbar"><label class="search-field">${icon('search', 14)}<input id="finding-search" placeholder="Search findings or transaction ID" value="${h(S.search)}" aria-label="Search findings"></label><select id="finding-filter" aria-label="Filter findings"><option value="all">All groups</option><option value="repair" ${S.filter === 'repair' ? 'selected' : ''}>Repairable</option><option value="manual" ${S.filter === 'manual' ? 'selected' : ''}>Manual investigation</option></select></div><div class="mock-groups">${groups.map(([cls, meta]) => groupCard(cls, meta)).join('') || '<div class="empty-state">No matching findings. Try another search.</div>'}</div>`;
}
function groupCard(cls, meta) {
  const group = S.report.groups.find(g => g.cls === cls), status = groupStatus(S.report, cls);
  const tone = ['verified', 'mapped', 'expected'].includes(status) ? 'green' : status === 'manual' ? 'blue' : 'amber';
  return `<article class="mock-group ${status}" data-class="${cls}"><div class="mock-group-top"><span class="group-icon">${icon(meta.icon, 18)}</span><div class="group-title"><h3>${h(meta.title)}</h3><span>${h(cls)}</span></div>${badge(status === 'manual' ? 'Manual investigation' : status === 'expected' ? 'Expected / no action' : status[0].toUpperCase() + status.slice(1), tone)}</div><p>${h(meta.note)}</p>${group ? `<div class="mock-finding-list">${group.findings.map(f => `<button class="mock-finding" data-action="evidence" data-txn="${h(f.txn)}"><span><strong>${h(f.txn)}</strong><small>${h(f.user)} · ${h(f.event_class)}</small></span><span>${h(money(f.delta, true))} <small>${h(f.currency)}</small></span><span class="evidence-link">Evidence ↗</span></button>`).join('')}</div>` : `<div class="resolved-note">${icon('check', 13)}${cls === 'UNMAPPED_EVENT_NAME' ? 'Mapping accepted locally. No new destination event.' : 'Fresh destination read no longer reports these findings.'}</div>`}${group?.writes ? `<div class="group-action"><span>${status === 'pending' ? 'Waiting for mock ingestion' : status === 'approved' ? 'Approval recorded; re-open plan to apply' : 'Human approval required'}</span>${button(status === 'pending' ? 'View pending receipt' : 'Review & preview', status === 'pending' ? 'receipt' : 'preview', false, counts().pending > 0 && status !== 'pending', `data-cls="${cls}"`)}</div>` : cls === 'UNMAPPED_EVENT_NAME' && group ? `<div class="group-action"><code>${counts().pending ? 'Advance clock before mapping' : 'premium_paid_v2 → purchase'}</code>${button('Review mapping', 'map-preview', false, counts().pending > 0)}</div>` : ''}</article>`;
}
function reviewPanel() {
  return `<aside class="mock-review"><h2>Run controls</h2><p>Read fresh destination state before recording the verification outcome.</p>${button(`Advance mock clock${counts().pending ? ` (${counts().pending} pending)` : ''}`, 'advance', false)}${button('Fresh read / Verify', 'verify', true)}${button('Export audit receipt', 'export-audit')}<a class="btn" href="/recovery.html">Payment Activation Recovery</a></aside>`;
}
function operationsTable() {
  return `<div class="table-scroll"><table class="data-table mock-operations"><thead><tr><th>Transaction / user</th><th>Class / scope</th><th>Source</th><th>Effective destination</th><th>Difference</th><th>Status</th></tr></thead><tbody>${S.operations.map(o => `<tr><td><button class="text-button mono" data-action="evidence" data-txn="${h(o.txn)}">${h(o.txn)}</button><small>${h(o.user)}</small></td><td>${h(o.event_class)}<small>${h(o.environment)}</small></td><td class="money">${h(money(o.source_amount))} ${h(o.currency)}</td><td class="money">${h(money(o.destination_amount))}</td><td class="money">${h(money(o.delta, true))}</td><td>${badge(o.status)}</td></tr>`).join('')}</tbody></table></div><p class="table-note">Money is calculated on the server with Decimal. Sandbox is excluded from the production totals.</p>`;
}
function receiptPage() {
  const actions = Object.entries(S.audit.actions || {});
  return `<div class="receipt-summary"><h2>Case receipt</h2><p>${S.report.approval_count} approved groups · ${S.report.action_count} accepted writes · ${counts().pending} pending visibility</p><div class="receipt-actions">${button('Export audit receipt', 'export-audit')}${button('Verify with fresh read', 'verify', true)}${actions.length ? button('Retry approved apply', 'retry-apply') : ''}</div></div>${actions.length ? actions.map(([id, a]) => `<article class="receipt-row"><div>${badge(...receiptStatus(S.report, S.audit, id, a))}<strong>${h(a.group)}</strong></div><p>${h(a.finding)}</p><dl><dt>Action ID</dt><dd>${h(id)}</dd><dt>Payload SHA-256</dt><dd>${h(a.payload_hash)}</dd><dt>Approval actor</dt><dd>${h(a.approval_actor)}</dd><dt>Accepted → visible tick</dt><dd>${a.accepted_at_tick} → ${a.visible_at_tick}</dd></dl></article>`).join('') : '<div class="empty-state"><h3>No writes accepted yet</h3><p>Preview and approve an eligible repair group first.</p></div>'}`;
}
function sourcesPage() {
  return `${heading('Sources', 'Two active local providers. Original evidence stays available.')}<div class="source-intro-note">${icon('shield', 18)}<div>FULL MOCK / SYNTHETIC DATA. The webhook-shaped log is the transaction-price authority. A profile read contains current subscription state, not a per-transaction price ledger.</div></div><div class="source-inventory">${[['Adapty-shaped source', 'A', '/mock/adapty/events/export', 'Webhook-shaped JSONL · exact local ledger', 'source'], ['Mixpanel-shaped destination', 'm', '/mock/mixpanel/api/2.0/export', `${S.report.raw_event_count} visible raw events · ${S.report.query_event_count} after delivery dedup`, 'destination']].map(([title, mark, path, text, type]) => `<article class="inventory-card"><div class="inventory-heading"><span class="provider-mark ${type === 'source' ? 'adapty' : 'mixpanel'}">${mark}</span><strong>${title}</strong>${badge('Active local', 'green')}</div><p>${text}</p><code class="source-path">${path}</code><div class="inventory-actions">${button('View raw export', 'source-view', false, false, `data-path="${path}"`)}${button('Download JSONL', 'source-download', false, false, `data-path="${path}" data-type="${type}"`)}</div></article>`).join('')}</div><section class="mock-contract-card"><h2>Scope & provenance</h2><dl>${Object.entries(S.manifest).map(([key, value]) => `<dt>${h(key)}</dt><dd>${h(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>`).join('')}</dl><div class="receipt-actions">${button('View effective query', 'metric')}${button('View sample profile', 'profile')}</div></section>`;
}
function labPage() {
  return `${heading('Demo Lab', 'Repeat the repair loop and inspect synthetic provider samples.', button('Reset demo', 'reset-preview'))}<section class="mock-lab-guide"><span class="lab-eyebrow">THE HACKATHON WALKTHROUGH</span><h2>From discrepancy to a verifiable receipt.</h2><p>Reset → Detect → Evidence → Preview → Approve → Apply → Pending → Advance clock → Verify → Ghost → Export audit.</p><div class="receipt-actions">${button('Open the analytics case', 'open-case', true)}${button('Test wrong-region delivery', 'region-test')}<a class="btn" href="/recovery.html#lumen">Open Lumen access lab ↗</a><a class="btn" href="/recovery.html">Payment Activation Recovery</a></div><p class="table-note">The EU negative control returns transport HTTP 200 with zero stored events. This models one local failure mode; it is not a claim about every real provider request.</p></section><h2 class="section-title">Available synthetic samples <span>${S.samples.length}</span></h2><p class="section-description">Reference payloads only. These services are not active connectors.</p><div class="mock-sample-grid">${S.samples.map(s => `<button class="sample-card" data-action="sample" data-path="${h(s.path)}"><span>${icon('layers', 15)}${h(s.provider)}</span><strong>${h(s.path.split('/').at(-1))}</strong><small>${s.bytes} bytes · synthetic partial projection ↗</small></button>`).join('')}</div><section class="mock-contract-card"><h2>Additional offline controls</h2><p>The retained browser engine includes clean, missing refund, repeated delivery, duplicate purchase, price unit error and zero-net / two-error fixtures, plus an 8-order Google reference check.</p><a class="btn" href="/legacy.html" target="_blank" rel="noopener">Open legacy fixture lab ↗</a><p class="table-note">This separate lab uses browser-local snapshots and is not connected to the repair state above. The separate 937-order Revenue Bridge package was not supplied.</p></section>`;
}
function historyPage() {
  return `${heading('Evidence / Run history', 'Saved server-side snapshots and the append-only action journal.', `${button('Detect & save run', 'detect', true)}${button('Export audit', 'export-audit')}`)}<section class="list-panel"><div class="panel-toolbar"><strong>Run snapshots</strong><span>Latest 20 · saved on this computer</span></div>${S.history.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Run</th><th>Tick</th><th>Findings</th><th>USD gap</th><th>EUR gap</th><th></th></tr></thead><tbody>${S.history.map((r, i) => `<tr><td><strong>${h(r.kind)}</strong><small class="mono">${h(r.id)}</small></td><td>${r.tick}</td><td>${r.report.groups.reduce((n, g) => n + g.findings.length, 0)}</td><td class="money">${h(money(r.report.gap.USD, true))}</td><td class="money">${h(money(r.report.gap.EUR, true))}</td><td>${button('Open snapshot', 'snapshot', false, false, `data-index="${i}"`)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><h3>No saved scan yet</h3><p>Detect or Verify saves an immutable report snapshot.</p></div>'}</section><section class="mock-contract-card"><h2>Audit journal</h2><div class="journal">${[...(S.audit.journal || [])].reverse().map(j => `<div class="journal-row"><span class="journal-dot"></span><div><strong>${h(j.type)}</strong><small>Tick ${j.tick ?? j.clock ?? 0}${j.actor ? ` · ${h(j.actor)}` : ''}</small>${j.cls ? `<code>${h(j.cls)}</code>` : ''}</div></div>`).join('')}</div></section>`;
}
function openModal(modal) { S.modal = modal; renderOverlay(); overlay.querySelector('button[data-action="close-modal"]')?.focus(); }
function closeModal() {
  S.modal = null; S.preview = null; S.selected.clear(); S.acknowledged = false; renderOverlay();
  const selector = focusReturn && Object.entries(focusReturn).map(([key, value]) => `[data-${key}="${CSS.escape(value)}"]`).join('');
  (selector && root.querySelector(selector) || root.querySelector('[data-action="detect"]'))?.focus();
}
function jsonBlock(title, data) { return `<section class="mock-json-block"><h3>${h(title)}</h3><pre>${h(typeof data === 'string' ? data : JSON.stringify(data, null, 2))}</pre></section>`; }
function renderOverlay() {
  const hadModalFocus = overlay.contains(document.activeElement);
  const focusedId = overlay.contains(document.activeElement) ? document.activeElement.id : '';
  const focusedSelection = overlay.contains(document.activeElement) ? document.activeElement.dataset.select : '';
  const modal = S.modal;
  root.inert = Boolean(modal);
  document.body.style.overflow = modal ? 'hidden' : '';
  if (!modal) { overlay.innerHTML = ''; return; }
  let content = '', footer = '';
  if (modal.kind === 'evidence') {
    const e = modal.data;
    content = `<p class="overlay-intro">Native-shaped local records and event IDs. Originals are retained; pending imports are separate from fresh visible readback.</p><div class="evidence-columns">${jsonBlock('Source ledger', e.source.length ? e.source : 'No counterpart in the declared source population.')}${jsonBlock('Destination · visible raw records', e.destination.length ? e.destination : 'No visible counterpart in these records.')}</div>${e.pending_destination?.length ? jsonBlock('Pending destination · not yet read back', e.pending_destination) : ''}${e.correction_receipts?.length ? jsonBlock('Action receipts', e.correction_receipts) : ''}`;
    footer = button('Export evidence', 'export-modal');
  } else if (modal.kind === 'preview') {
    content = `<p class="overlay-intro">Review exact payloads and signed metric changes. Approval only records your decision; Apply is a separate action.</p>${S.preview.groups.map(g => `<section class="preview-plan"><label class="preview-select"><input type="checkbox" data-select="${h(g.class)}" ${S.selected.has(g.class) ? 'checked' : ''} ${S.busy ? 'disabled' : ''}><span><strong>${h(CLASSES[g.class]?.title || g.class)}</strong><small>${g.row_count ?? g.finding_ids.length} destination events · ${h(g.action)}</small></span></label><div class="preview-delta">Expected signed gap change ${currencies(g.expected_signed_gap_change)}</div><dl><dt>Approval SHA-256</dt><dd>${h(g.approval_hash)}</dd></dl><details><summary>Exact planned payloads</summary><pre>${h(JSON.stringify(g.payloads, null, 2))}</pre></details></section>`).join('')}<label class="approval-ack"><input id="approval-ack" type="checkbox" ${S.acknowledged ? 'checked' : ''} ${S.busy ? 'disabled' : ''}><span>I reviewed the evidence and exact payloads. I approve only the checked groups for this local synthetic destination.</span></label><label class="actor-field">Approval actor<input id="approval-actor" value="${h(modal.actor ?? 'demo-operator')}" maxlength="100" autocomplete="off"></label>`;
    footer = `${button('Approve selected groups', 'approve', false, !S.selected.size || !S.acknowledged)}${button('Apply approved selection', 'apply', true, !S.selected.size || !S.acknowledged || !modal.approved)}`;
  } else if (modal.kind === 'mapping') {
    content = `<p class="overlay-intro">The same transaction is present under a renamed event. Accepting this rule updates local classification and creates zero destination events.</p><div class="mapping-rule"><code>premium_paid_v2</code>${icon('arrow')}<code>purchase</code></div>${jsonBlock('Matching source and destination evidence', modal.data)}<label class="approval-ack"><input id="mapping-ack" type="checkbox" ${modal.acknowledged ? 'checked' : ''} ${S.busy ? 'disabled' : ''}><span>I approve this local mapping rule after reviewing the matching identity.</span></label>`;
    footer = button('Accept local mapping', 'map', true, !modal.acknowledged);
  } else if (modal.kind === 'reset') {
    content = '<p class="overlay-intro">Reset this local demo to the fixed nine-account seed? This clears its approvals, corrections, mappings, audit journal and saved runs. Export your audit first if you need it.</p>';
    footer = `${button('Export audit first', 'export-audit')}${button('Reset local demo', 'reset', true)}`;
  } else if (modal.kind === 'snapshot') {
    content = `<div class="warning-callout">Historical snapshot · read-only · tick ${modal.data.tick}. Current repair actions always use the fresh active case.</div>${currencyCards(modal.data.report)}${jsonBlock('Saved report', modal.data)}`;
    footer = button('Export snapshot', 'export-modal');
  } else { content = jsonBlock(modal.title, modal.data); footer = button('Download', 'export-modal'); }
  overlay.innerHTML = `<div class="overlay-backdrop" data-action="close-modal"></div><section class="drawer mock-drawer" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="drawer-header"><div class="drawer-title-row"><div><span class="lab-eyebrow">LOCAL EVIDENCE WORKSPACE</span><h2 id="dialog-title">${h(modal.title)}</h2></div><button class="btn-icon" data-action="close-modal" aria-label="Close dialog">${icon('close', 20)}</button></div><div class="drawer-labels">${mockBadge()}${modal.kind === 'preview' && modal.approved ? badge('Approval saved', 'green') : ''}</div></header><div class="drawer-content">${content}</div><footer class="drawer-footer">${footer}${button('Close', 'close-modal')}</footer></section>`;
  const actorField = overlay.querySelector('#approval-actor'); if (actorField) actorField.disabled = S.busy;
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  else if (focusedSelection) overlay.querySelector(`[data-select="${CSS.escape(focusedSelection)}"]`)?.focus({ preventScroll: true });
  else if (hadModalFocus) overlay.querySelector('button[data-action="close-modal"]')?.focus({ preventScroll: true });
}
async function evidence(txn) { const data = await api(`/api/evidence?txn=${encodeURIComponent(txn)}`); openModal({ kind: 'evidence', title: txn, data }); }

document.addEventListener('click', async event => {
  const el = event.target.closest('[data-action], [data-page], [data-tab]');
  if (!el || el.disabled) return;
  if (el.dataset.page) { event.preventDefault(); navigate(el.dataset.page); return; }
  if (el.dataset.tab) { S.tab = el.dataset.tab; S.search = ''; S.filter = 'all'; render(); return; }
  const action = el.dataset.action;
  if (['evidence', 'preview', 'map-preview', 'reset-preview', 'snapshot', 'metric', 'profile', 'sample', 'source-view', 'region-test'].includes(action)) focusReturn = Object.fromEntries(Object.entries(el.dataset));
  if (action === 'close-modal') { if (!S.busy) closeModal(); return; }
  if (action === 'nav' || action === 'close-nav' || action === 'nav-close') { S.nav = action === 'nav' && !S.nav; render(); return; }
  if (action === 'open-case') { navigate('case'); return; }
  if (action === 'receipt') { S.tab = 'receipt'; render(); return; }
  if (action === 'reset-preview') { openModal({ kind: 'reset', title: 'Reset the local demo' }); return; }
  if (action === 'snapshot') { openModal({ kind: 'snapshot', title: 'Saved run snapshot', data: S.history[Number(el.dataset.index)] }); return; }
  if (action === 'export-report') { download({ mode: 'FULL_MOCK', manifest: S.manifest, report: S.report, operations: S.operations }, 'reconcile-report.json'); return; }
  if (action === 'export-audit') { await run(async () => { S.audit = await api('/api/audit'); download(S.audit, 'reconcile-case-receipt.json'); }); return; }
  if (action === 'export-modal') { download(S.modal.data, S.modal.filename || `reconcile-${S.modal.kind}.json`, S.modal.contentType || 'application/json'); return; }
  await run(async () => {
    if (action === 'retry' || action === 'reload') await refresh();
    else if (action === 'detect' || action === 'verify') {
      const result = await api(`/api/${action}`, {}); await refresh();
      if (action === 'verify' && (result.verification?.status === 'readback_failed' || S.report.action_count && ['readback_failed', 'unresolved', 'open_findings'].includes(S.report.verification_status))) {
        S.error = 'Fresh verification did not confirm the repair. Inspect the remaining findings and action receipts.'; notify(S.error, true);
      } else notify(action === 'detect' ? 'Fresh detection saved to run history.' : counts().pending ? 'Readback still pending. Advance the mock clock.' : S.report.action_count ? 'Fresh read complete. Review the remaining findings.' : 'No repair actions yet. Review the detected findings first.');
    }
    else if (action === 'evidence') await evidence(el.dataset.txn);
    else if (action === 'preview') {
      S.preview = await api('/api/preview'); S.selected.clear(); S.acknowledged = false;
      if (!S.preview.groups.length) { notify('No active repair plan. Read the current case receipt.'); return; }
      openModal({ kind: 'preview', title: 'Review the repair plan', approved: false });
    } else if (action === 'approve') {
      const ids = [...S.selected];
      const hashes = Object.fromEntries(S.preview.groups.filter(g => S.selected.has(g.class)).map(g => [g.class, g.approval_hash]));
      const actor = S.modal.actor ?? 'demo-operator';
      await api('/api/approve', { run: S.report.run, ids, hashes, actor });
      S.modal.approved = true; await refresh(); notify('Human approval saved. No destination writes yet.');
    } else if (action === 'apply') {
      const result = await api('/api/apply', { run: S.report.run, ids: [...S.selected] });
      closeModal(); await refresh(); S.tab = 'receipt'; notify(`${result.writes_accepted} writes accepted locally. Advance one tick, then Verify.`);
    } else if (action === 'retry-apply') {
      const result = await api('/api/apply', { run: S.report.run, ids: Object.keys(S.audit.approvals) });
      await refresh(); notify(`Idempotent retry: ${result.writes_accepted} additional writes accepted.`);
    } else if (action === 'map-preview') {
      const data = await api('/api/evidence?txn=txn_renamed'); openModal({ kind: 'mapping', title: 'Review the renamed event', data });
    } else if (action === 'map') {
      await api('/api/map', { event: 'premium_paid_v2', cls: 'purchase', actor: 'demo-operator' }); closeModal(); await refresh(); notify('Local mapping accepted. Zero destination events imported.');
    } else if (action === 'advance') { await api('/api/advance-clock', { ticks: 1 }); await refresh(); notify('Mock clock advanced. Run Verify to save a fresh readback.'); }
    else if (action === 'reset') { await api('/api/reset', {}); closeModal(); S.tab = 'findings'; await refresh(); navigate('case'); notify('Fixed seed restored. Six groups, seven findings.'); }
    else if (action === 'metric') openModal({ kind: 'json', title: 'Explicit effective metric', data: { contract: 'Query-time dedup (event + distinct_id + time + $insert_id), latest ingestion. Production only. Signed purchases/refunds plus reconcile_correction, separately per currency. Raw originals are retained; this is not a native provider chart.', result: await api('/mock/mixpanel/query') } });
    else if (action === 'profile') openModal({ kind: 'json', title: 'Synthetic profile · not a price ledger', data: await api('/mock/adapty/api/v2/server-side-api/profile/?customer_user_id=u00004') });
    else if (action === 'sample') { const data = await api(`/api/sample?path=${encodeURIComponent(el.dataset.path)}`); openModal({ kind: 'json', title: `Reference sample: ${data.path}`, data: data.content, filename: data.path.split('/').at(-1), contentType: 'text/plain' }); }
    else if (action === 'source-view' || action === 'source-download') {
      const response = await fetch(el.dataset.path, { cache: 'no-store' }); if (!response.ok) throw new Error('Could not read local export.'); const text = await response.text();
      if (action === 'source-download') download(text, `${el.dataset.type}.jsonl`, 'application/x-ndjson'); else openModal({ kind: 'json', title: 'Raw local export · JSONL', data: text, filename: 'reconcile-raw-export.jsonl', contentType: 'application/x-ndjson' });
    } else if (action === 'region-test') {
      const before = await api('/api/report');
      const probe = { event: 'subscription_started', properties: { distinct_id: 'mock-region-probe', time: 1794042000, $insert_id: 'mock-wrong-region-probe', transaction_id: 'txn_region_probe', currency: 'USD', price_local: '1.00', environment: 'Production', store: 'play_store' } };
      const data = await api('/mock/mixpanel/import?region=us', [probe]); const after = await api('/api/report');
      openModal({ kind: 'json', title: 'Wrong-region negative control', data: { transport_status: 200, mock_response: data, before_gap: before.gap, after_gap: after.gap, raw_before: before.raw_event_count, raw_after: after.raw_event_count, explanation: 'Local simulation: HTTP success alone is not persisted data or a successful repair.' } });
    }
  });
});
document.addEventListener('input', event => {
  if (event.target.id === 'finding-search') { S.search = event.target.value; render(); }
  if (event.target.id === 'approval-actor' && S.modal) {
    S.modal.actor = event.target.value; S.modal.approved = false;
    const applyButton = overlay.querySelector('[data-action="apply"]'); if (applyButton) applyButton.disabled = true;
  }
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'case-type') { S.caseType = el.value; render(); }
  if (el.id === 'finding-filter') { S.filter = el.value; render(); }
  if (el.dataset.select) { el.checked ? S.selected.add(el.dataset.select) : S.selected.delete(el.dataset.select); S.modal.approved = false; renderOverlay(); }
  if (el.id === 'approval-ack') { S.acknowledged = el.checked; S.modal.approved = false; renderOverlay(); }
  if (el.id === 'mapping-ack') { S.modal.acknowledged = el.checked; renderOverlay(); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !S.busy) { if (S.modal) closeModal(); else if (S.nav) { S.nav = false; render(); } }
  if (event.key === 'Tab' && S.modal) {
    const focusable = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),summary,a[href]')];
    const first = focusable[0], last = focusable.at(-1);
    if (!overlay.contains(document.activeElement)) { first?.focus(); event.preventDefault(); }
    else if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault(); }
  }
});
render(); run(refresh);
