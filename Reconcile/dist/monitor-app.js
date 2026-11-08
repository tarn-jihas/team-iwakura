import { renderMonitor } from './monitor-view.js';

const root = document.querySelector('#app');
const liveRegion = document.createElement('div');
liveRegion.className = 'visually-hidden'; liveRegion.setAttribute('role','status'); liveRegion.setAttribute('aria-live','polite'); document.body.append(liveRegion);
let data = null, pollError = '', actionError = '', pending = false, accepted = false, acceptedAction = '', statusMessage = '', lastSummary = null, timer = null, demoTimer = null, controller = null, alive = true, demoTraffic = true, actionFocus = null, filterStatus = 'all', cursor = 0, page = 0, cursorHistory = [0], fulfillments = [], traces = {}, rangeEdited = false, range = {from:'',to:''};
const path = '/api/recovery/monitor';
const focusKey = element => element?.tagName === 'BUTTON' && element.closest?.('[data-form="filters"]') ? {filterSubmit:true} : element?.dataset?.action ? {action:element.dataset.action,id:element.dataset.id} : element?.name ? {name:element.name,form:element.closest?.('form')?.dataset?.form} : element?.closest?.('.trace-account') ? {trace:detailsKey(element.closest('.trace-account'))} : element?.closest?.('.incident') ? {incident:element.closest('.incident').dataset.incident} : element?.closest?.('.integration') ? {integration:element.closest('.activity-feed') ? 'observations' : 'integration'} : null;
const detailsKey = el => el.dataset.evidence ?? el.dataset.incident ?? (el.classList?.contains('trace-account') ? `trace:${el.closest('.incident')?.dataset.incident}:${el.querySelector('summary')?.textContent}` : el.closest('.activity-feed') ? 'observations' : 'integration');
function readRange() { for (const input of root.querySelectorAll('input[name]')) range[input.name] = input.value; }
function defaultRange() { return {from:new Date(Date.now()-86400000).toISOString().slice(0,19),to:new Date(Date.now()+1000).toISOString().slice(0,19)}; }

function render() {
  if (document.activeElement?.matches?.('[data-form="export"] input') && !pending) return;
  const open = new Set([...root.querySelectorAll('details[open]')].map(detailsKey));
  const active = focusKey(document.activeElement) || actionFocus;
  if (rangeEdited) readRange(); else range = defaultRange();
  const requestMessage = pending && data?.mode === 'FULL_MOCK' ? 'Starting a run · a customer is about to be denied at the Lumen gate…' : pending ? 'Request pending · waiting for the monitor response.' : accepted ? acceptedAction === 'stop' ? 'Stop accepted · waiting for the monitor to confirm.' : 'Request accepted · waiting for the monitor to confirm.' : '';
  root.innerHTML = renderMonitor(data, {pollError, actionError, pending, requestMessage, status:filterStatus, fulfillments, traces, range, page, demoTraffic, controllerBusy:Boolean(controller)});
  for (const el of root.querySelectorAll('details')) if (open.has(detailsKey(el))) el.open = true;
  if (active?.action) {
    if (active.action === 'trace') [...root.querySelectorAll('[data-action="trace"]')].find(el => el.dataset.id === active.id)?.focus({preventScroll:true});
    else {
      const action = ['start','stop','continuous','bootstrap'].includes(active.action) ? (data?.simulation?.status === 'running' ? 'stop' : data?.simulation?.bootstrap_required ? 'bootstrap' : data?.simulation?.bootstrap_status === 'not_required' ? 'start' : 'continuous') : active.action;
      root.querySelector(`[data-action="${action}"]`)?.focus({preventScroll:true});
    }
  }
  else if (active?.filterSubmit) root.querySelector('[data-form="filters"] button')?.focus({preventScroll:true});
  else if (active?.trace) [...root.querySelectorAll('.trace-account')].find(el => detailsKey(el) === active.trace)?.querySelector('summary')?.focus({preventScroll:true});
  else if (active?.incident) [...root.querySelectorAll('.incident')].find(el => el.dataset.incident === active.incident)?.querySelector('summary')?.focus({preventScroll:true});
  else if (active?.integration) [...root.querySelectorAll('details')].find(el => detailsKey(el) === active.integration)?.querySelector('summary')?.focus({preventScroll:true});
  else if (active?.name) root.querySelector(`[data-form="${active.form}"] [name="${active.name}"]`)?.focus({preventScroll:true});
  if (!pending) actionFocus = null;
}

