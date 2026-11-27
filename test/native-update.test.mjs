import {CANDIDATE_VERSION,CANDIDATE_KIT} from './helpers/candidate.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';import {evidenceApp} from './fixtures/evidence-app.mjs';import {command,eventually} from './helpers/native-browser.mjs';
import {verifyKit,hash} from '../src/release.mjs';
const baseline=process.env.LATCH_BASELINE_KIT,enabled=process.env.LATCH_NATIVE_UPGRADE==='1'&&process.platform==='darwin';
test('retained native release updates, rolls back and reactivates with pairing/auth intact and a minimal host PATH',
 {skip:!enabled||(!baseline&&'Set LATCH_BASELINE_KIT to the frozen RC3 kit.'),timeout:240000},async t=>{
  const old=await verifyKit(baseline);
  const retained={'0.2.0-rc.3':'a50ad773869e1519f83670f6648f09ed773e287601763837f1a0d7fbc654acdd',
    '0.2.0-rc.8':'c153486c0d3bdb83240375c9885e786f13f11d528f38a9edfaa66d8ad59cc862'};
  assert.ok(retained[old.version],'Only recorded frozen baselines are accepted.');
  assert.equal(hash(await fs.readFile(path.join(baseline,'release.json'))),retained[old.version]);
  const candidate=process.env.LATCH_CANDIDATE_KIT||CANDIDATE_KIT;
  const current=await verifyKit(candidate);assert.equal(current.version,CANDIDATE_VERSION);
  const candidateDescriptorSHA256=hash(await fs.readFile(path.join(candidate,'release.json')));
  const app=await evidenceApp();app.installed=true;app.artifactExtension=path.join(baseline,'extension');let f,options;
  const setup=async(kit,operation,extra=[],env)=>{
    const result=await command(process.execPath,[path.join(kit,'src/install.mjs'),operation,'--root',options.root,'--registration-root',options.registrationRoot,...(operation==='inspect'||operation==='activate'?['--kit',kit]:[]),...extra],{cwd:kit,env});
    const value=JSON.parse(result.out||result.err);assert.equal(result.code,0,JSON.stringify(value));return value;
  };
  const activate=async(kit,env)=>{const plan=await setup(kit,'inspect',[],env);await setup(kit,'activate',['--expect',plan.planToken,'--tasks-drained','--extension-unloaded'],env)};
  app.install=async({temp,profile,env})=>{app.installedRoot=path.join(temp,'installed runtime');options={root:app.installedRoot,registrationRoot:path.join(profile,'NativeMessagingHosts')};await fs.writeFile(env.LATCH_CONFIG,'{"v":1,"profiles":{}}');await activate(baseline,env)};
  t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,'native');const instance=f.identity.instanceId;
  const configuration=await fs.readFile(f.env.LATCH_CONFIG);
  await f.connect(0,f.tabs[0],{background:true});await f.pw(0,['run-code','async(page)=>page.evaluate(()=>localStorage.setItem("native-update-auth","retained"))']);await f.latch(0,['disconnect','--session','agent']);
  // The fixture stops Chrome with SIGTERM, and this checks retention of committed
  // state. Without Latch, Chrome 157 lost a value at 4s (0/5) and kept it from 6s
  // (5/5) after the write; graceful close kept it immediately (4/4). Chrome 147 kept it at 0s.
  await new Promise(resolve=>setTimeout(resolve,8000));
  const maintenance=async()=>{await f.fault('disable');await f.stop();await eventually(()=>fs.lstat(path.join(f.env.LATCH_RUNTIME_DIR,instance+'.sock')).then(()=>false,e=>e.code==='ENOENT'));app.seeds.delete(f.run)};
  const resumed=async(version)=>{
    await f.restartBrowser();await f.fault('disable');await eventually(()=>fs.lstat(path.join(f.env.LATCH_RUNTIME_DIR,instance+'.sock')).then(()=>false,e=>e.code==='ENOENT'));await f.fault('enable');await f.refreshIdentity();assert.equal(f.identity.instanceId,instance);assert.equal(f.identity.releaseVersion,version);
    const tabs=(await eventually(()=>app.seeds.get(f.run))).tabs;
    await f.latch(0,['connect','--session','agent','--focus-emulation','on','--tab',String(tabs[0])]);
    assert.deepEqual(valueOf(await f.pw(0,['run-code','async(page)=>({actor:await page.locator("#actor").innerText(),auth:await page.evaluate(()=>localStorage.getItem("native-update-auth"))})'])),{actor:f.run+':a',auth:'retained'});
    await f.latch(0,['disconnect','--session','agent']);assert.deepEqual(await fs.readFile(f.env.LATCH_CONFIG),configuration);
  };
  await maintenance();await activate(candidate,f.env);app.minimalHostPath=true;await resumed(CANDIDATE_VERSION);
  await maintenance();await setup(candidate,'rollback',['--tasks-drained','--extension-unloaded'],f.env);await resumed(old.version);
  await maintenance();await activate(candidate,f.env);await resumed(CANDIDATE_VERSION);
  await fs.writeFile(path.join(f.evidence,'native-update.json'),JSON.stringify({headless:true,versions:f.versions,launchArgs:f.launchArgs,baseline:old.version,candidate:CANDIDATE_VERSION,candidateDescriptorSHA256,nativeOnly:true,baselineEnvironment:'terminal PATH',candidateAndRollbackPATH:'/usr/bin:/bin',update:true,rollback:true,reactivation:true,stableInstance:true,configurationUnchanged:true,syntheticAuthRetained:true,physicalTabRetentionAcrossRestartsUnverified:true,humanPermissionAcceptanceUnverified:true},null,2));console.log('Native update: '+f.evidence);
 });
