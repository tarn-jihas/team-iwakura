import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, renderMonitor } from '../dist/monitor-view.js';

const item = (overrides = {}) => ({id:'incident-1',title:'Access issue',description:'<img src=x onerror=alert(1)>',status:'repaired',affected_accounts:24,repaired_accounts:24,detected_at:'2026-01-02T03:04:05Z',repair_started_at:'2026-01-02T03:04:06Z',repaired_at:'2026-01-02T03:04:07Z',duration_ms:3408,repair_summary:'Restored',next_step:'',source_provenance:'Adapty',payment_verification:'not_independently_verified',...overrides});
const feed = (incidents, automation = true, ready = true) => ({mode:'LIVE_ADAPTY_SEEDED',app:{title:'Lumen',environment:'demo'},automation:{enabled:automation},connection:{ready,active_accounts:100,total_accounts:100,cli_version:'1.2.3',catalog_product_count:6,source_observed_at:'2026-01-02T03:00:00Z'},summary:{incidents:incidents.length,fixed:incidents.filter(x=>x.status==='repaired').length,needs_attention:incidents.filter(x=>x.status==='unresolved').length},telemetry:{queued:1,dropped:0,failed:0},simulation:{status:'idle'},incidents});

test('incomplete access observations give a next step without an unknown stage ladder', () => {
  const html = renderMonitor(feed([]), {fulfillments:[{
    key:{customer_id:'customer-1',transaction_id:'transaction-1'},
    source_period:{starts_at:'2026-01-02T03:00:00Z',expires_at:'2027-01-02T03:00:00Z'},
    stages:{source_recorded:true,application_applied:false,access_verified:null},
    telemetry_gap:true,
  }]});
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.match(html, /customer identity could not be confirmed/);
  assert.match(html, /What to do: Check the subscription source/);
  assert.doesNotMatch(html, /Adapty recorded: unknown|Access verified: Unknown/);
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
  assert.match(html, /data-action="bootstrap" >Run</);
  assert.doesNotMatch(html, /data-action="continuous"/);
  assert.doesNotMatch(html, /data-action="once"/);
});

test('renders empty and manual feeds honestly', () => {
  assert.match(renderMonitor(feed([])), /No incidents yet/);
  const header = renderMonitor(feed([])).split('</header>')[0];
  assert.doesNotMatch(header, /Live Adapty · Seeded data|Local demo|last check|Source (ready|unavailable)/);
  assert.match(renderMonitor(null, {pollError:'<script>error</script>'}), /&lt;script&gt;error&lt;\/script&gt;/);
  const html = renderMonitor(feed([], false));
  assert.match(html, /Manual mode/);
  assert.doesNotMatch(html, /Run demo/);
  assert.doesNotMatch(html, /advanced tools/i);
  assert.match(renderMonitor(feed([], true, false)), /data-action="continuous" disabled/);
  const integration = renderMonitor(feed([]));
  assert.match(integration, /100 active · 100 total accounts/);
  assert.match(integration, /Source readiness \(last check\)/);
  assert.match(integration, /Jan 2, 2026 at 3:00 AM UTC|Jan 2, 2026, 3:00 AM UTC/);
  assert.match(integration, /Only the configured test accounts are monitored/);
});

test('renders incident states and escapes untrusted feed text', () => {
  for (const status of ['repairing','repaired','unresolved']) assert.match(renderMonitor(feed([item({status})])), new RegExp(status === 'unresolved' ? 'Needs attention' : status === 'repaired' ? 'Repaired' : 'Repairing'));
  const html = renderMonitor(feed([item()]));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /UTC/);
  assert.match(html, /3\.4 s/);
  assert.match(html, /data-incident="incident-1"/);
  assert.match(html, /No real charge verified/);
  const aggregated = renderMonitor(feed([item({actions:Array.from({length:48},()=>({owner:'Lumen',status:'verified'}))})]));
  assert.match(aggregated, /Lumen · verified · 48 steps/);
  assert.doesNotMatch(aggregated, /Lumen: verified · Lumen: verified/);
  const partial = renderMonitor(feed([item({status:'unresolved',affected_accounts:24,repaired_accounts:23,next_step:'Check account 24'})]));
  assert.match(partial, /24/);
  assert.match(partial, /23 access checks passed/);
  assert.match(partial, /Check account 24/);
  assert.match(renderMonitor(feed([item({status:'repaired',affected_accounts:24,repaired_accounts:24})])), /24 repaired/);
  const activity = renderMonitor({...feed([item({status:'unresolved',affected_accounts:24,repaired_accounts:23})]),summary:{incidents:900,fixed:800,needs_attention:100},pagination:{total:100}}, {fulfillments:[{key:'user-1',source_period:'2026-01',stages:{source_recorded:true,application_applied:{status:'applied'},access_verified:{status:'unknown'}},telemetry_gap:'<script>x</script>',next_step:'Check gate'}],traces:{'incident-1':{steps:[{name:'Access check',status:'unknown',owner:'App',result:'<script>x</script>',at:'2026-01-02T03:04:05Z'}],next_step:'Retry'}}});
  assert.match(activity, /900/);
  assert.match(activity, /100 total/);
  assert.match(activity, /23 access checks passed/);
  assert.match(activity, /Current access/);
  assert.match(activity, /Check source or identity/);
  assert.match(activity, /What to do: Check gate/);
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
  assert.doesNotMatch(pending, /Run once/);
  assert.match(pending, /Request pending/);
  const errors = renderMonitor(feed([]), {pollError:'Feed unavailable',actionError:'Simulation rejected'});
  assert.match(errors, /Feed unavailable/);
  assert.match(errors, /Simulation rejected/);
});

