import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {bridgeLocator, fault} from '../extension/protocol.js';

export function redact(text) {
  return String(text).replace(/([?&](?:token|access_token|key)=)[^\s&"<>]+/gi, '$1[redacted]');
}
export async function workspaceAt(start = process.cwd()) {
  return await fs.realpath(start);
}
export const sessionKey = (workspace, session) => crypto.createHash('sha256').update(JSON.stringify([workspace, session])).digest('hex');
export function runCLI(session, args, {workspace, chromeProfileDir, timeout = 45000} = {}) {
  return new Promise((resolve, reject) => {
    const env = {...process.env, NO_UPDATE_NOTIFIER: '1'};
    if (chromeProfileDir) env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = chromeProfileDir;
    const child = spawn(process.env.QA_BROWSER_PLAYWRIGHT_CLI || 'playwright-cli', [`-s=${session}`, '--json', ...args], {
      cwd: workspace, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', ended = false;
    const finish = (error, value) => { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(fault('CLI_TIMEOUT', 'Playwright CLI timed out.')); }, timeout);
    child.stdout.on('data', data => { stdout += data; if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { child.kill(); finish(fault('CLI_OUTPUT_LARGE', 'Playwright CLI output exceeded the limit.')); } });
    child.stderr.on('data', data => { if (stderr.length < 16384) stderr += data; });
    child.on('error', () => finish(fault('CLI_UNAVAILABLE', 'Cannot start playwright-cli. Ensure it is installed and on PATH.')));
    child.on('close', code => {
      if (ended) return;
      if (code !== 0 && /Playwright extension did not connect/.test(stderr + stdout))
        return finish(fault('EXTENSION_CONNECTION_FAILED', 'The Playwright extension did not connect. Check the configured Work profile and its initial connection authorization.'));
      try {
        const response = JSON.parse(stdout);
        if (code !== 0 || response.isError) throw fault('PLAYWRIGHT_ERROR', redact(response.error || stderr || 'Playwright CLI failed.'));
        finish(null, response);
      } catch (error) { finish(error.code ? error : fault('CLI_RESPONSE_INVALID', `Playwright CLI (${args[0]}) did not return JSON. ${redact(stderr || stdout).slice(0, 1000)}`)); }
    });
  });
}
export function resultValue(response) {
  if (typeof response.result !== 'string') return response.result;
  try { return JSON.parse(response.result); } catch { return response.result; }
}
export async function assertVersion(options) {
  const response = await runCLI('version-check', ['--version'], options);
  if (response.version !== '0.1.20') throw fault('UNSUPPORTED_VERSION', `Validated CLI version: 0.1.20; found ${response.version || 'unknown'}. Run compatibility tests before upgrading.`);
  return response.version;
}
export async function connectionURL(session, options) {
  const response = await runCLI(session, ['run-code', 'async (page) => page.context().pages().map(p => p.url())'], options);
  const pages = resultValue(response);
  if (!Array.isArray(pages)) throw fault('CLI_RESPONSE_INVALID', 'Playwright did not return a page inventory.');
  const locators = pages.map(bridgeLocator).filter(Boolean);
  if (locators.length !== 1) throw fault('SESSION_LOCATOR_MISSING', 'Expected one official protocol-v2 connection page for this session.');
  // Only the non-secret relay locator is retained. Connection tokens never leave this adapter.
  const clean = new URL('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html');
  clean.searchParams.set('mcpRelayUrl', locators[0]);
  clean.searchParams.set('protocolVersion', '2');
  return clean.href;
}
export async function selectAndVerify(session, exactUrl, options) {
  const deadline = Date.now() + 10000;
  let index;
  while (Date.now() < deadline) {
    const response = await runCLI(session, ['run-code', 'async (page) => page.context().pages().map(p => p.url())'], options);
    const urls = resultValue(response);
    if (!Array.isArray(urls)) throw fault('CLI_RESPONSE_INVALID', 'Unexpected page inventory.');
    const indices = urls.map((url, i) => url === exactUrl ? i : -1).filter(i => i >= 0);
    if (indices.length > 1) throw fault('TAB_AMBIGUOUS', 'Multiple connected pages have the requested URL.');
    if (indices.length === 1) { index = indices[0]; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (index === undefined) throw fault('ATTACH_TIMEOUT', 'Chrome grouped the target, but Playwright did not expose the requested page.');
  await runCLI(session, ['tab-select', String(index)], options);
  const response = await runCLI(session, ['run-code', 'async (page) => ({url: page.url(), title: await page.title()})'], options);
  const page = resultValue(response);
  if (page?.url !== exactUrl) throw fault('TAB_CHANGED', 'Selected page changed during verification.');
  return page;
}
