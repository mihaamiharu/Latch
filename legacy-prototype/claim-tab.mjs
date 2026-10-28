#!/usr/bin/env node
// Attach an existing, ungrouped tab using an already connected Playwright CLI session.
import {spawnSync} from 'node:child_process';

const args = process.argv.slice(2);
const session = args[1] ?? 'qa-work';
if (!args[0] || args.length > 2 || !/^[a-zA-Z0-9_-]+$/.test(session)) {
  console.error('Usage: node claim-tab.mjs <exact-http(s)-url> [session=qa-work]');
  process.exit(1);
}
let target;
try {
  target = new URL(args[0]);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.href.includes('*'))
    throw new Error('Use an exact HTTP(S) URL without credentials or wildcards.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function claim(page, exactUrl) {
  const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';
  const bridgeUrl = 'chrome-extension://' + extensionId + '/connect.html';
  const bridges = page.context().pages().filter(p => p.url() === bridgeUrl || p.url().startsWith(bridgeUrl + '?'));
  if (bridges.length !== 1)
    throw new Error('Expected one connected Playwright extension Welcome tab. Attach first and keep that tab open.');
  const bridge = bridges[0];
  const selected = await bridge.evaluate(async ({exactUrl, extensionId}) => {
    if (chrome.runtime.id !== extensionId)
      throw new Error('Unexpected extension.');
    const self = await chrome.tabs.getCurrent();
    if (!self || self.groupId < 0)
      throw new Error('The Welcome tab is not in an active Playwright group.');
    const originPattern = new URL(exactUrl).origin + '/*';
    const tabs = await chrome.tabs.query({windowId: self.windowId, url: originPattern});
    const matches = tabs.filter(tab => tab.url === exactUrl);
    if (matches.length !== 1)
      throw new Error(`Expected one exact URL match in the connected profile/window; found ${matches.length}. No tab was moved.`);
    const tab = matches[0];
    if (tab.groupId >= 0 && tab.groupId !== self.groupId)
      throw new Error('Target already belongs to another group. Refusing to move it automatically.');
    const alreadyConnected = tab.groupId === self.groupId;
    if (!alreadyConnected)
      await chrome.tabs.group({tabIds: [tab.id], groupId: self.groupId});
    const updated = await chrome.tabs.get(tab.id);
    if (updated.groupId !== self.groupId || updated.url !== exactUrl)
      throw new Error('Tab changed during attachment. Inspect the session before proceeding.');
    return {tabId: tab.id, groupId: self.groupId, windowId: self.windowId, url: updated.url, alreadyConnected, extensionVersion: chrome.runtime.getManifest().version};
  }, {exactUrl, extensionId});

  // Group changes are asynchronous: wait for the existing tab to appear to Playwright.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const connected = page.context().pages().filter(p => p.url() === exactUrl);
    if (connected.length === 1) {
      return {...selected, title: await connected[0].title(), verified: true};
    }
    if (connected.length > 1)
      throw new Error('Multiple connected pages have the target URL. Refusing ambiguous selection.');
    await bridge.waitForTimeout(100);
  }
  throw new Error('Tab was grouped, but Playwright did not expose it within 10 seconds.');
}

const code = `async (page) => await (${claim.toString()})(page, ${JSON.stringify(target.href)})`;
// Argument array, no shell: URL and session input cannot become shell commands.
const result = spawnSync('playwright-cli', [`-s=${session}`, '--json', 'run-code', code], {
  encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.stderr) process.stderr.write(result.stderr);
try {
  const response = JSON.parse(result.stdout);
  const value = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
  if (result.status !== 0 || value?.verified !== true)
    throw new Error('CLI did not report a verified attachment.\n' + result.stdout);
  console.log(JSON.stringify(value, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
