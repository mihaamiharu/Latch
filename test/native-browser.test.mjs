import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {OFFICIAL_ID} from '../extension/protocol.js';
import {HEADLESS_ARGS} from './helpers/native-browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const enabled = process.env.LATCH_NATIVE_SPIKE === '1' && process.platform === 'darwin';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function chromePath() {
  if (process.env.LATCH_SPIKE_BROWSER) return process.env.LATCH_SPIKE_BROWSER;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const versions = (await fs.readdir(cache)).filter(x => /^chromium-\d+$/.test(x)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const version of versions) {
    const candidate = path.join(cache, version, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error('Set LATCH_SPIKE_BROWSER to a Chrome for Testing executable.');
}
function control(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('Control timed out.')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      socket.destroy();
      try { const response = JSON.parse(data); response.ok ? resolve(response.result) : reject(new Error(response.error)); }
      catch (error) { reject(error); }
    });
  });
}
async function eventually(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw last || new Error('Condition did not become true.');
}
async function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {...options, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture command timed out.')); }, 45000);
    child.stdout.on('data', data => out += data);
    child.stderr.on('data', data => err += data);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({code, out, err}); });
  });
}
async function stopBrowser(browser) {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 3000);
    browser.once('exit', () => { clearTimeout(timer); resolve(); });
    browser.kill('SIGTERM');
  });
}

