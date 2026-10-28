import test from 'node:test';
import assert from 'node:assert/strict';
import {popupApp} from './fixtures/popup-app.mjs';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {eventually} from './helpers/native-browser.mjs';

const enabled=!!(process.env.QA_BROWSER_PLAYWRIGHT_MODULE&&process.env.QA_BROWSER_CHROME&&process.env.QA_BROWSER_OFFICIAL_EXTENSION)&&process.platform==='darwin';
test('headless real Chrome: existing authenticated tabs for two official CLI sessions',{skip:!enabled,timeout:180000},async t=>{
 const app=await popupApp();let f;t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,'official');
 await Promise.all([f.connect(0,f.tabs[0]),f.connect(1,f.tabs[1])]);
 for(const [index,label]of [[0,'first'],[1,'second']]){
  const result=valueOf(await f.pw(index,['run-code',`async(page)=>{await page.bringToFront();await page.locator('#value').fill(${JSON.stringify(label)});await page.locator('#save').click();return {actor:await page.locator('#actor').innerText(),result:await page.locator('#result').innerText()}}`]));
  assert.equal(result.actor,f.run+(index?':b':':a'));assert.equal(result.result,'Saved '+label);
  await eventually(()=>f.states().some(s=>s.actor===result.actor&&s.result===result.result&&s.signedIn&&s.marker==='pre-existing'));
 }
 await f.latch(0,['release','--session','agent','--tab',String(f.tabs[0])]);
 assert.equal(valueOf(await f.pw(1,['run-code',"async(page)=>await page.locator('#result').innerText()"])),'Saved second');
 await f.latch(0,['disconnect','--session','agent']);await f.latch(1,['disconnect','--session','agent']);
 const tabs=(await f.latch(0,['tabs'])).tabs;assert.ok(tabs.some(tab=>tab.tabId===f.tabs[0]));assert.ok(tabs.some(tab=>tab.tabId===f.tabs[1]));assert.ok(tabs.every(tab=>tab.owner===null));
});
