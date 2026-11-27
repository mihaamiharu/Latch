import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInstanceId} from '../extension/identity-store.js';
import {ipcEndpoint} from '../src/platform.mjs';
import {command} from './helpers/native-browser.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const OLD = '11111111-1111-4111-8111-111111111111', NEW = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333';

function fakes({stored, saved, readFails = false, writeFails = false}) {
  const state = {stored, saved, writes: 0};
  return {state, storage: {get: async () => (state.stored ? {instanceId: state.stored} : {}), set: async v => { state.stored = v.instanceId; }},
    backup: {read: async () => { if (readFails) throw new Error('unavailable'); return state.saved; },
      write: async id => { if (writeFails) throw new Error('unavailable'); state.writes++; state.saved = id; }},
    randomUUID: () => NEW};
}

test('identity keeps the stored ID, restores from backup and creates one only when both are empty', async () => {
  let f = fakes({stored: OLD, saved: OLD});
  assert.deepEqual(await resolveInstanceId(f), {instanceId: OLD, source: 'storage'});
  assert.equal(f.state.writes, 0);

  f = fakes({stored: OLD});
  assert.deepEqual(await resolveInstanceId(f), {instanceId: OLD, source: 'storage'});
  assert.equal(f.state.saved, OLD, 'an existing install gains a backup on first run');

  f = fakes({saved: OLD});
  assert.deepEqual(await resolveInstanceId(f), {instanceId: OLD, source: 'backup'});
  assert.equal(f.state.stored, OLD);

  f = fakes({});
  assert.deepEqual(await resolveInstanceId(f), {instanceId: NEW, source: 'new'});
  assert.deepEqual([f.state.stored, f.state.saved], [NEW, NEW]);
});

test('identity prefers storage over a conflicting backup, and a broken backup cannot stop startup', async () => {
  let f = fakes({stored: OLD, saved: OTHER});
  assert.equal((await resolveInstanceId(f)).instanceId, OLD);
  assert.equal(f.state.saved, OLD);

  f = fakes({stored: OLD, readFails: true, writeFails: true});
  assert.deepEqual(await resolveInstanceId(f), {instanceId: OLD, source: 'storage'});

  f = fakes({saved: 'not-a-uuid'});
  assert.equal((await resolveInstanceId(f)).source, 'new');

  f = fakes({readFails: true, writeFails: true});
  assert.equal((await resolveInstanceId(f)).instanceId, NEW);
});

async function pairing(t, {live = [NEW], ready = true} = {}) {
  const dir = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'latch-pair-')), runtime = path.join(dir, 'r'), config = path.join(dir, 'config.json');
  await fs.mkdir(runtime, {mode: 0o700});
  const original = {v: 1, profiles: {work: {instanceId: OLD, chromeProfileDir: 'Default'}}};
  await fs.writeFile(config, JSON.stringify(original), {mode: 0o600});
  const env = {...process.env, LATCH_CONFIG: config, LATCH_RUNTIME_DIR: runtime};
  const servers = await Promise.all(live.map(async id => {
    const server = net.createServer(socket => {
      let body = '';
      socket.on('data', chunk => {
        body += chunk; if (!body.includes('\n')) return;
        const message = JSON.parse(body);
        socket.end(JSON.stringify({v: 1, id: message.id, ok: true, result: {instanceId: id, epoch: OTHER, readiness: {verified: ready}, sessions: []}}) + '\n');
      });
    });
    await new Promise(resolve => server.listen(ipcEndpoint(id, process.platform, env), resolve));
    return server;
  }));
  t.after(async () => { for (const server of servers) server.close(); await fs.rm(dir, {recursive: true, force: true}); });
  const pair = async (...extra) => { const r = await command(process.execPath, [cli, 'pair', '--json', '--profile', 'work', ...extra], {env}); return {code: r.code, value: JSON.parse(r.out || r.err)}; };
  const read = async () => JSON.parse(await fs.readFile(config, 'utf8'));
  return {dir, config, original, pair, read};
}
const replacing = (instance = NEW, expectOld = OLD, directory = 'Default') => ['--instance', instance, '--chrome-profile-dir', directory, '--replace', '--expect-old', expectOld];
const assertRefused = async (f, result, code) => {
  assert.equal(result.code, 1); assert.equal(result.value.error.code, code);
  assert.deepEqual(await f.read(), f.original);
  assert.deepEqual((await fs.readdir(f.dir)).filter(n => n.startsWith('config-before')), []);
};

test('pair --replace changes only the instance, after a backup, when the old instance is gone', async t => {
  const f = await pairing(t), {code, value} = await f.pair(...replacing());
  assert.equal(code, 0, JSON.stringify(value));
  assert.equal(value.replaced, true); assert.equal(value.before, OLD); assert.equal(value.after, NEW);
  assert.deepEqual(await f.read(), {...f.original, profiles: {work: {...f.original.profiles.work, instanceId: NEW}}});
  assert.deepEqual(JSON.parse(await fs.readFile(value.backup, 'utf8')), f.original);
  if (process.platform !== 'win32') assert.equal((await fs.stat(value.backup)).mode & 0o777, 0o600);
});

test('pair --replace refuses while the old instance is live, since the new ID may be another profile', async t => {
  const f = await pairing(t, {live: [OLD, NEW]});
  await assertRefused(f, await f.pair(...replacing()), 'PAIRING_OLD_INSTANCE_LIVE');
});

test('pair --replace refuses a stale expectation, a changed directory, an absent or unverified instance', async t => {
  let f = await pairing(t);
  await assertRefused(f, await f.pair(...replacing(NEW, OTHER)), 'PAIRING_CHANGED');
  await assertRefused(f, await f.pair(...replacing(NEW, OLD, 'Profile 1')), 'PAIRING_PROFILE_DIRECTORY_CHANGED');
  await assertRefused(f, await f.pair(...replacing(OTHER)), 'PROFILE_UNAVAILABLE');
  await assertRefused(f, await f.pair(...replacing(OLD, OLD)), 'INVALID_PAIRING');
  f = await pairing(t, {ready: false});
  await assertRefused(f, await f.pair(...replacing()), 'PAIRING_NOT_VERIFIED');
});

test('plain pair still refuses a change, and the replace flags cannot be used alone or elsewhere', async t => {
  const f = await pairing(t);
  await assertRefused(f, await f.pair('--instance', NEW, '--chrome-profile-dir', 'Default'), 'PROFILE_ALREADY_PAIRED');
  await assertRefused(f, await f.pair('--instance', NEW, '--chrome-profile-dir', 'Default', '--replace'), 'INVALID_ARGUMENT');
  await assertRefused(f, await f.pair('--instance', NEW, '--chrome-profile-dir', 'Default', '--expect-old', OLD), 'INVALID_ARGUMENT');
});
