import { Fragment, useContext } from 'react';
import { Badge, BusyContext, Button, Heading } from '../../../shared';
import { orderedAccounts, PAGE_SIZE, recoveryOutcome, STATUS } from '../domain';
import type { Access, Tab } from '../useAccess';

export function IncidentPage({ ax }: { ax: Access }) {
  const report = ax.report!;
  const r = report.recovery;
  const s = report.summary;
  const scanned = Boolean(report.incident.id);
  const [outcome, outcomeTone] = recoveryOutcome(r);
  const stats: Array<[string, number | string, string]> = [
    ['Accounts in scope', s.in_scope, 'Known client registry'],
    ['Evaluated', scanned ? s.evaluated : '—', 'Identity + fresh source'],
    ['Affected accounts', scanned ? r.target_count || s.confirmed : '—', r.target_count ? 'Approved incident cohort' : scanned ? 'Confirmed by current gate' : 'Run detection first'],
    ['Inconclusive', scanned ? s.inconclusive : '—', 'Excluded from all writes'],
  ];
  const tabs: Array<[Tab, string, number | undefined]> = [['accounts', 'Accounts', report.accounts.length], ['repair', 'Repair & verify', r.target_count], ['scope', 'Scope & exclusions', s.inconclusive]];
  return (
    <>
      <Heading title="Paid access denied after renewal cancellation" description="Find the affected accounts, approve a bounded resync and prove access at the app’s real gate."
        actions={<><Button action="lumen" onClick={() => ax.navigate('lumen')}>Open Lumen app</Button><Button action="export" onClick={ax.actions.exportBundle}>Export evidence bundle</Button></>} />
      <div className="mock-case-meta"><Badge>ACCESS-001</Badge><Badge tone={outcomeTone}>{outcome}</Badge><span>{report.manifest.app}</span><span>Production · premium_export</span></div>
      <div className="access-stats">
        {stats.map(([label, value, note]) => <section className="access-stat" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></section>)}
      </div>
      <div className="access-cause"><span className="access-cause-icon">◈</span><div>
        <strong>{r.root_cause_status === 'pending' ? 'Root cause pending' : 'Demo consumer state: ' + r.root_cause_status}</strong>
        <p>Restoring a licence changes the current app projection and cache. It does not fix or deploy the consumer that caused the incident.</p>
      </div></div>
      <IncidentForm ax={ax} />
      <div className="mock-flow"><span>1. Collect actual app events</span><i>→</i><span>2. Scan the registry</span><i>→</i><span>3. Preview &amp; approve</span><i>→</i><span>4. Resync local licence</span><i>→</i><span>5. Probe the same gate</span></div>
      <div className="mock-tabbar" role="tablist" aria-label="Access case views">
        {tabs.map(([id, title, n]) => (
          <button type="button" role="tab" key={id} aria-selected={ax.tab === id} className={ax.tab === id ? 'active' : ''} data-tab={id} onClick={() => ax.setTab(id)}>{title}<span>{n}</span></button>
        ))}
      </div>
      {ax.tab === 'accounts' ? <Accounts ax={ax} /> : ax.tab === 'repair' ? <Repair ax={ax} /> : <Scope ax={ax} />}
    </>
  );
}

function IncidentForm({ ax }: { ax: Access }) {
  const busy = useContext(BusyContext);
  const w = ax.window!;
  return (
    <form id="incident-form" className="access-window" onSubmit={e => { e.preventDefault(); ax.actions.detect(); }}>
      <div><h2>Incident window</h2><p>Business occurrence time in UTC. Candidate grouping is followed by a full registry scan.</p></div>
      <label>From (UTC)<input type="datetime-local" step="1" id="window-start" value={w.start} required onChange={e => ax.setWindowField('start', e.target.value)} /></label>
      <label>To (UTC)<input type="datetime-local" step="1" id="window-end" value={w.end} required onChange={e => ax.setWindowField('end', e.target.value)} /></label>
      <label>Consumer version<select id="window-handler" value={w.handler} onChange={e => ax.setWindowField('handler', e.target.value)}>
        <option value="cancel-handler-v1">Faulty v1</option><option value="cancel-handler-v2">Fixed v2</option>
      </select></label>
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Working…' : 'Detect blast radius'}</button>
    </form>
  );
}

