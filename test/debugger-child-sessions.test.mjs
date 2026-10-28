import test from 'node:test';import assert from 'node:assert/strict';import {createDebuggerTransport} from '../extension/debugger-transport.js';

test('extension boundary rejects retired descendants before Chrome execution and preserves a new lifetime',async t=>{
 const original=globalThis.WebSocket,commands=[],sent=[],warnings=[];let event,ws;
 class FakeSocket extends EventTarget{
  static OPEN=1;readyState=1;bufferedAmount=0;
  constructor(){super();ws=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
  send(data){sent.push(JSON.parse(data))}close(){this.readyState=3}
 }
 globalThis.WebSocket=FakeSocket;t.after(()=>globalThis.WebSocket=original);
 const api={debugger:{onEvent:{addListener:fn=>event=fn},onDetach:{addListener:()=>{}},attach:async()=>{},detach:async()=>{},getTargets:async()=>[],
  sendCommand:async(source,method,params)=>{commands.push({source,method,params});return method==='Target.getTargetInfo'?{targetInfo:{targetId:'root'}}:{}}},tabs:{}};
 const transport=createDebuggerTransport(api,{onWarning:(_key,w)=>warnings.push(w)});await transport.connect('key',{id:1,url:'http://fixture'},'ws://127.0.0.1:10000/extension/'+'a'.repeat(64));
 await ws.onmessage({data:JSON.stringify({id:1,method:'attach',params:{tabId:1}})});
 const attach=(id,parent,targetId='target-'+id)=>event({tabId:1,...(parent?{sessionId:parent}:{})},'Target.attachedToTarget',{sessionId:id,targetInfo:{targetId,type:'iframe'},waitingForDebugger:false});
 attach('a');attach('b','a');event({tabId:1},'Target.detachedFromTarget',{sessionId:'a',targetId:'target-a'});
 const request=(id,sessionId)=>ws.onmessage({data:JSON.stringify({id,method:'command',params:{tabId:1,sessionId,method:'Runtime.evaluate',params:{expression:'1'}}})});
 let count=commands.length;await request(2,'b');assert.match(sent.at(-1).error,/not owned/);assert.equal(commands.length,count);
 attach('a',undefined,'new-target');count=commands.length;attach('a');await Promise.resolve();assert.equal(commands.length,count);assert.ok(warnings.length);
 await request(3,'a');assert.equal(sent.at(-1).id,3);assert.ok(!sent.at(-1).error);
 count=commands.length;await request(4,'foreign');assert.equal(commands.length,count);assert.match(sent.at(-1).error,/not owned/);
 const before=commands.length;event({tabId:1},'Target.attachedToTarget',{sessionId:'unsupported',targetInfo:{targetId:'unsupported',type:'shared_worker'},waitingForDebugger:true});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(commands.slice(before).map(c=>c.method),['Runtime.runIfWaitingForDebugger','Target.detachFromTarget']);
 await transport.release('key');
});
