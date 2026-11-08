import { Badge, Button, Currencies, Drawer, Icon, JsonBlock } from '../../../shared';
import { CurrencyCards } from '../components/CurrencyCards';
import { CLASSES } from '../domain';
import type { Workspace } from '../useWorkspace';

export function WorkspaceModal({ ws }: { ws: Workspace }) {
  const modal = ws.modal;
  if (!modal) return null;
  let content: React.ReactNode;
  let footer: React.ReactNode;

  if (modal.kind === 'evidence') {
    const e = modal.data;
    content = (
      <>
        <p className="overlay-intro">Native-shaped local records and event IDs. Originals are retained; pending imports are separate from fresh visible readback.</p>
        <div className="evidence-columns">
          <JsonBlock title="Source ledger" data={e.source.length ? e.source : 'No counterpart in the declared source population.'} />
          <JsonBlock title="Destination · visible raw records" data={e.destination.length ? e.destination : 'No visible counterpart in these records.'} />
        </div>
        {!!e.pending_destination?.length && <JsonBlock title="Pending destination · not yet read back" data={e.pending_destination} />}
        {!!e.correction_receipts?.length && <JsonBlock title="Action receipts" data={e.correction_receipts} />}
      </>
    );
    footer = <Button action="export-modal" onClick={ws.actions.exportModal}>Export evidence</Button>;
  } else if (modal.kind === 'preview') {
    const groups = ws.preview?.groups || [];
    content = (
      <>
        <p className="overlay-intro">Review exact payloads and signed metric changes. Approval only records your decision; Apply is a separate action.</p>
        {groups.map(g => (
          <section className="preview-plan" key={g.class}>
            <label className="preview-select">
              <input type="checkbox" data-select={g.class} checked={ws.selected.has(g.class)} disabled={ws.busy} onChange={e => ws.actions.toggleGroup(g.class, e.target.checked)} />
              <span><strong>{CLASSES[g.class]?.title || g.class}</strong><small>{g.row_count ?? g.finding_ids.length} destination events · {g.action}</small></span>
            </label>
            <div className="preview-delta">Expected signed gap change <Currencies data={g.expected_signed_gap_change} /></div>
            <dl><dt>Approval SHA-256</dt><dd>{g.approval_hash}</dd></dl>
            <details><summary>Exact planned payloads</summary><pre>{JSON.stringify(g.payloads, null, 2)}</pre></details>
          </section>
        ))}
        <label className="approval-ack">
          <input id="approval-ack" type="checkbox" checked={ws.acknowledged} disabled={ws.busy} onChange={e => ws.actions.setAcknowledged(e.target.checked)} />
          <span>I reviewed the evidence and exact payloads. I approve only the checked groups for this local synthetic destination.</span>
        </label>
        <label className="actor-field">Approval actor<input id="approval-actor" value={modal.actor} maxLength={100} autoComplete="off" disabled={ws.busy} onChange={e => ws.actions.setActor(e.target.value)} /></label>
      </>
    );
    const none = !ws.selected.size || !ws.acknowledged;
    footer = (
      <>
        <Button action="approve" disabled={none} onClick={ws.actions.approve}>Approve selected groups</Button>
        <Button action="apply" primary disabled={none || !modal.approved} onClick={ws.actions.apply}>Apply approved selection</Button>
      </>
    );
  } else if (modal.kind === 'mapping') {
    content = (
      <>
        <p className="overlay-intro">The same transaction is present under a renamed event. Accepting this rule updates local classification and creates zero destination events.</p>
        <div className="mapping-rule"><code>premium_paid_v2</code><Icon name="arrow" /><code>purchase</code></div>
        <JsonBlock title="Matching source and destination evidence" data={modal.data} />
        <label className="approval-ack">
          <input id="mapping-ack" type="checkbox" checked={modal.acknowledged} disabled={ws.busy} onChange={e => ws.actions.setMappingAck(e.target.checked)} />
          <span>I approve this local mapping rule after reviewing the matching identity.</span>
        </label>
      </>
    );
    footer = <Button action="map" primary disabled={!modal.acknowledged} onClick={ws.actions.map}>Accept local mapping</Button>;
  } else if (modal.kind === 'reset') {
    content = <p className="overlay-intro">Reset this local demo to the fixed nine-account seed? This clears its approvals, corrections, mappings, audit journal and saved runs. Export your audit first if you need it.</p>;
    footer = <><Button action="export-audit" onClick={ws.actions.exportAudit}>Export audit first</Button><Button action="reset" primary onClick={ws.actions.reset}>Reset local demo</Button></>;
  } else if (modal.kind === 'snapshot') {
    content = (
      <>
        <div className="warning-callout">Historical snapshot · read-only · tick {modal.data.tick}. Current repair actions always use the fresh active case.</div>
        <CurrencyCards report={modal.data.report} />
        <JsonBlock title="Saved report" data={modal.data} />
      </>
    );
    footer = <Button action="export-modal" onClick={ws.actions.exportModal}>Export snapshot</Button>;
  } else {
    content = <JsonBlock title={modal.title} data={modal.data} />;
    footer = <Button action="export-modal" onClick={ws.actions.exportModal}>Download</Button>;
  }

  return (
    <Drawer eyebrow="LOCAL EVIDENCE WORKSPACE" title={modal.title} titleId="dialog-title" busy={ws.busy} onClose={ws.closeModal}
      closeAction="close-modal" closeLabel={<Icon name="close" size={20} />}
      labels={modal.kind === 'preview' && modal.approved ? <Badge tone="green">Approval saved</Badge> : null}
      footer={<>{footer}<Button action="close-modal" onClick={ws.closeModal}>Close</Button></>}>
      {content}
    </Drawer>
  );
}
