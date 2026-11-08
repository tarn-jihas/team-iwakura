import { formatMoney, parseSource, reconcile, SCENARIOS } from './legacy-engine';
import { loadFixture } from './fixture-loader';

type Data = Record<string, any>;
const source = async (file: string, provider: string, provenance = 'synthetic') => {
  const parsed = parseSource(await loadFixture(file), provider);
  parsed.filename = file;
  parsed.provenance = provenance;
  return parsed;
};

export async function loadLegacyCase(id: string, coverage = 'declared_complete') {
  if (id === 'store_reference') {
    const [left, right] = await Promise.all([source('google_orders.json', 'google_play'), source('adapty.jsonl', 'adapty')]);
    return { ...reconcile(left, right, { coverage, label: 'Google Play → Adapty cash operations' }), id, title: 'Google Play → Adapty cash operations', description: 'Eight synthetic order objects produce eight charges and one refund.' };
  }
  const scenario = SCENARIOS.find(item => item.id === id);
  if (!scenario) throw new Error('Unknown demo scenario.');
  const [left, right] = await Promise.all([source('adapty.jsonl', 'adapty'), source(`${id}.jsonl`, 'mixpanel')]);
  return { ...reconcile(left, right, { coverage, label: scenario.title }), id, title: scenario.title, description: scenario.description };
}

export function formatLegacyMoney(value: string | number | bigint | null | undefined) {
  return formatMoney(value);
}

export function legacyReport(result: Data, review = 'open') {
  return {
    schema_version: 'reconcile-browser-demo/1', generated_at: new Date().toISOString(),
    implementation: 'Browser prototype; no hosted reconciliation backend, provider connection, model or MCP transport is active.',
    provenance: result.source, case_id: result.id, case_title: result.title, fingerprint: result.fingerprint,
    fingerprint_algorithm: 'FNV-1a demonstration identifier, not a cryptographic digest', contract: result.contract,
    coverage: result.coverage, verdict: result.verdict, delta_minor: result.deltaMinor, counts: result.counts,
    current_review: { status: review, scope: 'Human review state in this browser; independent of computed outcome' },
    sources: [result.left, result.right].map((item: Data) => ({ provider: item.provider, filename: item.filename, provenance: item.provenance, record_count: item.recordCount, raw_operations: item.rawCount, deduplicated_operations: item.dedupCount, total_minor: item.totalMinor, raw_text: item.rawText })),
    findings: result.findings, operations: result.operations,
  };
}
