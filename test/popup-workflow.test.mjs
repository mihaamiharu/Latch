import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {popupApp} from './fixtures/popup-app.mjs';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {eventually} from './helpers/native-browser.mjs';
import {sessionKey} from '../src/playwright.mjs';

const enabled=process.env.LATCH_POPUP_WORKFLOW==='1'&&process.platform==='darwin';
const identify=`const c=await child.context().newCDPSession(child);let targetId;try{targetId=(await c.send('Target.getTargetInfo')).targetInfo.targetId}finally{await c.detach()}`;

test('native popup ownership: concurrent parents, standard events, redirects and surviving children',{skip:!enabled,timeout:180000},async t=>{
  const app=await popupApp();let f;t.after(async()=>{await f?.close();await app.close();});
  f=await attachmentFixture(t,app,'native');
  await Promise.all([f.connect(0,f.tabs[0],{background:true}),f.connect(1,f.tabs[1],{background:true})]);
  const outcomes=[];
  // The fixture omits allow-popups on a sandboxed frame. Chrome must deny its
  // popup; no content setting or user-profile permission is changed.
  const blocked=valueOf(await f.pw(0,['run-code',`async(page)=>{
    const waiting=page.waitForEvent('popup',{timeout:1200}).then(()=>true,()=>false);
    await page.locator('#blocked').click();
    await page.locator('body[data-blocked-popup]').waitFor();
    return {denied:(await page.locator('body').getAttribute('data-blocked-popup'))==='yes',observed:await waiting,actor:await page.locator('#actor').innerText()}
  }`]));
  assert.deepEqual(blocked,{denied:true,observed:false,actor:f.run+':a'});
  assert.equal((await f.connect(0,f.tabs[0])).targets.length,1);
  outcomes.push({case:'sandbox-blocked popup leaves parent usable and ownership unchanged',outcome:'passed'});
  const open=async(index,selector,{close=true,optional=false,foreground=false}={})=>valueOf(await f.pw(index,['run-code',
    `async(page)=>{${foreground?'await page.bringToFront();':''}const wait=page.waitForEvent('popup',{timeout:${optional?2000:10000}}).catch(e=>{${optional?'return null':'throw e'}});await page.locator(${JSON.stringify(selector)}).click();const child=await wait;if(!child)return {observed:false};${optional?'if(child.isClosed())return {observed:true,closed:true};':''}await child.waitForLoadState('domcontentloaded');${identify};const result={observed:true,actor:await child.locator('#actor').innerText(),role:await child.locator('#role').innerText(),url:child.url(),targetId};${close?'await child.close();':''}return result}`]));
  const [a,b]=await Promise.all([open(0,'#window',{close:false}),open(1,'#window',{close:false})]);
  assert.equal(a.actor,f.run+':a');assert.equal(b.actor,f.run+':b');assert.equal(a.url,b.url);assert.notEqual(a.targetId,b.targetId);
  outcomes.push({case:'concurrent same-URL popups',outcome:'passed'});
  const owned=await f.connect(0,f.tabs[0]);
  const childA=owned.targets.find(tab=>tab.targetId===a.targetId);
  assert.ok(childA);assert.equal(childA.openerTabId,f.tabs[0]);
  const conflict=await f.latch(2,['connect','--transport','native','--session','agent','--tab',String(childA.tabId)],{fail:true});
  assert.equal(conflict.error.code,'TAB_OWNED');
  const childConnection=await f.connect(0,childA.tabId);
  assert.equal(childConnection.page.targetId,a.targetId);
  assert.equal(valueOf(await f.pw(0,['run-code',"async(page)=>await page.locator('#role').innerText()"])), '/child');
  const released=await f.latch(0,['release','--session','agent','--tab',String(childA.tabId)]);
  assert.equal(released.sessionClosed,false);
  await f.connect(0,f.tabs[0]);
  await f.pw(1,['run-code',`async(page)=>{for(const p of page.context().pages())if(p!==page&&p.url().split('#')[0].split('?')[0].endsWith('/child'))await p.close()}`]);
  const before=await f.latch(0,['tabs']);
  assert.equal(before.tabs.find(tab=>tab.tabId===childA.tabId).owner,null);
  // Updating a released child must not automatically claim it again.
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal((await f.latch(0,['tabs'])).tabs.find(tab=>tab.tabId===childA.tabId).owner,null);
  outcomes.push({case:'explicit child selection and release preserves parent/peer',outcome:'passed'});
  for(const selector of ['#blank','#window','#delayed','#cross','#noopener']){
    const result=await open(0,selector,{optional:selector==='#noopener',foreground:true});
    if(!result.observed){
      assert.equal(selector,'#noopener');
      const list=(await f.latch(0,['tabs'])).tabs;
      assert.ok(list.some(tab=>tab.url===app.origin+'/child'&&tab.owner===null));
      outcomes.push({case:selector,outcome:'limited',reason:'Chrome supplied no attributable opener; tab left unclaimed'});
    }else{
      assert.equal(result.actor,f.run+':a');assert.equal(result.role,'/child');
      outcomes.push({case:selector,outcome:'passed'});
    }
  }
  console.log('Popup links, redirects and ownership checks complete.');
  const auth=valueOf(await f.pw(0,['run-code',"async(page)=>{await page.bringToFront();const wait=page.waitForEvent('popup',{timeout:10000});await page.locator('#auth').click();const child=await wait;await child.waitForEvent('close',{timeout:10000});await page.locator('#result').filter({hasText:'Authenticated'}).waitFor();return await page.locator('#result').innerText()} "]));
  assert.equal(auth,'Authenticated');outcomes.push({case:'authentication-style self-close',outcome:'passed'});
  await open(0,'#fast',{optional:true,foreground:true});
  assert.equal(valueOf(await f.pw(0,['run-code',"async(page)=>await page.locator('#actor').innerText()"])),f.run+':a');
  outcomes.push({case:'immediate child close preserves parent',outcome:'passed'});
  const nested=valueOf(await f.pw(0,['run-code',`async(page)=>{await page.bringToFront();let waiting=page.waitForEvent('popup');await page.locator('#window').click();const child=await waiting;await child.waitForLoadState('domcontentloaded');waiting=child.waitForEvent('popup');await child.locator('#nested').click();const last=await waiting;await last.waitForLoadState('domcontentloaded');const c=await last.context().newCDPSession(last);let targetId;try{targetId=(await c.send('Target.getTargetInfo')).targetInfo.targetId}finally{await c.detach()}await child.close();return {targetId,role:await last.locator('#role').innerText()}}`]));
  assert.equal(nested.role,'/nested');
  await f.pw(0,['run-code','async(page)=>await page.close()']);
  const inventory=(await f.latch(0,['tabs'])).tabs;
  const nestedTab=inventory.find(tab=>tab.owner===sessionKey(f.workspaces[0],'agent')&&tab.url===app.origin+'/nested');
  assert.ok(nestedTab);
  const survivor=await f.connect(0,nestedTab.tabId);
  assert.equal(survivor.page.targetId,nested.targetId);
  await f.pw(0,['snapshot',`--filename=${path.join(f.evidence,'surviving-child.yaml')}`]);
  await f.pw(0,['screenshot',`--filename=${path.join(f.evidence,'surviving-child.png')}`]);
  outcomes.push({case:'nested child survives both parent and starting-tab closure',outcome:'passed'});
  assert.equal(valueOf(await f.pw(1,['run-code',"async(page)=>await page.locator('#actor').innerText()"])),f.run+':b');
  await f.latch(0,['disconnect','--session','agent']);
  await f.latch(1,['disconnect','--session','agent']);
  const after=(await f.latch(0,['tabs'])).tabs;
  assert.ok(after.some(tab=>tab.tabId===nestedTab.tabId&&tab.owner===null));
  assert.ok(after.some(tab=>tab.tabId===f.tabs[2]&&tab.owner===null));
  assert.ok(!after.some(tab=>tab.owner));
  await fs.writeFile(path.join(f.evidence,'report.json'),JSON.stringify({outcome:'passed',transport:'native',headless:f.headless,launchArgs:f.launchArgs,versions:f.versions,realNativeMessaging:true,
    focusEmulation:true,focusPolicy:'concurrent opening uses focus emulation; sequential popup cases explicitly foreground the parent',officialExtensionInstalled:false,runtimeRemoteDebugging:false,outcomes,
    cleanupPreservedRemainingTabs:true,limits:{ownedTabs:16,popupDepth:4},
    notCovered:['frames and files','large payloads','restart recovery','installed Work rollout']},null,2));
  await f.close();console.log(`Popup workflow passed; evidence: ${f.evidence}`);
});
