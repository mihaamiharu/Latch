import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {redact, cliError, resultValue, workspaceAt, sessionKey} from '../src/redact.mjs';
import {fault} from '../extension/protocol.js';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('redact and cliError scrub endpoints, tokens, and retain hints and bounded diagnostics', () => {
  const secret =
    'Connection failed ws://127.0.0.1:123/cdp/' +
    'a'.repeat(64) +
    ' https://x.test/?token=secret-token&access_token=tok2 PLAYWRIGHT_MCP_EXTENSION_TOKEN=secret-env';
  const cleaned = redact(secret);
  assert.doesNotMatch(cleaned, /secret-token|secret-env|tok2|ws:\/\/|127\.0\.0\.1/);
  assert.match(cleaned, /\[endpoint redacted\]/);
  assert.match(cleaned, /\[redacted\]/);

  const err = Object.assign(
    fault('ACTION_TIMEOUT', secret, 'Check ws://127.0.0.1:999/extension/' + 'b'.repeat(64)),
    {diagnostics: {action: 'click', elapsedMs: 120}},
  );
  const formatted = cliError(err);
  assert.equal(formatted.code, 'ACTION_TIMEOUT');
  assert.equal(formatted.diagnostics.action, 'click');
  assert.doesNotMatch(JSON.stringify(formatted), /secret|ws:\/\/|127\.0\.0\.1/);
  assert.match(formatted.hint, /\[endpoint redacted\]/);
});

test('resultValue unwraps JSON strings and direct values consistently', () => {
  assert.deepEqual(resultValue({result: '{"ok":1}'}), {ok: 1});
  assert.equal(resultValue({result: 'plain-text'}), 'plain-text');
  assert.deepEqual(resultValue({value: {nested: true}}), {nested: true});
});

test('workspaceAt and sessionKey produce deterministic canonical hashes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-ws-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const real = await workspaceAt(dir);
  assert.equal(real, await fs.realpath(dir));
  const k1 = sessionKey(real, 'agent');
  const k2 = sessionKey(real, 'agent');
  const k3 = sessionKey(real, 'other');
  assert.match(k1, /^[a-f0-9]{64}$/);
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test('CLI emits structured JSON on version and structured JSON errors on invalid commands', async () => {
  const okOut = await exec(process.execPath, [cliEntry, '--version']);
  const parsed = JSON.parse(okOut.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nativeSessionSchema, 4);
  assert.ok(parsed.playwrightCore);

  await assert.rejects(exec(process.execPath, [cliEntry, 'pw', '--session', 'test', '--', 'attach']), e => {
    const err = JSON.parse(e.stderr);
    assert.equal(err.ok, false);
    assert.equal(err.error.code, 'INVALID_ARGUMENT');
    return true;
  });
});
