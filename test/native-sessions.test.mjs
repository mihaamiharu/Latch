import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {NativeSessions} from '../src/native-sessions.mjs';
import {BrowserModel} from '../src/native-browser-model.mjs';
import {createController} from '../extension/controller.js';

const identity = () => ({
  instanceId: crypto.randomUUID(),
  epoch: crypto.randomUUID(),
  extensionId: 'a'.repeat(32),
  capabilities: {nativeTransport: true},
});
const key = () => crypto.randomBytes(32).toString('hex');

test('native reservations are atomic and preserve existing groups/windows', async () => {
  const id = identity();
  const a = key();
  const b = key();
  const c = key();
  const tabs = [
    {id: 1, windowId: 10, groupId: 90, url: 'https://fixture/same'},
    {id: 2, windowId: 20, groupId: 91, url: 'https://fixture/same'},
  ];
  const native = {available: true, release: async () => {}, isAttached: () => true, connect: async () => {}};
  const api = {
    tabs: {
      get: async id => tabs.find(t => t.id === id),
      query: async () => tabs,
      group: () => {
        throw new Error('Native mode must preserve groups.');
      },
      ungroup: () => {
        throw new Error('Native mode must preserve groups.');
      },
    },
    tabGroups: {get: async () => ({})},
  };
  const controller = createController(api, id, {nativeTransport: native});
  const call = async (op, p) => controller.handle({v: 1, id: crypto.randomUUID(), op, payload: {...id, ...p}});
  const competing = await Promise.all([a, b].map(sessionKey => call('native-reserve', {sessionKey, tabId: 1, expectedUrl: tabs[0].url})));
  assert.equal(competing.filter(r => r.ok).length, 1);
  assert.equal(competing.find(r => !r.ok).error.code, 'TAB_OWNED');
  const winner = competing[0].ok ? a : b;
  assert.equal((await call('native-reserve', {sessionKey: c, tabId: 2, expectedUrl: tabs[1].url})).ok, true);
  assert.equal((await call('native-reserve', {sessionKey: winner, tabId: 2, expectedUrl: tabs[1].url})).ok, false);
  assert.equal((await call('native-release', {sessionKey: winner, tabId: 2})).error.code, 'TAB_NOT_OWNED');
  const bad = await controller.handle({
    v: 1,
    id: crypto.randomUUID(),
    op: 'native-release',
    payload: {...id, epoch: crypto.randomUUID(), sessionKey: winner},
  });
  assert.equal(bad.error.code, 'PROFILE_MISMATCH');
  assert.equal((await call('native-release', {sessionKey: winner, tabId: 1})).ok, true);
  assert.equal((await call('native-check', {sessionKey: c, tabId: 2, expectedUrl: tabs[1].url})).ok, true);
  assert.deepEqual(
    tabs.slice(0, 2).map(t => [t.windowId, t.groupId]),
    [[10, 90], [20, 91]],
  );
});

test('relay session IDs and child routes cannot be reused across agent connections', async () => {
  const make = name =>
    new BrowserModel(
      async (method, params) => (params.method === 'Target.getTargetInfo' ? {targetInfo: {targetId: name}} : {}),
      () => {},
    );
  const a = make('a');
  const b = make('b');
  a.setTab({id: 1});
  b.setTab({id: 2});
  await Promise.all([a.initialize(), b.initialize()]);
  assert.notEqual(a.sessionId, b.sessionId);
  await assert.rejects(a.command({sessionId: b.sessionId, method: 'Runtime.evaluate'}), /not owned/);
  await assert.rejects(b.command({sessionId: a.sessionId, method: 'Runtime.evaluate'}), /not owned/);
  await assert.rejects(a.command({method: 'Target.attachToTarget', params: {targetId: 'b'}}), /not owned/);
  assert.deepEqual(await b.command({method: 'Target.getTargets'}), {targetInfos: [{targetId: 'b'}]});
});

test('failed native bootstrap releases only its reservation; stale identities are rejected first', async () => {
  const id = identity();
  const a = key();
  const b = key();
  const calls = [];
  const relayFactory = async () => ({
    extensionEndpoint: 'private',
    cdpEndpoint: 'private',
    ready: Promise.resolve(),
    stop: async () => {},
    status: () => ({stopped: false, targetId: 'target'}),
  });
  const manager = new NativeSessions(
    id,
    async (op, payload) => {
      calls.push([op, payload.sessionKey]);
      if (op === 'native-open' && payload.sessionKey === b) throw Object.assign(new Error('fixture failure'), {code: 'FIXTURE'});
      return {};
    },
    {relayFactory},
  );
  const p = {...id, sessionKey: a, tabId: 1, expectedUrl: 'https://fixture'};
  assert.equal((await manager.handle('native-connect', p)).alreadyConnected, false);
  await assert.rejects(manager.handle('native-connect', {...p, sessionKey: b, tabId: 2}), {code: 'FIXTURE'});
  assert.equal(manager.sessions.has(a), true);
  assert.equal(manager.sessions.has(b), false);
  assert.ok(calls.some(([op, k]) => op === 'native-release' && k === b));
  assert.ok(!calls.some(([op, k]) => op === 'native-release' && k === a));
  const before = calls.length;
  await assert.rejects(manager.handle('native-disconnect', {...p, epoch: crypto.randomUUID()}), {code: 'PROFILE_MISMATCH'});
  assert.equal(calls.length, before);
  await manager.stop();
});
