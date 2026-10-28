import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
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
    // Allow the adapter's 45s command deadline to return its structured error
    // before the outer fixture process deadline kills that diagnostic.
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture command timed out.')); }, 65000);
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


export {chromePath, control, eventually, command, stopBrowser};
