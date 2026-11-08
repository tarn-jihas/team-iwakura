import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { canonical } from "@reconcile/server-sdk";

const BODY_LIMIT = 1024 * 1024;

export class InternalHTTPError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string) {
    super(message);
    this.name = "InternalHTTPError";
  }
}

export function loopbackUrl(value: string, expectedPath = ""): URL {
  if (typeof value !== "string" || value.length > 512) throw new TypeError("Invalid loopback URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("Invalid loopback URL"); }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.$/u, "");
  const ipv4Loopback = isIP(host) === 4 && host.split(".")[0] === "127";
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash
      || !(host === "localhost" || host === "::1" || ipv4Loopback)
      || url.pathname.replace(/\/+$/u, "") !== expectedPath
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) {
    throw new TypeError("Invalid loopback URL");
  }
  return url;
}

export function signInternal(key: Uint8Array, method: string, path: string, timestamp: number, body: Uint8Array): string {
  if (key.byteLength < 32 || !/^[A-Za-z]+$/u.test(method) || !path.startsWith("/")
      || /[\r\n]/u.test(path) || !Number.isSafeInteger(timestamp)) throw new TypeError("Invalid internal signing input");
  const hash = createHash("sha256").update(body).digest("hex");
  const material = `recovery-internal-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${hash}`;
  return createHmac("sha256", key).update(material, "utf8").digest("hex");
}

export function verifyInternal(key: Uint8Array, method: string, path: string, timestamp: string,
  body: Uint8Array, signature: string, now = Date.now()): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(timestamp) || !/^[0-9a-f]{64}$/u.test(signature)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(now) || Math.abs(now / 1000 - seconds) > 300) return false;
  try {
    const expected = Buffer.from(signInternal(key, method, path, seconds, body), "hex");
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  } catch { return false; }
}

async function readBounded(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_LIMIT) {
        try { await reader.cancel(); } catch { /* Keep the size failure. */ }
        throw new InternalHTTPError(502, "Simulator response too large");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}

function retryDelay(value: string | null): number {
  if (value === null) return 1;
  const text = value.trim();
  if (/^\d+$/u.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds : Number.MAX_SAFE_INTEGER;
  }
  const date = /^[A-Za-z]{3,9}(?:,|\s)/u.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : 1;
}

export async function internalRequest(key: Uint8Array, base: URL, method: "GET" | "POST", path: string,
  body?: unknown, timeoutMs = 15_000): Promise<unknown> {
  if (!path.startsWith("/") || /[\r\n]/u.test(path)) throw new TypeError("Invalid internal path");
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(canonical(body), "utf8");
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signInternal(key, method, path, timestamp, raw);
  const headers: Record<string, string> = {
    "X-Recovery-Timestamp": String(timestamp),
    "X-Recovery-Signature": signature,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method, headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: raw }),
      });
    } catch {
      throw new InternalHTTPError(503, "Internal simulator is unavailable");
    }
    const payload = await readBounded(response);
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      if (attempt >= 3 || retryDelay(retry) > 5) throw new InternalHTTPError(429, "Internal simulator is rate limited", retry ?? undefined);
      await new Promise((resolve) => setTimeout(resolve, retryDelay(retry) * 1000));
      continue;
    }
    let result: unknown;
    try { result = payload.length ? JSON.parse(payload.toString("utf8")) : {}; }
    catch { throw new InternalHTTPError(502, "Invalid simulator response"); }
    if (!response.ok) throw new InternalHTTPError(response.status, "Internal simulator request failed", response.headers.get("Retry-After") ?? undefined);
    return result;
  }
}
