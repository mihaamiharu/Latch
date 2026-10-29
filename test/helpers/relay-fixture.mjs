import {WebSocket} from 'ws';import {once} from 'node:events';import {createRelay} from '../../src/native-relay.mjs';
export async function relayFixture(t){
 const relay=await createRelay('a'.repeat(32)),ext=new WebSocket(relay.extensionEndpoint,{origin:'chrome-extension://'+'a'.repeat(32)});ext.on('error',()=>{});await once(ext,'open');let handler;
 const respond=m=>ext.send(JSON.stringify({id:m.id,result:m.params?.method==='Target.getTargetInfo'?{targetInfo:{targetId:'owned',type:'page'}}:{}}));ext.on('message',data=>{const m=JSON.parse(data);handler?handler(m,respond):respond(m)});
 ext.send(JSON.stringify({method:'ready',params:{id:42,url:'http://fixture'}}));await relay.ready;
 const cdp=new WebSocket(relay.cdpEndpoint);cdp.on('error',()=>{});await once(cdp,'open');let id=0;const pending=new Map(),events=new Set();
 cdp.on('message',data=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);p.resolve(m)}}else for(const e of events)if(e.method===m.method){events.delete(e);clearTimeout(e.timer);e.resolve(m)}});
 cdp.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP fixture closed'))}pending.clear()});
 const waitEvent=method=>new Promise((resolve,reject)=>{const item={method,resolve,timer:setTimeout(()=>{events.delete(item);reject(new Error('Missing fixture event '+method))},6000)};events.add(item)});
 const request=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('Fixture response deadline'))},6000);pending.set(n,{resolve,reject,timer});cdp.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}))});
 const attached=waitEvent('Target.attachedToTarget');await request('Target.setAutoAttach',{autoAttach:true});const root=(await attached).params.sessionId;
 const close=async()=>{for(const e of events)clearTimeout(e.timer);events.clear();await relay.stop()};t.after(close);
 return {relay,ext,cdp,root,request,waitEvent,handle:fn=>handler=fn,close};
}
