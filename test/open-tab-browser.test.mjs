import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {attachmentFixture, valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';

test('headless fresh-tab open reuses profile auth, preserves existing tabs/peer, and rejects duplicate sessions', {
  skip: process.env.LATCH_OPEN_TAB !== '1' || process.platform !== 'darwin', timeout:150000,
}, async t => {
  const app = await evidenceApp(); let f;
  t.after(async()=>{await f?.close();await app.close();});
  f = await attachmentFixture(t,app,'native');
  await f.connect(1,f.tabs[1],{background:true});
  await f.pw(1,['run-code','async(page)=>page.evaluate(()=>localStorage.setItem("open-auth","synthetic-login"))']);
  const before=(await f.latch(0,['tabs','--profile','work'])).tabs;
  const evidence=path.join(f.evidence,'fresh-tab');
  const opened=await f.latch(0,['open','--profile','work','--transport','native','--session','agent',
    '--focus-emulation','on','--url',app.origin+'/root#'+encodeURIComponent(f.run+':fresh'),'--evidence-dir',evidence,'--step','open','--inline']);
  assert.equal(opened.created,true);assert.equal(opened.connected,true);
  assert.ok(!before.some(tab=>tab.tabId===opened.tabId));
  const read=await f.latch(0,['pw','--profile','work','--session','agent','--evidence-dir',evidence,'--step','auth','--inline',
    '--expect-result',JSON.stringify({actor:f.run+':fresh',auth:'synthetic-login'}),'--','run-code',
    'async(page)=>({actor:await page.locator("#actor").innerText(),auth:await page.evaluate(()=>localStorage.getItem("open-auth"))})']);
  assert.equal(valueOf(read).auth,'synthetic-login');
  const collision=await f.latch(0,['open','--profile','work','--transport','native','--session','agent','--url',app.origin+'/another'],{fail:true});
  assert.equal(collision.error.code,'SESSION_COLLISION');
  const after=(await f.latch(0,['tabs','--profile','work'])).tabs;
  assert.equal(after.length,before.length+1);
  for (const tab of before) {
    const current=after.find(t=>t.tabId===tab.tabId);
    assert.equal(current.url,tab.url);assert.equal(current.groupId,tab.groupId);assert.equal(current.windowId,tab.windowId);
  }
  await f.latch(0,['pw','--profile','work','--session','agent','--','goto',app.origin+'/next']);
  await f.latch(0,['disconnect','--profile','work','--session','agent','--evidence-dir',evidence,'--step','disconnect']);
  const preserved=(await f.latch(0,['tabs','--profile','work'])).tabs.find(t=>t.tabId===opened.tabId);
  assert.ok(preserved);assert.equal(preserved.owner,null);assert.equal(preserved.url,app.origin+'/next');
  assert.equal(valueOf(await f.pw(1,['run-code','async(page)=>await page.locator("#actor").innerText()'])),f.run+':b');
  // Navigation failures retain an inspectable session/tab and cannot create
  // duplicates when the caller repeats an uncertain command.
  t.after(async()=>{await f.latch(0,['disconnect','--session','navigation-error']).catch(()=>{});});
  const failed=await f.latch(0,['open','--transport','native','--session','navigation-error','--url','http://127.0.0.1:1/'],{fail:true});
  assert.equal(failed.error.code,'PLAYWRIGHT_ERROR');
  assert.equal(failed.error.diagnostics.connected,true);
  assert.ok(Number.isSafeInteger(failed.error.diagnostics.createdTabId));
  const repeated=await f.latch(0,['open','--transport','native','--session','navigation-error','--url',app.origin+'/retry'],{fail:true});
  assert.equal(repeated.error.code,'SESSION_COLLISION');
  await f.latch(0,['disconnect','--session','navigation-error']);
  await fs.writeFile(path.join(f.evidence,'open-tab-result.json'),JSON.stringify({headless:true,versions:f.versions,
    launchArgs:f.launchArgs,newTab:true,syntheticLoginReused:true,existingTabsPreserved:true,
    duplicateOpenRejected:true,navigationFailureRetainsSession:true,peerSurvives:true,disconnectPreservesCreatedTab:true},null,2));
  console.log('Fresh-tab evidence: '+f.evidence);
});
