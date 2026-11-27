import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {attachmentFixture, valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';
import {suiteGate} from './helpers/browser-suite.mjs';
import {eventually} from './helpers/native-browser.mjs';

test('headless fresh-tab open reuses profile auth, preserves existing tabs/peer, rejects duplicate sessions, and --close-tabs closes only opened tabs', {
  skip: suiteGate('LATCH_OPEN_TAB'), timeout:150000,
}, async t => {
  const app = await evidenceApp(); let f;
  t.after(async()=>{await f?.close();await app.close();});
  f = await attachmentFixture(t,app,'native');
  const tabs = async () => (await f.latch(0,['tabs','--profile','work'])).tabs;
  await f.connect(1,f.tabs[1],{background:true});
  await f.pw(1,['run-code','async(page)=>page.evaluate(()=>localStorage.setItem("open-auth","synthetic-login"))']);
  const before=await tabs();
  const opened=await f.latch(0,['open',app.origin+'/root#'+encodeURIComponent(f.run+':fresh'),'--profile','work','--session','agent','--focus-emulation','on']);
  assert.equal(opened.created,true);assert.equal(opened.connected,true);
  assert.ok(!before.some(tab=>tab.tabId===opened.tabId));
  const read=valueOf(await f.pw(0,['run-code',
    'async(page)=>({actor:await page.locator("#actor").innerText(),auth:await page.evaluate(()=>localStorage.getItem("open-auth"))})']));
  assert.deepEqual(read,{actor:f.run+':fresh',auth:'synthetic-login'});
  const collision=await f.latch(0,['open',app.origin+'/another','--profile','work','--session','agent'],{fail:true});
  assert.equal(collision.error.code,'SESSION_COLLISION');
  const after=await tabs();
  assert.equal(after.length,before.length+1);
  for (const tab of before) {
    const current=after.find(t=>t.tabId===tab.tabId);
    assert.equal(current.url,tab.url);assert.equal(current.windowId,tab.windowId);
  }
  await f.pw(0,['goto',app.origin+'/next']);
  await f.latch(0,['disconnect','--profile','work','--session','agent']);
  const preserved=(await tabs()).find(t=>t.tabId===opened.tabId);
  assert.ok(preserved);assert.equal(preserved.owner,null);assert.equal(preserved.url,app.origin+'/next');
  assert.equal(valueOf(await f.pw(1,['run-code','async(page)=>await page.locator("#actor").innerText()'])),f.run+':b');

  // --close-tabs closes only the tab `latch open` created, never the
  // attached (connected) tab or the peer's tab.
  const connected=await f.connect(0,f.tabs[0]);
  assert.equal(connected.tabId,f.tabs[0]);
  await f.latch(0,['disconnect','--profile','work','--session','agent']);
  const created=await f.latch(0,['open',app.origin+'/root#'+encodeURIComponent(f.run+':closable'),'--profile','work','--session','closer']);
  const closed=await f.latch(0,['disconnect','--profile','work','--session','closer','--close-tabs']);
  const remaining=await eventually(async()=>{const list=await tabs();return list.some(t=>t.tabId===created.tabId)?null:list;});
  for (const id of [f.tabs[0],f.tabs[1],opened.tabId]) assert.ok(remaining.some(t=>t.tabId===id),`tab ${id} must survive --close-tabs`);

  // Navigation failures retain an inspectable session/tab and cannot create
  // duplicates when the caller repeats an uncertain command.
  t.after(async()=>{await f.latch(0,['disconnect','--session','navigation-error']).catch(()=>{});});
  const failed=await f.latch(0,['open','http://127.0.0.1:1/','--session','navigation-error'],{fail:true});
  const repeated=await f.latch(0,['open',app.origin+'/retry','--session','navigation-error'],{fail:true});
  assert.equal(repeated.error.code,'SESSION_COLLISION');
  await f.latch(0,['disconnect','--session','navigation-error']);
  await fs.writeFile(path.join(f.evidence,'open-tab-result.json'),JSON.stringify({...f.evidenceRecord,versions:f.versions,
    newTab:true,syntheticLoginReused:true,existingTabsPreserved:true,duplicateOpenRejected:true,
    navigationFailure:failed.error,peerSurvives:true,disconnectPreservesCreatedTab:true,
    closeTabs:{result:closed,closedCreatedTab:true,keptConnectedAndPeerTabs:true}},null,2));
  console.log('Fresh-tab evidence: '+f.evidence);
});
