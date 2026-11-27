import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {allocateRun,saveMeta,loadMeta,runPath,lockRun,verifyArtifacts,boundRun,indexArtifact} from '../src/exploration-storage.mjs';
import {addStates,writeHandoff,elementsOf,validateExploration,actionOf} from '../src/exploration-model.mjs';
import {libraryCommand,saveReview,startLibraryServer,exportRun} from '../src/exploration-library.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'latch-library-')),prior=process.env.LATCH_ARTIFACT_ROOT;process.env.LATCH_ARTIFACT_ROOT=path.join(root,'central artifacts');t.after(async()=>{prior===undefined?delete process.env.LATCH_ARTIFACT_ROOT:process.env.LATCH_ARTIFACT_ROOT=prior;await fs.rm(root,{recursive:true,force:true});});const meta=await allocateRun({workspace:root,session:'agent',profile:'work'},{objective:'Explore checkout'});return {root,meta,dir:await runPath(meta.id)};}
const snapshot='- heading "Checkout" [level=1] [ref=e1]\n- textbox "Email" [ref=e2]\n- button "Pay" [ref=e3]\n- button "Pay" [ref=e4]';
test('central runs are isolated by workspace and reject a second binding without mixing evidence',async t=>{
 const f=await fixture(t);await assert.rejects(allocateRun({workspace:f.root,session:'agent',profile:'work'}),{code:'EXPLORATION_BUSY'});
 const other=await allocateRun({workspace:f.root+'/other',session:'agent',profile:'work'});assert.notEqual(other.id,f.meta.id);assert.equal((await boundRun(f.meta)).id,f.meta.id);assert.equal((await libraryCommand('list',{})).runs.length,2);
});
test('handoff has observed locators, frame context, honest transitions and final YAML with verified hashes',async t=>{
 const {meta}=await fixture(t);const state=await addStates(meta,{currentTargetId:'page1',pages:[{targetId:'page1',url:'https://example.test',title:'Checkout',snapshot,frames:[]}]},{step:'initial'});
 assert.equal(state.elements.find(e=>e.snapshot_ref==='e3').ambiguous,true);
 const after=await addStates(meta,{currentTargetId:'page1',pages:[{targetId:'page1',url:'https://example.test/saved',title:'Saved',snapshot:'- status [ref=e5]: Saved',frames:[{id:'frame-1',url:'https://frame.test',snapshot:'- textbox "Code" [ref=e6]'}]}]},{final:true,step:'final'});
 actionOf(meta,{command:'pw',flags:{},playwrightArgs:['click','e3']},{step:'click',before:state,after,startedAt:new Date().toISOString()});meta.status='finished';await writeHandoff(meta);
 const source=await fs.readFile(path.join(await runPath(meta.id),'exploration.yaml'),'utf8');assert.match(source,/schema_version: 1/);assert.match(source,/strategy: "role"/);assert.match(source,/final-page1-frame-1.yaml/);assert.doesNotMatch(source,/await page/);
 assert.equal((await verifyArtifacts(await loadMeta(meta.id))).verified,true);
 await fs.appendFile(path.join(await runPath(meta.id),state.snapshot),'tampered');assert.equal((await verifyArtifacts(meta)).verified,false);
 await assert.rejects(exportRun(meta.id,path.join(meta.workspace,'export')),{code:'EVIDENCE_INTEGRITY_FAILED'});
});
test('QA review is separate and handoff export is self-contained and never merges destinations',async t=>{
 const f=await fixture(t);await addStates(f.meta,{currentTargetId:'p',pages:[{targetId:'p',url:'http://fixture',title:'Fixture',snapshot,frames:[]}]},{step:'capture',final:true});await writeHandoff(f.meta);
 await saveReview(f.meta.id,{decision:'automate',note:'Cover required fields'});assert.equal((await loadMeta(f.meta.id)).annotations.length,0);
 const out=path.join(f.root,'handoff');await exportRun(f.meta.id,out);assert.ok(await fs.stat(path.join(out,'exploration.yaml')));assert.equal(JSON.parse(await fs.readFile(path.join(out,'review.json'))).decision,'automate');await assert.rejects(exportRun(f.meta.id,out),{code:'EEXIST'});
});
test('schema rejects dangling transitions and symlinked artifacts fail verification',async t=>{
 const f=await fixture(t);assert.throws(()=>validateExploration({schema_version:1,run_id:'x',states:[],transitions:[{id:'a',from:'missing'}],final_states:[]}),{code:'EXPLORATION_SCHEMA_INVALID'});
 await fs.writeFile(path.join(f.root,'outside'),'private');try{await fs.symlink(path.join(f.root,'outside'),path.join(f.dir,'outside.yaml'));}catch(e){if(e.code==='EPERM')await fs.symlink(f.root,path.join(f.dir,'outside.yaml'),'junction');else throw e}f.meta.artifacts=[{path:'outside.yaml',type:'snapshot',bytes:7,sha256:'x'}];await saveMeta(f.meta);assert.equal((await verifyArtifacts(f.meta)).verified,false);
});
test('a busy library writer blocks offline repair without blocking a browser-independent review',async t=>{
 const f=await fixture(t);let release,entered;const ready=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);const held=lockRun(f.meta.id,()=>{entered();return barrier});await ready;await assert.rejects(libraryCommand('repair',{run:f.meta.id}),{code:'EXPLORATION_BUSY'});await saveReview(f.meta.id,{decision:'investigate'});release();await held;
});
test('local reviewer escapes page text, supports video byte ranges and rejects foreign review requests',async t=>{
 const f=await fixture(t);f.meta.objective='<img src=x onerror=alert(1)>';
 await addStates(f.meta,{currentTargetId:'p',pages:[{targetId:'p',url:'http://fixture',title:'Fixture',snapshot,frames:[]}]},{step:'capture'});await writeHandoff(f.meta);
 await fs.mkdir(path.join(f.dir,'videos'));const clip=Buffer.from([26,69,223,163,1,2,3,4,5,6]);await fs.writeFile(path.join(f.dir,'videos','range.webm'),clip);await indexArtifact(f.meta,'videos/range.webm','video');await saveMeta(f.meta);
 const app=await startLibraryServer();t.after(()=>app.close());const html=await(await fetch(app.url+'/run/'+f.meta.id)).text();assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);
 const range=await fetch(app.url+'/artifact/'+f.meta.id+'/videos/range.webm',{headers:{Range:'bytes=2-5'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),Buffer.from([223,163,1,2]));
 const denied=await fetch(app.url+'/review/'+f.meta.id,{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:JSON.stringify({decision:'automate'})});assert.equal(denied.status,403);
 const unsafe=await fetch(app.url+'/artifact/'+f.meta.id+'/..%2f..%2fconfig.json');assert.notEqual(unsafe.status,200);
});

