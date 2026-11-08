import { useEffect } from 'react';
import { BusyContext, Button } from '../../shared';
import { AccessShell } from './components/AccessShell';
import { AccessModal } from './modals/AccessModal';
import { IncidentPage } from './pages/IncidentPage';
import { HistoryView, LumenPage, SourcesView } from './pages/OtherViews';
import { useAccess } from './useAccess';

/** Paid Access Recovery: incident, Lumen client simulator, sources/collector and run history. */
export function AccessApp() {
  const ax = useAccess();
  useEffect(() => { ax.actions.reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ax.busy && !ax.modal && ax.nav) ax.setNav(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ax.busy, ax.modal, ax.nav]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ax.report || !ax.window) {
    return (
      <div className="fatal-state">
        <span className="boot-mark">R</span><h1>Paid Access Recovery</h1>
        <p>{ax.error || 'Reading the local Lumen state…'}</p>
        {ax.error && <Button action="reload" primary onClick={ax.actions.reload}>Try again</Button>}
      </div>
    );
  }
  const view = ax.view === 'incident' ? <IncidentPage ax={ax} /> : ax.view === 'lumen' ? <LumenPage ax={ax} />
    : ax.view === 'sources' ? <SourcesView ax={ax} /> : <HistoryView ax={ax} />;
  return (
    <BusyContext.Provider value={ax.busy}>
      <AccessShell ax={ax}>{view}</AccessShell>
      <AccessModal ax={ax} />
    </BusyContext.Provider>
  );
}
