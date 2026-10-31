import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {selectTransport} from '../src/transport.mjs';
import {command} from './helpers/native-browser.mjs';
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;

test('transport precedence preserves recorded adapters, retired cleanup and explicit overrides',()=>{
 const choose=options=>selectTransport({command:'connect',...options});
 assert.equal(choose({}).transport,'official');
 assert.equal(choose({profile:{defaultTransport:'native'}}).transportSource,'profile-default');
 assert.equal(choose({profile:{defaultTransport:'native'},legacy:{}}).transport,'official');
 assert.equal(choose({profile:{defaultTransport:'official'},nativeRecord:{status:'attached'}}).transport,'native');
 assert.equal(choose({profile:{defaultTransport:'official'},nativeRecord:{status:'retired'}}).transport,'official');
 assert.equal(choose({profile:{defaultTransport:'official'},nativeRecord:{status:'retired'},command:'disconnect'}).transport,'native');
 assert.equal(choose({explicit:'official',profile:{defaultTransport:'native'}}).transportSource,'explicit');
 assert.throws(()=>choose({profile:{defaultTransport:'future'}}),{code:'INVALID_TRANSPORT_DEFAULT'});
 assert.throws(()=>choose({legacy:{transport:'future'}}),{code:'SESSION_STATE_UNSUPPORTED'});
 assert.throws(()=>choose({legacy:{},nativeRecord:{status:'interrupted'}}),{code:'SESSION_STATE_CONFLICT'});
});
async function fixture(t){
 const dir=await fs.mkdtemp('/tmp/latch-pref-'),instanceId=crypto.randomUUID(),epoch=crypto.randomUUID(),runtime=path.join(dir,'r'),config=path.join(dir,'config.json');await fs.mkdir(runtime);
 const profiles={work:{instanceId,chromeProfileDir:'Default'},other:{instanceId:crypto.randomUUID(),chromeProfileDir:'Profile 1',defaultTransport:'official'}};await fs.writeFile(config,JSON.stringify({v:1,profiles,keep:'preserved'}));
 let cap={nativeTransport:true,nativeSessionSchema:4,recoveryContract:1},ready=true;
 const calls=[],server=net.createServer(socket=>{let body='';socket.on('data',b=>{body+=b;if(!body.includes('\n'))return;const m=JSON.parse(body);calls.push(m.op);const result=m.op==='status'?{instanceId,epoch,capabilities:cap,readiness:{verified:ready},sessions:[]}:m.op==='tabs'?[]:{};socket.end(JSON.stringify({v:1,id:m.id,ok:true,result})+'\n')})});await new Promise(r=>server.listen(path.join(runtime,instanceId+'.sock'),r));
 t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})});
 const env={...process.env,QA_BROWSER_CONFIG:config,QA_BROWSER_RUNTIME_DIR:runtime};const run=async(args,fail=false)=>{const result=await command(process.execPath,[cli,...args],{cwd:dir,env});const data=JSON.parse(result.out||result.err);assert.equal(result.code,fail?1:0,JSON.stringify(data));return data};
 return {dir,instanceId,epoch,runtime,config,profiles,calls,run,env,setCap:value=>cap=value,setReady:value=>ready=value};
}
test('profile setter is scoped/idempotent, validates capability, preserves pairing and permits offline official rollback',async t=>{
 const f=await fixture(t);assert.equal((await f.run(['transport'])).defaultTransport,'official');assert.deepEqual(f.calls,[]);
 const first=await f.run(['transport','--set','native']);assert.equal(first.updated,true);assert.equal(first.existingSessionsUnchanged,true);assert.equal((await f.run(['transport','--set','native'])).updated,false);
 const config=JSON.parse(await fs.readFile(f.config));assert.deepEqual(config.profiles.other,f.profiles.other);assert.equal(config.keep,'preserved');
 await f.run(['pair','--instance',f.instanceId,'--chrome-profile-dir','Default']);assert.equal(JSON.parse(await fs.readFile(f.config)).profiles.work.defaultTransport,'native');
 f.setCap({nativeTransport:false});const bytes=await fs.readFile(f.config,'utf8');assert.equal((await f.run(['transport','--set','native'],true)).error.code,'NATIVE_TRANSPORT_UNAVAILABLE');assert.equal(await fs.readFile(f.config,'utf8'),bytes);
 assert.equal((await f.run(['doctor'])).healthy,false);assert.equal((await f.run(['doctor'])).transport,'native');
 const fake=path.join(f.dir,'must-not-run');await fs.writeFile(fake,'#!/bin/sh\nexit 99\n',{mode:0o700});f.env.QA_BROWSER_PLAYWRIGHT_CLI=fake;
 assert.equal((await f.run(['connect','--session','fresh','--tab','1'],true)).error.code,'NATIVE_TRANSPORT_UNAVAILABLE');
 await fs.unlink(path.join(f.runtime,f.instanceId+'.sock'));await f.run(['transport','--set','official']);assert.equal((await f.run(['transport'])).defaultTransport,'official');
});
test('configuration gates and unknown records are preserved rather than reclaimed',async t=>{
 const f=await fixture(t);const gate=f.config+'.lock';await fs.mkdir(gate);await fs.writeFile(path.join(gate,'owner.json'),'{"pid":1}');const before=await fs.readFile(f.config,'utf8');assert.equal((await f.run(['transport','--set','official'],true)).error.code,'CONFIG_BUSY');assert.equal(await fs.readFile(f.config,'utf8'),before);assert.equal(await fs.readFile(path.join(gate,'owner.json'),'utf8'),'{"pid":1}');
 const session='old',key=crypto.createHash('sha256').update(JSON.stringify([await fs.realpath(f.dir),session])).digest('hex');await fs.writeFile(path.join(f.runtime,key+'.session.json'),JSON.stringify({transport:'future',instanceId:f.instanceId,epoch:f.epoch}));assert.equal((await f.run(['connect','--session',session,'--tab','1'],true)).error.code,'SESSION_STATE_UNSUPPORTED');
});
test('native setup refuses an unverified controller even when the host advertises schema 4',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.config);f.setReady(false);
 assert.equal((await f.run(['transport','--set','native'],true)).error.code,'NATIVE_TRANSPORT_UNAVAILABLE');assert.deepEqual(await fs.readFile(f.config),before);
 const health=await f.run(['diagnose']);assert.equal(health.healthy,false);assert.equal(health.layers.host,'reachable');assert.equal(health.layers.controller,'unverified');
});

test('legacy sessions retain official transport after a native default and explicit switching is rejected',async t=>{
 const f=await fixture(t);await f.run(['transport','--set','native']);const session='legacy',key=crypto.createHash('sha256').update(JSON.stringify([await fs.realpath(f.dir),session])).digest('hex');const state={v:2,transport:'official',instanceId:f.instanceId,epoch:f.epoch,sessionKey:key,session,workspace:await fs.realpath(f.dir)};await fs.writeFile(path.join(f.runtime,key+'.session.json'),JSON.stringify(state));const result=await f.run(['release','--session',session,'--tab','1']);assert.equal(result.transport,'official');assert.equal(result.transportSource,'session');assert.ok(f.calls.includes('release'));assert.ok(!f.calls.some(s=>s.startsWith('native-')));assert.equal((await f.run(['release','--transport','native','--session',session,'--tab','1'],true)).error.code,'TRANSPORT_MISMATCH');assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.runtime,key+'.session.json'))),state);
});
