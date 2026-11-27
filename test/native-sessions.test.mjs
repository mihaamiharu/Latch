import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeSessions} from '../src/native-sessions.mjs';
import {BrowserModel} from '../src/native-browser-model.mjs';
import {createController} from '../extension/controller.js';

const identity = () => ({
  instanceId: crypto.randomUUID(),
  epoch: crypto.randomUUID(),
  hostGeneration: crypto.randomUUID(),
  extensionId: 'a'.repeat(32),
  capabilities: {nativeTransport: true, nativeSessionSchema: 4, createTab: 1},
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
    targets: () => [{tabId: 1, targetId: 'target'}],
    status: () => ({stopped: false, targetId: 'target'}),
  });
  const engineFactory = async () => ({
    activePage: {},
    pageSummary: async () => ({targetId: 'target', url: 'https://fixture', title: 'Fixture'}),
    action: async () => ({}),
    captureState: async () => ({}),
    selectTarget: async () => ({}),
    close: async () => {},
  });
  const manager = new NativeSessions(
    id,
    async (op, payload) => {
      calls.push([op, payload.sessionKey]);
      if (op === 'native-open' && payload.sessionKey === b) throw Object.assign(new Error('fixture failure'), {code: 'FIXTURE'});
      if (op === 'native-inventory') return {rootTabId: 1, targets: [{tabId: 1}], warnings: []};
      return {};
    },
    {relayFactory, engineFactory},
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

test('session-open/connect default focusEmulation to true and route session-action and session-capture-state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-ns-'));
  const oldCfg = process.env.LATCH_CONFIG;
  process.env.LATCH_CONFIG = path.join(dir, 'config.json');
  t.after(async () => {
    oldCfg === undefined ? delete process.env.LATCH_CONFIG : (process.env.LATCH_CONFIG = oldCfg);
    await fs.rm(dir, {recursive: true, force: true});
  });

  const id = identity();
  const browserCalls = [];
  const engineActions = [];
  const relayFactory = async (_ext, {expectedTabId}) => ({
    extensionEndpoint: 'ws://127.0.0.1:1/extension/' + 'a'.repeat(64),
    cdpEndpoint: 'ws://127.0.0.1:1/cdp/' + 'b'.repeat(64),
    ready: Promise.resolve(),
    stop: async () => {},
    targets: () => [{tabId: expectedTabId, targetId: `target-${expectedTabId}`}],
    status: () => ({stopped: false, targetId: `target-${expectedTabId}`}),
  });
  const engineFactory = async opts => ({
    activePage: {},
    pageSummary: async () => ({targetId: opts.targetId, url: 'https://example.test/', title: 'Example'}),
    action: async (action, args) => {
      engineActions.push({action, args});
      if (action === 'goto') return {url: args.url, title: 'Example', targetId: opts.targetId};
      return {ok: true, action};
    },
    captureState: async () => ({currentTargetId: opts.targetId, pages: [], screenshot: 'AQID'}),
    selectTarget: async () => ({}),
    close: async () => {},
  });

  const manager = new NativeSessions(
    id,
    async (op, payload) => {
      browserCalls.push({op, payload});
      if (op === 'native-create-tab') return {tabId: 101};
      if (op === 'native-inventory') return {rootTabId: 101, targets: [{tabId: 101}], warnings: []};
      return {};
    },
    {relayFactory, engineFactory},
  );

  const opened = await manager.handle('session-open', {
    ...id,
    workspace: dir,
    session: 'main',
    url: 'https://example.test/',
  });
  assert.equal(opened.created, true);
  assert.equal(opened.focusEmulation, true);
  assert.equal(opened.cdpEndpoint, undefined);
  assert.equal(browserCalls.find(c => c.op === 'native-open').payload.focusEmulation, true);
  assert.deepEqual(engineActions[0], {action: 'goto', args: {url: 'https://example.test/'}});

  const listed = await manager.handle('session-list', {...id});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].session, 'main');
  assert.equal(listed.sessions[0].cdpEndpoint, undefined);

  await manager.handle('session-action', {...id, sessionKey: opened.sessionKey, action: 'snapshot', args: {}});
  assert.equal(engineActions.at(-1).action, 'snapshot');

  const captured = await manager.handle('session-capture-state', {...id, sessionKey: opened.sessionKey});
  assert.equal(captured.screenshot, 'AQID');

  const disconnected = await manager.handle('session-disconnect', {
    ...id,
    sessionKey: opened.sessionKey,
    workspace: dir,
    session: 'main',
  });
  assert.equal(disconnected.disconnected, true);
  assert.equal(disconnected.preservedUserTabs, true);
  assert.equal((await manager.handle('session-list', {...id})).sessions.length, 0);
});

