import test from 'node:test';import assert from 'node:assert/strict';
import {ChildSessions,CHILD_LIMITS} from '../extension/child-sessions.js';
import {BrowserModel} from '../src/native-browser-model.mjs';
const entry=(id,parent)=>({id,parent,targetId:'target-'+id,type:'iframe'});
test('child graph retires a subtree, rejects stale/foreign ancestry and permits a fresh lifetime',()=>{
 const graph=new ChildSessions();graph.add(entry('a'));graph.add(entry('b','a'));graph.add(entry('c','b'));graph.add(entry('peer'));
 assert.equal(graph.add(entry('a')).duplicate,true);assert.throws(()=>graph.add(entry('foreign','missing')),/not owned/);
 assert.deepEqual(graph.remove('a').map(e=>e.id),['c','b','a']);assert.equal(graph.has('peer'),true);
 assert.throws(()=>graph.add(entry('b','peer')),/retired/);assert.throws(()=>graph.add({...entry('service'),type:'service_worker'}),/Unsupported/);
 assert.equal(graph.add({...entry('b','peer'),targetId:'new-target'}).duplicate,false);
});
test('child graph checks active, depth and lease limits before adoption',()=>{
 const graph=new ChildSessions();for(let n=0;n<CHILD_LIMITS.perTab;n++)graph.add(entry('c'+n));assert.throws(()=>graph.add(entry('extra')),/limit/);
 const deep=new ChildSessions();for(let n=0;n<CHILD_LIMITS.depth;n++)deep.add(entry('d'+n,n?'d'+(n-1):undefined));assert.throws(()=>deep.add(entry('extra','d15')),/limit/);
 assert.throws(()=>new ChildSessions().add(entry('x'),CHILD_LIMITS.perLease),/limit/);
});
test('model rejects commands through all retired descendant routes',async()=>{
 const events=[],calls=[];const model=new BrowserModel(async(method,p)=>{calls.push(p);return p.method==='Target.getTargetInfo'?{targetInfo:{targetId:'root',type:'page'}}:{}},e=>events.push(e));
 model.setTab({id:1});await model.initialize();
 model.onEvent({source:{tabId:1},method:'Target.attachedToTarget',params:{sessionId:'a',targetInfo:{targetId:'frame-a',type:'iframe'}}});const a=events.at(-1).params.sessionId;
 model.onEvent({source:{tabId:1,sessionId:'a'},method:'Target.attachedToTarget',params:{sessionId:'b',targetInfo:{targetId:'frame-b',type:'iframe'}}});const b=events.at(-1).params.sessionId;
 model.onEvent({source:{tabId:1},method:'Target.detachedFromTarget',params:{sessionId:'a',targetId:'frame-a'}});
 const count=calls.length;await assert.rejects(model.command({method:'Runtime.evaluate',sessionId:a}),/not owned/);await assert.rejects(model.command({method:'Runtime.evaluate',sessionId:b}),/not owned/);assert.equal(calls.length,count);
});

test('child inspection aliases retire with the actual target and never become a sibling route',async()=>{
 const events=[],calls=[];const model=new BrowserModel(async(method,p)=>{calls.push(p);return p.method==='Target.getTargetInfo'?{targetInfo:{targetId:p.sessionId?'frame-a':'root',type:'iframe'}}:{}},e=>events.push(e));
 model.setTab({id:1});await model.initialize();model.onEvent({source:{tabId:1},method:'Target.attachedToTarget',params:{sessionId:'a',targetInfo:{targetId:'frame-a',type:'iframe'}}});
 const alias=await model.command({method:'Target.attachToTarget',params:{targetId:'frame-a'}});
 await model.command({method:'Runtime.evaluate',sessionId:alias.sessionId});assert.equal(calls.at(-1).sessionId,'a');
 model.onEvent({source:{tabId:1},method:'Target.detachedFromTarget',params:{sessionId:'a',targetId:'frame-a'}});
 await assert.rejects(model.command({method:'Runtime.evaluate',sessionId:alias.sessionId}),/not owned/);
 assert.ok(events.some(e=>e.method==='Target.detachedFromTarget'&&e.params.sessionId===alias.sessionId));
 model.onEvent({source:{tabId:1},method:'Target.attachedToTarget',params:{sessionId:'a',targetInfo:{targetId:'new-frame',type:'iframe'}}});
 await assert.rejects(model.command({method:'Runtime.evaluate',sessionId:alias.sessionId}),/not owned/);
});

test('child filter preserves requested exclusions and never enables shared or service workers',async()=>{
 const {childFilter}=await import('../extension/child-sessions.js');
 assert.deepEqual(childFilter(),[{type:'iframe',exclude:false},{type:'worker',exclude:false},{exclude:true}]);
 assert.deepEqual(childFilter([{type:'worker',exclude:true},{}]),[{type:'iframe',exclude:false},{exclude:true}]);
 assert.deepEqual(childFilter([]),[{exclude:true}]);
});

test('retirement history is bounded and fails closed when exhausted',()=>{
 const graph=new ChildSessions();for(let n=0;n<=CHILD_LIMITS.retired;n++){graph.add({...entry('same'),targetId:'generation-'+n});graph.remove('same')}
 assert.equal(graph.retired.size,CHILD_LIMITS.retired);assert.throws(()=>graph.add({...entry('same'),targetId:'another'}),/retired/);
});
test('closing the root notifies and retires its inspection aliases',async()=>{
 const events=[];const model=new BrowserModel(async(method,p)=>p.method==='Target.getTargetInfo'?{targetInfo:{targetId:'root',type:'page'}}:{},e=>events.push(e));model.setTab({id:1});await model.initialize();
 const c=await model.command({method:'Target.attachToTarget',params:{targetId:'root'}});model.removeTab(1);
 assert.ok(events.some(e=>e.method==='Target.detachedFromTarget'&&e.params.sessionId===c.sessionId));await assert.rejects(model.command({method:'Runtime.evaluate',sessionId:c.sessionId}),/not owned/);
});
