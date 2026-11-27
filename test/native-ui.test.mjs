import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from '../src/release.mjs';
import {NativeUI} from '../src/native-ui.mjs';
import {NativeSessions} from '../src/native-sessions.mjs';
import {sessionKey} from '../src/redact.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(ROOT, 'work/ui-'));
  const before = process.env.LATCH_CONFIG;
  process.env.LATCH_CONFIG = path.join(dir, 'config.json');
  t.after(async () => {
    before === undefined ? delete process.env.LATCH_CONFIG : (process.env.LATCH_CONFIG = before);
    await fs.rm(dir, {recursive: true, force: true});
  });
  const workspace = await fs.realpath(dir);
  const identity = {
    instanceId: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    hostGeneration: crypto.randomUUID(),
    capabilities: {nativeTransport: true, nativeSessionSchema: 4, uiControl: 1},
  };
  const key = sessionKey(workspace, 'agent');
  await fs.writeFile(
    process.env.LATCH_CONFIG,
    JSON.stringify({profiles: {work: {instanceId: identity.instanceId}, personal: {instanceId: crypto.randomUUID()}}}),
  );
  const browser = async op => (op === 'status' ? {sessions: []} : [{tabId: 1, title: 'Fixture', url: 'https://fixture.test/', owner: key}]);
  const sessions = new NativeSessions(identity, browser);
  const ui = new NativeUI(identity, sessions, browser);
  const leaseId = crypto.randomUUID();
  sessions.sessions.set(key, {
    leaseId,
    session: 'agent',
    workspace,
    tabId: 1,
    focusEmulation: true,
    relay: {status: () => ({stopped: false, cdpEndpoint: 'SECRET'}), stop: async () => {}},
    engine: {close: async () => {}},
  });
  return {dir, workspace, key, identity, leaseId, sessions, ui};
}

test('popup pairing is scoped to its instance and status excludes endpoint secrets and page content', async t => {
  const f = await fixture(t);
  const data = await f.ui.status();
  assert.deepEqual(data.profile.aliases, ['work']);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].revocable, true);
  assert.ok(!JSON.stringify(data).includes('SECRET'));
  assert.ok(!JSON.stringify(data).includes('personal'));
});

test('popup stale identity and busy operations cannot revoke a successor; unconfirmed cleanup is truthful', async t => {
  const f = await fixture(t);
  const p = {key: f.key, leaseId: f.leaseId, revision: f.leaseId, hostGeneration: f.identity.hostGeneration};
  await assert.rejects(f.ui.revoke({...p, leaseId: crypto.randomUUID()}), {code: 'AUTHORITY_STALE'});
  f.sessions.busy.add(f.key);
  await assert.rejects(f.ui.revoke(p), {code: 'SESSION_BUSY'});
  f.sessions.busy.delete(f.key);

  f.sessions.sessions.set(f.key, {
    leaseId: p.leaseId,
    session: 'agent',
    workspace: f.workspace,
    tabId: 1,
    relay: {status: () => ({stopped: true}), stop: async () => {}},
    engine: {close: async () => {}},
  });
  f.sessions.handle = async () => {
    throw Object.assign(new Error('Owned detach unconfirmed'), {code: 'NATIVE_CLEANUP_FAILED'});
  };
  const result = await f.ui.revoke(p);
  assert.equal(result.accessRevoked, true);
  assert.equal(result.cleanup, 'unconfirmed');
});

test('profile labels and status remain bounded, and host shutdown fences UI authority', async t => {
  const f = await fixture(t);
  await fs.writeFile(
    process.env.LATCH_CONFIG,
    JSON.stringify({profiles: {['x'.repeat(100000)]: {instanceId: f.identity.instanceId}}}),
  );
  const data = await f.ui.status();
  assert.equal(data.profile.aliases[0].length, 60);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 49152);
  f.ui.stop();
  await assert.rejects(f.ui.status(), {code: 'BRIDGE_DISCONNECTED'});
});
