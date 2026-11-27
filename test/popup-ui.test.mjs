import {CANDIDATE_KIT} from './helpers/candidate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {attachmentFixture, valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';
import {eventually, command} from './helpers/native-browser.mjs';
import {suiteGate} from './helpers/browser-suite.mjs';
import {sessionKey} from '../src/redact.mjs';

// The real built popup page (dist/latch-<version>/extension), driven over the
// fixture's private debugger injector. Requires `npm run build` first.
const skip = suiteGate('LATCH_POPUP_UI');
const wait = `async function poll(fn){const end=Date.now()+8000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Popup condition timed out')}`;
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const popupApp = async extra => {
  const app = await evidenceApp();
  Object.assign(app, {recovery: true, popup: true, artifactExtension: path.join(CANDIDATE_KIT, 'extension')}, extra);
  return app;
};
const shot = (f, name, result) => fs.writeFile(path.join(f.evidence, name), Buffer.from(result.screenshot, 'base64'));
const refreshText = `(async()=>{document.querySelector('#refresh').click();await new Promise(r=>setTimeout(r,100));return document.body.innerText})()`;

test('real popup page shows paired sessions, saves the finish setting, and stops only the selected agent through the host', {skip, timeout: 150000}, async t => {
  const app = await popupApp();
  let f;
  t.after(async () => { await f?.close(); await app.close(); });
  f = await attachmentFixture(t, app, 'native');
  const view = (expression, screenshot) => f.fault('popup', {expression, screenshot});

  const empty = await view(`(async()=>{${wait};await poll(()=>document.querySelector('#empty').textContent.includes('No active'));return document.body.innerText})()`, true);
  assert.match(empty.value, /Paired profile: work/);
  await shot(f, 'popup-empty.png', empty);

  const focus = await view(`document.querySelector('#refresh').focus();document.activeElement.id`);
  assert.equal(focus.value, 'refresh');
  const tabbed = await f.fault('popup', {expression: 'document.activeElement.tagName+"#"+document.activeElement.id', key: 'Tab'});
  assert.notEqual(tabbed.value, 'BUTTON#refresh', 'Tab must move focus off Refresh');

  // "On session finish" defaults to collapse and persists a change.
  const finish = await view(`(async()=>{${wait};const s=document.querySelector('#finish-behavior');await poll(()=>document.querySelector('#finish-hint').textContent);const initial=s.value;s.value='close';s.dispatchEvent(new Event('change'));await poll(()=>document.querySelector('#notice').textContent.includes('On session finish'));return {initial,notice:document.querySelector('#notice').textContent,hint:document.querySelector('#finish-hint').textContent}})()`, true);
  assert.equal(finish.value.initial, 'collapse');
  assert.match(finish.value.notice, /Close Latch-opened tabs/);
  assert.match(finish.value.hint, /never closed/);
  await shot(f, 'popup-finish-setting.png', finish);
  const reopened = await view(`(async()=>{${wait};await poll(()=>document.querySelector('#finish-behavior').value==='close');const s=document.querySelector('#finish-behavior');s.value='collapse';s.dispatchEvent(new Event('change'));return 'close'})()`);
  assert.equal(reopened.value, 'close');

  await f.connect(0, f.tabs[0]);
  await f.connect(1, f.tabs[1], {background: true});
  const loaded = await view(`(async()=>{${wait};document.querySelector('#refresh').click();await poll(()=>document.querySelectorAll('.task').length===2);return {text:document.body.innerText,keys:[...document.querySelectorAll('.task')].map(t=>t.dataset.key)}})()`, true);
  assert.match(loaded.value.text, /agent/);
  await shot(f, 'popup-agents.png', loaded);

  await f.pw(0, ['run-code', `async(page)=>page.evaluate(()=>{document.title='<img src=x onerror=alert(1)> '+ 'Long-title-'.repeat(50);history.replaceState(null,'','?privateQuery=DO_NOT_DISPLAY'+location.hash)})`]);
  const long = await view(`(async()=>{${wait};document.body.style.width='320px';document.querySelector('#refresh').click();await poll(()=>document.querySelector('.task li')?.textContent.includes('<img'));return {text:document.body.innerText,markup:document.querySelectorAll('.task img').length,overflow:document.body.scrollWidth>320,live:document.querySelector('#notice').getAttribute('aria-live')}})()`, true);
  assert.equal(long.value.markup, 0);
  assert.equal(long.value.overflow, false);
  assert.equal(long.value.live, 'polite');
  assert.ok(!long.value.text.includes('DO_NOT_DISPLAY'));
  await shot(f, 'popup-long-narrow.png', long);
  await view(`document.body.style.width='390px'`);

  // A stale popup row (session replaced after render) must not stop the successor.
  const key = sessionKey(f.workspaces[0], 'agent');
  const status = `(async()=>{${wait};document.querySelector('#refresh').click();await poll(()=>document.querySelector('[data-key="${key}"] button.stop'));const r=await chrome.runtime.sendMessage({type:'ui',op:'status'});return r.result.sessions.find(s=>s.key==='${key}')})()`;
  const before = (await view(status)).value;
  await f.latch(0, ['disconnect', '--session', 'agent']);
  await f.connect(0, f.tabs[0]);
  await view(status);
  const stale = await view(`chrome.runtime.sendMessage({type:'ui',op:'revoke',payload:${JSON.stringify({key, leaseId: before.leaseId, revision: before.revision, hostGeneration: before.hostGeneration})}})`);
  assert.equal(stale.value.error?.code, 'AUTHORITY_STALE');
  assert.equal(valueOf(await f.pw(0, ['run-code', 'async(page)=>page.locator("#actor").innerText()'])), f.run + ':a');

  // v1.1: Stop while an action is in flight is refused (SESSION_BUSY, nothing
  // stopped) and the popup says so; Stop after the action ends succeeds.
  // The action is finite (6s): a never-settling action hits the 40s action
  // deadline, after which v1.1 tears the session down on its own.
  const holding = command(process.execPath, [cli, 'run-code', 'async(page)=>page.evaluate(async()=>{await fetch("/event?op=popup-commit&n=1");await new Promise(r=>setTimeout(r,6000));return "held"})', '--session', 'agent', '--workspace', f.workspaces[0], '--json'], {cwd: f.workspaces[0], env: f.env});
  let heldEarly;
  holding.then(r => { heldEarly = r; });
  await eventually(() => {
    if (app.receipts.some(r => r.operation === 'popup-commit')) return true;
    if (heldEarly) throw new Error('Held action ended before reaching the page: ' + (heldEarly.out || heldEarly.err));
  });
  await view(`(async()=>{${wait};document.querySelector('#refresh').click();await new Promise(r=>setTimeout(r,600));await poll(()=>document.querySelector('[data-key="${key}"] button.stop:not([disabled])'));document.querySelector('[data-key="${key}"] button.stop').click();return 'clicked'})()`);
  const held = await holding;
  assert.equal(held.code, 0, held.out || held.err);
  assert.equal(JSON.parse(held.out).value, 'held');
  const stopped = await eventually(async () => {
    const r = await view(`(async()=>{const n=document.querySelector('#notice').textContent;return /^(|Stopping automation…)$/.test(n)?'':n})()`, true);
    return r.value && r;
  }, 20000);
  // The in-flight action made the first Stop a no-op, and the popup says so.
  assert.match(stopped.value, /This task is busy\. No access was stopped/);
  await shot(f, 'popup-busy.png', stopped);
  await view(`(async()=>{${wait};document.querySelector('#notice').textContent='';document.querySelector('#refresh').click();await new Promise(r=>setTimeout(r,600));await poll(()=>document.querySelector('[data-key="${key}"] button.stop:not([disabled])'));document.querySelector('[data-key="${key}"] button.stop').click();return 'clicked'})()`);
  const finished = await eventually(async () => {
    const r = await view(`(async()=>{const n=document.querySelector('#notice').textContent;return /^(|Stopping automation…)$/.test(n)?'':n})()`, true);
    return r.value && r;
  }, 40000);
  assert.match(finished.value, /Session stopped\. Your tabs are still open/);
  assert.equal(app.receipts.filter(r => r.operation === 'popup-commit').length, 1);
  await shot(f, 'popup-stopped.png', finished);

  assert.equal(valueOf(await f.pw(1, ['run-code', 'async(page)=>page.locator("#actor").innerText()'])), f.run + ':b');
  const tabs = (await f.latch(0, ['tabs'])).tabs;
  assert.ok(f.tabs.every(id => tabs.some(t => t.tabId === id)));
  assert.equal(tabs.find(t => t.tabId === f.tabs[0]).owner, null);
  assert.equal((await f.fault('spoof-ui')).rejected, true);

  // Bridge loss: suspend the test host and end its process; the popup reports
  // offline, then degraded, and reconnects only after an explicit Retry.
  await f.latch(1, ['disconnect', '--session', 'agent']);
  const {nativeHostPID} = await import('./helpers/evidence-resources.mjs');
  await f.suspendHost();
  process.kill(await nativeHostPID(f.browserPID), 'SIGTERM');
  const offline = await eventually(async () => {
    const result = await view(refreshText, true);
    return result.value.includes('Local bridge disconnected') && result;
  }, 10000);
  await shot(f, 'popup-offline.png', offline);
  const degraded = await eventually(async () => {
    const result = await view(refreshText, true);
    return result.value.includes('Needs attention') && result;
  }, 45000);
  await shot(f, 'popup-degraded.png', degraded);
  await f.restoreHost();
  await view(`document.querySelector('#retry').click()`);
  await eventually(async () => {
    const result = await view(refreshText);
    return result.value.includes('Local bridge connected') && result.value.includes('No active agent sessions');
  }, 15000);

  await fs.writeFile(path.join(f.evidence, 'popup-report.json'), JSON.stringify({
    ...f.evidenceRecord, versions: f.versions, artifactManifestUnmodified: true, paired: true, finishSettingDefault: 'collapse',
    finishSettingPersists: true, staleRevokeRejected: true, stopDuringActionRefusedBusy: true, inFlightActionCompleted: true, mutationReceipts: 1, peerPreserved: true,
    tabsPreserved: true, webOrForeignProxyRejected: true, longTextEscaped: true, narrowLayout: true, offlineAndDegraded: true,
    explicitRetryNoAutomation: true,
    notCovered: ['toolbar bubble placement (headless)', 'tab-group collapse rendering (headless)'],
  }, null, 2));
  console.log('Popup UI: ' + f.evidence);
});

