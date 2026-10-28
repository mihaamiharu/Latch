import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {BrowserModel} from '../src/native-browser-model.mjs';
import {createController} from '../extension/controller.js';

test('popup model preserves proven opener identity and surviving targets after parent closes',async()=>{
  const calls=[],events=[];
  const model=new BrowserModel(async(method,p)=>{
    calls.push({method,...p});return p.method==='Target.getTargetInfo'?{targetInfo:{targetId:'target-'+p.tabId,type:'page',url:'http://same'}}:{};
  },event=>events.push(event));
  model.setTab({id:1,url:'http://same'});await model.initialize();
  const rootSession=model.sessionId;
  await model.addTab({id:2,url:'about:blank',openerTabId:1});
  const popup=events.find(e=>e.method==='Target.attachedToTarget'&&e.params.targetInfo.targetId==='target-2');
  assert.equal(popup.params.targetInfo.openerId,'target-1');
  await model.command({method:'Runtime.evaluate',sessionId:popup.params.sessionId});
  assert.equal(calls.at(-1).tabId,2);
  await assert.rejects(model.addTab({id:3,openerTabId:999}),/owned parent/);
  await assert.rejects(model.command({method:'Target.getTargetInfo',sessionId:popup.params.sessionId,params:{targetId:'foreign'}}),/not owned/);
  model.removeTab(1);
  assert.deepEqual(model.inventory().map(t=>t.tabId),[2]);
  await assert.rejects(model.command({method:'Runtime.evaluate',sessionId:rootSession}),/not owned/);
  assert.equal((await model.command({method:'Target.getTargetInfo',sessionId:popup.params.sessionId})).targetInfo.targetId,'target-2');
  await model.command({method:'Target.closeTarget',params:{targetId:'target-2'}});
  assert.equal(calls.at(-1).method,'close');assert.equal(calls.at(-1).tabId,2);
});

test('popup reservations require a live owned opener and enforce depth without regrouping tabs',async()=>{
  const identity={instanceId:crypto.randomUUID(),epoch:crypto.randomUUID()};
  const key='a'.repeat(64), other='b'.repeat(64), tabs=new Map();
  const native={available:true,addTab:()=>true,release:async()=>{},removeTab:async()=>{},isAttached:()=>true};
  const api={tabs:{get:async id=>{if(!tabs.has(id))throw new Error('closed');return tabs.get(id)},query:async()=>[...tabs.values()],
    group:()=>{throw new Error('Unexpected regroup')},ungroup:()=>{throw new Error('Unexpected regroup')}}};
  const controller=createController(api,identity,{nativeTransport:native});
  const call=async(op,p={})=>controller.handle({v:1,id:crypto.randomUUID(),op,payload:{...identity,sessionKey:key,...p}});
  tabs.set(1,{id:1,url:'http://same',windowId:10,groupId:12});
  tabs.set(2,{id:2,url:'http://same',windowId:10,groupId:12});
  assert.equal((await call('native-reserve',{tabId:1,expectedUrl:'http://same'})).ok,true);
  await controller.observeTab(tabs.get(2));
  assert.equal((await call('tabs')).result.find(t=>t.tabId===2).owner,null);
  for(let id=3;id<=7;id++){
    const tab={id,url:'about:blank',openerTabId:id===3?1:id-1,windowId:20,groupId:-1};
    tabs.set(id,tab);await controller.observeTab(tab);
  }
  const owned=(await call('native-inventory')).result;
  assert.deepEqual(owned.targets.map(t=>t.tabId),[1,3,4,5,6]);
  assert.equal(owned.warnings[0].code,'POPUP_LIMIT_EXCEEDED');
  tabs.set(3,{...tabs.get(3),url:'http://same'});
  assert.equal((await call('native-reserve',{sessionKey:other,tabId:3,expectedUrl:'http://same'})).error.code,'TAB_OWNED');
  tabs.delete(1);await controller.removeTab(1);
  assert.ok((await call('native-inventory')).result.targets.some(t=>t.tabId===3));
  assert.equal((await call('native-release',{tabId:1})).ok,true);
  assert.ok((await call('tabs')).result.every(t=>t.owner===null));
});

