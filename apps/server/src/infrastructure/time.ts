/** Parse timezone-qualified source timestamps without accepting invalid calendar dates. */
export function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) return Number.NaN;
  const [, year, month, day, hour, minute, second, zone] = parts;
  if (!year || !month || !day || !hour || !minute || !second || !zone) return Number.NaN;
  const y = Number(year), m = Number(month), d = Number(day), h = Number(hour), mi = Number(minute), s = Number(second);
  if (y < 1) return Number.NaN;
  const reference = new Date(0);
  reference.setUTCFullYear(y, m - 1, d);
  reference.setUTCHours(h, mi, s, 0);
  if (reference.getUTCFullYear() !== y || reference.getUTCMonth() !== m - 1
      || reference.getUTCDate() !== d || reference.getUTCHours() !== h
      || reference.getUTCMinutes() !== mi || reference.getUTCSeconds() !== s) return Number.NaN;
  if (zone.toUpperCase() !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) {
    return Number.NaN;
  }
  return Date.parse(value);
}
