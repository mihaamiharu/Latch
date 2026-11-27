import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {frameWorkerApp} from './fixtures/frame-worker-app.mjs';import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';import {sessionKey} from '../src/redact.mjs';import {eventually} from './helpers/native-browser.mjs';
const enabled=process.env.LATCH_FRAME_ISOLATION==='1'&&process.platform==='darwin';
test('headless native frame/worker lifetimes, cancellation and agent isolation',{skip:!enabled,timeout:240000},async t=>{
 const app=await frameWorkerApp();let f;t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,'native');
 const connected=await Promise.all([f.connect(0,f.tabs[0],{background:true}),f.connect(1,f.tabs[1],{background:true})]);
 const run=async(i,code)=>valueOf(await f.pw(i,['run-code',code]));const results=[];
 const inspect=async(i)=>run(i,"async(page)=>{const frame=await (await page.locator('#cross').elementHandle()).contentFrame();const c=await page.context().newCDPSession(frame);try{const targetId=(await c.send('Target.getTargetInfo')).targetInfo.targetId;await page.frameLocator('#cross').locator('#value').fill('agent-write');await page.frameLocator('#cross').locator('#save').click();return {targetId,actor:await page.frameLocator('#cross').locator('#actor').innerText(),instance:await page.frameLocator('#cross').locator('#instance').innerText()}}finally{await c.detach()}}");
 const [a,b]=await Promise.all([inspect(0),inspect(1)]);assert.equal(a.actor,f.run+':a');assert.equal(b.actor,f.run+':b');assert.notEqual(a.targetId,b.targetId);
 await eventually(()=>app.states.get(a.instance)?.result==='Saved agent-write'&&app.states.get(b.instance)?.result==='Saved agent-write');results.push('same-URL concurrent frame writes reach only their actors');
 const start=i=>run(i,"async(page)=>{const waiting=page.waitForEvent('worker',{timeout:10000});await page.evaluate(()=>document.querySelector('#start-worker').click());const worker=await waiting;return await worker.evaluate(()=>new Promise(resolve=>{const poll=()=>self.fixture?.ready?resolve(self.fixture):setTimeout(poll,10);poll()}))}");
 const [wa,wb]=await Promise.all([start(0),start(1)]);assert.equal(wa.actor,f.run+':a');assert.equal(wb.actor,f.run+':b');assert.notEqual(wa.instance,wb.instance);results.push('same-URL dynamic workers remain in their own sessions');
 const graph=await f.protocolEvents(),rootB=graph.find(e=>e.type==='page'&&e.targetId===connected[1].page.targetId);
 assert.ok(rootB);const workerB=graph.filter(e=>e.daemon===rootB.daemon&&e.type==='worker'&&e.sessionId===rootB.childSessionId).at(-1);assert.ok(workerB);
 const negative=await run(0,`async(page)=>{const c=await page.context().browser().newBrowserCDPSession();try{const rejected=[];for(const id of ${JSON.stringify([b.targetId,workerB.targetId])}){try{await c.send('Target.attachToTarget',{targetId:id,flatten:true});rejected.push(false)}catch{rejected.push(true)}}return rejected}finally{await c.detach()}}`);
 assert.deepEqual(negative,[true,true]);results.push('foreign frame and worker target attachment rejected');
 const [retired,peer]=await Promise.all([
 run(0,"async(page)=>{const handle=await page.locator('#cross').elementHandle(),old=await handle.contentFrame();const c=await page.context().newCDPSession(old);const pending=c.send('Runtime.evaluate',{expression:'new Promise(()=>{})',awaitPromise:true}).then(()=>false,()=>true);await page.evaluate(()=>document.querySelector('#replace').click());await page.frameLocator('#cross').locator('h1').filter({hasText:'replacement'}).waitFor();const cancelled=await pending;let stale=false;try{await c.send('Runtime.evaluate',{expression:'1'})}catch{stale=true}let frameStale=false;try{await old.locator('#save').click({timeout:1000})}catch{frameStale=true}return {cancelled,stale,frameStale,detached:old.isDetached(),actor:await page.locator('#actor').innerText()}}"),
 inspect(1)]);
 assert.deepEqual(retired,{cancelled:true,stale:true,frameStale:true,detached:true,actor:f.run+':a'});assert.equal(peer.actor,f.run+':b');
 const stillOld=await run(0,`async(page)=>{const c=await page.context().browser().newBrowserCDPSession();try{let rejected=false;try{await c.send('Target.attachToTarget',{targetId:${JSON.stringify(a.targetId)},flatten:true})}catch{rejected=true}return rejected}finally{await c.detach()}}`);assert.equal(stillOld,true);results.push('in-flight child command cancelled, old aliases and frame rejected, peer preserved');
 const released=await f.latch(0,['release','--session','agent','--tab',String(f.tabs[0])]);assert.equal(released.sessionClosed,true);
 assert.equal((await inspect(1)).actor,f.run+':b');const tabs=(await f.latch(1,['tabs'])).tabs;
 assert.equal(tabs.find(tab=>tab.tabId===f.tabs[0]).owner,null);assert.equal(tabs.find(tab=>tab.tabId===f.tabs[1]).owner,sessionKey(f.workspaces[1],'agent'));assert.equal(tabs.find(tab=>tab.tabId===f.tabs[2]).owner,null);
 results.push('release retires only one lease and preserves all physical tabs and peer operation');
 await f.pw(1,['screenshot',`--filename=${path.join(f.evidence,'peer-survives.png')}`]);
 await f.latch(0,['disconnect','--session','agent']);await f.latch(1,['disconnect','--session','agent']);
 assert.ok((await f.latch(1,['tabs'])).tabs.every(tab=>tab.owner===null));
 await fs.writeFile(path.join(f.evidence,'report.json'),JSON.stringify({outcome:'passed',headless:true,versions:f.versions,launchArgs:f.launchArgs,focusEmulation:true,results,cleanupPreservedTabs:true},null,2));await f.close();console.log(`Isolation evidence: ${f.evidence}`);
});
