import {checkRequest, fault, safeError, webUrl} from './protocol.js';

export const LATCH_GROUP_TITLE = 'Latch';
export const LATCH_GROUP_COLOR = 'green';
export const LATCH_GROUP_COLORS = ['green', 'cyan', 'blue', 'purple', 'orange', 'pink', 'yellow'];
const TAB_GROUP_ID_NONE = -1;
export const FINISH_BEHAVIORS = ['collapse', 'keep', 'ungroup', 'close'];
export const DEFAULT_FINISH_BEHAVIOR = 'collapse';
export const FINISH_BEHAVIOR_KEY = 'finishBehavior';

export function normalizeFinishBehavior(value) {
  return FINISH_BEHAVIORS.includes(value) ? value : DEFAULT_FINISH_BEHAVIOR;
}

export function isLatchGroupTitle(title) {
  return title === LATCH_GROUP_TITLE || (typeof title === 'string' && title.startsWith(`${LATCH_GROUP_TITLE} · `));
}

export function sessionGroupTitle(sessionName) {
  const clean = typeof sessionName === 'string' ? sessionName.trim().slice(0, 40) : '';
  return clean ? `${LATCH_GROUP_TITLE} · ${clean}` : LATCH_GROUP_TITLE;
}

export function sessionGroupColor(seed) {
  if (!seed || typeof seed !== 'string') return LATCH_GROUP_COLOR;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash * 31) + seed.charCodeAt(i)) >>> 0;
  return LATCH_GROUP_COLORS[hash % LATCH_GROUP_COLORS.length];
}

