import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createController} from '../extension/controller.js';
import {OFFICIAL_ID, bridgeLocator} from '../extension/protocol.js';
import {sessionKey, redact} from '../src/playwright.mjs';

const identity = {instanceId: crypto.randomUUID(), epoch: crypto.randomUUID(), extensionVersion: '0.1.0'};
function fixture() {
  const locator = 'ws://127.0.0.1:40000/extension/11111111-1111-1111-1111-111111111111';
  const url = `chrome-extension://${OFFICIAL_ID}/connect.html?protocolVersion=2&mcpRelayUrl=${encodeURIComponent(locator)}&token=never-log-this`;
  const tabs = new Map([[1, {id: 1, windowId: 10, groupId: 100, url}],
    [2, {id: 2, windowId: 10, groupId: -1, url: 'https://work.example.test/checkout', title: 'Checkout'}],
    [3, {id: 3, windowId: 20, groupId: -1, url: 'https://work.example.test/other'}],
    [4, {id: 4, windowId: 10, groupId: 400, url: 'https://work.example.test/grouped'}],
    [5, {id: 5, windowId: 10, groupId: -1, url: 'https://private.example.test/', incognito: true}]]);
  let changes = 0;
  const api = {tabs: {query: async () => [...tabs.values()].map(t => ({...t})), get: async id => {
    if (!tabs.has(id)) throw new Error('closed'); return {...tabs.get(id)};
  }, group: async ({tabIds, groupId}) => { changes++; for (const id of tabIds) tabs.get(id).groupId = groupId; },
  ungroup: async ids => { changes++; for (const id of ids) tabs.get(id).groupId = -1; }},
  tabGroups: {get: async id => { if (![100, 200].includes(id)) throw new Error('gone'); return {id}; }}};
  const controller = createController(api, identity);
  const key = sessionKey('/repo/a', 'checkout');
  const send = (op, payload = {}) => controller.handle({v: 1, id: crypto.randomUUID(), op, payload: {...identity, sessionKey: key, ...payload}});
  return {controller, tabs, url, key, send, changed: () => changes};
}
test('exact session locator strips token and rejects other extensions/non-loopback relays', () => {
  const f = fixture();
  assert.equal(bridgeLocator(f.url), 'ws://127.0.0.1:40000/extension/11111111-1111-1111-1111-111111111111');
  assert.equal(bridgeLocator(f.url.replace(OFFICIAL_ID, 'a'.repeat(32))), null);
  assert.equal(bridgeLocator(f.url.replace('127.0.0.1', 'example.com')), null);
  assert.equal(bridgeLocator(f.url.replace('protocolVersion=2', 'protocolVersion=999')), null);
});
test('claim and release preserve tab identity, content URL, and unrelated tabs', async () => {
  const f = fixture();
  assert.equal((await f.send('register', {connectUrl: f.url})).ok, true);
  const claimed = await f.send('claim', {tabId: 2, expectedUrl: f.tabs.get(2).url});
  assert.equal(claimed.result.tabId, 2);
  assert.equal(claimed.result.groupId, 100);
  const again = await f.send('claim', {tabId: 2, expectedUrl: f.tabs.get(2).url});
  assert.equal(again.result.alreadyConnected, true);
  assert.equal(f.changed(), 1);
  assert.equal((await f.send('release', {tabId: 2})).ok, true);
  assert.equal(f.tabs.get(2).groupId, -1);
  assert.equal(f.tabs.get(2).url, 'https://work.example.test/checkout');
  assert.equal(f.tabs.get(4).groupId, 400);
});
test('profile/epoch mismatch and changed URLs never mutate browser groups', async () => {
  const f = fixture();
  await f.send('register', {connectUrl: f.url});
  assert.equal((await f.send('claim', {tabId: 2, expectedUrl: f.tabs.get(2).url, epoch: crypto.randomUUID()})).error.code, 'PROFILE_MISMATCH');
  assert.equal((await f.send('claim', {tabId: 2, expectedUrl: 'https://work.example.test/old'})).error.code, 'TAB_CHANGED');
  assert.equal(f.changed(), 0);
});
test('cross-window and unrelated group claims fail without relocating tabs', async () => {
  const f = fixture(); await f.send('register', {connectUrl: f.url});
  assert.equal((await f.send('claim', {tabId: 3, expectedUrl: f.tabs.get(3).url})).error.code, 'WINDOW_MISMATCH');
  assert.equal((await f.send('claim', {tabId: 4, expectedUrl: f.tabs.get(4).url})).error.code, 'TAB_GROUPED');
  assert.equal(f.changed(), 0);
});
test('two concurrent sessions cannot steal the same tab', async () => {
  const f = fixture(); const otherKey = sessionKey('/repo/b', 'checkout');
  const secondUrl = f.url.replace('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
  // URL is percent encoded in the connection page.
  f.tabs.set(6, {id: 6, windowId: 10, groupId: 200, url: secondUrl});
  await f.send('register', {connectUrl: f.url});
  assert.equal((await f.send('register', {connectUrl: secondUrl, sessionKey: otherKey})).ok, true);
  const results = await Promise.all([f.send('claim', {tabId: 2, expectedUrl: f.tabs.get(2).url}),
    f.send('claim', {tabId: 2, expectedUrl: f.tabs.get(2).url, sessionKey: otherKey})]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.find(r => !r.ok).error.code, 'TAB_OWNED');
});
test('inventory excludes internal and incognito tabs; closing a tab clears ownership', async () => {
  const f = fixture();
  const inventory = await f.send('tabs');
  assert.deepEqual(inventory.result.map(t => t.tabId), [2, 3, 4]);
  await f.send('register', {connectUrl: f.url});
  await f.send('claim', {tabId: 2, expectedUrl: f.tabs.get(2).url});
  f.tabs.delete(2); f.controller.removeTab(2);
  assert.equal((await f.send('forget')).ok, true);
});
test('workspace scopes and token redaction', () => {
  assert.notEqual(sessionKey('/repo/a', 'qa'), sessionKey('/repo/b', 'qa'));
  assert.equal(redact('https://x/?token=secret&protocolVersion=2'), 'https://x/?token=[redacted]&protocolVersion=2');
});
test('final verification detects a target that navigates or closes after grouping', async () => {
  const f = fixture(); await f.send('register', {connectUrl: f.url});
  const expectedUrl = f.tabs.get(2).url;
  await f.send('claim', {tabId: 2, expectedUrl});
  f.tabs.get(2).url = 'https://work.example.test/changed';
  assert.equal((await f.send('verify', {tabId: 2, expectedUrl})).error.code, 'TAB_CHANGED');
  f.tabs.delete(2); f.controller.removeTab(2);
  assert.equal((await f.send('verify', {tabId: 2, expectedUrl})).error.code, 'TAB_CLOSED');
});
