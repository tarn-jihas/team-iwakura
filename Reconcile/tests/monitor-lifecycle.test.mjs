import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(resolve => setImmediate(resolve));
const feed = status => ({mode:'LIVE_ADAPTY_SEEDED',app:{title:'Lumen'},
  automation:{enabled:true},connection:{ready:true},summary:{incidents:0,fixed:0,needs_attention:0},
  telemetry:{},simulation:{status,completed:0,total:3},incidents:[]});
const response = value => ({ok:true,json:async()=>value});

test('polling does not replace the DOM while an export date is being edited', async t => {
  const browser = await browserHarness(t, async()=>response(feed('idle')));
  browser.root.innerHTML = 'date input being edited';
  document.activeElement = {matches:()=>true};
  browser.listeners.document.visibilitychange();
  await tick(); await tick();
  assert.equal(browser.root.innerHTML, 'date input being edited');
  document.activeElement = null;
  browser.listeners.document.visibilitychange();
  await tick(); await tick();
  assert.match(browser.root.innerHTML, /Access recovery/);
});

test('polling restores the filter submit button focus', async t => {
  const browser = await browserHarness(t, async()=>response(feed('idle')));
  let restored = 0;
  const button = {tagName:'BUTTON',closest:selector=>selector==='[data-form="filters"]'?{}:null,
    focus:()=>{restored++;}};
  browser.root.querySelector = selector => selector==='[data-form="filters"] button'?button:null;
  document.activeElement = button;
  browser.listeners.document.visibilitychange();
  await tick(); await tick();
  assert.ok(restored>0);
});

async function browserHarness(t, fetcher, inputs = []) {
  const listeners = {root:{},document:{},window:{}};
  const root = {innerHTML:'',querySelectorAll:selector=>selector === 'input[name]' ? inputs : [],querySelector:()=>null,
    addEventListener:(name, callback)=>{listeners.root[name]=callback;}};
  const saved = new Map(['document','window','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  globalThis.document = {hidden:false,activeElement:null,querySelector:()=>root,
    createElement:()=>({setAttribute(){},click(){}}),body:{append(){}},
    addEventListener:(name, callback)=>{listeners.document[name]=callback;}};
  globalThis.window = {addEventListener:(name, callback)=>{listeners.window[name]=callback;}};
  globalThis.fetch = fetcher;
  t.after(async()=>{
    listeners.window.pagehide?.();
    await tick();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  });
  await import(`../dist/monitor-app.js?case=${encodeURIComponent(t.name)}`);
  await tick();
  return {root,listeners,click:(action, extra = {})=>listeners.root.click({preventDefault(){},target:{closest:()=>({dataset:{action,...extra}})}})};
}

test('stop interrupts an in-flight read instead of swallowing the user action', async t => {
  const calls = [];
  let reads = 0;
  const browser = await browserHarness(t, async(url, options)=>{
    calls.push({url,options});
    if (options.method === 'POST') return response({accepted:true});
    reads++;
    if (reads === 2) return new Promise((_, reject)=>{
      options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    });
    return response(feed(reads === 1 ? 'running' : 'stopped'));
  });
  browser.listeners.document.visibilitychange();
  assert.equal(reads,2);
  await browser.click('stop');
  await tick();
  const post = calls.filter(call=>call.options.method === 'POST');
  assert.equal(post.length,1);
  assert.deepEqual(JSON.parse(post[0].options.body),{action:'stop'});
  assert.equal(calls[1].options.signal.aborted,true);
  assert.doesNotMatch(browser.root.innerHTML,/Request pending/);
});

test('server export uses the exact UTC range and format', async t => {
  const urls = [];
  const inputs = [{name:'from',value:'2026-01-02T03:04:05'},{name:'to',value:'2026-01-03T03:04:05'}];
  const browser = await browserHarness(t, async(url, options)=>{
    urls.push(url);
    return url.startsWith('/api/recovery/export') ? {ok:true,text:async()=>'{"items":[]}',json:async()=>({})} : response(feed('idle'));
  }, inputs);
  browser.listeners.root.input({target:{closest:()=>({dataset:{form:'export'}})}});
  await browser.click('json');
  const exported = new URL(urls.find(url=>url.startsWith('/api/recovery/export')), 'http://local');
  assert.equal(exported.searchParams.get('from'),'2026-01-02T03:04:05.000Z');
  assert.equal(exported.searchParams.get('to'),'2026-01-03T03:04:05.000Z');
  assert.equal(exported.searchParams.get('format'),'json');
  assert.ok(urls.some(url=>url.startsWith('/api/recovery/export')));
});

test('invalid UTC range shows an error without requesting an export', async t => {
  const urls = [];
  const browser = await browserHarness(t, async(url, options)=>{ urls.push(url); return response(feed('idle')); }, [
    {name:'from',value:'2026-01-03T03:04:05'},{name:'to',value:'2026-01-02T03:04:05'}
  ]);
  browser.listeners.root.input({target:{closest:()=>({dataset:{form:'export'}})}});
  await browser.click('csv');
  assert.ok(!urls.some(url=>url.startsWith('/api/recovery/export')));
  assert.match(browser.root.innerHTML,/From is earlier than To/);
});

test('monitor requests every status so the attention box and live feed are both complete', async t => {
  const urls = [];
  await browserHarness(t, async(url, options)=>{ urls.push(url); return response(feed('idle')); });
  const monitor = new URL(urls.find(url=>url.startsWith('/api/recovery/monitor')), 'http://local');
  assert.equal(monitor.searchParams.get('cursor'),'0');
  assert.equal(monitor.searchParams.get('limit'),'200');
  assert.equal(monitor.searchParams.get('status'),null);
});

test('manual mode skips live fulfillment polling', async t => {
  const urls = [];
  await browserHarness(t, async(url, options)=>{
    urls.push(url);
    return response({...feed('idle'),mode:'FULL_MOCK',automation:{enabled:false}});
  });
  assert.ok(!urls.some(url=>url.startsWith('/api/recovery/fulfillments')));
});

test('automatic mock mode Run starts one run through the simulation endpoint', async t => {
  const calls = [];
  const browser = await browserHarness(t, async(url, options)=>{
    calls.push({url,options});
    if (url.startsWith('/api/recovery/monitor')) return response({...feed('idle'),mode:'FULL_MOCK',automation:{enabled:true}});
    return response(options?.method === 'POST' ? {status:'accepted'} : {items:[]});
  });
  await browser.click('once');
  const run = calls.find(call=>call.url === '/api/recovery/simulation');
  assert.ok(run);
  assert.equal(JSON.parse(run.options.body).action,'once');
  assert.ok(!calls.some(call=>call.url === '/api/recovery/lumen/export'));
});

test('browser back-forward restoration resumes monitoring and actions', async t => {
  const calls = [];
  const browser = await browserHarness(t, async(url, options)=>{
    calls.push({url,options});
    return response(options.method === 'POST' ? {accepted:true} : feed('idle'));
  });
  assert.equal(calls.filter(call=>call.url.startsWith('/api/recovery/monitor')).length,1);
  browser.listeners.window.pagehide();
  browser.listeners.window.pageshow({persisted:true});
  await tick();
  assert.equal(calls.filter(call=>call.url.startsWith('/api/recovery/monitor')).length,2);
  await browser.click('once');
  const post = calls.find(call=>call.options.method === 'POST');
  assert.equal(JSON.parse(post.options.body).action,'once');
  assert.match(JSON.parse(post.options.body).operation_key,/^[a-f0-9-]{36}$/);
});
