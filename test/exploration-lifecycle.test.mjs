import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runExploration,CAPTURE_SCRIPT} from '../src/exploration.mjs';
import {boundRun,loadMeta,runPath,lockRun} from '../src/exploration-storage.mjs';
import {LIMITS} from '../src/evidence-storage.mjs';
import {fault} from '../extension/protocol.js';
async function fixture(t,{videoError=false}={}){
 const workspace=await fs.realpath(await fs.mkdtemp('/tmp/latch-life-')),old={root:process.env.LATCH_ARTIFACT_ROOT,capture:process.env.LATCH_CAPTURE};process.env.LATCH_ARTIFACT_ROOT=path.join(workspace,'library');delete process.env.LATCH_CAPTURE;
 t.after(async()=>{for(const [k,v]of [['LATCH_ARTIFACT_ROOT',old.root],['LATCH_CAPTURE',old.capture]])v===undefined?delete process.env[k]:process.env[k]=v;await fs.rm(workspace,{recursive:true,force:true});});
 const calls=[];let video;
 const execute=async inv=>{
  calls.push(inv);
  if(inv.command==='open')return {connected:true,created:true,cliVersion:'0.1.20'};
  if(inv.command==='disconnect')return {disconnected:true,preservedUserTabs:true};
  const args=inv.playwrightArgs;
  if(args[0]==='video-start'){if(videoError)throw fault('VIDEO_MISSING_ENCODER','No encoder');video=args[1];await fs.writeFile(video,Buffer.concat([Buffer.from([26,69,223,163]),Buffer.alloc(200)]));return {result:'Video recording started.'};}
  if(args[0]==='video-stop')return {result:`- [Video](${video})`};
  if(args[0]==='run-code'&&args[1]===CAPTURE_SCRIPT)return {result:JSON.stringify({currentTargetId:'p',pages:[{targetId:'p',url:'https://fixture',title:'Fixture',snapshot:'- textbox "Email" [ref=e1]\n- button "Save" [ref=e2]',frames:[]}]})};
  return {result:''};
 };
 const invoke=(command,args=[],flags={})=>runExploration({command,flags:{workspace,session:'agent',profile:'work',...flags},playwrightArgs:args},'test',execute);
 return {workspace,calls,execute,invoke};
}
test('managed lifecycle records automatically and repeat finish is read-only/idempotent',async t=>{
 const f=await fixture(t);const start=await f.invoke('open',[],{url:'https://fixture',objective:'Explore'});assert.ok(start.library.runId);
 await f.invoke('pw',['fill','e1','private-input'],{'data-ref':'seeded-user'});await f.invoke('pw',['click','e2']);
 await assert.rejects(f.invoke('pw',['video-stop']),{code:'VIDEO_MANAGED'});
 const result=await f.invoke('finish');assert.equal(result.library.integrity,true);assert.equal(result.library.cleanup,'confirmed');assert.equal(result.library.video,'complete');
 const graph=JSON.parse(await fs.readFile(path.join(result.library.directory,'exploration.json')));assert.equal(graph.transitions.length,2);assert.equal(graph.transitions[0].action.data_reference,'seeded-user');assert.doesNotMatch(JSON.stringify(graph.transitions),/private-input/);assert.ok(graph.final_states.length);
 const count=f.calls.length;assert.equal((await f.invoke('finish')).alreadyFinished,true);assert.equal(f.calls.length,count);
});
test('an unavailable encoder preserves snapshots and cleanup and marks the video gap explicitly',async t=>{
 const f=await fixture(t,{videoError:true});const start=await f.invoke('open',[],{url:'https://fixture'});const result=await f.invoke('finish');assert.equal(result.library.cleanup,'confirmed');assert.equal(result.library.status,'partial');
 const m=await loadMeta(start.library.runId);assert.equal(m.video.status,'unavailable');assert.ok(m.states.length);assert.ok(m.gaps.some(g=>g.code==='VIDEO_MISSING_ENCODER'));assert.equal(f.calls.filter(i=>i.playwrightArgs?.[0]==='video-start').length,1);
});
test('recording limits stop new application actions while preserving finish capacity',async t=>{
 const f=await fixture(t);const start=await f.invoke('open',[],{url:'https://fixture'}),dir=await runPath(start.library.runId);
 const starts=Array.from({length:LIMITS.commands-4},(_,i)=>({schema:1,event:'started',runId:'unit',step:'step'+i,at:new Date().toISOString(),command:'click',kind:'operation',argumentCount:1,argumentSHA256:'a'.repeat(64)}));await fs.writeFile(path.join(dir,'commands.jsonl'),starts.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const count=f.calls.length;await assert.rejects(f.invoke('pw',['click','e2']),{code:'EXPLORATION_LIMIT'});assert.equal(f.calls.length,count);
});
test('disconnect revokes access despite a busy library writer and records an interruption marker',async t=>{
 const f=await fixture(t);const start=await f.invoke('open',[],{url:'https://fixture'});let release,entered;const ready=new Promise(r=>entered=r);const held=lockRun(start.library.runId,()=>{entered();return new Promise(r=>release=r)});await ready;
 const result=await f.invoke('disconnect');assert.equal(result.disconnected,true);assert.equal(result.library.status,'interrupted');assert.equal(await boundRun({workspace:f.workspace,session:'agent',profile:'work'}),null);
 const marker=JSON.parse(await fs.readFile(path.join(await runPath(start.library.runId),'stop-request.json')));assert.equal(marker.confirmed,true);release();await held;
});
