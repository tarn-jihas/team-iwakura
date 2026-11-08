import type { CanonicalValue } from "./canonical.ts";
import { canonical } from "./canonical.ts";
export { canonical, type CanonicalValue } from "./canonical.ts";

export const SCHEMA_VERSION = 1 as const;
export const TRACE_SCHEMA_VERSION = 2 as const;
export const KINDS = [
  "webhook_received",
  "handler_completed",
  "access_projection_changed",
  "feature_access_decided",
  "source_entitlement_observed",
  "resync_requested",
  "resync_completed",
  "verification_completed",
  "mobile_observation",
] as const;

export type RecoveryKind = (typeof KINDS)[number];
export type JsonInteger = number | bigint;

export interface RecoveryState {
  active?: boolean;
  premium?: boolean;
  expires_at?: string | null;
  revision?: JsonInteger;
  cache_revision?: JsonInteger;
  projection_revision?: JsonInteger;
  source_hash?: string;
  invalidated?: boolean;
  cached_at?: string | null;
}

export type TraceStepName =
  | "receive"
  | "handler"
  | "fresh_source_read"
  | "identity_check"
  | "policy_check"
  | "projection_commit"
  | "cache_refresh"
  | "gate_readback"
  | "telemetry_enqueue"
  | "projection_readback"
  | "source_observation";
export type TraceStatus = "started" | "completed" | "failed" | "skipped" | "unknown";
export type TraceOwner = "source" | "lumen" | "engine" | "collector";
export type TraceResult =
  | "accepted"
  | "verified"
  | "failed"
  | "skipped"
  | "matched"
  | "mismatched"
  | "committed"
  | "queued"
  | "unavailable"
  | "not_required"
  | "observed"
  | "allowed"
  | "denied"
  | "replayed"
  | "unknown";
export type TraceReason =
  | "source_unavailable"
  | "source_cooldown"
  | "identity_mismatch"
  | "policy_restricted"
  | "projection_mismatch"
  | "cache_mismatch"
  | "gate_denied"
  | "telemetry_gap"
  | "readback_unknown"
  | "timeout_after_commit"
  | "handler_failure";

export interface TraceStep {
  name: TraceStepName;
  status: TraceStatus;
  owner: TraceOwner;
  result: TraceResult;
  at?: string;
  revision?: JsonInteger;
  reason_code?: TraceReason;
  gap?: boolean;
}

export interface TraceRevisions {
  identity?: JsonInteger;
  policy?: JsonInteger;
  projection?: JsonInteger;
  cache?: JsonInteger;
}

export interface TraceStackFrame {
  module: string;
  function: string;
  line: JsonInteger;
}

export type RecoveryDetails = Record<string, unknown>;

export interface RecoveryEventV1 {
  schema_version: 1;
  event_id: string;
  run_id: string;
  app: string;
  environment: string;
  app_user_id: string;
  kind: RecoveryKind;
  occurred_at: string;
  correlation_id: string;
  source_event_id: string;
  details: RecoveryDetails;
}

export interface Version2ProcessingReceipt extends RecoveryDetails {
  processing_id: string;
  trace_id: string;
  transaction_id: string;
  steps: TraceStep[];
  revisions: TraceRevisions;
}

export type RecoveryEventV2 = Omit<RecoveryEventV1, "schema_version" | "kind" | "details"> & {
  schema_version: 2;
  kind: "access_projection_changed" | "handler_completed" | "mobile_observation";
  details: Version2ProcessingReceipt;
};

export type RecoveryEvent = RecoveryEventV1 | RecoveryEventV2;

export interface CollectorEnvelope {
  schema_version: 1 | 2;
  event: RecoveryEvent;
  sent_at: number;
}

export interface CollectorAcknowledgement {
  accepted: true;
  event_id: string;
  event_hash: string;
  duplicate: boolean;
}

export interface EventScope {
  runId?: string;
  app?: string;
  environment?: string;
}

