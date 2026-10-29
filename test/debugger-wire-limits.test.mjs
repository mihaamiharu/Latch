import test from 'node:test';import assert from 'node:assert/strict';import {createDebuggerTransport} from '../extension/debugger-transport.js';
for(const reason of ['TRANSPORT_BACKLOG','WIRE_MESSAGE_TOO_LARGE'])test(`extension ${reason} uses a browser-valid close code and preserves its peer`,async t=>{
 const previous=globalThis.WebSocket,sockets=[],warnings=[];let event;
 class Socket extends EventTarget{static OPEN=1;readyState=1;bufferedAmount=0;messages=[];constructor(){super();sockets.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')))}send(s){this.messages.push(JSON.parse(s))}close(code=1000,text=''){assert.ok(code===1000||code>=3000&&code<=4999);if(this.readyState===3)return;this.code=code;this.reason=text;this.readyState=3}}
 globalThis.WebSocket=Socket;t.after(()=>globalThis.WebSocket=previous);
 const api={debugger:{onEvent:{addListener:fn=>event=fn},onDetach:{addListener:()=>{}},detach:async()=>{},getTargets:async()=>[]},tabs:{}};
 const transport=createDebuggerTransport(api,{onWarning:(key,warning)=>warnings.push({key,...warning})});
 for(const [key,id]of [['a',1],['b',2]])await transport.connect(key,{id,url:'http://fixture'},'ws://127.0.0.1:1000/extension/'+'a'.repeat(64));
 if(reason==='TRANSPORT_BACKLOG')sockets[0].bufferedAmount=8*1024*1024+1;
 event({tabId:1},'Runtime.consoleAPICalled',{value:reason==='WIRE_MESSAGE_TOO_LARGE'?'x'.repeat(32*1024*1024):'small'});
 await new Promise(r=>setImmediate(r));assert.ok(warnings.some(w=>w.key==='a'&&w.code===reason));assert.equal(sockets[0].code,4009);assert.equal(sockets[1].readyState,1);
 const before=sockets[1].messages.length;event({tabId:2},'Runtime.consoleAPICalled',{value:'peer'});assert.equal(sockets[1].messages.length,before+1);await transport.releaseAll();
});
