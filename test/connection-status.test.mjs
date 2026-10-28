import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

test('failed native connection recovers without displaying its stale error', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const previousChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = previousChrome; });
  const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); }});
  const ports = [];
  const chrome = {runtime: {lastError: null, onInstalled: event(), onStartup: event(), onMessage: event(),
    getManifest: () => ({version: '0.1.2'}), getURL: p => `chrome-extension://test/${p}`,
    connectNative: () => {
      const port = {onMessage: event(), onDisconnect: event(), postMessage() {}};
      ports.push(port); return port;
    }},
    storage: {local: {get: async () => ({instanceId: crypto.randomUUID()}), set: async () => {}}},
    tabs: {onRemoved: event()}};
  globalThis.chrome = chrome;
  const background = await import('../extension/background.js?status-regression');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await background.status()).connected, true);
  chrome.runtime.lastError = {message: 'Specified native messaging host not found.'};
  ports[0].onDisconnect.emit();
  const failed = await background.status();
  assert.equal(failed.connected, false);
  assert.match(failed.lastError, /host not found/);
  chrome.runtime.lastError = null;
  t.mock.timers.tick(10000);
  await new Promise(resolve => setImmediate(resolve));
  const recovered = await background.status();
  assert.equal(ports.length, 2);
  assert.equal(recovered.connected, true);
  assert.equal(recovered.lastError, '');
  chrome.runtime.lastError = {message: 'late obsolete disconnect'};
  ports[0].onDisconnect.emit();
  assert.equal((await background.status()).lastError, '');
  assert.equal((await background.status()).connected, true);
});
