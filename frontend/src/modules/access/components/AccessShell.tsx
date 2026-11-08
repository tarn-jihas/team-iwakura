import type { ReactNode } from 'react';
import { Button, MockBadge } from '../../../shared';
import type { Access, View } from '../useAccess';

const Mark = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M5 4h9v4H5zM10 16h9v4h-9zM5 8v8h5M14 8h5v8M8 12h8" />
  </svg>
);

const NAV: Array<[View, string]> = [['incident', '◈ Access incident'], ['sources', '▱ Sources / Collector'], ['lumen', '◇ Lumen / Demo Lab'], ['history', '◷ Evidence / Runs']];

export function AccessShell({ ax, children }: { ax: Access; children: ReactNode }) {
  return (
    <div className="app-shell mock-app access-app">
      {ax.nav && <div className="nav-backdrop" data-action="nav-close" onClick={() => ax.setNav(false)}></div>}
      <aside className={`sidebar ${ax.nav ? 'open' : ''}`} id="primary-navigation" aria-label="Recovery workspace navigation">
        <div className="sidebar-brand">
          <a className="brand" href="/"><span className="brand-mark"><Mark /></span>Reconcile</a>
          <button type="button" className="btn-icon sidebar-close" data-action="nav-close" aria-label="Close navigation" onClick={() => ax.setNav(false)}>×</button>
        </div>
        <div className="workspace-identity"><span className="app-icon">L</span><div><strong>Mock Lumen</strong><span>Paid Access Recovery</span></div></div>
        <nav className="primary-nav">
          <a className="nav-button" href="/">▦ Cases<span className="count">2</span></a>
          {NAV.map(([view, label]) => (
            <button type="button" key={view} className={`nav-button ${ax.view === view ? 'active' : ''}`} data-view={view} onClick={() => ax.navigate(view)}>{label}</button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-lock"><span>◈</span><div><strong>Real local gate decisions</strong><span>Synthetic licences · no provider writes</span></div></div>
          <a className="nav-button" href="/">← Analytics workspace</a>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="toolbar-location">
            <button type="button" className="btn-icon mobile-nav-button" data-action="nav" aria-label="Open navigation" aria-expanded={ax.nav} aria-controls="primary-navigation" onClick={() => ax.setNav(!ax.nav)}>☰</button>
            <div className="breadcrumbs"><a href="/">Cases</a><span> / </span><strong>ACCESS-001</strong></div>
          </div>
          <div className="topbar-actions"><MockBadge /></div>
        </header>
        <main className="page" id="main-content">
          {ax.error && <div className="mock-error" role="alert">{ax.error}<Button action="reload" onClick={ax.actions.reload}>Refresh current state</Button></div>}
          {children}
        </main>
        <footer className="mock-footer"><span>Source entitlement → client projection → cache → actual premium gate</span><span>Local synthetic app · no payment credentials</span></footer>
      </div>
    </div>
  );
}
