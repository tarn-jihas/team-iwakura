import { Badge, Button, Heading, Icon, money } from '../../../shared';
import type { Workspace } from '../useWorkspace';

export function SourcesPage({ ws }: { ws: Workspace }) {
  const report = ws.report!;
  const sources: Array<[string, string, string, string, 'source' | 'destination']> = [
    ['Adapty-shaped source', 'A', '/mock/adapty/events/export', 'Webhook-shaped JSONL · exact local ledger', 'source'],
    ['Mixpanel-shaped destination', 'm', '/mock/mixpanel/api/2.0/export', `${report.raw_event_count} visible raw events · ${report.query_event_count} after delivery dedup`, 'destination'],
  ];
  return (
    <>
      <Heading title="Sources" description="Two active local providers. Original evidence stays available." />
      <div className="source-intro-note"><Icon name="shield" size={18} /><div>FULL MOCK / SYNTHETIC DATA. The webhook-shaped log is the transaction-price authority. A profile read contains current subscription state, not a per-transaction price ledger.</div></div>
      <div className="source-inventory">
        {sources.map(([title, mark, path, text, type]) => (
          <article className="inventory-card" key={path}>
            <div className="inventory-heading"><span className={`provider-mark ${type === 'source' ? 'adapty' : 'mixpanel'}`}>{mark}</span><strong>{title}</strong><Badge tone="green">Active local</Badge></div>
            <p>{text}</p>
            <code className="source-path">{path}</code>
            <div className="inventory-actions">
              <Button action="source-view" data-path={path} onClick={() => ws.actions.sourceView(path)}>View raw export</Button>
              <Button action="source-download" data-path={path} data-type={type} onClick={() => ws.actions.sourceDownload(path, type)}>Download JSONL</Button>
            </div>
          </article>
        ))}
      </div>
      <section className="mock-contract-card">
        <h2>Scope &amp; provenance</h2>
        <dl>{Object.entries(ws.manifest).map(([key, value]) => <Row key={key} k={key} v={typeof value === 'object' ? JSON.stringify(value) : String(value)} />)}</dl>
        <div className="receipt-actions">
          <Button action="metric" onClick={ws.actions.metric}>View effective query</Button>
          <Button action="profile" onClick={ws.actions.profile}>View sample profile</Button>
        </div>
      </section>
    </>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => <><dt>{k}</dt><dd>{v}</dd></>;

export function LabPage({ ws }: { ws: Workspace }) {
  return (
    <>
      <Heading title="Demo Lab" description="Repeat the repair loop and inspect synthetic provider samples." actions={<Button action="reset-preview" onClick={ws.actions.resetPreview}>Reset demo</Button>} />
      <section className="mock-lab-guide">
        <span className="lab-eyebrow">THE HACKATHON WALKTHROUGH</span>
        <h2>From discrepancy to a verifiable receipt.</h2>
        <p>Reset → Detect → Evidence → Preview → Approve → Apply → Pending → Advance clock → Verify → Ghost → Export audit.</p>
        <div className="receipt-actions">
          <Button action="open-case" primary onClick={() => ws.navigate('case')}>Open the analytics case</Button>
          <Button action="region-test" onClick={ws.actions.regionTest}>Test wrong-region delivery</Button>
          <a className="btn" href="/access.html#lumen">Open Lumen access lab ↗</a>
        </div>
        <p className="table-note">The EU negative control returns transport HTTP 200 with zero stored events. This models one local failure mode; it is not a claim about every real provider request.</p>
      </section>
      <h2 className="section-title">Available synthetic samples <span>{ws.samples.length}</span></h2>
      <p className="section-description">Reference payloads only. These services are not active connectors.</p>
      <div className="mock-sample-grid">
        {ws.samples.map(s => (
          <button type="button" key={s.path} className="sample-card" data-action="sample" data-path={s.path} disabled={ws.busy} onClick={() => ws.actions.sample(s.path)}>
            <span><Icon name="layers" size={15} />{s.provider}</span><strong>{s.path.split('/').at(-1)}</strong><small>{s.bytes} bytes · synthetic partial projection ↗</small>
          </button>
        ))}
      </div>
      <section className="mock-contract-card">
        <h2>Additional offline controls</h2>
        <p>The retained browser engine includes clean, missing refund, repeated delivery, duplicate purchase, price unit error and zero-net / two-error fixtures, plus an 8-order Google reference check.</p>
        <a className="btn" href="/legacy.html" target="_blank" rel="noopener">Open legacy fixture lab ↗</a>
        <p className="table-note">This separate lab uses browser-local snapshots and is not connected to the repair state above. The separate 937-order Revenue Bridge package was not supplied.</p>
      </section>
    </>
  );
}

export function HistoryPage({ ws }: { ws: Workspace }) {
  return (
    <>
      <Heading title="Evidence / Run history" description="Saved server-side snapshots and the append-only action journal."
        actions={<><Button action="detect" primary onClick={ws.actions.detect}>Detect &amp; save run</Button><Button action="export-audit" onClick={ws.actions.exportAudit}>Export audit</Button></>} />
      <section className="list-panel">
        <div className="panel-toolbar"><strong>Run snapshots</strong><span>Latest 20 · saved on this computer</span></div>
        {ws.history.length ? (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Run</th><th>Tick</th><th>Findings</th><th>USD gap</th><th>EUR gap</th><th></th></tr></thead>
            <tbody>
              {ws.history.map((r, i) => (
                <tr key={r.id}>
                  <td><strong>{r.kind}</strong><small className="mono">{r.id}</small></td>
                  <td>{r.tick}</td>
                  <td>{r.report.groups.reduce((n, g) => n + g.findings.length, 0)}</td>
                  <td className="money">{money(r.report.gap.USD, true)}</td>
                  <td className="money">{money(r.report.gap.EUR, true)}</td>
                  <td><Button action="snapshot" data-index={i} onClick={() => ws.actions.snapshot(i)}>Open snapshot</Button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <div className="empty-state"><h3>No saved scan yet</h3><p>Detect or Verify saves an immutable report snapshot.</p></div>}
      </section>
      <section className="mock-contract-card">
        <h2>Audit journal</h2>
        <div className="journal">
          {[...(ws.audit.journal || [])].reverse().map((j, i) => (
            <div className="journal-row" key={i}><span className="journal-dot"></span><div>
              <strong>{j.type}</strong><small>Tick {j.tick ?? j.clock ?? 0}{j.actor ? ` · ${j.actor}` : ''}</small>{j.cls && <code>{j.cls}</code>}
            </div></div>
          ))}
        </div>
      </section>
    </>
  );
}
