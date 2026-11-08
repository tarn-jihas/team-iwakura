export const LIVE_MODE = 'LIVE_ADAPTY_SEEDED';
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export function isLiveMode(report: Record<string, any>) { return report?.mode === LIVE_MODE; }
export function provenanceLabel(report: Record<string, any>) { return isLiveMode(report) ? 'Real Adapty reads · synthetic purchase records' : 'Local synthetic evidence'; }
const labels: Record<string, string> = {
  activation_missing: 'Activation missing', access_not_delivered: 'Access not delivered', healthy: 'Healthy',
  inconclusive: 'Inconclusive', policy_denial: 'Policy denial', legitimate_denial: 'Legitimate denial',
  restored: 'Restored', pending_verification: 'Pending verification', awaiting_client_action: 'Awaiting client action',
  accepted: 'Accepted, verification pending', verified: 'Verified', failed: 'Failed', unknown_outcome: 'Outcome unknown', blocked: 'Blocked',
  confirmed: 'Confirmed discrepancy', potential: 'Potentially affected', outside_incident: 'Outside incident', not_scanned: 'Not evaluated', unclassified: 'Not evaluated',
  access_verified: 'Access verified', partial_recovery: 'Partial recovery', recovery_unresolved: 'Recovery unresolved',
};
export function statusLabel(status: unknown) { const key = String(status ?? ''); return labels[key] || (key ? key.replace(/[_-]+/g, ' ') : 'Status unavailable'); }
export function targetLabel(action: Record<string, any>) {
  const target = action?.target;
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return action?.account_id || 'Not recorded';
  if (target.transaction_id) return `Purchase ${target.transaction_id}`;
  if (target.product_id || target.price_id) return [target.product_id, target.price_id].filter(Boolean).join(' / ');
  return target.user_id || target.feature || action?.account_id || 'Configuration';
}
export function statusTone(status: string) {
  if (['restored', 'healthy', 'verified'].includes(status)) return 'green';
  if (['failed', 'blocked', 'unknown_outcome'].includes(status)) return 'red';
  if (['confirmed', 'potential', 'activation_missing', 'access_not_delivered', 'policy_denial', 'pending_verification', 'awaiting_client_action'].includes(status)) return 'amber';
  return 'blue';
}
export function paymentLabel(account: Record<string, any>, report: Record<string, any>) { return isLiveMode(report) ? 'Not independently verified' : statusLabel(account?.payment_state || 'Unknown'); }

export function summaryView(report: Record<string, any>) {
  const summary = report?.summary || {}, recovery = report?.recovery || {}, coverage = report?.coverage || {};
  return {
    coverage: coverage.complete === true ? 'Complete' : coverage.complete === false ? 'Incomplete' : 'Unknown',
    gaps: (coverage.gaps || []).length,
    evaluated: summary.evaluated ?? 0,
    inScope: summary.in_scope ?? 0,
    excluded: summary.excluded ?? 0,
    verified: (isLiveMode(report) ? recovery.entitlement_verified : recovery.activation_verified) ?? 0,
    verifiedLabel: isLiveMode(report) ? 'Entitlement verified' : 'Activation verified',
    accessVerified: recovery.access_verified ?? 0,
    unresolved: recovery.unresolved ?? 0,
  };
}

export function safeReportHtml(bundle: Record<string, any>) {
  const actions = Array.isArray(bundle?.actions) ? bundle.actions : [];
  const summary = bundle?.summary || {}, recovery = bundle?.recovery || {}, incident = bundle?.incident || {};
  const remaining = Array.isArray(bundle?.accounts)
    ? bundle.accounts.filter((account: any) => account.eligible || ['inconclusive', 'awaiting_client_action', 'potential'].includes(account.status)).map((account: any) => `${account.id}: ${statusLabel(account.reason || account.status)}`)
    : actions.filter((action: any) => !['verified', 'restored', 'healthy', 'completed'].includes(action.status)).map((action: any) => `${targetLabel(action)}: ${action.next_step || statusLabel(action.status)}`);
  const rows = actions.map((action: any) => `<tr><td>${escapeHtml(action.owner)}</td><td>${escapeHtml(targetLabel(action))}${action.account_id ? `<br>${escapeHtml(action.account_id)}` : ''}</td><td>${escapeHtml(statusLabel(action.status))}</td><td>${escapeHtml(action.started_at || 'Not recorded')}<br>${escapeHtml(action.finished_at || '')}</td><td>${escapeHtml(action.evidence_ref)}<details><summary>Preconditions</summary><pre>${escapeHtml(JSON.stringify(action.preconditions || {}, null, 2))}</pre></details></td><td>${escapeHtml(action.next_step)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Payment Activation Recovery report</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#222}table{border-collapse:collapse;width:100%}th,td{text-align:left;border:1px solid #ddd;padding:8px;overflow-wrap:anywhere}th{background:#f5f3ff}li{margin:5px 0}.scroll{overflow:auto}pre{white-space:pre-wrap}</style></head><body><h1>${isLiveMode(bundle) ? 'Lumen access delivery recovery' : 'Payment Activation Recovery'}</h1><p>${isLiveMode(bundle) ? 'LIVE ADAPTY · SEEDED DATA · ' : ''}${escapeHtml(provenanceLabel(bundle))} · ${escapeHtml(bundle?.manifest?.app_title || bundle?.manifest?.app || 'App unavailable')} · ${escapeHtml(bundle?.manifest?.environment || 'Environment unavailable')}</p><h2>Recovery result</h2><p><strong>${escapeHtml(summary.confirmed ?? 0)} confirmed affected · ${isLiveMode(bundle) ? `${escapeHtml(recovery.entitlement_verified ?? 0)} entitlements verified` : `${escapeHtml(recovery.activation_verified ?? 0)} activations verified`} · ${escapeHtml(recovery.access_verified ?? 0)} accesses verified · ${escapeHtml(recovery.unresolved ?? 0)} unresolved · ${escapeHtml(summary.inconclusive ?? 0)} inconclusive</strong></p>${isLiveMode(bundle) ? '<p>Recovery basis: Adapty entitlement delivery. Payment state was not independently verified.</p>' : ''}<h2>Incident and scope</h2><p>${escapeHtml(incident.id || 'No incident recorded')} · ${escapeHtml(incident.window_start || 'Start unavailable')} to ${escapeHtml(incident.window_end || 'End unavailable')}</p><p>${escapeHtml(summary.in_scope ?? 0)} in scope · ${escapeHtml(summary.evaluated ?? 0)} evaluated</p><h2>Cause assessment</h2><p>${escapeHtml(statusLabel(recovery.root_cause_status))} · ${escapeHtml(recovery.root_cause_certainty || 'Certainty unavailable')}</p><h2>Actions and responsibilities</h2><div class="scroll"><table><thead><tr><th>Owner</th><th>Target</th><th>Status</th><th>Started / finished</th><th>Evidence reference</th><th>Next step</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No recorded actions</td></tr>'}</tbody></table></div><h2>Remaining work</h2><ul>${remaining.map((item: string) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>No unresolved account was listed in this snapshot.</li>'}</ul><h2>Evidence coverage</h2><p>${bundle?.coverage?.complete === true ? 'Complete' : 'Incomplete or unavailable'}</p><ul>${(bundle?.coverage?.gaps || []).map((gap: any) => `<li>${escapeHtml(typeof gap === 'string' ? gap : gap.reason || gap.source || 'Source evidence unavailable')}</li>`).join('')}</ul></body></html>`;
}
