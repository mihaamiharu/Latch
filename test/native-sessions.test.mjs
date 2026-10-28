import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {NativeSessions} from '../src/native-sessions.mjs';
import {BrowserModel} from '../src/native-browser-model.mjs';
import {createController} from '../extension/controller.js';
import {OFFICIAL_ID} from '../extension/protocol.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeWorkflow} from '../src/native-workflow.mjs';

const identity = () => ({instanceId: crypto.randomUUID(), epoch: crypto.randomUUID(), extensionId: 'a'.repeat(32), capabilities: {nativeTransport: true}});
const key = () => crypto.randomBytes(32).toString('hex');

test('native reservations are atomic across both adapters and preserve existing groups/windows', async () => {
  const id = identity(), a = key(), b = key(), c = key();
  const connectUrl = `chrome-extension://${OFFICIAL_ID}/connect.html?protocolVersion=2&mcpRelayUrl=${encodeURIComponent('ws://127.0.0.1:40000/extension/'+crypto.randomUUID())}`;
  const tabs = [{id: 1, windowId: 10, groupId: 90, url: 'https://fixture/same'},
    {id: 2, windowId: 20, groupId: 91, url: 'https://fixture/same'},
    {id: 3, windowId: 10, groupId: 92, url: connectUrl}];
  const native = {available: true, release: async () => {}, isAttached: () => true, connect: async () => {}};
  const api = {tabs: {get: async id => tabs.find(t => t.id === id), query: async () => tabs,
    group: () => { throw new Error('Native mode must preserve groups.'); }, ungroup: () => { throw new Error('Native mode must preserve groups.'); }},
    tabGroups: {get: async () => ({})}};
  const controller = createController(api, id, {nativeTransport: native});
  const call = async (op, p) => controller.handle({v: 1, id: crypto.randomUUID(), op, payload: {...id, ...p}});
  const competing = await Promise.all([a, b].map(sessionKey => call('native-reserve', {sessionKey, tabId: 1, expectedUrl: tabs[0].url})));
  assert.equal(competing.filter(r => r.ok).length, 1);
  assert.equal(competing.find(r => !r.ok).error.code, 'TAB_OWNED');
  const winner = competing[0].ok ? a : b;
  assert.equal((await call('native-reserve', {sessionKey: c, tabId: 2, expectedUrl: tabs[1].url})).ok, true);
  assert.equal((await call('native-reserve', {sessionKey: winner, tabId: 2, expectedUrl: tabs[1].url})).ok, false);
  const official = key();
  assert.equal((await call('register', {sessionKey: official, connectUrl})).ok, true);
  assert.equal((await call('claim', {sessionKey: official, tabId: 1, expectedUrl: tabs[0].url})).error.code, 'TAB_OWNED');
  assert.equal((await call('native-release', {sessionKey: winner, tabId: 2})).error.code, 'TAB_NOT_OWNED');
  const bad = await controller.handle({v: 1, id: crypto.randomUUID(), op: 'native-release', payload: {...id, epoch: crypto.randomUUID(), sessionKey: winner}});
  assert.equal(bad.error.code, 'PROFILE_MISMATCH');
  assert.equal((await call('native-release', {sessionKey: winner, tabId: 1})).ok, true);
  assert.equal((await call('native-check', {sessionKey: c, tabId: 2, expectedUrl: tabs[1].url})).ok, true);
  assert.deepEqual(tabs.slice(0, 2).map(t => [t.windowId, t.groupId]), [[10, 90], [20, 91]]);
});

test('relay session IDs and child routes cannot be reused across agent connections', async () => {
  const make = name => new BrowserModel(async (method, params) => params.method === 'Target.getTargetInfo'
    ? {targetInfo: {targetId: name}} : {}, () => {});
  const a = make('a'), b = make('b');
  a.setTab({id: 1}); b.setTab({id: 2});
  await Promise.all([a.initialize(), b.initialize()]);
  assert.notEqual(a.sessionId, b.sessionId);
  await assert.rejects(a.command({sessionId: b.sessionId, method: 'Runtime.evaluate'}), /not owned/);
  await assert.rejects(b.command({sessionId: a.sessionId, method: 'Runtime.evaluate'}), /not owned/);
  await assert.rejects(a.command({method: 'Target.attachToTarget', params: {targetId: 'b'}}), /not owned/);
  assert.deepEqual(await b.command({method: 'Target.getTargets'}), {targetInfos: [{targetId: 'b'}]});
});

