import { Badge, Button, Currencies, Heading, Icon, MockBadge } from '../../../shared';
import { counts, stage } from '../domain';
import type { Workspace } from '../useWorkspace';

export function CasesPage({ ws }: { ws: Workspace }) {
  const report = ws.report!;
  const [status, tone] = stage(report);
  const access = ws.access;
  const affected = access && (access.recovery.target_count || access.summary.confirmed);
  const accessCard = access ? (
    <div className="mock-case-entry">
      <div>
        <span className="case-code mono">ACCESS-001 · PAID ACCESS</span>
        <h2>Paid access denied after renewal cancellation</h2>
        <p>Current entitlement <Icon name="arrow" size={12} /> Lumen projection, cache &amp; premium gate</p>
        <div className="case-meta">{access.summary.in_scope} accounts in scope · {access.incident.id ? `${affected} affected · ${access.summary.inconclusive} inconclusive` : 'Run detection to assess the incident'}</div>
      </div>
      <div className="case-entry-end">
        <Badge tone={access.recovery.target_count && !access.recovery.unresolved_count ? 'green' : 'amber'}>
          {access.recovery.target_count ? `${access.recovery.verified_count} gate-verified / ${access.recovery.unresolved_count} unresolved` : 'Needs detection'}
        </Badge>
        <a className="btn btn-primary" href="/access.html">Open access incident</a>
        <a className="text-button" href="/access.html#lumen">Open Lumen app ↗</a>
      </div>
    </div>
  ) : (
    <div className="mock-case-entry"><div>
      <span className="case-code mono">PAID ACCESS RECOVERY</span>
      <h2>Restart the server to load the access module</h2>
      <p>The analytics workspace remains available. Stop the older server and run npm start again to enable Lumen recovery.</p>
    </div></div>
  );
  const analyticsCard = (
    <div className="mock-case-entry">
      <div>
        <span className="case-code mono">RCN-001 · ANALYTICS</span>
        <h2>When subscription events drift</h2>
        <p>Adapty-shaped ledger <Icon name="arrow" size={12} /> Mixpanel-shaped analytics</p>
        <div className="case-meta">mock-lumen · mock-mixpanel-eu · Production · 9 sample accounts</div>
      </div>
      <div className="case-entry-end">
        <Badge tone={tone}>{status}</Badge>
        <div className="case-money"><Currencies data={report.gap} /></div>
        <Button action="open-case" primary onClick={() => ws.navigate('case')}>Open analytics case</Button>
      </div>
    </div>
  );
  return (
    <>
      <Heading title="Cases" description="Investigate access incidents and subscription data, with the evidence to act." />
      <div className="overview-strip">
        <div className="overview-stat"><strong>{access ? 2 : 1}</strong><span className="stat-label">Available cases</span><span className="stat-icon"><Icon name="cases" size={25} /></span></div>
        <div className="overview-stat"><strong>{counts(report).findings}</strong><span className="stat-label">Analytics findings</span><span className="stat-icon"><Icon name="search" size={25} /></span></div>
        <div className="overview-stat"><strong>{access?.recovery.verified_count ?? '—'}</strong><span className="stat-label">Access gates verified</span><span className="stat-icon"><Icon name="shield" size={25} /></span></div>
      </div>
      <section className="list-panel">
        <div className="panel-toolbar">
          <label>Case type <select id="case-type" aria-label="Filter case type" value={ws.caseType} onChange={e => ws.setCaseType(e.target.value)}>
            <option value="all">All cases</option><option value="access">Paid access</option><option value="analytics">Analytics</option>
          </select></label>
          <MockBadge />
        </div>
        {ws.caseType !== 'analytics' && accessCard}
        {ws.caseType !== 'access' && analyticsCard}
        <div className="panel-footer"><span>FULL MOCK · independent access and analytics state</span><span>Human-approved repairs</span></div>
      </section>
    </>
  );
}
