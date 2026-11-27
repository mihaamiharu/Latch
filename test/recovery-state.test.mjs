import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {RecoveryStore, readRecovery, recoveryPath} from '../src/recovery-state.mjs';
import {RecoveryCoordinator} from '../src/recovery-coordinator.mjs';
import {NativeRecovery, recoveryInspection} from '../src/native-recovery.mjs';
import {sessionKey} from '../src/playwright.mjs';

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'latch-recovery-unit-'));const original={config:process.env.LATCH_CONFIG,runtime:process.env.LATCH_RUNTIME_DIR};
 process.env.LATCH_CONFIG=path.join(dir,'config.json');process.env.LATCH_RUNTIME_DIR=path.join(dir,'runtime');await fs.mkdir(process.env.LATCH_RUNTIME_DIR);
 t.after(async()=>{for(const [key,value] of [['LATCH_CONFIG',original.config],['LATCH_RUNTIME_DIR',original.runtime]])value===undefined?delete process.env[key]:process.env[key]=value;await fs.rm(dir,{recursive:true,force:true})});
 const workspace=await fs.realpath(dir),key=sessionKey(workspace,'agent'),identity={instanceId:crypto.randomUUID(),epoch:crypto.randomUUID(),hostGeneration:crypto.randomUUID()};
 const store=new RecoveryStore(identity.instanceId),sessions={sessions:new Map(),handle:async()=>{throw new Error('Unexpected browser mutation')}};
 const broker=new NativeRecovery(identity,sessions,async()=>{}, {store});const meta={...identity,sessionKey:key,workspace,session:'agent'};
 const record={v:4,key,...identity,leaseId:crypto.randomUUID(),workspace,session:'agent',status:'interrupted',stage:'verify',outcome:'unknown',tabId:1};
 return {dir,workspace,key,identity,store,sessions,broker,meta,record};
}
test('connection grants fence expired/EOF holders without stealing live grants or confusing an automation lease',()=>{
 let now=0;const c=new RecoveryCoordinator({now:()=>now,budget:60,limit:2}),owner={},g=c.begin('a',owner);assert.throws(()=>c.begin('a',{}),{code:'SESSION_BUSY'});const peer=c.begin('b',{});assert.throws(()=>c.begin('c',{}),{code:'BRIDGE_BUSY'});
 assert.throws(()=>c.check(g,{},g.nonce),{code:'OPERATION_FENCED'});now=60;assert.throws(()=>c.check(g,owner,g.nonce),{code:'OPERATION_FENCED'});assert.throws(()=>c.begin('a',{}),{code:'SESSION_BUSY'});
 c.end(g);const successor=c.begin('a',owner);assert.throws(()=>c.check(g,owner,g.nonce),{code:'OPERATION_FENCED'});c.check(successor,owner,successor.nonce);c.end(g);assert.equal(c.grants.get('a'),successor);c.end(peer);c.end(successor);
});
test('atomic bounded schema-4 records preserve corrupt, partial, foreign and unknown state',async t=>{
 const f=await fixture(t),r=await f.store.write(f.key,f.record),file=recoveryPath(f.identity.instanceId,f.key);assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);assert.equal((await readRecovery(f.identity.instanceId,f.key)).revision,r.revision);
 await fs.writeFile(file+'.incomplete.tmp','{"v":');await fs.writeFile(file,'{"v":');await assert.rejects(f.store.read(f.key),{code:'RECOVERY_STATE_CORRUPT'});assert.equal(await fs.readFile(file,'utf8'),'{"v":');assert.equal(await fs.readFile(file+'.incomplete.tmp','utf8'),'{"v":');
 await fs.writeFile(file,JSON.stringify({...r,v:99}));await assert.rejects(f.store.read(f.key),{code:'RECOVERY_STATE_UNSUPPORTED'});
 await fs.unlink(file);await fs.symlink(file+'.incomplete.tmp',file);await assert.rejects(f.store.read(f.key),{code:'RECOVERY_STATE_UNSAFE'});await fs.unlink(file);
 await assert.rejects(f.store.write(f.key,{...f.record,stage:'x'.repeat(65536)}),{code:'RECOVERY_STATE_LARGE'});
});
test('reconciliation is read-only offline, guarded/idempotent online, and cannot erase a successor',async t=>{
 const f=await fixture(t);await f.store.write(f.key,f.record);const file=recoveryPath(f.identity.instanceId,f.key),before=await fs.readFile(file,'utf8');
 const offline=await recoveryInspection({instanceId:f.identity.instanceId,key:f.key,offlineError:{code:'BRIDGE_ACCESS_DENIED'}});assert.equal(offline.outcome,'unknown');assert.ok(offline.blockers.includes('BRIDGE_ACCESS_DENIED'));assert.equal(await fs.readFile(file,'utf8'),before);
 const plan=await f.broker.inspect(f.key);const owner={},g=await f.broker.begin(f.meta,owner);const send=(action,p={})=>f.broker.step(g,owner,{nonce:g.nonce,action,...p});
 await assert.rejects(send('apply',{expect:'0'.repeat(64)}),{code:'RECOVERY_PLAN_CHANGED'});assert.equal(await fs.readFile(file,'utf8'),before);
 assert.equal((await send('apply',{expect:plan.planToken})).reconciled,true);assert.equal((await send('apply',{expect:plan.planToken})).alreadyReconciled,true);await f.broker.finish(g);
 const successor=await f.store.write(f.key,{...f.record,leaseId:crypto.randomUUID(),status:'attached'});f.sessions.sessions.set(f.key,{leaseId:successor.leaseId,relay:{status:()=>({stopped:false})}});
 const g2=await f.broker.begin(f.meta,{});await assert.rejects(f.broker.step(g2,g2.owner,{nonce:g2.nonce,action:'apply',expect:plan.planToken}),{code:'RECOVERY_PLAN_CHANGED'});assert.equal((await f.store.read(f.key)).leaseId,successor.leaseId);assert.equal((await f.broker.inspect(f.key)).healthy,true);await f.broker.finish(g2);
});
test('operation EOF fences late commits while normal agent exit preserves healthy persistent leases',async t=>{
 const f=await fixture(t);const r=await f.store.write(f.key,{...f.record,status:'attached'});f.sessions.sessions.set(f.key,{leaseId:r.leaseId,relay:{status:()=>({stopped:false})}});
 const owner={},g=await f.broker.begin(f.meta,owner);g.active=false;await assert.rejects(f.broker.step(g,owner,{nonce:g.nonce,action:'commit'}),{code:'OPERATION_FENCED'});await f.broker.finish(g,{interrupted:true});assert.equal((await f.store.read(f.key)).status,'attached');assert.equal((await f.broker.inspect(f.key)).healthy,true);
 const g2=await f.broker.begin(f.meta,{});await f.broker.finish(g2);assert.equal((await f.store.read(f.key)).status,'attached');
});