test('failed native bootstrap releases only its reservation; stale identities are rejected first', async () => {
  const id = identity(), a = key(), b = key(), calls = [];
  const relayFactory = async () => ({extensionEndpoint: 'private', cdpEndpoint: 'private', ready: Promise.resolve(),
    stop: async () => {}, status: () => ({stopped: false, targetId: 'target'})});
  const manager = new NativeSessions(id, async (op, payload) => {
    calls.push([op, payload.sessionKey]);
    if (op === 'native-open' && payload.sessionKey === b) throw Object.assign(new Error('fixture failure'), {code: 'FIXTURE'});
    return {};
  }, {relayFactory});
  const p = {...id, sessionKey: a, tabId: 1, expectedUrl: 'https://fixture'};
  assert.equal((await manager.handle('native-connect', p)).alreadyConnected, false);
  await assert.rejects(manager.handle('native-connect', {...p, sessionKey: b, tabId: 2}), {code: 'FIXTURE'});
  assert.equal(manager.sessions.has(a), true);
  assert.equal(manager.sessions.has(b), false);
  assert.ok(calls.some(([op, k]) => op === 'native-release' && k === b));
  assert.ok(!calls.some(([op, k]) => op === 'native-release' && k === a));
  const before = calls.length;
  await assert.rejects(manager.handle('native-disconnect', {...p, epoch: crypto.randomUUID()}), {code: 'PROFILE_MISMATCH'});
  assert.equal(calls.length, before);
  await manager.stop();
});

test('uncertain control timeout retains a private native record until explicit disconnect', async t => {
  const base=fileURLToPath(new URL('../work/native-workflow-unit/',import.meta.url));
  await fs.mkdir(base,{recursive:true}); const temp=await fs.mkdtemp(path.join(base,'run-'));
  const previous={runtime:process.env.QA_BROWSER_RUNTIME_DIR,cli:process.env.QA_BROWSER_PLAYWRIGHT_CLI};
  process.env.QA_BROWSER_RUNTIME_DIR=path.join(temp,'runtime');
  const fake=path.join(temp,'cli');
  await fs.writeFile(fake,`#!${process.execPath}\nconst a=process.argv.slice(2);console.log(JSON.stringify(a.includes('--version')?{version:'0.1.20'}:a.includes('list')?{browsers:[]}:{}));\n`,{mode:0o700});
  process.env.QA_BROWSER_PLAYWRIGHT_CLI=fake;
  t.after(async()=>{
    for(const [name,value] of [['QA_BROWSER_RUNTIME_DIR',previous.runtime],['QA_BROWSER_PLAYWRIGHT_CLI',previous.cli]])
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    await fs.rm(temp,{recursive:true,force:true});
  });
  const id=identity(), k=key(), calls=[];
  const args={command:'connect',payload:id,alias:'work',workspace:temp,session:'agent',key:k,tabId:42,options:{workspace:temp},
    call:async op=>{calls.push(op);if(op==='tabs')return [{tabId:42,url:'https://fixture'}];throw Object.assign(new Error('fixture timeout'),{code:'BRIDGE_TIMEOUT'});}};
  await assert.rejects(nativeWorkflow(args),{code:'NATIVE_CLEANUP_FAILED'});
  const record=path.join(temp,'runtime',k+'.session.json');
  assert.equal(JSON.parse(await fs.readFile(record)).status,'interrupted');
  assert.equal((await fs.stat(record)).mode&0o777,0o600);
  assert.deepEqual(calls,['tabs','native-connect']);
  const cleaned=await nativeWorkflow({...args,command:'disconnect',call:async op=>{assert.equal(op,'native-disconnect');return {disconnected:true};}});
  assert.equal(cleaned.disconnected,true);
  await assert.rejects(fs.stat(record),{code:'ENOENT'});
});
