const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '..', 'network-observer.js'), 'utf8');
const channel = 'scp-network-observer-v1';
const endpoint = 'https://atv-ps.amazon.co.jp/cdp/catalog/GetPlaybackResources?token=SECRET';
const payload = { transitionTimecodes: { result: { events: [{ eventType: 'END_CREDITS', startTime: 1337, endTime: 1432, token: 'SECRET', title: 'PRIVATE' }] } }, resources: { nextUpV2: { card: { autoPlayConfig: { autoplayEnabled: true, countdownSeconds: 5 }, url: 'https://secret.invalid' } } } };
function fixture(data = payload) {
  const reports = [], listeners = []; let response, returned;
  class XHR extends EventTarget {
    open(method, url) { this.method = method; this.url = url; return 'opened'; }
    send(body) { this.body = body; this.dispatchEvent(new Event('loadend')); return 'sent'; }
  }
  const c = { URL, TextDecoder, Response, Headers, setTimeout, clearTimeout, location: { origin: 'https://www.amazon.co.jp', href: 'https://www.amazon.co.jp/gp/video/detail/example' }, XMLHttpRequest: XHR,
    fetch(...args) { response = typeof data === 'function' ? data() : new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); returned = Promise.resolve(response); return returned; },
    addEventListener(type, fn) { listeners.push(fn); },
    postMessage(message) { if (message.type === 'report') reports.push(message.payload); for (const fn of listeners) fn({ source: vm.runInContext('window', context), data: message }); },
  };
  c.window = c; const context = vm.createContext(c); vm.runInContext(script, context);
  return { c, reports, configure: (enabled, experiment = false, experimentMode = 'remove') => c.postMessage({ channel, type: 'configure', enabled, experiment, experimentMode }),
    returned: () => returned, response: () => response };
}
const settle = async () => { for (let i=0;i<5;i++) await new Promise(r => setImmediate(r)); };
test('fetch preserves original promise, response and payload while reporting only selected fields', async () => {
  const f=fixture(); f.configure(true); const promise=f.c.fetch(endpoint);
  assert.equal(promise, f.returned()); const response=await promise; assert.equal(response,f.response());
  assert.deepEqual(await response.json(),payload); await settle();
  const record=f.reports.find(r=>r.transport==='fetch'); assert.ok(record);
  assert.ok(record.fields.some(f=>f.value===1337)); assert.ok(record.fields.some(f=>f.value===true));
  assert.ok(!JSON.stringify(record).includes('SECRET')); assert.ok(!JSON.stringify(record).includes('PRIVATE')); assert.ok(!JSON.stringify(record).includes('https://'));
});
test('disabled observer does not wrap fetch until opted in', async () => {
  const f=fixture(); const original=f.c.fetch; f.configure(false); assert.equal(f.c.fetch,original);
  await f.c.fetch(endpoint); await settle(); assert.equal(f.reports.filter(r=>r.transport).length,0);
});
test('turning observation off suppresses in-flight results', async () => {
  const f=fixture(); f.configure(true); const p=f.c.fetch(endpoint); f.configure(false); await p; await settle();
  assert.equal(f.reports.filter(r=>r.transport).length,0);
});
test('unrelated domains and media URLs are not inspected', async () => {
  const f=fixture(); f.configure(true); await f.c.fetch('https://other.invalid/GetPlaybackResources'); await f.c.fetch('https://amazon.com/video.mp4'); await settle();
  assert.equal(f.reports.filter(r=>r.transport).length,0);
});
test('XHR retains request args and response text', () => {
  const f=fixture(); f.configure(true); const x=new f.c.XMLHttpRequest(); x.responseType=''; x.responseText=JSON.stringify(payload);
  assert.equal(x.open('POST',endpoint),'opened'); assert.equal(x.send('original'),'sent');
  assert.equal(x.body,'original'); assert.equal(x.responseText,JSON.stringify(payload));
  assert.ok(f.reports.find(r=>r.transport==='xhr').fields.length>0);
});
test('XHR JSON includes no arbitrary strings and leaves original object untouched', () => {
  const f=fixture(); f.configure(true); const x=new f.c.XMLHttpRequest(); x.responseType='json'; x.response=payload;
  x.open('GET',endpoint); x.send(); assert.equal(x.response,payload);
  assert.ok(!JSON.stringify(f.reports).includes('SECRET'));
});
test('response without recognized timing data is explicitly reported as empty', async () => {
  const f=fixture({ token:'SECRET' }); f.configure(true); await f.c.fetch(endpoint); await settle();
  assert.equal(f.reports.find(r=>r.transport==='fetch').fields.length,0);
});
test('oversized fetch response is not parsed and original remains readable', async () => {
  const f=fixture({ padding:'a'.repeat(2200000) }); f.configure(true); const r=await f.c.fetch(endpoint);
  assert.ok((await r.text()).length>2000000); await settle();
  assert.ok(f.reports.some(r=>r.status==='size-limit'));
});

