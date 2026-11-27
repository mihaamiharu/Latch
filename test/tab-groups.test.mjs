import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createController, LATCH_GROUP_TITLE, LATCH_GROUP_COLOR} from '../extension/controller.js';
import {parseArgs, runCLI, formatResult} from '../src/cli.mjs';

function mockChrome({tabs: initialTabs = [], groups: initialGroups = []} = {}) {
  const tabs = new Map(initialTabs.map(t => [t.id, {...t}]));
  const groups = new Map(initialGroups.map(g => [g.id, {...g}]));
  let nextTabId = Math.max(100, ...tabs.keys()) + 1;
  let nextGroupId = Math.max(10, ...groups.keys()) + 1;
  const calls = {group: [], ungroup: [], updateGroup: []};

  const api = {
    windows: {
      getAll: async () => [{id: 1, incognito: false, focused: true}],
    },
    tabs: {
      get: async id => {
        if (!tabs.has(id)) throw new Error('TAB_CLOSED');
        return {...tabs.get(id)};
      },
      query: async () => [...tabs.values()].map(t => ({...t})),
      create: async opts => {
        const id = nextTabId++;
        const tab = {id, windowId: opts.windowId ?? 1, url: '', pendingUrl: opts.url, groupId: -1, active: !!opts.active};
        tabs.set(id, tab);
        return {...tab};
      },
      group: async ({tabIds, groupId}) => {
        calls.group.push({tabIds: [...tabIds], groupId});
        let gid = groupId;
        if (gid === undefined) {
          gid = nextGroupId++;
          const firstTab = tabs.get(tabIds[0]);
          groups.set(gid, {id: gid, windowId: firstTab?.windowId ?? 1, title: '', color: 'grey'});
        }
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (t) t.groupId = gid;
        }
        return gid;
      },
      ungroup: async tabId => {
        const ids = Array.isArray(tabId) ? tabId : [tabId];
        calls.ungroup.push(ids);
        for (const id of ids) {
          const t = tabs.get(id);
          if (t) t.groupId = -1;
        }
      },
    },
    tabGroups: {
      query: async filter => {
        return [...groups.values()].filter(g => {
          if (filter?.windowId !== undefined && g.windowId !== filter.windowId) return false;
          if (filter?.title !== undefined && g.title !== filter.title) return false;
          return true;
        });
      },
      update: async (id, props) => {
        calls.updateGroup.push({id, ...props});
        const g = groups.get(id);
        if (g) Object.assign(g, props);
        return {...g};
      },
    },
  };

  return {api, tabs, groups, calls};
}

test('latch open creates a separate per-session Chrome tab group and keeps each session popups inside its own group', async () => {
  const {api, tabs, groups, calls} = mockChrome();
  const identity = {instanceId: crypto.randomUUID(), epoch: crypto.randomUUID()};
  const generation = crypto.randomUUID();
  const keyA = 'a'.repeat(64);
  const keyB = 'b'.repeat(64);
  const leaseA = crypto.randomUUID();
  const leaseB = crypto.randomUUID();
  const native = {available: true, addTab: async () => true, release: async () => {}, removeTab: async () => {}, isAttached: () => true};

  const controller = createController(api, identity, {nativeTransport: native});
  await controller.activateNative(generation);
  const send = (sessionKey, leaseId, op, p = {}) =>
    controller.handle({v: 1, id: crypto.randomUUID(), op, payload: {...identity, hostGeneration: generation, leaseId, sessionKey, ...p}});

  const createdA = await send(keyA, leaseA, 'native-create-tab', {session: 'claude-qa'});
  const createdB = await send(keyB, leaseB, 'native-create-tab', {session: 'codex-qa'});
  assert.equal(createdA.ok, true);
  assert.equal(createdB.ok, true);
  assert.equal(createdA.result.latchGroup, true);
  assert.equal(createdB.result.latchGroup, true);
  assert.notEqual(createdA.result.groupId, createdB.result.groupId);
  assert.equal(groups.get(createdA.result.groupId).title, 'Latch · claude-qa');
  assert.equal(groups.get(createdB.result.groupId).title, 'Latch · codex-qa');

  // Child popup spawned by claude-qa joins claude-qa's group, not codex-qa's
  const popupTab = {id: 500, windowId: 1, url: 'https://staging.example.com/popup', openerTabId: createdA.result.tabId, groupId: -1};
  tabs.set(500, popupTab);
  await controller.observeTab(popupTab);
  assert.equal(tabs.get(500).groupId, createdA.result.groupId);
  assert.equal(calls.updateGroup.length, 2); // one per session group; popup reused parent's group

  // Tabs listing exposes latchGroup: true and per-session latchGroupTitle
  tabs.get(createdA.result.tabId).url = 'https://staging.example.com/a';
  tabs.get(createdB.result.tabId).url = 'https://staging.example.com/b';
  const listed = await send(keyA, leaseA, 'tabs');
  const tabA = listed.result.find(t => t.tabId === createdA.result.tabId);
  const tabB = listed.result.find(t => t.tabId === createdB.result.tabId);
  assert.equal(tabA.latchGroupTitle, 'Latch · claude-qa');
  assert.equal(tabB.latchGroupTitle, 'Latch · codex-qa');
  assert.match(formatResult('tabs', {profile: 'work', tabs: listed.result}), /\[Latch · claude-qa\]/);
});