for (const kind of ['unsupported', 'cleanup-unconfirmed']) test(`popup ${kind} state is truthful`, {skip, timeout: 90000}, async t => {
  const app = await popupApp({uiUnsupported: kind === 'unsupported', popupCleanupFault: kind === 'cleanup-unconfirmed'});
  let f;
  t.after(async () => { await f?.close(); await app.close(); });
  f = await attachmentFixture(t, app, 'native');
  if (kind === 'cleanup-unconfirmed') await f.connect(0, f.tabs[0]);
  const result = await f.fault('popup', {screenshot: true, expression: `(async()=>{${wait};${kind === 'unsupported'
    ? "await poll(()=>document.querySelector('#empty').textContent.includes('Update the matching'))"
    : "await poll(()=>document.querySelector('button.stop'));document.querySelector('button.stop').click();await poll(()=>document.querySelector('#notice').textContent.includes('cleanup is unconfirmed'))"};return document.body.innerText})()`});
  await shot(f, 'popup-' + kind + '.png', result);
  if (kind === 'cleanup-unconfirmed') {
    // Access is cut (the session relay stopped) even though cleanup is unconfirmed.
    assert.match(result.value, /Access stopped\. CLI cleanup is unconfirmed/);
    const after = await f.pw(0, ['run-code', 'async(page)=>1'], {fail: true});
    assert.equal(after.ok, false);
  }
  await fs.writeFile(path.join(f.evidence, 'popup-state.json'), JSON.stringify({...f.evidenceRecord, state: kind, controlledHostFault: !!app.popupCleanupFault, capabilityFixture: !!app.uiUnsupported}, null, 2));
  console.log('Popup state: ' + f.evidence);
});

