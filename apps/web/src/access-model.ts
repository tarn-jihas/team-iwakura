export const ACCESS_STATUS: Record<string, [string, string]> = {
  confirmed: ['Confirmed access failure', 'amber'], healthy: ['Healthy', 'green'],
  legitimate_denial: ['Legitimate denial', 'plain'], policy_denial: ['Policy restriction', 'plain'],
  inconclusive: ['Inconclusive', 'blue'], restored: ['Gate verified', 'green'],
  pending_verification: ['Not verified', 'amber'], outside_incident: ['Not assessed in incident', 'plain'],
};

export function orderedAccounts(accounts: Array<Record<string, any>>, filter = 'all', query = '') {
  const priority: Record<string, number> = { confirmed: 0, pending_verification: 1, inconclusive: 2, restored: 3 };
  return accounts.filter(account => (filter === 'all' || account.status === filter) && `${account.id} ${account.reason} ${account.status}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (priority[a.status] ?? 4) - (priority[b.status] ?? 4) || a.id.localeCompare(b.id));
}

export function utcInput(value: unknown) { return String(value || '').replace(/Z$/, '').slice(0, 19); }
export function utcValue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('Choose an incident time in UTC.');
  return value + (value.length === 16 ? ':00Z' : 'Z');
}
export function recoveryOutcome(recovery: Record<string, any>) {
  if (!recovery?.target_count) return ['No repair applied', 'plain'];
  if (recovery.verified_count === recovery.target_count && recovery.unresolved_count === 0) return ['Access restored · root cause separate', 'green'];
  return [`${recovery.verified_count || 0} verified / ${recovery.unresolved_count ?? recovery.target_count} unresolved`, 'amber'];
}
