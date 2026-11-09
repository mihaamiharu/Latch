import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';
import {startLibraryServer} from '../src/exploration-library.mjs';

test('managed exploration captures centrally, finalizes YAML, reviews locally and exports a complete handoff',{
 skip:process.env.LATCH_EXPLORATION!=='1'||process.platform!=='darwin',timeout:180000,
},async t=>{
 const app=await evidenceApp();let f,ui;const old=process.env.LATCH_ARTIFACT_ROOT;
 t.after(async()=>{await ui?.close();await f?.close();await app.close();old===undefined?delete process.env.LATCH_ARTIFACT_ROOT:process.env.LATCH_ARTIFACT_ROOT=old;});
 f=await attachmentFixture(t,app,'native');f.env.LATCH_CAPTURE='on';f.env.LATCH_ARTIFACT_ROOT=path.join(f.temp,'central artifacts');process.env.LATCH_ARTIFACT_ROOT=f.env.LATCH_ARTIFACT_ROOT;
 const opened=await f.latch(0,['open','--transport','native','--session','agent','--focus-emulation','on','--url',app.origin+'/root#'+encodeURIComponent(f.run+':exploration'),'--objective','Required-field exploration','--environment','local fixture']);
 assert.equal(opened.created,true);assert.ok(opened.library.runId);const run=opened.library.runId;
 const initial=JSON.parse(await fs.readFile(path.join(opened.library.directory,'exploration.json')));assert.ok(initial.states.length>0,'Initial states captured');
 const field=initial.states[0].elements.find(e=>e.role==='textbox');assert.ok(field);
 await f.latch(0,['pw','--session','agent','--data-ref','synthetic-value','--','fill',field.snapshot_ref,'proof']);
 const afterFill=JSON.parse(await fs.readFile(path.join(opened.library.directory,'exploration.json')));
 const state=afterFill.states.at(-1),button=state.elements.find(e=>e.role==='button'&&e.name==='Save');assert.ok(button);
 await f.latch(0,['pw','--session','agent','--','click',button.snapshot_ref]);
 await f.latch(0,['checkpoint','--session','agent','--note','Save displays the supplied value. Expected business behavior needs QA review.']);
 const finished=await f.latch(0,['finish','--session','agent']);assert.equal(finished.library.cleanup,'confirmed');assert.equal(finished.library.integrity,true);
 const handoff=JSON.parse(await fs.readFile(path.join(opened.library.directory,'exploration.json')));assert.ok(handoff.transitions.some(a=>a.action.type==='fill'));assert.ok(handoff.final_states.some(s=>s.status==='captured'));assert.ok(handoff.states.some(s=>s.elements.some(e=>e.locator_candidate?.name==='Save')));
 const listed=await f.latch(0,['library','list']);assert.ok(listed.runs.some(r=>r.id===run));
 ui=await startLibraryServer();f.env.LATCH_CAPTURE='off';await f.connect(1,f.tabs[1],{background:true});await f.pw(1,['run-code','async(page)=>{await page.setViewportSize({width:1280,height:900});await page.bringToFront()}']);await f.pw(1,['goto',ui.url]);
 await f.pw(1,['run-code',`async(page)=>{await page.getByLabel('Search explorations').fill('Required-field');await page.getByRole('link',{name:/Required-field exploration/}).click();await page.getByLabel('Decision').selectOption('automate');await page.getByLabel('Review notes').fill('Automate Save feedback.');await page.getByRole('button',{name:'Save review'}).click();await page.getByRole('status').filter({hasText:'Review saved'}).waitFor()}`]);
 await f.pw(1,['run-code','async(page)=>page.evaluate(()=>window.scrollTo(0,0))']);
 await f.pw(1,['screenshot','--full-page','--filename='+path.join(f.evidence,'library-review.png')]);
 const review=JSON.parse(await fs.readFile(path.join(opened.library.directory,'review.json')));assert.equal(review.decision,'automate');
 const exported=await f.latch(0,['library','export','--run',run,'--destination',path.join(f.evidence,'handoff')]);assert.equal(exported.exported,true);
 assert.ok(await fs.stat(path.join(exported.directory,'exploration.yaml')));
 await fs.writeFile(path.join(f.evidence,'exploration-result.json'),JSON.stringify({headless:true,versions:f.versions,launchArgs:f.launchArgs,runId:run,library:opened.library.directory,central:true,finalSnapshots:true,reviewSaved:true,exported:true,videoStatus:handoff.video.status},null,2));
 console.log('Exploration evidence: '+f.evidence);
});