const EVENT_FIELDS = new Set([
  "schema_version", "event_id", "run_id", "app", "environment", "app_user_id",
  "kind", "occurred_at", "correlation_id", "source_event_id", "details",
]);
const STATE_FIELDS = new Set([
  "active", "premium", "expires_at", "revision", "cache_revision",
  "projection_revision", "source_hash", "invalidated", "cached_at",
]);
const DETAIL_FIELDS = new Set([
  "event_type", "handler_version", "received_at", "processed_at", "outcome",
  "reason_code", "projection_version", "cache_version", "source_hash",
  "before", "after", "cache_invalidated", "feature", "decision",
  "policy_version", "adapter_version", "initiator", "starts_at", "expires_at",
  "action_id", "expected_revision", "actual_revision",
  "observation_kind", "transaction_id", "product_id", "price_id",
  "original_transaction_id", "source_environment", "store", "access_level",
  "customer_id", "source_version", "steps", "revisions", "processing_id",
  "trace_id", "stack",
]);
const DETAIL_KEYS: Record<RecoveryKind, Set<string>> = {
  mobile_observation: new Set(["observation_kind", "transaction_id", "product_id", "price_id", "feature", "reason_code"]),
  webhook_received: new Set(["event_type", "handler_version", "received_at", "processed_at", "outcome"]),
  handler_completed: new Set(["event_type", "handler_version", "received_at", "processed_at", "outcome", "reason_code"]),
  source_entitlement_observed: new Set(["source_hash", "starts_at", "expires_at", "adapter_version", "outcome", "reason_code"]),
  feature_access_decided: new Set(["feature", "decision", "reason_code", "projection_version", "cache_version", "policy_version", "adapter_version", "initiator"]),
  resync_requested: new Set(["action_id", "source_hash", "expected_revision", "policy_version", "adapter_version", "projection_version", "cache_version", "outcome", "reason_code"]),
  resync_completed: new Set(["action_id", "source_hash", "expected_revision", "policy_version", "adapter_version", "projection_version", "cache_version", "outcome", "reason_code", "processed_at", "cache_invalidated", "actual_revision"]),
  verification_completed: new Set(["feature", "decision", "outcome", "reason_code", "action_id", "policy_version", "adapter_version", "projection_version", "cache_version", "actual_revision"]),
  access_projection_changed: new Set(),
};
const PROJECTION_CANCEL_FIELDS = new Set([
  "event_type", "handler_version", "projection_version", "cache_version",
  "source_hash", "before", "after", "processed_at", "reason_code", "cache_invalidated",
]);
const PROJECTION_RESYNC_FIELDS = new Set([
  "action_id", "source_hash", "expected_revision", "policy_version",
  "adapter_version", "projection_version", "cache_version", "outcome",
  "before", "after", "cache_invalidated",
]);
const PROJECTION_V2_FIELDS = new Set(["processing_id", "trace_id", "transaction_id", "steps", "revisions"]);
const HANDLER_V2_FIELDS = new Set([...PROJECTION_V2_FIELDS, "projection_version", "adapter_version", "source_hash"]);
const TRACE_STEP_FIELDS = new Set(["name", "status", "at", "owner", "result", "revision", "reason_code", "gap"]);
const TRACE_STEPS = new Set([
  "receive", "handler", "fresh_source_read", "identity_check", "policy_check",
  "projection_commit", "cache_refresh", "gate_readback", "telemetry_enqueue",
  "projection_readback", "source_observation",
]);
const TRACE_STATUSES = new Set(["started", "completed", "failed", "skipped", "unknown"]);
const TRACE_OWNERS = new Set(["source", "lumen", "engine", "collector"]);
const TRACE_RESULTS = new Set([
  "accepted", "verified", "failed", "skipped", "matched", "mismatched",
  "committed", "queued", "unavailable", "not_required", "observed", "allowed",
  "denied", "replayed", "unknown",
]);
const TRACE_REASONS = new Set([
  "source_unavailable", "source_cooldown", "identity_mismatch", "policy_restricted",
  "projection_mismatch", "cache_mismatch", "gate_denied", "telemetry_gap",
  "readback_unknown", "timeout_after_commit", "handler_failure",
]);
const REASONS = new Set([
  "allowed", "policy_restricted", "identity_ambiguous", "identity_mismatch",
  "identity_unavailable", "cache_unavailable", "cache_stale", "subscription_expired",
  "subscription_inactive", "none", "source_unavailable", "identity_source_mismatch",
  "approved_resync", "resync_completed", "cache_refresh_skipped", "renewal_cancelled",
  "handler_completed", "handler_failure",
]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: RecordValue, expected: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function requireText(value: unknown, name: string, limit = 256): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || [...value].length > limit
      || /[\u0000-\u001f\u007f]/u.test(value)
      || /(?:\bBearer\s+\S{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(value)) {
    throw new TypeError(`Invalid collector ${name}`);
  }
}

function requireInteger(value: unknown, name: string, minimum = 0): asserts value is number | bigint {
  if (typeof value === "bigint") {
    if (value < BigInt(minimum)) throw new TypeError(`Invalid collector ${name}`);
    return;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`Invalid collector ${name}`);
  }
}