test('dragging a Latch-grouped tab out of the group detaches automation while preserving the tab; non-Latch connected tabs are unaffected', async () => {
  const {api, tabs} = mockChrome({
    tabs: [
      {id: 10, windowId: 1, url: 'https://staging.example.com/a', groupId: 50},
      {id: 20, windowId: 1, url: 'https://staging.example.com/b', groupId: 99},
    ],
    groups: [
      {id: 50, windowId: 1, title: LATCH_GROUP_TITLE, color: LATCH_GROUP_COLOR},
      {id: 99, windowId: 1, title: 'My Work Group', color: 'blue'},
    ],
  });
  const identity = {instanceId: crypto.randomUUID(), epoch: crypto.randomUUID()};
  const keyA = 'a'.repeat(64);
  const keyB = 'b'.repeat(64);
  const removed = [];
  const released = [];
  const native = {
    available: true,
    preflight: async () => {},
    release: async key => { released.push(key); },
    removeTab: async (key, id, info) => { removed.push({key, id, info}); },
    isAttached: () => true,
  };
  const controller = createController(api, identity, {nativeTransport: native});
  const send = (key, op, p = {}) =>
    controller.handle({v: 1, id: crypto.randomUUID(), op, payload: {...identity, sessionKey: key, ...p}});

  // Connect tab 10 (inside Latch group) and tab 20 (inside user's own group)
  const r1 = await send(keyA, 'native-reserve', {tabId: 10, expectedUrl: 'https://staging.example.com/a'});
  const r2 = await send(keyB, 'native-reserve', {tabId: 20, expectedUrl: 'https://staging.example.com/b'});
  assert.equal(r1.ok, true);
  assert.equal(r1.result.latchGroup, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.result.latchGroup, false);
  // Existing user group was never altered
  assert.equal(tabs.get(20).groupId, 99);

  // Moving tab 20 (which was never in Latch group) out of group 99 does NOT detach it
  tabs.get(20).groupId = -1;
  await controller.observeTab(tabs.get(20), {groupId: -1});
  assert.equal(removed.length, 0);
  assert.equal(released.length, 0);

  // Dragging tab 10 out of the Latch group immediately detaches automation and releases the empty session
  tabs.get(10).groupId = -1;
  await controller.observeTab(tabs.get(10), {groupId: -1});
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 10);
  assert.equal(removed[0].info.reason, 'removed_from_latch_group');
  assert.deepEqual(released, [keyA]);
  // Tab itself remains open in Chrome
  assert.ok(tabs.has(10));
});