test('a running simulation can be stopped when the source becomes unavailable', () => {
  const data = {...feed([], true, false), simulation:{status:'running',completed:1,total:3}};
  const html = renderMonitor(data);
  assert.match(html, /data-action="stop" >Stop</);
  assert.doesNotMatch(html, /data-action="stop" disabled/);
  assert.match(renderMonitor(data, {pending:true}), /data-action="stop" disabled/);
  const continuous = renderMonitor({...data, simulation:{status:'running',continuous:true,completed:3,total:0}});
  assert.match(continuous, /3 scenarios completed/);
  assert.doesNotMatch(continuous, /3 of 0/);
  assert.doesNotMatch(renderMonitor({...data,simulation:{status:'stopped',waiting_reason:'no_candidates'}}), /no_candidates/);
  assert.match(renderMonitor({...data,simulation:{status:'stopped',waiting_reason:'engine_storage_limit',error:'engine_storage_limit'}}), /engine storage limit/);
});

test('unresolved incidents are marked in their own box and stay out of the live feed', () => {
  const html = renderMonitor(feed([item({id:'fixed-1',status:'repaired'}), item({id:'stuck-1',status:'unresolved',repaired_accounts:0,next_step:'Check the gate'})]));
  const attention = html.slice(html.indexOf('class="feed attention"'), html.indexOf('class="feed live-feed"'));
  const live = html.slice(html.indexOf('class="feed live-feed"'));
  assert.match(attention, /Needs attention/);
  assert.match(attention, /data-incident="stuck-1"/);
  assert.doesNotMatch(attention, /data-incident="fixed-1"/);
  assert.match(live, /data-incident="fixed-1"/);
  assert.doesNotMatch(live, /data-incident="stuck-1"/);
  assert.doesNotMatch(renderMonitor(feed([item({status:'repaired'})])), /class="feed attention"/);
});

test('history navigation keeps summary totals separate from the visible page', () => {
  const data = {...feed([item()]), summary:{incidents:260,fixed:200,needs_attention:12}, pagination:{cursor:'0',limit:50,next_cursor:'50',total:260}};
  const html = renderMonitor(data, {status:'all',page:0});
  assert.match(html, /value="all" selected>All activity/);
  assert.match(html, /data-action="needs-attention">View needs attention/);
  assert.match(html, /Page 1 · 260 matching incidents/);
  assert.match(html, /data-action="page" data-page="1">Next/);
  assert.match(html, /Adapty seeded data · no real charges verified/);
  assert.match(renderMonitor({...data,mode:'FULL_MOCK'}), /Synthetic demo · no real charges/);
  assert.match(renderMonitor({...data,mode:'LOCAL_ADAPTY_FIXTURE'}), /Synthetic local fixture data · no real charges/);
});

test('automatic mock mode labels synthetic traffic and is disabled while repairing', () => {
  const html = renderMonitor({...feed([]), mode:'FULL_MOCK', telemetry:{queued:0}}, {demoTraffic:true});
  assert.match(html, /Synthetic demo traffic · On/);
  assert.match(html, /data-action="demo-traffic" aria-pressed="true">Stop demo traffic/);
  assert.match(html, /data-action="once" >Run once<\/button>/);
  assert.match(html, /Synthetic source · Current observations/);
  assert.doesNotMatch(html, /advanced tools|recovery-console/i);
  assert.doesNotMatch(html, /data-action="continuous"/);
  assert.match(renderMonitor({...feed([item({status:'repairing'})]), mode:'FULL_MOCK'}), /data-action="once" disabled>Run once/);
  assert.match(renderMonitor({...feed([]), mode:'FULL_MOCK'}, {demoTraffic:false}), /Synthetic demo traffic · Off/);
});

test('mock incidents show a readable step trace and where automatic repair stopped', () => {
  const timeline = [
    {step:'Scan all accounts', owner:'Reconcile', status:'ok', detail:'100 accounts checked'},
    {step:'Verify the premium gate', owner:'Lumen', status:'failed', detail:'0 of 24 done · failed: u00000 (<b>probe</b>)'}];
  const failure = {step:'Verify the premium gate', owner:'Lumen', reason:'Gate unreachable', accounts:[{account:'u00000', reason:'probe unavailable'}]};
  const html = renderMonitor({...feed([item({status:'unresolved', timeline, failure})]), mode:'FULL_MOCK'});
  assert.match(html, /Needs action: Test Premium access/);
  assert.match(html, /Affected accounts: u00000/);
  assert.match(html, /Recorded result: probe unavailable/);
  assert.match(html, /class="step-failed"/);
  assert.match(html, /Recorded recovery checks/);
  assert.doesNotMatch(html, /<b>probe<\/b>/);
  assert.doesNotMatch(html, /data-action="trace"/);
});

