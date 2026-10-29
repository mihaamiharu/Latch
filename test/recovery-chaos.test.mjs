import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';import {evidenceApp,hash} from './fixtures/evidence-app.mjs';import {nativeHostPID,tcpResources} from './helpers/evidence-resources.mjs';import {eventually} from './helpers/native-browser.mjs';
const enabled=process.env.LATCH_RECOVERY_CHAOS==='1'&&process.platform==='darwin';
test('twenty bounded real fault cycles with two agents and an untouched outsider',{skip:!enabled,timeout:360000},async t=>{
 const app=await evidenceApp();app.recovery=true;let f;t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,'native');const cycles=[];const artifact=path.join(f.evidence,'retained-evidence.txt');await fs.writeFile(artifact,'completed fixture evidence');const sha256=hash(await fs.readFile(artifact));
 const inspect=i=>f.latch(i,['reconcile','--session','agent']);
 for(let n=0;n<20;n++){
  await f.connect(0,f.tabs[0]);await f.connect(1,f.tabs[1],{background:true});const before=await f.fault('status');const fault=['SIGKILL','terminate','detach-native','SIGTERM','reload'][n%5];
  if(fault==='detach-native')await f.fault(fault,{tabId:f.tabs[0]});else if(fault.startsWith('SIG'))process.kill(await nativeHostPID(f.browserPID),fault);else{const result=await f.fault(fault);if(fault==='terminate')assert.equal(result.closeResult.success,true)}
  if(fault!=='detach-native'){await eventually(async()=>{const s=await f.fault('status');return s.connected&&s.hostGeneration!==before.hostGeneration},20000);await f.refreshIdentity()}
  else{await eventually(async()=>(await inspect(0)).status==='interrupted');const peer=valueOf(await f.pw(1,['run-code','async(page)=>page.locator("#actor").innerText()']));assert.equal(peer,f.run+':b')}
  const affected=fault==='detach-native'?[0]:[0,1];for(const i of affected){const plan=await inspect(i);assert.equal(plan.outcome,'unknown');await f.latch(i,['reconcile','--session','agent','--apply','--expect',plan.planToken])}
  const tabs=(await f.latch(0,['tabs'])).tabs;assert.ok(f.tabs.every(id=>tabs.some(t=>t.tabId===id)));assert.equal(tabs.find(t=>t.tabId===f.tabs[2]).owner,null);const resources=await tcpResources(await nativeHostPID(f.browserPID));assert.equal(resources.listeners,fault==='detach-native'?1:0);assert.equal(hash(await fs.readFile(artifact)),sha256);cycles.push({cycle:n+1,fault,affectedAgents:affected,resources,evidenceHash:sha256});
  console.log('Recovery cycle '+(n+1)+'/20: '+fault);
 }
 for(let i=0;i<2;i++)await f.latch(i,['disconnect','--session','agent']);await eventually(async()=>(await tcpResources(await nativeHostPID(f.browserPID))).tcpSockets===0);assert.equal((await f.nativeStatus()).sessions.length,0);
 await fs.writeFile(path.join(f.evidence,'recovery-chaos.json'),JSON.stringify({headless:true,launchArgs:f.launchArgs,versions:f.versions,cycles,finalResources:await tcpResources(await nativeHostPID(f.browserPID)),outsiderClaimed:false,artifactHash:sha256},null,2));console.log('Recovery chaos: '+f.evidence);
});