test('popup addToLatchGroup and removeFromLatchGroup toggle group membership and detach active sessions cleanly', async () => {
  const {api, tabs} = mockChrome({
    tabs: [{id: 42, windowId: 1, url: 'https://staging.example.com/app', title: 'Staging App', groupId: -1}],
  });
  const identity = {instanceId: crypto.randomUUID(), epoch: crypto.randomUUID()};
  const key = 'c'.repeat(64);
  const released = [];
  const native = {
    available: true,
    preflight: async () => {},
    release: async k => { released.push(k); },
    removeTab: async () => {},
    isAttached: () => true,
  };
  const controller = createController(api, identity, {nativeTransport: native});

  const before = await controller.latchGroupStatus(tabs.get(42));
  assert.equal(before.supported, true);
  assert.equal(before.inGroup, false);

  const added = await controller.addToLatchGroup(tabs.get(42));
  assert.equal(added.inGroup, true);
  assert.ok(tabs.get(42).groupId > -1);

  await controller.handle({
    v: 1,
    id: crypto.randomUUID(),
    op: 'native-reserve',
    payload: {...identity, sessionKey: key, tabId: 42, expectedUrl: 'https://staging.example.com/app'},
  });

  const removed = await controller.removeFromLatchGroup(tabs.get(42));
  assert.equal(removed.inGroup, false);
  assert.equal(removed.owned, false);
  assert.equal(tabs.get(42).groupId, -1);
  assert.deepEqual(released, [key]);
});

test('CLI latch connect without tabId auto-selects unowned Latch-grouped tab and handles ambiguity cleanly', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-group-cli-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const workspace = await fs.realpath(dir);
  const instanceId = crypto.randomUUID();

  assert.equal(parseArgs(['connect']).flags.tab, undefined);
  assert.equal(parseArgs(['connect', '--record']).flags.record, true);

  let mockTabs = [];
  const makeDeps = () => ({
    readConfig: async () => ({profiles: {work: {instanceId, chromeProfileDir: 'Default'}}}),
    workspaceAt: async () => workspace,
    readWorkspaceBinding: async () => null,
    writeWorkspaceBinding: async () => {},
    loadExploration: async () => ({runWithExploration: async (inv, _ver, exec) => exec(inv)}),
    request: async (_id, op, payload) => {
      if (op === 'status') {
        return {instanceId, epoch: 'e1', hostGeneration: 'h1', capabilities: {nativeTransport: true, nativeSessionSchema: 4, createTab: 1}};
      }
      if (op === 'tabs') return mockTabs;
      if (op === 'session-connect') {
        return {connected: true, tabId: payload.tabId, focusEmulation: payload.focusEmulation, page: {url: 'https://staging.example.com', title: 'Staging'}};
      }
    },
  });

  // 1. No tabs in Latch group -> clear NO_LATCH_GROUP_TAB error
  mockTabs = [{tabId: 1, title: 'Docs', url: 'https://docs.example.com', active: true, latchGroup: false, owner: null}];
  await assert.rejects(runCLI(['connect'], makeDeps()), {code: 'NO_LATCH_GROUP_TAB'});

  // 2. Sole unowned tab in Latch group -> auto-selected
  mockTabs = [
    {tabId: 1, title: 'Docs', url: 'https://docs.example.com', active: true, latchGroup: false, owner: null},
    {tabId: 88, title: 'Staging', url: 'https://staging.example.com', active: false, latchGroup: true, owner: null},
  ];
  const single = await runCLI(['connect'], makeDeps());
  assert.equal(single.result.tabId, 88);

  // 3. Multiple unowned Latch tabs with one active -> picks active
  mockTabs = [
    {tabId: 88, title: 'Staging A', url: 'https://staging.example.com/a', active: false, latchGroup: true, owner: null},
    {tabId: 89, title: 'Staging B', url: 'https://staging.example.com/b', active: true, latchGroup: true, owner: null},
  ];
  const activePick = await runCLI(['connect'], makeDeps());
  assert.equal(activePick.result.tabId, 89);

  // 4. Multiple unowned inactive Latch tabs -> TAB_AMBIGUOUS
  mockTabs = [
    {tabId: 88, title: 'Staging A', url: 'https://staging.example.com/a', active: false, latchGroup: true, owner: null},
    {tabId: 89, title: 'Staging B', url: 'https://staging.example.com/b', active: false, latchGroup: true, owner: null},
  ];
  await assert.rejects(runCLI(['connect'], makeDeps()), {code: 'TAB_AMBIGUOUS'});

  // 5. formatResult('tabs', ...) renders [Latch] badge
  const formatted = formatResult('tabs', {profile: 'work', tabs: mockTabs});
  assert.match(formatted, /\[88\] Staging A .* \[Latch\]/);
});
