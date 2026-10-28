import {HOST, FIXTURE_ORIGIN} from './config.js';

const port = chrome.runtime.connectNative(HOST);
let current;
const forbidden = new Set(['Network.getAllCookies', 'Network.getCookies', 'Network.setCookies',
  'Network.deleteCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache']);
const domains = new Set(['Accessibility', 'DOM', 'DOMSnapshot', 'CSS', 'Runtime', 'Page', 'Input',
  'Network', 'Emulation', 'Log', 'Performance']);

function allowed(method) {
  return typeof method === 'string' && !forbidden.has(method) &&
    (domains.has(method.split('.')[0]) || ['Target.getTargetInfo', 'Target.setAutoAttach'].includes(method));
}
function emit(value) {
  if (current?.ws.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify(value));
}
async function release() {
  const old = current;
  current = undefined;
  if (!old) return;
  old.ws.close();
  if (old.attached) await chrome.debugger.detach({tabId: old.tabId}).catch(() => {});
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!current || source.tabId !== current.tabId) return;
  if (source.sessionId && !current.children.has(source.sessionId)) return;
  if (method === 'Target.attachedToTarget' && params?.sessionId) current.children.add(params.sessionId);
  if (method === 'Target.detachedFromTarget' && params?.sessionId) current.children.delete(params.sessionId);
  emit({method: 'event', params: {source, method, params}});
});
chrome.debugger.onDetach.addListener(source => { if (source.tabId === current?.tabId) void release(); });
port.onDisconnect.addListener(() => {
  console.error('Latch experiment native port closed:', chrome.runtime.lastError?.message || 'disconnected');
  void release();
});

async function operate(message) {
  if (message.op === 'debuggers') return (await chrome.debugger.getTargets())
    .filter(target => target.tabId !== undefined).map(({tabId, attached}) => ({tabId, attached}));
  // Fixture provisioning only; this entire extension is experimental and is
  // never shipped in the production extension directory.
  if (message.op === 'fixtureSeed') {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(FIXTURE_ORIGIN)) throw new Error('Invalid fixture origin.');
    const window = await chrome.windows.create({url: [FIXTURE_ORIGIN + '/work', FIXTURE_ORIGIN + '/unrelated'], type: 'normal'});
    return {seeded: true, windowId: window.id};
  }
  if (message.op === 'tabs') return (await chrome.tabs.query({})).filter(tab =>
    !tab.incognito && /^https?:/.test(tab.url || '')).map(({id, url, title, groupId, windowId}) => ({id, url, title, groupId, windowId}));
  if (message.op === 'release') { await release(); return {released: true}; }
  if (message.op !== 'connect' || current) throw new Error('Unsupported operation or an existing session is active.');
  const tab = await chrome.tabs.get(message.tabId);
  if (tab.incognito || !/^https?:/.test(tab.url || '') || tab.url !== message.expectedUrl)
    throw new Error('Selected target changed or is unsupported.');
  const endpoint = new URL(message.endpoint);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.search || endpoint.hash ||
      !/^\/extension\/[a-f0-9]{64}$/.test(endpoint.pathname)) throw new Error('Invalid local transport.');
  const ws = new WebSocket(endpoint.href);
  const session = {ws, tabId: tab.id, attached: false, children: new Set()};
  current = session;
  ws.onclose = () => { if (current === session) void release(); };
  ws.onerror = () => { if (current === session) void release(); };
  ws.onmessage = async event => {
    let request;
    try {
      request = JSON.parse(event.data);
      if (!Number.isSafeInteger(request.id) || current !== session || request.params?.tabId !== session.tabId)
        throw new Error('Command target is not owned.');
      let result;
      if (request.method === 'attach') {
        await chrome.debugger.attach({tabId: session.tabId}, '1.3');
        if (current !== session) { await chrome.debugger.detach({tabId: session.tabId}); throw new Error('Session closed during attachment.'); }
        session.attached = true;
      } else if (request.method === 'command' && session.attached && allowed(request.params.method)) {
        const child = request.params.sessionId;
        if (child && !session.children.has(child)) throw new Error('Child target is not owned.');
        result = await chrome.debugger.sendCommand({tabId: session.tabId, ...(child ? {sessionId: child} : {})},
          request.params.method, request.params.params);
      } else throw new Error('Unsupported debugger command.');
      emit({id: request.id, result: result ?? {}});
    } catch (error) {
      if (Number.isSafeInteger(request?.id)) emit({id: request.id, error: String(error.message).slice(0, 300)});
      else void release();
    }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay connection timed out.')), 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Relay connection failed.')); }, {once: true});
    ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Relay closed before connection.')); }, {once: true});
  });
  emit({method: 'ready', params: {id: tab.id, url: tab.url, title: tab.title}});
  return {connected: true, tabId: tab.id};
}
port.onMessage.addListener(message => {
  if (!message?.id) return;
  operate(message).then(result => port.postMessage({id: message.id, result}),
    error => { void release(); port.postMessage({id: message.id, error: String(error.message).slice(0, 300)}); });
});
port.postMessage({type: 'hello', extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version});
