import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';

test('headless official alternative: fresh tab, profile auth reuse, navigation and independent sessions', {
  skip:process.env.LATCH_OFFICIAL_ALTERNATIVE !== '1' || process.platform !== 'darwin', timeout:150000,
},async t=>{
  const app=await evidenceApp();let f;t.after(async()=>{await f?.close();await app.close()});
  f=await attachmentFixture(t,app,'official');
  await f.connect(0,f.tabs[0]);await f.connect(1,f.tabs[1]);
  await f.pw(0,['run-code','async(page)=>page.evaluate(()=>localStorage.setItem("alternative-auth","synthetic-login"))']);
  await f.pw(0,['tab-new',app.origin+'/root#'+encodeURIComponent(f.run+':official-fresh')]);
  assert.deepEqual(valueOf(await f.pw(0,['run-code','async(page)=>({actor:await page.locator("#actor").innerText(),auth:await page.evaluate(()=>localStorage.getItem("alternative-auth"))})'])),{actor:f.run+':official-fresh',auth:'synthetic-login'});
  await f.pw(0,['goto',app.origin+'/next']);
  assert.equal(valueOf(await f.pw(1,['run-code','async(page)=>await page.locator("#actor").innerText()'])),f.run+':b');
  await f.latch(0,['disconnect','--session','agent']);
  assert.equal(valueOf(await f.pw(1,['run-code','async(page)=>await page.locator("#actor").innerText()'])),f.run+':b');
  await fs.writeFile(path.join(f.evidence,'official-alternative-result.json'),JSON.stringify({headless:true,versions:f.versions,
    launchArgs:f.launchArgs,officialExtensionVersion:'0.4.0',latchUsedForFixtureBootstrap:true,
    tabNewThroughOrdinaryPlaywrightCLI:true,syntheticLoginReused:true,navigation:true,independentSessions:true,
    noClaimForLatestOfficialExtension:true,backgroundModeNotTested:true,actualSignedInWorkProfileNotTested:true},null,2));
  console.log('Official alternative evidence: '+f.evidence);
});