test('lifecycle enable waits until the initial frame-tree response has been delivered',async()=>{
  const commands=[];
  const model=new BrowserModel(async(method,p)=>{
    commands.push(p.method);
    return p.method==='Target.getTargetInfo'?{targetInfo:{targetId:'root'}}:{};
  },()=>{});
  model.setTab({id:1});await model.initialize();
  const tree={id:1,method:'Page.getFrameTree',sessionId:model.sessionId};
  await model.command(tree);
  const lifecycle=model.command({method:'Page.setLifecycleEventsEnabled',sessionId:model.sessionId,params:{enabled:true}});
  const runtime=model.command({method:'Runtime.enable',sessionId:model.sessionId});
  await Promise.resolve();
  assert.ok(!commands.includes('Page.setLifecycleEventsEnabled'));
  assert.ok(!commands.includes('Runtime.enable'));
  model.didSendResponse(tree);await Promise.all([lifecycle,runtime]);
  assert.ok(commands.includes('Page.setLifecycleEventsEnabled'));
  assert.ok(commands.includes('Runtime.enable'));
});

test('verified opener correction moves a provisional child to its actual session and respects explicit release',async()=>{
  const identity={instanceId:crypto.randomUUID(),epoch:crypto.randomUUID()};
  const a='a'.repeat(64),b='b'.repeat(64),tabs=new Map([
    [1,{id:1,url:'http://same',groupId:-1}], [2,{id:2,url:'http://same',groupId:-1}],
    [3,{id:3,url:'http://same',groupId:-1,openerTabId:1}],
  ]);
  const attempts=[];
  const native={available:true,release:async()=>{},removeTab:async()=>{},isAttached:()=>true,
    addTab:async(key,tab)=>{attempts.push(key);return key===a?{openerTabId:2}:true}};
  const api={tabs:{get:async id=>tabs.get(id),query:async()=>[...tabs.values()]}};
  const controller=createController(api,identity,{nativeTransport:native});
  const call=(key,op,p={})=>controller.handle({v:1,id:crypto.randomUUID(),op,payload:{...identity,sessionKey:key,...p}});
  await call(a,'native-reserve',{tabId:1,expectedUrl:'http://same'});
  await call(b,'native-reserve',{tabId:2,expectedUrl:'http://same'});
  await controller.observeTab(tabs.get(3));
  assert.deepEqual(attempts,[a,b]);
  assert.equal((await call(a,'tabs')).result.find(t=>t.tabId===3).owner,b);
  assert.equal((await call(b,'native-inventory')).result.targets.find(t=>t.tabId===3).openerTabId,2);
  await call(b,'native-drop',{tabId:3});
  await controller.observeTab(tabs.get(3));
  assert.deepEqual(attempts,[a,b]);
  assert.equal((await call(a,'tabs')).result.find(t=>t.tabId===3).owner,null);
});

test('popup active-target limit leaves excess tabs open and unclaimed',async()=>{
  const identity={instanceId:crypto.randomUUID(),epoch:crypto.randomUUID()},key='a'.repeat(64);
  const tabs=new Map([[1,{id:1,url:'http://fixture',groupId:-1}]]),adopted=[];
  const native={available:true,release:async()=>{},isAttached:()=>true,addTab:async(_key,t)=>{adopted.push(t.id);return true}};
  const controller=createController({tabs:{get:async id=>tabs.get(id),query:async()=>[...tabs.values()]}},identity,{nativeTransport:native});
  const call=(op,p={})=>controller.handle({v:1,id:crypto.randomUUID(),op,payload:{...identity,sessionKey:key,...p}});
  await call('native-reserve',{tabId:1,expectedUrl:'http://fixture'});
  for(let id=2;id<=17;id++){
    const tab={id,url:'http://fixture',groupId:-1,openerTabId:1};tabs.set(id,tab);await controller.observeTab(tab);
  }
  const result=(await call('native-inventory')).result;
  assert.equal(result.targets.length,16);assert.equal(adopted.length,15);
  assert.deepEqual(result.warnings,[{code:'POPUP_LIMIT_EXCEEDED',tabId:17}]);
  assert.equal((await call('tabs')).result.find(t=>t.tabId===17).owner,null);
  assert.equal(tabs.size,17);
});
