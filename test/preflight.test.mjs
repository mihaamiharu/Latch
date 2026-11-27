import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {preflight} from '../src/preflight.mjs';
import {diagnose} from '../src/diagnostics.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/latch-preflight-'), runtime = path.join(dir, 'r'), workspace = path.join(dir, 'task with spaces');
  await fs.mkdir(runtime); await fs.mkdir(workspace);
  const instanceId = crypto.randomUUID(), socket = path.join(runtime, instanceId + '.sock'), config = path.join(dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({profiles: {work: {instanceId, chromeProfileDir: 'Default', defaultTransport: 'native'}}, keep: 'untouched'}));
  const cli = path.join(dir, 'cli'); await fs.writeFile(cli, '#!/bin/sh\nprintf \'{"version":"0.1.20"}\'\n', {mode: 0o700});
  const env = {LATCH_CONFIG: config, LATCH_RUNTIME_DIR: runtime, PWTEST_DAEMON_SESSION_DIR: path.join(dir, 'daemon'), LATCH_PLAYWRIGHT_CLI: cli};
  const before = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const calls = []; let cap = {nativeTransport: true, nativeSessionSchema: 4, recoveryContract: 1};
  const server = net.createServer(s => { let data = ''; s.on('data', chunk => {
    data += chunk; if (!data.includes('\n')) return; const request = JSON.parse(data); calls.push(request.op);
    s.end(JSON.stringify({v: 1, id: request.id, ok: true, result: {instanceId, readiness: {verified: true}, capabilities: cap}}) + '\n');
  }); });
  await new Promise(r => server.listen(socket, r));
  t.after(async () => {
    await fs.chmod(socket, 0o600).catch(() => {}); await new Promise(r => server.close(r));
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await fs.rm(dir, {recursive: true, force: true});
  });
  return {dir, workspace, runtime, socket, config, calls, setCap: value => cap = value, run: () => preflight({workspace, session: 'fresh'})};
}
test('same-caller preflight probes exact task paths without attachment, defaults or retained probe files', async t => {
  const f = await fixture(t), before = await fs.readFile(f.config), result = await f.run();
  assert.equal(result.ready, true); assert.equal(result.attachment, 'not-checked'); assert.equal(result.application, 'not-checked');
  assert.equal(result.permissionTools, 'not-observable-from-cli'); assert.deepEqual(f.calls, ['status']);
  assert.deepEqual(await fs.readFile(f.config), before);
  for (const directory of Object.values(result.paths)) assert.ok(!(await fs.readdir(directory)).some(n => n.startsWith('.latch-preflight-')));
  assert.equal(path.basename(result.paths.daemonCache), crypto.createHash('sha1').update(f.workspace).digest('hex').slice(0, 16));
});
test('denied socket retains paired identity, unknown capabilities and skips task writes', {skip: process.getuid?.() === 0}, async t => {
  const f = await fixture(t); await fs.chmod(f.socket, 0o000); const result = await f.run();
  assert.equal(result.ready, false); assert.equal(result.health.configuration.paired, true);
  assert.equal(result.health.connection.error.code, 'BRIDGE_ACCESS_DENIED'); assert.equal(result.health.layers.native, 'unknown');
  assert.equal(result.checks.find(c => c.id === 'native-capability').status, 'unknown'); assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(path.join(f.workspace, '.playwright')), {code: 'ENOENT'});
});
test('write failure blocks readiness without issuing any browser command or deleting a foreign file', async t => {
  const f = await fixture(t), file = path.join(f.workspace, '.playwright'); await fs.writeFile(file, 'keep');
  const result = await f.run(); assert.equal(result.ready, false); assert.equal(result.checks.find(c => c.id === 'write-workspaceRegistry').status, 'blocked');
  assert.equal(await fs.readFile(file, 'utf8'), 'keep'); assert.deepEqual(f.calls, ['status']);
});
test('legacy unknown capability is distinct from an explicit unsupported native capability', async t => {
  const f = await fixture(t); f.setCap(undefined); const unknown = await diagnose();
  assert.equal(unknown.connection.capabilities, null); assert.equal(unknown.layers.native, 'unknown');
  const result = await f.run(); assert.equal(result.ready, false);
  f.setCap({nativeTransport: false}); assert.equal((await diagnose()).layers.native, 'unavailable');
});
test('denied local networking is a blocked prerequisite without attachment or browser retries', async t => {
  const f = await fixture(t); t.mock.method(net, 'createServer', () => { throw Object.assign(new Error('fixture denied local networking'), {code: 'EPERM'}); });
  const result = await f.run(); assert.equal(result.ready, false); assert.equal(result.checks.find(c => c.id === 'local-loopback').status, 'blocked'); assert.deepEqual(f.calls, ['status']);
});
