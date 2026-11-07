import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, renderMonitor } from '../dist/monitor-view.js';

const item = (overrides = {}) => ({id:'incident-1',title:'Access issue',description:'<img src=x onerror=alert(1)>',status:'repaired',affected_accounts:24,repaired_accounts:24,detected_at:'2026-01-02T03:04:05Z',repair_started_at:'2026-01-02T03:04:06Z',repaired_at:'2026-01-02T03:04:07Z',duration_ms:3408,repair_summary:'Restored',next_step:'',source_provenance:'Adapty',payment_verification:'not_independently_verified',...overrides});
const feed = (incidents, automation = true, ready = true) => ({mode:'LIVE_ADAPTY_SEEDED',app:{title:'Lumen',environment:'demo'},automation:{enabled:automation},connection:{ready,active_accounts:100,total_accounts:100,cli_version:'1.2.3',catalog_product_count:6,source_observed_at:'2026-01-02T03:00:00Z'},summary:{incidents:incidents.length,fixed:incidents.filter(x=>x.status==='repaired').length,needs_attention:incidents.filter(x=>x.status==='unresolved').length},telemetry:{queued:1,dropped:0,failed:0},simulation:{status:'idle'},incidents});

test('renders empty and manual feeds honestly', () => {
  assert.match(renderMonitor(feed([])), /No incidents yet/);
  assert.match(renderMonitor(feed([])), /Live Adapty · Seeded data/);
  assert.match(renderMonitor(null, {pollError:'<script>error</script>'}), /&lt;script&gt;error&lt;\/script&gt;/);
  const html = renderMonitor(feed([], false));
  assert.match(html, /Manual mode/);
  assert.doesNotMatch(html, /Run demo/);
  assert.match(html, /Open advanced tools/);
  assert.match(renderMonitor(feed([], true, false)), /Source unavailable/);
  assert.match(renderMonitor(feed([], true, false)), /data-action="start" disabled/);
  const integration = renderMonitor(feed([]));
  assert.match(integration, /100 active · 100 total accounts/);
  assert.match(integration, /Source readiness \(last check\)/);
  assert.match(integration, /Jan 2, 2026 at 3:00 AM UTC|Jan 2, 2026, 3:00 AM UTC/);
  assert.match(integration, /not the full provider account population/);
});

test('renders incident states and escapes untrusted feed text', () => {
  for (const status of ['repairing','repaired','unresolved']) assert.match(renderMonitor(feed([item({status})])), new RegExp(status === 'unresolved' ? 'Needs attention' : status === 'repaired' ? 'Repaired' : 'Repairing'));
  const html = renderMonitor(feed([item()]));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /UTC/);
  assert.match(html, /3\.4 s/);
  assert.match(html, /data-incident="incident-1"/);
  assert.match(html, /not_independently_verified/);
  const aggregated = renderMonitor(feed([item({actions:Array.from({length:48},()=>({owner:'Lumen',status:'verified'}))})]));
  assert.match(aggregated, /Lumen · verified · 48 steps/);
  assert.doesNotMatch(aggregated, /Lumen: verified · Lumen: verified/);
  const partial = renderMonitor(feed([item({status:'unresolved',affected_accounts:24,repaired_accounts:23,next_step:'Check account 24'})]));
  assert.match(partial, /24/);
  assert.match(partial, /23 repaired/);
  assert.match(partial, /Check account 24/);
  assert.match(renderMonitor(feed([item({status:'repaired',affected_accounts:24,repaired_accounts:24})])), /24 repaired/);
});

test('CSV quotes text, preserves timestamps and neutralizes formulas', () => {
  const text = csv([item({title:'say "yes",\nnext ☃',description:'=1+1',repair_summary:'+cmd',source_provenance:'@origin',payment_verification:'-1'})]);
  assert.match(text, /"say ""yes"",\nnext ☃"/);
  assert.match(text, /"'=1\+1"/);
  assert.match(text, /"'\+cmd"/);
  assert.match(text, /"'@origin"/);
  assert.match(text, /"'-1"/);
  assert.match(text, /2026-01-02T03:04:05Z/);
});

test('pending controls are disabled and polling and action errors remain separate', () => {
  const pending = renderMonitor(feed([item()]), {pending:true,requestMessage:'Request pending'});
  assert.match(pending, /data-action="start" disabled/);
  assert.match(pending, /data-action="once" disabled/);
  assert.match(pending, /Request pending/);
  const errors = renderMonitor(feed([]), {pollError:'Feed unavailable',actionError:'Simulation rejected'});
  assert.match(errors, /Feed unavailable/);
  assert.match(errors, /Simulation rejected/);
});

test('a running simulation can be stopped when the source becomes unavailable', () => {
  const data = {...feed([], true, false), simulation:{status:'running',completed:1,total:3}};
  const html = renderMonitor(data);
  assert.match(html, /data-action="stop" >Stop simulation/);
  assert.doesNotMatch(html, /data-action="stop" disabled/);
  assert.match(renderMonitor(data, {pending:true}), /data-action="stop" disabled/);
});
