import {checkRequest, bridgeLocator, fault, safeError, webUrl} from './protocol.js';

// This controller uses Chrome APIs only. It never evaluates code in another extension.
export function createController(api, identity) {
  const sessions = new Map();
  const owners = new Map();
  let queue = Promise.resolve();
  const plainTab = tab => ({tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId,
    title: tab.title || '', url: tab.url || '', active: !!tab.active, owner: owners.get(tab.id) || null});
  async function tabById(id) {
    if (!Number.isSafeInteger(id) || id < 0) throw fault('INVALID_TAB', 'A numeric tab ID is required.');
    try { return await api.tabs.get(id); } catch { throw fault('TAB_CLOSED', 'The requested tab no longer exists.'); }
  }
  async function liveSession(key) {
    const session = sessions.get(key);
    if (!session) throw fault('SESSION_UNAVAILABLE', 'Register this CLI session before claiming a tab.');
    try { await api.tabGroups.get(session.groupId); } catch {
      sessions.delete(key);
      for (const [tabId, owner] of owners) if (owner === key) owners.delete(tabId);
      throw fault('SESSION_STALE', 'The registered browser group no longer exists. Reconnect the session.');
    }
    return session;
  }
  async function operate(op, p) {
    if (op === 'status') return {...identity, sessions: [...sessions].map(([key, s]) => ({key, groupId: s.groupId, windowId: s.windowId}))};
    if (op === 'tabs') return (await api.tabs.query({})).filter(t => !t.incognito && webUrl(t.url)).map(plainTab);
    if (typeof p.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(p.sessionKey)) throw fault('INVALID_SESSION', 'Invalid workspace/session key.');
    if (op === 'register') {
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
    handle(request) { const result = queue.then(() => run(request)); queue = result.catch(() => {}); return result; },
    removeTab(id) { owners.delete(id); },
  };
}
