import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
// Headless by default (AGENTS.md). LATCH_BROWSER_HEADED=1 is an explicit, manual
// opt-in for checking headed behavior; it is never an automatic fallback. Headed
// runs also drop the anti-throttling flags so background tabs behave as in a
// user's Chrome. Profiles and native hosts stay disposable either way.
export const HEADED = process.env.LATCH_BROWSER_HEADED === '1';
export const HEADLESS_ARGS = HEADED
  ? []
  : ['--headless=new','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'];
async function chromePath() {
  const pins = JSON.parse(await fs.readFile(new URL('../browser-versions.json', import.meta.url), 'utf8'));
  const lane = process.env.LATCH_BROWSER_LANE || 'current', pin = pins[lane];
  if (!['floor', 'current'].includes(lane) || !pin) throw new Error('Use LATCH_BROWSER_LANE=floor|current.');
  const cacheDir =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
      : process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'ms-playwright')
        : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
  const binaryRel =
    process.platform === 'win32'
      ? 'chrome-win64/chrome.exe'
      : process.platform === 'linux'
        ? 'chrome-linux/chrome'
        : 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const executable = process.env.LATCH_SPIKE_BROWSER || process.env.LATCH_CHROME ||
    path.join(cacheDir, 'chromium-' + pin.cacheRevision, binaryRel);
  // AGENTS.md: the full Chrome for Testing binary, never the headless shell.
  if (/headless[_-]shell/i.test(executable)) throw new Error('Refusing the Chromium headless shell; use the full Chrome for Testing binary.');
  const actual = await chromeVersion(executable);
  if (actual !== 'Google Chrome for Testing ' + pin.version)
    throw new Error(`Browser pin mismatch for ${lane}: expected Chrome for Testing ${pin.version}; found ${actual || 'no version'}. No browser fixture was launched.`);
  return executable;
}
// chrome.exe --version prints nothing on Windows (GUI subsystem), so read the
// binary's version resource instead. Returns e.g. "Google Chrome for Testing 157.0.8103.39".
async function chromeVersion(executable) {
  if (process.platform !== 'win32') {
    const r = await command(executable, ['--version']);
    return r.code === 0 ? r.out.trim() : '';
  }
  const script = '$v=(Get-Item -LiteralPath $env:LATCH_VERSION_PROBE).VersionInfo;$v.ProductName+" "+$v.ProductVersion';
  const r = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {env: {...process.env, LATCH_VERSION_PROBE: executable}});
  return r.code === 0 ? r.out.trim() : '';
}
function control(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(15000, () => finish(new Error('Control timed out.')));
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!settled) finish(new Error('Control connection closed before a response.')); });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      try { const response = JSON.parse(data); response.ok ? finish(null, response.result) : finish(Object.assign(new Error(response.error?.message || 'Control failed.'), {code: response.error?.code})); }
      catch (error) { finish(error); }
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
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    const child = spawn(executable, args, {...options, ...(useShell ? {shell: true} : {}), stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    // Allow the adapter's 45s command deadline to return its structured error
    // before the outer fixture process deadline kills that diagnostic.
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture command timed out.')); }, 65000);
    child.stdout.on('data', data => out += data);
    child.stderr.on('data', data => err += data);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({code, out, err}); });
  });
}
async function stopBrowser(browser) {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 3000);
    browser.once('exit', () => { clearTimeout(timer); resolve(); });
    // SIGTERM on Windows only ends the browser process and orphans its
    // renderer/GPU children, which keep the disposable profile locked.
    if (process.platform === 'win32') spawn('taskkill.exe', ['/T', '/F', '/PID', String(browser.pid)], {stdio: 'ignore', windowsHide: true});
    else browser.kill('SIGTERM');
  });
}


export {chromePath, chromeVersion, control, eventually, command, stopBrowser};
