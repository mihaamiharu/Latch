import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {runCLI, assertVersion, resultValue} from './playwright.mjs';
import {readSession, writeSession, forgetSession} from './state.mjs';

function validateState(state) {
  if (state && (![2, 3].includes(state.v) || state.transport !== 'native'))
    throw fault('SESSION_STATE_UNSUPPORTED', 'Unsupported native session state. Inspect it before proceeding.');
}
export function focusWarnings(enabled) {
  return enabled ? [] : [{code: 'FOCUS_EMULATION_DISABLED',
    message: 'Focus emulation is off. Background pages may stall Playwright stability checks. For ordinary background interactions, disconnect and reconnect with --focus-emulation on; keep it off for real focus/visibility checks. Inspect timed-out actions before retrying.'}];
}
export async function observe(session, options) {
  const result = await runCLI(session, ['run-code', `async(page)=>{const cdp=await page.context().newCDPSession(page);try{const {targetInfo}=await cdp.send('Target.getTargetInfo');return {url:page.url(),title:await page.title(),targetId:targetInfo.targetId}}finally{await cdp.detach()}}`], options);
  return resultValue(result);
}
export async function selectTarget(session, targetId, options) {
  const response = await runCLI(session, ['run-code', `async(page)=>{const open=page.context().pages();return {currentIndex:open.indexOf(page),pages:await Promise.all(open.map(async(p,index)=>{const c=await p.context().newCDPSession(p);try{const {targetInfo}=await c.send('Target.getTargetInfo');return {index,targetId:targetInfo.targetId}}finally{await c.detach()}}))}}`], options);
  const inventory = resultValue(response);
  const selected = Array.isArray(inventory?.pages) && inventory.pages.find(page => page.targetId === targetId);
  if (!selected) throw fault('TAB_CHANGED', 'The requested owned target is not exposed by Playwright.');
  // Avoid an unnecessary bringToFront when the CLI already selected this page.
  if (selected.index !== inventory.currentIndex) await runCLI(session, ['tab-select', String(selected.index)], options);
}

