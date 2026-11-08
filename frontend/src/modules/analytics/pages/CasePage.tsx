import { Badge, Button, Heading, Icon, money, type IconName, type Tone } from '../../../shared';
import { CurrencyCards } from '../components/CurrencyCards';
import { counts, groupStatus, receiptStatus, stage, visibleGroups } from '../domain';
import type { Tab, Workspace } from '../useWorkspace';

export function CasePage({ ws }: { ws: Workspace }) {
  const report = ws.report!;
  const [status, tone] = stage(report);
  const c = counts(report);
  const tabs: Array<[Tab, string, number]> = [['findings', 'Findings', c.findings], ['operations', 'Operations', ws.operations.length], ['receipt', 'Case receipt', report.action_count]];
  return (
    <>
      <button type="button" className="back-link" data-page="cases" onClick={() => ws.navigate('cases')}>← All cases</button>
      <Heading title="When subscription events drift" description="Compare the source ledger with analytics. Repair only what the evidence supports."
        actions={<><Button action="export-report" onClick={ws.actions.exportReport}>Export report</Button><Button action="detect" primary onClick={ws.actions.detect}>{ws.busy ? 'Working…' : 'Detect'}</Button></>} />
      <div className="mock-case-meta"><Badge>RCN-001</Badge><Badge tone={tone}>{status}</Badge><span>mock-lumen</span><span>EU · mock-mixpanel-eu</span><span>Production</span></div>
      <CurrencyCards report={report} />
      <div className="metric-contract"><Icon name="shield" size={14} /><span><strong>Explicit effective metric:</strong> query-deduped events + signed reconcile_correction events. Raw history stays intact. This is a synthetic analytical difference.</span><button type="button" className="text-button" data-action="metric" onClick={ws.actions.metric} disabled={ws.busy}>View contract ↗</button></div>
      <div className="mock-flow"><span className="flow-done"><Icon name="check" size={12} /> Detect</span><i>→</i><span>Review &amp; preview</span><i>→</i><span>Human approval</span><i>→</i><span className={c.pending ? 'flow-active' : undefined}>Apply &amp; pending</span><i>→</i><span>Fresh verification</span></div>
      <div className="mock-workspace">
        <section className="mock-work-main">
          <div className="mock-tabbar" role="tablist" aria-label="Case views">
            {tabs.map(([id, label, n]) => (
              <button type="button" role="tab" key={id} aria-selected={ws.tab === id} data-tab={id} className={ws.tab === id ? 'active' : ''} onClick={() => ws.setTab(id)}>{label}<span>{n}</span></button>
            ))}
          </div>
          {ws.tab === 'findings' ? <Findings ws={ws} /> : ws.tab === 'operations' ? <Operations ws={ws} /> : <Receipt ws={ws} />}
        </section>
        <ReviewPanel ws={ws} />
      </div>
    </>
  );
}

function Findings({ ws }: { ws: Workspace }) {
  const groups = visibleGroups(ws.report!, ws.search, ws.filter);
  return (
    <>
      <div className="mock-finding-toolbar">
        <label className="search-field"><Icon name="search" size={14} /><input id="finding-search" placeholder="Search findings or transaction ID" value={ws.search} aria-label="Search findings" onChange={e => ws.setSearch(e.target.value)} /></label>
        <select id="finding-filter" aria-label="Filter findings" value={ws.filter} onChange={e => ws.setFilter(e.target.value)}>
          <option value="all">All groups</option><option value="repair">Repairable</option><option value="manual">Manual investigation</option>
        </select>
      </div>
      <div className="mock-groups">
        {groups.length ? groups.map(([cls, meta]) => <GroupCard key={cls} ws={ws} cls={cls} meta={meta} />) : <div className="empty-state">No matching findings. Try another search.</div>}
      </div>
    </>
  );
}

