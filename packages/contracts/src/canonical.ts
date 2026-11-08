/** JSON serialization for cross-language fingerprints. Numbers must be integers. */
export type CanonicalValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value)!;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Canonical JSON accepts only safe integer numbers; use bigint for larger integers");
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Value is not in the canonical JSON domain");
  }
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => encode(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON requires plain objects");
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      throw new TypeError("Canonical JSON object keys must be strings");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Match Python's compact, UTF-8 JSON for objects containing only integer numbers.
 * Python distinguishes ints from floats after parsing; JS does not, so fractional,
 * non-finite, and unsafe Number values are rejected instead of fingerprinted differently.
 */
export function canonical(value: unknown): string {
  return encode(value, new Set());
}
