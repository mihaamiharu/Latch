import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {preflight} from '../src/preflight.mjs';
import {diagnose} from '../src/diagnostics.mjs';
import {ipcEndpoint} from '../src/platform.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'latch-preflight-'));
  const runtime = path.join(dir, 'r');
  const workspace = path.join(dir, 'task with spaces');
  await fs.mkdir(runtime);
  await fs.mkdir(workspace);
  const instanceId = crypto.randomUUID();
  const config = path.join(dir, 'app', 'config.json');
  await fs.mkdir(path.dirname(config), {recursive: true});
  await fs.writeFile(
    config,
    JSON.stringify({profiles: {work: {instanceId, chromeProfileDir: 'Default', defaultTransport: 'native'}}, keep: 'untouched'}),
  );
  const env = {LATCH_CONFIG: config, LATCH_RUNTIME_DIR: runtime};
  const socket = ipcEndpoint(instanceId, process.platform, env);
  const before = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const calls = [];
  let cap = {nativeTransport: true, nativeSessionSchema: 4, recoveryContract: 1};
  const server = net.createServer(s => {
    let data = '';
    s.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      const request = JSON.parse(data);
      calls.push(request.op);
      s.end(
        JSON.stringify({
          v: 1,
          id: request.id,
          ok: true,
          result: {instanceId, readiness: {verified: true}, capabilities: cap},
        }) + '\n',
      );
    });
  });
  await new Promise(r => server.listen(socket, r));
  t.after(async () => {
    await fs.chmod(socket, 0o600).catch(() => {});
    await new Promise(r => server.close(r));
    for (const [key, value] of Object.entries(before)) {
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    }
    await fs.rm(dir, {recursive: true, force: true});
  });
  return {
    dir,
    workspace,
    runtime,
    socket,
    config,
    calls,
    setCap: value => (cap = value),
    run: () => preflight({workspace, session: 'fresh'}),
  };
}

test('preflight probes app-data session/runtime paths without writing workspace dotfiles or loopback probes', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.config);
  const result = await f.run();
  assert.equal(result.ready, true);
  assert.equal(result.attachment, 'not-checked');
  assert.equal(result.application, 'not-checked');
  assert.equal(result.permissionTools, 'not-observable-from-cli');
  assert.deepEqual(f.calls, ['status']);
  assert.deepEqual(await fs.readFile(f.config), before);
  for (const directory of Object.values(result.paths)) {
    assert.ok(!(await fs.readdir(directory)).some(n => n.startsWith('.latch-preflight-')));
  }
  assert.deepEqual(await fs.readdir(f.workspace), []);
});

test('denied socket retains paired identity, unknown capabilities and skips state writes', {skip: process.platform === 'win32' || process.getuid?.() === 0}, async t => {
  const f = await fixture(t);
  await fs.chmod(f.socket, 0o000);
  const result = await f.run();
  assert.equal(result.ready, false);
  assert.equal(result.health.configuration.paired, true);
  assert.equal(result.health.connection.error.code, 'BRIDGE_ACCESS_DENIED');
  assert.equal(result.health.layers.native, 'unknown');
  assert.equal(result.checks.find(c => c.id === 'native-capability').status, 'unknown');
  assert.deepEqual(f.calls, []);
});

test('write failure blocks readiness without issuing any browser command or deleting a foreign file', async t => {
  const f = await fixture(t);
  const sessionsFile = path.join(path.dirname(f.config), 'sessions');
  await fs.writeFile(sessionsFile, 'keep');
  const result = await f.run();
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(c => c.id === 'write-sessions').status, 'blocked');
  assert.equal(await fs.readFile(sessionsFile, 'utf8'), 'keep');
  assert.deepEqual(f.calls, ['status']);
});

test('legacy unknown capability is distinct from an explicit unsupported native capability', async t => {
  const f = await fixture(t);
  f.setCap(undefined);
  const unknown = await diagnose();
  assert.equal(unknown.connection.capabilities, null);
  assert.equal(unknown.layers.native, 'unknown');
  const result = await f.run();
  assert.equal(result.ready, false);
  f.setCap({nativeTransport: false});
  assert.equal((await diagnose()).layers.native, 'unavailable');
});
