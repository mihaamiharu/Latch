import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {evidenceApp,MiB} from './fixtures/evidence-app.mjs';import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';import {eventually} from './helpers/native-browser.mjs';import {sessionKey} from '../src/playwright.mjs';import {captureCLI,responseBody,screenshot} from './helpers/evidence-capture.mjs';
import {nativeHostPID,tcpResources} from './helpers/evidence-resources.mjs';
const enabled=process.env.LATCH_EVIDENCE_ISOLATION==='1'&&process.platform==='darwin';
test('headless native evidence failures preserve peer ownership and settle resources',{skip:!enabled,timeout:300000},async t=>{
 const app=await evidenceApp();let f;t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,'native');
 await Promise.all([f.connect(0,f.tabs[0],{background:true}),f.connect(1,f.tabs[1],{background:true})]);const results=[],run=async(i,code)=>valueOf(await f.pw(i,['run-code',code]));
 const status=async()=>{const s=await f.nativeStatus();return s.sessions.find(s=>s.key===sessionKey(f.workspaces[0],'agent'))};
 const peer=async label=>{assert.equal(await run(1,'async(page)=>await page.evaluate(()=>evidence.actor)'),f.run+':b');const body=await responseBody(f,app,1,'binary',1024,'peer-'+label);assert.equal(body.actor,f.run+':b');return body.sha256};
 // One browser fetch gates 64 debugger awaits without monopolizing the shared HTTP connection pool.
 const gate='pending';const pending=captureCLI(f,0,['run-code',`async(page)=>{await page.evaluate(()=>{window.LATCH_GATE=fetch('/gate?op=${gate}').then(()=>1)});const c=await page.context().newCDPSession(page);try{const results=await Promise.all(Array.from({length:65},()=>c.send('Runtime.evaluate',{expression:'window.LATCH_GATE',awaitPromise:true,returnByValue:true}).then(()=>({ok:true}),e=>({ok:false,error:e.message}))));return results}finally{await c.detach()}}`],{name:'pending-65',fail:true}).then(r=>r);
 await eventually(async()=> (await status())?.pending===64);const pendingPeer=await peer('pending');app.openGate(gate);
 const accepted=valueOf((await pending).response);assert.equal(accepted.filter(r=>r.ok).length,64);assert.equal(accepted.filter(r=>!r.ok&&/Too many pending/.test(r.error)).length,1);
 assert.equal((await status()).pending,0);results.push({case:'Q1/I1 real pending boundary',peerHash:pendingPeer,status:await status()});
 const burst=await run(0,"async(page)=>{const logs=[],requests=[];const log=m=>{if(m.text().startsWith('LATCH-EVENT:'))logs.push(m.text())};const request=r=>{if(r.url().includes('/event?'))requests.push(r.url())};page.on('console',log);page.on('request',request);try{await page.evaluate(()=>evidence.burst('burst'));return {logs:logs.length,unique:new Set(logs).size,requests:requests.length}}finally{page.off('console',log);page.off('request',request)}}");
 assert.deepEqual(burst,{logs:512,unique:512,requests:64});assert.equal(app.receipts.filter(r=>r.operation==='burst'&&r.event!==undefined).length,64);
 const consoleOutput=await f.pw(0,['console']);const retained=(JSON.stringify(consoleOutput).match(/LATCH-EVENT:/g)||[]).length;assert.ok(retained>0&&retained<=200);assert.ok(JSON.stringify(consoleOutput).includes(':511'));
 await fs.writeFile(path.join(f.evidence,'console-history.json'),JSON.stringify(consoleOutput,null,2));
 results.push({case:'Q3 event burst',...burst,cliRetained:retained,cliHistoryPolicy:'Pinned Page console cache is capped at 200 messages; this is a partial history, not the complete burst',peerHash:await peer('burst')});
 for(const failure of ['oversize','timeout']){
  const code=failure==='oversize'?`async(page)=>await page.evaluate(()=> 'x'.repeat(33*1024*1024))`:`async(page)=>await page.evaluate(()=>new Promise(()=>{}))`;
  const failing=captureCLI(f,0,['run-code',code],{name:failure,fail:true});await eventually(async()=> (await status())?.pending>0);
  const peerHash=await peer(failure);const failed=await failing;await fs.writeFile(path.join(f.evidence,failure+'-status.json'),JSON.stringify(await f.nativeStatus(),null,2));assert.equal(failed.response.isError,true);
  await eventually(async()=> (await status())?.stopped);const summary=await status();assert.equal(summary.pending,0);assert.equal(summary.reason,failure==='oversize'?'WIRE_MESSAGE_TOO_LARGE':'command-timeout');
  await eventually(async()=> (await f.latch(1,['tabs'])).tabs.find(tab=>tab.tabId===f.tabs[0])?.owner===null);
  assert.equal((await f.latch(1,['tabs'])).tabs.find(tab=>tab.tabId===f.tabs[1]).owner,sessionKey(f.workspaces[1],'agent'));
  results.push({case:'I1 '+failure,peerHash,error:failed.response.error,elapsedMs:failed.elapsedMs,status:summary});
  await f.latch(0,['disconnect','--session','agent']);await f.connect(0,f.tabs[0],{background:true});
 }
 const holding=captureCLI(f,0,['run-code',"async(page)=>await Promise.all(Array.from({length:4},()=>page.evaluate(()=>new Promise(()=>{}))))"],{name:'disconnect-pending',fail:true});
 await eventually(async()=> (await status())?.pending===4);const peerHash=await peer('disconnect');await f.latch(0,['disconnect','--session','agent']);assert.equal((await holding).response.isError,true);
 assert.ok(!(await f.nativeStatus()).sessions.some(s=>s.key===sessionKey(f.workspaces[0],'agent')));
 await screenshot(f,1,64,64,'peer-survives');await f.latch(1,['disconnect','--session','agent']);const tabs=(await f.latch(1,['tabs'])).tabs;assert.ok(f.tabs.every(id=>tabs.some(t=>t.tabId===id&&t.owner===null)));
 results.push({case:'I2 disconnect pending',peerHash,cleanupPreservedTabs:true});
 const hostPID=await nativeHostPID(f.browserPID),resourceCycles=[];
 for(let n=0;n<5;n++){await f.connect(0,f.tabs[0],{background:true});const live=await status();assert.equal(live.pending,0);assert.equal(live.resources.clients,2);assert.equal(live.resources.listening,true);const active=await tcpResources(hostPID);assert.equal(active.listeners,1);await f.latch(0,['disconnect','--session','agent']);assert.equal((await f.nativeStatus()).sessions.length,0);const after=await tcpResources(hostPID);assert.deepEqual(after,{tcpSockets:0,listeners:0});resourceCycles.push({cycle:n+1,active,after})}
 results.push({case:'P2 five-cycle TCP/listener audit',hostPID,resourceCycles});
 await fs.writeFile(path.join(f.evidence,'isolation-report.json'),JSON.stringify({headless:true,versions:f.versions,launchArgs:f.launchArgs,results,slowConsumerCoverage:'Real paused WebSocket readers and peer relays in the protocol suite; real-browser peers tested here for pending, oversize, timeout and disconnect'},null,2));
 await f.close();console.log(`Evidence isolation: ${f.evidence}`);
});