test('session-open retains attached session on goto failure when relay stays live, and NATIVE_CLEANUP_FAILED surfaces both causes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-ns-err-'));
  const oldCfg = process.env.LATCH_CONFIG;
  process.env.LATCH_CONFIG = path.join(dir, 'config.json');
  t.after(async () => {
    oldCfg === undefined ? delete process.env.LATCH_CONFIG : (process.env.LATCH_CONFIG = oldCfg);
    await fs.rm(dir, {recursive: true, force: true});
  });

  const id = identity();
  const relayFactory = async (_ext, {expectedTabId}) => ({
    extensionEndpoint: 'ws://127.0.0.1:1/extension/' + 'a'.repeat(64),
    cdpEndpoint: 'ws://127.0.0.1:1/cdp/' + 'b'.repeat(64),
    ready: Promise.resolve(),
    stop: async () => {},
    targets: () => [{tabId: expectedTabId, targetId: `target-${expectedTabId}`}],
    status: () => ({stopped: false, targetId: `target-${expectedTabId}`}),
  });
  const engineFactory = async opts => ({
    closed: false,
    activePage: {},
    pageSummary: async () => ({targetId: opts.targetId, url: 'about:blank', title: ''}),
    action: async action => {
      if (action === 'goto') {
        const err = new Error('net::ERR_NAME_NOT_RESOLVED');
        err.code = 'PLAYWRIGHT_ERROR';
        throw err;
      }
      return {ok: true};
    },
    captureState: async () => ({}),
    selectTarget: async () => ({}),
    close: async () => {},
  });

  const liveManager = new NativeSessions(
    id,
    async op => (op === 'native-create-tab' ? {tabId: 201} : {}),
    {relayFactory, engineFactory},
  );
  await assert.rejects(
    liveManager.handle('session-open', {...id, workspace: dir, session: 'navfail', url: 'https://bad.invalid/'}),
    err => {
      assert.equal(err.code, 'PLAYWRIGHT_ERROR');
      assert.match(err.message, /ERR_NAME_NOT_RESOLVED/);
      assert.equal(err.diagnostics?.connected, true);
      assert.equal(err.diagnostics?.createdTabId, 201);
      assert.match(err.hint, /Tab 201 was created and attached/);
      return true;
    },
  );
  assert.equal((await liveManager.handle('session-list', {...id})).sessions.length, 1);
  await liveManager.stop();

  const failingManager = new NativeSessions(
    id,
    async op => {
      if (op === 'native-create-tab') return {tabId: 202};
      if (op === 'native-open') throw Object.assign(new Error('Open boom'), {code: 'OPEN_BOOM'});
      if (op === 'native-release') throw Object.assign(new Error('Release timed out'), {code: 'BROWSER_TIMEOUT'});
      return {};
    },
    {relayFactory, engineFactory},
  );
  await assert.rejects(
    failingManager.handle('session-open', {...id, workspace: dir, session: 'cleanfail', url: 'https://example.test/'}),
    err => {
      assert.equal(err.code, 'NATIVE_CLEANUP_FAILED');
      assert.match(err.message, /OPEN_BOOM: Open boom/);
      assert.match(err.message, /BROWSER_TIMEOUT: Release timed out/);
      assert.match(err.hint, /latch disconnect/);
      return true;
    },
  );
});

test('hung captureState hits captureTimeoutMs, releases busy lock, and allows immediate disconnect', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-busy-timeout-'));
  const oldCfg = process.env.LATCH_CONFIG;
  process.env.LATCH_CONFIG = path.join(dir, 'config.json');
  t.after(async () => {
    oldCfg === undefined ? delete process.env.LATCH_CONFIG : (process.env.LATCH_CONFIG = oldCfg);
    await fs.rm(dir, {recursive: true, force: true});
  });

  const id = identity();
  const relayFactory = async (_ext, {expectedTabId}) => ({
    extensionEndpoint: 'ws://127.0.0.1:1/extension/' + 'c'.repeat(64),
    cdpEndpoint: 'ws://127.0.0.1:1/cdp/' + 'd'.repeat(64),
    ready: Promise.resolve(),
    stop: async () => {},
    targets: () => [{tabId: expectedTabId, targetId: `target-${expectedTabId}`}],
    status: () => ({stopped: false, targetId: `target-${expectedTabId}`}),
  });
  const engineFactory = async opts => ({
    activePage: {},
    pageSummary: async () => ({targetId: opts.targetId, url: 'https://calendar.example/', title: 'Calendar'}),
    action: async () => ({ok: true}),
    captureState: () => new Promise(() => {}),
    selectTarget: async () => ({}),
    close: async () => {},
  });

  const manager = new NativeSessions(
    id,
    async op => {
      if (op === 'native-create-tab') return {tabId: 301};
      if (op === 'native-inventory') return {rootTabId: 301, targets: [{tabId: 301}], warnings: []};
      return {};
    },
    {relayFactory, engineFactory, captureTimeoutMs: 60},
  );

  const opened = await manager.handle('session-open', {...id, workspace: dir, session: 'hung-qa', url: 'https://calendar.example/'});
  assert.equal(opened.connected, true);

  await assert.rejects(
    manager.handle('session-capture-state', {...id, sessionKey: opened.sessionKey}),
    {code: 'CAPTURE_TIMEOUT'},
  );
  // Busy lock must be cleared immediately after timeout so disconnect succeeds (never wedged in SESSION_BUSY)
  assert.equal(manager.busy.has(opened.sessionKey), false);
  const disc = await manager.handle('session-disconnect', {...id, sessionKey: opened.sessionKey, workspace: dir, session: 'hung-qa'});
  assert.equal(disc.disconnected, true);
});
