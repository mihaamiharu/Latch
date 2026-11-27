import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePwArgs} from '../src/cli.mjs';
import {sessionKey} from '../src/redact.mjs';
import {ipcEndpoint} from '../src/platform.mjs';
import {command} from './helpers/native-browser.mjs';

test('pw keeps lifecycle and global session/format overrides out of forwarded actions', () => {
  for (const args of [
    [],
    ['attach'],
    ['close-all'],
    ['tab-new'],
    ['click', 'e1', '--session=other'],
    ['snapshot', '-sother'],
    ['snapshot', '-xsother'],
    ['run-code', 'async()=>1', '--json=false'],
    ['snapshot', '--no-json'],
    ['snapshot', '--raw'],
  ]) {
    assert.throws(() => validatePwArgs(args), {code: 'INVALID_ARGUMENT'});
  }
  for (const args of [
    ['snapshot', '--filename=a b.yaml'],
    ['fill', 'e1', 'value with spaces'],
    ['run-code', 'async(page)=>page.title()'],
    ['click', 'e1'],
    ['dialog-accept', 'ok'],
  ]) {
    validatePwArgs(args);
  }
});

test('pw dispatches session-action over IPC and records zero-exit assertion errors cleanly', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-command-'));
  const runtime = path.join(os.tmpdir(), `latch-command-${crypto.randomBytes(5).toString('hex')}`);
  await fs.mkdir(runtime, {mode: 0o700});
  const workspace = await fs.realpath(dir);
  const session = 'test';
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
  await fs.writeFile(config, JSON.stringify({profiles: {work: {instanceId, chromeProfileDir: 'Default'}}}));

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
              capabilities: {nativeTransport: true, nativeSessionSchema: 4, recoveryContract: 1},
              readiness: {verified: true},
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
  const run = async (args, flags = []) => {
    const r = await command(
      process.execPath,
      [cliEntry, 'pw', '--session', session, '--workspace', workspace, ...flags, '--', ...args],
      {cwd: workspace, env},
    );
    return {...r, data: JSON.parse(r.out || r.err)};
  };

  const ok = await run(['click', 'e1']);
  assert.equal(ok.code, 0);
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.clicked, true);
  const actionMsg = received.find(m => m.op === 'session-action');
  assert.equal(actionMsg.payload.sessionKey, sessionKey(workspace, session));
  assert.equal(actionMsg.payload.action, 'click');
  assert.deepEqual(actionMsg.payload.args, {target: 'e1'});

  const evidence = path.join(workspace, 'recorded');
  const captured = await run(['click', 'e-timeout'], [
    '--evidence-dir',
    evidence,
    '--step',
    'timeout-check',
    '--expect-error',
    'ACTION_TIMEOUT',
  ]);
  assert.equal(captured.code, 1);
  assert.equal(captured.data.error.code, 'ACTION_TIMEOUT');
  assert.equal(captured.data.error.evidence.checkStatus, 'pass');
  const check = JSON.parse(await fs.readFile(path.join(evidence, 'result.json'))).checks[0];
  assert.equal(check.operation.helperExitCode, 1);
  assert.equal(check.operation.assertionExitCode, 0);
  assert.equal(check.status, 'pass');
});
