import { classifyFulfillment, type FulfillmentObservation, type FulfillmentStatus } from '../fulfillment/classification.js';
import { parseTimestamp } from '../../infrastructure/time.js';

export interface ProcessingSignal {
  at: string;
  productId: string | null;
  handlerVersion: string | null;
  failedStep: string | null;
}

export interface AccountEvidence {
  userId:string;
  environment:string;
  observation:FulfillmentObservation;
  signal:ProcessingSignal | null;
}

export interface AccountAssessment {
  userId:string;
  status:FulfillmentStatus;
  reason:string;
  eligible:boolean;
  inWindow:boolean;
  correlation:'shared_signature_hypothesis' | 'different_signature' | 'unknown';
}

/** Individual evidence determines affected accounts; signals only suggest correlation. */
export function assessIncident(appId:string, environment:string, triggerUserId:string, eventAt:string,
  records:readonly AccountEvidence[], now:Date, windowSeconds = 300): AccountAssessment[] {
  const anchorTime = parseTimestamp(eventAt);
  if (!appId || !environment || !triggerUserId || !Number.isFinite(anchorTime)
      || !Number.isFinite(now.getTime()) || !Number.isInteger(windowSeconds) || windowSeconds < 0 || windowSeconds > 86_400
      || new Set(records.map(record => record.userId)).size !== records.length) throw new Error('Invalid incident scope');
  const candidateAnchor = records.find(record => record.userId === triggerUserId && record.environment === environment
    && record.observation.appId === appId && record.observation.userId === triggerUserId)?.signal;
  const anchorAt = candidateAnchor ? parseTimestamp(candidateAnchor.at) : Number.NaN;
  const anchor = Number.isFinite(anchorAt) && Math.abs(anchorAt - anchorTime) <= windowSeconds * 1000 ? candidateAnchor : null;
  return records.filter(record => record.environment === environment && record.observation.appId === appId)
    .map(record => {
      const observed = record.observation.userId === record.userId
        ? classifyFulfillment({ ...record.observation, now })
        : { status:'inconclusive' as const, reason:'identity_unknown', eligible:false };
      const signalTime = record.signal ? parseTimestamp(record.signal.at) : Number.NaN;
      const inWindow = Number.isFinite(signalTime) && Math.abs(signalTime - anchorTime) <= windowSeconds * 1000;
      let correlation:AccountAssessment['correlation'] = 'unknown';
      if (inWindow && anchor?.productId && anchor.handlerVersion && anchor.failedStep
          && record.signal?.productId && record.signal.handlerVersion && record.signal.failedStep) {
        correlation = record.signal.productId === anchor.productId && record.signal.handlerVersion === anchor.handlerVersion
          && record.signal.failedStep === anchor.failedStep ? 'shared_signature_hypothesis' : 'different_signature';
      }
      return { userId:record.userId, status:observed.status, reason:observed.reason,
        eligible:observed.eligible, inWindow, correlation };
    });
}
