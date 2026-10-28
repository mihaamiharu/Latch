import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {frameWorkerApp} from './fixtures/frame-worker-app.mjs';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {eventually} from './helpers/native-browser.mjs';

const enabled=process.env.LATCH_FRAMES_WORKERS==='1'&&process.platform==='darwin';
for(const transport of ['official','native'])test(`headless frame/worker comparison: ${transport}`,{skip:!enabled,timeout:240000},async t=>{
  const app=await frameWorkerApp();let f;t.after(async()=>{await f?.close();await app.close()});
  f=await attachmentFixture(t,app,transport);await f.connect(0,f.tabs[0]);const outcomes=[];
  const run=async code=>valueOf(await f.pw(0,['run-code',code]));
  const interact=async(selector,value)=>run(`async(page)=>{await page.bringToFront();const frame=${selector};await frame.locator('#value').fill(${JSON.stringify(value)});await frame.locator('#save').click();return {actor:await frame.locator('#actor').innerText(),instance:await frame.locator('#instance').innerText(),result:await frame.locator('#result').innerText()}}`);
  for(const [id,selector] of [['F1',"page.frameLocator('#same')"],['F2/F3',"page.frameLocator('#cross')"],['F4',"page.frameLocator('#cross').frameLocator('#nested')"]]){
    const r=await interact(selector,id);assert.equal(r.actor,f.run+':a');assert.equal(r.result,'Saved '+id);
    await eventually(()=>app.states.get(r.instance)?.result===r.result);outcomes.push({case:id,outcome:'passed'});
  }
  const iframeWorker=await run("async(page)=>{const frame=page.frameLocator('#cross');const parent=await frame.locator('#instance').innerText();const waiting=page.waitForEvent('worker',{timeout:10000});await (await (await page.locator('#cross').elementHandle()).contentFrame()).evaluate(()=>document.querySelector('#start-worker').click());const w=await waiting;const data=await w.evaluate(()=>new Promise(resolve=>{const poll=()=>self.fixture?.ready?resolve(self.fixture):setTimeout(poll,10);poll()}));await w.evaluate(()=>self.postMessage({reply:'iframe-echo',...self.fixture}));await frame.locator('#worker-result').filter({hasText:'iframe-echo'}).waitFor();const closing=w.waitForEvent('close',{timeout:10000});await (await (await page.locator('#cross').elementHandle()).contentFrame()).evaluate(()=>document.querySelector('#stop-worker').click());await closing;return {parent,data,reply:JSON.parse(await frame.locator('#worker-result').innerText()).reply}}");
  assert.equal(iframeWorker.data.actor,f.run+':a');assert.equal(iframeWorker.data.parent,iframeWorker.parent);assert.equal(iframeWorker.reply,'iframe-echo');outcomes.push({case:'W4 OOPIF-owned dedicated worker and message round trip',outcome:'passed'});
  const graph=await f.protocolEvents();
  const frames=graph.filter(e=>e.method==='Target.attachedToTarget'&&e.type==='iframe');
  assert.ok(frames.length>=2,'Actual distinct iframe targets must be observed');
  assert.ok(frames.some(e=>frames.some(parent=>parent.daemon===e.daemon&&parent.childSessionId===e.sessionId)),'Nested iframe target must attach under its parent child session');
  await fs.writeFile(path.join(f.evidence,'oopif-proof.json'),JSON.stringify(frames,null,2));
  await run("async(page)=>{await page.evaluate(()=>document.querySelector('#insert').click());await page.frameLocator('#dynamic').locator('#actor').waitFor()}");
  await interact("page.frameLocator('#dynamic')",'dynamic');
  const removed=await run("async(page)=>{const frame=page.frames().find(f=>f.name()==='dynamic');const old=await frame.locator('#actor').elementHandle();await page.evaluate(()=>document.querySelector('#remove').click());await page.waitForFunction(()=>!document.querySelector('#dynamic'));let rejected=false;try{await old.click({timeout:1000})}catch{rejected=true}return {detached:frame.isDetached(),rejected,parent:await page.locator('#actor').innerText()}}");
  assert.equal(removed.detached,true);assert.equal(removed.rejected,true);assert.equal(removed.parent,f.run+':a');outcomes.push({case:'F5/F7 dynamic removal and stale handle',outcome:'passed'});
  for(let n=0;n<2;n++){await run("async(page)=>{await page.evaluate(()=>document.querySelector('#navigate').click())}");await interact("page.frameLocator('#moving')",'navigate-'+n)}
  const replacement=await run("async(page)=>{const old=await (await page.locator('#cross').elementHandle()).contentFrame();await page.evaluate(()=>document.querySelector('#replace').click());await page.frameLocator('#cross').locator('h1').filter({hasText:'replacement'}).waitFor();return old.isDetached()}");assert.equal(replacement,true);
  await interact("page.frameLocator('#cross')",'replacement');outcomes.push({case:'F6 same/cross-site navigation and replacement',outcome:'passed'});
  const workers=await run("async(page)=>Promise.all(page.workers().map(w=>w.evaluate(()=>self.fixture)))");
  const existing=await run("async(page)=>await page.evaluate(()=>new Promise(resolve=>{const w=fixtureWorkers.existing;w.addEventListener('message',e=>resolve(e.data),{once:true});w.postMessage('existing-probe')}))");
  assert.equal(existing.actor,f.run+':a');assert.equal(existing.reply,'existing-probe');
  assert.equal(app.states.get(existing.instance)?.actor,f.run+':a');
  outcomes.push({case:'W1 existing dedicated worker',outcome:workers.some(w=>w.actor===f.run+':a')?'passed':'limited',reason:'Pinned CLI does not backfill existing workers into page.workers; real target and application message round trip are observed'});
  const worker=await run("async(page)=>{const waiting=page.waitForEvent('worker',{timeout:10000});await page.evaluate(()=>document.querySelector('#start-worker').click());const w=await waiting;return await w.evaluate(()=>new Promise(resolve=>{const poll=()=>self.fixture?.ready?resolve(self.fixture):setTimeout(poll,10);poll()}))}");assert.equal(worker.actor,f.run+':a');
  const recreated=await run(`async(page)=>{const candidates=await Promise.all(page.workers().map(async w=>({w,id:(await w.evaluate(()=>self.fixture)).instance})));const old=candidates.find(x=>x.id===${JSON.stringify(worker.instance)})?.w;if(!old)throw new Error('Dynamic worker missing');const closing=old.waitForEvent('close',{timeout:10000});await page.evaluate(()=>document.querySelector('#stop-worker').click());await closing;let staleRejected=false;try{await old.evaluate(()=>1)}catch{staleRejected=true}const waiting=page.waitForEvent('worker',{timeout:10000});await page.evaluate(()=>document.querySelector('#start-worker').click());const fresh=await waiting;return {staleRejected,current:await fresh.evaluate(()=>new Promise(resolve=>{const poll=()=>self.fixture?.ready?resolve(self.fixture):setTimeout(poll,10);poll()}))}}`);
  assert.equal(recreated.staleRejected,true);assert.notEqual(recreated.current.instance,worker.instance);assert.equal(recreated.current.actor,f.run+':a');outcomes.push({case:'W2/W3 creation, evaluation, termination and recreation',outcome:'passed'});
  await fs.writeFile(path.join(f.evidence,'worker-observations.json'),JSON.stringify({existingProbe:existing,inventoryCount:workers.length,created:worker,recreated:recreated.current,iframeWorker},null,2));
  const events=await run("async(page)=>{const logs=[],requests=[];const log=m=>logs.push(m.text()),request=r=>{if(r.url().includes('/event?'))requests.push(r.url())};page.on('console',log);page.on('request',request);try{const error=page.waitForEvent('pageerror',{timeout:10000});await page.frameLocator('#cross').locator('#emit').click();return {logs,requests,error:(await error).message}}finally{page.off('console',log);page.off('request',request)}}");
  assert.ok(events.logs.some(x=>x.includes('frame-console:'+f.run+':a:replacement')));assert.ok(events.error.includes('frame-error:'+f.run+':a:replacement'));assert.equal(events.requests.length,1);
  await fs.writeFile(path.join(f.evidence,'frame-events.json'),JSON.stringify(events,null,2));
  await fs.writeFile(path.join(f.evidence,'console.json'),JSON.stringify(await f.pw(0,['console','error']),null,2));
  await fs.writeFile(path.join(f.evidence,'requests.json'),JSON.stringify(await f.pw(0,['requests']),null,2));
  await f.pw(0,['snapshot',`--filename=${path.join(f.evidence,'frames.yaml')}`]);
  await f.pw(0,['screenshot',`--filename=${path.join(f.evidence,'frames.png')}`]);
  const snapshot=await fs.readFile(path.join(f.evidence,'frames.yaml'),'utf8');assert.ok(snapshot.includes('Saved F1'));assert.ok(snapshot.includes('Saved replacement'));assert.ok((await fs.stat(path.join(f.evidence,'frames.png'))).size>1000);
  outcomes.push({case:'F8 frame console, page error, request, snapshot and screenshot',outcome:'passed'});
  await f.latch(0,['disconnect','--session','agent']);const remaining=(await f.latch(0,['tabs'])).tabs;
  assert.ok(remaining.some(tab=>tab.tabId===f.tabs[0]));assert.ok(remaining.every(tab=>tab.owner===null));
  await fs.writeFile(path.join(f.evidence,'report.json'),JSON.stringify({transport,headless:true,lifecycleTriggers:'scoped fixture DOM controls; forms use normal fill/click',connectionPageDelivery:f.connectionPageDelivery,versions:f.versions,launchArgs:f.launchArgs,outcomes,cleanupPreservedTabs:true},null,2));
  await f.close();console.log(`Frame/worker ${transport} evidence: ${f.evidence}`);
});
