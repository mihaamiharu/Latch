import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {encode, decoder} from '../src/framing.mjs';
import {OFFICIAL_ID} from '../extension/protocol.js';

const enabled = !!(process.env.QA_BROWSER_PLAYWRIGHT_MODULE && process.env.QA_BROWSER_CHROME && process.env.QA_BROWSER_OFFICIAL_EXTENSION);
test('real Chrome: companion claims existing authenticated tabs for two unmodified CLI sessions', {skip: !enabled, timeout: 120000}, async t => {
  const {chromium} = await import(process.env.QA_BROWSER_PLAYWRIGHT_MODULE);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const work = fileURLToPath(new URL('../work/browser-bridge/', import.meta.url));
  await fs.mkdir(work, {recursive: true});
  const temp = await fs.mkdtemp(path.join(work, 'browser-'));
  const profile = path.join(temp, 'chrome-profile');
  const project = path.join(temp, 'project');
  await fs.mkdir(project);
  const runtime = `/tmp/qab-browser-${crypto.randomBytes(4).toString('hex')}`;
  const official = path.resolve(process.env.QA_BROWSER_OFFICIAL_EXTENSION);
  const extension = path.join(root, 'extension');
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  const ownId = [...digest].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
  let context, native;
  let nativeErrors = '';
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>QA fixture ${req.url}</title><h1>Checkout fixture</h1><p id="account">${req.headers.cookie?.includes('signed=1') ? 'signed in' : 'signed out'}</p><p id="total">100</p>`);
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (context && process.env.QA_BROWSER_TEST_DEBUG) {
      console.log('Browser pages:', await Promise.all(context.pages().map(async page => ({url: page.url().split('?')[0], title: await page.title().catch(() => 'closed')}))));
    }
    if (native && native.exitCode === null) { const exited = new Promise(r => native.once('exit', r)); native.stdin.end(); await exited; }
    await context?.close().catch(() => {});
    await new Promise(resolve => httpServer.close(resolve));
    await fs.rm(runtime, {recursive: true, force: true});
    // Keep browser fixtures in work/ for diagnostics; never use a user's Chrome profile.
  });
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.QA_BROWSER_CHROME, channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${extension},${official}`, `--load-extension=${extension},${official}`],
  });
  const deadline = Date.now() + 15000;
  let worker;
  while (Date.now() < deadline) {
    worker = context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${ownId}/`));
    if (worker) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(worker, 'Companion service worker loaded');
  // One-time authorization is provisioned only inside this disposable fixture profile.
  const token = crypto.randomUUID();
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${OFFICIAL_ID}/status.html`);
  await setup.evaluate(token => localStorage.setItem('auth-token', token), token);
  await setup.close();
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  await context.addCookies([{name: 'signed', value: '1', url: origin}]);
  const first = await context.newPage(); await first.goto(origin + '/checkout');
  const second = await context.newPage(); await second.goto(origin + '/orders');
  const ownPage = await context.newPage();
  await ownPage.goto(`chrome-extension://${ownId}/popup.html`);
  const identity = await ownPage.evaluate(async () => await chrome.runtime.sendMessage({type: 'status'}));
  assert.ok(identity.instanceId && identity.epoch);

  const env = {...process.env, QA_BROWSER_RUNTIME_DIR: runtime, QA_BROWSER_CONFIG: path.join(temp, 'config.json'),
    PWTEST_DAEMON_SESSION_DIR: path.join(temp, 'daemon'),
    PLAYWRIGHT_MCP_EXECUTABLE_PATH: process.env.QA_BROWSER_CHROME, PWTEST_EXTENSION_USER_DATA_DIR: profile,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, NO_UPDATE_NOTIFIER: '1'};
  native = spawn(process.execPath, [path.join(root, 'src/native-host.mjs')], {env, stdio: ['pipe', 'pipe', 'pipe']});
  native.stderr.on('data', data => nativeErrors += data);
  // Test driver substitutes only Chrome's native-pipe wiring. Real native framing,
  // socket host, CLI, companion dispatcher, Chrome APIs and official transport run unchanged.
  const consume = decoder(message => {
    ownPage.evaluate(async message => await chrome.runtime.sendMessage(message), message)
      .then(response => native.stdin.write(encode(response)))
      .catch(error => native.stdin.write(encode({v: 1, id: message.id, ok: false, error: {code: 'TEST_DRIVER', message: error.message}})));
  });
  native.stdout.on('data', consume);
  native.stdin.write(encode({v: 1, type: 'hello', ...identity, extensionVersion: manifest.version}));
  const address = path.join(runtime, `${identity.instanceId}.sock`);
  for (let i = 0; i < 100; i++) { try { await fs.stat(address); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
  async function cli(args, {fail = false} = {}) {
    const child = spawn(process.execPath, [path.join(root, 'src/cli.mjs'), ...args], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data);
    const timer = setTimeout(() => child.kill(), 50000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, fail ? 1 : 0, out + err + nativeErrors);
    return JSON.parse(fail ? err : out);
  }
  await cli(['pair', '--instance', identity.instanceId, '--chrome-profile-dir', 'Default']);
  const inventory = await cli(['tabs']);
  const target = inventory.tabs.find(t => t.url === origin + '/checkout');
  const target2 = inventory.tabs.find(t => t.url === origin + '/orders');
  assert.ok(target && target2);
  const connected = await cli(['connect', '--session', 'first', '--tab', String(target.tabId)]);
  assert.equal(connected.page.url, origin + '/checkout');
  assert.equal(connected.tabId, target.tabId);
  assert.equal(await first.locator('#account').innerText(), 'signed in');
  const observed = await new Promise((resolve, reject) => {
    const child = spawn('playwright-cli', ['-s=first', '--json', 'run-code',
      'async (page) => ({account: await page.locator("#account").innerText(), total: await page.locator("#total").innerText()})'],
    {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data);
    child.on('error', reject);
    child.on('exit', code => {
      try { assert.equal(code, 0, err); resolve(JSON.parse(JSON.parse(out).result)); } catch (error) { reject(error); }
    });
  });
  assert.deepEqual(observed, {account: 'signed in', total: '100'});
  const connected2 = await cli(['connect', '--session', 'second', '--tab', String(target2.tabId)]);
  assert.notEqual(connected.groupId, connected2.groupId);
  const conflict = await cli(['connect', '--session', 'second', '--tab', String(target.tabId)], {fail: true});
  assert.equal(conflict.error.code, 'TAB_OWNED');
  const again = await cli(['connect', '--session', 'first', '--tab', String(target.tabId)]);
  assert.equal(again.alreadyConnected, true);
  // Closing the seed page does not make our controller lose its registered group.
  const current = await worker.evaluate(async ({groupId}) => (await chrome.tabs.query({groupId})).filter(t => t.url?.startsWith('chrome-extension:')).map(t => t.id), {groupId: connected.groupId});
  await worker.evaluate(async ids => { for (const id of ids) await chrome.tabs.remove(id); }, current);
  assert.equal((await cli(['connect', '--session', 'first', '--tab', String(target.tabId)])).connected, true);
  await cli(['release', '--session', 'first', '--tab', String(target.tabId)]);
  await cli(['disconnect', '--session', 'first']);
  await cli(['disconnect', '--session', 'second']);
  const after = await cli(['tabs']);
  const preserved = after.tabs.find(t => t.tabId === target.tabId);
  assert.equal(preserved.url, target.url);
  assert.equal(preserved.groupId, -1);
  assert.equal(await first.locator('#account').innerText(), 'signed in');
  assert.equal(await second.locator('#account').innerText(), 'signed in');
});
