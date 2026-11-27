import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from '../src/release.mjs';
import {NativeUI} from '../src/native-ui.mjs';
import {NativeSessions} from '../src/native-sessions.mjs';
import {sessionKey} from '../src/redact.mjs';

async function fixture(t, uiOptions = {}) {
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
  const ui = new NativeUI(identity, sessions, browser, uiOptions);
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

test('popup UI exposes library status, lazily opens loopback library server, chooses artifacts folder, and updates artifactsDir', async t => {
  const pickerCalls = [];
  let pickerResult = null;
  let pickerImpl = async initial => {
    pickerCalls.push(initial);
    return typeof pickerResult === 'function' ? pickerResult(initial) : pickerResult;
  };
  const f = await fixture(t, {
    pickDirectory: initial => pickerImpl(initial),
  });
  const customArtifacts = path.join(f.dir, 'custom-artifacts');
  const pickedArtifacts = path.join(f.dir, 'picked-artifacts');
  const beforeArt = process.env.LATCH_ARTIFACT_ROOT;
  delete process.env.LATCH_ARTIFACT_ROOT;
  t.after(async () => {
    f.ui.stop();
    beforeArt === undefined ? delete process.env.LATCH_ARTIFACT_ROOT : (process.env.LATCH_ARTIFACT_ROOT = beforeArt);
  });

  const initialStatus = await f.ui.status();
  assert.equal(initialStatus.library.runCount, 0);
  assert.equal(initialStatus.library.source, 'default');
  assert.equal(initialStatus.library.envOverride, false);
  assert.equal(initialStatus.sessions[0].runId, null);

  await assert.rejects(f.ui.setConfig({key: 'unknownKey', value: customArtifacts}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(f.ui.setConfig({key: 'artifactsDir', value: 'relative/path'}), {code: 'INVALID_ARGUMENT'});

  const saved = await f.ui.setConfig({key: 'artifactsDir', value: customArtifacts});
  assert.equal(saved.updated, true);
  assert.equal(saved.reset, false);
  assert.equal(saved.library.source, 'config');
  assert.equal(saved.library.path, path.resolve(customArtifacts));

  // Cancelling folder picker leaves config unchanged
  pickerResult = null;
  const cancelled = await f.ui.chooseFolder();
  assert.deepEqual(cancelled, {cancelled: true, updated: false});
  assert.equal(pickerCalls.at(-1), path.resolve(customArtifacts));

  // Selecting a folder persists it immediately
  pickerResult = pickedArtifacts;
  const picked = await f.ui.chooseFolder();
  assert.equal(picked.cancelled, false);
  assert.equal(picked.updated, true);
  assert.equal(picked.library.source, 'config');
  assert.equal(picked.library.path, path.resolve(pickedArtifacts));
  assert.equal(pickerCalls.at(-1), path.resolve(customArtifacts));

  // Concurrent picker calls are rejected with UI_BUSY
  let releasePicker;
  pickerResult = () => new Promise(resolve => (releasePicker = resolve));
  const pendingPick = f.ui.chooseFolder();
  await assert.rejects(f.ui.chooseFolder(), {code: 'UI_BUSY'});
  releasePicker(null);
  assert.deepEqual(await pendingPick, {cancelled: true, updated: false});

  // LATCH_ARTIFACT_ROOT locks chooseFolder
  process.env.LATCH_ARTIFACT_ROOT = customArtifacts;
  await assert.rejects(f.ui.chooseFolder(), {code: 'CONFIG_LOCKED'});
  delete process.env.LATCH_ARTIFACT_ROOT;

  const {allocateRun} = await import('../src/exploration-storage.mjs');
  const run = await allocateRun(
    {workspace: f.workspace, session: 'agent', profile: 'work'},
    {objective: 'Popup library link test'},
  );

  const withRunStatus = await f.ui.status();
  assert.equal(withRunStatus.library.runCount, 1);
  assert.equal(withRunStatus.sessions[0].runId, run.id);

  await assert.rejects(f.ui.openLibrary({runId: '../bad'}), {code: 'INVALID_RUN'});
  const opened1 = await f.ui.openLibrary();
  const opened2 = await f.ui.openLibrary({runId: run.id});
  assert.equal(opened1.baseUrl, opened2.baseUrl);
  assert.equal(opened2.url, `${opened1.baseUrl}/run/${run.id}`);
  const pageRes = await fetch(opened1.url);
  assert.equal(pageRes.status, 200);
  assert.match(await pageRes.text(), /Exploration library/);

  const reset = await f.ui.setConfig({key: 'artifactsDir', reset: true});
  assert.equal(reset.reset, true);
  assert.equal(reset.library.source, 'default');

  f.ui.stop();
  await assert.rejects(f.ui.openLibrary(), {code: 'BRIDGE_DISCONNECTED'});
  await assert.rejects(f.ui.chooseFolder(), {code: 'BRIDGE_DISCONNECTED'});
});
