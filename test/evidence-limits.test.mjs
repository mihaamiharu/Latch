import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {TRANSPORT_LIMITS as L,prepareWire,browserDeadline} from '../extension/transport-limits.js';import {relayFixture} from './helpers/relay-fixture.mjs';import {eventually} from './helpers/native-browser.mjs';
const enabled=process.env.LATCH_EVIDENCE_LIMITS==='1';
const exact=(value,n,unicode=false)=>{const base=JSON.stringify({...value,padding:''}),room=n-Buffer.byteLength(base),pad=unicode?'雪'.repeat(Math.floor(room/3))+'x'.repeat(room%3):'x'.repeat(room);const text=JSON.stringify({...value,padding:pad});assert.equal(Buffer.byteLength(text),n);return text};
test('wire guard declares backlog plus one finite message and counts UTF-8 envelopes',()=>{
 assert.equal(prepareWire({x:'雪'},L.backlog).bytes,Buffer.byteLength(JSON.stringify({x:'雪'})));assert.throws(()=>prepareWire({},L.backlog+1),{code:'TRANSPORT_BACKLOG'});
 assert.equal(prepareWire(JSON.parse(exact({id:1},L.message)),0).bytes,L.message);assert.throws(()=>prepareWire(JSON.parse(exact({id:1},L.message+1)),0),{code:'WIRE_MESSAGE_TOO_LARGE'});
 assert.equal(browserDeadline('command',{method:'Runtime.evaluate',params:{awaitPromise:true,timeout:999999}}),30000);assert.equal(browserDeadline('command',{method:'Runtime.evaluate',params:{awaitPromise:false}}),10000);assert.equal(browserDeadline('command',{method:'Network.getResponseBody'}),10000);
});
for(const role of ['cdp','extension'])test(`actual native wire boundary and fragments: ${role}`,{skip:!enabled,timeout:45000},async t=>{
 const f=await relayFixture(t);
 for(const [i,size]of [L.message-1,L.message].entries()){
  if(role==='cdp'){
   const text=exact({id:100+i,method:'Browser.getVersion'},size,true);const received=new Promise(resolve=>{const listener=data=>{const m=JSON.parse(data);if(m.id===100+i){f.cdp.off('message',listener);resolve(m)}};f.cdp.on('message',listener)});
   const bytes=Buffer.from(text),cut=bytes.indexOf(Buffer.from('雪'))+1;f.cdp.send(bytes.subarray(0,cut),{binary:false,fin:false});f.cdp.send(bytes.subarray(cut),{binary:false,fin:true});assert.ok((await received).result.product);
  }else{
   const event=f.waitEvent('Runtime.consoleAPICalled'),text=exact({method:'event',params:{source:{tabId:42},method:'Runtime.consoleAPICalled',params:{type:'log',args:[],timestamp:i}}},size,true);
   const bytes=Buffer.from(text),cut=bytes.indexOf(Buffer.from('雪'))+1;f.ext.send(bytes.subarray(0,cut),{binary:false,fin:false});f.ext.send(bytes.subarray(cut),{binary:false,fin:true});await event;
  }
  assert.equal(f.relay.status().stopped,false);assert.equal(f.relay.status().metrics.maxReceivedMessage,size);
 }
 const socket=role==='cdp'?f.cdp:f.ext,closed=once(socket,'close');socket.send(exact(role==='cdp'?{id:999,method:'Browser.getVersion'}:{method:'event',params:{source:{tabId:42},method:'Runtime.consoleAPICalled',params:{}}},L.message+1));await closed;
 assert.equal(f.relay.status().stopped,true);assert.equal(f.relay.status().pending,0);await f.relay.stop();await eventually(()=>f.relay.status().resources.clients===0,2000);assert.deepEqual(f.relay.status().resources,{clients:0,listening:false,pendingTimers:0});
});
test('pending 65th call is rejected before dispatch; accepted replies settle',{skip:!enabled,timeout:20000},async t=>{
 const f=await relayFixture(t),held=[];f.handle((m,respond)=>m.params?.method==='Runtime.evaluate'?held.push(m):respond(m));
 const calls=Array.from({length:64},()=>f.request('Runtime.evaluate',{expression:'hold'},f.root));await eventually(()=>held.length===64);
 const overflow=await f.request('Runtime.evaluate',{expression:'overflow'},f.root);assert.match(overflow.error.message,/Too many pending/);assert.equal(held.length,64);
 for(const m of held)f.ext.send(JSON.stringify({id:m.id,result:{result:{value:1}}}));assert.ok((await Promise.all(calls)).every(m=>m.result));assert.equal(f.relay.status().pending,0);assert.equal(f.relay.status().metrics.pendingHighWater,64);
 // A late producer cannot reuse a stopped lease or disturb a fresh peer.
 held.length=0;const late=f.request('Runtime.evaluate',{expression:'late'},f.root).catch(()=>null);await eventually(()=>held.length===1);
 const closed=once(f.ext,'close');await f.relay.stop('explicit-stop');await closed;await late;assert.equal(f.relay.status().pending,0);
 const prevented=await new Promise(resolve=>f.ext.send(JSON.stringify({id:held[0].id,result:{foreignLate:true}}),error=>resolve(!!error)));assert.equal(prevented,true);
 const peer=await relayFixture(t);assert.ok((await peer.request('Browser.getVersion')).result.product);assert.equal(peer.relay.status().stopped,false);
});
for(const direction of ['extension','cdp'])test(`paused ${direction} reader exhausts only its own backlog`,{skip:!enabled,timeout:20000},async t=>{
 const f=await relayFixture(t),peer=await relayFixture(t),waiting=[];const paused=direction==='extension'?f.ext:f.cdp;paused.pause();
 for(let i=0;i<24&&!f.relay.status().stopped;i++){
  if(direction==='extension')waiting.push(f.request('Runtime.evaluate',{expression:'x'.repeat(2*1024*1024)},f.root).catch(()=>null));
  else await new Promise(resolve=>f.ext.send(JSON.stringify({method:'event',params:{source:{tabId:42},method:'Runtime.consoleAPICalled',params:{type:'log',args:[{value:'x'.repeat(2*1024*1024)}]}}}),()=>resolve()));
  await new Promise(resolve=>setImmediate(resolve));
 }
 await eventually(()=>f.relay.status().stopped);paused.resume();await Promise.all(waiting);assert.equal(f.relay.status().reason,'TRANSPORT_BACKLOG');assert.equal(f.relay.status().pending,0);
 assert.ok((await peer.request('Browser.getVersion')).result.product);assert.equal(peer.relay.status().stopped,false);
});
