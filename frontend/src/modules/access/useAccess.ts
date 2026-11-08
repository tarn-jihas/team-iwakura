import { useCallback, useRef, useState } from 'react';
import { download, useAsyncRunner, useFocusReturn, useToast } from '../../shared';
import { request } from './api';
import { orderedAccounts, utcInput, utcValue, type AccessReport, type Gate, type Plan } from './domain';

export type View = 'incident' | 'lumen' | 'sources' | 'history';
export type Tab = 'accounts' | 'repair' | 'scope';
export type Modal =
  | { kind: 'plan'; title: string }
  | { kind: 'reset'; title: string; variant: number }
  | { kind: 'json'; title: string; data: unknown };

interface IncidentWindow { start: string; end: string; handler: string }

export function useAccess() {
  const notify = useToast();
  const focus = useFocusReturn();
  const [report, setReport] = useState<AccessReport | null>(null);
  const [view, setView] = useState<View>(location.hash === '#lumen' ? 'lumen' : 'incident');
  const [tab, setTab] = useState<Tab>('accounts');
  const [filter, setFilterState] = useState('all');
  const [query, setQueryState] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [window_, setWindow] = useState<IncidentWindow | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ack, setAckState] = useState(false);
  const [actor, setActorState] = useState('demo-operator');
  const [approved, setApproved] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [nav, setNav] = useState(false);
  const [lumenUser, setLumenUserState] = useState('');
  const [gate, setGate] = useState<Gate | null>(null);
  const [handlerMode, setHandlerMode] = useState('faulty');
  const modalRef = useRef<Modal | null>(null);
  modalRef.current = modal;

  const onError = useCallback((e: Error & { status?: number }) => {
    if (e.status === 409 && modalRef.current?.kind === 'plan') setApproved(false);
    notify(e.message, true);
  }, [notify]);
  const { busy, error, setError, run } = useAsyncRunner(onError);

  const refresh = useCallback(async () => {
    const next = await request<AccessReport>('/api/access/report');
    setReport(next); setError('');
    if (next.consumer) setHandlerMode(next.consumer.mode);
    setWindow(w => w ?? { start: utcInput(next.incident.window_start), end: utcInput(next.incident.window_end), handler: next.incident.handler_version || 'cancel-handler-v1' });
    setActivePlanId(id => next.recovery.latest_plan_id || id);
    setLumenUserState(u => (!u || !next.accounts.some(a => a.id === u) ? orderedAccounts(next.accounts)[0]?.id || '' : u));
    setSelected(prev => new Set([...prev].filter(id => next.accounts.some(a => a.id === id && a.eligible))));
    return next;
  }, [setError]);

  const navigate = (next: View) => { setView(next); setNav(false); location.hash = next === 'incident' ? '' : next; window.scrollTo(0, 0); };
  const open = (next: Modal) => { focus.remember(); setModal(next); };
  const closeModal = () => { setModal(null); setPlan(null); setAckState(false); setApproved(false); focus.restore('[data-action="export"]'); };

  const createPlan = async (ids: string[], retry = false) => {
    const next = await request<Plan>('/api/access/preview', { ids, ...(retry ? { retry_of: activePlanId } : {}) });
    setPlan(next); setAckState(false); setApproved(false);
    open({ kind: 'plan', title: retry ? 'Review the fresh bounded retry' : 'Review the access repair plan' });
  };

  const eligible = () => (report?.accounts || []).filter(a => a.eligible);

  const actions = {
    reload: () => run(async () => { await refresh(); }),
    detect: () => run(async () => {
      if (!report || !window_) return;
      await request('/api/access/detect', {
        run_id: report.manifest.run_id, window_start: utcValue(window_.start), window_end: utcValue(window_.end),
        handler_version: window_.handler, event_type: 'subscription_renewal_cancelled', feature: 'premium_export',
      });
      setSelected(new Set()); setPage(0); await refresh();
      notify('Registry scan complete. Confirmed accounts and exclusions are backed by current gate probes.');
    }),
    toggleAccount: (id: string, checked: boolean) => setSelected(prev => { const next = new Set(prev); if (checked) next.add(id); else next.delete(id); return next; }),
    selectEligible: () => setSelected(new Set(eligible().map(a => a.id))),
    clearSelection: () => setSelected(new Set()),
    previous: () => setPage(p => p - 1),
    next: () => setPage(p => p + 1),
    preview: () => run(() => createPlan([...selected])),
    retryPreview: () => run(() => createPlan(report?.recovery.unresolved_ids || [], true)),
    setAck: (value: boolean) => { setAckState(value); setApproved(false); },
    setActor: (value: string) => { setActorState(value); setApproved(false); },
    approve: () => run(async () => {
      if (!plan) return;
      await request('/api/access/approve', { plan_id: plan.id, plan_hash: plan.plan_hash, actor });
      setApproved(true); await refresh(); notify('Approval saved. No client licence or cache was changed.');
    }),
    apply: (repeat = false) => run(async () => {
      const planId = repeat ? activePlanId : plan?.id;
      const p = repeat ? report?.plans?.find(row => row.id === planId) : plan;
      if (!planId || !p) return;
      const result = await request<{ writes_accepted: number }>('/api/access/apply', { plan_id: planId, plan_hash: p.plan_hash });
      setActivePlanId(planId); closeModal(); await refresh(); setTab('repair'); setView('incident');
      notify(`${result.writes_accepted} local resyncs accepted. Verify the actual gates to establish restoration.`);
    }),
    verify: () => run(async () => {
      await request('/api/access/verify', { plan_id: activePlanId });
      const next = await refresh();
      notify(`${next.recovery.verified_count} gate-verified / ${next.recovery.unresolved_count} unresolved. Root cause is tracked separately.`);
    }),
    inspectPlan: (id: string) => run(async () => {
      const bundle = await request<{ plans?: Plan[] | Record<string, Plan> }>('/api/access/audit');
      const plans = Array.isArray(bundle.plans) ? bundle.plans : Object.values(bundle.plans || {});
      const found = plans.find(p => p.id === id);
      if (!found) throw new Error('The saved plan is unavailable in this access run.');
      open({ kind: 'json', title: 'Saved access repair plan', data: found });
    }),
    evidence: (user: string) => run(async () => { open({ kind: 'json', title: `Evidence · ${user}`, data: await request(`/api/access/evidence?user=${encodeURIComponent(user)}`) }); }),
    journal: () => run(async () => { open({ kind: 'json', title: 'Collector journal · actual app operations', data: await request('/api/access/journal') }); }),
    registry: () => run(async () => { open({ kind: 'json', title: 'Known account registry', data: await request('/api/access/registry') }); }),
    history: (index: number) => open({ kind: 'json', title: 'Historical access run · read only', data: report?.history?.[index] }),
    exportBundle: () => run(async () => { download(await request('/api/access/audit'), 'reconcile-access-audit.json'); }),
    lumenExport: () => run(async () => {
      setGate(await request<Gate>('/mock/lumen/export', { user_id: lumenUser, feature: 'premium_export' }, { allowDenied: true }));
      await refresh();
    }),
    setHandler: () => run(async () => {
      await request('/api/access/demo', { action: 'handler', mode: handlerMode }); await refresh();
      notify('Future-event demo handler changed. Existing licences were not repaired.');
    }),
    cancel: () => run(async () => {
      await request('/api/access/demo', { action: 'cancel', ids: [lumenUser] }); setGate(null); await refresh();
      notify('Cancellation processed by the current demo handler. Inspect the resulting gate.');
    }),
    resetPreview: (variant: number) => open({ kind: 'reset', title: 'Reset the access simulator', variant }),
    reset: () => run(async () => {
      if (modal?.kind !== 'reset') return;
      await request('/api/access/demo', { action: 'reset', variant: modal.variant });
      closeModal(); setWindow(null); setActivePlanId(null); setSelected(new Set()); setGate(null); setTab('accounts');
      await refresh(); navigate('incident'); notify('Synthetic 100-account access scenario reset.');
    }),
    modalDownload: () => { if (modal?.kind === 'json') download(modal.data, 'reconcile-access-evidence.json'); },
    gateDownload: () => download(gate, 'lumen-gate-receipt.json'),
  };

  return {
    report, view, tab, filter, query, page, selected, window: window_, modal, plan, ack, actor, approved, activePlanId,
    nav, lumenUser, gate, handlerMode, busy, error,
    setTab, setNav, setPage, setHandlerMode, navigate, closeModal, actions, eligible,
    setFilter: (v: string) => { setFilterState(v); setPage(0); },
    setQuery: (v: string) => { setQueryState(v); setPage(0); },
    setWindowField: (field: keyof IncidentWindow, value: string) => setWindow(w => (w ? { ...w, [field]: value } : w)),
    setLumenUser: (v: string) => { setLumenUserState(v); setGate(null); },
  };
}

export type Access = ReturnType<typeof useAccess>;
