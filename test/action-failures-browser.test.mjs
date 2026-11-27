import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {actionApp} from './fixtures/action-app.mjs';
import {attachmentFixture, valueOf} from './helpers/attachment-fixture.mjs';
import {command, eventually} from './helpers/native-browser.mjs';
import {suiteGate} from './helpers/browser-suite.mjs';

test('action failure diagnostics: native', {skip: suiteGate('LATCH_ACTION_FAILURES'), timeout: 180000}, async t => {
  const app = await actionApp();
  app.recovery = true;
  let f;
  t.after(async () => {
    await f?.close();
    await app.close();
  });
  f = await attachmentFixture(t, app, 'native');
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const pw = async (args, fail = false) => {
    const r = await command(
      process.execPath,
      [cli, ...args, '--profile', 'work', '--session', 'agent', '--workspace', f.workspaces[0], '--json'],
      {cwd: f.workspaces[0], env: f.env},
    );
    const data = JSON.parse(r.out || r.err);
    assert.equal(r.code, fail ? 1 : 0, JSON.stringify(data));
    return data.ok === false ? data : {...data, result: JSON.stringify(data.value)};
  };
  const configBefore = await fs.readFile(f.env.LATCH_CONFIG, 'utf8');
  const report = {...f.evidenceRecord, transport: 'native', versions: f.versions};
  const off = await f.connect(0, f.tabs[0], {background: false});
  assert.equal(off.focusEmulation, false);
  // v1.1 removed the FOCUS_EMULATION_DISABLED warning; focus emulation now defaults on.
  report.focusOff = {focusEmulation: off.focusEmulation, warnings: off.warnings};
  const probe = await f.pw(0, [
    'run-code',
    'async(page)=>{const editor=page.locator(".cm-content").first();const state={count:await editor.count(),visible:await editor.isVisible(),enabled:await editor.isEnabled(),...await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus()}))};try{await editor.click({trial:true,timeout:1500});return {...state,trial:"passed"}}catch(e){return {...state,trial:"failed",error:e.message}}}',
  ]);
  report.backgroundTrial = valueOf(probe);
  assert.equal(report.backgroundTrial.count, 1);
  assert.equal(app.receipts.length, 0);
  await f.latch(0, ['disconnect', '--session', 'agent']);
  const on = await f.connect(0, f.tabs[0], {background: true});
  assert.equal(on.focusEmulation, true);
  assert.ok(!on.warnings.some(w => w.code === 'FOCUS_EMULATION_DISABLED'));

  // A script asking for Save must fail even though the real button is present.
  const wrong = await pw(['run-code', 'async(page)=>page.getByRole("button",{name:"Save",exact:true}).click({timeout:1200})'], true);
  // v1.1 classifies a locator that never resolves as ACTION_TIMEOUT.
  assert.equal(wrong.error.code, 'ACTION_TIMEOUT');
  assert.match(wrong.error.message, /timed out|Timeout/i);
  assert.equal(app.receipts.length, 0);
  report.wrongLocator = wrong;
  const saved = valueOf(
    await pw([
      'run-code',
      'async(page)=>{await page.locator(".cm-content").first().click({timeout:5000});await page.getByRole("textbox",{name:"Outline"}).fill("Verified once");await page.getByRole("button",{name:"Update Test Case",exact:true}).click({timeout:5000});await page.getByText("Saved Verified once",{exact:true}).waitFor();return {result:await page.locator("#result").innerText(),url:page.url()}}',
    ]),
  );
  assert.equal(saved.result, 'Saved Verified once');
  await eventually(() => app.receipts.length === 1);
  assert.deepEqual(app.receipts, [{actor: f.run + ':a', value: 'Verified once', sequence: 1}]);
  report.save = saved;
  report.receipts = app.receipts;
  await pw(['screenshot', '--out', path.join(f.evidence, 'saved.png')]);
  await fs.writeFile(path.join(f.evidence, 'saved.yaml'), (await pw(['snapshot'])).snapshot || '');
  await f.latch(0, ['disconnect', '--session', 'agent']);
  const retired = await pw(['snapshot'], true);
  assert.ok(['SESSION_STALE', 'SESSION_UNAVAILABLE'].includes(retired.error.code));
  assert.equal(app.receipts.length, 1);
  assert.equal(await fs.readFile(f.env.LATCH_CONFIG, 'utf8'), configBefore);
  const tabs = (await f.latch(0, ['tabs'])).tabs;
  assert.ok(tabs.some(tab => tab.tabId === f.tabs[0] && !tab.owner));
  report.cleanupPreservedTabs = true;
  await fs.writeFile(path.join(f.evidence, 'action-failures.json'), JSON.stringify(report, null, 2));
  console.log('Action diagnostics evidence: ' + f.evidence);
});
