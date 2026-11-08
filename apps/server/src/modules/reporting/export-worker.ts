import { parentPort } from 'node:worker_threads';
import { safeReceipt } from './receipt.js';

interface Row {
  id:string; created_at:string; snapshot_json:string | null; plan_id:string | null; plan_json:string | null;
  plan_created_at:string | null; plan_order:number | null; operation_key:string | null;
  action_status:string | null; sequence:number | null; event_order:number | null; event_status:string | null; result_json:string | null; occurred_at:string | null;
}
interface PlannedAction { operationKey:string; userId:string; kind:string }
interface FulfillmentRow { incident_id:string; identity_hash:string; sequence:number; event_order:number; status:string; reason:string;
  episode_no:number; occurred_at:string; user_id:string }
interface ExternalRow { id:string; incident_id:string; user_id:string; verified_at:string; event_order:number; kind:'external' | 'own_followup' }
interface ReceiptRow { incident_id:string; event_json:string; received_at:string }
interface MonitorOptions { cursor:number; limit:number; status:string; mode:string; title:string;
  sourceReady:boolean; sourceFresh:boolean; lastError:string | null }
interface Incident { id:string; detected_at:string; status:string; affected_accounts:number; repaired_accounts:number;
  externally_restored_accounts:number; repair_started_at:string | null; repaired_at:string | null; resolved_at:string | null; duration_ms:number | null;
  actions:{ operation_key:string; user_id:string; owner:string; action:string; status:string; at:string; reason_code:string; trace_ref:string }[];
  processing_receipts:Record<string,unknown>[] }
interface StateAt { status:string; at:string; order:number }
interface Group { incident:Incident; plans:Set<string>; actions:Map<string,PlannedAction>; gates:Map<string,StateAt>;
  fulfillments:Map<string,StateAt>; external:Map<string,StateAt>; ownFollowup:Map<string,StateAt> }

