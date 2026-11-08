import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPrivateApiKey } from '@reconcile/server/source/adapty-reader';
import { createProviderService, type LiveProviderConfig } from './service.js';

const APP_ID = '46a573aa-8c90-4b4b-ba72-2349ae9fb030';
const APP_TITLE = 'Lumen - AI Photo Editor (Hackathon)';
const ENVIRONMENT = 'hackathon_seed';
const SOURCE_ENVIRONMENT = 'Production';

function parseLiveConfig(path: string): { config: LiveProviderConfig; secretKeyFile: string } {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024) throw new Error('Live config must be a regular file');
  const parsed: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Live config is invalid');
  const value = parsed as Record<string, unknown>;
  const seed = value.seed;
  const userIds = value.customer_user_ids;
  if (value.app_id !== APP_ID || value.title !== APP_TITLE || value.environment !== ENVIRONMENT
      || (value.source_environment ?? SOURCE_ENVIRONMENT) !== SOURCE_ENVIRONMENT
      || typeof seed !== 'object' || seed === null || Array.isArray(seed)
      || typeof (seed as Record<string, unknown>).revision !== 'string'
      || typeof (seed as Record<string, unknown>).run_prefix !== 'string'
      || !Array.isArray(userIds) || userIds.length !== 100
      || userIds.some((item) => typeof item !== 'string' || !item)
      || new Set(userIds).size !== 100 || typeof value.secret_key_file !== 'string'
      || !value.secret_key_file.startsWith('/')) throw new Error('Live config scope is invalid');
  const seedValue = seed as Record<string, unknown>;
  return {
    config: { appId: APP_ID, appTitle: APP_TITLE, environment: ENVIRONMENT,
      sourceEnvironment: SOURCE_ENVIRONMENT, seedRevision: String(seedValue.revision),
      seedRunPrefix: String(seedValue.run_prefix), customerUserIds: userIds as string[] },
    secretKeyFile: value.secret_key_file,
  };
}

async function loadInternalKey(path: string): Promise<Buffer> {
  const text = await loadPrivateApiKey(path);
  const key = /^(?:[0-9a-fA-F]{2}){32,}$/u.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'utf8');
  if (key.byteLength < 32) throw new Error('Recovery key must contain at least 32 bytes');
  return key;
}

async function main(): Promise<void> {
  const port = Number(process.env.PROVIDER_PORT ?? 8767);
  const keyPath = process.env.RECOVERY_KEY_FILE;
  const mode = process.env.PROVIDER_MODE ?? 'mock';
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !keyPath || !['mock', 'live'].includes(mode)) {
    throw new Error('Set PROVIDER_PORT, PROVIDER_MODE, and RECOVERY_KEY_FILE');
  }
  const options = {
    dbPath: resolve(process.env.PROVIDER_DB ?? 'runtime/provider-simulator.sqlite3'),
    key: await loadInternalKey(resolve(keyPath)),
    mode: mode as 'mock' | 'live',
  };
  let service;
  if (mode === 'live') {
    const configPath = process.env.PROVIDER_LIVE_CONFIG;
    if (!configPath) throw new Error('Set PROVIDER_LIVE_CONFIG in live mode');
    const { config, secretKeyFile } = parseLiveConfig(configPath);
    const apiKey = await loadPrivateApiKey(secretKeyFile);
    service = await createProviderService({ ...options, liveConfig: config, apiKey });
  } else {
    const sampleSize = Number(process.env.PROVIDER_SAMPLE_SIZE ?? 100);
    if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 1000) throw new Error('Invalid PROVIDER_SAMPLE_SIZE');
    service = await createProviderService({ ...options,
      fixtureDirectory: process.env.PROVIDER_FIXTURE_DIR ? resolve(process.env.PROVIDER_FIXTURE_DIR) : undefined,
      runId: process.env.PROVIDER_RUN_ID ?? 'offline-77d39ed8', sampleSize,
      activeOverlay:process.env.PROVIDER_ACTIVE_OVERLAY === 'true',
    });
  }
  const boundPort = await service.listen(port);
  process.stdout.write(`${JSON.stringify({ role: 'provider', port: boundPort, mode })}\n`);
  const stop = async () => { await service.close(); process.exitCode = 0; };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Provider startup failed'}\n`);
  process.exitCode = 1;
});