// This controller uses Chrome APIs only. It never evaluates code in another extension.
export function createController(api, identity, {nativeTransport, nativeRecovery = false, getFinishBehavior} = {}) {
  const sessions = new Map();
  const owners = new Map();
  const releasedTabs = new Set();
  let queue = Promise.resolve();
  let nativeGeneration;

  async function latchGroupsMap(windowId) {
    if (typeof api.tabGroups?.query !== 'function') return new Map();
    try {
      const query = windowId !== undefined ? {windowId} : {};
      const groups = await api.tabGroups.query(query);
      const map = new Map();
      for (const g of groups || []) {
        if (Number.isSafeInteger(g?.id) && g.id > TAB_GROUP_ID_NONE && isLatchGroupTitle(g.title)) {
          map.set(g.id, g.title);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async function createOrJoinGroup(tabId, windowId, {title = LATCH_GROUP_TITLE, color = LATCH_GROUP_COLOR, groupId = null, reuseByTitle = false} = {}) {
    if (typeof api.tabs?.group !== 'function') return null;
    try {
      const existing = await latchGroupsMap(windowId);
      let targetGroupId = groupId !== null && existing.has(groupId) ? groupId : null;
      if (targetGroupId === null && reuseByTitle) {
        for (const [id, existingTitle] of existing) {
          if (existingTitle === title) {
            targetGroupId = id;
            break;
          }
        }
      }
      if (targetGroupId !== null) {
        const joined = await api.tabs.group({tabIds: [tabId], groupId: targetGroupId});
        return Number.isSafeInteger(joined) ? joined : targetGroupId;
      }
      const created = await api.tabs.group({tabIds: [tabId]});
      if (Number.isSafeInteger(created) && created > TAB_GROUP_ID_NONE) {
        await api.tabGroups?.update?.(created, {title, color}).catch(() => {});
        return created;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function finishBehavior() {
    try {
      return normalizeFinishBehavior(getFinishBehavior ? await getFinishBehavior() : undefined);
    } catch {
      return DEFAULT_FINISH_BEHAVIOR;
    }
  }

  // Applied after the debugger lease is released. Only tabs that Latch itself
  // created (latch open and its tracked popups) may ever be closed; connected
  // user tabs and tabs added through the popup are always preserved.
  async function applyFinishBehavior(key, session, mode, {allowClose = true} = {}) {
    const outcome = {finishBehavior: mode, closedTabIds: [], collapsedGroupIds: [], ungroupedTabIds: []};
    if (!session || mode === 'keep') return outcome;
    if (mode === 'close' && !allowClose) mode = 'collapse';
    outcome.finishBehavior = mode;
    const live = [];
    for (const [id, meta] of session.targets) {
      try {
        const tab = await api.tabs.get(id);
        if (tab && !tab.incognito) live.push({tab, meta});
      } catch {}
    }
    if (mode === 'close') {
      const ids = live.filter(({meta}) => meta.createdByLatch === true).map(({tab}) => tab.id);
      for (const id of ids) {
        try {
          await api.tabs.remove(id);
          outcome.closedTabIds.push(id);
        } catch {}
      }
      return outcome;
    }
    const latchGroups = await latchGroupsMap();
    const grouped = live.filter(({tab, meta}) =>
      meta.latchGroupId != null && tab.groupId === meta.latchGroupId && latchGroups.has(tab.groupId));
    if (mode === 'ungroup') {
      const ids = grouped.map(({tab}) => tab.id);
      if (ids.length && typeof api.tabs?.ungroup === 'function') {
        try {
          await api.tabs.ungroup(ids);
          outcome.ungroupedTabIds.push(...ids);
        } catch {}
      }
      return outcome;
    }
    // collapse
    if (typeof api.tabGroups?.update !== 'function') return outcome;
    const groupIds = [...new Set(grouped.map(({tab}) => tab.groupId))];
    let allTabs = [];
    try {
      allTabs = await api.tabs.query({});
    } catch {}
    for (const gid of groupIds) {
      const members = allTabs.filter(t => t.groupId === gid);
      // Never collapse a group another live session still uses, and never
      // yank the user's active tab by collapsing the group that holds it.
      if (members.some(t => owners.has(t.id) && owners.get(t.id) !== key)) continue;
      if (members.some(t => t.active)) continue;
      try {
        await api.tabGroups.update(gid, {collapsed: true});
        outcome.collapsedGroupIds.push(gid);
      } catch {}
    }
    return outcome;
  }

  const plainTab = (tab, latchGroups = null) => {
    const hasGroup = !!(latchGroups && Number.isSafeInteger(tab.groupId) && latchGroups.has(tab.groupId));
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      groupId: tab.groupId,
      latchGroup: hasGroup,
      ...(hasGroup ? {latchGroupTitle: latchGroups.get(tab.groupId)} : {}),
      openerTabId: tab.openerTabId,
      title: tab.title || '',
      url: tab.url || '',
      active: !!tab.active,
      owner: owners.get(tab.id) || null,
    };
  };

  const enqueue = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };

  const inventory = async session => {
    const latchGroups = await latchGroupsMap();
    return {
      rootTabId: session.rootTabId,
      warnings: session.warnings.slice(),
      targets: (await Promise.all([...session.targets].map(async ([id, meta]) => {
        try {
          return {...plainTab(await api.tabs.get(id), latchGroups), openerTabId: meta.openerTabId, depth: meta.depth};
        } catch {
          return null;
        }
      }))).filter(Boolean),
    };
  };

  function forgetNativeTab(key, id, leaseId) {
    if (leaseId !== undefined && sessions.get(key)?.leaseId !== leaseId) return;
    if (owners.get(id) === key) owners.delete(id);
    sessions.get(key)?.targets?.delete(id);
  }

  async function handleGroupChange(id, tab) {
    const key = owners.get(id);
    const session = sessions.get(key);
    const meta = session?.targets?.get(id);
    if (!session || !meta || meta.latchGroupId == null) return;
    if (tab.groupId === meta.latchGroupId) return;
    releasedTabs.add(id);
    forgetNativeTab(key, id);
    await nativeTransport.removeTab?.(key, id, {closed: false, reason: 'removed_from_latch_group'});
    if (!session.targets.size) {
      await nativeTransport.release?.(key);
      for (const [tid, owner] of owners) if (owner === key) owners.delete(tid);
      if (sessions.get(key) === session) sessions.delete(key);
    }
  }

  async function observe(tab, change = null) {
    if (change && Object.hasOwn(change, 'groupId')) {
      await handleGroupChange(tab.id, tab);
    }
    if (owners.has(tab.id) || releasedTabs.has(tab.id) || tab.incognito || (tab.url && tab.url !== 'about:blank' && !webUrl(tab.url))) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = owners.get(tab.openerTabId);
      const session = sessions.get(key);
      if (!session || !session.targets.has(tab.openerTabId) || session.known.has(tab.id)) return;
      const parent = session.targets.get(tab.openerTabId);
      if (session.targets.size >= 16 || parent.depth >= 4 || session.known.size >= 256) {
        if (session.warnings.length < 32) session.warnings.push({code: 'POPUP_LIMIT_EXCEEDED', tabId: tab.id});
        return;
      }
      let childLatchGroupId = null;
      if (parent.latchGroupId != null) {
        childLatchGroupId =
          tab.groupId === parent.latchGroupId
            ? parent.latchGroupId
            : await createOrJoinGroup(tab.id, tab.windowId, {
                groupId: parent.latchGroupId,
                title: session.groupTitle || LATCH_GROUP_TITLE,
                color: session.groupColor || LATCH_GROUP_COLOR,
                reuseByTitle: true,
              });
      }
      owners.set(tab.id, key);
      session.targets.set(tab.id, {
        openerTabId: tab.openerTabId,
        depth: parent.depth + 1,
        latchGroupId: childLatchGroupId,
        createdByLatch: parent.createdByLatch === true,
      });
      session.known.add(tab.id);
      let result;
      try {
        result = await nativeTransport.addTab?.(key, tab);
      } catch {
        result = false;
      }
      if (result === true || result === undefined) return;
      if (session.warnings.length < 32) session.warnings.push({code: result?.reason || 'POPUP_OPENER_CHANGED', tabId: tab.id});
      forgetNativeTab(key, tab.id);
      session.known.delete(tab.id);
      if (result?.openerTabId === undefined || result.openerTabId === null) return;
      tab = {...tab, openerTabId: result.openerTabId};
    }
  }

  async function tabById(id) {
    if (!Number.isSafeInteger(id) || id < 0) throw fault('INVALID_TAB', 'A numeric tab ID is required.');
    try {
      return await api.tabs.get(id);
    } catch {
      throw fault('TAB_CLOSED', 'The requested tab no longer exists.');
    }
  }

  async function operate(op, p) {
    if (op === 'status') {
      return {
        ...identity,
        sessions: [...sessions].map(([key, s]) => ({
          key,
          transport: 'native',
          groupId: s.groupId,
          windowId: s.windowId,
          tabId: s.tabId,
        })),
      };
    }
    if (op === 'tabs') {
      const latchGroups = await latchGroupsMap();
      return (await api.tabs.query({})).filter(t => !t.incognito && webUrl(t.url)).map(t => plainTab(t, latchGroups));
    }
    if (typeof p.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(p.sessionKey)) {
      throw fault('INVALID_SESSION', 'Invalid workspace/session key.');
    }
    if (!['native-create-tab', 'native-reserve', 'native-open', 'native-check', 'native-release', 'native-drop', 'native-inventory', 'native-health'].includes(op)) {
      throw fault('INVALID_REQUEST', 'Unsupported browser operation.');
    }
    if (!nativeTransport?.available) {
      throw fault('DEBUGGER_PERMISSION_REQUIRED', 'This extension build has no debugger permission.');
    }
    const old = sessions.get(p.sessionKey);
    if ((nativeRecovery || nativeGeneration) && (!nativeGeneration || p.hostGeneration !== nativeGeneration || typeof p.leaseId !== 'string')) {
      throw fault('AUTHORITY_STALE', 'Native authority is unavailable or changed.');
    }
    if (old && (old.leaseId !== p.leaseId || old.hostGeneration !== p.hostGeneration)) {
      throw fault('AUTHORITY_STALE', 'Native lease changed.');
    }
    if (op === 'native-create-tab') {
      if (old) throw fault('SESSION_COLLISION', 'Use a fresh session name to open a new tab.');
      if (sessions.size >= 32) throw fault('SESSION_LIMIT', 'Too many browser sessions.');
      // about:blank cannot redirect before attachment/identity verification.
      // Only this exact leased tab may bypass the normal HTTP(S) admission.
      const windows = (await api.windows.getAll({windowTypes: ['normal']})).filter(w => !w.incognito);
      const window = windows.find(w => w.focused) || windows[0];
      if (!window) throw fault('WINDOW_UNAVAILABLE', 'Open a regular Chrome window in the paired profile first.');
      const tab = await api.tabs.create({windowId: window.id, url: 'about:blank', active: false});
      if (!tab.url && tab.pendingUrl === 'about:blank') tab.url = 'about:blank';
      if (tab.incognito || !Number.isSafeInteger(tab.id) || tab.url !== 'about:blank') {
        throw fault('TAB_CHANGED', 'The newly created tab changed before reservation; it was preserved.');
      }
      const groupTitle = sessionGroupTitle(p.session);
      const groupColor = sessionGroupColor(p.session || p.sessionKey);
      const latchGroupId = await createOrJoinGroup(tab.id, tab.windowId, {
        title: groupTitle,
        color: groupColor,
        reuseByTitle: false,
      });
      if (latchGroupId != null) tab.groupId = latchGroupId;
      sessions.set(p.sessionKey, {
        transport: 'native',
        leaseId: p.leaseId,
        hostGeneration: p.hostGeneration,
        tabId: tab.id,
        rootTabId: tab.id,
        createdTabId: tab.id,
        groupId: latchGroupId ?? tab.groupId,
        groupTitle,
        groupColor,
        windowId: tab.windowId,
        targets: new Map([[tab.id, {depth: 0, latchGroupId, createdByLatch: true}]]),
        known: new Set([tab.id]),
        warnings: [],
      });
      owners.set(tab.id, p.sessionKey);
      const latchGroups = latchGroupId != null ? new Map([[latchGroupId, groupTitle]]) : null;
      return {...plainTab(tab, latchGroups), created: true};
    }
    if (op === 'native-health') {
      return {healthy: !!old && (nativeTransport.inspect ? await nativeTransport.inspect(p.sessionKey) : true)};
    }
    if (op === 'native-release') {
      if (old && p.tabId !== undefined && !old.known.has(p.tabId)) throw fault('TAB_NOT_OWNED', 'This session does not own that tab.');
      await nativeTransport.release(p.sessionKey);
      for (const [id, owner] of owners) if (owner === p.sessionKey) owners.delete(id);
      sessions.delete(p.sessionKey);
      const mode = p.closeTabs === true ? 'close' : await finishBehavior();
      const tabOutcome = old ? await applyFinishBehavior(p.sessionKey, old, mode) : {finishBehavior: mode};
      return {released: true, alreadyReleased: !old, ...tabOutcome};
    }
    if (op === 'native-inventory') return old ? inventory(old) : {targets: [], warnings: []};
    if (op === 'native-drop') {
      if (!old?.targets.has(p.tabId) || owners.get(p.tabId) !== p.sessionKey) throw fault('TAB_NOT_OWNED', 'This session does not own that tab.');
      releasedTabs.add(p.tabId);
      await nativeTransport.removeTab(p.sessionKey, p.tabId);
      forgetNativeTab(p.sessionKey, p.tabId);
      return {released: true, ...await inventory(old), sessionClosed: !old.targets.size};
    }
    const tab = await tabById(p.tabId);
    if (old?.createdTabId === tab.id && !tab.url && tab.pendingUrl === 'about:blank') tab.url = 'about:blank';
    if (tab.incognito || !(webUrl(tab.url) || tab.url === 'about:blank' && old?.createdTabId === tab.id)) {
      throw fault('TAB_UNSUPPORTED', 'Only ordinary HTTP(S) tabs and this session’s newly created blank tab are supported.');
    }
    if (tab.url !== p.expectedUrl) throw fault('TAB_CHANGED', 'The tab URL changed after discovery.');
    if (owners.has(tab.id) && owners.get(tab.id) !== p.sessionKey) throw fault('TAB_OWNED', 'Another session owns this tab.');
    if (op === 'native-reserve') {
      if (old && !old.targets.has(tab.id)) throw fault('SESSION_TAB_LIMIT', 'Only the starting tab and its attributed children belong to this session.');
      if (!old && sessions.size >= 32) throw fault('SESSION_LIMIT', 'Too many browser sessions.');
      if (!old) await nativeTransport.preflight?.(tab.id);
      const latchGroups = await latchGroupsMap(tab.windowId);
      const inLatchGroup = Number.isSafeInteger(tab.groupId) && latchGroups.has(tab.groupId);
      if (!old) {
        sessions.set(p.sessionKey, {
          transport: 'native',
          leaseId: p.leaseId,
          hostGeneration: p.hostGeneration,
          tabId: tab.id,
          rootTabId: tab.id,
          groupId: tab.groupId,
          groupTitle: inLatchGroup ? latchGroups.get(tab.groupId) : null,
          groupColor: LATCH_GROUP_COLOR,
          windowId: tab.windowId,
          targets: new Map([[tab.id, {depth: 0, latchGroupId: inLatchGroup ? tab.groupId : null}]]),
          known: new Set([tab.id]),
          warnings: [],
        });
      }
      releasedTabs.delete(tab.id);
      owners.set(tab.id, p.sessionKey);
      return {...plainTab(tab, latchGroups), alreadyConnected: !!old};
    }
    if (!old?.targets.has(tab.id) || owners.get(tab.id) !== p.sessionKey) throw fault('TAB_NOT_OWNED', 'Reserve this tab before connecting.');
    if (op === 'native-open') {
      await nativeTransport.connect(p.sessionKey, tab, p.endpoint, {focusEmulation: p.focusEmulation === true, leaseId: p.leaseId});
      for (const id of old.targets.keys()) {
        if (id === tab.id) continue;
        try {
          const child = await api.tabs.get(id);
          await nativeTransport.addTab(p.sessionKey, {...child, openerTabId: old.targets.get(id).openerTabId});
        } catch {
          forgetNativeTab(p.sessionKey, id);
        }
      }
    } else if (!nativeTransport.isAttached(p.sessionKey, tab.id)) {
      throw fault('SESSION_STALE', 'The native debugger target is no longer attached.');
    }
    return {...plainTab(tab), ...await inventory(old)};
  }

  async function run(request) {
    try {
      checkRequest(request, {internal: true});
      const p = request.payload;
      if (p.instanceId !== identity.instanceId || p.epoch !== identity.epoch) {
        throw fault('PROFILE_MISMATCH', 'The paired browser instance changed. Rediscover before acting.');
      }
      return {v: 1, id: request.id, ok: true, result: await operate(request.op, p)};
    } catch (error) {
      return {v: 1, id: request?.id, ok: false, error: safeError(error)};
    }
  }

  return {
    activateNative(generation) {
      return enqueue(() => { nativeGeneration = generation; });
    },
    invalidateNative() {
      nativeGeneration = null;
      return enqueue(async () => {
        const mode = await finishBehavior();
        for (const [key, session] of sessions) {
          await nativeTransport.release(key);
          for (const [id, owner] of owners) if (owner === key) owners.delete(id);
          if (sessions.get(key) === session) sessions.delete(key);
          // Losing the bridge is not a deliberate finish: never close tabs here.
          await applyFinishBehavior(key, session, mode, {allowClose: false}).catch(() => {});
        }
      });
    },
    handle(request) { return enqueue(() => run(request)); },
    observeTab(tab, change = null) { return enqueue(() => observe(tab, change)); },
    latchGroupStatus(tab) {
      return enqueue(async () => {
        if (!tab || tab.incognito || !webUrl(tab.url)) {
          return {supported: false, tabId: tab?.id ?? null, title: tab?.title || '', inGroup: false, owned: false};
        }
        const latchGroups = await latchGroupsMap(tab.windowId);
        return {
          supported: true,
          tabId: tab.id,
          title: tab.title || '',
          inGroup: Number.isSafeInteger(tab.groupId) && latchGroups.has(tab.groupId),
          groupTitle: latchGroups.get(tab.groupId) || null,
          owned: owners.has(tab.id),
        };
      });
    },
    addToLatchGroup(tab) {
      return enqueue(async () => {
        if (!tab || tab.incognito || !webUrl(tab.url)) {
          throw fault('TAB_UNSUPPORTED', 'Only ordinary HTTP(S) tabs can be added to the Latch tab group.');
        }
        const groupId = await createOrJoinGroup(tab.id, tab.windowId, {
          title: LATCH_GROUP_TITLE,
          color: LATCH_GROUP_COLOR,
          reuseByTitle: true,
        });
        if (groupId == null) {
          throw fault('GROUP_UNAVAILABLE', 'Chrome tab groups are unavailable for this tab.');
        }
        const key = owners.get(tab.id);
        const meta = sessions.get(key)?.targets?.get(tab.id);
        if (meta) meta.latchGroupId = groupId;
        return {supported: true, tabId: tab.id, title: tab.title || '', groupId, inGroup: true, owned: owners.has(tab.id)};
      });
    },
    removeFromLatchGroup(tab) {
      return enqueue(async () => {
        if (!tab || !Number.isSafeInteger(tab.id)) {
          throw fault('TAB_UNAVAILABLE', 'No active tab to remove from the Latch group.');
        }
        if (typeof api.tabs?.ungroup === 'function' && tab.groupId > TAB_GROUP_ID_NONE) {
          await api.tabs.ungroup(tab.id);
        }
        await handleGroupChange(tab.id, {...tab, groupId: TAB_GROUP_ID_NONE});
        return {supported: webUrl(tab.url), tabId: tab.id, title: tab.title || '', inGroup: false, owned: owners.has(tab.id)};
      });
    },
    nativeDetached(key, id, leaseId) { return enqueue(() => forgetNativeTab(key, id, leaseId)); },
    nativeWarning(key, warning, leaseId) {
      return enqueue(() => {
        const session = sessions.get(key);
        if (session && (leaseId === undefined || session.leaseId === leaseId) && session.warnings.length < 32) {
          session.warnings.push(warning);
        }
      });
    },
    removeTab(id) {
      return enqueue(async () => {
        releasedTabs.delete(id);
        const key = owners.get(id);
        const session = sessions.get(key);
        if (session) {
          forgetNativeTab(key, id);
          await nativeTransport.removeTab?.(key, id, {closed: true});
        } else {
          owners.delete(id);
        }
      });
    },
  };
}
