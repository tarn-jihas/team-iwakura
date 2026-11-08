import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, renderMonitor } from '../dist/monitor-view.js';

const item = (overrides = {}) => ({id:'incident-1',title:'Access issue',description:'<img src=x onerror=alert(1)>',status:'repaired',affected_accounts:24,repaired_accounts:24,detected_at:'2026-01-02T03:04:05Z',repair_started_at:'2026-01-02T03:04:06Z',repaired_at:'2026-01-02T03:04:07Z',duration_ms:3408,repair_summary:'Restored',next_step:'',source_provenance:'Adapty',payment_verification:'not_independently_verified',...overrides});
const feed = (incidents, automation = true, ready = true) => ({mode:'LIVE_ADAPTY_SEEDED',app:{title:'Lumen',environment:'demo'},automation:{enabled:automation},connection:{ready,active_accounts:100,total_accounts:100,cli_version:'1.2.3',catalog_product_count:6,source_observed_at:'2026-01-02T03:00:00Z'},summary:{incidents:incidents.length,fixed:incidents.filter(x=>x.status==='repaired').length,needs_attention:incidents.filter(x=>x.status==='unresolved').length},telemetry:{queued:1,dropped:0,failed:0},simulation:{status:'idle'},incidents});

test('real fulfillment DTOs show readable periods and telemetry behind disclosure', () => {
  const html = renderMonitor(feed([]), {fulfillments:[{
    key:{customer_id:'customer-1',transaction_id:'transaction-1'},
    source_period:{starts_at:'2026-01-02T03:00:00Z',expires_at:'2027-01-02T03:00:00Z'},
    stages:{source_recorded:true,application_applied:false,access_verified:null},
    telemetry_gap:true,
  }]});
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.match(html, /Processing telemetry is incomplete/);
  assert.match(html, /Not confirmed/);
  assert.match(html, /Access verified: Unknown/);
  assert.match(html, /<details class="integration"><summary>Observed access updates/);
});

test('incident activity retains account context and actual processing receipts', () => {
  const html = renderMonitor(feed([item()]), {traces:{'incident-1':{
    traces:[{user_id:'account-a',status:'discrepancy',steps:[{
      name:'projection_readback',status:'failed',owner:'lumen',result:'mismatched'}]}],
    processing_receipts:[{transaction_id:'transaction-a',steps:[{
      name:'handler',status:'failed',owner:'lumen',result:'failed',gap:true}]},
      {user_id:'account-a',transaction_id:'transaction-b',steps:[]}],
  }}});
  assert.match(html, /class="trace-account"><summary>account-a/);
  assert.match(html, /account-a · Access mismatch/);
  assert.match(html, /class="trace-account"><summary>transaction-a/);
  assert.match(html, /projection readback/);
  assert.match(html, /Telemetry incomplete/);
});

test('a pending first replay has one obvious bootstrap action', () => {
  const data = {...feed([]),simulation:{status:'idle',bootstrap_required:true}};
  const html = renderMonitor(data);
  assert.match(html, /data-action="bootstrap" >Start demo/);
  assert.doesNotMatch(html, /data-action="continuous"/);
  assert.doesNotMatch(html, /data-action="once"/);
});

test('renders empty and manual feeds honestly', () => {
  assert.match(renderMonitor(feed([])), /No incidents yet/);
  assert.match(renderMonitor(feed([])), /Live Adapty · Seeded data/);
  assert.match(renderMonitor(null, {pollError:'<script>error</script>'}), /&lt;script&gt;error&lt;\/script&gt;/);
  const html = renderMonitor(feed([], false));
  assert.match(html, /Manual mode/);
  assert.doesNotMatch(html, /Run demo/);
  assert.match(html, /Open advanced tools/);
  assert.match(renderMonitor(feed([], true, false)), /Source unavailable/);
  assert.match(renderMonitor(feed([], true, false)), /data-action="continuous" disabled/);
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
  const activity = renderMonitor({...feed([item({status:'unresolved',affected_accounts:24,repaired_accounts:23})]),summary:{incidents:900,fixed:800,needs_attention:100},pagination:{total:100}}, {fulfillments:[{key:'user-1',source_period:'2026-01',stages:{source_recorded:true,application_applied:{status:'applied'},access_verified:{status:'unknown'}},telemetry_gap:'<script>x</script>',next_step:'Check gate'}],traces:{'incident-1':{steps:[{name:'Access check',status:'unknown',owner:'App',result:'<script>x</script>',at:'2026-01-02T03:04:05Z'}],next_step:'Retry'}}});
  assert.match(activity, /900/);
  assert.match(activity, /100 total/);
  assert.match(activity, /23 repaired/);
  assert.match(activity, /Adapty recorded/);
  assert.match(activity, /Application applied/);
  assert.match(activity, /Access verified: unknown/);
  assert.match(activity, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(activity, /<script>/);
  const snapshot = renderMonitor(feed([item()]), {traces:{'incident-1':{steps:[],_loaded_at:'2026-01-02T03:04:05Z'}}});
  assert.match(snapshot, /Snapshot Jan 2, 2026/);
  assert.match(snapshot, /Refresh activity/);
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
  assert.match(pending, /data-action="continuous" disabled/);
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
  const continuous = renderMonitor({...data, simulation:{status:'running',continuous:true,completed:3,total:0}});
  assert.match(continuous, /3 scenarios completed/);
  assert.doesNotMatch(continuous, /3 of 0/);
  assert.doesNotMatch(renderMonitor({...data,simulation:{status:'stopped',waiting_reason:'no_candidates'}}), /no_candidates/);
  assert.match(renderMonitor({...data,simulation:{status:'stopped',waiting_reason:'engine_storage_limit',error:'engine_storage_limit'}}), /engine storage limit/);
});
