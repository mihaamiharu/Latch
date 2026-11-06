import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createController} from '../extension/controller.js';
import {executeCLI} from '../src/cli.mjs';

test('open rejects unsafe/missing URLs and conflicting tab before contacting Chrome', async () => {
  for (const url of [undefined, 'about:blank', 'chrome://settings', 'javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com'])
    await assert.rejects(executeCLI({command:'open', flags:{url, session:'new'}}), {code:'INVALID_ARGUMENT'});
  await assert.rejects(executeCLI({command:'open', flags:{url:'https://example.com', tab:'1'}}), {code:'INVALID_ARGUMENT'});
  await assert.rejects(executeCLI({command:'connect', flags:{url:'https://example.com'}}), {code:'INVALID_ARGUMENT'});
});

test('fresh blank tab is reserved atomically and only its owner can attach; disconnect preserves it', async () => {
  const identity = {instanceId:crypto.randomUUID(), epoch:crypto.randomUUID()}, generation = crypto.randomUUID();
  const tabs = new Map([[1,{id:1,url:'https://existing.test/',groupId:3,windowId:10}], [2,{id:2,url:'about:blank',groupId:-1,windowId:10}]]);
  const creates = [];
  const controller = createController({windows:{getAll:async()=>[{id:20,incognito:true,focused:true},{id:10,incognito:false}]},tabs:{
    query:async()=>[...tabs.values()], get:async id=>{if (!tabs.has(id)) throw new Error('gone'); return {...tabs.get(id)};},
    create:async options=>{creates.push(options);const tab={id:3,url:'',pendingUrl:options.url,windowId:10,groupId:-1};tabs.set(3,tab);return {...tab};},
  }}, identity, {nativeTransport:{available:true, preflight:async()=>{}, release:async()=>{}, isAttached:()=>true}});
  await controller.activateNative(generation);
  const a = 'a'.repeat(64), b = 'b'.repeat(64), leaseId = crypto.randomUUID();
  const send = (op,p={})=>controller.handle({v:1,id:crypto.randomUUID(),op,payload:{...identity,hostGeneration:generation,leaseId,sessionKey:a,...p}});
  const result = await send('native-create-tab');
  assert.equal(result.ok,true);assert.equal(result.result.created,true);assert.equal(result.result.tabId,3);
  assert.deepEqual(creates,[{windowId:10,url:'about:blank',active:false}]);
  assert.equal((await send('native-create-tab')).error.code,'SESSION_COLLISION');
  assert.equal((await send('native-reserve',{tabId:3,expectedUrl:'about:blank'})).ok,true);
  assert.equal((await send('native-reserve',{tabId:3,expectedUrl:'about:blank',sessionKey:b})).error.code,'TAB_UNSUPPORTED');
  assert.equal((await send('native-reserve',{tabId:2,expectedUrl:'about:blank',sessionKey:b})).error.code,'TAB_UNSUPPORTED');
  assert.equal((await send('native-create-tab',{leaseId:crypto.randomUUID()})).error.code,'AUTHORITY_STALE');
  assert.equal(creates.length,1);
  assert.equal((await send('native-release')).ok,true);
  assert.equal(tabs.get(3).pendingUrl,'about:blank');assert.equal(tabs.get(1).url,'https://existing.test/');
  assert.equal(tabs.get(1).groupId,3);
});
