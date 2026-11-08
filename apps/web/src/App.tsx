import { useEffect, useRef, useState } from 'preact/hooks';
import { defaultRange, exportUrl, monitorUrl, simulationPayload } from './model';
import type { ExportKind, IncidentStatus, SimulationAction } from './model';
import { MonitorView } from './MonitorView';
import type { Fulfillment, MonitorFeed, Trace } from './MonitorView';

type State = {
  data: MonitorFeed | null;
  pollError: string;
  actionError: string;
  pending: boolean;
  accepted: boolean;
  acceptedAction: SimulationAction | '';
  filterStatus: IncidentStatus;
  selectedStatus: IncidentStatus;
  cursor: string | number;
  page: number;
  cursorHistory: Array<string | number>;
  fulfillments: Fulfillment[];
  traces: Record<string, Trace>;
  range: { from: string; to: string };
  rangeEdited: boolean;
  lastSummary: string | null;
  statusMessage: string;
  alive: boolean;
};

const initialState = (): State => ({
  data: null,
  pollError: '',
  actionError: '',
  pending: false,
  accepted: false,
  acceptedAction: '',
  filterStatus: 'unresolved',
  selectedStatus: 'unresolved',
  cursor: 0,
  page: 0,
  cursorHistory: [0],
  fulfillments: [],
  traces: {},
  range: defaultRange(),
  rangeEdited: false,
  lastSummary: null,
  statusMessage: '',
  alive: true,
});