function bridge(f, settings = { observeNextUp: true }) {
  let changed, handler;
  f.c.chrome = { storage: { sync: { get: (_d, cb) => cb(settings) },
    onChanged: { addListener: fn => { changed=fn; } } }, runtime: { onMessage: { addListener: fn => { handler=fn; } } } };
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','network-bridge.js'),'utf8'), vm.createContext(f.c));
  return { report: () => { let result; handler({type:'scp-network-diagnostics'}, {}, x=>{result=x;}); return result; },
    change: changes => changed(changes, 'sync'),
    off: () => changed({enabled:{newValue:false}},'sync') };
}
test('bridge handshake collects summaries and clears on disabling', async () => {
  const f=fixture(), b=bridge(f); assert.equal(b.report().ready,true);
  await f.c.fetch(endpoint); await settle(); assert.ok(b.report().records.length >= 1);
  b.off(); assert.equal(b.report().records.length,0); assert.equal(b.report().enabled,false);
});
test('bridge ignores invalid record types and private string values', () => {
  const f=fixture(), b=bridge(f);
  f.c.postMessage({channel,type:'report',payload:{transport:'fetch',endpoint:'playback-resources',status:'parsed',fields:[{path:'resources.url',value:'https://private.invalid'},{path:'resources.countdown',value:5}]}});
  assert.equal(b.report().records[0].fields.length,1);
  f.c.postMessage({channel,type:'report',payload:{transport:'unexpected',endpoint:'playback-resources',status:'parsed',fields:[]}});
  assert.equal(b.report().records.length,1);
});

const experimentalPayload = () => ({ ...payload, transitionTimecodes: { result: { events: [
  { eventType: 'NEXT_UP', startTimeMs: 1336000, nested: [{ startTimeMs: 1336000 }] },
  { eventType: 'END_CREDITS', startTimeMs: 1336000 },
  { eventType: 'INTRO', startTimeMs: 84000, endTimeMs: 178000 }, null
] } } });
test('experiment removes only NEXT_UP and preserves END_CREDITS, intro, ads and metadata', async () => {
  const data = experimentalPayload(); data.ads = { duration: 33 }; const f = fixture(data);
  f.configure(true, true); const r = await f.c.fetch(endpoint);
  assert.notEqual(r, f.response()); assert.equal(r.url, f.response().url); assert.equal(r.type, f.response().type);
  const clone = r.clone(); assert.equal(clone.type, r.type);
  const expected = structuredClone(data); expected.transitionTimecodes.result.events.shift();
  assert.deepEqual(await r.json(), expected); assert.deepEqual(await clone.json(), expected);
  assert.deepEqual(await f.response().json(), data);
  assert.ok(f.reports.some(r => r.status === 'experiment-applied' && r.fields[0].value === 1));
});
test('experiment OFF retains NEXT_UP and original promise', async () => {
  const data = experimentalPayload(), f = fixture(data); f.configure(true);
  const p = f.c.fetch(endpoint); assert.equal(p, f.returned()); assert.deepEqual(await (await p).json(), data);
});
test('experiment leaves unknown structure unchanged', async () => {
  const f = fixture({ events: [{ eventType: 'NEXT_UP' }] }); f.configure(true, true);
  const r = await f.c.fetch(endpoint); assert.equal(r, f.response());
  assert.ok(f.reports.some(r => r.status === 'experiment-no-match'));
});
test('experiment only changes playback-resources, not other player responses', async () => {
  const f = fixture(experimentalPayload()); f.configure(true, true);
  const p = f.c.fetch('https://www.amazon.co.jp/getsections'); assert.equal(p, f.returned());
  assert.equal(await p, f.response());
});
test('experiment cancellation preserves in-flight original response', async () => {
  const f = fixture(experimentalPayload()); f.configure(true, true);
  const p = f.c.fetch(endpoint); f.configure(false, false);
  assert.equal(await p, f.response()); assert.ok(!f.reports.some(r => r.status === 'experiment-applied'));
});
test('experiment size limit falls back to unchanged response', async () => {
  const data = experimentalPayload(); data.padding = 'x'.repeat(2200000);
  const f = fixture(data); f.configure(true, true); const r = await f.c.fetch(endpoint);
  assert.equal(r, f.response()); assert.ok(f.reports.some(r => r.status === 'experiment-bypassed'));
  assert.deepEqual(await r.json(), data);
});
test('XHR experiment explicitly reports unsupported and leaves response unchanged', () => {
  const f = fixture(); f.configure(true, true); const x = new f.c.XMLHttpRequest();
  x.responseType = 'json'; x.response = experimentalPayload(); const original = x.response;
  x.open('GET', endpoint); x.send(); assert.equal(x.response, original);
  assert.ok(f.reports.some(r => r.status === 'experiment-xhr-unsupported'));
});
test('bridge enables experiment independently and master OFF prevents modification', async () => {
  const f = fixture(experimentalPayload()), b = bridge(f, { suppressNextUpExperiment: true, enabled: true });
  assert.equal(b.report().suppressNextUpExperiment, true);
  await f.c.fetch(endpoint); assert.ok(b.report().records.some(r => r.status === 'experiment-applied'));
  b.change({ enabled: { newValue: false } }); assert.equal(b.report().suppressNextUpExperiment, false);
  const p = f.c.fetch(endpoint); assert.equal(p, f.returned()); assert.equal(await p, f.response());
});

