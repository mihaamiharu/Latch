import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {runCLI, assertVersion, resultValue} from './playwright.mjs';
import {readSession, writeSession, forgetSession} from './state.mjs';

function validateState(state) {
  if (state && (state.v !== 2 || state.transport !== 'native'))
    throw fault('SESSION_STATE_UNSUPPORTED', 'Unsupported native session state. Inspect it before proceeding.');
}
async function observe(session, options) {
  const result = await runCLI(session, ['run-code', `async(page)=>{const cdp=await page.context().newCDPSession(page);try{const {targetInfo}=await cdp.send('Target.getTargetInfo');return {url:page.url(),title:await page.title(),targetId:targetInfo.targetId}}finally{await cdp.detach()}}`], options);
  return resultValue(result);
}

// Called under the normal workspace/session lock. No endpoint is persisted in
// the Latch record or returned by the user-facing command.
export async function nativeWorkflow({command, call, payload, alias, workspace, session, key, tabId, options, requestedFocusEmulation}) {
  const old = await readSession(key);
  validateState(old);
  if (old && (old.instanceId !== payload.instanceId || old.epoch !== payload.epoch))
    throw fault('SESSION_STALE', 'Browser instance changed. Inspect the recorded native session before repair.');
  if (command === 'connect') {
    const focusEmulation = requestedFocusEmulation ?? old?.focusEmulation ?? false;
    if (old && focusEmulation !== !!old.focusEmulation) throw fault('SESSION_OPTIONS_CHANGED', 'Disconnect before changing focus emulation.');
    await assertVersion(options);
    if (old && old.tabId !== tabId) throw fault('SESSION_TAB_LIMIT', 'Native mode supports one tab per named session. Use another session.');
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
        await writeSession(key, {v: 2, transport: 'native', ...payload, session, workspace, tabId, focusEmulation, status: 'connecting'});
        if (!connected.cdpEndpoint) throw fault('SESSION_STALE', 'Host session exists without this caller record. Inspect before reconnecting.');
        attachStarted = true;
        await runCLI(session, ['attach', `--cdp=${connected.cdpEndpoint}`], options);
      }
      const page = await observe(session, options);
      const verified = await call('native-verify', {sessionKey: key, tabId, expectedUrl: target.url});
      if (page.targetId !== verified.targetId || page.url !== target.url)
        throw fault('TAB_CHANGED', 'The Playwright target does not match the reserved Chrome tab.');
      await writeSession(key, {v: 2, transport: 'native', ...payload, session, workspace, tabId, targetId: page.targetId, focusEmulation, status: 'attached'});
      return {connected: true, profile: alias, transport: 'native', session, workspace, tabId,
        alreadyConnected: !!old, focusEmulation, page, nextCommand: ['playwright-cli', `-s=${session}`, 'snapshot']};
    } catch (error) {
      if (!old && !acquired && connectAttempted && ['BRIDGE_TIMEOUT', 'BRIDGE_DISCONNECTED', 'BROWSER_TIMEOUT', 'NATIVE_CLEANUP_FAILED'].includes(error.code)) {
        await writeSession(key, {v: 2, transport: 'native', ...payload, session, workspace, tabId, focusEmulation, status: 'interrupted'});
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
