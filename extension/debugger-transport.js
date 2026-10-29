import {fault} from './protocol.js';
import {ChildSessions,childFilter} from './child-sessions.js';
import {prepareWire} from './transport-limits.js';

const forbidden = new Set(['Network.getAllCookies', 'Network.getCookies', 'Network.setCookies',
  'Network.deleteCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache']);
const domains = new Set(['Accessibility', 'DOM', 'DOMSnapshot', 'CSS', 'Runtime', 'Page', 'Input',
  'Network', 'Emulation', 'Log', 'Performance']);
const allowed = method => typeof method === 'string' && !forbidden.has(method) &&
  (domains.has(method.split('.')[0]) || ['Target.getTargetInfo', 'Target.setAutoAttach'].includes(method));

export function createDebuggerTransport(api, {onTargetGone = () => {}, onWarning = () => {}} = {}) {
  const sessions = new Map(), owners = new Map();
  const available = !!api.debugger;
  let receiptQueue = Promise.resolve();
  const receiptKey = 'latchNativeAttachments';
  const receipt = (tabId, value) => {
    if (!api.storage?.session) return Promise.resolve();
    const result = receiptQueue.then(async () => {
      const records = (await api.storage.session.get(receiptKey))[receiptKey] || {};
      if (value) records[tabId] = value; else delete records[tabId];
      if (Object.keys(records).length > 256) throw fault('SESSION_LIMIT', 'Native attachment receipt limit exceeded.');
      await api.storage.session.set({[receiptKey]: records});
    });
    receiptQueue = result.catch(() => {}); return result;
  };
  async function intent(session, target) {
    if (!api.storage?.session) return;
    const info = (await api.debugger.getTargets()).find(t => t.tabId === target.tab.id);
    if (!info) throw new Error('Target disappeared before attachment.');
    if (info.attached) throw fault('DEBUGGER_CONFLICT', 'Another debugger is attached. Release it before connecting Latch.');
    await receipt(target.tab.id, {tabId: target.tab.id, targetId: info.id, leaseId: session.leaseId || null});
  }
  async function recoverOwned() {
    if (!available || !api.storage?.session) return;
    const records = (await api.storage.session.get(receiptKey))[receiptKey] || {};
    if (Object.keys(records).length > 256) throw fault('NATIVE_CLEANUP_FAILED', 'Attachment receipts exceed their bound.');
    const targets = await api.debugger.getTargets();
    for (const [id, record] of Object.entries(records)) {
      if (!Number.isSafeInteger(record?.tabId) || String(record.tabId) !== id || typeof record.targetId !== 'string') throw fault('NATIVE_CLEANUP_FAILED', 'Attachment receipt is invalid; preserved.');
      const current = targets.find(t => t.tabId === record.tabId && t.id === record.targetId);
      if (current?.attached) {
        let ours = false;
        try { ours = (await api.debugger.sendCommand({tabId: record.tabId}, 'Target.getTargetInfo')).targetInfo?.targetId === record.targetId; }
        catch (e) { if (!/not attached|No tab|No target|closed/i.test(e.message)) throw e; }
        if (ours) await api.debugger.detach({tabId: record.tabId});
      }
      await receipt(record.tabId, null);
    }
  }
  function emit(session, value) {
    if (sessions.get(session.key) === session && !session.closing && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.send(prepareWire(value,session.ws.bufferedAmount).text); }
      catch(error) { onWarning(session.key,{code:error.code||'TRANSPORT_SEND_FAILED'},session.leaseId);session.ws.close(4009,error.code||'TRANSPORT_SEND_FAILED');void release(session.key, session).catch(()=>{}); }
    }
  }
  async function detach(target) {
    target.closing = true;
    if (target.attaching) await target.attaching.catch(() => {});
    if (!target.attached) { await receipt(target.tab.id, null); return; }
    if (target.focusEmulation) await api.debugger.sendCommand({tabId: target.tab.id}, 'Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => {});
    try { await api.debugger.detach({tabId: target.tab.id}); }
    catch (error) {
      const list = await api.debugger.getTargets();
      if (list.some(item => item.tabId === target.tab.id && item.attached)) throw error;
    }
    target.attached = false;
    await receipt(target.tab.id, null);
  }
  async function removeTab(key, tabId, {closed = false} = {}) {
    const session = sessions.get(key), target = session?.targets.get(tabId);
    if (!target) return;
    if (!closed) await detach(target);
    else { target.closing = true; target.attached = false; await receipt(tabId, null); }
    session.targets.delete(tabId); if (sessions.get(key) === session && owners.get(tabId) === key) owners.delete(tabId);
    emit(session, {method: 'tab-removed', params: {tabId}});
    onTargetGone(key, tabId, session.leaseId);
    if (!session.targets.size && !session.closing) session.ws.close();
  }
  async function release(key, expected) {
    const session = sessions.get(key);
    if (expected && session !== expected) return;
    if (!session) return;
    if (session.releasing) return session.releasing;
    session.closing = true;
    session.releasing = (async () => {
      session.ws.close();
      for (const target of [...session.targets.values()]) {
        await detach(target);
        if (owners.get(target.tab.id) === key && sessions.get(key) === session) owners.delete(target.tab.id); session.targets.delete(target.tab.id);
      }
      if (sessions.get(key) === session) sessions.delete(key);
    })();
    try { await session.releasing; }
    catch (error) { session.releasing = undefined; throw fault('NATIVE_CLEANUP_FAILED', String(error.message)); }
  }
  api.debugger?.onEvent.addListener((source, method, params) => {
    const session = sessions.get(owners.get(source.tabId)), target = session?.targets.get(source.tabId);
    if (!target || session.closing || target.closing || target.provisional || (source.sessionId && !target.children.has(source.sessionId))) return;
    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      try {
        const {duplicate}=target.children.add({id:params.sessionId,parent:source.sessionId,
          targetId:params.targetInfo?.targetId,type:params.targetInfo?.type},
          [...session.targets.values()].reduce((n,t)=>n+t.children.size,0));
        if(duplicate)return;
      } catch(error) {
        onWarning(session.key,{code:'CHILD_TARGET_REJECTED',tabId:source.tabId,type:params.targetInfo?.type,reason:error.message},session.leaseId);
        // A conflicting late attachment must not detach a newer live session
        // that happens to use the same native identifier.
        if(target.children.has(params.sessionId))return;
        // Release only this rejected related-target attachment, never its tab.
        // Resume before detach so a paused worker/frame cannot block the app.
        void (async()=>{
          const current=()=>sessions.get(session.key)===session&&session.targets.get(source.tabId)===target&&!session.closing&&!target.closing;
          if(!current())return;
          const resumed=!params.waitingForDebugger||await api.debugger.sendCommand({tabId:source.tabId,sessionId:params.sessionId},'Runtime.runIfWaitingForDebugger').then(()=>true,()=>false);
          if(!current())return;
          const detached=await api.debugger.sendCommand(source,'Target.detachFromTarget',{sessionId:params.sessionId}).then(()=>true,()=>false);
          if(current()&&!resumed&&!detached){
            onWarning(session.key,{code:'CHILD_CLEANUP_FAILED',tabId:source.tabId},session.leaseId);
            await release(session.key, session).catch(()=>{});
          }
        })();
        return;
      }
    }
    if (method === 'Target.detachedFromTarget' && params?.sessionId) target.children.remove(params.sessionId);
    emit(session, {method: 'event', params: {source, method, params}});
  });
  api.debugger?.onDetach.addListener(source => {
    const key = owners.get(source.tabId), session = sessions.get(key), target = session?.targets.get(source.tabId);
    if (!target || target.closing) return;
    // Chrome events contain only a tab ID. A delayed detach notification from
    // an old lifetime must not retire a successor which now owns that same ID.
    void api.debugger.sendCommand({tabId: source.tabId}, 'Target.getTargetInfo').catch(() => {
      if (sessions.get(key) === session && session.targets.get(source.tabId) === target && !target.closing)
        return removeTab(key, source.tabId, {closed: true});
    }).catch(() => {});
  });
  async function addTab(key, tab) {
    const session = sessions.get(key);
    if (!session || session.closing) return false;
    if (session.targets.has(tab.id)) return true;
    if (owners.has(tab.id) || session.targets.size >= 16 || !session.targets.has(tab.openerTabId))
      throw fault('TAB_NOT_OWNED', 'Popup has no live owned parent or exceeds the session limit.');
    const target = {tab, attached: false, provisional: true, children: new ChildSessions(), focusEmulation: session.focusEmulation};
    session.targets.set(tab.id, target); owners.set(tab.id, key);
    const discard = async () => {
      await detach(target);
      session.targets.delete(tab.id); if (owners.get(tab.id) === key) owners.delete(tab.id);
    };
    try {
      // Chrome forbids querying another target's opener through a parent's
      // debugger. Read only identity metadata on this provisional candidate;
      // do not expose it or enable page domains until the real opener matches.
      await intent(session, target);
      await api.debugger.attach({tabId: tab.id}, '1.3'); target.attached = true;
      const {targetInfo} = await api.debugger.sendCommand({tabId: tab.id}, 'Target.getTargetInfo');
      const targets = await api.debugger.getTargets();
      const parent = targets.find(item => item.id === targetInfo?.openerId);
      if (parent?.tabId === undefined || !owners.has(parent.tabId)) { await discard(); return {openerTabId: null, reason: 'POPUP_OPENER_UNAVAILABLE'}; }
      if (parent.tabId !== tab.openerTabId || owners.get(parent.tabId) !== key) {
        await discard(); return {openerTabId: parent.tabId};
      }
      target.provisional = false;
      if (target.focusEmulation) await api.debugger.sendCommand({tabId: tab.id}, 'Emulation.setFocusEmulationEnabled', {enabled: true});
      emit(session, {method: 'tab-created', params: {id: tab.id, url: tab.url || 'about:blank', title: tab.title, openerTabId: parent.tabId}});
      return true;
    } catch {
      await discard().catch(() => {});
      const live = await api.tabs.get(tab.id).catch(() => null);
      return {openerTabId: null, reason: live ? 'POPUP_ATTACH_FAILED' : 'POPUP_CLOSED_BEFORE_ATTACH'};
    }
  }
  async function connect(key, tab, endpoint, {focusEmulation = false, leaseId} = {}) {
    if (!available) throw fault('DEBUGGER_PERMISSION_REQUIRED', 'This extension build has no debugger permission. Native transport is unavailable.');
    if (sessions.has(key) || owners.has(tab.id)) throw fault('TAB_OWNED', 'A native transport already owns this target.');
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.search || url.hash || !/^\/extension\/[a-f0-9]{64}$/.test(url.pathname))
      throw fault('INVALID_ENDPOINT', 'Invalid native relay endpoint.');
    const ws = new WebSocket(url.href);
    const session = {key, ws, leaseId, focusEmulation, targets: new Map([[tab.id, {tab, children: new ChildSessions(), attached: false, focusEmulation}]])};
    sessions.set(key, session); owners.set(tab.id, key);
    ws.onclose = () => { void release(key, session).catch(() => {}); };
    ws.onerror = () => { void release(key, session).catch(() => {}); };
    ws.onmessage = async event => {
      let request;
      try {
        request = JSON.parse(event.data);
        const target = session.targets.get(request.params?.tabId);
        if (!Number.isSafeInteger(request.id) || session.closing || !target || target.closing || owners.get(target.tab.id) !== key)
          throw new Error('Target is not owned by this session.');
        let result;
        if (request.method === 'attach') {
          if (!target.attached) {
            target.attaching ||= intent(session, target).then(() => api.debugger.attach({tabId: target.tab.id}, '1.3')).then(async () => {
              target.attached = true;
              if (target.focusEmulation) await api.debugger.sendCommand({tabId: target.tab.id}, 'Emulation.setFocusEmulationEnabled', {enabled: true});
            });
            await target.attaching;
          }
          if (target.closing || session.closing) throw new Error('Target closed during attachment.');
        } else if (request.method === 'close') {
          await api.tabs.remove(target.tab.id);
        } else if (request.method === 'drop') {
          await removeTab(key, target.tab.id);
        } else if (request.method === 'command' && target.attached && allowed(request.params.method)) {
          const child = request.params.sessionId;
          if (child && !target.children.has(child)) throw new Error('Child target is not owned.');
          // The model enforces target metadata scope too. Do not allow this
          // boundary to query a foreign target via Target.getTargetInfo.
          if (request.params.method === 'Target.getTargetInfo' && request.params.params?.targetId) {
            const info = child ? target.children.get(child).targetId : (await api.debugger.sendCommand({tabId: target.tab.id}, 'Target.getTargetInfo')).targetInfo?.targetId;
            if (info !== request.params.params.targetId) throw new Error('Target is not owned.');
          }
          const lifetime=child&&target.children.get(child);
          const params=request.params.method==='Target.setAutoAttach'&&request.params.params?.autoAttach
            ? {...request.params.params,filter:childFilter(request.params.params.filter)}:request.params.params;
          result = await api.debugger.sendCommand({tabId: target.tab.id, ...(child ? {sessionId: child} : {})}, request.params.method, params);
          if(child&&target.children.get(child)!==lifetime)throw new Error('Child session retired during command.');
        } else throw new Error('Unsupported debugger command.');
        emit(session, {id: request.id, result: result ?? {}});
      } catch (error) {
        if (Number.isSafeInteger(request?.id)) emit(session, {id: request.id, error: String(error.message).slice(0, 300)});
        else void release(key, session).catch(() => {});
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
    } catch (error) { await release(key, session); throw fault('NATIVE_CONNECTION_FAILED', error.message); }
  }
  return {available, connect, addTab, removeTab, release, recoverOwned,
    async preflight(tabId) {
      const target = (await api.debugger.getTargets()).find(t => t.tabId === tabId);
      if (target?.attached) throw fault('DEBUGGER_CONFLICT', 'Another debugger is attached. Release it before connecting Latch.');
    },
    async inspect(key) {
      const session = sessions.get(key);
      if (!session || session.closing || !session.targets.size) return false;
      for (const target of [...session.targets.values()]) {
        if (!target.attached || target.closing) return false;
        try { await api.debugger.sendCommand({tabId: target.tab.id}, 'Target.getTargetInfo'); }
        catch { if (sessions.get(key) === session) await removeTab(key, target.tab.id, {closed: true}); return false; }
      }
      return sessions.get(key) === session && !session.closing;
    },
    isAttached: (key, tabId) => { const s = sessions.get(key), t = s?.targets.get(tabId); return !!t?.attached && !t.closing && !s.closing; },
    releaseAll: () => Promise.allSettled([...sessions.keys()].map(key => release(key)))};
}
