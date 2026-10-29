import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createBridgeConnection} from '../extension/bridge-connection.js';

function fixture(t, saved) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); }});
  const ports = [], writes = [], alarms = [], storage = {latchRetry: saved}; let time = 0, invalidations = 0;
  const api = {runtime: {lastError: null, connectNative() { const p = {onMessage: event(), onDisconnect: event(), sent: [], postMessage(m) { this.sent.push(m); }, disconnect() {}}; ports.push(p); return p; }},
    storage: {local: {get: async key => ({[key]: storage[key]}), set: async value => { writes.push(value); Object.assign(storage, value); }}},
    alarms: {clear: async () => {}, create: async (name, info) => alarms.push({name,...info}), onAlarm: event()}};
  const hello = {v: 1, type: 'hello', instanceId: crypto.randomUUID(), epoch: crypto.randomUUID()};
  const bridge = createBridgeConnection(api, {host: 'fixture', hello, now: () => time, dispatch: async () => ({}), invalidate: async () => { invalidations++; }});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const tick = async ms => { time += ms; t.mock.timers.tick(ms); await flush(); };
  const ack = async (index = ports.length - 1) => { const p = ports[index], generation = crypto.randomUUID(), nonce = p.sent[0].nonce; p.onMessage.emit({type:'challenge',epoch:hello.epoch,hostGeneration:generation,nonce}); await flush(); p.onMessage.emit({type:'ready',epoch:hello.epoch,hostGeneration:generation,nonce}); await flush(); return generation; };
  return {bridge,api,ports,writes,alarms,hello,flush,tick,ack,get invalidations(){return invalidations}};
}
test('readiness requires exact challenge/ACK and clears errors only on confirmed readiness', async t => {
  const f = fixture(t); await f.bridge.start(); assert.equal(f.bridge.status().connected,false);
  f.ports[0].onMessage.emit({type:'ready',nonce:f.ports[0].sent[0].nonce,epoch:f.hello.epoch}); await f.flush(); assert.equal(f.bridge.status().connected,false);
  f.ports[0].onMessage.emit({type:'ready',epoch:f.hello.epoch,hostGeneration:'wrong',nonce:'wrong'}); await f.flush(); assert.equal(f.bridge.status().connected,false);
  await f.ack(); assert.equal(f.bridge.status().connected,true);
  f.api.runtime.lastError={message:'host disappeared'};f.ports[0].onDisconnect.emit();await f.flush();assert.equal(f.bridge.status().connected,false);assert.equal(f.invalidations,2);assert.match(f.bridge.status().lastError,/disappeared/);
  await f.tick(1000);assert.equal(f.ports.length,2);assert.match(f.bridge.status().lastError,/disappeared/);const generation=await f.ack();assert.equal(f.bridge.status().lastError,'');
  f.ports[0].onDisconnect.emit();await f.flush();assert.equal(f.bridge.status().hostGeneration,generation);assert.equal(f.bridge.status().connected,true);
});
test('missing acknowledgments exhaust a finite retry budget with durable alarms and explicit retry',async t=>{
  const f=fixture(t);await f.bridge.start();
  for(const delay of [1000,2000,4000,8000,16000]){await f.tick(5000);assert.equal(f.bridge.status().connected,false);await f.tick(delay)}
  await f.tick(5000);assert.equal(f.ports.length,6);assert.equal(f.bridge.status().state,'degraded');assert.equal(f.bridge.status().nextAttemptAt,null);
  await f.tick(1000000);assert.equal(f.ports.length,6);assert.ok(f.alarms.length>=5);assert.ok(f.writes.some(w=>w.latchRetry.degraded));
  await f.bridge.start({reset:true});await f.ack();assert.equal(f.bridge.status().state,'ready');
});
test('worker restart honors a persisted due time and degraded state',async t=>{
  const f=fixture(t,{attempts:2,nextAttemptAt:4000,degraded:false});await f.bridge.start();assert.equal(f.ports.length,0);await f.tick(4000);assert.equal(f.ports.length,1);await f.ack();assert.equal(f.bridge.status().attempts,0);
});
