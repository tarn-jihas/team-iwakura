export type IncidentStatus = 'unresolved' | 'detecting' | 'repairing' | 'repaired';
export type ExportKind = 'csv' | 'json';
export type SimulationAction = 'start' | 'bootstrap' | 'continuous' | 'once' | 'stop';

export function monitorUrl(cursor: string | number, status: IncidentStatus) {
  const apiStatus = status === 'unresolved' ? 'needs_attention' : status;
  return `/api/recovery/monitor?cursor=${encodeURIComponent(cursor)}&limit=50&status=${encodeURIComponent(apiStatus)}`;
}

export function exportUrl(from: string, to: string, kind: ExportKind) {
  const start = new Date(`${from}Z`);
  const end = new Date(`${to}Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new Error('Choose a valid UTC range where From is earlier than To.');
  }
  return `/api/recovery/export?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}&format=${kind}`;
}

export function simulationPayload(action: SimulationAction, operationKey: string) {
  return action === 'stop' ? { action } : { action, operation_key: operationKey };
}

const exportFields = ['id', 'status', 'title', 'affected_accounts', 'repaired_accounts', 'detected_at', 'repair_started_at', 'repaired_at', 'duration_ms', 'description', 'repair_summary', 'next_step', 'source_provenance', 'payment_verification'];

export function csv(rows: Array<Record<string, unknown>>) {
  const cell = (value: unknown) => {
    let text = value == null ? '' : Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [exportFields.map(cell).join(','), ...rows.map(row => exportFields.map(key => cell(row[key])).join(','))].join('\r\n');
}

export function defaultRange(now = Date.now()) {
  return {
    from: new Date(now - 86400000).toISOString().slice(0, 19),
    to: new Date(now + 1000).toISOString().slice(0, 19),
  };
}
