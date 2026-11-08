export const CLASSES: Record<string, { title: string; icon: string; note: string }> = {
  MISSING_IN_MIXPANEL: { title: 'Missing events', icon: 'missing', note: 'Backfill the purchase and refund observed in the source ledger.' },
  PRICE_MISMATCH: { title: 'Price mismatch', icon: 'money', note: 'Append a signed correction. The original price stays in the raw export.' },
  DUPLICATE_IN_MIXPANEL: { title: 'Duplicate purchase', icon: 'duplicate', note: 'Different delivery IDs describe one purchase. Offset the extra analytical amount.' },
  UNMAPPED_EVENT_NAME: { title: 'Unmapped event name', icon: 'link', note: 'Accept the local event-name mapping. No destination event is imported.' },
  EXTRA_IN_MIXPANEL: { title: 'Destination-only event', icon: 'search', note: 'The source has no matching transaction in this population. Investigate manually.' },
  SANDBOX_EXPECTED: { title: 'Expected sandbox exclusion', icon: 'shield', note: 'The production metric intentionally excludes this sandbox purchase.' },
};

export function money(value: unknown, signed = false) {
  if (value === undefined || value === null) return '—';
  const text = String(value);
  if (!/^-?\d+\.\d{2}$/.test(text)) return text;
  const [integer, fraction] = text.replace(/^-/, '').split('.');
  const sign = text.startsWith('-') ? '−' : signed && !/^0+\.00$/.test(text) ? '+' : '';
  return `${sign}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

export function groupStatus(report: Record<string, any>, cls: string) {
  const provided = report.group_states?.[cls];
  if (provided) return typeof provided === 'string' ? provided : provided.status;
  if (cls === 'EXTRA_IN_MIXPANEL') return 'manual';
  if (cls === 'SANDBOX_EXPECTED') return 'expected';
  return report.groups.some((group: any) => group.cls === cls) ? 'open' : cls === 'UNMAPPED_EVENT_NAME' ? 'mapped' : 'verified';
}

export function receiptStatus(report: Record<string, any>, audit: Record<string, any>, actionId: string, action: Record<string, any>) {
  const result = audit.verification?.actions?.find((row: any) => row.action_id === actionId);
  if (result?.status === 'pending_visibility' || report.clock < action.visible_at_tick) return ['Pending visibility', 'amber'];
  if (result?.status === 'verified') return groupStatus(report, action.group) === 'verified' ? ['Verified by current read', 'green'] : ['Read back; findings remain', 'amber'];
  return [result?.status === 'missing_readback' ? 'Readback failed' : 'Not verified', 'red'];
}