test('invalid JSON and HTTP errors leave the original response readable', async () => {
  for (const make of [() => new Response('{broken'), () => new Response('server error', { status: 500 })]) {
    const f = fixture(make); f.configure(true, true); const r = await f.c.fetch(endpoint);
    assert.equal(r, f.response()); assert.ok((await r.text()).length > 0);
    assert.ok(!f.reports.some(r => r.status === 'experiment-applied'));
  }
});
test('slow body times out without replacing the response', async () => {
  let controller;
  const f = fixture(() => new Response(new ReadableStream({ start(c) { controller = c; } })));
  f.configure(true, true); const r = await f.c.fetch(endpoint);
  assert.equal(r, f.response()); assert.ok(f.reports.some(r => r.status === 'experiment-bypassed'));
  controller.enqueue(new TextEncoder().encode('{}')); controller.close();
  assert.deepEqual(await r.json(), {}); await settle();
});

test('delay30 retains NEXT_UP and shifts parent and nested starts, preserving all other events', async () => {
  const data = experimentalPayload(); const f = fixture(data); f.configure(true, true, 'delay30');
  const r = await f.c.fetch(endpoint), result = await r.json();
  const expected = structuredClone(data);
  expected.transitionTimecodes.result.events[0].startTimeMs = 1366000;
  expected.transitionTimecodes.result.events[0].nested[0].startTimeMs = 1366000;
  assert.deepEqual(result, expected);
  const applied = f.reports.find(r => r.status === 'experiment-applied');
  assert.ok(applied.fields.some(f => f.path === 'experiment.delayedNextUpEvents' && f.value === 1));
  assert.ok(applied.fields.some(f => f.path === 'experiment.fieldsChanged' && f.value === 2));
  assert.ok(applied.fields.some(f => f.path.endsWith('updatedStartTimeMs') && f.value === 1366000));
});
test('delay30 refuses unknown ranges, mismatched nested times or invalid units without partial mutation', async () => {
  for (const modify of [e => {e.endTimeMs = 1432000;}, e => {e.nested[0].startTimeMs = 100;},
    e => {e.startTimeMs = 'unknown';}, e => {e.duration = 5;}]) {
    const data = experimentalPayload(); modify(data.transitionTimecodes.result.events[0]);
    const f = fixture(data); f.configure(true, true, 'delay30'); const r = await f.c.fetch(endpoint);
    assert.equal(r, f.response()); assert.deepEqual(await r.json(), data);
    assert.ok(f.reports.some(r => r.status === 'experiment-bypassed'));
  }
});
test('delay30 preserves numeric string format and multiple NEXT_UP events', async () => {
  const data = experimentalPayload(); const event = data.transitionTimecodes.result.events[0];
  event.startTimeMs = '1336000'; event.nested[0].startTimeMs = '1336000';
  data.transitionTimecodes.result.events.push({ eventType: 'NEXT_UP', startTimeMs: 1600000 });
  const f = fixture(data); f.configure(true, true, 'delay30'); const result = await (await f.c.fetch(endpoint)).json();
  assert.equal(result.transitionTimecodes.result.events[0].startTimeMs, '1366000');
  assert.equal(result.transitionTimecodes.result.events.at(-1).startTimeMs, 1630000);
});
test('changing experiment mode cancels old in-flight modification', async () => {
  const f = fixture(experimentalPayload()); f.configure(true, true, 'delay30');
  const pending = f.c.fetch(endpoint); f.configure(true, true, 'remove');
  assert.equal(await pending, f.response());
});

