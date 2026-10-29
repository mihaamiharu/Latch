import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {performance} from 'node:perf_hooks';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {evidenceApp,MiB} from './fixtures/evidence-app.mjs';import {attachmentFixture} from './helpers/attachment-fixture.mjs';import {screenshot,snapshot} from './helpers/evidence-capture.mjs';
const exec=promisify(execFile),enabled=process.env.LATCH_EVIDENCE_PERFORMANCE==='1'&&process.platform==='darwin';
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
async function processes(f,daemonPIDs){
 const {stdout}=await exec('ps',['-ax','-o','pid=,ppid=,rss=,pcpu=,command=']);const rows=stdout.split('\n').map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],rssKiB:+m[3],cpu:+m[4],command:m[5]}}).filter(Boolean);
 const selected=new Set([f.browserPID,...daemonPIDs]);for(let changed=true;changed;){changed=false;for(const r of rows)if(selected.has(r.ppid)&&!selected.has(r.pid)){selected.add(r.pid);changed=true}}
 const owned=rows.filter(r=>selected.has(r.pid)&&(r.pid===f.browserPID||r.ppid!==1||r.command.includes('cliDaemon.js'))).map(({command,...r})=>r);
 return {rssBytes:owned.reduce((n,p)=>n+p.rssKiB*1024,0),cpuPercentSum:owned.reduce((n,p)=>n+p.cpu,0),processes:owned};
}
async function daemons(f){
 const pids=[];for(const dir of await fs.readdir(path.join(f.temp,'daemon')).catch(()=>[])){
  const log=path.join(f.temp,'daemon',dir,'agent.err');const result=await exec('lsof',['-t',log]).catch(()=>({stdout:''}));for(const pid of result.stdout.trim().split('\n'))if(/^\d+$/.test(pid))pids.push(Number(pid));
 }return [...new Set(pids)];
}
test('headless paired evidence performance and five-cycle resource cohort',{skip:!enabled,timeout:480000},async t=>{
 const app=await evidenceApp(),fixtures={};t.after(async()=>{for(const f of Object.values(fixtures))await f.close();await app.close()});
 for(const kind of ['official','native'])fixtures[kind]=await attachmentFixture(t,app,kind);
 const samples={official:[],native:[]},warm={},peaks={},last={},pidSets={official:new Set(),native:new Set()};let busy=false,sampleError;
 const sample=async()=>{if(busy)return;busy=true;try{for(const kind of ['official','native']){const p=await processes(fixtures[kind],[...pidSets[kind]]);last[kind]=p;peaks[kind]=Math.max(peaks[kind]||0,p.rssBytes)}}catch(e){sampleError=e}finally{busy=false}};
 const timer=setInterval(()=>void sample(),250);t.after(()=>clearInterval(timer));
 for(let round=0;round<6;round++)for(const kind of round%2?['native','official']:['official','native']){
  const f=fixtures[kind];const activeBeforeAttach=(await f.latch(0,['tabs'])).tabs.find(tab=>tab.tabId===f.tabs[0]).active;if(round>0)assert.equal(activeBeforeAttach,true,'Measured attach must start with the intended tab active');const start=performance.now();await f.connect(0,f.tabs[0]);const attachMs=performance.now()-start;
  const pids=await daemons(f);assert.ok(pids.length,'Exact private daemon stderr must identify its process');for(const pid of pids)pidSets[kind].add(pid);
  const focus=await f.pw(0,['run-code',"async(page)=>{await page.bringToFront();return await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus()}))}"]);const focusState=JSON.parse(focus.result);assert.deepEqual(focusState,{visibility:'visible',focused:true});
  const snap=await snapshot(f,0,64,256,`P-snapshot-${round}`),image=await screenshot(f,0,512,1024,`P-pixels-${round}`);
  const live=kind==='native'?await f.nativeStatus():undefined;assert.ok(!live||live.sessions.every(s=>s.pending===0&&!s.stopped));
  const stop=performance.now();await f.latch(0,['disconnect','--session','agent']);const disconnectMs=performance.now()-stop;
  assert.ok(kind!=='native'||(await f.nativeStatus()).sessions.length===0);assert.ok((await f.latch(0,['tabs'])).tabs.every(t=>t.owner===null));
  // Fixed observation interval from the approved plan, not a readiness substitute.
  await new Promise(r=>setTimeout(r,5000));await sample();const after=last[kind];
  if(round===0)warm[kind]=after;
  else samples[kind].push({round,attachMs,disconnectMs,snapshotMs:snap.elapsedMs,snapshotBytes:snap.bytes,screenshotMs:image.elapsedMs,screenshotBytes:image.bytes,screenshotSha256:image.sha256,activeBeforeAttach,focusState,after,liveNative:live?.sessions.map(({metrics,pending,stopped})=>({metrics,pending,stopped}))});
  // Hashes remain in the report; duplicate measured files need not accumulate.
  if(round>1)for(const file of [snap.path,image.path])await fs.unlink(file);
 }
 clearInterval(timer);if(sampleError)throw sampleError;
 const summary={};for(const kind of ['official','native']){
  const s=samples[kind];summary[kind]={operations:Object.fromEntries(['attachMs','snapshotMs','screenshotMs','disconnectMs'].map(key=>[key,{median:median(s.map(x=>x[key])),min:Math.min(...s.map(x=>x[key])),max:Math.max(...s.map(x=>x[key]))}])),warmRSS:warm[kind].rssBytes,finalRSS:s.at(-1).after.rssBytes,peakRSS:peaks[kind],growth:s.at(-1).after.rssBytes-warm[kind].rssBytes};
 }
 const concerns=[];for(const key of ['attachMs','snapshotMs','screenshotMs'])if(summary.native.operations[key].median>2*summary.official.operations[key].median)concerns.push(key+' native median above 2x');
 for(const kind of ['official','native'])if(summary[kind].growth>Math.max(64*MiB,summary[kind].warmRSS*.25))concerns.push(kind+' RSS growth threshold');
 const report={headless:true,confirmationReason:process.env.LATCH_PERFORMANCE_CONFIRMATION||'initial cohort',focusPolicy:'Warm-up activates each target. Every measured attach starts on its active target; evidence capture explicitly foregrounds it. Native focus emulation off.',cpu:os.cpus()[0].model,os:os.release(),versions:fixtures.official.versions,launchArgs:fixtures.native.launchArgs,samples,summary,concerns,measurement:'One warm-up and five pairs, alternating order; initialized browsers, fresh normal CLI sessions. RSS sum may double-count shared pages; CPU is ps lifetime percentage. Exact fixture browser descendants plus daemons identified from private stderr descriptors; no unrelated Chrome.',daemonPIDs:Object.fromEntries(Object.entries(pidSets).map(([k,v])=>[k,[...v]]))};
 for(const f of Object.values(fixtures))await fs.writeFile(path.join(f.evidence,'performance-report.json'),JSON.stringify(report,null,2));
 for(const f of Object.values(fixtures)){await f.close();console.log(`Performance evidence: ${f.evidence}`)}
 assert.deepEqual(concerns,[],'Investigate concerns and, if needed, run one confirmation cohort; do not discard samples');
});
