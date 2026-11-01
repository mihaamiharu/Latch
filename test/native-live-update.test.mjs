import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {CANDIDATE_VERSION,CANDIDATE_KIT} from './helpers/candidate.mjs';import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';import {command,eventually,chromePath} from './helpers/native-browser.mjs';import {verifyKit,hash} from '../src/release.mjs';
const enabled=process.env.LATCH_NATIVE_LIVE_UPDATE==='1'&&process.platform==='darwin',baseline=process.env.LATCH_BASELINE_KIT;
test('disabled native extension updates in a running headless browser without losing identity, tabs or unsaved fixture state',
 {skip:!enabled||(!baseline&&'Set LATCH_BASELINE_KIT to the frozen RC3 kit.'),timeout:150000},async t=>{
  await verifyKit(baseline);assert.equal(hash(await fs.readFile(path.join(baseline,'release.json'))),'a50ad773869e1519f83670f6648f09ed773e287601763837f1a0d7fbc654acdd');
  const candidate=process.env.LATCH_CANDIDATE_KIT||CANDIDATE_KIT,descriptor=await verifyKit(candidate);assert.equal(descriptor.version,CANDIDATE_VERSION);
  const app=await evidenceApp();app.installed=true;app.popup=true;app.artifactExtension=path.join(baseline,'extension');let f,options,setupLaunchArgs;
  const setup=async(kit,op,extra=[],env)=>{const r=await command(process.execPath,[path.join(kit,'src/install.mjs'),op,'--kit',kit,'--root',options.root,'--registration-root',options.registrationRoot,...extra],{cwd:kit,env});const v=JSON.parse(r.out||r.err);assert.equal(r.code,0,JSON.stringify(v));return v};
  const activate=async(kit,env)=>{const plan=await setup(kit,'inspect',[],env);return setup(kit,'activate',['--expect',plan.planToken,'--tasks-drained','--extension-unloaded'],env)};
  app.install=async({temp,profile,env})=>{
   app.installedRoot=path.join(temp,'installed runtime');options={root:app.installedRoot,registrationRoot:path.join(profile,'NativeMessagingHosts')};
   // Prepare only this disposable profile through Chrome's own settings API.
   // Seeding the UI preference alone does not establish reload authorization.
   const which=await command('which',['playwright-cli']),executable=await fs.realpath(which.out.trim());
   const {chromium}=await import(pathToFileURL(path.join(path.dirname(executable),'node_modules/playwright-core/index.mjs')).href);
   const setupBrowser=await chromium.launchPersistentContext(profile,{executablePath:await chromePath(),channel:'chromium',headless:true,args:['--use-mock-keychain','--password-store=basic','--enable-automation']});
   try{const cdp=await setupBrowser.browser().newBrowserCDPSession();setupLaunchArgs=(await cdp.send('Browser.getBrowserCommandLine')).arguments.slice(1);const page=await setupBrowser.newPage();await page.goto('chrome://extensions/');const configured=await page.evaluate(async()=>{await chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});return (await chrome.developerPrivate.getProfileConfiguration()).inDeveloperMode});assert.equal(configured,true)}finally{await setupBrowser.close()}
   await fs.writeFile(env.QA_BROWSER_CONFIG,'{"v":1,"profiles":{}}');await activate(baseline,env);
  };
  t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,'native');const before=f.identity,configuration=await fs.readFile(f.env.QA_BROWSER_CONFIG),browserPID=f.browserPID;
  await f.connect(0,f.tabs[0],{background:true});await f.pw(0,['run-code','async(page)=>{await page.locator("#value").fill("unsaved-live-update");await page.evaluate(()=>{window.latchHeap="retained";localStorage.setItem("latch-live-auth","retained")})}']);await f.latch(0,['disconnect','--session','agent']);
  const tabsBefore=(await f.latch(0,['tabs'])).tabs.map(({tabId,windowId,groupId,url})=>({tabId,windowId,groupId,url}));
  await f.fault('disable');await eventually(()=>fs.lstat(path.join(f.env.QA_BROWSER_RUNTIME_DIR,before.instanceId+'.sock')).then(()=>false,e=>e.code==='ENOENT'));
  await activate(candidate,f.env);const enabledInfo=await f.fault('enable');
  const discover=async()=>{const profiles=(await f.latch(0,['discover'])).profiles;return profiles.find(p=>p.extensionId===f.extensionId)};
  const afterEnable=await eventually(discover,20000);
  // Host release metadata is independent of Chrome's cached extension manifest.
  // Re-enabling alone may run old metadata with the newly selected host. Reload
  // the disposable extension explicitly, then require its own observed version.
  await f.fault('popup',{expression:'(setTimeout(()=>chrome.runtime.reload(),100), "fixture reload scheduled")'});
  let live;try{live=await eventually(async()=>{const p=await discover();return p?.extensionVersion===descriptor.chromeVersion&&p},20000)}catch(error){await fs.writeFile(path.join(f.evidence,'native-live-update-failure.json'),JSON.stringify({headless:true,setupLaunchArgs,afterEnable,extensionInfo:await f.fault('extension-info'),lastDiscovery:await discover(),error:error.message},null,2)+'\n');throw error}
  const settledInfo=await f.fault('extension-info');
  const result={headless:true,versions:f.versions,launchArgs:f.launchArgs,setupLaunchArgs,testProfileDeveloperMode:true,browserRestarted:false,browserPIDUnchanged:f.browserPID===browserPID,baselineRelease:before.releaseVersion,candidateRelease:descriptor.version,candidateDescriptorSHA256:hash(await fs.readFile(path.join(candidate,'release.json'))),beforeInstance:before.instanceId,afterInstance:live.instanceId,observedRelease:live.releaseVersion,extensionVersionAfterEnable:afterEnable.extensionVersion,extensionVersionAfterExplicitReload:live.extensionVersion,enabledManifestVersion:enabledInfo.version,settledManifestVersion:settledInfo.version,explicitRuntimeReload:true,identityPreserved:live.instanceId===before.instanceId,configurationUnchanged:Buffer.compare(configuration,await fs.readFile(f.env.QA_BROWSER_CONFIG))===0,officialExtensionPresent:false,humanPermissionAcceptanceUnverified:true};
  await fs.writeFile(path.join(f.evidence,'native-live-update.json'),JSON.stringify(result,null,2)+'\n');console.log('Running-browser native update: '+f.evidence);
  assert.equal(result.identityPreserved,true,'Instance changed in running-browser update');assert.equal(live.releaseVersion,descriptor.version);assert.equal(live.extensionVersion,descriptor.chromeVersion);assert.equal(settledInfo.version,descriptor.chromeVersion);await f.refreshIdentity();
  assert.deepEqual((await f.latch(0,['tabs'])).tabs.map(({tabId,windowId,groupId,url})=>({tabId,windowId,groupId,url})),tabsBefore);
  await f.connect(0,f.tabs[0],{background:true});assert.deepEqual(valueOf(await f.pw(0,['run-code','async(page)=>({input:await page.locator("#value").inputValue(),heap:await page.evaluate(()=>window.latchHeap),auth:await page.evaluate(()=>localStorage.getItem("latch-live-auth"))})'])),{input:'unsaved-live-update',heap:'retained',auth:'retained'});await f.latch(0,['disconnect','--session','agent']);
  await fs.writeFile(path.join(f.evidence,'native-live-update.json'),JSON.stringify({...result,tabsAndGroupsPreserved:true,unsavedInputAndHeapPreserved:true,syntheticAuthenticationPreserved:true,cleanupConfirmed:true},null,2)+'\n');
 });