const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function App() {
  const state = useRef(initialState());
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setVersion] = useState(0);
  const redraw = () => setVersion(value => value + 1);
  const update = (patch: Partial<State>) => {
    Object.assign(state.current, patch);
    redraw();
  };

  async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const current = new AbortController();
    const timeoutMs = options.method === 'POST' ? 60000 : 12000;
    controller.current = current;
    const timeout = setTimeout(() => current.abort('timeout'), timeoutMs);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: current.signal, ...options });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
      return body as T;
    } catch (error) {
      if (current.signal.reason === 'timeout') {
        throw new Error(options.method === 'POST' ? 'The simulation request timed out; check the feed before retrying.' : 'The incident feed request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (controller.current === current) controller.current = null;
    }
  }

  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    if (state.current.alive && !document.hidden) timer.current = setTimeout(() => void refresh(), 2000);
  }

  async function refresh() {
    const current = state.current;
    if (!current.alive || document.hidden || current.pending || controller.current) return;
    try {
      const feed = await request<MonitorFeed>(monitorUrl(current.cursor, current.filterStatus));
      current.data = feed;
      current.pollError = '';
      if (current.data.pagination?.next_cursor == null && Number(current.cursor) > 0 && !(current.data.incidents || []).length) {
        current.cursor = 0;
        current.page = 0;
        current.cursorHistory = [0];
      }
      redraw();
      if (feed.mode && ['LIVE_ADAPTY_SEEDED', 'LOCAL_ADAPTY_FIXTURE'].includes(feed.mode) && feed.automation?.enabled === true) {
        const activity = await request<{ items?: Fulfillment[] }>('/api/recovery/fulfillments?cursor=0&limit=50');
        current.fulfillments = activity.items || [];
      } else current.fulfillments = [];
      if (current.accepted && (current.acceptedAction === 'stop'
        ? !['queued', 'running', 'waiting'].includes(feed.simulation?.status || '')
        : feed.simulation?.status !== 'idle')) current.accepted = false;
      const needs = Number(feed.summary?.needs_attention) || 0;
      const simulation = feed.simulation?.status || 'idle';
      const signature = `${needs}:${simulation}`;
      if (current.lastSummary !== null && signature !== current.lastSummary) {
        const updates: string[] = [];
        if (simulation !== current.lastSummary.split(':')[1] && simulation !== 'idle') updates.push(`Simulation ${simulation}.`);
        if (needs !== Number(current.lastSummary.split(':')[0])) updates.push(needs ? `${needs} ${needs === 1 ? 'incident needs' : 'incidents need'} attention.` : 'No incidents need attention.');
        current.statusMessage = updates.join(' ');
      }
      current.lastSummary = signature;
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError' && current.alive) current.pollError = message(error, 'Could not load the incident feed.');
    }
    if (current.alive) redraw();
    schedule();
  }

  async function runAction(action: SimulationAction) {
    const current = state.current;
    if (current.pending) return;
    current.pending = true;
    current.accepted = false;
    current.actionError = '';
    controller.current?.abort();
    redraw();
    try {
      await request('/api/recovery/simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simulationPayload(action, crypto.randomUUID())),
      });
      current.accepted = true;
      current.acceptedAction = action;
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError' && current.alive) current.actionError = message(error, 'Simulation request failed.');
    }
    current.pending = false;
    redraw();
    if (current.alive && !document.hidden) {
      await refresh();
      redraw();
    }
  }

  async function loadTrace(id: string) {
    try {
      const trace = await request<Trace>(`/api/recovery/incidents/${encodeURIComponent(id)}/trace`);
      state.current.traces = { ...state.current.traces, [id]: { ...trace, _loaded_at: new Date().toISOString() } };
      redraw();
      requestAnimationFrame(() => {
        [...document.querySelectorAll<HTMLButtonElement>('[data-action="trace"]')].find(button => button.dataset.id === id)?.focus({ preventScroll: true });
      });
    } catch (error) {
      state.current.actionError = message(error, 'Could not load activity.');
      redraw();
    }
  }

  async function download(kind: ExportKind) {
    const current = state.current;
    const range = current.rangeEdited ? current.range : defaultRange();
    if (!current.rangeEdited) { current.range = range; redraw(); }
    try {
      const response = await fetch(exportUrl(range.from, range.to, kind), { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || body.message || `Export failed (${response.status})`);
      }
      const blob = new Blob([await response.text()], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `reconcile-activity.${kind}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      current.actionError = '';
    } catch (error) {
      current.actionError = message(error, 'Export failed.');
    }
    redraw();
  }

  function changePage(target: number) {
    const current = state.current;
    if (target < current.page) {
      current.cursorHistory = current.cursorHistory.slice(0, target + 1);
      current.cursor = current.cursorHistory[target] ?? 0;
    } else {
      current.cursor = current.data?.pagination?.next_cursor ?? current.cursor;
      current.cursorHistory[target] = current.cursor;
    }
    current.page = target;
    redraw();
    void refresh();
  }

  function applyFilter(status: IncidentStatus) {
    state.current.filterStatus = status;
    state.current.selectedStatus = status;
    state.current.cursor = 0;
    state.current.page = 0;
    redraw();
    void refresh();
  }

  useEffect(() => {
    const visibility = () => {
      if (timer.current) clearTimeout(timer.current);
      if (document.hidden) controller.current?.abort();
      else void refresh();
    };
    const pagehide = () => {
      state.current.alive = false;
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
    };
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        state.current.alive = true;
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    void refresh();
    return () => {
      state.current.alive = false;
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
    };
  }, []);

  const current = state.current;
  const requestMessage = current.pending
    ? 'Request pending · waiting for the monitor response.'
    : current.accepted
      ? current.acceptedAction === 'stop' ? 'Stop accepted · waiting for the monitor to confirm.' : 'Request accepted · waiting for the monitor to confirm.'
      : '';
  return <MonitorView
    data={current.data}
    pollError={current.pollError}
    actionError={current.actionError}
    pending={current.pending}
    requestMessage={requestMessage}
    status={current.filterStatus}
    selectedStatus={current.selectedStatus}
    fulfillments={current.fulfillments}
    traces={current.traces}
    range={current.range}
    page={current.page}
    statusMessage={current.statusMessage}
    onRefresh={() => void refresh()}
    onAction={action => void runAction(action)}
    onPage={changePage}
    onFilter={applyFilter}
    onFilterSelection={status => { state.current.selectedStatus = status; redraw(); }}
    onTrace={id => void loadTrace(id)}
    onExport={kind => void download(kind)}
    onRangeInput={(name, value) => {
      state.current.range = { ...state.current.range, [name]: value };
      state.current.rangeEdited = true;
      redraw();
    }}
    onDismissError={() => update({ actionError: '' })}
  />;
}