test('daemon ownership detects a replaced task without treating normal socket retirement as replacement',async t=>{
 const f=await fixture(t),{daemonFile,daemonIdentity,assertDaemon}=await import('../src/daemon-identity.mjs'),{default:net}=await import('node:net');const previous=process.env.PWTEST_DAEMON_SESSION_DIR;process.env.PWTEST_DAEMON_SESSION_DIR=path.join(f.dir,'daemon');t.after(()=>{previous===undefined?delete process.env.PWTEST_DAEMON_SESSION_DIR:process.env.PWTEST_DAEMON_SESSION_DIR=previous});
 const file=daemonFile(f.workspace,'agent'),socketPath=path.join(f.dir,'cli.sock'),server=net.createServer();await new Promise(r=>server.listen(socketPath,r));t.after(()=>server.close());await fs.mkdir(path.dirname(file),{recursive:true});const config={name:'agent',workspaceDir:f.workspace,attached:true,version:'pinned-fixture',timestamp:194,socketPath};await fs.writeFile(file,JSON.stringify(config));
 const identity=await daemonIdentity(f.workspace,'agent'),record={...f.record,daemonFingerprint:identity.fingerprint,daemonSocketFingerprint:identity.socketFingerprint};assert.equal((await assertDaemon(record)).absent,false);await new Promise(r=>server.close(r));assert.equal((await assertDaemon(record)).absent,false);
 await fs.writeFile(file,JSON.stringify({...config,timestamp:195}));await assert.rejects(assertDaemon(record),{code:'DAEMON_IDENTITY_CHANGED'});
});

test('tombstone compaction cannot delete a same-key successor during a concurrent host write',async t=>{
 const f=await fixture(t);await f.store.write(f.key,{...f.record,status:'retired',updatedAt:0});
 for(let i=0;i<65;i++){const session='t'+i,key=sessionKey(f.workspace,session);await f.store.write(key,{...f.record,key,session,status:'retired',updatedAt:i+1})}
 const originalRead=f.store.read.bind(f.store);let release,seen;const barrier=new Promise(r=>release=r),reached=new Promise(r=>seen=r);let paused=false;
 f.store.read=async key=>{const record=await originalRead(key);if(key===f.key&&!paused){paused=true;seen();await barrier}return record};
 const trim=f.store.trim();await reached;const leaseId=crypto.randomUUID();let completed=false;const successor=f.store.write(f.key,{...f.record,leaseId,status:'attached'}).then(r=>{completed=true;return r});await new Promise(r=>setImmediate(r));assert.equal(completed,false);release();await trim;await successor;
 assert.equal((await originalRead(f.key)).leaseId,leaseId);const records=await fs.readdir(path.dirname(recoveryPath(f.identity.instanceId,f.key)));assert.equal(records.filter(n=>n.endsWith('.json')).length,65);
});

