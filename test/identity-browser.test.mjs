import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {EXTENSION_ID} from '../src/release.mjs';
import {chromePath, command, eventually, HEADLESS_ARGS} from './helpers/native-browser.mjs';

const enabled = process.env.LATCH_IDENTITY === '1' && process.platform === 'darwin';

test('real headless extension restores its ID from backup, and creates a new one once both copies are gone', {skip: !enabled, timeout: 90000}, async t => {
  const which = await command('which', ['playwright-cli']), executable = await fs.realpath(which.out.trim());
  const {chromium} = await import(pathToFileURL(path.join(path.dirname(executable), 'node_modules/playwright-core/index.mjs')).href);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-identity-')), extension = path.join(temp, 'extension');
  await fs.cp(path.resolve('dist/latch'), extension, {recursive: true});
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {executablePath: await chromePath(), channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--disable-component-extensions-with-background-pages'],
    args: [...HEADLESS_ARGS.filter(arg => !arg.startsWith('--headless')), '--use-mock-keychain', '--password-store=basic', '--enable-unsafe-extension-debugging']});
  t.after(async () => { await context.close().catch(() => {}); await fs.rm(temp, {recursive: true, force: true}); });
  const settings = await context.newPage();
  await settings.goto('chrome://extensions/');
  await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}));
  const cdp = await context.browser().newBrowserCDPSession();
  assert.equal((await cdp.send('Extensions.loadUnpacked', {path: extension})).id, EXTENSION_ID);

  const inExtension = async expression => {
    const page = await context.newPage();
    try { await page.goto(`chrome-extension://${EXTENSION_ID}/popup.html`, {timeout: 5000}); return await page.evaluate(expression); }
    finally { await page.close().catch(() => {}); }
  };
  const stored = () => eventually(async () => (await inExtension(() => chrome.storage.local.get('instanceId'))).instanceId, 20000);
  const reload = async action => {
    await inExtension(action);
    await settings.evaluate(id => chrome.developerPrivate.reload(id, {failQuietly: true}), EXTENSION_ID);
  };

  const original = await stored();
  await eventually(() => inExtension(async id => new Promise(resolve => {
    const open = indexedDB.open('latch-identity', 1);
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const request = open.result.transaction('identity').objectStore('identity').get('instanceId');
      request.onsuccess = () => { open.result.close(); resolve(request.result === id); };
    };
  }), original), 20000).catch(() => {});

  // storage.local alone emptied: the backup restores the same identity.
  await reload(() => chrome.storage.local.clear());
  assert.equal(await stored(), original, 'identity should be restored from the backup');

  // Positive control: this test can detect a reset, so the result above means something.
  await reload(() => chrome.storage.local.clear().then(() => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('latch-identity');
    request.onsuccess = request.onblocked = () => resolve();
    request.onerror = () => reject(request.error);
  })));
  const replacement = await stored();
  assert.notEqual(replacement, original, 'a full wipe must not keep the identity');
});
