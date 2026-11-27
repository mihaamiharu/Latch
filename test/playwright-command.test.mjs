import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePlaywrightArgs} from '../src/playwright-command.mjs';
import {sessionKey} from '../src/playwright.mjs';
import {daemonFile} from '../src/daemon-identity.mjs';
import {recoveryPath} from '../src/recovery-state.mjs';
import {ipcEndpoint} from '../src/platform.mjs';
import {command} from './helpers/native-browser.mjs';

test('pw keeps lifecycle and global session/format overrides out of forwarded commands', () => {
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
    assert.throws(() => validatePlaywrightArgs(args), {code: 'INVALID_ARGUMENT'});
  }
  for (const args of [
    ['snapshot', '--filename=a b.yaml'],
    ['fill', 'e1', 'value with spaces'],
    ['run-code', 'async(page)=>page.title()'],
  ]) {
    validatePlaywrightArgs(args);
  }
});

test('pw propagates zero-exit tool errors and never starts an absent, foreign or stale task', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-command-'));
  const runtime = path.join(os.tmpdir(), `latch-command-${crypto.randomBytes(5).toString('hex')}`);
  await fs.mkdir(runtime, {mode: 0o700});
  const workspace = await fs.realpath(dir);
  const session = 'test';
  const key = sessionKey(workspace, session);
  const instanceId = crypto.randomUUID();
  const epoch = crypto.randomUUID();
  const hostGeneration = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const config = path.join(dir, 'config.json');
  const script = path.join(dir, 'fake-cli');
  const calls = path.join(dir, 'calls.jsonl');
  const daemonRoot = path.join(dir, 'daemon');
  const taskSocket = process.platform === 'win32'
    ? `\\\\.\\pipe\\latch-task-${crypto.randomUUID()}`
    : path.join(runtime, 'task.sock');
  const env = {
    ...process.env,
    LATCH_RUNTIME_DIR: runtime,
    LATCH_CONFIG: config,
    LATCH_PLAYWRIGHT_CLI: script,
    PWTEST_DAEMON_SESSION_DIR: daemonRoot,
  };
  await fs.writeFile(config, JSON.stringify({profiles: {work: {instanceId, chromeProfileDir: 'Default'}}}));
  await fs.writeFile(
    script,
    `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})+'\\n');console.log(JSON.stringify({isError:true,error:'TimeoutError: locator.click: waiting for element to be visible, enabled and stable'}));`,
    {mode: 0o700},
  );

  const priorConfig = process.env.LATCH_CONFIG;
  process.env.LATCH_CONFIG = config;
  const stateFile = recoveryPath(instanceId, key);
  priorConfig === undefined ? delete process.env.LATCH_CONFIG : (process.env.LATCH_CONFIG = priorConfig);

  let currentRecord = null;
  let healthy = true;
  const host = net.createServer(socket => {
    let body = '';
    socket.on('data', b => {
      body += b;
      while (body.includes('\n')) {
        const line = body.slice(0, body.indexOf('\n'));
        body = body.slice(body.indexOf('\n') + 1);
        const m = JSON.parse(line);
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
        if (m.op === 'native-operation') {
          const action = m.payload?.action;
          if (action === 'begin') {
            socket.write(JSON.stringify({v: 1, id: m.id, ok: true, result: {nonce: 'grant-nonce'}}) + '\n');
          } else if (action === 'inspect') {
            socket.write(JSON.stringify({v: 1, id: m.id, ok: true, result: {healthy, record: currentRecord}}) + '\n');
          } else if (action === 'end') {
            socket.write(JSON.stringify({v: 1, id: m.id, ok: true, result: {ended: true}}) + '\n');
          }
        }
      }
    });
  });
  const daemon = net.createServer(socket => socket.end());
  await new Promise(r => host.listen(ipcEndpoint(instanceId, process.platform, env), r));
  await new Promise(r => daemon.listen(taskSocket, r));
  t.after(async () => {
    await Promise.all([host, daemon].map(s => new Promise(r => s.close(r))));
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

  let r = await run(['click', 'e1']);
  assert.equal(r.code, 1);
  assert.equal(r.data.error.code, 'SESSION_UNAVAILABLE');
  await assert.rejects(fs.access(calls), {code: 'ENOENT'});

  await fs.mkdir(path.dirname(stateFile), {recursive: true});
  const baseRecord = {
    v: 4,
    key,
    revision: crypto.randomUUID(),
    instanceId,
    epoch,
    hostGeneration,
    leaseId,
    workspace,
    session,
    status: 'attached',
    stage: 'verified',
    tabId: 1,
  };
  await fs.writeFile(stateFile, JSON.stringify(baseRecord));

  currentRecord = {...baseRecord, workspace: workspace + '-other'};
  r = await run(['snapshot']);
  assert.equal(r.data.error.code, 'SESSION_STALE');

  currentRecord = {...baseRecord};
  r = await run(['snapshot']);
  assert.equal(r.data.error.code, 'DAEMON_IDENTITY_UNCONFIRMED');
  await assert.rejects(fs.access(calls), {code: 'ENOENT'});

  const priorDaemon = process.env.PWTEST_DAEMON_SESSION_DIR;
  process.env.PWTEST_DAEMON_SESSION_DIR = daemonRoot;
  const registry = daemonFile(workspace, session);
  priorDaemon === undefined ? delete process.env.PWTEST_DAEMON_SESSION_DIR : (process.env.PWTEST_DAEMON_SESSION_DIR = priorDaemon);
  await fs.mkdir(path.dirname(registry), {recursive: true});
  await fs.writeFile(
    registry,
    JSON.stringify({name: session, workspaceDir: workspace, attached: true, version: '0.1.20', timestamp: Date.now(), socketPath: taskSocket}),
  );
  const {daemonIdentity} = await import('../src/daemon-identity.mjs');
  process.env.PWTEST_DAEMON_SESSION_DIR = daemonRoot;
  const ident = await daemonIdentity(workspace, session);
  priorDaemon === undefined ? delete process.env.PWTEST_DAEMON_SESSION_DIR : (process.env.PWTEST_DAEMON_SESSION_DIR = priorDaemon);

  currentRecord = {...baseRecord, daemonFingerprint: ident.fingerprint, daemonSocketFingerprint: ident.socketFingerprint};
  r = await run(['click', 'e1']);
  assert.equal(r.code, 1);
  assert.equal(r.data.error.code, 'PLAYWRIGHT_ERROR');
  assert.equal(r.data.error.diagnostics.exitCode, 0);
  assert.match(r.data.error.diagnostics.upstreamError, /visible, enabled and stable/);
  const invoked = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(invoked.length, 1);
  assert.deepEqual(invoked[0], {argv: ['-s=test', '--json', 'click', 'e1'], cwd: workspace});

  const evidence = path.join(workspace, 'recorded');
  const captured = await command(
    process.execPath,
    [
      cliEntry,
      'pw',
      '--session',
      session,
      '--workspace',
      workspace,
      '--evidence-dir',
      evidence,
      '--step',
      'zero-exit',
      '--expect-error',
      'PLAYWRIGHT_ERROR',
      '--',
      'click',
      'e1',
    ],
    {cwd: workspace, env},
  );
  assert.equal(captured.code, 1);
  const normalized = JSON.parse(captured.err);
  assert.equal(normalized.error.code, 'PLAYWRIGHT_ERROR');
  assert.equal(normalized.error.evidence.checkStatus, 'pass');
  const check = JSON.parse(await fs.readFile(path.join(evidence, 'result.json'))).checks[0];
  assert.equal(check.operation.helperExitCode, 1);
  assert.equal(check.operation.upstreamExitCode, 0);
  assert.equal(check.operation.assertionExitCode, 0);
  assert.equal(check.status, 'pass');
});
