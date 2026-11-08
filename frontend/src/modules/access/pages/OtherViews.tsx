import { Fragment } from 'react';
import { Badge, Button, Heading } from '../../../shared';
import { orderedAccounts, STATUS } from '../domain';
import type { Access } from '../useAccess';

export function LumenPage({ ax }: { ax: Access }) {
  const report = ax.report!;
  const account = report.accounts.find(a => a.id === ax.lumenUser);
  const gate = ax.gate;
  return (
    <>
      <Heading title="Lumen · client app simulator" description="A small working client surface. Its premium export calls the same backend gate used by recovery verification."
        actions={<Button action="incident" onClick={() => ax.navigate('incident')}>Back to incident</Button>} />
      <div className="lumen-layout">
        <section className="lumen-app-card">
          <div className="lumen-app-header"><span className="lumen-logo">L</span><div><strong>Lumen</strong><small>Synthetic photo workspace</small></div><Badge tone="blue">Client simulator</Badge></div>
          <div className="lumen-canvas"><span className="lumen-sun"></span><span className="lumen-hill one"></span><span className="lumen-hill two"></span><span className="lumen-canvas-label">Your next perspective.</span></div>
          <div className="lumen-app-content">
            <label>Demo account<select id="lumen-user" value={ax.lumenUser} onChange={e => ax.setLumenUser(e.target.value)}>
              {orderedAccounts(report.accounts).map(a => <option key={a.id} value={a.id}>{a.id} · {STATUS[a.status]?.[0] || a.status}</option>)}
            </select></label>
            <div className="lumen-entitlement">
              <span>Source entitlement<strong>{account?.source_active === true ? 'Active paid period' : account?.source_active === false ? 'Inactive' : 'Unknown'}</strong></span>
              <span>App access state<strong>{account?.gate?.allowed ? 'Gate allows access' : 'Gate denies access'}</strong></span>
            </div>
            <Button action="lumen-export" primary onClick={ax.actions.lumenExport}>Export premium preview</Button>
            <p className="table-note">This is an actual local request and customer-attempt journal entry, not a prerecorded animation.</p>
            {gate && (
              <div className={`lumen-gate-result ${gate.allowed ? 'allowed' : 'denied'}`} role="status">
                <strong>{gate.allowed ? '200 · Premium export allowed' : '403 · Premium export denied'}</strong>
                <p>{gate.reason || gate.reason_code}</p>
                <details><summary>Gate response and versions</summary><pre>{JSON.stringify(gate, null, 2)}</pre></details>
                {gate.allowed
                  ? <Button action="gate-download" onClick={ax.actions.gateDownload}>Download gate receipt</Button>
                  : <Button action="incident" onClick={() => ax.navigate('incident')}>Investigate this incident</Button>}
              </div>
            )}
          </div>
        </section>
        <div>
          <section className="mock-contract-card">
            <h2>Collector SDK</h2>
            <p>Consumer events, projection changes, customer access decisions and resync results are signed and recorded by our server-side SDK.</p>
            <div className="access-collector-count"><strong>{report.collector.event_count}</strong><span>recorded metadata events</span></div>
            <p>Only allowlisted subscription/access metadata is accepted. No card details or payment credentials are collected.</p>
            <Button action="journal" onClick={ax.actions.journal}>Inspect collector journal</Button>
          </section>
          <section className="mock-contract-card">
            <h2>Demo controls</h2>
            <p>Handler changes apply to future cancellation events. Resyncing an account does not deploy a root-cause fix.</p>
            <label className="access-field">Future cancellation handler<select id="handler-mode" value={ax.handlerMode} onChange={e => ax.setHandlerMode(e.target.value)}>
              <option value="faulty">Faulty v1</option><option value="fixed">Fixed v2</option>
            </select></label>
            <div className="receipt-actions">
              <Button action="set-handler" onClick={ax.actions.setHandler}>Set demo handler</Button>
              <Button action="cancel" onClick={ax.actions.cancel}>Send cancellation to selected account</Button>
            </div>
            <div className="access-demo-reset">
              <p>Reset only this access run. Analytics evidence is preserved.</p>
              <Button action="reset-preview" onClick={() => ax.actions.resetPreview(0)}>Reset 100-account scenario</Button>
              <Button action="variant-preview" onClick={() => ax.actions.resetPreview(1)}>Use alternate 100-account seed</Button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export function SourcesView({ ax }: { ax: Access }) {
  const report = ax.report!;
  const cards: Array<[string, string]> = [
    ['Source entitlement', 'Synthetic Adapty-shaped current access observations. A payment amount alone never establishes entitlement.'],
    ['Client projection & cache', 'Independent revisioned state written by the Lumen consumer. Stale cache can deny access after a successful resync.'],
    ['Collector SDK journal', `${report.collector.event_count} signed metadata events generated by actual local app operations. Customer decisions and reconciliation probes carry separate initiators.`],
  ];
  return (
    <>
      <Heading title="Sources / Collector" description="Separate source entitlement, client state and real gate decisions." actions={<Button action="export" onClick={ax.actions.exportBundle}>Export evidence bundle</Button>} />
      <div className="source-inventory">
        {cards.map(([title, note]) => <article className="inventory-card" key={title}><div className="inventory-heading"><strong>{title}</strong><Badge tone="blue">Synthetic / local</Badge></div><p>{note}</p></article>)}
      </div>
      <section className="mock-contract-card">
        <h2>Run manifest</h2>
        <dl>{Object.entries(report.manifest).map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></Fragment>)}</dl>
        <div className="receipt-actions">
          <Button action="registry" onClick={ax.actions.registry}>View registry</Button>
          <Button action="journal" onClick={ax.actions.journal}>View collector journal</Button>
        </div>
      </section>
    </>
  );
}

export function HistoryView({ ax }: { ax: Access }) {
  const history = ax.report!.history || [];
  return (
    <>
      <Heading title="Evidence / Run history" description="Recorded scans, gate checks and approval receipts stay tied to the access run." actions={<Button action="export" onClick={ax.actions.exportBundle}>Export evidence bundle</Button>} />
      <section className="list-panel">
        <div className="panel-toolbar"><strong>Access run history</strong><span>Latest 20 recorded operations</span></div>
        {history.length ? history.slice().reverse().map((row, i) => {
          const index = history.length - i - 1;
          return (
            <div className="access-history-row" key={index}>
              <div><strong>{String(row.action || row.kind || row.type || 'Snapshot')}</strong><small>{String(row.at || row.id || row.created_at || row.scenario_now || '')}</small></div>
              <Button action="history" data-index={index} onClick={() => ax.actions.history(index)}>Inspect record</Button>
            </div>
          );
        }) : <div className="empty-state">Detect or verify an incident to record a snapshot.</div>}
      </section>
    </>
  );
}
