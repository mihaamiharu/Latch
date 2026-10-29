import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {actionApp} from './fixtures/action-app.mjs';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {command,eventually} from './helpers/native-browser.mjs';

const enabled=process.env.LATCH_ACTION_FAILURES==='1'&&process.platform==='darwin';
for(const transport of ['official','native'])test(`action failure diagnostics: ${transport}`,{skip:!enabled,timeout:180000},async t=>{
  const app=await actionApp();if(transport==='native')app.recovery=true;
  else app.artifactExtension=new URL('../dist/latch/',import.meta.url).pathname;
  let f;
  t.after(async()=>{await f?.close();await app.close()});f=await attachmentFixture(t,app,transport);
  const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
  const pw=async(args,fail=false)=>{
    const r=await command(process.execPath,[cli,'pw','--profile','work','--session','agent','--workspace',f.workspaces[0],'--',...args],{cwd:f.workspaces[0],env:f.env});
    const data=JSON.parse(r.out||r.err);assert.equal(r.code,fail?1:0,JSON.stringify(data));return data;
  };
  const configBefore=await fs.readFile(f.env.QA_BROWSER_CONFIG,'utf8'),report={transport,headless:f.headless,launchArgs:f.launchArgs,versions:f.versions};
  if(transport==='official'){
    const doctor=await f.latch(0,['doctor']);assert.equal(doctor.attachment.verified,false);
    const diagnosis=await f.latch(0,['diagnose']);assert.equal(diagnosis.healthy,true);assert.equal(diagnosis.layers.officialAttachment,'not-checked');
    const token=f.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;f.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN=crypto.randomUUID();
    const failure=await f.latch(0,['connect','--session','agent','--tab',String(f.tabs[0])],{fail:true});
    f.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN=token;
    assert.equal(failure.error.code,'EXTENSION_CONNECTION_FAILED');assert.equal(failure.error.diagnostics.transport,'official');assert.equal(failure.error.diagnostics.transportSource,'legacy-default');assert.equal(failure.error.diagnostics.attachmentVerified,false);assert.equal(failure.error.diagnostics.nativeAvailable,true);
    assert.match(failure.error.diagnostics.upstreamError,/did not connect within/);assert.ok(failure.error.diagnostics.elapsedMs>=29000);
    assert.ok(!JSON.stringify(failure).includes(token));assert.ok(!JSON.stringify(failure).includes('mcpRelayUrl='));report.attachFailure=failure;
    await f.connect(0,f.tabs[0]);
    await pw(['run-code','async(page)=>{await page.bringToFront();return page.title()}']);
  }else{
    const off=await f.connect(0,f.tabs[0]);assert.equal(off.focusEmulation,false);assert.ok(off.warnings.some(w=>w.code==='FOCUS_EMULATION_DISABLED'));
    report.focusOff=off.warnings;
    const probe=await f.pw(0,['run-code','async(page)=>{const editor=page.locator(".cm-content").first();const state={count:await editor.count(),visible:await editor.isVisible(),enabled:await editor.isEnabled(),...await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus()}))};try{await editor.click({trial:true,timeout:1500});return {...state,trial:"passed"}}catch(e){return {...state,trial:"failed",error:e.message}}}']);
    report.backgroundTrial=valueOf(probe);assert.equal(report.backgroundTrial.count,1);assert.equal(app.receipts.length,0);
    await f.latch(0,['disconnect','--session','agent']);
    const on=await f.connect(0,f.tabs[0],{background:true});assert.equal(on.focusEmulation,true);assert.ok(!on.warnings.some(w=>w.code==='FOCUS_EMULATION_DISABLED'));
  }
  // A script asking for Save must fail even though the real button is present.
  const wrong=await pw(['run-code','async(page)=>page.getByRole("button",{name:"Save",exact:true}).click({timeout:1200})'],true);
  assert.equal(wrong.error.code,'PLAYWRIGHT_ERROR');assert.match(wrong.error.diagnostics.upstreamError,/Timeout/);assert.equal(app.receipts.length,0);report.wrongLocator=wrong;
  const saved=valueOf(await pw(['run-code','async(page)=>{await page.locator(".cm-content").first().click({timeout:5000});await page.getByRole("textbox",{name:"Outline"}).fill("Verified once");await page.getByRole("button",{name:"Update Test Case",exact:true}).click({timeout:5000});await page.getByText("Saved Verified once",{exact:true}).waitFor();return {result:await page.locator("#result").innerText(),url:page.url()}}']));
  assert.equal(saved.result,'Saved Verified once');await eventually(()=>app.receipts.length===1);assert.deepEqual(app.receipts,[{actor:f.run+':a',value:'Verified once',sequence:1}]);report.save=saved;report.receipts=app.receipts;
  await pw(['screenshot',`--filename=${path.join(f.evidence,'saved.png')}`]);await pw(['snapshot',`--filename=${path.join(f.evidence,'saved.yaml')}`]);
  await f.latch(0,['disconnect','--session','agent']);
  const retired=await pw(['snapshot'],true);assert.ok(['SESSION_STALE','SESSION_UNAVAILABLE'].includes(retired.error.code));assert.equal(app.receipts.length,1);
  assert.equal(await fs.readFile(f.env.QA_BROWSER_CONFIG,'utf8'),configBefore);const tabs=(await f.latch(0,['tabs'])).tabs;assert.ok(tabs.some(tab=>tab.tabId===f.tabs[0]&&!tab.owner));report.cleanupPreservedTabs=true;
  await fs.writeFile(path.join(f.evidence,'action-failures.json'),JSON.stringify(report,null,2));console.log('Action diagnostics evidence: '+f.evidence);
});