function GroupCard({ ws, cls, meta }: { ws: Workspace; cls: string; meta: { title: string; icon: IconName; note: string } }) {
  const report = ws.report!;
  const group = report.groups.find(g => g.cls === cls);
  const status = groupStatus(report, cls);
  const tone: Tone = ['verified', 'mapped', 'expected'].includes(status) ? 'green' : status === 'manual' ? 'blue' : 'amber';
  const pending = counts(report).pending;
  const label = status === 'manual' ? 'Manual investigation' : status === 'expected' ? 'Expected / no action' : status[0].toUpperCase() + status.slice(1);
  return (
    <article className={`mock-group ${status}`} data-class={cls}>
      <div className="mock-group-top"><span className="group-icon"><Icon name={meta.icon} size={18} /></span><div className="group-title"><h3>{meta.title}</h3><span>{cls}</span></div><Badge tone={tone}>{label}</Badge></div>
      <p>{meta.note}</p>
      {group ? (
        <div className="mock-finding-list">
          {group.findings.map(f => (
            <button type="button" key={f.id ?? f.txn} className="mock-finding" data-action="evidence" data-txn={f.txn} disabled={ws.busy} onClick={() => ws.actions.evidence(f.txn)}>
              <span><strong>{f.txn}</strong><small>{f.user} · {f.event_class}</small></span>
              <span>{money(f.delta, true)} <small>{f.currency}</small></span>
              <span className="evidence-link">Evidence ↗</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="resolved-note"><Icon name="check" size={13} />{cls === 'UNMAPPED_EVENT_NAME' ? 'Mapping accepted locally. No new destination event.' : 'Fresh destination read no longer reports these findings.'}</div>
      )}
      {group?.writes ? (
        <div className="group-action">
          <span>{status === 'pending' ? 'Waiting for mock ingestion' : status === 'approved' ? 'Approval recorded; re-open plan to apply' : 'Human approval required'}</span>
          <Button action={status === 'pending' ? 'receipt' : 'preview'} data-cls={cls} disabled={pending > 0 && status !== 'pending'}
            onClick={status === 'pending' ? () => ws.setTab('receipt') : ws.actions.preview}>{status === 'pending' ? 'View pending receipt' : 'Review & preview'}</Button>
        </div>
      ) : cls === 'UNMAPPED_EVENT_NAME' && group ? (
        <div className="group-action">
          <code>{pending ? 'Advance clock before mapping' : 'premium_paid_v2 → purchase'}</code>
          <Button action="map-preview" disabled={pending > 0} onClick={ws.actions.mapPreview}>Review mapping</Button>
        </div>
      ) : null}
    </article>
  );
}

function ReviewPanel({ ws }: { ws: Workspace }) {
  const report = ws.report!;
  const c = counts(report);
  return (
    <aside className="mock-review">
      <div className="review-panel-title"><Icon name="spark" size={17} /><h2>Review assistant</h2><Badge tone="blue">MOCK</Badge></div>
      <p className="review-caption">Deterministic explanation · no model connected</p>
      <div className="review-answer">
        <strong>What do the records tell us?</strong>
        <p>{c.repair ? `${c.repair} repair groups are still detected. Review their raw evidence before approving a bounded plan.` : 'The supported repair findings have cleared. The destination-only transaction still needs a human investigation.'}</p>
        <p>The {report.gap.EUR === '0.00' ? 'EUR metric now matches' : 'EUR mismatch is observable in the event amounts'}. It does not prove recovered revenue or another store charge.</p>
        <button type="button" className="text-button" data-action="evidence" data-txn="txn_price" disabled={ws.busy} onClick={() => ws.actions.evidence('txn_price')}>Inspect the price evidence ↗</button>
      </div>
      <div className="review-proof">
        <span><Icon name="shield" size={14} />Confidence: deterministic / mock</span>
        <span><Icon name="layers" size={14} />Provenance: synthetic local ledger</span>
        <span><Icon name="clock" size={14} />Fresh state at mock tick {report.clock}</span>
      </div>
      <div className="review-controls">
        <h3>Readback controls</h3><p>Imports become visible after one explicit mock tick.</p>
        <Button action="advance" onClick={ws.actions.advance}>{`Advance mock clock${c.pending ? ` (${c.pending} pending)` : ''}`}</Button>
        <Button action="verify" primary onClick={ws.actions.verify}>Fresh read / Verify</Button>
        <Button action="export-audit" onClick={ws.actions.exportAudit}>Export audit receipt</Button>
      </div>
      <div className="review-limit"><strong>What remains unknown?</strong><p>The ghost&#39;s origin and any production root cause. Raw corrections change only this defined effective metric.</p></div>
    </aside>
  );
}

function Operations({ ws }: { ws: Workspace }) {
  return (
    <>
      <div className="table-scroll"><table className="data-table mock-operations">
        <thead><tr><th>Transaction / user</th><th>Class / scope</th><th>Source</th><th>Effective destination</th><th>Difference</th><th>Status</th></tr></thead>
        <tbody>
          {ws.operations.map((o, i) => (
            <tr key={`${o.txn}-${o.event_class}-${i}`}>
              <td><button type="button" className="text-button mono" data-action="evidence" data-txn={o.txn} disabled={ws.busy} onClick={() => ws.actions.evidence(o.txn)}>{o.txn}</button><small>{o.user}</small></td>
              <td>{o.event_class}<small>{o.environment}</small></td>
              <td className="money">{money(o.source_amount)} {o.currency}</td>
              <td className="money">{money(o.destination_amount)}</td>
              <td className="money">{money(o.delta, true)}</td>
              <td><Badge>{o.status}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="table-note">Money is calculated on the server with Decimal. Sandbox is excluded from the production totals.</p>
    </>
  );
}

function Receipt({ ws }: { ws: Workspace }) {
  const report = ws.report!;
  const actions = Object.entries(ws.audit.actions || {});
  return (
    <>
      <div className="receipt-summary">
        <h2>Case receipt</h2>
        <p>{report.approval_count} approved groups · {report.action_count} accepted writes · {counts(report).pending} pending visibility</p>
        <div className="receipt-actions">
          <Button action="export-audit" onClick={ws.actions.exportAudit}>Export audit receipt</Button>
          <Button action="verify" primary onClick={ws.actions.verify}>Verify with fresh read</Button>
          {actions.length > 0 && <Button action="retry-apply" onClick={ws.actions.retryApply}>Retry approved apply</Button>}
        </div>
      </div>
      {actions.length ? actions.map(([id, a]) => {
        const [label, tone] = receiptStatus(report, ws.audit, id, a);
        return (
          <article className="receipt-row" key={id}>
            <div><Badge tone={tone}>{label}</Badge><strong>{a.group}</strong></div>
            <p>{a.finding}</p>
            <dl><dt>Action ID</dt><dd>{id}</dd><dt>Payload SHA-256</dt><dd>{a.payload_hash}</dd><dt>Approval actor</dt><dd>{a.approval_actor}</dd><dt>Accepted → visible tick</dt><dd>{a.accepted_at_tick} → {a.visible_at_tick}</dd></dl>
          </article>
        );
      }) : <div className="empty-state"><h3>No writes accepted yet</h3><p>Preview and approve an eligible repair group first.</p></div>}
    </>
  );
}

