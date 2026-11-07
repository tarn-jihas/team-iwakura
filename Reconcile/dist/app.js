import { SCENARIOS, loadCase, loadStoreCase, parseSource, reconcile, formatMoney, exportReport } from './engine.js';

const DOC_URL = 'https://docs.google.com/document/d/1FF7qujD65tEM6v0w2_6u7fhhmKCq3_-0evp0cIwD0vw/edit';
const STORAGE_KEY = 'reconcile-product-demo-v1';
const MAX_HISTORY = 20;
const root = document.getElementById('app');
const overlayRoot = document.getElementById('overlay-root');
const providerNames = { adapty: 'Adapty', mixpanel: 'Mixpanel', google_play: 'Google Play' };
const reviewLabels = { open: 'Open', investigating: 'Investigating', explained: 'Explained' };
const coverageLabels = { declared_complete: 'Declared complete', partial: 'Partial coverage', unknown: 'Unknown coverage' };
const caseNumbers = { zero_net_two_errors: 'RCN-005', missing_refund: 'RCN-002', double_tracking: 'RCN-004', repeated_delivery: 'RCN-003', price_unit_error: 'RCN-006', clean: 'RCN-001', store_reference: 'RCN-007' };
const paths = {
  logo: '<path d="M5 4h9v4H5zM10 16h9v4h-9zM5 8v8h5M14 8h5v8M8 12h8"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  cases: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16M8 14h3m-3 3h7"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  sliders: '<path d="M5 3v18M12 3v18M19 3v18"/><path d="M2 8h6m1 8h6m1-9h6" stroke-width="4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>',
  play: '<path d="m9 5 11 7-11 7V5Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  money: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.1M18 12h.1"/>',
  shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  send: '<path d="m4 13 16-9-8 16-2-7-6 0Z"/><path d="m10 13 10-9"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  file: '<path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h8"/>',
  folder: '<path d="M3 6h7l2 3h9v12H3V6Z"/>',
  upload: '<path d="M12 17V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 7M4 12l2 7a8 8 0 0 0 13-2"/>',
  retry: '<path d="M4 9a8 8 0 1 1 0 7M4 3v6h6"/>',
  missing: '<path d="M7 3h10v18H7V3ZM3 12h18"/>',
  duplicate: '<rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/>',
  filter: '<path d="M3 5h18M6 12h12m-9 7h6"/>',
  external: '<path d="M14 3h7v7m-1-6-9 9M9 3H3v18h18v-6"/>',
  flask: '<path d="M9 3h6m-5 0v7L4 20c-.3.6.1 1 1 1h14c.9 0 1.3-.4 1-1l-6-10V3M7 16h10"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  eye: '<path d="M2 12S6 5 12 5s10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
};
function icon(name, size = 16, extra = '') { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${extra}">${paths[name] || paths.info}</svg>`; }
function h(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function money(value, signed = false) { if (value === null || value === undefined) return '—'; return `${signed && BigInt(value) > 0n ? '+' : ''}${formatMoney(value)}`; }
function provider(name) { return providerNames[name] || name; }
function providerMark(name) { return `<span class="provider-mark ${h(name)}" aria-hidden="true">${name === 'google_play' ? 'G' : name === 'mixpanel' ? 'm' : 'A'}</span>`; }
function bytes(value = 0) { return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`; }
function dateTime(value) { if (!value || Number.isNaN(Date.parse(value))) return 'Not recorded'; return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(value)); }
function shortId(value = '') { return value.length > 29 ? `${value.slice(0, 12)}…${value.slice(-13)}` : value; }
function caseCode(id) { return caseNumbers[id] || `RCN-${String(id).slice(-5).toUpperCase()}`; }
function pretty(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  // Format only whitespace; re-parsing raw JSON would round large money tokens.
  let output = '', level = 0, inString = false, escaped = false;
  const indent = () => '  '.repeat(Math.max(0, level));
  for (const char of value) {
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; output += char; }
    else if (char === '{' || char === '[') { level++; output += char + '\n' + indent(); }
    else if (char === '}' || char === ']') { level--; output = output.trimEnd() + '\n' + indent() + char; }
    else if (char === ',') output += ',\n' + indent();
    else if (char === ':') output += ': ';
    else if (!/\s/.test(char)) output += char;
  }
  return output;
}
function validCase(value) { return value && typeof value.id === 'string' && value.left && value.right && Array.isArray(value.findings) && Array.isArray(value.operations) && value.counts && typeof value.deltaMinor === 'string'; }
function storedState() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
const saved = storedState();
if (saved.reviews && typeof saved.reviews === 'object') for (const id of Object.keys(saved.reviews)) if (saved.reviews[id] === 'resolved') saved.reviews[id] = 'explained';
const state = {
  page: 'cases', tab: 'findings', cases: [], storeCase: null, current: null, history: saved.history && typeof saved.history === 'object' ? saved.history : {},
  reviews: saved.reviews && typeof saved.reviews === 'object' ? saved.reviews : {}, customCases: Array.isArray(saved.customCases) ? saved.customCases.filter(validCase) : [],
  caseSearch: '', caseFilter: 'all', findingSearch: '', findingFilter: 'all', operationFilter: 'all', ai: null,
  drawer: null, modal: null, import: null, navOpen: false, running: false, storageOK: true, activeRunId: null,
};
let toastTimer;
function notify(message, error = false) { clearTimeout(toastTimer); document.getElementById('toast-root').innerHTML = `<div class="toast ${error ? 'error' : ''}">${icon(error ? 'alert' : 'check', 15)}<span>${h(message)}</span></div>`; toastTimer = setTimeout(() => { document.getElementById('toast-root').innerHTML = ''; }, 4200); }
function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ reviews: state.reviews, history: state.history, customCases: state.customCases, selectedCaseId: state.current?.id })); state.storageOK = true; } catch { if (state.storageOK) notify('Browser storage is full or unavailable. This session still works; export your case to keep it.', true); state.storageOK = false; } }
function historyFor(id) { const rows = state.history[id]; return Array.isArray(rows) ? rows.filter(row => validCase(row.snapshot)) : []; }
function recordRun(result, initial = false) {
  const existing = historyFor(result.id);
  if (initial && existing[0]?.snapshot?.fingerprint === result.fingerprint) { state.history[result.id] = existing; return existing[0]; }
  const row = { id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: result.computed_at, snapshot: clone(result) };
  state.history[result.id] = [row, ...existing].slice(0, MAX_HISTORY);
  return row;
}
function allCases() { return [...state.cases, ...state.customCases]; }
function findCase(id) { return allCases().find(c => c.id === id) || (state.storeCase?.id === id ? state.storeCase : null); }
function openCase(id) {
  const c = findCase(id); if (!c) return;
  const last = historyFor(id)[0]; state.current = clone(last?.snapshot?.fingerprint === c.fingerprint ? last.snapshot : c); state.activeRunId = last?.id || null;
  state.page = 'case'; state.tab = 'findings'; state.findingSearch = ''; state.findingFilter = 'all'; state.operationFilter = 'all'; state.ai = null; state.drawer = null; state.navOpen = false;
  persist(); render(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function badgeOutcome(c) { if (c.verdict === 'issues') return `<span class="badge badge-amber">${icon('alert', 10)}Needs review</span>`; if (c.verdict === 'inconclusive') return `<span class="badge badge-blue">${icon('info', 10)}Inconclusive</span>`; return `<span class="badge badge-green">${icon('check', 10)}Matched</span>`; }
function certaintyBadge(value) { return `<span class="badge ${value === 'proven' ? 'badge-green' : value === 'candidate' ? 'badge-amber' : 'badge-blue'}">${value === 'proven' ? 'Proven' : value === 'candidate' ? 'Candidate' : 'Inconclusive'}</span>`; }
function reviewSelect(c) { const current = state.reviews[c.id] || 'open'; return `<select data-bind="review" aria-label="Human review status" id="review-status">${Object.entries(reviewLabels).map(([id, label]) => `<option value="${id}" ${id === current ? 'selected' : ''}>Review: ${label}</option>`).join('')}</select>`; }
function sidebar() {
  return `${state.navOpen ? '<div class="nav-backdrop" data-action="nav-close"></div>' : ''}<aside class="sidebar ${state.navOpen ? 'open' : ''}" id="primary-navigation" aria-label="Workspace navigation">
    <div class="sidebar-brand"><a class="brand" href="#" data-action="navigate" data-page="cases" aria-label="Reconcile — cases"><span class="brand-mark">${icon('logo', 22)}</span>Reconcile</a><button class="btn-icon sidebar-close" data-action="nav-close" aria-label="Close navigation">${icon('close', 18)}</button></div>
    <div class="workspace-identity"><span class="app-icon">L</span><div><strong>Lumen</strong><span>Android workspace</span></div></div>
    <nav class="primary-nav" aria-label="Primary navigation">
      <button class="nav-button ${['case', 'cases'].includes(state.page) ? 'active' : ''}" data-action="navigate" data-page="cases">${icon('cases', 17)}Cases<span class="count">${allCases().length}</span></button>
      <button class="nav-button ${state.page === 'sources' ? 'active' : ''}" data-action="navigate" data-page="sources">${icon('layers', 17)}Sources</button>
    </nav>
    <div class="sidebar-reference"><span class="nav-section-label">Reference check</span><button class="nav-button nav-secondary" data-action="store-case">${icon('shield', 16)}Google Play → Adapty</button></div>
    <div class="sidebar-bottom"><button class="nav-button nav-secondary ${state.page === 'method' ? 'active' : ''}" data-action="navigate" data-page="method">${icon('info', 16)}Method & scope</button><a class="nav-button nav-secondary" href="${DOC_URL}" target="_blank" rel="noopener noreferrer">${icon('file', 16)}Specification${icon('external', 12)}</a><div class="storage-note">${icon('folder', 13)}Saved in this browser</div></div>
  </aside>`;
}
function topbar() {
  const label = state.page === 'case' ? caseCode(state.current.id) : state.page === 'cases' ? 'Cases' : state.page === 'sources' ? 'Sources' : 'Method & scope';
  const status = state.page === 'case' && state.current.source === 'user_supplied' ? 'Local file demo' : 'FULL MOCK / SYNTHETIC DATA';
  const action = state.page === 'cases' || state.page === 'sources' ? `<button class="btn btn-primary" data-action="new-case">${icon(state.page === 'sources' ? 'upload' : 'plus', 14)}${state.page === 'sources' ? 'Import source' : 'New case'}</button>` : '';
  return `<header class="topbar"><div class="toolbar-location"><button class="btn-icon mobile-nav-button" aria-label="${state.navOpen ? 'Close' : 'Open'} navigation" aria-expanded="${state.navOpen}" aria-controls="primary-navigation" data-action="nav-toggle">${icon('menu', 19)}</button><div class="breadcrumbs">${state.page === 'case' ? `<button data-action="navigate" data-page="cases">Cases</button>${icon('chevron', 11)}` : `<span class="workspace-crumb">Workspace</span><span class="crumb-first-chevron">${icon('chevron', 11)}</span>`}<strong>${h(label)}</strong></div></div><div class="topbar-actions"><span class="demo-pill" title="Browser-only prototype; no live provider connection">${icon('flask', 12)}${status}</span>${action}</div></header>`;
}
function pageHeading(title, description = '', actions = '', meta = '') {
  return `<section class="page-heading"><div class="page-title"><h1>${h(title)}</h1>${description ? `<p>${h(description)}</p>` : ''}</div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}${meta ? `<div class="case-meta">${meta}</div>` : ''}</section>`;
}
function workspaceStart(label) { return `<section class="workspace-content" aria-label="${h(label)}">`; }
function workspaceEnd() { return '</section>'; }
function render() {
  const focused = document.activeElement; const focusId = focused?.id; const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
  root.innerHTML = `<div class="app-shell">${sidebar()}<div class="main-shell">${topbar()}<main class="page" id="main-content">${state.page === 'case' ? casePage() : state.page === 'cases' ? casesPage() : state.page === 'sources' ? sourcesPage() : methodPage()}</main></div></div>`;
  renderOverlay();
  if (focusId) { const next = document.getElementById(focusId); if (next) { next.focus({ preventScroll: true }); if (selection && typeof next.setSelectionRange === 'function') try { next.setSelectionRange(...selection); } catch {} } }
}
function sourceTotal(source, side) { return `<div class="source-total"><div class="source-total-label">${providerMark(source.provider)}<span>${h(provider(source.provider))}</span><span class="source-kind">${side === 'left' ? 'REFERENCE' : 'COMPARISON'}</span></div><div class="big-amount">${h(money(source.totalMinor))}<span class="currency">USD</span></div><div class="source-subline"><strong>${source.rawCount} → ${source.dedupCount}</strong><span>operations after delivery dedup</span></div></div>`; }
function comparisonCard(c) { return `<section class="comparison-card" aria-label="Source totals"><div class="comparison-grid">${sourceTotal(c.left, 'left')}${sourceTotal(c.right, 'right')}<div class="source-total delta-total"><div class="source-total-label">${icon('money', 15)}Net difference<span class="source-kind">RIGHT − LEFT</span></div><div class="big-amount">${h(money(c.deltaMinor, true))}<span class="currency">USD</span></div><div class="source-subline">${BigInt(c.deltaMinor) === 0n && c.counts.issues > 0 ? `${icon('info', 11)}Equal totals do not mean equal operations` : c.counts.info ? 'Compared after delivery deduplication' : 'Compared within the selected scope'}</div></div></div><div class="comparison-footer"><span>${icon('globe', 11)}<strong>USD</strong> · UTC</span><span class="money-basis">${icon('money', 11)}Reported USD · charges less refunds</span><span class="scope-coverage">${icon(c.coverage === 'declared_complete' ? 'shield' : 'info', 11)}${h(coverageLabels[c.coverage])}${c.source === 'synthetic' ? ' · synthetic scope' : ''}</span></div></section>`; }
function verdictBanner(c) {
  let title, text, tone = '';
  if (c.counts.issues) { title = `${c.counts.issues} ${c.counts.issues === 1 ? 'discrepancy needs' : 'discrepancies need'} review`; text = BigInt(c.deltaMinor) === 0n ? 'The impacts offset each other. Operation-level matching reveals what the total misses.' : 'Open a finding to inspect the matching identities, amounts and source rows.'; }
  else if (c.counts.inconclusive) { title = 'The evidence is incomplete'; text = 'Imported records can be compared, but coverage or identity prevents a complete conclusion.'; tone = 'unknown'; }
  else { title = c.counts.info ? 'Amounts match after delivery deduplication' : 'Every operation matches in this scope'; text = c.counts.info ? 'Repeated delivery is recorded as a notice. It is not evidence of a second store payment.' : 'No operation-level differences were found in these imported snapshots.'; tone = 'good'; }
  return `<div class="verdict-banner ${tone}"><span class="verdict-icon">${icon(tone === 'good' ? 'check' : tone === 'unknown' ? 'info' : 'alert', 16)}</span><div><strong>${h(title)}</strong><p>${h(text)}</p></div><span class="banner-tail">${c.counts.matched} matched · ${c.operations.length} operation groups</span></div>`;
}
function casePage() {
  const c = state.current;
  return `<button class="back-link" data-action="navigate" data-page="cases">${icon('arrow', 13, 'back-arrow')}Back to cases</button>${pageHeading(c.title, c.description,
    `${reviewSelect(c)}<button class="btn" data-action="export-current">${icon('export', 14)}Export report</button><button class="btn btn-primary" data-action="run" ${state.running ? 'disabled' : ''}>${icon(state.running ? 'refresh' : 'play', 13, state.running ? 'spinner' : '')}${state.running ? 'Comparing…' : 'Run comparison'}</button>`,
    `<span class="mono">${h(caseCode(c.id))}</span><span>·</span><span>${h(provider(c.left.provider))} ${icon('arrow', 11)} ${h(provider(c.right.provider))}</span><span>·</span><span>Computed ${h(dateTime(c.computed_at))} UTC</span>`)}${workspaceStart(caseCode(c.id))}
    ${comparisonCard(c)}${verdictBanner(c)}
    <div class="workspace-layout"><div class="workspace-main"><section class="result-panel"><div class="panel-tabs" role="tablist" aria-label="Case sections">${[['findings', 'Findings', c.findings.length], ['operations', 'Operations', c.operations.length], ['sources', 'Sources', 2], ['runs', 'Runs', historyFor(c.id).length]].map(([id, label, count]) => `<button class="tab-button ${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}" role="tab" aria-selected="${state.tab === id}">${label}<span class="tab-count">${count}</span></button>`).join('')}</div>${state.tab === 'findings' ? findingsPanel(c) : state.tab === 'operations' ? operationsPanel(c) : state.tab === 'sources' ? sourcePanel(c) : runsPanel(c)}</section><div class="panel-notes"><h3>How this result was produced</h3><div class="rule-steps"><span>${icon('file', 12)}Read the source snapshots</span><span>${icon('duplicate', 12)}Deduplicate delivery identities</span><span>${icon('link', 12)}Match operation IDs and amounts</span></div></div></div>${investigationPanel(c)}</div>${workspaceEnd()}`;
}
function findingIcon(f) { return f.kind === 'economic_duplicate' || f.kind === 'repeated_delivery' ? 'duplicate' : f.kind === 'amount_mismatch' ? 'money' : f.kind === 'missing_operation' ? 'missing' : 'info'; }
function findingsPanel(c) {
  const q = state.findingSearch.trim().toLowerCase();
  const findings = c.findings.filter(f => (state.findingFilter === 'all' || f.severity === state.findingFilter) && (!q || `${f.title} ${f.description} ${f.transactionId}`.toLowerCase().includes(q)));
  return `<div class="panel-toolbar"><label class="search-field">${icon('search', 13)}<input id="finding-search" data-bind="finding-search" value="${h(state.findingSearch)}" placeholder="Search findings or transaction IDs" aria-label="Search findings"></label><select class="filter-select" id="finding-filter" data-bind="finding-filter" aria-label="Filter findings">${[['all', 'All findings'], ['issue', 'Discrepancies'], ['info', 'Delivery notices'], ['inconclusive', 'Inconclusive']].map(([id, name]) => `<option value="${id}" ${state.findingFilter === id ? 'selected' : ''}>${name}</option>`).join('')}</select></div>
  ${findings.length ? `<div class="table-scroll"><table class="data-table findings-table"><thead><tr><th>Finding</th><th>Impact</th><th>Certainty</th><th>Evidence</th></tr></thead><tbody>${findings.map(f => `<tr class="clickable" tabindex="0" data-action="evidence" data-id="${h(f.id)}" aria-label="Inspect evidence: ${h(f.title)}"><td><div class="finding-cell"><span class="finding-symbol ${h(f.severity)}">${icon(findingIcon(f), 13)}</span><div><span class="finding-name">${h(f.title)}</span><span class="finding-sub mono" title="${h(f.transactionId)}">${h(f.transactionId ? shortId(f.transactionId) : 'Comparison scope')}</span></div></div></td><td class="money nowrap">${h(money(f.deltaMinor, true))}<span class="cell-sub">${f.deltaMinor === null ? 'Not attributed' : 'USD · right − left'}</span></td><td>${certaintyBadge(f.certainty)}</td><td class="action-cell"><button class="row-action" data-action="evidence" data-id="${h(f.id)}" aria-label="View evidence: ${h(f.title)}">Evidence${icon('arrow', 12)}</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><div class="empty-symbol">${icon(c.findings.length ? 'search' : 'check', 22)}</div><h3>${c.findings.length ? 'No findings match this filter' : 'Nothing to reconcile in these snapshots'}</h3><p>${c.findings.length ? 'Try another transaction ID or include every finding type.' : `${c.operations.length} operation groups match. Coverage is still defined by the selected source contract.`}</p>${c.findings.length ? '<button class="btn btn-compact" data-action="clear-finding-filters">Clear filters</button>' : '<button class="btn btn-compact" data-action="tab" data-tab="operations">Inspect matched operations</button>'}</div>`}
  <div class="panel-footer"><span>${icon('shield', 11)}${findings.length} of ${c.findings.length} findings · source evidence attached</span><button class="btn btn-subtle btn-compact" data-action="view-report">View report ${icon('arrow', 11)}</button></div>`;
}
function operationsPanel(c) {
  const rows = c.operations.filter(op => state.operationFilter === 'all' || (state.operationFilter === 'differences' ? op.status !== 'matched' : op.status === 'matched'));
  return `<div class="panel-toolbar"><span class="muted text-helper">One row per operation identity</span><select class="filter-select" id="operation-filter" data-bind="operation-filter" aria-label="Filter operations">${[['all', 'All operations'], ['differences', 'Differences only'], ['matched', 'Matched only']].map(([id, label]) => `<option value="${id}" ${state.operationFilter === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${rows.length ? `<div class="table-scroll"><table class="data-table operations-table"><thead><tr><th>Transaction / operation</th><th class="number-cell">${h(provider(c.left.provider))}</th><th class="number-cell">${h(provider(c.right.provider))}</th><th class="number-cell">Difference</th><th>Result</th></tr></thead><tbody>${rows.map(op => `<tr class="clickable" tabindex="0" data-action="operation-evidence" data-key="${h(op.key)}" aria-label="Inspect ${h(op.transactionId)} ${h(op.type)}"><td><span class="mono" title="${h(op.transactionId)}">${h(shortId(op.transactionId))}</span><span class="cell-sub">${h(op.type)} · ${h(dateTime(op.timestamp))}</span></td><td class="money number-cell">${h(money(op.leftMinor))}</td><td class="money number-cell">${h(money(op.rightMinor))}</td><td class="money number-cell">${h(money(op.deltaMinor, true))}</td><td><span class="badge ${op.status === 'matched' ? 'badge-green' : 'badge-amber'}">${h(op.status)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><div class="empty-symbol">'+icon('check', 20)+'</div><h3>No operations in this filter</h3><p>Choose all operations to inspect the full comparison.</p></div>'}<div class="panel-footer"><span>${rows.length} operation groups · refund amounts are negative</span><span>USD, exact minor units</span></div>`;
}
function sourcePanel(c) { return `<div class="data-source-stack">${[['left', c.left], ['right', c.right]].map(([side, source]) => `<div class="source-card">${providerMark(source.provider)}<div class="source-card-body"><h3>${h(provider(source.provider))} <span class="badge badge-plain">${side === 'left' ? 'Reference' : 'Comparison'}</span></h3><p class="mono">${h(source.filename)}</p><div class="source-tags"><span class="badge ${source.provenance === 'synthetic' ? 'badge-amber' : 'badge-blue'}">${source.provenance === 'synthetic' ? 'Synthetic fixture' : 'User supplied · unverified'}</span><span class="muted source-record-summary">${source.recordCount} records · ${source.rawCount} operations · ${bytes(source.bytes)}</span></div></div><div class="source-card-actions"><button class="btn-icon" title="View source snapshot" aria-label="View ${h(provider(source.provider))} source" data-action="case-source" data-side="${side}">${icon('eye', 15)}</button><button class="btn-icon" title="Download source file" aria-label="Download ${h(provider(source.provider))} source" data-action="download-case-source" data-side="${side}">${icon('export', 14)}</button></div></div>`).join('')}</div><dl class="contract-grid"><div><dt>Money basis</dt><dd>${h(c.contract.money_basis)}</dd></div><div><dt>Coverage</dt><dd>${h(coverageLabels[c.coverage])}; ${c.source === 'synthetic' ? 'closed synthetic fixture' : 'user-declared import scope'}</dd></div><div><dt>Scope</dt><dd>${h(c.contract.store)} / ${h(c.contract.environment)} · USD · UTC</dd></div><div><dt>Demo content fingerprint</dt><dd class="mono">${h(c.fingerprint)} · non-cryptographic</dd></div></dl>`; }
function runsPanel(c) {
  const rows = historyFor(c.id);
  return `<div class="runs-list">${rows.map((run, i) => `<div class="run-row"><span class="run-icon">${icon('clock', 14)}</span><div class="run-details"><strong>Run ${String(rows.length - i).padStart(2, '0')} ${state.activeRunId === run.id ? '<span class="badge badge-green">Viewing</span>' : i === 0 ? '<span class="badge badge-plain">Latest</span>' : ''}</strong><p>${h(dateTime(run.at))} UTC · ${run.snapshot.findings.length} findings · ${h(money(run.snapshot.deltaMinor, true))}</p></div><button class="btn btn-compact" data-action="open-run" data-id="${h(run.id)}">Open snapshot</button><button class="btn-icon" aria-label="Export saved run" data-action="export-run" data-id="${h(run.id)}">${icon('export', 14)}</button></div>`).join('')}</div><div class="panel-footer"><span>${icon('info', 11)}Last ${MAX_HISTORY} runs per case are stored in this browser.</span></div>`;
}
function investigationPanel(c) {
  return `<aside class="investigation-panel" aria-label="AI investigation preview"><div class="investigation-header"><span class="ai-mark">${icon('spark', 14)}</span><h3>Case assistant</h3><span class="badge">Preview</span></div><div class="investigation-body"><div class="ai-eyebrow">${icon('flask', 11)}Demo · no model connected</div>${state.ai ? aiResponse(c) : `<div class="ai-intro"><p>Summarise the findings or inspect their source references.</p></div><div class="prompt-buttons"><button class="prompt-button" data-action="ask-ai" data-mode="explain">Explain this result${icon('arrow', 12)}</button><button class="prompt-button" data-action="ask-ai" data-mode="evidence">Show me the evidence${icon('arrow', 12)}</button><button class="prompt-button" data-action="ask-ai" data-mode="unknown">What remains unknown?${icon('arrow', 12)}</button></div>`}<form class="ai-input-form" id="ai-form"><input id="ai-question-input" name="question" placeholder="Ask about this case…" aria-label="Question for simulated investigation" autocomplete="off"><button type="submit" aria-label="Show demo explanation">${icon('send', 14)}</button></form><div class="ai-footnote">Responses use this case’s computed results. No live model or MCP connection.</div></div></aside>`;
}
function aiResponse(c) {
  const { mode, question } = state.ai;
  const refs = c.findings.map((f, i) => ({ f, label: `F${i + 1}` }));
  let content = '';
  if (mode === 'unknown') content = `<p><strong>The records establish the discrepancy, not its production root cause.</strong></p><p>These ${c.source === 'synthetic' ? 'synthetic fixtures' : 'imported files'} cannot establish whether a live store charged someone twice, why an event was lost, or whether a provider account export is complete.</p><p>Coverage is <strong>${h(coverageLabels[c.coverage].toLowerCase())}</strong>. Fees, tax adjustments and settlement are outside this money basis.</p>${refs.length ? `<p>Start with the recorded observations: ${refs.map(({ f, label }) => `<button class="evidence-cite" data-action="evidence" data-id="${h(f.id)}">${label}</button>`).join('')}</p>` : ''}`;
  else if (mode === 'evidence') content = `<p><strong>${c.findings.length ? `${c.findings.length} findings have explicit source references.` : 'Every operation has a matched counterpart in these snapshots.'}</strong></p>${refs.length ? `<ul>${refs.map(({ f, label }) => `<li>${h(f.title)}: ${f.evidence.length} source ${f.evidence.length === 1 ? 'row' : 'rows'}.<button class="evidence-cite" data-action="evidence" data-id="${h(f.id)}">${label}</button></li>`).join('')}</ul>` : `<p>Open a matched operation to compare the original amounts, transaction identity and effective timestamp.</p><button class="prompt-button" data-action="tab" data-tab="operations">Inspect all operations${icon('arrow', 12)}</button>`}<p>Evidence stays linked to the selected saved run. The expected-results oracle is never read by this application.</p>`;
  else {
    content = `<p>The net difference is <strong>${h(money(c.deltaMinor, true))}</strong>. ${c.counts.issues ? `<strong>${c.counts.issues} operation-level ${c.counts.issues === 1 ? 'discrepancy remains' : 'discrepancies remain'}.</strong>` : c.counts.inconclusive ? 'The comparison has unresolved coverage or identity limitations.' : 'No economic amount discrepancy remains after delivery deduplication.'}</p>`;
    if (refs.length) content += `<ul>${refs.map(({ f, label }) => `<li>${h(f.title)}${f.deltaMinor === null ? '' : ` (${h(money(f.deltaMinor, true))})`}.<button class="evidence-cite" data-action="evidence" data-id="${h(f.id)}">${label}</button></li>`).join('')}</ul>`;
    if (c.counts.issues > 1 && c.deltaMinor === '0') content += '<p><strong>The impacts cancel in the total.</strong> Comparing the operation identities exposes both differences.</p>';
    if (c.findings.some(f => f.kind === 'economic_duplicate')) content += '<p>Repeated analytics events do not prove a second store charge. Producer instrumentation is one possible explanation.</p>';
    if (c.findings.some(f => f.kind === 'amount_mismatch')) content += '<p>The amount mismatch is observable. A unit-conversion mistake remains a candidate explanation.</p>';
    if (c.findings.some(f => f.kind === 'repeated_delivery')) content += `<p>${c.right.rawCount} downstream observations become ${c.right.dedupCount} operations after exact delivery-key deduplication.</p>`;
    if (!refs.length) content += `<p>All ${c.operations.length} operation groups match within the declared fixture scope. This does not certify a live provider account.</p>`;
  }
  return `<div class="ai-question">${h(question)}</div><div class="ai-response">${content}</div><details class="tool-trace"><summary>${icon('code', 12)}Simulated tool trace · 5 steps</summary><div class="trace-list">${[['list_cases', `${allCases().length} cases`], ['get_case', caseCode(c.id)], ['run_reconciliation', 'Current result'], ['list_findings', `${c.findings.length} findings`], ['get_evidence', 'Source rows']].map(([tool, result]) => `<div class="trace-item"><span class="status-dot"></span><code>${tool}</code><span>${h(result)}</span></div>`).join('')}</div></details><button class="ai-reset" data-action="ai-reset">${icon('retry', 11)}Ask another question</button>`;
}
function casesPage() {
  const cases = allCases(); const q = state.caseSearch.trim().toLowerCase();
  const filtered = cases.filter(c => (state.caseFilter === 'all' || c.verdict === state.caseFilter) && (!q || `${c.title} ${c.description} ${caseCode(c.id)}`.toLowerCase().includes(q)));
  return `${pageHeading('Cases', 'Compare source snapshots and review discrepancies.')}${workspaceStart('Cases')}<div class="overview-strip"><div class="overview-stat"><strong>${cases.length}</strong><span class="stat-label">Total cases</span><span class="stat-icon">${icon('cases', 25)}</span></div><div class="overview-stat"><strong>${cases.filter(c => c.verdict === 'issues').length}</strong><span class="stat-label">Needs review</span><span class="stat-icon">${icon('alert', 25)}</span></div><div class="overview-stat"><strong>${cases.filter(c => c.verdict === 'matched').length}</strong><span class="stat-label">Matched</span><span class="stat-icon">${icon('shield', 25)}</span></div></div><section class="list-panel"><div class="panel-toolbar"><label class="search-field">${icon('search', 13)}<input id="case-search" data-bind="case-search" value="${h(state.caseSearch)}" placeholder="Search cases" aria-label="Search cases"></label><select class="filter-select" id="case-filter" data-bind="case-filter" aria-label="Filter case outcome">${[['all', 'All outcomes'], ['issues', 'Needs review'], ['matched', 'Matched'], ['inconclusive', 'Inconclusive']].map(([id, label]) => `<option value="${id}" ${state.caseFilter === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${filtered.length ? `<div class="table-scroll"><table class="data-table case-list-table"><thead><tr><th>Case</th><th>Sources</th><th>Outcome</th><th>Difference</th><th>Review</th><th></th></tr></thead><tbody>${filtered.map(c => `<tr class="clickable" tabindex="0" data-action="open-case" data-id="${h(c.id)}" aria-label="Open case ${h(c.title)}"><td><span class="case-code mono">${h(caseCode(c.id))}</span><span class="case-title">${h(c.title)}</span><span class="case-description">${c.source === 'synthetic' ? 'Synthetic fixture' : 'User-supplied snapshot'} · ${c.findings.length} ${c.findings.length === 1 ? 'finding' : 'findings'}</span></td><td><span class="comparison-type">${h(provider(c.left.provider))} ${icon('arrow', 10)} ${h(provider(c.right.provider))}</span></td><td>${badgeOutcome(c)}</td><td class="money">${h(money(c.deltaMinor, true))}</td><td><span class="badge badge-plain">${h(reviewLabels[state.reviews[c.id] || 'open'])}</span></td><td class="action-cell"><span class="row-action">Open${icon('chevron', 12)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><div class="empty-symbol">'+icon('search', 20)+'</div><h3>No cases match your search</h3><p>Try a broader search or another outcome filter.</p><button class="btn btn-compact" data-action="clear-case-filters">Clear filters</button></div>'}<div class="panel-footer"><span>${filtered.length} of ${cases.length} cases</span><span>${icon('flask', 11)}No live account data</span></div></section>${workspaceEnd()}`;
}
function inventory() {
  const result = [], seen = new Set();
  for (const c of [...allCases(), ...(state.storeCase ? [state.storeCase] : [])]) for (const source of [c.left, c.right]) { const key = `${source.provider}|${source.filename}|${source.rawText}`; if (!seen.has(key)) { seen.add(key); result.push(source); } }
  return result;
}
function sourcesPage() { const rows = inventory(); return `${pageHeading('Sources', 'View and download the files used in your comparisons.')}${workspaceStart('Sources')}<div class="source-intro-note">${icon('info', 16)}<div>Bundled files are schema-based synthetic fixtures. Google Play has 8 order objects that yield 9 financial operations. An uploaded file is labelled user supplied; its real-world coverage is not inferred.</div></div><div class="source-inventory">${rows.map((source, i) => `<article class="inventory-card"><div class="inventory-heading">${providerMark(source.provider)}<strong>${h(provider(source.provider))}</strong><span class="badge ${source.provenance === 'synthetic' ? 'badge-amber' : 'badge-blue'}">${source.provenance === 'synthetic' ? 'Synthetic fixture' : 'User supplied'}</span></div><div class="inventory-file" title="${h(source.filename)}">${h(source.filename)}</div><div class="inventory-metrics"><div><strong>${source.recordCount}</strong><span>Source records</span></div><div><strong>${source.rawCount}</strong><span>Cash operations</span></div><div><strong>${bytes(source.bytes)}</strong><span>File size</span></div></div><div class="inventory-actions"><button class="btn btn-compact" data-action="inventory-source" data-index="${i}">${icon('eye', 13)}View snapshot</button><button class="btn btn-subtle btn-compact" data-action="download-inventory-source" data-index="${i}">${icon('export', 13)}Download</button></div></article>`).join('')}</div>${workspaceEnd()}`; }
function methodPage() {
  return `${pageHeading('Method & scope', 'Comparison rules, supported inputs and prototype limits.')}${workspaceStart('Method & scope')}<div class="method-layout"><section class="method-card"><h2>The comparison contract</h2><p>Every result is constrained by the source files and the scope selected for that case.</p>${[
      ['Align the scope', 'The prototype accepts one Google Play app namespace, one environment, UTC timestamps and USD. Charges less refunds are compared before fees and tax adjustments.'],
      ['Normalise explicit fields', 'Small format-specific readers map Google order events, Adapty cash events and Mixpanel exports into the same financial operation. A refund is a separate negative operation.'],
      ['Separate delivery from economics', 'The same delivery identity and payload are counted once. Different event identities describing one charge remain visible as multiple economic observations.'],
      ['Match operation identity', 'Store, environment, transaction ID and operation type establish the group. Matching totals alone never establish that the underlying operations match.'],
      ['Keep the evidence and uncertainty', 'Each finding references original source records. Unknown or partial coverage prevents an unmatched record from becoming a definitive missing-provider-operation claim.'],
    ].map(([title, text], i) => `<div class="method-step"><span class="step-number">${i + 1}</span><div><h3>${title}</h3><p>${text}</p></div></div>`).join('')}<div class="formula"><code>difference = right source − left source</code></div></section><div class="method-side"><section class="method-card"><h2>What works in this prototype</h2><ul><li>Six fixture scenarios and a Google Play → Adapty reference check.</li><li>Real parsing, exact minor-unit arithmetic, matching and evidence inspection in the browser.</li><li>Local JSON / JSONL imports, review states, saved run snapshots and JSON exports.</li><li>A clearly labelled, deterministic preview of the AI investigation flow.</li></ul><button class="btn btn-primary" data-action="store-case">${icon('shield', 14)}Run the store reference check</button></section><section class="method-card"><h2>The planned monolith</h2><p>One Node/TypeScript application will serve the UI, REST endpoints, comparison core, persistent cases and our own MCP tools. The UI and MCP will use the same operations.</p><div class="warning-callout">The hosted prototype has no server-side reconciliation backend, live provider credentials, connected model or MCP transport. Other products’ MCP servers are not required.</div><p class="method-note">The browser fingerprint is a demonstration identifier. Cryptographic content digests and durable server storage belong to the proposed product.</p></section><section class="method-card"><h2>Browser-local state</h2><p>Review statuses, imported cases and the latest ${MAX_HISTORY} run snapshots per case are retained in this browser when storage is available. Export a report to keep a portable copy.</p><button class="btn btn-compact btn-danger" data-action="request-reset">Reset this browser demo</button></section></div></div>${workspaceEnd()}`;
}
function renderOverlay() {
  if (state.drawer) { overlayRoot.innerHTML = evidenceDrawer(); return; }
  if (!state.modal) { overlayRoot.innerHTML = ''; document.body.style.overflow = ''; return; }
  document.body.style.overflow = 'hidden';
  overlayRoot.innerHTML = state.modal === 'import' ? importModal() : state.modal === 'source' ? sourceModal() : state.modal === 'report' ? reportModal() : resetModal();
}
function evidenceDrawer() {
  document.body.style.overflow = 'hidden';
  const c = state.current, f = state.drawer; const evidence = f.evidence || [];
  return `<div class="overlay-backdrop" data-action="close-overlay"></div><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title"><div class="drawer-header"><div class="drawer-title-row"><div><div class="kicker">EVIDENCE / ${h(caseCode(c.id))}</div><h2 id="evidence-title">${h(f.title)}</h2></div><button class="btn-icon" data-action="close-overlay" aria-label="Close evidence" id="overlay-close">${icon('close', 20)}</button></div><p>${h(f.description || 'Inspect the source observations for this operation identity.')}</p><div class="drawer-labels">${certaintyBadge(f.certainty || 'proven')}<span class="badge badge-plain">${h(coverageLabels[c.coverage])}</span><span class="badge badge-amber">${c.source === 'synthetic' ? 'Synthetic evidence' : 'Imported evidence'}</span></div></div><div class="drawer-content"><dl class="evidence-summary"><div class="evidence-summary-item"><dt>Transaction identity</dt><dd class="mono">${h(f.transactionId || 'Comparison-wide coverage')}</dd></div><div class="evidence-summary-item"><dt>Observed impact · right − left</dt><dd class="money">${h(money(f.deltaMinor, true))}${f.deltaMinor === null ? ' · not attributed' : ' USD'}</dd></div></dl><div class="evidence-columns">${[['left', c.left], ['right', c.right]].map(([side, source]) => { const rows = evidence.filter(e => e.side === side); return `<section><div class="evidence-column-title">${providerMark(source.provider)}${h(provider(source.provider))}<span class="badge badge-plain">${side === 'left' ? 'Reference' : 'Comparison'}</span></div>${rows.length ? rows.map((row, i) => `<article class="evidence-card"><div class="evidence-card-head"><strong>${h(row.id)}</strong><button class="btn-icon" data-action="copy-evidence" data-index="${evidence.indexOf(row)}" aria-label="Copy raw evidence record">${icon('copy', 13)}</button></div><div class="evidence-locator">${h(source.filename)} · ${h(row.locator)}<br>${h(row.timestamp)} · ${h(money(row.amountMinor))}</div><pre class="raw-code">${h(pretty(row.raw))}</pre></article>`).join('') : `<div class="evidence-absent">${icon('search', 24)}<strong>${f.kind === 'coverage_gap' ? 'No individual row establishes coverage' : ['missing_operation', 'extra_operation'].includes(f.kind) ? 'No counterpart in these records' : 'No row attached to this finding'}</strong><p>${c.coverage === 'declared_complete' ? 'This statement applies to the explicitly declared comparison scope.' : 'The import does not establish complete provider coverage.'}</p></div>`}</section>`; }).join('')}</div></div><div class="drawer-footer"><p>Evidence is tied to this saved run.<br><span class="mono">${h(c.fingerprint)}</span> · demo fingerprint</p><button class="btn" data-action="download-evidence">${icon('export', 14)}Export evidence</button></div></section>`;
}
function wizardSteps(step) { return `<div class="wizard-steps">${['Choose data', 'Define scope', 'Compare'].map((label, i) => `<div class="wizard-step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}"><span>${step > i + 1 ? icon('check', 11) : i + 1}</span>${label}</div>`).join('')}</div>`; }
function importModal() {
  const im = state.import;
  let body;
  if (im.step === 1) body = `<div class="mode-options"><button class="mode-card ${im.mode === 'bundle' ? 'selected' : ''}" data-action="import-mode" data-mode="bundle">${icon('flask', 20)}<span><strong>Use demo data</strong><small>Choose a prepared scenario with a bounded synthetic scope.</small></span></button><button class="mode-card ${im.mode === 'upload' ? 'selected' : ''}" data-action="import-mode" data-mode="upload">${icon('upload', 20)}<span><strong>Import a source</strong><small>Compare a JSON / JSONL file against a bundled reference.</small></span></button></div>${im.mode === 'bundle' ? `<label class="field"><span class="field-label">Comparison lane</span><select id="import-lane" data-bind="import-lane"><option value="analytics" ${im.lane === 'analytics' ? 'selected' : ''}>Adapty → Mixpanel</option><option value="store" ${im.lane === 'store' ? 'selected' : ''}>Google Play → Adapty</option></select></label>${im.lane === 'analytics' ? `<label class="field"><span class="field-label">Scenario</span><select id="import-scenario" data-bind="import-scenario">${SCENARIOS.map(s => `<option value="${h(s.id)}" ${s.id === im.scenario ? 'selected' : ''}>${h(s.title)}</option>`).join('')}</select><small class="field-note">${h(SCENARIOS.find(s => s.id === im.scenario)?.description)}</small></label>` : '<div class="scope-box">Eight Google order objects yield eight charges and one refund. The reference check compares these operations with the Adapty projection.</div>'}` : `<label class="field"><span class="field-label">File format</span><select id="import-provider" data-bind="import-provider">${[['mixpanel', 'Mixpanel export · JSONL'], ['adapty', 'Adapty cash-event projection · JSONL'], ['google_play', 'Google Play Orders · JSON']].map(([id, label]) => `<option value="${id}" ${id === im.provider ? 'selected' : ''}>${label}</option>`).join('')}</select><small class="field-note">${im.provider === 'adapty' ? 'Reference: bundled Google Play operations.' : 'Reference: bundled Adapty cash-event projection.'} USD and the documented fixture field contract are required.</small></label><input class="visually-hidden" type="file" id="import-file" accept=".json,.jsonl,.ndjson,application/json,text/plain"><div class="drop-zone" id="drop-zone">${icon('upload', 24)}<strong>Drop your file here</strong><small>JSON / JSONL · up to 10 MiB · 5,000 records</small><button class="btn btn-compact" data-action="browse-file">Choose file</button></div>${im.parsed ? `<div class="file-summary">${icon('file', 21)}<div class="file-info"><strong>${h(im.parsed.filename)}</strong><small>${im.parsed.recordCount} records · ${im.parsed.rawCount} financial operations · ${bytes(im.parsed.bytes)}</small></div><span class="badge badge-green">Parsed</span></div>` : ''}`}`;
  else if (im.step === 2) body = `<label class="field"><span class="field-label">Case name</span><input id="import-name" data-bind="import-name" value="${h(im.name)}" maxlength="110" placeholder="Name this comparison"></label><div class="field-grid"><label class="field"><span class="field-label">Currency</span><input value="USD" readonly aria-label="Currency USD"></label><label class="field"><span class="field-label">Timezone</span><input value="UTC" readonly aria-label="Timezone UTC"></label></div><label class="field"><span class="field-label">Money basis</span><input value="Reported USD charges less refunds; no fee/tax adjustments" readonly aria-label="Money basis"></label><label class="field"><span class="field-label">Coverage of the selected comparison scope</span><select id="import-coverage" data-bind="import-coverage">${Object.entries(coverageLabels).map(([id, label]) => `<option value="${id}" ${im.coverage === id ? 'selected' : ''}>${label}</option>`).join('')}</select><small class="field-note">${im.coverage === 'declared_complete' ? 'An explicit completeness declaration for this exact input scope. It does not certify a provider account.' : 'Unmatched records will remain inconclusive when a complete export cannot be established.'}</small></label><div class="scope-box">${im.mode === 'bundle' ? 'Both inputs are labelled synthetic. The organisers’ seed data and documented formats define the fixture; no live response is being claimed.' : 'The uploaded source is labelled user supplied. Its identity and real-world coverage are unverified. Nothing is uploaded to a reconciliation server.'}</div>`;
  else { const c = im.preview; body = `<div class="preview-comparison"><div class="preview-source">${providerMark(c.left.provider)}<strong>${h(provider(c.left.provider))}</strong><span class="money">${h(money(c.left.totalMinor))}</span><small>${c.left.rawCount} → ${c.left.dedupCount} operations</small></div>${icon('arrow', 18)}<div class="preview-source">${providerMark(c.right.provider)}<strong>${h(provider(c.right.provider))}</strong><span class="money">${h(money(c.right.totalMinor))}</span><small>${c.right.rawCount} → ${c.right.dedupCount} operations</small></div></div><div class="preview-result"><span>${h(im.name)}</span>${badgeOutcome(c)}</div><div class="preview-result"><span>${c.findings.length} findings · ${h(coverageLabels[c.coverage])}</span><strong class="money">${h(money(c.deltaMinor, true))}</strong></div><div class="scope-box">The comparison above was computed from the selected inputs. Creating the case saves this snapshot, its evidence and the selected scope in this browser.</div>`; }
  return `<div class="overlay-backdrop" data-action="close-overlay"></div><div class="modal-wrap"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><div class="modal-header"><div><h2 id="import-title">New comparison</h2><p>Choose source data, set the scope and compare.</p></div><button class="btn-icon" id="overlay-close" data-action="close-overlay" aria-label="Close new comparison">${icon('close', 18)}</button></div><div class="modal-body">${wizardSteps(im.step)}${body}${im.error ? `<div class="import-error" role="alert">${h(im.error)}</div>` : ''}</div><div class="modal-footer"><small>${icon('shield', 10)}Files stay in this browser.</small><div class="footer-actions">${im.step > 1 ? '<button class="btn" data-action="import-back">Back</button>' : '<button class="btn" data-action="close-overlay">Cancel</button>'}<button class="btn btn-primary" data-action="import-next" ${im.working || (im.step === 1 && im.mode === 'upload' && !im.parsed) ? 'disabled' : ''}>${im.working ? 'Comparing…' : im.step === 3 ? 'Create case' : 'Continue'}${icon(im.step === 3 ? 'check' : 'arrow', 13)}</button></div></div></section></div>`;
}
function sourceModal() { const source = state.modalData; return `<div class="overlay-backdrop" data-action="close-overlay"></div><div class="modal-wrap"><section class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="source-modal-title"><div class="modal-header"><div><h2 id="source-modal-title">${h(provider(source.provider))} source snapshot</h2><p class="mono">${h(source.filename)}</p></div><button class="btn-icon" id="overlay-close" data-action="close-overlay" aria-label="Close source snapshot">${icon('close', 18)}</button></div><div class="modal-body"><div class="source-detail-meta"><span>${source.recordCount} source records</span><span>${source.rawCount} financial operations</span><span>${bytes(source.bytes)}</span><span>${source.provenance === 'synthetic' ? 'Synthetic fixture' : 'User supplied · unverified'}</span></div><p class="report-notice">The first three source objects are shown below. Download the source to inspect the entire original file.</p><pre class="raw-code report-code">${h(JSON.stringify(source.records.slice(0, 3), null, 2))}</pre>${source.warnings?.length ? `<div class="warning-callout">${source.warnings.map(w => h(w)).join('<br>')}</div>` : ''}</div><div class="modal-footer"><small>The source payload is read-only.</small><button class="btn btn-primary" data-action="download-modal-source">${icon('export', 14)}Download complete source</button></div></section></div>`; }
function makeReport(c) { return { ...exportReport(c), case_title: c.title, current_review: { status: state.reviews[c.id] || 'open', scope: 'Human review state in this browser; independent of computed outcome' }, run_snapshot_at: c.computed_at }; }
function reportModal() { const c = state.current; return `<div class="overlay-backdrop" data-action="close-overlay"></div><div class="modal-wrap"><section class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="report-title"><div class="modal-header"><div><h2 id="report-title">Case report</h2><p>${h(caseCode(c.id))} · ${h(c.title)}</p></div><button class="btn-icon" id="overlay-close" data-action="close-overlay" aria-label="Close report">${icon('close', 18)}</button></div><div class="modal-body"><p class="report-notice">A portable JSON report containing the input snapshots, contract, findings, operations and raw evidence. Provenance and prototype limitations travel with the report.</p><pre class="raw-code report-code">${h(JSON.stringify(makeReport(c), null, 2))}</pre></div><div class="modal-footer"><small>Financial values use integer minor-unit strings.</small><button class="btn btn-primary" data-action="export-current">${icon('export', 14)}Download JSON report</button></div></section></div>`; }
function resetModal() { return `<div class="overlay-backdrop" data-action="close-overlay"></div><div class="modal-wrap"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title"><div class="modal-header"><div><h2 id="reset-title">Reset this browser demo?</h2><p>Bundled scenarios remain available.</p></div><button class="btn-icon" id="overlay-close" data-action="close-overlay" aria-label="Cancel reset">${icon('close', 18)}</button></div><div class="modal-body"><p class="report-notice">This removes locally imported cases, human review statuses and run history from this browser. Download any reports you want to keep first.</p></div><div class="modal-footer"><button class="btn" data-action="close-overlay">Cancel</button><button class="btn btn-danger" data-action="confirm-reset">Reset browser state</button></div></section></div>`; }
function openOverlay(type, value) { state.drawer = null; state.modal = type; state.modalData = value; renderOverlay(); setTimeout(() => document.getElementById('overlay-close')?.focus(), 0); }
function closeOverlay() { state.drawer = null; state.modal = null; state.modalData = null; state.import = null; renderOverlay(); }
function openEvidence(finding) { if (!finding) return; state.modal = null; state.drawer = finding; renderOverlay(); setTimeout(() => document.getElementById('overlay-close')?.focus(), 0); }
function newCase() { state.import = { step: 1, mode: state.page === 'sources' ? 'upload' : 'bundle', lane: 'analytics', scenario: 'zero_net_two_errors', provider: 'mixpanel', coverage: state.page === 'sources' ? 'unknown' : 'declared_complete', parsed: null, name: '', error: null, working: false }; openOverlay('import'); }
function download(content, filename, mime = 'application/json') { const url = URL.createObjectURL(new Blob([content], { type: mime })); const a = document.createElement('a'); a.href = url; a.download = filename.replace(/[\\/:*?"<>|]/g, '-'); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function downloadReport(c) { download(JSON.stringify(makeReport(c), null, 2), `${caseCode(c.id).toLowerCase()}-report.json`); notify('Report exported with source snapshots and evidence.'); }
function downloadSource(source) { download(source.rawText, source.filename || `${source.provider}.json`, source.filename?.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json'); notify('Complete source snapshot downloaded.'); }
async function runCurrent() {
  if (state.running) return; state.running = true; render();
  await new Promise(resolve => requestAnimationFrame(resolve));
  try { const old = state.current; const result = { ...reconcile(old.left, old.right, { coverage: old.coverage, label: old.title }), id: old.id, title: old.title, description: old.description }; const row = recordRun(result); state.current = result; state.activeRunId = row.id; state.ai = null;
    const bundleIndex = state.cases.findIndex(c => c.id === result.id); if (bundleIndex >= 0) state.cases[bundleIndex] = result;
    const customIndex = state.customCases.findIndex(c => c.id === result.id); if (customIndex >= 0) state.customCases[customIndex] = result;
    if (state.storeCase?.id === result.id) state.storeCase = result;
    persist(); notify(`Comparison complete. ${result.findings.length} ${result.findings.length === 1 ? 'finding' : 'findings'} saved in a new run.`);
  } catch (error) { notify(error.message, true); } finally { state.running = false; render(); }
}
async function acceptFile(file) {
  if (!file || !state.import) return;
  const im = state.import; im.error = null; im.parsed = null; im.working = true; renderOverlay();
  try { if (file.size > 10 * 1024 * 1024) throw new Error('Choose a file no larger than 10 MiB.'); const text = await file.text(); const parsed = parseSource(text, im.provider); parsed.filename = file.name; parsed.provenance = 'user_supplied'; im.parsed = parsed; im.coverage = 'unknown'; }
  catch (error) { im.error = error.message; }
  finally { im.working = false; if (state.import === im) renderOverlay(); }
}
async function importNext() {
  const im = state.import; if (!im || im.working) return;
  im.error = null;
  if (im.step === 1) { if (im.mode === 'upload' && !im.parsed) return; im.name ||= im.mode === 'bundle' ? im.lane === 'store' ? 'Google Play → Adapty reference check' : SCENARIOS.find(s => s.id === im.scenario).title : `${provider(im.provider)} import comparison`; im.step = 2; renderOverlay(); return; }
  if (im.step === 2) {
    if (!im.name.trim()) { im.error = 'Give this comparison a name.'; renderOverlay(); return; }
    im.working = true; renderOverlay();
    try { let preview;
      if (im.mode === 'bundle') preview = im.lane === 'store' ? await loadStoreCase({ coverage: im.coverage }) : await loadCase(im.scenario, { coverage: im.coverage });
      else { const base = im.provider === 'adapty' ? state.storeCase : state.cases.find(c => c.id === 'clean'); preview = reconcile(base.left, im.parsed, { coverage: im.coverage, label: im.name.trim() }); }
      im.preview = { ...preview, id: `import-${Date.now().toString(36)}`, title: im.name.trim(), description: im.mode === 'bundle' ? 'A saved comparison built from the selected synthetic scenario.' : 'A user-supplied source compared with a bundled reference snapshot.' }; im.step = 3;
    } catch (error) { im.error = error.message; }
    finally { im.working = false; if (state.import === im) renderOverlay(); }
    return;
  }
  const c = clone(im.preview); state.customCases.push(c); recordRun(c); closeOverlay(); persist(); openCase(c.id); notify('Case created. Inputs, scope and computed result saved locally.');
}
function askAI(mode, customQuestion) { const prompts = { explain: 'Explain this result', evidence: 'Show me the evidence', unknown: 'What remains unknown?' }; state.ai = { mode, question: customQuestion || prompts[mode] }; render(); }

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  if (button.matches('button:disabled')) return;
  const action = button.dataset.action; event.preventDefault();
  if (action === 'navigate') { state.page = button.dataset.page; state.navOpen = false; render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
  else if (action === 'nav-toggle') { state.navOpen = !state.navOpen; render(); }
  else if (action === 'nav-close') { state.navOpen = false; render(); }
  else if (action === 'new-case') newCase();
  else if (action === 'open-case') openCase(button.dataset.id);
  else if (action === 'store-case') { if (state.storeCase) openCase(state.storeCase.id); }
  else if (action === 'tab') { state.tab = button.dataset.tab; render(); }
  else if (action === 'run') await runCurrent();
  else if (action === 'export-current') downloadReport(state.current);
  else if (action === 'view-report') openOverlay('report');
  else if (action === 'clear-finding-filters') { state.findingSearch = ''; state.findingFilter = 'all'; render(); }
  else if (action === 'clear-case-filters') { state.caseSearch = ''; state.caseFilter = 'all'; render(); }
  else if (action === 'evidence') openEvidence(state.current.findings.find(f => f.id === button.dataset.id));
  else if (action === 'operation-evidence') { const op = state.current.operations.find(o => o.key === button.dataset.key); if (op) openEvidence({ title: `${op.type === 'refund' ? 'Refund' : 'Charge'} · ${op.status}`, description: 'The operation is grouped by store, environment, transaction identity and type. Source evidence is shown without modifying the payloads.', transactionId: op.transactionId, deltaMinor: op.deltaMinor, certainty: op.status === 'matched' ? 'proven' : state.current.findings.some(f => f.transactionId === op.transactionId && f.certainty === 'inconclusive') ? 'inconclusive' : 'proven', evidence: [...op.leftEvidence, ...op.rightEvidence] }); }
  else if (action === 'close-overlay') closeOverlay();
  else if (action === 'ask-ai') askAI(button.dataset.mode);
  else if (action === 'ai-reset') { state.ai = null; render(); }
  else if (action === 'case-source') openOverlay('source', state.current[button.dataset.side]);
  else if (action === 'inventory-source') openOverlay('source', inventory()[Number(button.dataset.index)]);
  else if (action === 'download-case-source') downloadSource(state.current[button.dataset.side]);
  else if (action === 'download-inventory-source') downloadSource(inventory()[Number(button.dataset.index)]);
  else if (action === 'download-modal-source') downloadSource(state.modalData);
  else if (action === 'copy-evidence') { const raw = state.drawer.evidence[Number(button.dataset.index)]?.raw; try { await navigator.clipboard.writeText(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)); notify('Raw evidence copied.'); } catch { notify('Clipboard is unavailable. Use Export evidence instead.', true); } }
  else if (action === 'download-evidence') { download(JSON.stringify({ case_id: state.current.id, run_fingerprint: state.current.fingerprint, provenance: state.current.source, finding: state.drawer }, null, 2), `${caseCode(state.current.id).toLowerCase()}-evidence.json`); notify('Evidence exported.'); }
  else if (action === 'open-run') { const run = historyFor(state.current.id).find(r => r.id === button.dataset.id); if (run) { state.current = clone(run.snapshot); state.activeRunId = run.id; state.ai = null; state.tab = 'findings'; render(); notify('Opened the saved run snapshot.'); } }
  else if (action === 'export-run') { const run = historyFor(state.current.id).find(r => r.id === button.dataset.id); if (run) downloadReport(run.snapshot); }
  else if (action === 'import-mode') { state.import.mode = button.dataset.mode; state.import.coverage = state.import.mode === 'upload' ? 'unknown' : 'declared_complete'; state.import.error = null; state.import.name = ''; renderOverlay(); }
  else if (action === 'browse-file') document.getElementById('import-file')?.click();
  else if (action === 'import-back') { state.import.step = Math.max(1, state.import.step - 1); state.import.error = null; renderOverlay(); }
  else if (action === 'import-next') await importNext();
  else if (action === 'request-reset') openOverlay('reset');
  else if (action === 'confirm-reset') { try { localStorage.removeItem(STORAGE_KEY); } catch {} state.customCases = []; state.reviews = {}; state.history = {}; for (const c of [...state.cases, state.storeCase]) recordRun(c); closeOverlay(); openCase('zero_net_two_errors'); notify('Browser demo reset. Bundled source files are unchanged.'); }
});
document.addEventListener('input', event => {
  const el = event.target; const binding = el.dataset.bind;
  if (binding === 'finding-search') { state.findingSearch = el.value; render(); }
  else if (binding === 'case-search') { state.caseSearch = el.value; render(); }
  else if (binding === 'import-name') state.import.name = el.value;
});
document.addEventListener('change', async event => {
  const el = event.target; const binding = el.dataset.bind;
  if (binding === 'review') { state.reviews[state.current.id] = el.value; persist(); notify(`Human review marked ${reviewLabels[el.value].toLowerCase()}. Computed findings are unchanged.`); }
  else if (binding === 'finding-filter') { state.findingFilter = el.value; render(); }
  else if (binding === 'case-filter') { state.caseFilter = el.value; render(); }
  else if (binding === 'operation-filter') { state.operationFilter = el.value; render(); }
  else if (binding === 'import-lane') { state.import.lane = el.value; state.import.name = ''; renderOverlay(); }
  else if (binding === 'import-scenario') { state.import.scenario = el.value; state.import.name = ''; renderOverlay(); }
  else if (binding === 'import-provider') { state.import.provider = el.value; state.import.parsed = null; state.import.error = null; renderOverlay(); }
  else if (binding === 'import-coverage') { state.import.coverage = el.value; renderOverlay(); }
  else if (el.id === 'import-file') await acceptFile(el.files?.[0]);
});
document.addEventListener('submit', event => { if (event.target.id !== 'ai-form') return; event.preventDefault(); const input = document.getElementById('ai-question-input'), question = input.value.trim(); if (!question) return; const mode = /unknown|cause|why.*lost|complete|coverage|limitation/i.test(question) ? 'unknown' : /evidence|source|row|show|record/i.test(question) ? 'evidence' : 'explain'; askAI(mode, question); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (state.drawer || state.modal) closeOverlay(); else if (state.navOpen) { state.navOpen = false; render(); } }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-action]')) { event.preventDefault(); event.target.click(); }
  if (event.key === 'Tab' && (state.drawer || state.modal)) { const dialog = overlayRoot.querySelector('[role="dialog"]'); const items = [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([type="file"]), select, textarea, summary, [tabindex="0"]')].filter(el => el.offsetParent !== null); if (!items.length) return; const first = items[0], last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
});
document.addEventListener('dragover', event => { const zone = event.target.closest('#drop-zone'); if (zone) { event.preventDefault(); zone.classList.add('drag-over'); } });
document.addEventListener('dragleave', event => { const zone = event.target.closest('#drop-zone'); if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('drag-over'); });
document.addEventListener('drop', async event => { const zone = event.target.closest('#drop-zone'); if (zone) { event.preventDefault(); await acceptFile(event.dataTransfer?.files?.[0]); } });

async function initialise() {
  try {
    const [cases, store] = await Promise.all([Promise.all(SCENARIOS.map(s => loadCase(s.id))), loadStoreCase()]);
    state.cases = cases; state.storeCase = store;
    for (const c of [...cases, store, ...state.customCases]) recordRun(c, true);
    const selected = findCase(saved.selectedCaseId) || findCase('zero_net_two_errors');
    const last = historyFor(selected.id)[0];
    state.current = clone(last?.snapshot?.fingerprint === selected.fingerprint ? last.snapshot : selected);
    state.activeRunId = last?.id || null;
    state.page = 'cases';
    persist(); render();
  } catch (error) {
    root.innerHTML = `<main class="fatal-state"><div class="brand-mark">${icon('logo', 22)}</div><h1 style="margin-top:20px">The source files could not be loaded.</h1><p>The comparison workspace needs the bundled fixture files before it can compute results.</p><pre>${h(error.message)}</pre><button class="btn btn-primary" id="retry-start">${icon('retry', 14)}Try again</button></main>`;
    document.getElementById('retry-start')?.addEventListener('click', () => window.location.reload());
  }
}
initialise();
