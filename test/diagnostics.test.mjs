import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {diagnose} from '../src/diagnostics.mjs';
import {discoverDetailed, request, socketPath} from '../src/local.mjs';

async function fixture(t) {
  const parent = fileURLToPath(new URL('../work/diagnostics-tests/', import.meta.url));
  await fs.mkdir(parent, {recursive: true});
  const work = await fs.mkdtemp(path.join(parent, 'case-'));
  const runtime = path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `latch-diag-${crypto.randomBytes(5).toString('hex')}`);
  await fs.mkdir(runtime, {mode: 0o700});
  const previous = {runtime: process.env.LATCH_RUNTIME_DIR, config: process.env.LATCH_CONFIG};
  process.env.LATCH_RUNTIME_DIR = runtime;
  process.env.LATCH_CONFIG = path.join(work, 'config.json');
  t.after(async () => {
    for (const [name, value] of [['LATCH_RUNTIME_DIR', previous.runtime], ['LATCH_CONFIG', previous.config]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(runtime, {recursive: true, force: true});
    await fs.rm(work, {recursive: true, force: true});
  });
  return {runtime, config: process.env.LATCH_CONFIG, instanceId: crypto.randomUUID()};
}

test('configured pairing with an absent socket remains paired and retains ENOENT', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.config, JSON.stringify({v: 1, profiles: {work: {instanceId: f.instanceId, chromeProfileDir: 'Default'}}}));
  const result = await diagnose('work');
  assert.equal(result.healthy, false);
  assert.equal(result.configuration.paired, true);
  assert.equal(result.socket.exists, false);
  assert.equal(result.connection.error.code, 'PROFILE_UNAVAILABLE');
  assert.match(result.connection.error.message, /ENOENT/);
  assert.ok(result.connection.error.message.includes(result.paths.socket));
  assert.equal(result.paths.configuration, f.config);
  assert.equal(result.execution.platform, process.platform);
});

test('a missing alias is distinguished from an unreachable paired socket', async t => {
  await fixture(t);
  const result = await diagnose('work');
  assert.equal(result.configuration.paired, false);
  assert.equal(result.connection.error.code, 'PROFILE_UNPAIRED');
});

test('discovery preserves unreachable socket failures as diagnostics', async t => {
  const f = await fixture(t);
  const address = socketPath(f.instanceId);
  if (process.platform === 'win32') {
    const server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
  } else {
    await fs.writeFile(address, 'not a listening socket');
  }
  const result = await discoverDetailed();
  assert.deepEqual(result.profiles, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].instanceId, f.instanceId);
  assert.match(result.warnings[0].message, /ECONNREFUSED|ENOTSOCK|disconnected/i);
  assert.equal(result.runtimeDirectory, f.runtime);
});

test('Unix socket access denial is not reported as missing pairing', {skip: process.platform === 'win32' || process.getuid?.() === 0}, async t => {
  const f = await fixture(t);
  const address = socketPath(f.instanceId);
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  t.after(async () => {
    await fs.chmod(address, 0o600).catch(() => {});
    await new Promise(resolve => server.close(resolve));
  });
  await fs.chmod(address, 0o000);
  await assert.rejects(request(f.instanceId, 'status'), error => {
    assert.equal(error.code, 'BRIDGE_ACCESS_DENIED');
    assert.match(error.message, /EACCES|EPERM/);
    assert.ok(error.message.includes(address));
    return true;
  });
});
