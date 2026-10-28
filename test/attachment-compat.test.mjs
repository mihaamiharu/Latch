import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {popupApp} from './fixtures/popup-app.mjs';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {eventually} from './helpers/native-browser.mjs';

const enabled=process.env.LATCH_ATTACHMENT_COMPAT==='1'&&process.platform==='darwin';
for(const transport of ['official','native'])test(`real attachment comparison: ${transport} basic QA and popup`,{skip:!enabled,timeout:180000},async t=>{
  const app=await popupApp();let f;t.after(async()=>{await f?.close();await app.close();});
  f=await attachmentFixture(t,app,transport);
  const connection=await f.connect(0,f.tabs[0]);
  // Foreground is explicit for both comparison paths. Native-specific
  // background/focus-emulation checks live in the concurrent ownership suite.
  const basic=valueOf(await f.pw(0,['run-code',"async(page)=>{await page.bringToFront();await page.locator('#value').fill('Parity');await page.locator('#save').click();return {result:await page.locator('#result').innerText(),actor:await page.locator('#actor').innerText()}}"]));
  assert.equal(basic.result,'Saved Parity');assert.equal(basic.actor,f.run+':a');
  await f.pw(0,['snapshot',`--filename=${path.join(f.evidence,'root.yaml')}`]);
  await f.pw(0,['screenshot',`--filename=${path.join(f.evidence,'root.png')}`]);
  const popup=valueOf(await f.pw(0,['run-code',"async(page)=>{await page.bringToFront();const waiting=page.waitForEvent('popup',{timeout:30000});await page.locator('#window').click();const child=await waiting;await child.waitForLoadState('domcontentloaded');return {url:child.url(),actor:await child.locator('#actor').innerText(),role:await child.locator('#role').innerText()}}"]));
  assert.equal(popup.role,'/child');assert.equal(popup.actor,f.run+':a');
  await eventually(()=>f.states().some(s=>s.role==='/child'&&s.actor===f.run+':a'));
  await f.latch(0,['disconnect','--profile','work','--session','agent']);
  const remaining=(await f.latch(0,['tabs'])).tabs;
  assert.ok(remaining.some(tab=>tab.tabId===f.tabs[0]));assert.ok(remaining.some(tab=>tab.url===app.origin+'/child'));
  assert.ok(remaining.every(tab=>tab.owner===null));
  const result={adapter:transport,outcome:'passed',versions:f.versions,realNativeMessaging:true,runtimeRemoteDebugging:false,
    fixtureAuthorizationSetup:transport==='official'?'isolated pre-provisioning using Playwright, closed before runtime':'not needed',
    focusPolicy:'explicit foreground for both adapters',basic:{result:basic.result},popup:{role:popup.role},cleanupPreservedTabs:true};
  await fs.writeFile(path.join(f.evidence,'report.json'),JSON.stringify(result,null,2));
  await f.close();
  console.log(`${transport} baseline and popup passed.`);
});
