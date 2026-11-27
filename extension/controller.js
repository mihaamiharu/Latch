import {checkRequest, fault, safeError, webUrl} from './protocol.js';

// This controller uses Chrome APIs only. It never evaluates code in another extension.
export function createController(api, identity, {nativeTransport, nativeRecovery = false} = {}) {
  const sessions = new Map();
  const owners = new Map();
  const releasedTabs = new Set();
  let queue = Promise.resolve();
  let nativeGeneration;

  const plainTab = tab => ({
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    openerTabId: tab.openerTabId,
    title: tab.title || '',
    url: tab.url || '',
    active: !!tab.active,
    owner: owners.get(tab.id) || null,
  });

  const enqueue = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };

  const inventory = async session => ({
    rootTabId: session.rootTabId,
    warnings: session.warnings.slice(),
    targets: (await Promise.all([...session.targets].map(async ([id, meta]) => {
      try {
        return {...plainTab(await api.tabs.get(id)), openerTabId: meta.openerTabId, depth: meta.depth};
      } catch {
        return null;
      }
    }))).filter(Boolean),
  });

  function forgetNativeTab(key, id, leaseId) {
    if (leaseId !== undefined && sessions.get(key)?.leaseId !== leaseId) return;
    if (owners.get(id) === key) owners.delete(id);
    sessions.get(key)?.targets?.delete(id);
  }

  async function observe(tab) {
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
      owners.set(tab.id, key);
      session.targets.set(tab.id, {openerTabId: tab.openerTabId, depth: parent.depth + 1});
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
      return (await api.tabs.query({})).filter(t => !t.incognito && webUrl(t.url)).map(plainTab);
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
      sessions.set(p.sessionKey, {
        transport: 'native',
        leaseId: p.leaseId,
        hostGeneration: p.hostGeneration,
        tabId: tab.id,
        rootTabId: tab.id,
        createdTabId: tab.id,
        windowId: tab.windowId,
        targets: new Map([[tab.id, {depth: 0}]]),
        known: new Set([tab.id]),
        warnings: [],
      });
      owners.set(tab.id, p.sessionKey);
      return {...plainTab(tab), created: true};
    }
    if (op === 'native-health') {
      return {healthy: !!old && (nativeTransport.inspect ? await nativeTransport.inspect(p.sessionKey) : true)};
    }
    if (op === 'native-release') {
      if (old && p.tabId !== undefined && !old.known.has(p.tabId)) throw fault('TAB_NOT_OWNED', 'This session does not own that tab.');
      await nativeTransport.release(p.sessionKey);
      for (const [id, owner] of owners) if (owner === p.sessionKey) owners.delete(id);
      sessions.delete(p.sessionKey);
      return {released: true, alreadyReleased: !old};
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
      if (!old) {
        sessions.set(p.sessionKey, {
          transport: 'native',
          leaseId: p.leaseId,
          hostGeneration: p.hostGeneration,
          tabId: tab.id,
          rootTabId: tab.id,
          windowId: tab.windowId,
          targets: new Map([[tab.id, {depth: 0}]]),
          known: new Set([tab.id]),
          warnings: [],
        });
      }
      releasedTabs.delete(tab.id);
      owners.set(tab.id, p.sessionKey);
      return {...plainTab(tab), alreadyConnected: !!old};
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
        for (const [key, session] of sessions) {
          await nativeTransport.release(key);
          for (const [id, owner] of owners) if (owner === key) owners.delete(id);
          if (sessions.get(key) === session) sessions.delete(key);
        }
      });
    },
    handle(request) { return enqueue(() => run(request)); },
    observeTab(tab) { return enqueue(() => observe(tab)); },
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
