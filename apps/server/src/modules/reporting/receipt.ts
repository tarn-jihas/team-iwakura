export function safeReceipt(row:{ event_json:string; received_at:string }):Record<string,unknown> | null {
  try {
    const event = JSON.parse(row.event_json) as Record<string,unknown>;
    const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
      ? event.details as Record<string,unknown> : {};
    if (!Array.isArray(details.steps) || !details.steps.length) return null;
    const steps = details.steps.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const step = value as Record<string,unknown>;
      return Object.fromEntries(['name','status','owner','result','at','reason_code','gap']
        .filter(key => key in step).map(key => [key,step[key]]));
    }).filter(Boolean);
    return { user_id:event.app_user_id,created_at:event.occurred_at,recorded_at:row.received_at,steps };
  } catch { return null; }
}
