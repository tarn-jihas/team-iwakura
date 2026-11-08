import { LumenAdapter } from '../client/lumen-adapter.js';
import { ProviderAdapter } from '../source/provider-adapter.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { Expectations } from './expectations.js';
import { classifyFulfillment, type FulfillmentObservation, type Entitlement } from './classification.js';
import type { CurrentTarget } from '../recovery/preflight.js';

const object = (value:unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value:unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();
const revision = (value:unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

export interface ScanResult {
  observations:FulfillmentObservation[];
  current:Map<string,CurrentTarget>;
  coverage:{ registered:number; scanned:number; sourceRead:number; clientRead:number; incomplete:number; sourceStopped:boolean };
}

/** One pass over the known registry. Scheduling and incident persistence are separate. */
export async function scanFulfillments(lumen:Pick<LumenAdapter,'listAccounts' | 'readAccess'>,
  provider:Pick<ProviderAdapter,'profile'>, expectations:Expectations,
  appId:string, sourceEnvironment:string, clock:() => Date, isOwned:(userId:string) => Promise<boolean>,
  selectedUsers?:ReadonlySet<string>, previouslyVerified?:(userId:string,entitlement:Entitlement) => Promise<boolean>): Promise<ScanResult> {
  if (!text(appId) || !text(sourceEnvironment) || typeof clock !== 'function' || !Number.isFinite(clock().getTime())) throw new Error('Invalid scan scope');
  const accounts:Record<string,unknown>[] = [], cursors = new Set<string>(), users = new Set<string>();
  let cursor:string | null = null, total:number | null = null;
  do {
    const page = await lumen.listAccounts(cursor,500);
    if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || (page.total as number) < 0
        || (total !== null && total !== page.total)) throw new Error('Inconsistent client registry');
    total = page.total as number;
    for (const account of page.items) {
      if (!object(account) || !text(account.user_id) || users.has(account.user_id)) {
        throw new Error('Invalid client registry');
      }
      users.add(account.user_id);
      accounts.push(account);
    }
    cursor = page.next_cursor as string | null;
    if (cursor !== null && (!/^\d+$/.test(cursor) || cursors.has(cursor))) throw new Error('Invalid client cursor');
    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);
  if (accounts.length !== total) throw new Error('Incomplete client registry');

  const observations:FulfillmentObservation[] = [], current = new Map<string,CurrentTarget>();
  let sourceRead = 0, clientRead = 0, sourceStopped = false;
  if (selectedUsers && [...selectedUsers].some(userId => !users.has(userId))) throw new Error('Unknown selected account');
  for (const account of accounts) {
    const userId = account.user_id as string;
    if (selectedUsers && !selectedUsers.has(userId)) continue;
    let source:Record<string,unknown> | null = null, access:Record<string,unknown> | null = null;
    if (!sourceStopped) {
      try { source = await provider.profile(userId); sourceRead++; }
      catch { sourceStopped = true; }
    }
    try { access = await lumen.readAccess(userId); clientRead++; } catch { /* Mark coverage incomplete. */ }
    const now = clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Scan clock unavailable');
    const entitlementValue = source?.entitlement;
    const validEntitlement = object(entitlementValue) && text(entitlementValue.app_id)
      && text(entitlementValue.user_id) && text(entitlementValue.provider_customer_id)
      && (text(entitlementValue.transaction_id) || entitlementValue.transaction_id === null)
      && text(entitlementValue.product_id) && text(entitlementValue.store) && text(entitlementValue.source_environment)
      && text(entitlementValue.source_fingerprint) && text(entitlementValue.starts_at) && text(entitlementValue.expires_at)
      && typeof entitlementValue.is_in_grace_period === 'boolean' && text(entitlementValue.entitlement_hash);
    const entitlement:Entitlement | null = validEntitlement ? {
      app_id:entitlementValue.app_id as string,user_id:entitlementValue.user_id as string,
      provider_customer_id:entitlementValue.provider_customer_id as string,
      transaction_id:entitlementValue.transaction_id as string | null,product_id:entitlementValue.product_id as string,
      original_transaction_id:text(entitlementValue.original_transaction_id) ? entitlementValue.original_transaction_id : null,
      store:entitlementValue.store as string,source_environment:entitlementValue.source_environment as string,
      source_fingerprint:entitlementValue.source_fingerprint as string,starts_at:entitlementValue.starts_at as string,
      expires_at:entitlementValue.expires_at as string,is_in_grace_period:entitlementValue.is_in_grace_period as boolean,
      entitlement_hash:entitlementValue.entitlement_hash as string
    } : null;
    const profile = source && text(source.user_id) && text(source.app_id) && typeof source.identity_match === 'boolean'
      && text(source.observed_at) && ['active','inactive','unknown'].includes(String(source.status)) && text(source.reason)
      ? { user_id:source.user_id, app_id:source.app_id, identity_match:source.identity_match,
        observed_at:source.observed_at, status:source.status as 'active' | 'inactive' | 'unknown', reason:source.reason } : null;
    let normalProcessingWindow = false;
    if (profile?.status === 'active' && profile.identity_match && profile.app_id === appId && profile.user_id === userId
        && source?.provider_customer_id === userId && entitlement?.transaction_id && entitlement.app_id === appId
        && entitlement.user_id === userId && entitlement.provider_customer_id === userId
        && entitlement.source_environment === sourceEnvironment && entitlement.is_in_grace_period === false) {
      try {
        const expectation = await expectations.observe({ appId,environment:sourceEnvironment,store:entitlement.store,
          transactionId:entitlement.transaction_id,userId,accessLevel:'premium',startsAt:entitlement.starts_at,
          expiresAt:entitlement.expires_at,sourceFingerprint:entitlement.source_fingerprint,
          entitlementHash:entitlement.entitlement_hash },profile.observed_at);
        const age = now.getTime() - parseTimestamp(expectation.firstObservedAt);
        if (!expectation.current) source = null;
        normalProcessingWindow = expectation.current && age >= 0 && age < 30_000
          && !(previouslyVerified && await previouslyVerified(userId,entitlement));
      } catch { source = null; }
    }
    const client = access && text(account.provider_customer_id) && text(account.identity_status)
      && typeof account.policy_enabled === 'boolean' && typeof access.active === 'boolean'
      && revision(account.identity_revision) && revision(account.policy_revision) && revision(account.projection_revision)
      && access.identity_revision === account.identity_revision && access.policy_revision === account.policy_revision
      && access.projection_revision === account.projection_revision
      && (access.expires_at === null || text(access.expires_at))
      && (access.entitlement_hash === null || text(access.entitlement_hash))
      && typeof access.allowed === 'boolean' && text(access.reason)
      ? { provider_customer_id:account.provider_customer_id,identity_status:account.identity_status,
        policy_enabled:account.policy_enabled,access_active:access.active,access_expires_at:access.expires_at as string | null,
        entitlement_hash:access.entitlement_hash as string | null,gate:{ allowed:access.allowed,reason:access.reason } } : null;
    const owned = await isOwned(userId);
    if (typeof owned !== 'boolean') throw new Error('Incident ownership unavailable');
    const observation:FulfillmentObservation = { appId,userId,now,complete:!!source && !!profile && !!client,
      sourceScopeMatches:!!profile && profile.app_id === appId && (!entitlement || entitlement.source_environment === sourceEnvironment),
      provider:source && text(source.provider_customer_id) ? { provider_customer_id:source.provider_customer_id,
        identity_status:source.identity_match === true ? 'mapped' : 'unknown' } : null,
      profile,entitlement,client,ownedByOtherIncident:owned,normalProcessingWindow,explicitHandlerFailure:false };
    observations.push(observation);
    if (observation.complete && source && entitlement && client
        && text(source.source_fingerprint) && revision(account.identity_revision)
        && revision(account.policy_revision) && revision(account.projection_revision)) {
      current.set(userId,{ observation,customerId:client.provider_customer_id,store:entitlement.store,
        sourceEnvironment:entitlement.source_environment,sourceFingerprint:source.source_fingerprint,
        identityRevision:account.identity_revision,policyRevision:account.policy_revision,
        projectionRevision:account.projection_revision });
    }
  }
  return { observations,current,coverage:{ registered:accounts.length,scanned:observations.length,sourceRead,clientRead,
    incomplete:observations.filter(observation => classifyFulfillment(observation).status === 'inconclusive').length,sourceStopped } };
}