test('YAML includes owned popups, frame locators, transitions and final states without claiming opaque script coverage',{
 skip:process.env.LATCH_EXPLORATION!=='1'||process.platform!=='darwin',timeout:180000,
},async t=>{
 const {popupApp}=await import('./fixtures/popup-app.mjs');const app=await popupApp();let f;t.after(async()=>{await f?.close();await app.close();});
 f=await attachmentFixture(t,app,'native');f.env.LATCH_CAPTURE='on';f.env.LATCH_ARTIFACT_ROOT=path.join(f.temp,'central artifacts');
 const opened=await f.latch(0,['open','--transport','native','--session','agent','--focus-emulation','on','--video','off','--url',app.origin+'/root#'+encodeURIComponent(f.run+':map'),'--objective','Popup and frame map']);
 await f.pw(0,['run-code','async(page)=>page.bringToFront()']); // Explicit headed/foreground policy in this disposable fixture.
 await f.latch(0,['pw','--session','agent','--','click','#window']);
 await f.latch(0,['pw','--session','agent','--','tab-select','1']);
 await f.latch(0,['pw','--session','agent','--data-ref','seeded-child-value','--','fill','#value','child-data']);
 await f.latch(0,['pw','--session','agent','--','run-code',`async(page)=>{await page.evaluate(url=>{const frame=document.createElement('iframe');frame.src=url;document.body.append(frame)},${JSON.stringify(app.origin+'/child')});await page.frameLocator('iframe').locator('#value').waitFor()}`]);
 await f.latch(0,['checkpoint','--session','agent','--note','Child form is present inside an iframe.']);
 const finished=await f.latch(0,['finish','--session','agent']);assert.equal(finished.library.cleanup,'confirmed');
 const handoff=JSON.parse(await fs.readFile(path.join(opened.library.directory,'exploration.json')));
 assert.equal(handoff.pages.length,2);assert.ok(handoff.pages.some(p=>p.opener_page));assert.ok(handoff.states.some(s=>s.frame.id!=='main'&&s.locator_observations.some(e=>e.attributes.id==='value')));
 assert.ok(handoff.final_states.some(s=>s.frame!=='main'&&s.status==='captured'));assert.ok(handoff.coverage.gaps.some(g=>g.reason.includes('Opaque script')));
 assert.equal(handoff.video.status,'disabled');assert.ok(handoff.transitions.some(a=>a.action.type==='tab-select'&&a.from!==a.to));
 await fs.writeFile(path.join(f.evidence,'exploration-frames.json'),JSON.stringify({headless:true,versions:f.versions,runId:opened.library.runId,library:opened.library.directory,ownedPages:handoff.pages.length,frames:true,finals:true,videoExplicitlyDisabled:true},null,2));
 console.log('Frame handoff evidence: '+f.evidence);
});

test('foreground managed recording retains videos for an owned popup left open at finish',{
 skip:process.env.LATCH_EXPLORATION!=='1'||process.platform!=='darwin',timeout:150000,
},async t=>{
 const {popupApp}=await import('./fixtures/popup-app.mjs');const {command}=await import('./helpers/native-browser.mjs');const os=await import('node:os');const app=await popupApp();let f;t.after(async()=>{await f?.close();await app.close();});
 f=await attachmentFixture(t,app,'native');f.env.LATCH_CAPTURE='on';f.env.LATCH_ARTIFACT_ROOT=path.join(f.temp,'central artifacts');
 const opened=await f.latch(0,['open','--transport','native','--session','agent','--focus-emulation','on','--video','foreground','--url',app.origin+'/root#'+encodeURIComponent(f.run+':video'),'--objective','Popup video handoff']);
 await f.latch(0,['pw','--session','agent','--','click','#window']);
 await f.latch(0,['pw','--session','agent','--','tab-select','1']);
 await f.latch(0,['pw','--session','agent','--data-ref','child-seed','--','fill','#value','popup-video']);
 await f.latch(0,['pw','--session','agent','--','click','#save']);
 const finished=await f.latch(0,['finish','--session','agent']);assert.equal(finished.library.cleanup,'confirmed');
 const graph=JSON.parse(await fs.readFile(path.join(opened.library.directory,'exploration.json')));assert.equal(graph.pages.length,2);assert.equal(graph.video.status,'complete');assert.equal(graph.video.clips.length,2);
 for(const [i,clip]of graph.video.clips.entries()){const result=await command(path.join(os.homedir(),'Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac'),['-i',path.join(opened.library.directory,clip),'-frames:v','1','-f','image2',path.join(f.evidence,`clip-${i}.png`)]);assert.equal(result.code,0,result.err);}
 await fs.writeFile(path.join(f.evidence,'exploration-video.json'),JSON.stringify({headless:true,versions:f.versions,library:opened.library.directory,clips:2,decoded:true,focusPolicy:'explicit foreground',closedPopupCoverageNotClaimed:true},null,2));console.log('Managed video evidence: '+f.evidence);
});
