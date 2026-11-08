import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function loopbackUrl(value: string, expectedPath = ''): URL {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid loopback URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid loopback URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const ipv4Loopback = isIP(host) === 4 && host.split('.')[0] === '127';
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || !(host === 'localhost' || host === '::1' || ipv4Loopback)
      || url.pathname.replace(/\/+$/, '') !== expectedPath
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) {
    throw new Error('Invalid loopback URL');
  }
  return url;
}

export function signInternal(key: Uint8Array, method: string, path: string,
  timestamp: number, body: Uint8Array): string {
  if (key.byteLength < 32 || !/^[A-Za-z]+$/.test(method)
      || !path.startsWith('/') || /[\r\n]/.test(path) || !Number.isSafeInteger(timestamp)) {
    throw new Error('Invalid internal signing input');
  }
  const hash = createHash('sha256').update(body).digest('hex');
  const material = `recovery-internal-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${hash}`;
  return createHmac('sha256', key).update(material, 'utf8').digest('hex');
}

export function verifyInternal(key: Uint8Array, method: string, path: string,
  timestamp: string, body: Uint8Array, signature: string, now = Date.now()): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(now) || Math.abs(now / 1000 - seconds) > 300) return false;
  try {
    const expected = Buffer.from(signInternal(key, method, path, seconds, body), 'hex');
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
