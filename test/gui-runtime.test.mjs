import {CANDIDATE_VERSION,CANDIDATE_KIT} from './helpers/candidate.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';import {evidenceApp} from './fixtures/evidence-app.mjs';
import {eventually,command} from './helpers/native-browser.mjs';import {nativeHostPID} from './helpers/evidence-resources.mjs';
import {installCommand, doctorCommand} from '../src/setup.mjs';import {ROOT} from '../src/release.mjs';import {sessionKey} from '../src/redact.mjs';
const enabled=process.env.LATCH_GUI_RUNTIME==='1'&&process.platform==='darwin';
async function envOf(env,fn){const names=['LATCH_CONFIG','LATCH_RUNTIME_DIR','PWTEST_DAEMON_SESSION_DIR'],before=Object.fromEntries(names.map(n=>[n,process.env[n]]));for(const n of names)process.env[n]=env[n];try{return await fn()}finally{for(const n of names)before[n]===undefined?delete process.env[n]:process.env[n]=before[n]}}
test('installed native host with minimal PATH performs disconnect, popup Stop and exact recovery without ambient CLI or action replay',{skip:!enabled,timeout:180000},async t=>{
 const app=await evidenceApp();app.installed=true;app.popup=true;app.minimalHostPath=true;app.artifactExtension=path.join(ROOT,'dist/latch');let f,options;
 app.install=async({temp,profile,env})=>{app.installedRoot=path.join(temp,'installed runtime');options={kit:CANDIDATE_KIT,root:app.installedRoot,registrationRoot:path.join(profile,'NativeMessagingHosts'),skipSkills:true};await fs.writeFile(env.LATCH_CONFIG,'{"v":1,"profiles":{}}');await envOf(env,async()=>{await installCommand(options)})};
 t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,'native');
 const config=await fs.readFile(f.env.LATCH_CONFIG),cli=path.join(app.installedRoot,'bin/latch'),receipt=JSON.parse(await fs.readFile(path.join(app.installedRoot,'receipt.json')));
 assert.ok(path.isAbsolute(receipt.playwrightCLI));assert.equal(receipt.version,CANDIDATE_VERSION);
 await f.connect(0,f.tabs[0],{background:true});await f.connect(1,f.tabs[1],{background:true});
 assert.equal((await f.latch(0,['disconnect','--session','agent'])).disconnected,true);assert.equal(valueOf(await f.pw(1,['run-code','async(page)=>page.locator("#actor").innerText()'])),f.run+':b');
 await f.connect(0,f.tabs[0],{background:true});const directory=path.join(f.workspaces[0],'work/latch/gui-stop');
 const holding=command(cli,['pw','--workspace',f.workspaces[0],'--session','agent','--evidence-dir',directory,'--step','held','--','run-code','async(page)=>page.evaluate(async()=>{await fetch("/event?op=gui-stop&n=1");return new Promise(()=>{})})'],{cwd:f.workspaces[0],env:f.env});
 await eventually(()=>app.receipts.some(r=>r.operation==='gui-stop'));
 const key=sessionKey(f.workspaces[0],'agent'),view=await f.fault('popup',{expression:`(async()=>{const poll=async fn=>{const end=Date.now()+8000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Popup test timed out')};await poll(()=>document.querySelector('[data-key="${key}"] button.stop'));document.querySelector('[data-key="${key}"] button.stop').click();await poll(()=>document.querySelector('#notice').textContent.includes('Session stopped'));return document.body.innerText})()`});
 assert.match(view.value,/Session stopped/);assert.equal((await holding).code,1);await f.latch(0,['disconnect','--session','agent','--evidence-dir',directory,'--step','cleanup']);
 const report=JSON.parse(await fs.readFile(path.join(directory,'result.json')));assert.equal(report.cleanup.status,'confirmed');assert.equal(report.checks.find(c=>c.id==='held').operation.outcome,'unknown');
 assert.equal(valueOf(await f.pw(1,['run-code','async(page)=>page.locator("#actor").innerText()'])),f.run+':b');
 await f.connect(0,f.tabs[0],{background:true});await f.pw(0,['run-code','async(page)=>page.evaluate(()=>localStorage.setItem("gui-fixture-auth","retained"))']);
 const pending=f.pw(0,['run-code','async(page)=>page.evaluate(async()=>{await fetch("/event?op=gui-recovery&n=1");return new Promise(()=>{})})'],{fail:true});await eventually(()=>app.receipts.some(r=>r.operation==='gui-recovery'));
 const generation=f.identity.hostGeneration;process.kill(await nativeHostPID(f.browserPID,path.join(app.installedRoot,'boot.mjs')),'SIGKILL');await pending;await f.refreshIdentity();assert.notEqual(f.identity.hostGeneration,generation);
 for(let i=0;i<2;i++){const plan=await f.latch(i,['reconcile','--session','agent']);assert.equal(plan.outcome,'unknown');assert.equal((await f.latch(i,['reconcile','--session','agent','--apply','--expect',plan.planToken])).reconciled,true)}
 await f.connect(0,f.tabs[0],{background:true});assert.deepEqual(valueOf(await f.pw(0,['run-code','async(page)=>({actor:await page.locator("#actor").innerText(),auth:await page.evaluate(()=>localStorage.getItem("gui-fixture-auth"))})'])),{actor:f.run+':a',auth:'retained'});
 await f.latch(0,['disconnect','--session','agent']);const tabs=(await f.latch(0,['tabs'])).tabs;assert.ok(f.tabs.every(id=>tabs.some(t=>t.tabId===id&&t.owner===null)));
 assert.equal(app.receipts.filter(r=>r.operation==='gui-stop').length,1);assert.equal(app.receipts.filter(r=>r.operation==='gui-recovery').length,1);assert.deepEqual(await fs.readFile(f.env.LATCH_CONFIG),config);
 await envOf(f.env,async()=>assert.equal((await doctorCommand(options)).healthy,true));
 await fs.writeFile(path.join(f.evidence,'gui-runtime.json'),JSON.stringify({headless:true,versions:f.versions,launchArgs:f.launchArgs,browserPATH:'/usr/bin:/bin',ambientCLIOverrideAbsent:true,cliAndNodePinned:true,installedArtifactUnmodified:true,normalDisconnect:true,popupStopCleanupConfirmed:true,peerPreservedUntilHostFault:true,hostSIGKILL:true,exactReconciliation:true,unknownOutcomesPreserved:true,fixtureAuthRetained:true,tabsPreserved:true,mutationReceipts:{stop:1,recovery:1},pairingUnchanged:true,humanPermissionAcceptanceUnverified:true},null,2));console.log('GUI runtime: '+f.evidence);
});