test('Latch alone: real native bootstrap and unmodified CLI over CDP without Chrome debug flags', {skip: !enabled, timeout: 180000}, async t => {
  const chrome = await chromePath();
  const base = path.join(root, 'work/native-spike');
  await fs.mkdir(base, {recursive: true});
  const temp = await fs.mkdtemp(path.join(base, 'run-'));
  const runtime = `/tmp/latch-spike-${crypto.randomBytes(5).toString('hex')}`;
  await fs.mkdir(runtime, {mode: 0o700});
  const socket = path.join(runtime, 'spike.sock');
  const extension = path.join(temp, 'extension');
  const project = path.join(temp, 'project');
  const evidence = path.join(temp, 'evidence');
  await fs.mkdir(extension); await fs.mkdir(project); await fs.mkdir(path.join(project, '.playwright')); await fs.mkdir(evidence);
  const originalManifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json')));
  const extensionId = [...crypto.createHash('sha256').update(Buffer.from(originalManifest.key, 'base64')).digest().subarray(0, 16)]
    .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  const hostName = `com.latch.spike_${crypto.randomBytes(6).toString('hex')}`;
  // Chrome's user-data override also scopes user-level native-host discovery.
  // Keep the registration inside the disposable profile tree.
  const hostsDirectory = path.join(temp, 'profile/NativeMessagingHosts');
  const hostManifest = path.join(hostsDirectory, hostName + '.json');
  let registration, browser, disconnected = false, attachStarted = false;
  const session = `native-spike-${crypto.randomBytes(4).toString('hex')}`;
  const env = {...process.env, PWTEST_DAEMON_SESSION_DIR: path.join(temp, 'daemon'), NO_UPDATE_NOTIFIER: '1'};
  const telemetry = new Map();
  const fixture = http.createServer((req, res) => {
    if (req.url === '/fixture-state' && req.method === 'POST') {
      let body = '';
      req.on('data', data => body += data);
      req.on('end', () => {
        const state = JSON.parse(body);
        telemetry.set(state.path, {...state, receivedAt: Date.now()});
        res.end('ok');
      });
      return;
    }
    if (req.url === '/api/check') { res.setHeader('Content-Type', 'application/json'); res.end('{"checked":true}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'latch_fixture=signed-in; Path=/; SameSite=Lax');
    res.end(`<title>Latch native fixture</title><h1>Existing signed-in tab</h1>
      <p id="account">${req.headers.cookie?.includes('latch_fixture=signed-in') ? 'signed in' : 'initializing'}</p>
      <label>Name <input id="name"></label><button id="save">Save</button><p id="result">Waiting</p>
      <script>localStorage.setItem('latch-fixture-marker', 'pre-existing');
      document.querySelector('#account').textContent=document.cookie.includes('latch_fixture=signed-in')?'signed in':'signed out';
      document.querySelector('#save').onclick=async()=>{await fetch('/api/check');document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value;console.error('fixture console evidence');};
      setInterval(()=>fetch('/fixture-state',{method:'POST',body:JSON.stringify({path:location.pathname,result:document.querySelector('#result').textContent,marker:localStorage.getItem('latch-fixture-marker'),signedIn:document.cookie.includes('latch_fixture=signed-in')})}),250);</script>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const cli = async args => {
    const result = await command('playwright-cli', [`-s=${session}`, '--json', ...args], {cwd: project, env});
    let value;
    try { value = JSON.parse(result.out); } catch { throw new Error(`Playwright returned invalid output: ${result.err.slice(0, 400)}`); }
    if (result.code !== 0 || value.isError) {
      const message = JSON.stringify(value).replace(/ws:\/\/[^\s"<>]+/g, '[endpoint redacted]');
      throw new Error(`Playwright command ${args[0]} failed: ${message.slice(0, 1200)}`);
    }
    return value;
  };
  const valueOf = value => { try { return JSON.parse(value.result); } catch { return value.result; } };
  t.after(async () => {
    const finalTrace = await control(socket, {op: 'trace'}).catch(() => null);
    if (finalTrace) await fs.writeFile(path.join(evidence, 'final-protocol-methods.json'), JSON.stringify(finalTrace, null, 2));
    if (attachStarted && !disconnected) await cli(['detach']).catch(() => {});
    await control(socket, {op: 'disconnect'}).catch(() => {});
    await stopBrowser(browser);
    if (registration && await fs.readFile(hostManifest, 'utf8').catch(() => '') === registration) await fs.unlink(hostManifest);
    await new Promise(resolve => fixture.close(resolve));
    await fs.rm(runtime, {recursive: true, force: true});
  });
  await fs.copyFile(path.join(root, 'experiments/native-transport/extension/background.js'), path.join(extension, 'background.js'));
  await fs.writeFile(path.join(extension, 'config.js'), `export const HOST = ${JSON.stringify(hostName)};\nexport const FIXTURE_ORIGIN = ${JSON.stringify(origin)};\n`);
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify({manifest_version: 3,
    name: 'Latch Native Transport Experiment', version: '0.1.2', key: originalManifest.key,
    permissions: ['debugger', 'tabs', 'nativeMessaging'], background: {service_worker: 'background.js', type: 'module'}}));
  const launcher = path.join(temp, 'native-host');
  await fs.writeFile(launcher, `#!/bin/sh\nexport LATCH_SPIKE_RUNTIME=${quote(runtime)}\nexport LATCH_SPIKE_EXTENSION_ID=${quote(extensionId)}\nexec ${quote(process.execPath)} ${quote(path.join(root, 'experiments/native-transport/native-host.mjs'))} "$@" 2>>${quote(path.join(temp, 'native.stderr.log'))}\n`, {mode: 0o700});
  registration = JSON.stringify({name: hostName, description: 'Disposable Latch native transport fixture',
    path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`]}, null, 2) + '\n';
  await fs.mkdir(hostsDirectory, {recursive: true});
  await fs.writeFile(hostManifest, registration, {flag: 'wx', mode: 0o600});
  const launchArgs = [...HEADLESS_ARGS, `--user-data-dir=${path.join(temp, 'profile')}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check',
    '--enable-logging=stderr', '--use-mock-keychain', '--password-store=basic', '--disable-background-networking',
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`];
  assert.ok(!launchArgs.some(arg => arg.startsWith('--remote-debugging')));
  const log = await fs.open(path.join(temp, 'chrome.stderr.log'), 'w');
  browser = spawn(chrome, launchArgs, {stdio: ['ignore', 'ignore', log.fd]});
  await log.close();
  browser.on('error', () => {});
  console.log(`Fixture directory: ${temp}`);
  await eventually(() => control(socket, {op: 'status'}), 20000);
  const seeded = await control(socket, {op: 'fixtureSeed'});
  await fs.writeFile(path.join(temp, 'seed-diagnostic.json'), JSON.stringify(seeded, null, 2));
  const tabs = await eventually(async () => {
    const list = await control(socket, {op: 'tabs'});
    await fs.writeFile(path.join(temp, 'tabs-diagnostic.json'), JSON.stringify(list, null, 2));
    return list.some(tab => tab.url === origin + '/work') && list.some(tab => tab.url === origin + '/unrelated') ? list : null;
  });
  const target = tabs.find(tab => tab.url === origin + '/work');
  const unrelated = tabs.find(tab => tab.url === origin + '/unrelated');
  const connection = await control(socket, {op: 'connect', tabId: target.id});
  attachStarted = true;
  await cli(['attach', `--cdp=${connection.cdpEndpoint}`]);
  const observed = valueOf(await cli(['run-code', `async(page)=>({url:page.url(),account:await page.locator('#account').innerText(),marker:await page.evaluate(()=>localStorage.getItem('latch-fixture-marker'))})`]));
  assert.deepEqual(observed, {url: origin + '/work', account: 'signed in', marker: 'pre-existing'});
  await cli(['snapshot', `--filename=${path.join(evidence, 'before.yaml')}`]);
  const assertion = valueOf(await cli(['run-code', `async(page)=>{await page.locator('#name').fill('Latch');await page.locator('#save').click();await page.locator('#result').filter({hasText:'Saved Latch'}).waitFor();return {result:await page.locator('#result').innerText(),title:await page.title()}}`]));
  assert.equal(assertion.result, 'Saved Latch');
  await cli(['screenshot', `--filename=${path.join(evidence, 'after.png')}`]);
  await cli(['snapshot', `--filename=${path.join(evidence, 'after.yaml')}`]);
  const consoleOutput = await cli(['console', 'error']);
  const requests = await cli(['requests']);
  await fs.writeFile(path.join(evidence, 'console.json'), JSON.stringify(consoleOutput, null, 2));
  await fs.writeFile(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  assert.match(JSON.stringify(consoleOutput), /fixture console evidence/);
  assert.match(JSON.stringify(requests), /api\/check/);
  const status = await control(socket, {op: 'status'});
  assert.equal(status.relay.tabId, target.id);
  assert.ok(status.relay.targetId);
  const targetIdentity = valueOf(await cli(['run-code', `async(page)=>{const s=await page.context().newCDPSession(page);try{return await s.send('Target.getTargetInfo')}finally{await s.detach()}}`]));
  assert.equal(targetIdentity.targetInfo.targetId, status.relay.targetId);
  const trace = await control(socket, {op: 'trace'});
  await fs.writeFile(path.join(evidence, 'protocol-methods.json'), JSON.stringify(trace, null, 2));
  await cli(['detach']); disconnected = true;
  await control(socket, {op: 'disconnect'});
  await eventually(async () => {
    const debuggers = await control(socket, {op: 'debuggers'});
    return debuggers.find(entry => entry.tabId === target.id)?.attached === false;
  });
  const detachedAt = Date.now();
  const preservedState = await eventually(() => {
    const selected = telemetry.get('/work'), other = telemetry.get('/unrelated');
    return selected?.receivedAt > detachedAt && other?.receivedAt > detachedAt ? {selected, other} : null;
  });
  assert.equal(preservedState.selected.result, 'Saved Latch');
  assert.equal(preservedState.other.result, 'Waiting');
  for (const state of Object.values(preservedState)) {
    assert.equal(state.signedIn, true);
    assert.equal(state.marker, 'pre-existing');
  }
  const after = await control(socket, {op: 'tabs'});
  for (const original of [target, unrelated]) {
    const preserved = after.find(tab => tab.id === original.id);
    assert.equal(preserved?.url, original.url);
    assert.equal(preserved?.groupId, original.groupId);
    assert.equal(preserved?.windowId, original.windowId);
  }
  const png = await fs.readFile(path.join(evidence, 'after.png'));
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  // Chrome persists the installed extension inventory during clean shutdown.
  // All tab/state preservation assertions above run while it is still open.
  await stopBrowser(browser);
  const extensionSettings = {};
  for (const filename of ['Preferences', 'Secure Preferences']) {
    const preferences = JSON.parse(await fs.readFile(path.join(temp, 'profile/Default', filename)).catch(() => '{}'));
    Object.assign(extensionSettings, preferences.extensions?.settings || {});
  }
  assert.ok(extensionSettings[extensionId], 'Latch is installed in the disposable profile.');
  assert.ok(!extensionSettings[OFFICIAL_ID], 'Official extension is absent.');
  const report = {outcome: 'passed', cliVersion: (await command('playwright-cli', ['--version'])).out.trim(),
    chromeVersion: (await command(chrome, ['--version'])).out.trim(),
    transport: 'real Chrome native messaging plus authenticated local CDP relay',
    officialExtensionInstalled: false, remoteDebuggingFlags: false, debuggerDetached: true, tabId: target.id,
    targetId: status.relay.targetId, observed, assertion, preservedState, existingTabsPreserved: true,
    limitations: ['single session experiment', 'not installed in Work', 'no restart recovery', 'downloads unsupported']};
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Native transport proof passed; evidence: ${evidence}`);
});
