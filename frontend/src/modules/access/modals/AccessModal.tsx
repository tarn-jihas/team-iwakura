import { Badge, Button, Drawer } from '../../../shared';
import type { Access } from '../useAccess';

export function AccessModal({ ax }: { ax: Access }) {
  const modal = ax.modal;
  if (!modal) return null;
  let body: React.ReactNode;
  let actions: React.ReactNode;

  if (modal.kind === 'plan' && ax.plan) {
    const p = ax.plan;
    body = (
      <>
        <p className="overlay-intro">Review the exact accounts, unchanged entitlement expiry and proposed local projection/cache changes. Approval records a decision; Apply performs the resync.</p>
        <div className="access-plan-summary"><Badge tone="blue">{`${p.entries.length} accounts selected`}</Badge><span>Valid until {p.expires_at}</span></div>
        <dl><dt>Plan ID</dt><dd>{p.id}</dd><dt>Plan SHA-256</dt><dd>{p.plan_hash}</dd></dl>
        {p.entries.map(entry => (
          <details className="access-plan-entry" key={entry.account_id}><summary>{entry.account_id} · bounded current-state resync</summary><pre>{JSON.stringify(entry, null, 2)}</pre></details>
        ))}
        {!!p.exclusions?.length && <section className="mock-json-block"><h3>Excluded accounts</h3><pre>{JSON.stringify(p.exclusions, null, 2)}</pre></section>}
        <label className="approval-ack">
          <input type="checkbox" id="access-ack" checked={ax.ack} disabled={ax.busy} onChange={e => ax.actions.setAck(e.target.checked)} />
          <span>I reviewed the exact account scope and evidence. I approve this local licence/cache repair without extending source entitlements.</span>
        </label>
        <label className="actor-field">Approval actor<input id="access-actor" value={ax.actor} maxLength={100} disabled={ax.busy} onChange={e => ax.actions.setActor(e.target.value)} /></label>
        <p className="table-note">Plan expiry and source freshness use the explicit mock clock in UTC. Signature authentication uses actual wall-clock time.</p>
      </>
    );
    actions = (
      <>
        <Button action="approve" disabled={!ax.ack || !ax.actor.trim()} onClick={ax.actions.approve}>Approve this repair plan</Button>
        <Button action="apply" primary disabled={!ax.ack || !ax.approved} onClick={() => ax.actions.apply(false)}>Apply approved repair</Button>
      </>
    );
  } else if (modal.kind === 'reset') {
    body = <p className="overlay-intro">Reset the access simulator to {modal.variant ? 'a different synthetic 100-account population' : 'the default 100-account scenario'}? This clears this access run’s approvals, repairs and history. The analytics run is preserved.</p>;
    actions = <><Button action="export" onClick={ax.actions.exportBundle}>Export current evidence first</Button><Button action="reset" primary onClick={ax.actions.reset}>Reset access run</Button></>;
  } else {
    const data = modal.kind === 'json' ? modal.data : null;
    body = <section className="mock-json-block"><h3>{modal.title}</h3><pre>{JSON.stringify(data, null, 2)}</pre></section>;
    actions = <Button action="modal-download" onClick={ax.actions.modalDownload}>Download evidence</Button>;
  }

  return (
    <Drawer eyebrow="PAID ACCESS RECOVERY" title={modal.title} titleId="access-dialog-title" busy={ax.busy} onClose={ax.closeModal}
      closeAction="close" closeLabel="×"
      labels={ax.approved && modal.kind === 'plan' ? <Badge tone="green">Human approval saved</Badge> : null}
      footer={<>{actions}<Button action="close" onClick={ax.closeModal}>Close</Button></>}>
      {body}
    </Drawer>
  );
}
