import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {bridgeLocator, fault, safeError} from '../extension/protocol.js';
export const CLI_META = Symbol('playwright-process-result');

export function redact(text) {
  return String(text).replace(/chrome-extension:\/\/mmlmfjhmonkocbjadbfplnigmagldckm\/connect\.html[^\s"'<>]*/gi, 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?[redacted]')
    .replace(/wss?:\/\/[^\s"'<>]+/gi, '[endpoint redacted]')
    .replace(/(PLAYWRIGHT_MCP_EXTENSION_TOKEN=)[^\s"'<>]+/g, '$1[redacted]')
    .replace(/([?&](?:token|access_token|key)=)[^\s&"<>]+/gi, '$1[redacted]')
    .replace(/(\/(?:cdp|extension|view)\/)[a-f0-9]{64}/gi, '$1[redacted]');
}
// Local CLI failures retain a bounded cause; bridge errors still use safeError.
export function cliError(error) {
  return {...safeError(error), message: redact(safeError(error).message),
    ...(error.diagnostics ? {diagnostics: error.diagnostics} : {}),
    ...(error.evidence ? {evidence: error.evidence} : {}),
    ...(error.reporting ? {reporting: error.reporting} : {})};
}
export async function workspaceAt(start = process.cwd()) {
  return await fs.realpath(start);
}
export const sessionKey = (workspace, session) => crypto.createHash('sha256').update(JSON.stringify([workspace, session])).digest('hex');
export function runCLI(session, args, {workspace, chromeProfileDir, timeout = 45000, executable, nodeExecutable} = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const env = {...process.env, NO_UPDATE_NOTIFIER: '1'};
    if(nodeExecutable)env.PATH=path.dirname(nodeExecutable)+path.delimiter+(env.PATH||'');
    if (chromeProfileDir) env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = chromeProfileDir;
    const child = spawn(executable || process.env.QA_BROWSER_PLAYWRIGHT_CLI || 'playwright-cli', [`-s=${session}`, '--json', ...args], {
      cwd: workspace, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [], stderrChunks = [];
    let stdoutBytes = 0, stderrBytes = 0, ended = false, abortError, killTimer;
    const finish = (error, value) => { if (ended) return; ended = true; clearTimeout(timer); clearTimeout(killTimer); error ? reject(error) : resolve(value); };
    const abort = error => {
      if (abortError || ended) return;
      abortError = error; child.kill('SIGTERM');
      // A descendant may retain inherited pipes after the CLI itself exits.
      killTimer = setTimeout(() => { child.kill('SIGKILL'); child.stdout?.destroy(); child.stderr?.destroy(); }, 1000);
    };
    const timer = setTimeout(() => abort(fault('CLI_TIMEOUT', 'Playwright CLI timed out; an in-flight browser action may still have an unknown outcome.')), timeout);
    child.stdout.on('data', data => {
      if (abortError) return;
      stdoutBytes += data.length;
      if (stdoutBytes > 2 * 1024 * 1024) return abort(fault('CLI_OUTPUT_LARGE', 'Playwright CLI output exceeded the limit.'));
      stdoutChunks.push(data);
    });
    child.stderr.on('data', data => {
      if (stderrBytes >= 16384) return;
      const chunk = data.subarray(0, 16384 - stderrBytes); stderrChunks.push(chunk); stderrBytes += chunk.length;
    });
    child.on('error', () => finish(fault('CLI_UNAVAILABLE', 'Cannot start the selected Playwright CLI. Check its installed path and Node prerequisite; no other executable was substituted.')));
    child.on('close', (code, signal) => {
      if (ended) return;
      if (abortError) {abortError.diagnostics={command:args[0],exitCode:code,signal:signal??null,elapsedMs:Math.round(performance.now()-started),unknownOutcome:true};return finish(abortError);}
      const stdout = Buffer.concat(stdoutChunks).toString('utf8'), stderr = Buffer.concat(stderrChunks).toString('utf8');
      let response;
      try { response = JSON.parse(stdout); } catch {}
      const upstream = typeof response?.error === 'string' ? response.error : stderr || (response?.isError ? 'Playwright returned isError: true.' : '');
      const failed = code !== 0 || response?.isError;
      const cliFault = (name, message, cause = upstream) => Object.assign(fault(name, message), {diagnostics: {
        command: args[0], exitCode: code, elapsedMs: Math.round(performance.now() - started),
        upstreamError: redact(cause).slice(0, 4096),
      }});
      if (failed && /Playwright extension did not connect/.test(upstream || stdout))
        return finish(cliFault('EXTENSION_CONNECTION_FAILED', 'The official Playwright extension did not complete attachment. Bridge health does not verify this separate connection. Check that extension\'s enabled state, profile and authorization.', upstream || stdout));
      try {
        if (!response || typeof response !== 'object' || Array.isArray(response))
          throw cliFault('CLI_RESPONSE_INVALID', `Playwright CLI (${args[0]}) did not return a JSON object.`, stderr || stdout);
        if (failed) throw cliFault('PLAYWRIGHT_ERROR', redact(upstream || 'Playwright CLI failed.'));
        response[CLI_META]={exitCode:code,signal:signal??null,elapsedMs:Math.round(performance.now()-started)};
        finish(null, response);
      } catch (error) { finish(error); }
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
