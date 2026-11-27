import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fault, safeError} from '../extension/protocol.js';
import {spawnCommandSpec} from './platform.mjs';

export const CLI_META = Symbol('playwright-process-result');

export function redact(text) {
  return String(text)
    .replace(/wss?:\/\/[^\s"'<>]+/gi, '[endpoint redacted]')
    .replace(/(PLAYWRIGHT_MCP_EXTENSION_TOKEN=)[^\s"'<>]+/g, '$1[redacted]')
    .replace(/([?&](?:token|access_token|key)=)[^\s&"<>]+/gi, '$1[redacted]')
    .replace(/(\/(?:cdp|extension)\/)[a-f0-9]{64}/gi, '$1[redacted]');
}

// Local CLI failures retain a bounded cause; bridge errors still use safeError.
export function cliError(error) {
  return {
    ...safeError(error),
    message: redact(safeError(error).message),
    ...(error.diagnostics ? {diagnostics: error.diagnostics} : {}),
    ...(error.evidence ? {evidence: error.evidence} : {}),
    ...(error.reporting ? {reporting: error.reporting} : {}),
    ...(error.library ? {library: error.library} : {}),
  };
}

export async function workspaceAt(start = process.cwd()) {
  return await fs.realpath(start);
}

export const sessionKey = (workspace, session) =>
  crypto.createHash('sha256').update(JSON.stringify([workspace, session])).digest('hex');

export async function runCLI(session, args, {workspace, chromeProfileDir, timeout = 45000, executable, nodeExecutable} = {}) {
  const spec = await spawnCommandSpec(
    executable || process.env.LATCH_PLAYWRIGHT_CLI || 'playwright-cli',
    [`-s=${session}`, '--json', ...args],
    {nodeExecutable, env: {...process.env, NO_UPDATE_NOTIFIER: '1'}},
  );
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const env = {...process.env, NO_UPDATE_NOTIFIER: '1'};
    if (nodeExecutable) env.PATH = path.dirname(nodeExecutable) + path.delimiter + (env.PATH || '');
    if (chromeProfileDir) env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = chromeProfileDir;
    const child = spawn(spec.command, spec.args, {
      cwd: workspace,
      env,
      ...spec.options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let ended = false;
    let abortError;
    let killTimer;

    const finish = (error, value) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      error ? reject(error) : resolve(value);
    };

    const abort = error => {
      if (abortError || ended) return;
      abortError = error;
      child.kill('SIGTERM');
      // A descendant may retain inherited pipes after the CLI itself exits.
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1000);
    };

    const timer = setTimeout(
      () => abort(fault('CLI_TIMEOUT', 'Playwright CLI timed out; an in-flight browser action may still have an unknown outcome.')),
      timeout,
    );

    child.stdout.on('data', data => {
      if (abortError) return;
      stdoutBytes += data.length;
      if (stdoutBytes > 2 * 1024 * 1024) return abort(fault('CLI_OUTPUT_LARGE', 'Playwright CLI output exceeded the limit.'));
      stdoutChunks.push(data);
    });

    child.stderr.on('data', data => {
      if (stderrBytes >= 16384) return;
      const chunk = data.subarray(0, 16384 - stderrBytes);
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    child.on('error', () =>
      finish(fault('CLI_UNAVAILABLE', 'Cannot start the selected Playwright CLI. Check its installed path and Node prerequisite; no other executable was substituted.')),
    );

    child.on('close', (code, signal) => {
      if (ended) return;
      if (abortError) {
        abortError.diagnostics = {
          command: args[0],
          exitCode: code,
          signal: signal ?? null,
          elapsedMs: Math.round(performance.now() - started),
          unknownOutcome: true,
        };
        return finish(abortError);
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      let response;
      try {
        response = JSON.parse(stdout);
      } catch {}
      const upstream = typeof response?.error === 'string' ? response.error : stderr || (response?.isError ? 'Playwright returned isError: true.' : '');
      const failed = code !== 0 || response?.isError;
      const cliFault = (name, message, cause = upstream) =>
        Object.assign(fault(name, message), {
          diagnostics: {
            command: args[0],
            exitCode: code,
            elapsedMs: Math.round(performance.now() - started),
            upstreamError: redact(cause).slice(0, 4096),
          },
        });
      try {
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          throw cliFault('CLI_RESPONSE_INVALID', `Playwright CLI (${args[0]}) did not return a JSON object.`, stderr || stdout);
        }
        if (failed) throw cliFault('PLAYWRIGHT_ERROR', redact(upstream || 'Playwright CLI failed.'));
        response[CLI_META] = {
          exitCode: code,
          signal: signal ?? null,
          elapsedMs: Math.round(performance.now() - started),
        };
        finish(null, response);
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function resultValue(response) {
  if (typeof response.result !== 'string') return response.result;
  try {
    return JSON.parse(response.result);
  } catch {
    return response.result;
  }
}

export async function assertVersion(options) {
  const response = await runCLI('version-check', ['--version'], options);
  if (response.version !== '0.1.20') {
    throw fault('UNSUPPORTED_VERSION', `Validated CLI version: 0.1.20; found ${response.version || 'unknown'}. Run compatibility tests before upgrading.`);
  }
  return response.version;
}
