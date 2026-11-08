import { createHash } from 'node:crypto';

function codePointOrder(left: string, right: string): number {
  const a = Array.from(left, char => char.codePointAt(0)!);
  const b = Array.from(right, char => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** Fresh-runtime semantic JSON; numeric formatting can differ from Python for floats. */
export function semanticJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (/\p{Surrogate}/u.test(value)) throw new Error('Invalid source JSON');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(semanticJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid source JSON');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(codePointOrder).map(key =>
      `${semanticJson(key)}:${semanticJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Invalid source JSON');
}

export function semanticDigest(value: unknown): string {
  return createHash('sha256').update(semanticJson(value), 'utf8').digest('hex');
}