test('closing the popup after host acceptance does not cancel cleanup or revoke a successor', {skip, timeout: 90000}, async t => {
  const app = await popupApp({popupPauseCleanup: true});
  let f;
  t.after(async () => { if (f) await fs.unlink(f.popupPause).catch(() => {}); await f?.close(); await app.close(); });
  f = await attachmentFixture(t, app, 'native');
  await f.connect(0, f.tabs[0]);
  await f.connect(1, f.tabs[1], {background: true});
  const key = sessionKey(f.workspaces[0], 'agent');
  const view = expression => f.fault('popup', {expression});
  const old = (await view(`(async()=>{${wait};await poll(()=>document.querySelectorAll('.task').length===2);const r=await chrome.runtime.sendMessage({type:'ui',op:'status'});return r.result.sessions.find(s=>s.key==='${key}')})()`)).value;
  await fs.writeFile(f.popupPause, 'private test pause');
  await view(`document.querySelector('[data-key="${key}"] button.stop').click();'requested'`);
  await eventually(() => fs.stat(f.popupBarrier));
  assert.equal((await f.fault('close-popup')).closed, 1);
  await fs.unlink(f.popupPause);
  const reopened = await eventually(async () => {
    const r = await f.fault('popup', {screenshot: true, expression: `(async()=>{${wait};document.querySelector('#refresh').click();await poll(()=>document.querySelectorAll('.task').length===1);return !document.querySelector('[data-key="${key}"]')})()`}).catch(() => null);
    return r?.value === true && r;
  }, 20000);
  await shot(f, 'popup-reopened-after-close.png', reopened);
  assert.equal(valueOf(await f.pw(1, ['run-code', 'async(page)=>page.locator("#actor").innerText()'])), f.run + ':b');
  await f.connect(0, f.tabs[0]);
  const stale = (await view(`chrome.runtime.sendMessage({type:'ui',op:'revoke',payload:${JSON.stringify({key, leaseId: old.leaseId, revision: old.revision, hostGeneration: old.hostGeneration})}})`)).value;
  assert.equal(stale.error.code, 'AUTHORITY_STALE');
  assert.equal(valueOf(await f.pw(0, ['run-code', 'async(page)=>page.locator("#actor").innerText()'])), f.run + ':a');
  const tabs = (await f.latch(0, ['tabs'])).tabs;
  assert.ok(f.tabs.every(id => tabs.some(t => t.tabId === id)));
  await fs.writeFile(path.join(f.evidence, 'popup-closure.json'), JSON.stringify({
    ...f.evidenceRecord, versions: f.versions, controlledPauseAfterRevocation: true, popupClosedAfterAcceptance: true, cleanupFinished: true,
    reopenedStatusAccurate: true, peerPreserved: true, tabsPreserved: true, staleDuplicateRejected: true, successorUsable: true,
  }, null, 2));
  console.log('Popup closure: ' + f.evidence);
});