function format(rows:Row[], fulfillments:FulfillmentRow[], external:ExternalRow[], receipts:ReceiptRow[], metadata:{ coverage:unknown; provenance:string },
  appId:string,environment:string,from:string,to:string,format:'csv' | 'json' | 'monitor',exportedAt:string,monitor?:MonitorOptions):
  { body:string; contentType:string } {
  const groups = new Map<string,Group>();
  for (const row of rows) {
    let group = groups.get(row.id);
    if (!group) {
      group = { incident:{ id:row.id,detected_at:row.created_at,status:'needs_attention',affected_accounts:0,repaired_accounts:0,
        externally_restored_accounts:0,repair_started_at:null,repaired_at:null,resolved_at:null,duration_ms:null,actions:[],processing_receipts:[] },
        plans:new Set(),actions:new Map(),gates:new Map(),fulfillments:new Map(),external:new Map(),ownFollowup:new Map() };
      if (row.snapshot_json) {
        const snapshot = JSON.parse(row.snapshot_json) as { targets?:{ userId:string }[] };
        if (Array.isArray(snapshot.targets)) for (const target of snapshot.targets) group.gates.set(target.userId,{ status:'pending',at:row.created_at,order:0 });
      }
      groups.set(row.id,group);
    }
    if (row.plan_id && row.plan_json && !group.plans.has(row.plan_id)) {
      group.plans.add(row.plan_id);
      const plan = JSON.parse(row.plan_json) as { targets:{ userId:string }[]; actions:PlannedAction[] };
      for (const target of plan.targets) {
        const order = row.plan_order ?? 0;
        if (order > (group.gates.get(target.userId)?.order ?? -1)) {
          group.gates.set(target.userId,{ status:'pending',at:row.plan_created_at ?? row.created_at,order });
        }
      }
      for (const action of plan.actions) group.actions.set(action.operationKey,action);
    }
    if (row.operation_key && row.event_status && row.occurred_at) {
      const action = group.actions.get(row.operation_key);
      if (!action) continue;
      if (action.kind === 'verify_gate' && (row.event_order ?? 0) > (group.gates.get(action.userId)?.order ?? -1)) {
        group.gates.set(action.userId,{ status:row.event_status,at:row.occurred_at,order:row.event_order ?? 0 });
      }
      let detail:Record<string,unknown> = {};
      try { if (row.result_json) detail = JSON.parse(row.result_json) as Record<string,unknown>; } catch { /* Hide invalid details. */ }
      const knownReasons = ['client_rejected_or_unavailable','readback_unavailable_or_mismatched','gate_readback_unavailable','projection_or_gate_mismatch'];
      const reason = typeof detail.reason === 'string' && knownReasons.includes(detail.reason) ? detail.reason : '';
      const reference = typeof detail.evidence_ref === 'string' && /^lumen-(?:action|gate):[A-Za-z0-9._-]{1,256}$/.test(detail.evidence_ref)
        ? detail.evidence_ref : '';
      group.incident.actions.push({ operation_key:row.operation_key,user_id:action.userId,owner:'Lumen',
        action:action.kind,status:row.event_status,at:row.occurred_at,reason_code:reason,trace_ref:reference });
    }
  }
  for (const item of fulfillments) {
    const group = groups.get(item.incident_id);
    if (!group) continue;
    if (!group.gates.has(item.user_id)) group.gates.set(item.user_id,{ status:'pending',at:group.incident.detected_at,order:0 });
    group.fulfillments.set(item.user_id,{ status:item.status,at:item.occurred_at,order:item.event_order });
    group.incident.actions.push({ operation_key:'',user_id:item.user_id,owner:'Reconcile',action:'assessment',
      status:item.status,at:item.occurred_at,reason_code:/^[a-z0-9_]{1,80}$/.test(item.reason) ? item.reason : '',trace_ref:'' });
  }
  for (const item of external) {
    const group = groups.get(item.incident_id);
    if (!group) continue;
    if (!group.gates.has(item.user_id)) group.gates.set(item.user_id,{ status:'pending',at:group.incident.detected_at,order:0 });
    (item.kind === 'own_followup' ? group.ownFollowup : group.external).set(item.user_id,{ status:'verified',at:item.verified_at,order:item.event_order });
    group.incident.actions.push({ operation_key:'',user_id:item.user_id,owner:'Reconcile',
      action:item.kind === 'own_followup' ? 'followup_gate_verification' : 'external_gate_verification',
      status:'verified',at:item.verified_at,reason_code:'',trace_ref:`external:${item.id}` });
  }
  for (const item of receipts) {
    const receipt = safeReceipt(item);
    if (receipt) groups.get(item.incident_id)?.incident.processing_receipts.push(receipt);
  }
  const incidents = [...groups.values()].map(group => {
    const accounts = [...group.gates.entries()];
    const outcome = (userId:string,gate:StateAt):'repaired' | 'external' | 'unresolved' => {
      const fulfillment = group.fulfillments.get(userId);
      const externallyVerified = group.external.get(userId);
      const followedUp = group.ownFollowup.get(userId);
      const gateAt = gate.order, fulfillmentAt = fulfillment?.order ?? -1;
      const externalAt = externallyVerified?.order ?? -1;
      const followupAt = followedUp?.order ?? -1;
      const latest = Math.max(gateAt,fulfillmentAt,externalAt,followupAt);
      const fulfillmentHealthy = fulfillment?.status === 'verified_application'
        || (fulfillment?.status === 'superseded' && Math.max(externalAt,followupAt) >= 0);
      if (gateAt === latest && gate.status !== 'verified'
          || fulfillmentAt === latest && !fulfillmentHealthy) return 'unresolved';
      if (externallyVerified && externalAt > Math.max(gateAt,followupAt)) return 'external';
      if (gate.status === 'verified' || followedUp) return 'repaired';
      return fulfillmentHealthy ? 'external' : 'unresolved';
    };
    group.incident.affected_accounts = accounts.length;
    group.incident.repaired_accounts = accounts.filter(([userId,gate]) => outcome(userId,gate) === 'repaired').length;
    group.incident.externally_restored_accounts = accounts.filter(([userId,gate]) => outcome(userId,gate) === 'external').length;
    group.incident.status = accounts.length > 0 && group.incident.repaired_accounts === accounts.length ? 'repaired'
      : accounts.length > 0 && group.incident.repaired_accounts + group.incident.externally_restored_accounts === accounts.length
        ? 'resolved_externally' : 'needs_attention';
    group.incident.actions.sort((left,right) => Date.parse(left.at) - Date.parse(right.at));
    group.incident.repair_started_at = group.incident.actions.find(action => action.action === 'resync_access' && action.status === 'accepted')?.at ?? null;
    if (group.incident.status === 'repaired') {
      group.incident.repaired_at = group.incident.actions.filter(action =>
        action.action === 'verify_gate' && action.status === 'verified').at(-1)?.at ?? null;
      group.incident.resolved_at = group.incident.repaired_at;
    } else if (group.incident.status === 'resolved_externally') {
      group.incident.resolved_at = group.incident.actions.filter(action => action.action === 'external_gate_verification'
        || (action.action === 'assessment' && ['verified_application','superseded'].includes(action.status))).at(-1)?.at ?? null;
    }
    if (group.incident.resolved_at) {
      const duration = Date.parse(group.incident.resolved_at) - Date.parse(group.incident.detected_at);
      if (Number.isFinite(duration) && duration >= 0) group.incident.duration_ms = duration;
    }
    return group.incident;
  });
  const report = { app:appId,environment,from,to,exported_at:exportedAt,coverage:metadata.coverage ?? null,
    source_provenance:metadata.provenance ?? 'unknown',payment_verification:'not_independently_verified',incidents };
  if (format === 'monitor' && monitor) {
    const mapped = incidents.map(incident => ({ ...incident,
      status:incident.status === 'needs_attention' ? 'unresolved' : incident.status,
      title:'Paid access incident',description:'The recorded entitlement and application access were compared.',
      repair_summary:incident.status === 'repaired' ? 'Access was verified after recovery.'
        : incident.status === 'resolved_externally' ? 'Current access was verified after an external change.'
          : 'Access needs attention.',
      next_step:incident.status === 'needs_attention' ? 'Review the activity and current source coverage.' : 'No further action',
      source_provenance:report.source_provenance,payment_verification:report.payment_verification }));
    const selected = mapped.filter(incident => monitor.status === 'needs_attention' ? incident.status === 'unresolved'
      : monitor.status === 'repaired' ? ['repaired','resolved_externally'].includes(incident.status) : incident.status === monitor.status);
    const page = selected.slice(monitor.cursor,monitor.cursor+monitor.limit);
    const coverage = metadata.coverage && typeof metadata.coverage === 'object' ? metadata.coverage as Record<string,unknown> : {};
    const feed = { mode:monitor.mode,app:{ title:monitor.title,environment },automation:{ enabled:true },
      connection:{ ready:monitor.sourceReady,checked_accounts:coverage.sourceRead ?? 0,total_accounts:coverage.registered ?? 0 },
      summary:{ incidents:mapped.length,fixed:mapped.filter(incident => incident.status === 'repaired').length,
        needs_attention:mapped.filter(incident => incident.status === 'unresolved').length },
      coverage:{ ...coverage,complete:coverage.sourceStopped === false && coverage.incomplete === 0
        && coverage.scanned === coverage.registered,source_fresh:monitor.sourceFresh,
        ...(monitor.lastError ? { waiting_reason:monitor.lastError } : {}) },
      simulation:{ status:'idle',available:false },
      incidents:page,pagination:{ total:selected.length,next_cursor:monitor.cursor+page.length < selected.length
        ? String(monitor.cursor+page.length) : null } };
    return { body:JSON.stringify(feed),contentType:'application/json; charset=utf-8' };
  }
  if (format === 'json') return { body:JSON.stringify(report,null,2),contentType:'application/json; charset=utf-8' };
  const columns = ['app','environment','from','to','exported_at','coverage','source_provenance','payment_verification','incident_id','status',
    'detected_at','repair_started_at','repaired_at','resolved_at','duration_ms','affected_accounts','repaired_accounts',
    'externally_restored_accounts','last_action','responsibility','last_status','last_action_at','error_code','next_step','trace_ref'];
  const cell = (value:unknown):string => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const records = incidents.length ? incidents : [null];
  const lines = records.map(incident => {
    const last = incident?.actions.at(-1);
    return [appId,environment,from,to,exportedAt,metadata.coverage,metadata.provenance,'not_independently_verified',incident?.id,incident?.status,
      incident?.detected_at,incident?.repair_started_at,incident?.repaired_at,incident?.resolved_at,incident?.duration_ms,
      incident?.affected_accounts,incident?.repaired_accounts,incident?.externally_restored_accounts,
      last?.action,last?.owner,last?.status,last?.at,last?.reason_code,
      incident?.status === 'repaired' || incident?.status === 'resolved_externally' ? 'No further action' : incident ? 'Investigate unresolved access' : '',last?.trace_ref]
      .map(cell).join(',');
  });
  return { body:[columns.map(cell).join(','),...lines].join('\r\n'),contentType:'text/csv; charset=utf-8' };
}

parentPort?.once('message',(message:{ rows:Row[]; fulfillments:FulfillmentRow[]; external:ExternalRow[]; receipts:ReceiptRow[]; metadata:{ coverage:unknown; provenance:string }; appId:string; environment:string; from:string; to:string;
  format:'csv' | 'json' | 'monitor'; exportedAt:string; monitor?:MonitorOptions }) => {
  parentPort!.postMessage(format(message.rows,message.fulfillments,message.external,message.receipts,message.metadata,message.appId,message.environment,message.from,message.to,message.format,message.exportedAt,message.monitor));
});
