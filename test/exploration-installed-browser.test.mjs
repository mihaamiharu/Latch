import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {CANDIDATE_KIT} from './helpers/candidate.mjs';
import {attachmentFixture} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';
import {inspectSetup,activateSetup,verifySetup} from '../src/setup.mjs';

async function envOf(env,fn){const keys=['QA_BROWSER_CONFIG','QA_BROWSER_RUNTIME_DIR','PWTEST_DAEMON_SESSION_DIR'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));for(const k of keys)process.env[k]=env[k];try{return await fn()}finally{for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];}}
test('exact installed candidate creates a central video/YAML bundle, exports it and preserves the browser on finish',{
 skip:process.env.LATCH_EXPLORATION_INSTALLED!=='1'||process.platform!=='darwin',timeout:180000,
},async t=>{
 const app=await evidenceApp();app.installed=true;app.minimalHostPath=true;app.artifactExtension=path.join(CANDIDATE_KIT,'extension');let f,setup;
 app.install=async({temp,profile,env})=>{
  app.installedRoot=path.join(temp,'installed runtime');setup={kit:CANDIDATE_KIT,root:app.installedRoot,registrationRoot:path.join(profile,'NativeMessagingHosts'),tasksDrained:true,extensionUnloaded:true};
  await fs.writeFile(env.QA_BROWSER_CONFIG,'{"v":1,"profiles":{}}');
  await envOf(env,async()=>{const plan=await inspectSetup(setup);await activateSetup({...setup,expect:plan.planToken});});
 };
 t.after(async()=>{await f?.close();await app.close();});f=await attachmentFixture(t,app,'native');f.env.LATCH_CAPTURE='on';f.env.LATCH_ARTIFACT_ROOT=path.join(f.temp,'library');
 const opened=await f.latch(0,['open','--transport','native','--focus-emulation','on','--video','foreground','--session','agent','--url',app.origin+'/root#'+encodeURIComponent(f.run+':installed'),'--objective','Installed exploration handoff']);
 assert.equal(opened.created,true);assert.ok(opened.library.runId);
 await f.latch(0,['pw','--session','agent','--data-ref','seeded-input','--','fill','#value','installed-proof']);
 await f.latch(0,['pw','--session','agent','--','click','#save']);
 const annotation=path.join(f.temp,'behavior.json');await fs.writeFile(annotation,JSON.stringify({kind:'behavior',observed:'Save displays the entered value',expected:null}));
 await f.latch(0,['checkpoint','--session','agent','--annotation-file',annotation]);
 const done=await f.latch(0,['finish','--session','agent']);assert.equal(done.library.cleanup,'confirmed');assert.equal(done.library.integrity,true);assert.equal(done.library.video,'complete');
 const graph=JSON.parse(await fs.readFile(path.join(done.library.directory,'exploration.json')));assert.ok(graph.final_states.some(s=>s.status==='captured'));assert.equal(graph.behaviors.length,1);assert.equal(graph.behaviors[0].assertion_status,'not_asserted');
 assert.ok(await fs.stat(path.join(done.library.directory,'exploration.schema.json')));
 const exported=await f.latch(0,['library','export','--run',done.library.runId,'--destination',path.join(f.evidence,'handoff')]);assert.equal(exported.exported,true);
 assert.equal((await f.latch(0,['finish','--session','agent'])).alreadyFinished,true);
 assert.ok((await f.latch(0,['tabs'])).tabs.some(p=>p.tabId===opened.tabId&&p.owner===null));
 assert.equal((await envOf(f.env,()=>verifySetup(setup))).verified,true);
 const descriptor=JSON.parse(await fs.readFile(path.join(CANDIDATE_KIT,'release.json')));
 await fs.writeFile(path.join(f.evidence,'installed-exploration.json'),JSON.stringify({headless:true,versions:f.versions,launchArgs:f.launchArgs,candidateSource:descriptor.sourceRevision,sourceDirty:descriptor.sourceDirty,library:done.library.directory,exported:exported.directory,exactKitCLI:true,minimalHostPATH:true,videoFinalized:true,finalSnapshots:true,cleanup:true,realWorkChanged:false},null,2));console.log('Installed exploration evidence: '+f.evidence);
});
