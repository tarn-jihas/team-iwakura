import type { ReactNode } from 'react';
import { Button, Icon, MockBadge } from '../../../shared';
import type { Page, Workspace } from '../useWorkspace';

const NAV: Array<[Page, string, string]> = [['cases', 'cases', 'Cases'], ['sources', 'layers', 'Sources'], ['lab', 'flask', 'Demo Lab'], ['history', 'clock', 'Evidence / Runs']];
const LABELS: Record<Page, string> = { cases: 'Cases', case: 'RCN-001', sources: 'Sources', lab: 'Demo Lab', history: 'Evidence / Runs' };

export function Shell({ ws, children }: { ws: Workspace; children: ReactNode }) {
  const go = (page: Page) => (e: React.MouseEvent) => { e.preventDefault(); ws.navigate(page); };
  return (
    <div className="app-shell mock-app">
      {ws.nav && <div className="nav-backdrop" data-action="close-nav" onClick={() => ws.setNav(false)}></div>}
      <aside className={`sidebar ${ws.nav ? 'open' : ''}`} id="primary-navigation" aria-label="Workspace navigation">
        <div className="sidebar-brand">
          <a href="#cases" className="brand" data-page="cases" onClick={go('cases')}><span className="brand-mark"><Icon name="logo" size={23} /></span>Reconcile</a>
          <button type="button" className="btn-icon sidebar-close" data-action="nav-close" aria-label="Close navigation" onClick={() => ws.setNav(false)}><Icon name="close" /></button>
        </div>
        <div className="workspace-identity"><span className="app-icon">L</span><div><strong>Mock Lumen</strong><span>Subscription evidence</span></div></div>
        <nav className="primary-nav">
          {NAV.map(([page, glyph, text]) => (
            <button type="button" key={page} className={`nav-button ${ws.page === page || (page === 'cases' && ws.page === 'case') ? 'active' : ''}`} data-page={page} onClick={go(page)}>
              <Icon name={glyph} size={17} />{text}{page === 'cases' && <span className="count">2</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-lock"><Icon name="shield" /><div><strong>Everything stays local</strong><span>127.0.0.1 · no provider accounts</span></div></div>
          <div className="storage-note"><Icon name="layers" size={13} />State saved on this computer</div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="toolbar-location">
            <button type="button" className="btn-icon mobile-nav-button" data-action="nav" aria-label="Open navigation" aria-expanded={ws.nav} aria-controls="primary-navigation" onClick={() => ws.setNav(!ws.nav)}><Icon name="menu" size={19} /></button>
            <div className="breadcrumbs"><span className="workspace-crumb">Workspace</span><span> / </span><strong>{LABELS[ws.page]}</strong></div>
          </div>
          <div className="topbar-actions"><MockBadge /><span className="tick-label"><Icon name="clock" size={12} />Tick {ws.report?.clock}</span></div>
        </header>
        <main className="page" id="main-content">
          {ws.error && <div className="mock-error" role="alert">{ws.error} <Button action="reload" onClick={ws.actions.retry}>Refresh state</Button></div>}
          {children}
        </main>
        <footer className="mock-footer"><span>Deterministic engine · Decimal arithmetic · Human approval</span><span>FULL MOCK · No external requests</span></footer>
      </div>
    </div>
  );
}