test('Run waits while SDK events are still being delivered', () => {
  const html = renderMonitor({...feed([item()]), mode:'FULL_MOCK', telemetry:{queued:6}});
  assert.match(html, /data-action="once" disabled>Run once/);
  assert.match(html, /Delivering 6 SDK events to the collector/);
});

test('failure trace shows recorded HTTP evidence and separates readback from verification', () => {
  const failure = {step:'Verify the premium gate',owner:'Lumen',reason:'Probe unavailable',
    accounts:[{account:'u00000',reason:'repeated reason'}], trace:{account:'u00000',affected_count:24,
      attempts:[{at:'2026-11-08T12:00:00Z',action_id:'action-<unsafe>',
        request:{method:'POST',path:'/internal/lumen/probe',http_status:503,duration_ms:4},
        readback:{allowed:true,reason:'allowed'}}]}};
  const html = renderMonitor(feed([item({status:'unresolved',failure})]));
  assert.match(html, /POST \/internal\/lumen\/probe/);
  assert.match(html, /HTTP 503 · 4 ms/);
  assert.match(html, /Separate access readback: <b>allow<\/b>/);
  assert.match(html, /action-&lt;unsafe&gt;/);
  assert.equal(html.match(/repeated reason/g).length, 1);
});

test('access overview groups verified accounts and puts incomplete evidence first', () => {
  const verified = {key:{customer_id:'healthy',transaction_id:'txn-healthy'},telemetry_gap:true,
    stages:{source_recorded:true,application_applied:true,access_verified:true}};
  const incomplete = {key:{customer_id:'review-<unsafe>'},status:'discrepancy',
    stages:{source_recorded:true,application_applied:false,access_verified:false},
    reason:'Projection differs',next_step:'Read the projection'};
  const expired = {key:{customer_id:'expired'},access_state:'expired',display_label:'Subscription expired',
    reason:'Subscription expired; access is correctly denied.',next_step:'No repair needed'};
  const html = renderMonitor(feed([]), {fulfillments:[verified,expired,incomplete]});
  assert.match(html, /1 access verified<\/strong>/);
  assert.match(html, /1 expected denials<\/strong>/);
  assert.match(html, /1 need investigation<\/strong>/);
  assert.match(html, /Access confirmed by direct checks \(1\)/);
  assert.match(html, /Premium access works for these accounts/);
  assert.ok(html.indexOf('review-&lt;unsafe&gt;') < html.indexOf('txn-healthy'));
  assert.match(html, /<details data-evidence="verified-access"><summary>Verified accounts \(1\)/);
  assert.match(html, /Expected denials \(1\)/);
  assert.match(html, /Subscription expired/);
  assert.doesNotMatch(html, /Needs evidence|Adapty recorded: unknown/);
  assert.doesNotMatch(html, /No action needed while/);
});

test('a check that passed on retry is identified as recovered while retaining the earlier result', () => {
  const html = renderMonitor(feed([item({timeline:[
    {step:'Verify the premium gate',owner:'Lumen',status:'failed',detail:'First request denied'},
    {step:'Verify the premium gate',owner:'Lumen',status:'ok',detail:'Retry allowed'}]})]));
  assert.match(html, /Passed on a later attempt/);
  assert.match(html, /First request denied/);
  assert.match(html, /Retry allowed/);
  assert.doesNotMatch(html, /class="step-failed"/);
});

test('app-rule blocks explain why access is denied and the operator choice', () => {
  const html = renderMonitor({...feed([]),mode:'FULL_MOCK'}, {fulfillments:[{
    user_id:'account-policy',key:{customer_id:'customer-policy'},access_state:'policy_restricted',
    reason:'An active subscription does not override the app rule.',
    next_step:'If intentional, no repair is needed. Otherwise enable Premium export and check access again.'}]});
  assert.match(html, /Blocked by app rule/);
  assert.match(html, /does not override the app rule/);
  assert.match(html, /What to do: If intentional/);
  assert.match(html, /Otherwise enable Premium export/);
});

test('subscription evidence labels state the next action', () => {
  const html = renderMonitor(feed([]), {fulfillments:[
    {key:'account-a',access_state:'inconclusive',display_label:'Source unavailable'},
    {key:'account-b',access_state:'inconclusive',display_label:'Source stale'}]});
  assert.match(html, /Check subscription data/);
  assert.match(html, /Refresh subscription data/);
  assert.doesNotMatch(html, /Source unavailable|Source stale/);
});
