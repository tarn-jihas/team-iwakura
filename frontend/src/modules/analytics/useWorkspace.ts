import { useCallback, useState } from 'react';
import { ApiError, download, fetchText, useAsyncRunner, useFocusReturn, useToast } from '../../shared';
import { api } from './api';
import { counts, type AccessSummary, type Audit, type Evidence, type Operation, type Preview, type Report, type Run, type Sample } from './domain';

export type Page = 'cases' | 'case' | 'sources' | 'lab' | 'history';
export type Tab = 'findings' | 'operations' | 'receipt';

export type Modal =
  | { kind: 'evidence'; title: string; data: Evidence }
  | { kind: 'preview'; title: string; approved: boolean; actor: string }
  | { kind: 'mapping'; title: string; data: unknown; acknowledged: boolean }
  | { kind: 'reset'; title: string }
  | { kind: 'snapshot'; title: string; data: Run }
  | { kind: 'json'; title: string; data: unknown; filename?: string; contentType?: string };

interface Data {
  report: Report | null; access: AccessSummary | null; manifest: Record<string, unknown>; audit: Audit;
  history: Run[]; operations: Operation[]; samples: Sample[];
}

const EMPTY: Data = { report: null, access: null, manifest: {}, audit: {}, history: [], operations: [], samples: [] };

