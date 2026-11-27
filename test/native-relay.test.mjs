import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {BrowserModel} from '../src/native-browser-model.mjs';
import {createRelay} from '../src/native-relay.mjs';
import {browserDeadline, TRANSPORT_LIMITS} from '../extension/transport-limits.js';

test('native target model exposes only its selected tab and rejects global/foreign commands', async () => {
  const calls = [], events = [];
  const model = new BrowserModel(async (method, params) => {
    calls.push({method, params});
    return params.method === 'Target.getTargetInfo' ? {targetInfo: {targetId: 'owned', type: 'page'}} : {};
  }, event => events.push(event));
  model.setTab({id: 42, url: 'http://fixture.test'});
  await model.command({method: 'Target.setAutoAttach', params: {autoAttach: true}});
  assert.equal(events[0].params.targetInfo.targetId, 'owned');
  assert.equal(calls[0].params.tabId, 42);
  assert.deepEqual(await model.command({method: 'Target.getTargets'}), {targetInfos: [{targetId: 'owned', type: 'page'}]});
  const count = calls.length;
  for (const method of ['Browser.close', 'Storage.clearCookies', 'Target.createTarget'])
    await assert.rejects(model.command({method}), /Unsupported browser-level/);
  await assert.rejects(model.command({method: 'Target.closeTarget', params: {targetId: 'foreign'}}), /not owned/);
  await assert.rejects(model.command({method: 'Runtime.evaluate', sessionId: 'foreign'}), /not owned/);
  await assert.rejects(model.command({method: 'Target.getTargetInfo', params: {targetId: 'foreign'}}), /not owned/);
  assert.equal(calls.length, count);
  model.onEvent({source: {tabId: 43}, method: 'Runtime.consoleAPICalled', params: {}});
  assert.equal(events.length, 1);
  model.onEvent({source: {tabId: 42}, method: 'Target.attachedToTarget', params: {sessionId: 'child',targetInfo:{targetId:'child-target',type:'worker'}}});
  await model.command({method: 'Runtime.enable', sessionId: events.at(-1).params.sessionId});
  assert.equal(calls.at(-1).params.sessionId, 'child');
  const browser = await model.command({method: 'Target.attachToBrowserTarget'});
  await assert.rejects(model.command({method: 'Target.attachToTarget', sessionId: browser.sessionId,
    params: {targetId: 'foreign'}}), /not owned/);
  const alias = await model.command({method: 'Target.attachToTarget', sessionId: browser.sessionId,
    params: {targetId: 'owned'}});
  assert.equal((await model.command({method: 'Target.getTargetInfo', sessionId: alias.sessionId})).targetInfo.targetId, 'owned');
  await assert.rejects(model.command({method: 'Target.getTargetInfo', sessionId: alias.sessionId, params: {targetId: 'foreign'}}), /not owned/);
  await model.command({method: 'Target.detachFromTarget', sessionId: browser.sessionId,
    params: {sessionId: alias.sessionId}});
  await assert.rejects(model.command({method: 'Runtime.enable', sessionId: alias.sessionId}), /not owned/);
});

async function refused(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => { ws.terminate(); reject(new Error('Unauthorized connection was accepted.')); });
    ws.once('error', error => { assert.match(error.message, /403/); resolve(); });
  });
}

