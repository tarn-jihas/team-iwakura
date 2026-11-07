import { csv, renderMonitor } from './monitor-view.js';

const root = document.querySelector('#app');
const liveRegion = document.createElement('div');
liveRegion.className = 'visually-hidden'; liveRegion.setAttribute('role','status'); liveRegion.setAttribute('aria-live','polite'); document.body.append(liveRegion);
let data = null, pollError = '', actionError = '', pending = false, accepted = false, acceptedAction = '', statusMessage = '', lastSummary = null, timer = null, controller = null, alive = true, actionFocus = null;
const path = '/api/recovery/monitor';
const focusKey = element => element?.dataset?.action ? {action:element.dataset.action} : element?.closest?.('.incident') ? {incident:element.closest('.incident').dataset.incident} : element?.closest?.('.integration') ? {integration:true} : null;

function render() {
  const open = new Set([...root.querySelectorAll('details[open]')].map(el => el.dataset.incident ?? (el.classList.contains('integration') ? 'integration' : '')));
  const active = focusKey(document.activeElement) || actionFocus;
  const requestMessage = pending ? 'Request pending · waiting for the monitor response.' : accepted ? acceptedAction === 'stop' ? 'Stop accepted · waiting for the monitor to confirm.' : 'Request accepted · waiting for the monitor to confirm.' : '';
  root.innerHTML = renderMonitor(data, {pollError, actionError, pending, requestMessage});
  for (const el of root.querySelectorAll('details')) if (open.has(el.dataset.incident ?? (el.classList.contains('integration') ? 'integration' : ''))) el.open = true;
  if (active?.action) {
    const action = ['start','stop'].includes(active.action) ? (data?.simulation?.status === 'running' ? 'stop' : 'start') : active.action;
    root.querySelector(`[data-action="${action}"]`)?.focus({preventScroll:true});
  }
  else if (active?.incident) [...root.querySelectorAll('.incident')].find(el => el.dataset.incident === active.incident)?.querySelector('summary')?.focus({preventScroll:true});
  else if (active?.integration) root.querySelector('.integration summary')?.focus({preventScroll:true});
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
  if (!alive || document.hidden || pending || controller) return;
  try {
    data = await request(path); pollError = '';
    if (accepted && (acceptedAction === 'stop' ? data.simulation?.status !== 'running' : data.simulation?.status !== 'idle')) accepted = false;
    announce(data);
  }
  catch (e) { if (e.name !== 'AbortError' && alive) pollError = e.message || 'Could not load the incident feed.'; }
  if (alive) render();
  schedule();
}
function schedule() { clearTimeout(timer); if (alive && !document.hidden) timer = setTimeout(refresh, 2000); }
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
  const rows = data?.incidents;
  if (!rows?.length) return;
  const date = new Date().toISOString().slice(0,10);
  const content = kind === 'csv' ? csv(rows) : JSON.stringify({mode:data.mode,app:data.app,automation:data.automation,connection:data.connection,summary:data.summary,telemetry:data.telemetry,simulation:data.simulation,incidents:rows}, null, 2);
  const blob = new Blob([content], {type:kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json'});
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `reconcile-incidents-${date}.${kind}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'dismiss-error') { actionError = ''; render(); return; }
  if (button.dataset.action === 'csv' || button.dataset.action === 'json') { await download(button.dataset.action === 'csv' ? 'csv' : 'json'); render(); return; }
  if (button.dataset.action === 'refresh') { await refresh(); return; }
  const action = ({start:'start', once:'once', stop:'stop'})[button.dataset.action];
  if (!action || pending) return;
  pending = true; accepted = false; actionError = '';
  actionFocus = {action:button.dataset.action};
  controller?.abort();
  render();
  try {
    await request('/api/recovery/simulation', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(action === 'stop' ? {action} : {action, operation_key:crypto.randomUUID()})});
    accepted = true; acceptedAction = action;
  } catch (e) { if (e.name !== 'AbortError' && alive) actionError = e.message || 'Simulation request failed.'; }
  pending = false;
  if (alive && !document.hidden) { await refresh(); render(); }
});

document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (document.hidden) controller?.abort(); else refresh(); });
window.addEventListener('pagehide', () => { alive = false; clearTimeout(timer); controller?.abort(); });
window.addEventListener('pageshow', event => { if (event.persisted) { alive = true; refresh(); } });
render(); refresh();