// Called under the normal workspace/session lock. No endpoint is persisted in
// the Latch record or returned by the user-facing command.
export async function nativeWorkflow({command, call, payload, alias, workspace, session, key, tabId, options, requestedFocusEmulation}) {
  const old = await readSession(key);
  validateState(old);
  if (old && (old.instanceId !== payload.instanceId || old.epoch !== payload.epoch))
    throw fault('SESSION_STALE', 'Browser instance changed. Inspect the recorded native session before repair.');
  if (command === 'connect') {
    if (old?.v === 2) throw fault('SESSION_STATE_UPGRADE_REQUIRED', 'Disconnect the Phase 2 session before creating a new popup-capable session.');
    const focusEmulation = requestedFocusEmulation ?? old?.focusEmulation ?? false;
    if (old && focusEmulation !== !!old.focusEmulation) throw fault('SESSION_OPTIONS_CHANGED', 'Disconnect before changing focus emulation.');
    await assertVersion(options);
    if (old && old.status !== 'attached') throw fault('SESSION_STALE', 'An incomplete native session is recorded. Run disconnect before reconnecting.');
    const target = (await call('tabs')).find(tab => tab.tabId === tabId);
    if (!target) throw fault('TAB_UNAVAILABLE', 'The requested tab is not in the paired Work profile.');
    await fs.mkdir(path.join(workspace, '.playwright'), {recursive: true});
    if (!old) {
      const inventory = await runCLI(session, ['list'], options);
      if ((inventory.browsers || []).some(b => b.name === session && b.status === 'open' && b.workspace === workspace))
        throw fault('SESSION_COLLISION', 'A CLI session already uses this name in this workspace. Choose another name.');
    }
    let acquired = false, attachStarted = false, connectAttempted = false;
    try {
      connectAttempted = true;
      const connected = await call('native-connect', {sessionKey: key, tabId, expectedUrl: target.url, focusEmulation});
      if (!old && connected.alreadyConnected) throw fault('SESSION_COLLISION', 'Host session exists without this caller record. Inspect before reconnecting.');
      acquired = !connected.alreadyConnected;
      if (old && acquired) throw fault('SESSION_STALE', 'Host lost the previous native session. Run disconnect before reconnecting.');
      if (!old) {
        await writeSession(key, {v: 3, transport: 'native', ...payload, session, workspace, tabId, focusEmulation, status: 'connecting'});
        if (!connected.cdpEndpoint) throw fault('SESSION_STALE', 'Host session exists without this caller record. Inspect before reconnecting.');
        attachStarted = true;
        await runCLI(session, ['attach', `--cdp=${connected.cdpEndpoint}`], options);
      }
      const verified = await call('native-verify', {sessionKey: key, tabId, expectedUrl: target.url});
      await selectTarget(session, verified.targetId, options);
      const page = await observe(session, options);
      const inventory = await call('native-targets', {sessionKey: key});
      if (page.targetId !== verified.targetId || page.url !== target.url)
        throw fault('TAB_CHANGED', 'The Playwright target does not match the reserved Chrome tab.');
      await writeSession(key, {v: 3, transport: 'native', ...payload, session, workspace, tabId, rootTabId: inventory.rootTabId, targets: inventory.targets, targetId: page.targetId, focusEmulation, status: 'attached'});
      return {connected: true, profile: alias, transport: 'native', session, workspace, tabId,
        alreadyConnected: !!old, rootTabId: inventory.rootTabId, targets: inventory.targets, warnings: [...inventory.warnings, ...focusWarnings(focusEmulation)], focusEmulation, page, nextCommand: ['playwright-cli', `-s=${session}`, 'snapshot']};
    } catch (error) {
      if (!old && !acquired && connectAttempted && ['BRIDGE_TIMEOUT', 'BRIDGE_DISCONNECTED', 'BROWSER_TIMEOUT', 'NATIVE_CLEANUP_FAILED'].includes(error.code)) {
        await writeSession(key, {v: 3, transport: 'native', ...payload, session, workspace, tabId, focusEmulation, status: 'interrupted'});
        throw fault('NATIVE_CLEANUP_FAILED', `Native connection outcome is unconfirmed (${error.code}). Keep this session record and run disconnect before retrying.`);
      }
      if (acquired) {
        // Revoke the local endpoint before waiting on CLI cleanup.
        const results = await Promise.allSettled([
          call('native-disconnect', {sessionKey: key, tabId}),
          attachStarted ? runCLI(session, ['detach'], options) : Promise.resolve(),
        ]);
        if (results.some(result => result.status === 'rejected'))
          throw fault('NATIVE_CLEANUP_FAILED', 'Native connection failed; cleanup is incomplete. Keep the recorded session and run disconnect.');
        if (old) await writeSession(key, {...old, status: 'interrupted'});
        else await forgetSession(key);
      }
      throw error;
    }
  }
  if (!old) throw fault('SESSION_UNAVAILABLE', 'This workspace/session has no native record.');
  if (command === 'release' && old.v === 3) {
    const result = await call('native-release-tab', {sessionKey: key, tabId});
    if (result.sessionClosed) await runCLI(session, ['detach'], options);
    await writeSession(key, {...old, targets: result.targets, status: result.sessionClosed ? 'released' : 'attached'});
    return {...result, transport: 'native', preservedUserTabs: true};
  }
  if (command === 'release' && old.tabId !== tabId) throw fault('TAB_NOT_OWNED', 'This native session does not own that tab.');
  await call('native-disconnect', {sessionKey: key, tabId: old.tabId});
  if (old.status !== 'released') await runCLI(session, ['detach'], options);
  if (command === 'release') {
    await writeSession(key, {...old, status: 'released'});
    return {released: true, tabId, transport: 'native', sessionClosed: true, preservedUserTabs: true};
  }
  await forgetSession(key);
  return {disconnected: true, session, transport: 'native', preservedUserTabs: true};
}