function Accounts({ ax }: { ax: Access }) {
  const report = ax.report!;
  const rows = orderedAccounts(report.accounts, ax.filter, ax.query);
  const maxPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  const page = Math.min(ax.page, maxPage);
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const eligible = ax.eligible();
  return (
    <section className="list-panel">
      <div className="panel-toolbar access-account-toolbar">
        <label className="search-field"><input id="account-search" aria-label="Search accounts" placeholder="Search account ID or reason" value={ax.query} onChange={e => ax.setQuery(e.target.value)} /></label>
        <select id="account-filter" aria-label="Filter access accounts" value={ax.filter} onChange={e => ax.setFilter(e.target.value)}>
          <option value="all">All outcomes</option>
          {Object.entries(STATUS).map(([id, [label]]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <div className="access-selection">
        <span><strong>{ax.selected.size}</strong> accounts selected</span>
        <Button action="select-eligible" disabled={!eligible.length} onClick={ax.actions.selectEligible}>{`Select all eligible (${eligible.length})`}</Button>
        <Button action="clear-selection" disabled={!ax.selected.size} onClick={ax.actions.clearSelection}>Clear selection</Button>
        <Button action="preview" primary disabled={!ax.selected.size} onClick={ax.actions.preview}>Preview selected repair</Button>
      </div>
      <div className="table-scroll"><table className="data-table access-account-table">
        <thead><tr><th>Select</th><th>Account / evidence</th><th>Source entitlement</th><th>Actual client gate</th><th>Outcome</th></tr></thead>
        <tbody>
          {visible.length ? visible.map(a => {
            const [statusLabel, statusTone] = STATUS[a.status] || [a.status, 'plain'];
            return (
              <tr key={a.id}>
                <td><input type="checkbox" data-account={a.id} aria-label={`Select ${a.id} for repair`} checked={ax.selected.has(a.id)} disabled={!a.eligible || ax.busy} onChange={e => ax.actions.toggleAccount(a.id, e.target.checked)} /></td>
                <td><button type="button" className="text-button mono" data-action="evidence" data-user={a.id} disabled={ax.busy} onClick={() => ax.actions.evidence(a.id)}>{a.id} ↗</button><small>{a.observed_customer_denial ? 'Observed customer denial' : 'No customer attempt established'}</small></td>
                <td>{a.source_active === true ? 'Active' : a.source_active === false ? 'Inactive / expired' : 'Unknown'}<small>{a.source_freshness}{a.source_expires_at ? ' · expires ' + a.source_expires_at.slice(0, 10) : ''}</small></td>
                <td><Badge tone={a.gate?.allowed ? 'green' : 'plain'}>{a.gate?.allowed ? 'Allows access' : 'Denies access'}</Badge><small>{a.gate?.reason || a.reason}</small></td>
                <td><Badge tone={statusTone}>{statusLabel}</Badge><small>{a.reason}</small></td>
              </tr>
            );
          }) : <tr><td colSpan={5}><div className="empty-state">No accounts match this view.</div></td></tr>}
        </tbody>
      </table></div>
      <div className="panel-footer">
        <span>{rows.length ? page * PAGE_SIZE + 1 : 0}–{Math.min((page + 1) * PAGE_SIZE, rows.length)} of {rows.length} accounts</span>
        <div>
          <Button action="previous" disabled={page === 0} onClick={ax.actions.previous}>Previous</Button>
          <Button action="next" disabled={page === maxPage} onClick={ax.actions.next}>Next</Button>
        </div>
      </div>
    </section>
  );
}

function Repair({ ax }: { ax: Access }) {
  const report = ax.report!;
  const r = report.recovery;
  const unresolved = r.unresolved_ids || [];
  const plans = report.plans || [];
  const [outcome, tone] = recoveryOutcome(r);
  return (
    <>
      <section className="access-recovery-card">
        <div>
          <span className="lab-eyebrow">VERIFIED OUTCOMES</span>
          <h2>{r.verified_count || 0}<small> / {r.target_count || 0} accounts verified at the gate</small></h2>
          <p>{r.unresolved_count || 0} unresolved · {report.summary.inconclusive} inconclusive accounts remain excluded.</p>
        </div>
        <Badge tone={tone}>{outcome}</Badge>
        <div className="receipt-actions">
          <Button action="verify" primary disabled={!ax.activePlanId} onClick={ax.actions.verify}>Verify actual gates</Button>
          <Button action="repeat" disabled={!ax.activePlanId} onClick={() => ax.actions.apply(true)}>Repeat approved apply</Button>
          <Button action="retry-preview" disabled={!unresolved.length} onClick={ax.actions.retryPreview}>{`Preview fresh retry (${unresolved.length})`}</Button>
          <Button action="export" onClick={ax.actions.exportBundle}>Export evidence bundle</Button>
        </div>
      </section>
      <div className="source-intro-note"><div><strong>Write acceptance is not access restoration.</strong> Verification calls the same premium gate as the Lumen app. A successful projection write with stale cache remains unresolved. A retry needs a new preview, fresh checks and approval.</div></div>
      {plans.length ? plans.slice().reverse().map(p => (
        <section className="receipt-row" key={p.id}>
          <div><Badge>{p.status || (p.approved ? 'Approved' : 'Preview')}</Badge><strong>{p.id}</strong></div>
          <p>{p.entries?.length ?? p.account_ids?.length ?? '—'} accounts · {p.expires_at || ''}</p>
          <dl><dt>Plan SHA-256</dt><dd>{p.plan_hash}</dd></dl>
          <div className="receipt-actions"><Button action="inspect-plan" data-plan={p.id} onClick={() => ax.actions.inspectPlan(p.id)}>Inspect plan</Button></div>
        </section>
      )) : <div className="empty-state"><h3>No repair plan yet</h3><p>Select confirmed accounts in the Accounts tab and preview their exact resync.</p></div>}
    </>
  );
}

function Scope({ ax }: { ax: Access }) {
  const report = ax.report!;
  return (
    <div className="access-scope-grid">
      <section className="mock-contract-card">
        <h2>Coverage and exclusions</h2>
        <dl>{Object.entries(report.summary).map(([key, value]) => <Fragment key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{String(value)}</dd></Fragment>)}</dl>
        <p className="table-note">A previous payment is not proof of current access. Unknown identity, unavailable/stale entitlement, unsupported policy and incomplete processing never receive a repair.</p>
      </section>
      <section className="mock-contract-card">
        <h2>What this repair changes</h2>
        <p>The current client projection and cache are refreshed from the current source entitlement. The original entitlement expiry stays unchanged.</p>
        <p>Real charges, refunds, renewal choices and source licences are outside this local repair.</p>
        <h2>Current incident</h2>
        <pre className="access-inline-json">{JSON.stringify(report.incident, null, 2)}</pre>
      </section>
    </div>
  );
}
