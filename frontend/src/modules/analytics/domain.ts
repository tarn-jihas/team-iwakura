import type { IconName, Tone } from '../../shared';

export type Money = string; // Decimal string from the server, e.g. "989.01"
export type CurrencyMap = Record<string, Money>;

export interface Finding {
  id: string; txn: string; user: string; event_class: string; currency: string; delta: Money;
}
export interface Group { cls: string; writes: boolean; why?: string; findings: Finding[] }
export interface Report {
  run: string; clock: number; groups: Group[]; gap: CurrencyMap; source_totals: CurrencyMap;
  destination_effective_totals: CurrencyMap; group_states?: Record<string, string | { status: string }>;
  pending_count?: number; verification_status?: string; action_count: number; approval_count: number;
  raw_event_count: number; query_event_count: number;
}
export interface AuditAction {
  group: string; finding: string; payload_hash: string; approval_actor: string; accepted_at_tick: number; visible_at_tick: number;
}
export interface Audit {
  actions?: Record<string, AuditAction>; approvals?: Record<string, unknown>;
  journal?: Array<{ type: string; tick?: number; clock?: number; actor?: string; cls?: string }>;
  verification?: { actions?: Array<{ action_id: string; status: string }> };
}
export interface Operation {
  txn: string; user: string; event_class: string; environment: string; source_amount: Money;
  destination_amount: Money; delta: Money; currency: string; status: string;
}
export interface Run { id: string; kind: string; tick: number; report: Report }
export interface Sample { path: string; provider: string; bytes: number }
export interface PreviewGroup {
  class: string; action: string; finding_ids: string[]; row_count?: number;
  expected_signed_gap_change: CurrencyMap; approval_hash: string; payloads: unknown;
}
export interface Preview { run: string; groups: PreviewGroup[] }
export interface Evidence {
  source: unknown[]; destination: unknown[]; pending_destination?: unknown[]; correction_receipts?: unknown[];
}
/** Only the fields the workspace reads from the access module's report (for the Cases overview). */
export interface AccessSummary {
  summary: { in_scope: number; confirmed: number; inconclusive: number };
  incident: { id?: string | null };
  recovery: { target_count?: number; verified_count?: number; unresolved_count?: number };
}

export const CLASSES: Record<string, { title: string; icon: IconName; note: string }> = {
  MISSING_IN_MIXPANEL: { title: 'Missing events', icon: 'missing', note: 'Backfill the purchase and refund observed in the source ledger.' },
  PRICE_MISMATCH: { title: 'Price mismatch', icon: 'money', note: 'Append a signed correction. The original price stays in the raw export.' },
  DUPLICATE_IN_MIXPANEL: { title: 'Duplicate purchase', icon: 'duplicate', note: 'Different delivery IDs describe one purchase. Offset the extra analytical amount.' },
  UNMAPPED_EVENT_NAME: { title: 'Unmapped event name', icon: 'link', note: 'Accept the local event-name mapping. No destination event is imported.' },
  EXTRA_IN_MIXPANEL: { title: 'Destination-only event', icon: 'search', note: 'The source has no matching transaction in this population. Investigate manually.' },
  SANDBOX_EXPECTED: { title: 'Expected sandbox exclusion', icon: 'shield', note: 'The production metric intentionally excludes this sandbox purchase.' },
};

export const REPAIRABLE = ['MISSING_IN_MIXPANEL', 'PRICE_MISMATCH', 'DUPLICATE_IN_MIXPANEL'];

export function groupStatus(report: Pick<Report, 'groups' | 'group_states'>, cls: string): string {
  const provided = report.group_states?.[cls];
  if (provided) return typeof provided === 'string' ? provided : provided.status;
  if (cls === 'EXTRA_IN_MIXPANEL') return 'manual';
  if (cls === 'SANDBOX_EXPECTED') return 'expected';
  return report.groups.some(g => g.cls === cls) ? 'open' : cls === 'UNMAPPED_EVENT_NAME' ? 'mapped' : 'verified';
}

export function receiptStatus(report: Pick<Report, 'clock' | 'groups' | 'group_states'>, audit: Audit, actionId: string,
  action: Pick<AuditAction, 'group' | 'visible_at_tick'>): [string, Tone] {
  const result = audit.verification?.actions?.find(row => row.action_id === actionId);
  if (result?.status === 'pending_visibility' || report.clock < action.visible_at_tick) return ['Pending visibility', 'amber'];
  if (result?.status === 'verified') return groupStatus(report, action.group) === 'verified' ? ['Verified by current read', 'green'] : ['Read back; findings remain', 'amber'];
  return [result?.status === 'missing_readback' ? 'Readback failed' : 'Not verified', 'red'];
}

export function counts(report: Report) {
  return {
    findings: report.groups.reduce((n, g) => n + g.findings.length, 0),
    repair: report.groups.filter(g => g.writes).length,
    pending: report.pending_count || 0,
  };
}

export function stage(report: Report): [string, Tone] {
  const c = counts(report);
  if (c.pending) return ['Pending ingestion', 'amber'];
  if (report.verification_status === 'readback_failed') return ['Readback failed', 'red'];
  if (['unresolved', 'open_findings'].includes(report.verification_status || '') && report.action_count) return ['Repair not verified', 'amber'];
  if (c.repair) return ['Needs review', 'amber'];
  return ['Manual investigation remains', 'blue'];
}

/** Group definitions shown on the Findings tab, filtered by search text and filter. */
export function visibleGroups(report: Report, search: string, filter: string) {
  const definitions: Array<[string, { title: string; icon: IconName; note: string }]> = [
    ...Object.entries(CLASSES),
    ...report.groups.filter(g => !CLASSES[g.cls]).map(g => [g.cls, { title: g.cls.replaceAll('_', ' ').toLowerCase(), icon: 'search' as IconName, note: g.why || '' }] as [string, { title: string; icon: IconName; note: string }]),
  ];
  return definitions.filter(([cls, meta]) => {
    const text = `${cls} ${meta.title} ${report.groups.find(g => g.cls === cls)?.findings.map(f => `${f.txn} ${f.user}`).join(' ') || ''}`;
    const matches = text.toLowerCase().includes(search.toLowerCase());
    const byFilter = filter === 'all' || (filter === 'repair' && REPAIRABLE.includes(cls)) || (filter === 'manual' && (cls === 'EXTRA_IN_MIXPANEL' || !CLASSES[cls]));
    return matches && byFilter;
  });
}