for(const action of ['verify','release'])test(`operation-owner loss during ${action} fences completion and retains scoped unknown state`,async t=>{
 const f=await fixture(t),record=await f.store.write(f.key,{...f.record,status:action==='verify'?'connecting':'attached'});let released=false,stopCount=0,reach,resume;const barrier=new Promise(r=>resume=r),reached=new Promise(r=>reach=r);
 const live={leaseId:record.leaseId,relay:{status:()=>({stopped:stopCount>0}),stop:async()=>{stopCount++}}};f.sessions.sessions.set(f.key,live);
 f.sessions.handle=async(op,p)=>{assert.equal(p.leaseId,record.leaseId);if(op===(action==='verify'?'native-verify':'native-release-tab')){reach();await barrier;return {targets:[],sessionClosed:true}}if(op==='native-disconnect'){released=true;f.sessions.sessions.delete(f.key);return {disconnected:true}}throw new Error('Unexpected operation '+op)};
 const owner={},g=await f.broker.begin(f.meta,owner);if(action==='verify')g.acquired=true;const completing=f.broker.step(g,owner,{nonce:g.nonce,action,tabId:1,expectedUrl:'https://fixture/'});await reached;f.broker.fence(g);await assert.rejects(f.broker.begin(f.meta,{}),{code:'SESSION_BUSY'});resume();await assert.rejects(completing,{code:'OPERATION_FENCED'});await f.broker.finish(g,{interrupted:true});assert.equal(released,true);assert.ok(stopCount>0);assert.equal((await f.store.read(f.key)).outcome,'unknown');assert.equal((await f.store.read(f.key)).status,'interrupted');
});

test('fresh-tab creation is journaled before Chrome mutation and interrupted creation is never replayed', async t => {
 const f=await fixture(t);f.identity.capabilities={createTab:1};let created=0,disconnected=0;
 f.broker.browser=async op=>{assert.equal(op,'native-create-tab');assert.equal((await f.store.read(f.key)).stage,'creating-tab');created++;throw Object.assign(new Error('Response lost'),{code:'BRIDGE_TIMEOUT'})};
 f.sessions.handle=async op=>{assert.equal(op,'native-disconnect');disconnected++;return {disconnected:true}};
 const owner={},g=await f.broker.begin(f.meta,owner),p={action:'open',nonce:g.nonce};
 await assert.rejects(f.broker.step(g,owner,p),{code:'BRIDGE_TIMEOUT'});
 await assert.rejects(f.broker.step(g,owner,p),{code:'SESSION_COLLISION'});
 assert.equal(created,1);await f.broker.finish(g,{interrupted:true});assert.equal(disconnected,1);
 const record=await f.store.read(f.key);assert.equal(record.status,'interrupted');assert.equal(record.outcome,'unknown');
});

test('rejected fresh-tab bootstrap releases its early reservation before retiring the journal', async t => {
 const f=await fixture(t);f.identity.capabilities={createTab:1};let disconnected=0;
 f.broker.browser=async op=>{assert.equal(op,'native-create-tab');return {tabId:77}};
 f.sessions.handle=async op=>{
  if(op==='native-connect')throw Object.assign(new Error('Tab navigated'),{code:'TAB_CHANGED',nativeCleanupConfirmed:true});
  assert.equal(op,'native-disconnect');disconnected++;return {disconnected:true};
 };
 const owner={},g=await f.broker.begin(f.meta,owner);
 await assert.rejects(f.broker.step(g,owner,{action:'open',nonce:g.nonce}),{code:'TAB_CHANGED'});
 assert.equal(disconnected,1);const record=await f.store.read(f.key);
 assert.equal(record.status,'retired');assert.equal(record.tabId,77);assert.equal(Object.hasOwn(record,'createdTabId'),false);assert.equal(record.cleanup,'confirmed');
 await f.broker.finish(g);
});

test('an older extension cannot start fresh-tab creation', async t=>{
 const f=await fixture(t),owner={},g=await f.broker.begin(f.meta,owner);
 await assert.rejects(f.broker.step(g,owner,{action:'open',nonce:g.nonce}),{code:'OPEN_UNSUPPORTED'});
 assert.equal(await f.store.read(f.key),null);await f.broker.finish(g);
});
