import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createLumenService, type LiveConfig } from "./service.js";

function loadKey(path: string): Buffer {
  let value: string;
  let fd: number | undefined;
  try {
    fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error('invalid');
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd,bytes,size,bytes.length - size,size);
      if (!count) break;
      size += count;
    }
    if (size > 4096) throw new Error('invalid');
    value = new TextDecoder('utf-8',{ fatal:true }).decode(bytes.subarray(0,size)).trim();
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid');
  } catch { throw new Error("Shared key file must be a private regular file with mode 0600"); }
  finally { if (fd !== undefined) closeSync(fd); }
  let key: Buffer;
  if (/^(?:[0-9a-fA-F]{2}){32,}$/u.test(value)) key = Buffer.from(value, "hex");
  else key = Buffer.from(value, "utf8");
  if (key.byteLength < 32) throw new Error("Shared key must contain at least 32 bytes");
  return key;
}

function readLiveConfig(path: string): LiveConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid live configuration");
  const source = parsed as Record<string, unknown>;
  const appId = source.app_id ?? source.appId;
  const sourceEnvironment = source.source_environment ?? source.sourceEnvironment;
  const customerUserIds = source.customer_user_ids ?? source.customerUserIds;
  if (typeof appId !== "string" || typeof sourceEnvironment !== "string"
      || !Array.isArray(customerUserIds) || customerUserIds.length !== 100
      || customerUserIds.some((item) => typeof item !== "string" || !item)) {
    throw new Error("Live config must define an app, environment, and 100 customer IDs");
  }
  return { appId, sourceEnvironment, customerUserIds: customerUserIds as string[] };
}

async function main(): Promise<void> {
  const port = Number(process.env.LUMEN_PORT ?? 8766);
  const providerUrl = process.env.PROVIDER_URL;
  const keyPath = process.env.RECOVERY_KEY_FILE;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !providerUrl || !keyPath) {
    throw new Error("Set LUMEN_PORT, PROVIDER_URL, and RECOVERY_KEY_FILE");
  }
  const liveConfigPath = process.env.LUMEN_LIVE_CONFIG;
  const liveConfig = liveConfigPath ? readLiveConfig(resolve(liveConfigPath)) : undefined;
  const service = await createLumenService({
    port,
    dbPath: resolve(process.env.LUMEN_DB ?? "runtime/lumen-node.sqlite3"),
    outboxPath: resolve(process.env.LUMEN_OUTBOX_DB ?? "runtime/lumen-outbox.sqlite3"),
    key: loadKey(isAbsolute(keyPath) ? keyPath : resolve(keyPath)),
    providerUrl,
    collectorUrl: process.env.COLLECTOR_URL,
    app: process.env.LUMEN_APP ?? liveConfig?.appId,
    environment: process.env.LUMEN_ENVIRONMENT,
    runId: process.env.LUMEN_RUN_ID,
    scenario: process.env.LUMEN_SCENARIO,
    liveConfig,
    demo: process.env.LUMEN_DEMO === "true",
    liveBootstrapPending: process.env.LUMEN_LIVE_BOOTSTRAP_PENDING === "true",
  });
  const boundPort = await service.listen(port);
  process.stdout.write(`${JSON.stringify({ role: "lumen", port: boundPort })}\n`);
  const stop = async () => { await service.close(); process.exitCode = 0; };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Lumen startup failed"}\n`);
  process.exitCode = 1;
});