async function request(url, options = {}) {
  const current = new AbortController(), timeoutMs = options.method === 'POST' ? 60000 : 12000;
  controller = current;
  const timeout = setTimeout(() => current.abort('timeout'), timeoutMs);
  try {
    const response = await fetch(url, {cache:'no-store', signal:current.signal, ...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
    return body;
  } catch (e) {
    if (current.signal.reason === 'timeout') throw new Error(options.method === 'POST' ? 'The simulation request timed out; check the feed before retrying.' : 'The incident feed request timed out.');
    throw e;
  } finally { clearTimeout(timeout); if (controller === current) controller = null; }
}

async function refresh() {
  if (!alive || document.hidden) return;
  if (pending || controller) { schedule(); return; }
  try {
    data = await request(`${path}?cursor=${encodeURIComponent(cursor)}&limit=50${filterStatus === 'all' ? '' : `&status=${encodeURIComponent(filterStatus)}`}`); pollError = '';
    if (data.pagination?.next_cursor == null && cursor > 0 && !(data.incidents || []).length) { cursor = 0; page = 0; cursorHistory = [0]; }
    if (['LIVE_ADAPTY_SEEDED','LOCAL_ADAPTY_FIXTURE','FULL_MOCK'].includes(data.mode) && data.automation?.enabled === true) {
      const activity = await request(`/api/recovery/fulfillments?cursor=0&limit=${data.mode === 'FULL_MOCK' ? 100 : 50}`); fulfillments = activity.items || [];
    } else fulfillments = [];
    if (accepted && (acceptedAction === 'stop' ? data.simulation?.status !== 'running' : data.simulation?.status !== 'idle')) accepted = false;
    announce(data);
  }
  catch (e) {
    if (e.name !== 'AbortError' && alive) {
      pollError = e.message || 'Could not load the incident feed.';
      if (data?.mode === 'FULL_MOCK') { demoTraffic = false; clearTimeout(demoTimer); demoTimer = null; }
    }
  }
  if (alive) render();
  scheduleDemo();
  schedule();
}
function schedule() { clearTimeout(timer); if (alive && !document.hidden) timer = setTimeout(refresh, 2000); }
function demoReady() {
  return alive && !document.hidden && demoTraffic && data?.mode === 'FULL_MOCK' && data.automation?.enabled === true
    && filterStatus === 'all' && page === 0 && cursor === 0 && !pending && !controller
    && Number(data.telemetry?.queued || 0) === 0
    && !(data.incidents || []).some(item => ['detecting','repairing'].includes(item.status));
}
function scheduleDemo(delay = 6000) {
  if (!demoReady()) { clearTimeout(demoTimer); demoTimer = null; return; }
  if (demoTimer === null) demoTimer = setTimeout(runDemoOnce, delay);
}
async function runDemoOnce() {
  demoTimer = null;
  if (!demoReady()) return;
  pending = true; accepted = false; actionError = '';
  render();
  try {
    await request('/api/recovery/simulation', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'once', operation_key:crypto.randomUUID()})});
  } catch (e) {
    if (e.name !== 'AbortError' && alive) {
      actionError = e.message || 'Synthetic demo traffic failed.';
      demoTraffic = false;
    }
  }
  pending = false;
  if (alive && !document.hidden) await refresh();
}
function announce(feed) {
  const needs = Number(feed.summary?.needs_attention) || 0, simulation = feed.simulation?.status || 'idle';
  const signature = `${needs}:${simulation}`;
  if (lastSummary !== null && signature !== lastSummary) {
    const updates = [];
    if (simulation !== lastSummary.split(':')[1] && simulation !== 'idle') updates.push(`Simulation ${simulation}.`);
    if (needs !== Number(lastSummary.split(':')[0])) updates.push(needs ? `${needs} ${needs === 1 ? 'incident needs' : 'incidents need'} attention.` : 'No incidents need attention.');
    statusMessage = updates.join(' ');
    liveRegion.textContent = statusMessage;
  }
  lastSummary = signature;
}