test('nearEnd2 moves known marker to 1434 seconds and preserves the event', async () => {
  const f = fixture(experimentalPayload()); f.configure(true, true, 'nearEnd2');
  const result = await (await f.c.fetch(endpoint)).json();
  assert.equal(result.transitionTimecodes.result.events[0].startTimeMs, 1434000);
  assert.equal(result.transitionTimecodes.result.events[0].nested[0].startTimeMs, 1434000);
  assert.equal(result.transitionTimecodes.result.events[1].startTimeMs, 1336000);
});
test('nearEnd2 declines an uncalibrated marker', async () => {
  const data = experimentalPayload(); data.transitionTimecodes.result.events[0].startTimeMs = 1200000;
  const f = fixture(data); f.configure(true, true, 'nearEnd2'); const r = await f.c.fetch(endpoint);
  assert.equal(r, f.response()); assert.ok(f.reports.some(r => r.status === 'experiment-bypassed'));
});


test('even direct compare configuration cannot rewrite NEXT_UP', async () => {
  const f = fixture(experimentalPayload()); f.configure(true,true,'compare');
  const p = f.c.fetch(endpoint); assert.equal(p,f.returned()); assert.equal(await p,f.response());
});

test('general delay shifts each title marker by 24h without deleting events or changing credits', async () => {
  for (const start of [1336000, 1335000, 1304000, 2650000]) {
    const data = experimentalPayload(); data.transitionTimecodes.result.events[0].startTimeMs = start;
    data.transitionTimecodes.result.events[0].nested[0].startTimeMs = start;
    const f = fixture(data); const b = bridge(f, {suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback'});
    const result = await (await f.c.fetch(endpoint)).json();
    assert.equal(b.report().experimentMode,'delayFallback');
    assert.equal(result.transitionTimecodes.result.events[0].startTimeMs,start+86400000);
    assert.equal(result.transitionTimecodes.result.events[0].nested[0].startTimeMs,start+86400000);
    assert.deepEqual(result.transitionTimecodes.result.events.slice(1),data.transitionTimecodes.result.events.slice(1));
  }
});
test('general delay refuses unknown timing shape and respects master OFF', async () => {
  const data = experimentalPayload(); data.transitionTimecodes.result.events[0].endTimeMs = 1432000;
  const f = fixture(data); f.configure(true,true,'delayFallback');
  assert.equal(await f.c.fetch(endpoint),f.response());
  const g = fixture(experimentalPayload()); bridge(g,{suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback',enabled:false});
  const p = g.c.fetch(endpoint); assert.equal(p,g.returned()); assert.equal(await p,g.response());
});

test('fresh install and obsolete preferences both select the release policy; OFF stays OFF', async () => {
  for (const settings of [{}, {observeNextUp:false,suppressNextUpExperiment:false,nextUpExperimentMode:'remove',earlyNext:true}]) {
    const f=fixture(experimentalPayload()), b=bridge(f,settings);
    assert.equal(b.report().experimentMode,'delayFallback');
    const data=await (await f.c.fetch(endpoint)).json();
    assert.equal(data.transitionTimecodes.result.events[0].startTimeMs,1336000+86400000);
    b.change({nextUpExperimentMode:{newValue:'remove'},suppressNextUpExperiment:{newValue:false}});
    assert.equal(b.report().experimentMode,'delayFallback'); assert.equal(b.report().enabled,true);
    b.off(); const original=f.c.fetch(endpoint); assert.equal(original,f.returned());
  }
  const f=fixture(experimentalPayload()), b=bridge(f,{enabled:false,observeNextUp:true,suppressNextUpExperiment:true});
  assert.equal(b.report().enabled,false);
  const result=f.c.fetch(endpoint); assert.equal(result,f.returned());
});
