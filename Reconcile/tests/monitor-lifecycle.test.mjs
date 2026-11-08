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

test('a slow trace read does not stop future monitor polls', async t => {
  const timers = new Map();
  let timerId = 0, resolveTrace, monitorReads = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++timerId; timers.set(id, {callback, delay}); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const runPoll = async () => {
    const [id, timer] = [...timers].find(([, value]) => value.delay === 2000) || [];
    assert.ok(timer, 'a future monitor poll must be scheduled');
    timers.delete(id); await timer.callback();
  };
  const browser = await browserHarness(t, async url => {
    if (url.endsWith('/trace')) return new Promise(resolve => { resolveTrace = resolve; });
    if (url.startsWith('/api/recovery/monitor')) monitorReads++;
    return response(feed('idle'));
  });
  const trace = browser.click('trace', {id:'incident-1'});
  await runPoll();
  assert.equal(monitorReads, 1);
  resolveTrace(response({accounts:[]})); await trace;
  await runPoll();
  assert.equal(monitorReads, 2);
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

test('monitor loads bounded all activity and follows the API cursor', async t => {
  const urls = [];
  const browser = await browserHarness(t, async(url, options)=>{
    urls.push(url);
    return response({...feed('idle'), pagination:{cursor:urls.length===1?'0':'50',limit:50,next_cursor:urls.length===1?'50':null,total:201}});
  });
  const initial = new URL(urls.find(url=>url.startsWith('/api/recovery/monitor')), 'http://local');
  assert.equal(initial.searchParams.get('cursor'),'0');
  assert.equal(initial.searchParams.get('limit'),'50');
  assert.equal(initial.searchParams.get('status'),null);
  await browser.click('page',{page:'1'});
  const next = new URL(urls.filter(url=>url.startsWith('/api/recovery/monitor'))[1], 'http://local');
  assert.equal(next.searchParams.get('cursor'),'50');
  assert.equal(next.searchParams.get('limit'),'50');
});

test('filter changes reset pagination and request needs attention directly', async t => {
  const urls = [];
  const browser = await browserHarness(t, async(url, options)=>{ urls.push(url); return response({...feed('idle'),pagination:{cursor:'0',limit:50,next_cursor:null,total:0}}); });
  const form = {dataset:{form:'filters'},elements:{status:{value:'needs_attention'}}};
  await browser.listeners.root.submit({target:{closest:()=>form},preventDefault(){}});
  const filtered = new URL(urls.filter(url=>url.startsWith('/api/recovery/monitor')).at(-1), 'http://local');
  assert.equal(filtered.searchParams.get('cursor'),'0');
  assert.equal(filtered.searchParams.get('limit'),'50');
  assert.equal(filtered.searchParams.get('status'),'needs_attention');
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

test('FULL_MOCK traffic waits six seconds, uses once, and Stop cancels the next run', async t => {
  const timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++timerId; timers.set(id, {callback, delay}); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const calls = [];
  const browser = await browserHarness(t, async(url, options={})=>{
    calls.push({url,options});
    if (url.startsWith('/api/recovery/monitor')) return response({...feed('idle'),mode:'FULL_MOCK',automation:{enabled:true}});
    if (url.startsWith('/api/recovery/fulfillments')) return response({items:[]});
    return response({status:'accepted'});
  });
  assert.equal(calls.filter(call=>call.options.method === 'POST').length, 0);
  assert.ok([...timers.values()].some(timer=>timer.delay === 6000));
  await browser.click('demo-traffic');
  assert.equal(calls.filter(call=>call.options.method === 'POST').length, 0);
  assert.doesNotMatch(browser.root.innerHTML, /Synthetic demo traffic · On/);

  await browser.click('demo-traffic');
  const [id, timer] = [...timers].find(([,value])=>value.delay === 6000) || [];
  assert.ok(timer, 'turning traffic on schedules the first scenario after six seconds');
  timers.delete(id);
  await timer.callback();
  const posts = calls.filter(call=>call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].options.body).action, 'once');
  await browser.click('demo-traffic');
  assert.equal(calls.filter(call=>call.options.method === 'POST').length, 1);
});

test('FULL_MOCK traffic does not schedule while telemetry is queued or repair is active', async t => {
  const timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++timerId; timers.set(id, {callback, delay}); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const busy = {...feed('idle'),mode:'FULL_MOCK',automation:{enabled:true},telemetry:{queued:1},
    incidents:[{id:'incident-1',status:'repairing'}]};
  const calls = [];
  await browserHarness(t, async(url, options={})=>{
    calls.push({url,options});
    if (url.startsWith('/api/recovery/monitor')) return response(busy);
    if (url.startsWith('/api/recovery/fulfillments')) return response({items:[]});
    return response({status:'accepted'});
  });
  assert.ok(![...timers.values()].some(timer=>timer.delay === 6000));
  assert.equal(calls.filter(call=>call.options.method === 'POST').length, 0);
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