test('relay authenticates separate roles, rejects webpage origins and revokes on disconnect', async t => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const relay = await createRelay(id);
  t.after(() => relay.stop());
  await refused(relay.cdpEndpoint);
  await refused(relay.extensionEndpoint.replace(/.$/, 'z'), {origin: `chrome-extension://${id}`});
  await refused(relay.extensionEndpoint, {origin: 'https://attacker.example'});
  await refused(relay.extensionEndpoint);
  const ext = new WebSocket(relay.extensionEndpoint, {origin: `chrome-extension://${id}`});
  await once(ext, 'open');
  ext.on('message', data => {
    const request = JSON.parse(data);
    ext.send(JSON.stringify({id: request.id, result: request.params?.method === 'Target.getTargetInfo'
      ? {targetInfo: {targetId: 'fixture', type: 'page'}} : {}}));
  });
  ext.send(JSON.stringify({method: 'ready', params: {id: 42, url: 'http://fixture.test'}}));
  await relay.ready;
  await refused(relay.cdpEndpoint, {origin: 'https://attacker.example'});
  const cdp = new WebSocket(relay.cdpEndpoint);
  await once(cdp, 'open');
  await refused(relay.cdpEndpoint);
  const result = new Promise(resolve => cdp.on('message', data => {
    const message = JSON.parse(data);
    if (message.id === 1) resolve(message);
  }));
  cdp.send(JSON.stringify({id: 1, method: 'Target.setAutoAttach', params: {autoAttach: true}}));
  assert.deepEqual((await result).result, {});
  assert.equal(relay.status().targetId, 'fixture');
  const trace = JSON.stringify(relay.trace());
  assert.ok(!trace.includes(new URL(relay.cdpEndpoint).pathname));
  const closed = once(ext, 'close');
  cdp.close();
  await closed;
  assert.equal(relay.status().stopped, true);
  assert.equal(relay.status().pending, 0);
});

test('retiring a child cancels only its pending command and consumes only its known late response',async t=>{
 const relay=await createRelay('a'.repeat(32));t.after(()=>relay.stop());
 const ext=new WebSocket(relay.extensionEndpoint,{origin:'chrome-extension://'+'a'.repeat(32)});await once(ext,'open');
 let held,started;const pendingStarted=new Promise(resolve=>started=resolve);
 ext.on('message',data=>{const m=JSON.parse(data);if(m.method==='command'&&m.params.method==='Runtime.evaluate'){held=m.id;started();return}
  ext.send(JSON.stringify({id:m.id,result:m.params?.method==='Target.getTargetInfo'?{targetInfo:{targetId:'root',type:'page'}}:{}}));});
 ext.send(JSON.stringify({method:'ready',params:{id:42,url:'http://fixture'}}));await relay.ready;
 const cdp=new WebSocket(relay.cdpEndpoint);await once(cdp,'open');
 const next=predicate=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cdp.off('message',listen);reject(new Error('Expected protocol response missing'))},3000);const listen=data=>{const m=JSON.parse(data);if(predicate(m)){clearTimeout(timer);cdp.off('message',listen);resolve(m)}};cdp.on('message',listen)});
 let waiting=next(m=>m.id===1);cdp.send(JSON.stringify({id:1,method:'Target.setAutoAttach',params:{autoAttach:true}}));await waiting;
 waiting=next(m=>m.method==='Target.attachedToTarget'&&m.params.targetInfo.type==='iframe');
 ext.send(JSON.stringify({method:'event',params:{source:{tabId:42},method:'Target.attachedToTarget',params:{sessionId:'raw-child',targetInfo:{targetId:'frame',type:'iframe'}}}}));const child=(await waiting).params.sessionId;
 waiting=next(m=>m.id===2);cdp.send(JSON.stringify({id:2,sessionId:child,method:'Runtime.evaluate',params:{expression:'new Promise(()=>{})',awaitPromise:true}}));await pendingStarted;
 ext.send(JSON.stringify({method:'event',params:{source:{tabId:42},method:'Target.detachedFromTarget',params:{sessionId:'raw-child',targetId:'frame'}}}));
 assert.match((await waiting).error.message,/retired/);ext.send(JSON.stringify({id:held,result:{late:true}}));
 waiting=next(m=>m.id===3);cdp.send(JSON.stringify({id:3,method:'Browser.getVersion'}));assert.ok((await waiting).result.product);assert.equal(relay.status().stopped,false);assert.equal(relay.status().pending,0);
 const closed=once(ext,'close');ext.send(JSON.stringify({id:999999,result:{}}));await closed;assert.equal(relay.status().stopped,true);
});

test('Page.captureScreenshot and Accessibility.getFullAXTree use awaitedMs deadline instead of ordinaryMs', () => {
  assert.equal(browserDeadline('command', {method: 'Page.captureScreenshot'}), TRANSPORT_LIMITS.awaitedMs);
  assert.equal(browserDeadline('command', {method: 'Accessibility.getFullAXTree'}), TRANSPORT_LIMITS.awaitedMs);
  assert.equal(browserDeadline('command', {method: 'DOM.getDocument'}), TRANSPORT_LIMITS.ordinaryMs);
});