async function download(kind) {
  readRange();
  if (rangeEdited) readRange(); else range = defaultRange();
  const from = range.from, to = range.to;
  const start = new Date(`${from}Z`), end = new Date(`${to}Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) { actionError = 'Choose a valid UTC range where From is earlier than To.'; render(); return; }
  try {
    const response = await fetch(`/api/recovery/export?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}&format=${kind}`, {cache:'no-store'});
    if (!response.ok) { const body = await response.json().catch(()=>({})); throw new Error(body.error || body.message || `Export failed (${response.status})`); }
    const blob = new Blob([await response.text()], {type:kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json'});
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `reconcile-activity.${kind}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    actionError = '';
  } catch (e) { actionError = e.message || 'Export failed.'; }
}

root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'dismiss-error') { actionError = ''; render(); return; }
  if (button.dataset.action === 'demo-traffic') {
    demoTraffic = !demoTraffic; clearTimeout(demoTimer); demoTimer = null;
    if (demoTraffic) scheduleDemo();
    render(); return;
  }
  if (button.dataset.action === 'csv' || button.dataset.action === 'json') { event.preventDefault?.(); await download(button.dataset.action === 'csv' ? 'csv' : 'json'); render(); return; }
  if (button.dataset.action === 'refresh') { await refresh(); return; }
  if (button.dataset.action === 'needs-attention') { filterStatus = 'needs_attention'; cursor = 0; page = 0; cursorHistory = [0]; await refresh(); return; }
  if (button.dataset.action === 'page') {
    const target = Number(button.dataset.page);
    if (target < page) { cursorHistory = cursorHistory.slice(0, target + 1); cursor = cursorHistory[target] ?? 0; }
    else { cursor = data?.pagination?.next_cursor ?? cursor; cursorHistory[target] = cursor; }
    page = target; await refresh(); return;
  }
  if (button.dataset.action === 'trace') { const id = button.dataset.id; actionFocus = {action:'trace',id}; try { traces[id] = {...await request(`/api/recovery/incidents/${encodeURIComponent(id)}/trace`),_loaded_at:new Date().toISOString()}; render(); } catch (e) { actionError = e.message || 'Could not load activity.'; render(); } return; }
  const action = ({start:'start', bootstrap:'bootstrap', continuous:'continuous', once:'once', stop:'stop'})[button.dataset.action];
  if (!action || pending) return;
  if (action === 'once') { clearTimeout(demoTimer); demoTimer = null; }
  pending = true; accepted = false; actionError = '';
  actionFocus = {action:button.dataset.action};
  controller?.abort();
  render();
  try {
    await request('/api/recovery/simulation', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(action === 'stop' ? {action} : {action, operation_key:crypto.randomUUID()})});
    accepted = data?.mode !== 'FULL_MOCK'; acceptedAction = action;
  } catch (e) {
    if (e.name !== 'AbortError' && alive) {
      actionError = e.message || 'Simulation request failed.';
      if (data?.mode === 'FULL_MOCK') { demoTraffic = false; clearTimeout(demoTimer); demoTimer = null; }
    }
  }
  pending = false;
  if (alive && !document.hidden) { await refresh(); render(); }
});

root.addEventListener('submit', async event => {
  const form = event.target.closest?.('[data-form]'); if (!form) return;
  event.preventDefault();
  if (form.dataset.form === 'filters') { filterStatus = form.elements.status.value; cursor = 0; page = 0; cursorHistory = [0]; await refresh(); }
});
root.addEventListener('input', event => {
  if (event.target.closest?.('[data-form="export"]')) { rangeEdited = true; readRange(); }
});

document.addEventListener('visibilitychange', () => { clearTimeout(timer); clearTimeout(demoTimer); demoTimer = null; if (document.hidden) controller?.abort(); else refresh(); });
window.addEventListener('pagehide', () => { alive = false; clearTimeout(timer); clearTimeout(demoTimer); demoTimer = null; controller?.abort(); });
window.addEventListener('pageshow', event => { if (event.persisted) { alive = true; refresh(); } });
render(); refresh();
