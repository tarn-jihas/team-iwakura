import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(resolve => setImmediate(resolve));
const feed = status => ({mode:'LIVE_ADAPTY_SEEDED',app:{title:'Lumen'},
  automation:{enabled:true},connection:{ready:true},summary:{incidents:0,fixed:0,needs_attention:0},
  telemetry:{},simulation:{status,completed:0,total:3},incidents:[]});
const response = value => ({ok:true,json:async()=>value});

async function browserHarness(t, fetcher) {
  const listeners = {root:{},document:{},window:{}};
  const root = {innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name, callback)=>{listeners.root[name]=callback;}};
  const saved = new Map(['document','window','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  globalThis.document = {hidden:false,activeElement:null,querySelector:()=>root,
    createElement:()=>({setAttribute(){}}),body:{append(){}},
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
  return {root,listeners,click:action=>listeners.root.click({target:{closest:()=>({dataset:{action}})}})};
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

test('browser back-forward restoration resumes monitoring and actions', async t => {
  const calls = [];
  const browser = await browserHarness(t, async(url, options)=>{
    calls.push({url,options});
    return response(options.method === 'POST' ? {accepted:true} : feed('idle'));
  });
  assert.equal(calls.length,1);
  browser.listeners.window.pagehide();
  browser.listeners.window.pageshow({persisted:true});
  await tick();
  assert.equal(calls.length,2);
  await browser.click('once');
  const post = calls.find(call=>call.options.method === 'POST');
  assert.equal(JSON.parse(post.options.body).action,'once');
  assert.match(JSON.parse(post.options.body).operation_key,/^[a-f0-9-]{36}$/);
});
