export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const LIVE_MODE = 'LIVE_ADAPTY_SEEDED';
export function isLiveMode(report) { return report?.mode === LIVE_MODE; }
export function provenanceLabel(report) { return isLiveMode(report) ? 'Real Adapty reads · synthetic purchase records' : 'Local synthetic evidence'; }
export function paymentLabel(account, report) { return isLiveMode(report) ? 'Not independently verified' : account?.payment_state === 'paid' ? 'Recorded synthetic purchase' : statusLabel(account?.payment_state || 'Not checked'); }

const labels = {
  activation_missing: 'Activation missing', access_not_delivered: 'Access not delivered', healthy: 'Healthy',
  inconclusive: 'Check source or identity', policy_denial: 'Blocked by app rule', legitimate_denial: 'Access denied as expected',
  restored: 'Restored', pending_verification: 'Pending verification', awaiting_client_action: 'Awaiting client action',
  accepted: 'Write accepted · access check pending', verified: 'Verified', failed: 'Action failed',
  unknown_outcome: 'Result not confirmed · check evidence', blocked: 'Blocked by a precondition',
  confirmed: 'Confirmed discrepancy', potential: 'Potentially affected',
  outside_incident: 'Outside incident', not_scanned: 'Not evaluated', unclassified: 'Not evaluated',
  access_verified: 'Access verified', partial_recovery: 'Partial recovery', recovery_unresolved: 'Recovery unresolved',
};
export function statusLabel(status) { return labels[status] || (status ? String(status).replace(/[_-]+/g, ' ') : 'Status unavailable'); }
export function targetLabel(action) {
  const target = action?.target;
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return action?.account_id || 'Not recorded';
  if (target.transaction_id) return `Purchase ${target.transaction_id}`;
  if (target.product_id || target.price_id) return [target.product_id, target.price_id].filter(Boolean).join(' / ');
  return target.user_id || target.feature || action?.account_id || 'Configuration';
}
export function statusTone(status) {
  if (['restored', 'healthy', 'verified'].includes(status)) return 'green';
  if (['failed', 'blocked'].includes(status)) return 'red';
  if (status === 'unknown_outcome') return 'amber';
  if (['confirmed', 'potential', 'activation_missing', 'access_not_delivered', 'policy_denial', 'pending_verification', 'awaiting_client_action'].includes(status)) return 'amber';
  return 'blue';
}
export function safeReportHtml(bundle) {
  const actions = Array.isArray(bundle?.actions) ? bundle.actions : [];
  const summary = bundle?.summary || {}, recovery = bundle?.recovery || {}, incident = bundle?.incident || {};
  const remaining = Array.isArray(bundle?.accounts)
    ? bundle.accounts.filter(a => a.eligible || ['inconclusive', 'awaiting_client_action', 'potential'].includes(a.status)).map(a => `${a.id}: ${statusLabel(a.reason || a.status)}`)
    : actions.filter(a => !['verified', 'restored', 'healthy', 'completed'].includes(a.status)).map(a => `${targetLabel(a)}: ${a.next_step || statusLabel(a.status)}`);
  const rows = actions.map(a => `<tr><td>${escapeHtml(a.owner)}</td><td>${escapeHtml(targetLabel(a))}${a.account_id ? `<br>${escapeHtml(a.account_id)}` : ''}</td><td>${escapeHtml(statusLabel(a.status))}</td><td>${escapeHtml(a.started_at || 'Not recorded')}<br>${escapeHtml(a.finished_at || '')}</td><td>${escapeHtml(a.evidence_ref)}<details><summary>Preconditions</summary><pre>${escapeHtml(JSON.stringify(a.preconditions || {}, null, 2))}</pre></details></td><td>${escapeHtml(a.next_step)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Payment Activation Recovery report</title>
    <style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#222}table{border-collapse:collapse;width:100%}th,td{text-align:left;border:1px solid #ddd;padding:8px;overflow-wrap:anywhere}th{background:#f5f3ff}li{margin:5px 0}.scroll{overflow:auto}pre{white-space:pre-wrap}</style></head><body>
    <h1>${isLiveMode(bundle) ? 'Lumen access delivery recovery' : 'Payment Activation Recovery'}</h1><p>${isLiveMode(bundle) ? 'LIVE ADAPTY · SEEDED DATA · ' : ''}${escapeHtml(provenanceLabel(bundle))} · ${escapeHtml(bundle?.manifest?.app_title || bundle?.manifest?.app || 'App unavailable')} · ${escapeHtml(bundle?.manifest?.environment || 'Environment unavailable')}</p>
    <h2>Recovery result</h2><p><strong>${escapeHtml(summary.confirmed ?? 0)} confirmed affected · ${isLiveMode(bundle) ? `${escapeHtml(recovery.entitlement_verified ?? 0)} entitlements verified` : `${escapeHtml(recovery.activation_verified ?? 0)} activations verified`} · ${escapeHtml(recovery.access_verified ?? 0)} accesses verified · ${escapeHtml(recovery.unresolved ?? 0)} unresolved · ${escapeHtml(summary.inconclusive ?? 0)} inconclusive</strong></p>
    ${isLiveMode(bundle) ? '<p>Recovery basis: Adapty entitlement delivery. Payment state was not independently verified.</p>' : ''}
    <h2>Incident and scope</h2><p>${escapeHtml(incident.id || 'No incident recorded')} · ${escapeHtml(incident.window_start || 'Start unavailable')} to ${escapeHtml(incident.window_end || 'End unavailable')}</p><p>${escapeHtml(summary.in_scope ?? 0)} in scope · ${escapeHtml(summary.evaluated ?? 0)} evaluated</p>
    <h2>Cause assessment</h2><p>${escapeHtml(statusLabel(recovery.root_cause_status))} · ${escapeHtml(recovery.root_cause_certainty || 'Certainty unavailable')}</p>
    <h2>Actions and responsibilities</h2><div class="scroll"><table><thead><tr><th>Owner</th><th>Target</th><th>Status</th><th>Started / finished</th><th>Evidence reference</th><th>Next step</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No recorded actions</td></tr>'}</tbody></table></div>
    <h2>Remaining work</h2><ul>${remaining.map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>No unresolved account was listed in this snapshot.</li>'}</ul>
    <h2>Evidence coverage</h2><p>${bundle?.coverage?.complete === true ? 'Complete' : 'Incomplete or unavailable'}</p><ul>${(bundle?.coverage?.gaps || []).map(g => `<li>${escapeHtml(typeof g === 'string' ? g : g.reason || g.source || 'Source evidence unavailable')}</li>`).join('')}</ul></body></html>`;
}

export function summaryView(report) {
  const s = report?.summary || {}, r = report?.recovery || {};
  const coverage = report?.coverage || {};
  return `<section class="recovery-summary" aria-label="Incident summary">
    <article><span>Source checks</span><strong>${coverage.complete === true ? 'Complete' : coverage.complete === false ? 'Some checks could not finish' : 'Not run yet'}</strong><small>${escapeHtml((coverage.gaps || []).length)} recorded data gaps · inspect account reasons below</small></article>
    <article><span>Evaluated</span><strong>${escapeHtml(s.evaluated ?? 0)} / ${escapeHtml(s.in_scope ?? 0)}</strong><small>${escapeHtml(s.excluded ?? 0)} excluded</small></article>
    <article><span>${isLiveMode(report) ? 'Entitlement verified' : 'Activation verified'}</span><strong>${escapeHtml((isLiveMode(report) ? r.entitlement_verified : r.activation_verified) ?? 0)}</strong><small>Evidence-backed checks</small></article>
    <article><span>Access verified</span><strong>${escapeHtml(r.access_verified ?? 0)}</strong><small>${escapeHtml(r.unresolved ?? 0)} unresolved</small></article>
  </section>`;
}

export function accountRow(account, checked, busy = false, report = null) {
  const id = escapeHtml(account.id), status = account.status;
  const payment = paymentLabel(account, report), adapty = account.adapty_active === true ? 'Active' : account.adapty_active === false ? 'No active access' : 'Not checked';
  const gate = account.gate?.allowed === true ? 'Allows access' : account.gate?.allowed === false ? 'Denies access' : 'No app decision recorded';
  return `<tr><td><input type="checkbox" data-account="${id}" aria-label="Select ${id}" ${checked ? 'checked' : ''} ${!account.eligible || busy ? 'disabled' : ''}></td><th scope="row"><button class="text-button mono" data-action="evidence" data-user="${id}">${id}</button><small>${escapeHtml(statusLabel(account.reason || 'No reason recorded'))}</small></th><td>${escapeHtml(payment)}</td><td>${escapeHtml(adapty)}</td><td>${escapeHtml(gate)}</td><td><span class="badge badge-${statusTone(status)}">${escapeHtml(statusLabel(status))}</span></td></tr>`;
}
