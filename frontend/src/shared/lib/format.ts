/**
 * Money arrives from the server as Decimal strings ("989.01", "-11.98").
 * Formatting never converts it to a JS number, so precision is never lost.
 */
export function money(value: string | number | null | undefined, signed = false): string {
  if (value === undefined || value === null) return '—';
  const text = String(value);
  if (!/^-?\d+\.\d{2}$/.test(text)) return text;
  const [integer, fraction] = text.replace(/^-/, '').split('.');
  const sign = text.startsWith('-') ? '−' : signed && !/^0+\.00$/.test(text) ? '+' : '';
  return `${sign}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

export const pretty = (data: unknown): string => (typeof data === 'string' ? data : JSON.stringify(data, null, 2));

/** Escapes text for HTML. React escapes JSX automatically; kept for parity with the original view helpers. */
export function h(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
