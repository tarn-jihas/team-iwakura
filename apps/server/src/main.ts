import { resolve } from 'node:path';
import { loadPrivateApiKey } from './modules/source/adapty-reader.js';
import { EngineRuntime } from './http/runtime.js';

async function main():Promise<void> {
  const port = Number(process.env.ENGINE_PORT ?? 8768), keyFile = process.env.RECOVERY_KEY_FILE;
  const providerUrl = process.env.PROVIDER_URL, lumenUrl = process.env.LUMEN_URL;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !keyFile || !providerUrl || !lumenUrl) {
    throw new Error('Set ENGINE_PORT, RECOVERY_KEY_FILE, PROVIDER_URL and LUMEN_URL');
  }
  const text = await loadPrivateApiKey(resolve(keyFile));
  const key = /^(?:[0-9a-fA-F]{2}){32,}$/.test(text) ? Buffer.from(text,'hex') : Buffer.from(text,'utf8');
  const runtime = await EngineRuntime.create({ key,providerUrl,lumenUrl,
    databasePath:resolve(process.env.ENGINE_DB ?? 'runtime/typescript/engine.sqlite3'),
    analyticsDatabasePath:resolve(process.env.ANALYTICS_DB ?? 'runtime/typescript/analytics.sqlite3'),
    accessDatabasePath:resolve(process.env.ACCESS_DB ?? 'runtime/typescript/access.sqlite3'),
    webRoot:resolve(process.env.WEB_ROOT ?? 'apps/web/dist') });
  const bound = await runtime.listen(port);
  process.stdout.write(`${JSON.stringify({ role:'engine',port:bound })}\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); process.exitCode = 0; };
  process.once('SIGINT',() => { void stop(); });
  process.once('SIGTERM',() => { void stop(); });
}

void main().catch((error:unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Engine startup failed'}\n`);
  process.exitCode = 1;
});
