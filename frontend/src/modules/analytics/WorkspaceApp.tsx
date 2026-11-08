import { useEffect } from 'react';
import { BusyContext, Button } from '../../shared';
import { Shell } from './components/Shell';
import { WorkspaceModal } from './modals/WorkspaceModal';
import { CasePage } from './pages/CasePage';
import { CasesPage } from './pages/CasesPage';
import { HistoryPage, LabPage, SourcesPage } from './pages/OtherPages';
import { useWorkspace } from './useWorkspace';

/** Analytics workspace: Cases, the RCN-001 case, Sources, Demo Lab and Evidence / Runs. */
export function WorkspaceApp() {
  const ws = useWorkspace();
  useEffect(() => { ws.actions.retry(); /* initial load */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ws.busy && !ws.modal && ws.nav) ws.setNav(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ws.busy, ws.modal, ws.nav]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ws.report) {
    return (
      <div className="fatal-state">
        <span className="boot-mark">R</span><h1>Reconcile</h1>
        <p>{ws.error || 'Reading the local mock workspace…'}</p>
        {ws.error && <Button action="retry" primary onClick={ws.actions.retry}>Try again</Button>}
      </div>
    );
  }
  const page = ws.page === 'case' ? <CasePage ws={ws} /> : ws.page === 'cases' ? <CasesPage ws={ws} />
    : ws.page === 'sources' ? <SourcesPage ws={ws} /> : ws.page === 'lab' ? <LabPage ws={ws} /> : <HistoryPage ws={ws} />;
  return (
    <BusyContext.Provider value={ws.busy}>
      <Shell ws={ws}>{page}</Shell>
      <WorkspaceModal ws={ws} />
    </BusyContext.Provider>
  );
}