test('offline recovery fences a dead process lock and reconstructs committed states without replaying actions',async t=>{
 const f=await fixture(t);const state=await addStates(f.meta,{currentTargetId:'p',pages:[{targetId:'p',url:'http://fixture',title:'Fixture',snapshot,frames:[]}]},{step:'capture'});
 // The process died after writing an observed state and a completed tool event,
 // before updating its summary. The raw files remain authoritative.
 const stale={...f.meta,states:[],artifacts:[],pending:{step:'click',command:'click',from:state.id,action:{type:'click',values_stored:false}}};await saveMeta(stale);
 await fs.writeFile(path.join(f.dir,'commands.jsonl'),JSON.stringify({event:'finished',step:'click',operation:{outcome:'succeeded'}})+'\n');
 const root=process.env.LATCH_ARTIFACT_ROOT,lock=path.join(root,'locks',f.meta.id);await fs.mkdir(lock);
 await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:2147483647,identity:'old process',nonce:'11111111-1111-4111-8111-111111111111'}));
 const result=await libraryCommand('repair',{run:f.meta.id});assert.equal(result.replayedActions,0);
 const restored=await loadMeta(f.meta.id);assert.equal(restored.states.length,1);assert.equal(restored.actions[0].outcome,'succeeded');assert.equal(restored.actions[0].to,null);assert.equal(restored.status,'interrupted');assert.equal(restored.finals.length,0);
 assert.ok(await fs.stat(path.join(root,'lock-audit',f.meta.id+'-11111111-1111-4111-8111-111111111111')));
});
