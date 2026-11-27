import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from '../src/cli.mjs';
import {sessionKey} from '../src/redact.mjs';
import {ipcEndpoint} from '../src/platform.mjs';
import {command} from './helpers/native-browser.mjs';

test('flat CLI rejects unknown flags, invalid session/profile overrides, and legacy pw syntax', () => {
  for (const argv of [
    ['pw', 'click', 'e1'],
    ['attach'],
    ['close-all'],
    ['click'],
    ['click', 'e1', '--unknown-flag'],
    ['snapshot', '--session', 'bad session!'],
    ['snapshot', '-s'],
    ['open', 'javascript:alert(1)'],
    ['connect', 'not-a-tab'],
    ['dialog', 'ignore'],
    ['agents', 'unknown'],
  ]) {
    assert.throws(() => parseArgs(argv));
  }

  const parsed = parseArgs(['click', 'e1', '-s', 'agent']);
  assert.equal(parsed.command, 'click');
  assert.equal(parsed.action, 'click');
  assert.deepEqual(parsed.actionArgs, {target: 'e1'});
  assert.equal(parsed.flags.session, 'agent');
});

test('flat CLI dispatches session-open, session-action, and session-disconnect over IPC with smart defaults', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-command-'));
  const runtime = path.join(os.tmpdir(), `latch-command-${crypto.randomBytes(5).toString('hex')}`);
  await fs.mkdir(runtime, {mode: 0o700});
  const workspace = await fs.realpath(dir);
  const instanceId = crypto.randomUUID();
  const epoch = crypto.randomUUID();
  const hostGeneration = crypto.randomUUID();
  const config = path.join(dir, 'config.json');
  const env = {
    ...process.env,
    LATCH_RUNTIME_DIR: runtime,
    LATCH_CONFIG: config,
    LATCH_CAPTURE: 'off',
  };
  // Use a non-"work" sole profile name to verify sole-profile auto-detection.
  await fs.writeFile(config, JSON.stringify({profiles: {personal: {instanceId, chromeProfileDir: 'Default'}}}));

  const received = [];
  const host = net.createServer(socket => {
    let body = '';
    socket.on('data', b => {
      body += b;
      if (!body.includes('\n')) return;
      const m = JSON.parse(body.slice(0, body.indexOf('\n')));
      received.push(m);
      if (m.op === 'status') {
        socket.end(
          JSON.stringify({
            v: 1,
            id: m.id,
            ok: true,
            result: {
              instanceId,
              epoch,
              hostGeneration,
              capabilities: {nativeTransport: true, nativeSessionSchema: 4, recoveryContract: 1, createTab: 1},
              readiness: {verified: true},
            },
          }) + '\n',
        );
        return;
      }
      if (m.op === 'session-open') {
        socket.end(
          JSON.stringify({
            v: 1,
            id: m.id,
            ok: true,
            result: {
              created: true,
              connected: true,
              tabId: 17,
              focusEmulation: m.payload.focusEmulation,
              page: {targetId: 't1', url: m.payload.url, title: 'Fixture'},
            },
          }) + '\n',
        );
        return;
      }
      if (m.op === 'session-action') {
        if (m.payload.action === 'click' && m.payload.args?.target === 'e-timeout') {
          socket.end(
            JSON.stringify({
              v: 1,
              id: m.id,
              ok: false,
              error: {
                code: 'ACTION_TIMEOUT',
                message: 'Action click timed out',
                hint: 'Take a fresh snapshot.',
              },
            }) + '\n',
          );
          return;
        }
        socket.end(
          JSON.stringify({
            v: 1,
            id: m.id,
            ok: true,
            result: {clicked: true, url: 'https://fixture.test/', title: 'Fixture'},
          }) + '\n',
        );
        return;
      }
      if (m.op === 'session-disconnect') {
        socket.end(
          JSON.stringify({
            v: 1,
            id: m.id,
            ok: true,
            result: {disconnected: true, preservedUserTabs: true},
          }) + '\n',
        );
      }
    });
  });

  await new Promise(r => host.listen(ipcEndpoint(instanceId, process.platform, env), r));
  t.after(async () => {
    await new Promise(r => host.close(r));
    await fs.rm(dir, {recursive: true, force: true});
    await fs.rm(runtime, {recursive: true, force: true});
  });

  const cliEntry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const run = async args => {
    const r = await command(process.execPath, [cliEntry, ...args], {cwd: workspace, env});
    return r;
  };

  // Open without -s, --profile, or --workspace: auto-generates session and binds cwd.
  const openRes = await run(['open', 'https://fixture.test/', '--json']);
  assert.equal(openRes.code, 0, openRes.err);
  const openData = JSON.parse(openRes.out);
  assert.equal(openData.ok, true);
  assert.equal(openData.profile, 'personal');
  assert.match(openData.session, /^s-[a-f0-9]{6}$/);

  // Zero repo dotfiles created in workspace.
  const entries = await fs.readdir(workspace);
  assert.ok(!entries.includes('.latch'));
  assert.ok(!entries.includes('.playwright'));

  // Action without -s resolves active session automatically; default output is concise text.
  const clickRes = await run(['click', 'e1']);
  assert.equal(clickRes.code, 0, clickRes.err);
  assert.match(clickRes.out, /OK \(click\)/);
  const actionMsg = received.find(m => m.op === 'session-action');
  assert.equal(actionMsg.payload.sessionKey, sessionKey(workspace, openData.session));
  assert.equal(actionMsg.payload.action, 'click');
  assert.deepEqual(actionMsg.payload.args, {target: 'e1'});

  // Error output in --json and default mode.
  const failJson = await run(['click', 'e-timeout', '--json']);
  assert.equal(failJson.code, 1);
  const errData = JSON.parse(failJson.err);
  assert.equal(errData.ok, false);
  assert.equal(errData.error.code, 'ACTION_TIMEOUT');
  assert.equal(errData.error.hint, 'Take a fresh snapshot.');

  const failText = await run(['click', 'e-timeout']);
  assert.equal(failText.code, 1);
  assert.match(failText.err, /ACTION_TIMEOUT/);
  assert.match(failText.err, /Take a fresh snapshot\./);

  // Disconnect without -s clears workspace binding.
  const discRes = await run(['disconnect']);
  assert.equal(discRes.code, 0, discRes.err);
  assert.match(discRes.out, /Disconnected session/);
});
