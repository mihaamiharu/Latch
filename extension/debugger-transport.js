import {fault} from './protocol.js';

const forbidden = new Set(['Network.getAllCookies', 'Network.getCookies', 'Network.setCookies',
  'Network.deleteCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache']);
const domains = new Set(['Accessibility', 'DOM', 'DOMSnapshot', 'CSS', 'Runtime', 'Page', 'Input',
  'Network', 'Emulation', 'Log', 'Performance']);
const allowed = method => typeof method === 'string' && !forbidden.has(method) &&
  (domains.has(method.split('.')[0]) || ['Target.getTargetInfo', 'Target.setAutoAttach'].includes(method));

export function createDebuggerTransport(api) {
  const sessions = new Map(), owners = new Map();
  const available = !!api.debugger;
  function emit(session, value) {
    if (session.ws.readyState === WebSocket.OPEN) {
      if (session.ws.bufferedAmount > 8 * 1024 * 1024) { void release(session.key).catch(() => {}); return; }
      session.ws.send(JSON.stringify(value));
    }
  }
  async function release(key) {
    const session = sessions.get(key);
    if (!session) return;
    if (session.releasing) return session.releasing;
    session.closing = true;
    session.releasing = (async () => {
      session.ws.close();
      if (session.attaching) await session.attaching.catch(() => {});
      if (session.attached) {
        if (session.focusEmulation) await api.debugger.sendCommand({tabId: session.tabId}, 'Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => {});
        try { await api.debugger.detach({tabId: session.tabId}); }
        catch (error) {
          const targets = await api.debugger.getTargets();
          if (targets.some(target => target.tabId === session.tabId && target.attached)) throw error;
        }
      }
      if (sessions.get(key) === session) sessions.delete(key);
      if (owners.get(session.tabId) === key) owners.delete(session.tabId);
    })();
    try { await session.releasing; }
    catch (error) { session.releasing = undefined; throw fault('NATIVE_CLEANUP_FAILED', String(error.message)); }
  }
  api.debugger?.onEvent.addListener((source, method, params) => {
    const session = sessions.get(owners.get(source.tabId));
    if (!session || session.closing || (source.sessionId && !session.children.has(source.sessionId))) return;
    if (method === 'Target.attachedToTarget' && params?.sessionId) session.children.add(params.sessionId);
    if (method === 'Target.detachedFromTarget' && params?.sessionId) session.children.delete(params.sessionId);
    emit(session, {method: 'event', params: {source, method, params}});
  });
  api.debugger?.onDetach.addListener(source => {
    const session = sessions.get(owners.get(source.tabId));
    if (session) { session.attached = false; void release(session.key).catch(() => {}); }
  });
  async function connect(key, tab, endpoint, {focusEmulation = false} = {}) {
    if (!available) throw fault('DEBUGGER_PERMISSION_REQUIRED', 'This extension build has no debugger permission. Native transport is unavailable.');
    if (sessions.has(key) || owners.has(tab.id)) throw fault('TAB_OWNED', 'A native transport already owns this target.');
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.search || url.hash ||
        !/^\/extension\/[a-f0-9]{64}$/.test(url.pathname)) throw fault('INVALID_ENDPOINT', 'Invalid native relay endpoint.');
    const ws = new WebSocket(url.href);
    const session = {key, ws, tabId: tab.id, children: new Set(), attached: false, closing: false, focusEmulation};
    sessions.set(key, session); owners.set(tab.id, key);
    ws.onclose = () => { void release(key).catch(() => {}); };
    ws.onerror = () => { void release(key).catch(() => {}); };
    ws.onmessage = async event => {
      let request;
      try {
        request = JSON.parse(event.data);
        if (!Number.isSafeInteger(request.id) || session.closing || owners.get(tab.id) !== key || request.params?.tabId !== tab.id)
          throw new Error('Target is not owned by this session.');
        let result;
        if (request.method === 'attach') {
          if (!session.attached) {
            session.attaching ||= api.debugger.attach({tabId: tab.id}, '1.3').then(async () => {
              session.attached = true;
              if (session.focusEmulation) await api.debugger.sendCommand({tabId: tab.id}, 'Emulation.setFocusEmulationEnabled', {enabled: true});
            });
            await session.attaching;
          }
          if (session.closing) throw new Error('Session closed during attachment.');
        } else if (request.method === 'command' && session.attached && allowed(request.params.method)) {
          const child = request.params.sessionId;
          if (child && !session.children.has(child)) throw new Error('Child target is not owned.');
          result = await api.debugger.sendCommand({tabId: tab.id, ...(child ? {sessionId: child} : {})},
            request.params.method, request.params.params);
        } else throw new Error('Unsupported debugger command.');
        emit(session, {id: request.id, result: result ?? {}});
      } catch (error) {
        if (Number.isSafeInteger(request?.id)) emit(session, {id: request.id, error: String(error.message).slice(0, 300)});
        else void release(key).catch(() => {});
      }
    };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native relay connection timed out.')), 8000);
        const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
        ws.addEventListener('open', () => done(), {once: true});
        ws.addEventListener('error', () => done(new Error('Native relay connection failed.')), {once: true});
        ws.addEventListener('close', () => done(new Error('Native relay closed.')), {once: true});
      });
      emit(session, {method: 'ready', params: {id: tab.id, url: tab.url, title: tab.title}});
    } catch (error) { await release(key); throw fault('NATIVE_CONNECTION_FAILED', error.message); }
  }
  return {available, connect, release,
    isAttached: key => { const s = sessions.get(key); return !!s?.attached && !s.closing; },
    releaseAll: () => Promise.allSettled([...sessions.keys()].map(release))};
}
