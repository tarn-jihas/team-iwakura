import type { Tone } from '../../shared';

export interface Gate { allowed?: boolean; reason?: string; reason_code?: string; [key: string]: unknown }
export interface Account {
  id: string; status: string; reason: string; eligible: boolean; observed_customer_denial?: boolean;
  source_active?: boolean | null; source_freshness?: string; source_expires_at?: string | null; gate?: Gate;
}
export interface Plan {
  id: string; plan_hash: string; status?: string; approved?: boolean; expires_at?: string;
  entries: Array<{ account_id: string; [key: string]: unknown }>; account_ids?: string[]; exclusions?: unknown[];
}
export interface Recovery {
  target_count?: number; verified_count?: number; unresolved_count?: number; unresolved_ids?: string[];
  latest_plan_id?: string | null; root_cause_status?: string;
}
export interface AccessReport {
  manifest: { app: string; run_id: string; [key: string]: unknown };
  summary: Record<string, number | string> & { in_scope: number; evaluated: number; confirmed: number; inconclusive: number };
  accounts: Account[];
  incident: { id?: string | null; window_start?: string; window_end?: string; handler_version?: string; [key: string]: unknown };
  recovery: Recovery;
  plans?: Plan[];
  history?: Array<Record<string, unknown>>;
  collector: { event_count: number };
  consumer?: { mode: string };
}

export const STATUS: Record<string, [string, Tone]> = {
  confirmed: ['Confirmed access failure', 'amber'], healthy: ['Healthy', 'green'],
  legitimate_denial: ['Legitimate denial', 'plain'], policy_denial: ['Policy restriction', 'plain'],
  inconclusive: ['Inconclusive', 'blue'], restored: ['Gate verified', 'green'],
  pending_verification: ['Not verified', 'amber'], outside_incident: ['Not assessed in incident', 'plain'],
};

export function orderedAccounts<T extends { id: string; status: string; reason?: string }>(accounts: T[], filter = 'all', query = ''): T[] {
  const priority: Record<string, number> = { confirmed: 0, pending_verification: 1, inconclusive: 2, restored: 3 };
  return accounts
    .filter(a => (filter === 'all' || a.status === filter) && `${a.id} ${a.reason} ${a.status}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (priority[a.status] ?? 4) - (priority[b.status] ?? 4) || a.id.localeCompare(b.id));
}

export function utcInput(value: string | null | undefined): string {
  return String(value || '').replace(/Z$/, '').slice(0, 19);
}

export function utcValue(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('Choose an incident time in UTC.');
  return value + (value.length === 16 ? ':00Z' : 'Z');
}

export function recoveryOutcome(recovery: Recovery | null | undefined): [string, Tone] {
  if (!recovery?.target_count) return ['No repair applied', 'plain'];
  if (recovery.verified_count === recovery.target_count && recovery.unresolved_count === 0) return ['Access restored · root cause separate', 'green'];
  return [`${recovery.verified_count || 0} verified / ${recovery.unresolved_count ?? recovery.target_count} unresolved`, 'amber'];
}

export const PAGE_SIZE = 20;
