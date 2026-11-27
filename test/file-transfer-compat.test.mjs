import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileApp,inputCorpus,inboxReceipts} from './fixtures/file-app.mjs';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {eventually} from './helpers/native-browser.mjs';
import {meta,upload,chooserUpload,downloadProbe,received} from './helpers/file-workflow.mjs';

const enabled=process.env.LATCH_FILES==='1'&&process.platform==='darwin';
test('headless file comparison: native',{skip:!enabled,timeout:240000},async t=>{
 const transport='native';
 const app=await fileApp();let f;
 t.after(async()=>{await f?.close();await app.close()});
 f=await attachmentFixture(t,app,transport);await f.connect(0,f.tabs[0]);
 const corpus=await inputCorpus(f.workspaces[0],f.run+':a'),outcomes=[];
 const run=async code=>valueOf(await f.pw(0,['run-code',code]));
 await fs.writeFile(path.join(f.evidence,'input-manifest.json'),JSON.stringify(meta(corpus),null,2));
 for(const [operation,files,input] of [['U1',[corpus[0]],'single'],['U2',corpus.slice(4),'multi'],['U3',corpus.slice(1,4),'multi'],['U7-clear',[],'multi'],['U7-reselect',[corpus[0]],'multi']]){
  await upload(f,app,0,files,{operation,input});outcomes.push({case:operation,outcome:'passed'});
 }
 await chooserUpload(f,app,0,[corpus[0],corpus[2]],{operation:'U4'});outcomes.push({case:'U4 CLI pending chooser',outcome:'passed'});
 for(const frame of ['same','cross']){
  const scope=`page.frameLocator('#${frame}')`;
  const r=await upload(f,app,0,[corpus[3]],{operation:'U5-input-'+frame,scope});assert.equal(app.states.get(r.instance)?.role,frame);
  const c=await chooserUpload(f,app,0,[corpus[2]],{operation:'U5-chooser-'+frame,scope});assert.equal(app.states.get(c.instance)?.role,frame);
 }
 outcomes.push({case:'U5 same-origin and OOPIF input/CLI chooser',outcome:'passed'});
 for(const frame of ['same','cross']){const operation='I2-frame-'+frame;const download=await downloadProbe(f,0,{operation,scope:`page.frameLocator('#${frame}')`});outcomes.push({case:operation,...await received(f,app,operation),download})}
 const popupDownload=await run("async(page)=>{await page.bringToFront();const pending=page.waitForEvent('popup',{timeout:10000});await page.evaluate(()=>document.querySelector('#popup').click());const child=await pending;await child.waitForLoadState('domcontentloaded');await child.locator('#download-basic').evaluate(el=>el.ownerDocument.defaultView.fixture.operation='I2-popup');const waiting=child.waitForEvent('download',{timeout:2000}).then(()=>true,()=>false);await child.locator('#download-basic').evaluate(el=>el.click());return {actor:await child.locator('#actor').innerText(),event:await waiting,agentArtifact:false}}");
 assert.equal(popupDownload.actor,f.run+':a');assert.equal(popupDownload.event,false);
 outcomes.push({case:'I2 attributed popup',...await received(f,app,'I2-popup'),download:popupDownload});
 await f.connect(0,f.tabs[0]);
 const before=app.uploads.length;
 const negative=await run(`async(page)=>{
  let missing=false;try{await page.locator('#single').setInputFiles(${JSON.stringify(path.join(f.workspaces[0],'inputs','absent.txt'))})}catch{missing=true}
  const old=await page.locator('#single').elementHandle();await page.evaluate(()=>document.querySelector('#replace-input').click());const oldConnected=await old.evaluate(el=>el.isConnected);
  let stale=false;try{await old.setInputFiles(${JSON.stringify(corpus[0].path)})}catch{stale=true}
  const replacementCount=await page.locator('#single').evaluate(el=>el.files.length);
  const frame=await (await page.locator('#cross').elementHandle()).contentFrame();const handle=await frame.locator('#single').elementHandle();const retiring=page.waitForEvent('framedetached',{predicate:f=>f===frame,timeout:5000});
  await page.evaluate(()=>document.querySelector('#remove-cross').click());await retiring;let detached=false;try{await handle.setInputFiles(${JSON.stringify(corpus[0].path)})}catch{detached=true}
  return {missing,stale,oldConnected,replacementCount,detached,frameDetached:frame.isDetached()}
 }`);
 assert.equal(negative.oldConnected,false);assert.equal(negative.missing,true);assert.equal(negative.replacementCount,0);assert.equal(negative.detached,true);assert.equal(negative.frameDetached,true);assert.equal(app.uploads.length,before);
 outcomes.push({case:'U6 missing, replaced and detached inputs',outcome:'passed',...negative});
 for(const [operation,variant] of [['B1','basic'],['B2','redirect'],['B3-first','basic'],['B3-second','basic'],['B4-slow','slow']]){
  const download=await downloadProbe(f,0,{operation,variant});const receipt=await received(f,app,operation);assert.equal(download.event,false,'Pinned attachment capability changed; reclassify retrieval instead of claiming the old limit');
  if(download.agentArtifact){assert.equal(download.sha256,receipt.expected.sha256);assert.equal(download.bytes,receipt.expected.bytes)}
  outcomes.push({case:operation,...receipt,download});
 }
 const repeated=outcomes.filter(r=>r.case.startsWith('B3-'));
 assert.notEqual(repeated[0].observed.filename,repeated[1].observed.filename);assert.notEqual(repeated[0].observed.sha256,repeated[1].observed.sha256);
 const interrupted=await downloadProbe(f,0,{operation:'B4-interrupt',variant:'interrupt'});
 await eventually(()=>app.downloads.find(r=>r.operation==='B4-interrupt')?.response==='interrupted');
 const expected=app.downloads.find(r=>r.operation==='B4-interrupt');
 assert.ok(!(await inboxReceipts(f.browserInbox)).some(r=>r.complete&&r.sha256===expected.sha256));assert.equal(interrupted.agentArtifact,false);
 outcomes.push({case:'B4-interrupt',serverInterrupted:true,browserTerminalState:'not established by server interruption',completeArtifact:false,download:interrupted});
 outcomes.push({case:'B4-cancel',outcome:'unsupported',reason:'No Download event/object available; HTTP interruption is not cancellation API coverage'});
 outcomes.push({case:'R1/R2',outcome:'unsupported',reason:'Browser receipt works; no Playwright Download event or exact agent saveAs artifact. No inbox path exported as agent retrieval.'});
 const graph=await f.protocolEvents();
 const lifecycle=graph.filter(e=>e.method==='Page.downloadWillBegin'||e.method==='Page.downloadProgress');
 assert.ok(lifecycle.some(e=>e.method==='Page.downloadWillBegin'&&e.guid&&e.frameId));
 assert.ok(lifecycle.some(e=>e.state==='completed'));
 outcomes.push({case:'D2 low-level page lifecycle',outcome:'observed',events:lifecycle.length,states:[...new Set(lifecycle.map(e=>e.state).filter(Boolean))],exactSavedPath:false,normalPlaywrightDownload:false});
 await fs.writeFile(path.join(f.evidence,'download-lifecycle.json'),JSON.stringify(lifecycle,null,2));
 assert.ok(graph.some(e=>e.method==='Target.attachedToTarget'&&e.type==='iframe'),'Actual OOPIF required');
 await fs.writeFile(path.join(f.evidence,'observer-downloads.json'),JSON.stringify(await inboxReceipts(f.browserInbox),null,2));
 await f.pw(0,['screenshot',`--filename=${path.join(f.evidence,'files.png')}`]);await f.pw(0,['snapshot',`--filename=${path.join(f.evidence,'files.yaml')}`]);
 await f.latch(0,['disconnect','--session','agent']);assert.ok((await f.latch(0,['tabs'])).tabs.some(tab=>tab.tabId===f.tabs[0]&&tab.owner===null));
 await fs.writeFile(path.join(f.evidence,'report.json'),JSON.stringify({transport,headless:true,versions:f.versions,launchArgs:f.launchArgs,connectionPageDelivery:f.connectionPageDelivery,outcomes,cleanupPreservedTabs:true},null,2));
 await f.close();console.log(`File evidence: ${f.evidence}`);
});