export function useWorkspace() {
  const notify = useToast();
  const focus = useFocusReturn();
  const [data, setData] = useState<Data>(EMPTY);
  const [page, setPage] = useState<Page>('cases');
  const [tab, setTabState] = useState<Tab>('findings');
  const [caseType, setCaseType] = useState('all');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [nav, setNav] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState(false);
  const onError = useCallback((e: Error) => notify(e.message, true), [notify]);
  const { busy, error, setError, run } = useAsyncRunner(onError);

  const refresh = useCallback(async () => {
    const [report, manifest, audit, history, operations, samples, access] = await Promise.all([
      api<Report>('/api/report'), api<Record<string, unknown>>('/api/manifest'), api<Audit>('/api/audit'),
      api<{ runs: Run[] }>('/api/history'), api<{ operations: Operation[] }>('/api/operations'), api<{ samples: Sample[] }>('/api/samples'),
      api<AccessSummary>('/api/access/report').catch((e: unknown) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
    ]);
    setData({ report, access, manifest, audit, history: history.runs, operations: operations.operations, samples: samples.samples });
    setError('');
    return report;
  }, [setError]);

  const navigate = (next: Page) => { setPage(next); setNav(false); setSearch(''); setFilter('all'); window.scrollTo(0, 0); };
  const setTab = (next: Tab) => { setTabState(next); setSearch(''); setFilter('all'); };

  const open = (next: Modal) => { focus.remember(); setModal(next); };
  const closeModal = () => {
    setModal(null); setPreview(null); setSelected(new Set()); setAcknowledged(false);
    focus.restore('[data-action="detect"]');
  };
  const patchModal = (patch: Partial<Modal>) => setModal(m => (m ? ({ ...m, ...patch } as Modal) : m));

  const actions = {
    retry: () => run(async () => { await refresh(); }),
    detect: () => run(async () => {
      await api('/api/detect', {}); await refresh();
      notify('Fresh detection saved to run history.');
    }),
    verify: () => run(async () => {
      const result = await api<{ verification?: { status?: string } }>('/api/verify', {});
      const report = await refresh();
      if (result.verification?.status === 'readback_failed' || (report.action_count && ['readback_failed', 'unresolved', 'open_findings'].includes(report.verification_status || ''))) {
        const message = 'Fresh verification did not confirm the repair. Inspect the remaining findings and action receipts.';
        setError(message); notify(message, true);
      } else {
        notify(counts(report).pending ? 'Readback still pending. Advance the mock clock.' : report.action_count ? 'Fresh read complete. Review the remaining findings.' : 'No repair actions yet. Review the detected findings first.');
      }
    }),
    evidence: (txn: string) => run(async () => {
      const evidence = await api<Evidence>(`/api/evidence?txn=${encodeURIComponent(txn)}`);
      open({ kind: 'evidence', title: txn, data: evidence });
    }),
    preview: () => run(async () => {
      const plan = await api<Preview>('/api/preview');
      setPreview(plan); setSelected(new Set()); setAcknowledged(false);
      if (!plan.groups.length) { notify('No active repair plan. Read the current case receipt.'); return; }
      open({ kind: 'preview', title: 'Review the repair plan', approved: false, actor: 'demo-operator' });
    }),
    toggleGroup: (cls: string, checked: boolean) => {
      setSelected(prev => { const next = new Set(prev); if (checked) next.add(cls); else next.delete(cls); return next; });
      patchModal({ approved: false });
    },
    setAcknowledged: (value: boolean) => { setAcknowledged(value); patchModal({ approved: false }); },
    setActor: (actor: string) => patchModal({ actor, approved: false }),
    approve: () => run(async () => {
      if (modal?.kind !== 'preview' || !preview || !data.report) return;
      const ids = [...selected];
      const hashes = Object.fromEntries(preview.groups.filter(g => selected.has(g.class)).map(g => [g.class, g.approval_hash]));
      await api('/api/approve', { run: data.report.run, ids, hashes, actor: modal.actor ?? 'demo-operator' });
      patchModal({ approved: true }); await refresh();
      notify('Human approval saved. No destination writes yet.');
    }),
    apply: () => run(async () => {
      if (!data.report) return;
      const result = await api<{ writes_accepted: number }>('/api/apply', { run: data.report.run, ids: [...selected] });
      closeModal(); await refresh(); setTabState('receipt');
      notify(`${result.writes_accepted} writes accepted locally. Advance one tick, then Verify.`);
    }),
    retryApply: () => run(async () => {
      if (!data.report) return;
      const result = await api<{ writes_accepted: number }>('/api/apply', { run: data.report.run, ids: Object.keys(data.audit.approvals || {}) });
      await refresh(); notify(`Idempotent retry: ${result.writes_accepted} additional writes accepted.`);
    }),
    mapPreview: () => run(async () => {
      const evidence = await api('/api/evidence?txn=txn_renamed');
      open({ kind: 'mapping', title: 'Review the renamed event', data: evidence, acknowledged: false });
    }),
    setMappingAck: (value: boolean) => patchModal({ acknowledged: value }),
    map: () => run(async () => {
      await api('/api/map', { event: 'premium_paid_v2', cls: 'purchase', actor: 'demo-operator' });
      closeModal(); await refresh(); notify('Local mapping accepted. Zero destination events imported.');
    }),
    advance: () => run(async () => {
      await api('/api/advance-clock', { ticks: 1 }); await refresh();
      notify('Mock clock advanced. Run Verify to save a fresh readback.');
    }),
    resetPreview: () => open({ kind: 'reset', title: 'Reset the local demo' }),
    reset: () => run(async () => {
      await api('/api/reset', {}); closeModal(); setTabState('findings'); await refresh(); navigate('case');
      notify('Fixed seed restored. Six groups, seven findings.');
    }),
    snapshot: (index: number) => open({ kind: 'snapshot', title: 'Saved run snapshot', data: data.history[index] }),
    metric: () => run(async () => {
      const result = await api('/mock/mixpanel/query');
      open({ kind: 'json', title: 'Explicit effective metric', data: { contract: 'Query-time dedup (event + distinct_id + time + $insert_id), latest ingestion. Production only. Signed purchases/refunds plus reconcile_correction, separately per currency. Raw originals are retained; this is not a native provider chart.', result } });
    }),
    profile: () => run(async () => {
      open({ kind: 'json', title: 'Synthetic profile · not a price ledger', data: await api('/mock/adapty/api/v2/server-side-api/profile/?customer_user_id=u00004') });
    }),
    sample: (path: string) => run(async () => {
      const sample = await api<{ path: string; content: unknown }>(`/api/sample?path=${encodeURIComponent(path)}`);
      open({ kind: 'json', title: `Reference sample: ${sample.path}`, data: sample.content, filename: sample.path.split('/').at(-1), contentType: 'text/plain' });
    }),
    sourceView: (path: string) => run(async () => {
      open({ kind: 'json', title: 'Raw local export · JSONL', data: await fetchText(path), filename: 'reconcile-raw-export.jsonl', contentType: 'application/x-ndjson' });
    }),
    sourceDownload: (path: string, type: string) => run(async () => { download(await fetchText(path), `${type}.jsonl`, 'application/x-ndjson'); }),
    regionTest: () => run(async () => {
      const before = await api<Report>('/api/report');
      const probe = { event: 'subscription_started', properties: { distinct_id: 'mock-region-probe', time: 1794042000, $insert_id: 'mock-wrong-region-probe', transaction_id: 'txn_region_probe', currency: 'USD', price_local: '1.00', environment: 'Production', store: 'play_store' } };
      const result = await api('/mock/mixpanel/import?region=us', [probe]);
      const after = await api<Report>('/api/report');
      open({ kind: 'json', title: 'Wrong-region negative control', data: { transport_status: 200, mock_response: result, before_gap: before.gap, after_gap: after.gap, raw_before: before.raw_event_count, raw_after: after.raw_event_count, explanation: 'Local simulation: HTTP success alone is not persisted data or a successful repair.' } });
    }),
    exportReport: () => download({ mode: 'FULL_MOCK', manifest: data.manifest, report: data.report, operations: data.operations }, 'reconcile-report.json'),
    exportAudit: () => run(async () => {
      const audit = await api<Audit>('/api/audit');
      setData(d => ({ ...d, audit })); download(audit, 'reconcile-case-receipt.json');
    }),
    exportModal: () => {
      if (!modal) return;
      const m = modal as Modal & { data?: unknown; filename?: string; contentType?: string };
      download(m.data, m.filename || `reconcile-${m.kind}.json`, m.contentType || 'application/json');
    },
  };

  return {
    ...data, page, tab, caseType, search, filter, nav, modal, preview, selected, acknowledged, busy, error,
    navigate, setTab, setCaseType, setSearch, setFilter, setNav, closeModal, actions, refresh, run,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
