import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {assertVersion, runCLI} from './playwright.mjs';
import {observe, selectTarget, focusWarnings} from './native-workflow.mjs';
import {nativeChannel} from './native-channel.mjs';

export async function nativeWorkflowV4({command, profile, call, alias, workspace, session, key, tabId, url, options, requestedFocusEmulation}) {
  const channel = await nativeChannel(profile, {workspace, session, sessionKey: key});
  let acquired = false;
  try {
    const plan = await channel.send('inspect');
    const old = plan.record?.status !== 'retired' ? plan.record : null;
    if (command === 'connect' || command === 'open') {
      const focusEmulation = requestedFocusEmulation ?? old?.focusEmulation ?? false;
      const cliVersion=await assertVersion(options);
      if (old && !plan.healthy) throw fault('SESSION_STALE', 'Native session was interrupted. Inspect and reconcile before connecting again.');
      if (command === 'open' && old) throw fault('SESSION_COLLISION', 'Use a fresh session name to open a new tab.');
      let target = command === 'open' ? null : (await call('tabs')).find(t => t.tabId === tabId);
      if (command === 'connect' && !target) throw fault('TAB_UNAVAILABLE', 'Requested tab is not in the paired profile.');
      await fs.mkdir(path.join(workspace, '.playwright'), {recursive: true});
      if (!old) {
        const inventory = await runCLI(session, ['list'], options);
        if ((inventory.browsers || []).some(b => b.name === session && b.status === 'open' && b.workspace === workspace)) throw fault('SESSION_COLLISION', 'A CLI session already uses this workspace/name.');
      }
      const connected = await channel.send(command, {tabId, expectedUrl: target?.url, focusEmulation});
      if (command === 'open') { tabId = connected.tabId; target = {url: connected.expectedUrl}; }
      acquired = !connected.alreadyConnected;
      if (acquired) {
        await runCLI(session, ['attach', `--cdp=${connected.cdpEndpoint}`], options);
        await channel.send('cli-attached');
      }
      const verified = await channel.send('verify', {tabId, expectedUrl: target.url});
      await selectTarget(session, verified.targetId, options);
      let page = await observe(session, options);
      if (page.targetId !== verified.targetId || page.url !== target.url) throw fault('TAB_CHANGED', 'Playwright target differs from the reserved tab.');
      let inventory = await channel.send('targets');
      await channel.send('commit'); acquired = false;
      if (command === 'open') {
        await channel.close();
        try {
          await runCLI(session, ['goto', url], options);
          page = await observe(session, options);
          const inspection = await nativeChannel(profile, {workspace, session, sessionKey: key});
          try { inventory = await inspection.send('targets'); }
          finally { await inspection.close().catch(() => {}); }
        } catch (error) {
          error.diagnostics = {...error.diagnostics, createdTabId: tabId, session, workspace, connected: true,
            navigationOutcome: 'unknown', recovery: 'Inspect this session or disconnect it. Do not repeat open.'};
          throw error;
        }
      }
      return {...(command === 'open' ? {created: true} : {}), connected: true, profile: alias, transport: 'native', cliVersion, session, workspace, tabId, authority: connected.authority,
        alreadyConnected: !!old, rootTabId: inventory.rootTabId, targets: inventory.targets, warnings: [...inventory.warnings, ...focusWarnings(focusEmulation)], focusEmulation, page,
        nextCommand: ['playwright-cli', `-s=${session}`, 'snapshot']};
    }
    if (command === 'release') {
      const result = await channel.send('release', {tabId});
      return {...result, transport: 'native', preservedUserTabs: true};
    }
    return {...await channel.send('disconnect'), session, transport: 'native'};
  } catch(e) {
    if (acquired) await channel.send('rollback').catch(() => {});
    throw e;
  } finally { await channel.close().catch(() => {}); }
}