function requireTimestamp(value: unknown, name: string, allowNull = false): void {
  if (allowNull && value === null) return;
  if (typeof value !== "string") throw new TypeError(`Invalid collector ${name}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]00:00)$/u.exec(value);
  if (!match) throw new TypeError(`Collector ${name} must be UTC`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(`${yearText}-${monthText}-${dayText}T00:00:00Z`);
  if (year < 1 || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== `${yearText}-${monthText}-${dayText}`
      || month < 1 || month > 12 || day < 1 || day > 31
      || hour > 23 || minute > 59 || second > 59) {
    throw new TypeError(`Invalid collector ${name}`);
  }
}

function validateState(value: unknown, name: string): void {
  if (!isRecord(value) || !hasOnlyKeys(value, STATE_FIELDS)) throw new TypeError(`Invalid collector ${name} state`);
  for (const [field, item] of Object.entries(value)) {
    if (["active", "premium", "invalidated"].includes(field)) {
      if (typeof item !== "boolean") throw new TypeError("Invalid collector state value");
    } else if (["revision", "cache_revision", "projection_revision"].includes(field)) {
      requireInteger(item, "state value");
    } else if (["expires_at", "cached_at"].includes(field)) {
      requireTimestamp(item, field, true);
    } else {
      requireText(item, field);
    }
  }
}

function validateTraceSteps(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("Invalid collector trace steps");
  for (const step of value) {
    if (!isRecord(step) || !hasOnlyKeys(step, TRACE_STEP_FIELDS)
        || !["name", "status", "owner", "result"].every((key) => key in step)
        || !["name", "status", "owner", "result"].every((key) => typeof step[key] === "string")
        || !TRACE_STEPS.has(step.name as string) || !TRACE_STATUSES.has(step.status as string)
        || !TRACE_OWNERS.has(step.owner as string) || !TRACE_RESULTS.has(step.result as string)) {
      throw new TypeError("Invalid collector trace step");
    }
    for (const key of ["name", "status", "owner", "result"]) requireText(step[key], key, 64);
    if ("at" in step) requireTimestamp(step.at, "trace step time");
    if ("revision" in step) requireInteger(step.revision, "trace revision");
    if ("reason_code" in step && (typeof step.reason_code !== "string" || !TRACE_REASONS.has(step.reason_code))) {
      throw new TypeError("Invalid collector trace reason");
    }
    if ("gap" in step && typeof step.gap !== "boolean") throw new TypeError("Invalid collector trace gap");
  }
  if (new TextEncoder().encode(canonical(value)).byteLength > 16 * 1024) {
    throw new TypeError("Collector trace is too large");
  }
}

function validateTraceRevisions(value: unknown): void {
  const allowed = new Set(["identity", "policy", "projection", "cache"]);
  if (!isRecord(value) || Object.keys(value).length === 0 || !hasOnlyKeys(value, allowed)) {
    throw new TypeError("Invalid collector trace revisions");
  }
  for (const item of Object.values(value)) requireInteger(item, "trace revision");
}

function validateTraceStack(value: unknown): void {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError("Invalid collector trace stack");
  for (const frame of value) {
    if (!isRecord(frame) || !hasExactKeys(frame, new Set(["module", "function", "line"]))
        || typeof frame.module !== "string" || !/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(frame.module)
        || typeof frame.function !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(frame.function)) {
      throw new TypeError("Invalid collector trace stack frame");
    }
    requireInteger(frame.line, "trace stack line", 1);
  }
  if (new TextEncoder().encode(canonical(value)).byteLength > 4096) {
    throw new TypeError("Collector trace stack is too large");
  }
}

function validateDetails(kind: RecoveryKind, details: unknown): asserts details is RecoveryDetails {
  if (!isRecord(details) || !hasOnlyKeys(details, DETAIL_FIELDS)) {
    throw new TypeError("Collector details do not match the metadata contract");
  }
  let expected: Set<string>;
  if (kind === "access_projection_changed") {
    expected = details.action_id !== undefined ? new Set(PROJECTION_RESYNC_FIELDS) : new Set(PROJECTION_CANCEL_FIELDS);
    if (details.action_id !== undefined && [...PROJECTION_V2_FIELDS].some((field) => field in details)) {
      expected = new Set([...expected, ...PROJECTION_V2_FIELDS]);
      if ("stack" in details) expected.add("stack");
    }
  } else if (kind === "handler_completed" && [...HANDLER_V2_FIELDS].some((field) => field in details)) {
    expected = new Set([...DETAIL_KEYS[kind], ...HANDLER_V2_FIELDS]);
  } else {
    expected = DETAIL_KEYS[kind];
  }

  const optionalSource = new Set(["transaction_id", "original_transaction_id", "source_environment", "store", "access_level", "customer_id", "source_version"]);
  if (kind === "source_entitlement_observed") {
    if (![...expected].every((key) => key in details) || [...Object.keys(details)].some((key) => !expected.has(key) && !optionalSource.has(key))) {
      throw new TypeError("Collector details do not match the event contract");
    }
  } else if (kind === "mobile_observation") {
    const optionalMobile = new Set(["original_transaction_id", ...PROJECTION_V2_FIELDS, "stack"]);
    if (![...expected].every((key) => key in details) || Object.keys(details).some((key) => !expected.has(key) && !optionalMobile.has(key))) {
      throw new TypeError("Collector details do not match the event contract");
    }
  } else if (kind === "feature_access_decided") {
    if (![...expected].every((key) => key in details) || Object.keys(details).some((key) => !expected.has(key) && key !== "revisions")) {
      throw new TypeError("Collector details do not match the event contract");
    }
  } else if (!hasExactKeys(details, expected)) {
    throw new TypeError("Collector details do not match the event contract");
  }

  for (const [field, item] of Object.entries(details)) {
    if (kind === "mobile_observation" && item === null
        && ["transaction_id", "product_id", "price_id", "feature", "reason_code"].includes(field)) continue;
    if (field === "before" || field === "after") validateState(item, field);
    else if (["starts_at", "expires_at", "processed_at", "received_at", "at"].includes(field)) {
      requireTimestamp(item, field, field === "starts_at" || field === "expires_at");
    } else if (field === "expected_revision" || field === "actual_revision") requireInteger(item, field);
    else if (field === "cache_invalidated") {
      if (typeof item !== "boolean") throw new TypeError("Invalid collector cache_invalidated");
    } else if (field === "steps") validateTraceSteps(item);
    else if (field === "revisions") validateTraceRevisions(item);
    else if (field === "stack") validateTraceStack(item);
    else if (field === "gap") {
      if (typeof item !== "boolean") throw new TypeError("Invalid collector trace gap");
    } else requireText(item, field);
  }

  if (kind === "mobile_observation" && !["purchase_succeeded", "subscription_profile_updated", "access_denied"].includes(details.observation_kind as string)) {
    throw new TypeError("Unsupported mobile observation kind");
  }
  if (details.feature !== undefined && details.feature !== null && details.feature !== "premium_export") {
    throw new TypeError("Unsupported collector feature");
  }
  if ("decision" in details && details.decision !== "allow" && details.decision !== "deny") {
    throw new TypeError("Unsupported collector decision");
  }
  if ("initiator" in details && details.initiator !== "customer_demo" && details.initiator !== "reconcile_probe") {
    throw new TypeError("Unsupported collector initiator");
  }
  if (details.reason_code !== undefined && details.reason_code !== null && !REASONS.has(details.reason_code as string)) {
    throw new TypeError("Unsupported collector reason code");
  }
  if (Array.isArray(details.steps)) {
    for (const step of details.steps) {
      if (isRecord(step) && step.reason_code !== undefined && !TRACE_REASONS.has(step.reason_code as string)) {
        throw new TypeError("Unsupported collector trace reason");
      }
    }
  }
  if (details.event_type !== undefined && details.event_type !== "subscription_renewal_cancelled"
      && !(kind === "handler_completed" && details.event_type === "source_entitlement_observed")) {
    throw new TypeError("Unsupported collector event type");
  }
  if (details.handler_version !== undefined
      && !["cancel-handler-v1", "cancel-handler-v2"].includes(details.handler_version as string)
      && !(kind === "handler_completed" && [...HANDLER_V2_FIELDS].every((field) => field in details))) {
    throw new TypeError("Unsupported collector handler version");
  }
  if (details.outcome !== undefined) {
    const outcomes: Partial<Record<RecoveryKind, string[]>> = {
      webhook_received: ["accepted"],
      handler_completed: ["completed", "failed", "unknown"],
      source_entitlement_observed: ["observed", "unavailable"],
      resync_requested: ["requested"],
      resync_completed: ["accepted"],
      verification_completed: ["verified", "failed"],
    };
    if (!(outcomes[kind] ?? ["projection_updated"]).includes(details.outcome as string)) {
      throw new TypeError("Unsupported collector outcome");
    }
  }
}

export function validateEvent(event: unknown, scope: EventScope = {}): asserts event is RecoveryEvent {
  if (!isRecord(event) || !hasExactKeys(event, EVENT_FIELDS)) {
    throw new TypeError("Collector event fields do not match the metadata contract");
  }
  if (typeof event.schema_version !== "number" || !Number.isInteger(event.schema_version)
      || (event.schema_version !== SCHEMA_VERSION && event.schema_version !== TRACE_SCHEMA_VERSION)) {
    throw new TypeError("Unsupported collector event schema version");
  }
  for (const name of EVENT_FIELDS) {
    if (name === "schema_version" || name === "details") continue;
    requireText(event[name], name, ["run_id", "app", "environment", "app_user_id"].includes(name) ? 128 : 256);
  }
  requireTimestamp(event.occurred_at, "occurred_at");
  if (typeof event.kind !== "string" || !(KINDS as readonly string[]).includes(event.kind)) {
    throw new TypeError("Unsupported collector event kind");
  }
  if (scope.runId !== undefined && event.run_id !== scope.runId) throw new TypeError("Collector run scope mismatch");
  if (scope.app !== undefined && event.app !== scope.app) throw new TypeError("Collector app scope mismatch");
  if (scope.environment !== undefined && event.environment !== scope.environment) throw new TypeError("Collector environment scope mismatch");
  const kind = event.kind as RecoveryKind;
  validateDetails(kind, event.details);
  if (event.schema_version === TRACE_SCHEMA_VERSION) {
    const details = event.details;
    const projectionV2 = kind === "access_projection_changed" && [...PROJECTION_V2_FIELDS].every((field) => field in details);
    const handlerV2 = kind === "handler_completed" && [...HANDLER_V2_FIELDS].every((field) => field in details)
      && typeof details.transaction_id === "string" && details.transaction_id.length > 0;
    const mobileV2 = kind === "mobile_observation" && [...PROJECTION_V2_FIELDS].every((field) => field in details)
      && typeof details.transaction_id === "string" && details.transaction_id.length > 0;
    if (!projectionV2 && !handlerV2 && !mobileV2) {
      throw new TypeError("Version-2 collector events require a processing receipt");
    }
  }
  if (new TextEncoder().encode(canonical(event as unknown as CanonicalValue)).byteLength > 16 * 1024) {
    throw new TypeError("Collector event is too large");
  }
}
