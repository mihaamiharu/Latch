import {checkRequest, bridgeLocator, fault, safeError, webUrl} from './protocol.js';

// This controller uses Chrome APIs only. It never evaluates code in another extension.
export function createController(api, identity, {nativeTransport} = {}) {
  const sessions = new Map();
  const owners = new Map();
  const releasedTabs = new Set();
  let queue = Promise.resolve();
  const plainTab = tab => ({tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId,
    openerTabId: tab.openerTabId, title: tab.title || '', url: tab.url || '', active: !!tab.active, owner: owners.get(tab.id) || null});
  const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const inventory = async session => ({rootTabId: session.rootTabId, warnings: session.warnings.slice(),
    targets: (await Promise.all([...session.targets].map(async ([id, meta]) => {
      try { return {...plainTab(await api.tabs.get(id)), openerTabId: meta.openerTabId, depth: meta.depth}; } catch { return null; }
    }))).filter(Boolean)});
  function forgetNativeTab(key, id) {
    if (owners.get(id) === key) owners.delete(id);
    sessions.get(key)?.targets?.delete(id);
  }
  async function observe(tab) {
    if (owners.has(tab.id) || releasedTabs.has(tab.id) || tab.incognito || (tab.url && tab.url !== 'about:blank' && !webUrl(tab.url))) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = owners.get(tab.openerTabId), session = sessions.get(key);
      if (session?.transport !== 'native' || !session.targets.has(tab.openerTabId) || session.known.has(tab.id)) return;
      const parent = session.targets.get(tab.openerTabId);
      if (session.targets.size >= 16 || parent.depth >= 4 || session.known.size >= 256) {
        if (session.warnings.length < 32) session.warnings.push({code: 'POPUP_LIMIT_EXCEEDED', tabId: tab.id});
        return;
      }
      owners.set(tab.id, key); session.targets.set(tab.id, {openerTabId: tab.openerTabId, depth: parent.depth + 1}); session.known.add(tab.id);
      let result;
      try { result = await nativeTransport.addTab?.(key, tab); } catch { result = false; }
      if (result === true || result === undefined) return;
      if (session.warnings.length < 32) session.warnings.push({code: result?.reason || 'POPUP_OPENER_CHANGED', tabId: tab.id});
      forgetNativeTab(key, tab.id); session.known.delete(tab.id);
      if (result?.openerTabId === undefined || result.openerTabId === null) return;
      tab = {...tab, openerTabId: result.openerTabId};
    }
  }
  async function tabById(id) {
    if (!Number.isSafeInteger(id) || id < 0) throw fault('INVALID_TAB', 'A numeric tab ID is required.');
    try { return await api.tabs.get(id); } catch { throw fault('TAB_CLOSED', 'The requested tab no longer exists.'); }
  }
  async function liveSession(key) {
    const session = sessions.get(key);
    if (!session) throw fault('SESSION_UNAVAILABLE', 'Register this CLI session before claiming a tab.');
    if (session.transport === 'native') throw fault('TRANSPORT_MISMATCH', 'This session uses native transport.');
    try { await api.tabGroups.get(session.groupId); } catch {
      sessions.delete(key);
      for (const [tabId, owner] of owners) if (owner === key) owners.delete(tabId);
      throw fault('SESSION_STALE', 'The registered browser group no longer exists. Reconnect the session.');
    }
    return session;
  }
  async function operate(op, p) {
    if (op === 'status') return {...identity, sessions: [...sessions].map(([key, s]) => ({key, transport: s.transport || 'official',
      groupId: s.groupId, windowId: s.windowId, tabId: s.tabId}))};
    if (op === 'tabs') return (await api.tabs.query({})).filter(t => !t.incognito && webUrl(t.url)).map(plainTab);
    if (typeof p.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(p.sessionKey)) throw fault('INVALID_SESSION', 'Invalid workspace/session key.');
    if (['native-reserve', 'native-open', 'native-check', 'native-release', 'native-drop', 'native-inventory'].includes(op)) {
      if (!nativeTransport?.available) throw fault('DEBUGGER_PERMISSION_REQUIRED', 'This extension build has no debugger permission.');
      const old = sessions.get(p.sessionKey);
      if (old && old.transport !== 'native') throw fault('TRANSPORT_MISMATCH', 'A different transport owns this session.');
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
      if (tab.incognito || !webUrl(tab.url)) throw fault('TAB_UNSUPPORTED', 'Only ordinary HTTP(S) tabs are supported.');
      if (tab.url !== p.expectedUrl) throw fault('TAB_CHANGED', 'The tab URL changed after discovery.');
      if (owners.has(tab.id) && owners.get(tab.id) !== p.sessionKey) throw fault('TAB_OWNED', 'Another session owns this tab.');
      const openerOwner = owners.get(tab.openerTabId);
      if (openerOwner && openerOwner !== p.sessionKey && sessions.get(openerOwner)?.transport !== 'native')
        throw fault('TAB_OWNED', 'An official transport session controls this popup opener.');
      for (const [key, session] of sessions) if (key !== p.sessionKey && session.transport !== 'native' && session.groupId === tab.groupId && tab.groupId >= 0)
        throw fault('TAB_OWNED', 'An official transport session controls this tab group.');
      if (op === 'native-reserve') {
        if (old && !old.targets.has(tab.id)) throw fault('SESSION_TAB_LIMIT', 'Only the starting tab and its attributed children belong to this session.');
        if (!old && sessions.size >= 32) throw fault('SESSION_LIMIT', 'Too many browser sessions.');
        if (!old) sessions.set(p.sessionKey, {transport: 'native', tabId: tab.id, rootTabId: tab.id, windowId: tab.windowId,
          targets: new Map([[tab.id, {depth: 0}]]), known: new Set([tab.id]), warnings: []});
        releasedTabs.delete(tab.id); owners.set(tab.id, p.sessionKey);
        return {...plainTab(tab), alreadyConnected: !!old};
      }
      if (!old?.targets.has(tab.id) || owners.get(tab.id) !== p.sessionKey) throw fault('TAB_NOT_OWNED', 'Reserve this tab before connecting.');
      if (op === 'native-open') {
        await nativeTransport.connect(p.sessionKey, tab, p.endpoint, {focusEmulation: p.focusEmulation === true});
        for (const id of old.targets.keys()) if (id !== tab.id) {
          try { const child = await api.tabs.get(id); await nativeTransport.addTab(p.sessionKey, {...child, openerTabId: old.targets.get(id).openerTabId}); } catch { forgetNativeTab(p.sessionKey, id); }
        }
      } else if (!nativeTransport.isAttached(p.sessionKey, tab.id)) throw fault('SESSION_STALE', 'The native debugger target is no longer attached.');
      return {...plainTab(tab), ...await inventory(old)};
    }
    if (op === 'register') {
      if (sessions.get(p.sessionKey)?.transport === 'native') throw fault('TRANSPORT_MISMATCH', 'This session uses native transport.');
      const locator = bridgeLocator(p.connectUrl);
      if (!locator) throw fault('SESSION_LOCATOR_INVALID', 'A protocol-v2 official Playwright connection locator is required.');
      const matches = (await api.tabs.query({})).filter(t => !t.incognito && bridgeLocator(t.url) === locator);
      if (matches.length !== 1 || matches[0].groupId < 0) throw fault('SESSION_AMBIGUOUS', 'Expected one grouped connection page in this paired profile.');
      const anchor = matches[0];
      for (const [key, other] of sessions) if (key !== p.sessionKey && other.groupId === anchor.groupId)
        throw fault('SESSION_OWNED', 'This group is registered to a different session.');
      const old = sessions.get(p.sessionKey);
      if (old && old.groupId !== anchor.groupId && [...owners.values()].includes(p.sessionKey))
        throw fault('SESSION_OWNED', 'Release this session\'s tabs before replacing its group.');
      const session = {groupId: anchor.groupId, windowId: anchor.windowId, anchorId: anchor.id};
      sessions.set(p.sessionKey, session);
      return session;
    }
    if (op === 'forget') {
      if ([...owners.values()].includes(p.sessionKey)) throw fault('SESSION_BUSY', 'Release owned tabs before forgetting this session.');
      sessions.delete(p.sessionKey);
      return {forgotten: true};
    }
    if (!['claim', 'verify', 'release'].includes(op)) throw fault('INVALID_REQUEST', 'Unsupported browser operation.');
    const session = await liveSession(p.sessionKey);
    const tab = await tabById(p.tabId);
    if (op === 'release') {
      if (owners.get(tab.id) !== p.sessionKey) throw fault('TAB_NOT_OWNED', 'This session does not own the tab.');
      if (tab.groupId === session.groupId) await api.tabs.ungroup([tab.id]);
      owners.delete(tab.id);
      return {released: true, tabId: tab.id};
    }
    if (op === 'verify') {
      if (owners.get(tab.id) !== p.sessionKey || tab.groupId !== session.groupId)
        throw fault('TAB_CHANGED', 'The requested tab left this session during page verification.');
      if (tab.url !== p.expectedUrl) throw fault('TAB_CHANGED', 'The requested tab navigated during page verification.');
      return plainTab(tab);
    }
    if (tab.incognito || !webUrl(tab.url)) throw fault('TAB_UNSUPPORTED', 'Only ordinary HTTP(S) tabs are supported.');
    if (typeof p.expectedUrl !== 'string' || tab.url !== p.expectedUrl) throw fault('TAB_CHANGED', 'The tab URL changed after discovery; rediscover before claiming.');
    if (tab.windowId !== session.windowId) throw fault('WINDOW_MISMATCH', 'The target is in a different work window. This prototype does not relocate tabs.');
    if (owners.has(tab.id) && owners.get(tab.id) !== p.sessionKey) throw fault('TAB_OWNED', 'Another session owns the requested tab.');
    if (tab.groupId >= 0 && tab.groupId !== session.groupId) throw fault('TAB_GROUPED', 'The target belongs to another group; refusing to move it.');
    const alreadyConnected = owners.get(tab.id) === p.sessionKey;
    owners.set(tab.id, p.sessionKey);
    try {
      if (tab.groupId !== session.groupId) await api.tabs.group({tabIds: [tab.id], groupId: session.groupId});
      const current = await tabById(tab.id);
      if (current.url !== p.expectedUrl || current.groupId !== session.groupId) throw fault('TAB_CHANGED', 'The target changed during attachment.');
      return {...plainTab(current), alreadyConnected};
    } catch (error) {
      if (!alreadyConnected) {
        owners.delete(tab.id);
        if (tab.groupId < 0) {
          try { if ((await api.tabs.get(tab.id)).groupId === session.groupId) await api.tabs.ungroup([tab.id]); } catch {}
        }
      }
      throw error;
    }
  }
  async function run(request) {
    try {
      checkRequest(request);
      const p = request.payload;
      if (p.instanceId !== identity.instanceId || p.epoch !== identity.epoch)
        throw fault('PROFILE_MISMATCH', 'The paired browser instance changed. Rediscover before acting.');
      return {v: 1, id: request.id, ok: true, result: await operate(request.op, p)};
    } catch (error) { return {v: 1, id: request?.id, ok: false, error: safeError(error)}; }
  }
  return {
    handle(request) { return enqueue(() => run(request)); },
    observeTab(tab) { return enqueue(() => observe(tab)); },
    nativeDetached(key, id) { return enqueue(() => forgetNativeTab(key, id)); },
    nativeWarning(key, warning) { return enqueue(() => {
      const session=sessions.get(key);
      if(session?.transport==='native'&&session.warnings.length<32)session.warnings.push(warning);
    }); },
    removeTab(id) {
      return enqueue(async () => {
        releasedTabs.delete(id);
        const key = owners.get(id), session = sessions.get(key);
        if (session?.transport === 'native') {
          forgetNativeTab(key, id);
          await nativeTransport.removeTab?.(key, id, {closed: true});
        } else owners.delete(id);
      });
    },
  };
}
