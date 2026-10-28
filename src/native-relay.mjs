import http from 'node:http';
import crypto from 'node:crypto';
import {WebSocket, WebSocketServer} from 'ws';
import {BrowserModel} from './native-browser-model.mjs';

const MAX_PENDING = 64;
const MAX_BUFFERED = 8 * 1024 * 1024;

// Experimental single-session relay. Credentials stay in memory and in the
// caller's private native/control channel, never in diagnostic trace output.
export async function createRelay(extensionId, {expectedTabId, onStop} = {}) {
  const paths = {extension: `/extension/${crypto.randomBytes(32).toString('hex')}`,
    cdp: `/cdp/${crypto.randomBytes(32).toString('hex')}`};
  const trace = [];
  const pending = new Map();
  const retiredRequests=new Set();
  let sequence = 0, extension, client, stopped = false, initialized = false, stopPromise, stopReason;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const readyTimer = setTimeout(() => { readyReject(new Error('Extension initialization timed out.')); void stop(); }, 10000);
  function record(direction, method, outcome) {
    if (trace.length < 4096) trace.push({direction, method, ...(outcome ? {outcome} : {})});
  }
  function send(ws, value) {
    if (ws?.readyState !== WebSocket.OPEN) throw new Error('Transport is disconnected.');
    if (ws.bufferedAmount > MAX_BUFFERED) { void stop(); throw new Error('Transport queue exceeded its bound.'); }
    ws.send(JSON.stringify(value));
  }
  function call(method, params) {
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending browser commands.'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id); record('error', method, 'command-timeout'); reject(new Error('Browser command timed out.')); void stop('command-timeout');
      }, 10000);
      pending.set(id, {resolve, reject, timer,method,params});
      try { send(extension, {id, method, params}); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const model = new BrowserModel(call, message => {
    try { if (client) send(client, message); } catch { void stop(); }
  },{onRetire:(tabId,children)=>{
    for(const [id,entry]of pending){
      if(entry.method!=='command'||entry.params?.tabId!==tabId||children&&!children.includes(entry.params.sessionId))continue;
      clearTimeout(entry.timer);pending.delete(id);retiredRequests.add(id);entry.reject(new Error('Target session retired during command.'));
    }
    if(retiredRequests.size>256)void stop('retired-response-limit');
  }});
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const wss = new WebSocketServer({noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false});
  const rejected = socket => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
  server.on('upgrade', (req, socket, head) => {
    const role = req.url === paths.extension ? 'extension' : req.url === paths.cdp ? 'cdp' : null;
    const origin = req.headers.origin;
    if (stopped || !role || req.headers.host !== `127.0.0.1:${server.address()?.port}` ||
        (role === 'extension' ? origin !== `chrome-extension://${extensionId}` : origin !== undefined) ||
        (role === 'extension' ? !!extension : !!client || !initialized)) return rejected(socket);
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => void stop(`${role}-error`));
      ws.on('close', () => void stop(`${role}-disconnected`));
      if (role === 'extension') {
        extension = ws;
        ws.on('message', data => {
          try {
            const message = JSON.parse(data.toString());
            if (Number.isSafeInteger(message.id)) {
              const entry = pending.get(message.id);
              if (!entry) {if(retiredRequests.delete(message.id))return;throw new Error('Unknown browser response.');}
              pending.delete(message.id); clearTimeout(entry.timer);
              message.error ? entry.reject(new Error(String(message.error).slice(0, 300))) : entry.resolve(message.result ?? {});
            } else if (message.method === 'ready' && !initialized && Number.isSafeInteger(message.params?.id)) {
              if (expectedTabId !== undefined && message.params.id !== expectedTabId) throw new Error('Wrong target.');
              model.setTab(message.params); initialized = true;
              clearTimeout(readyTimer); readyResolve();
            } else if (message.method === 'event' && initialized) {
              if (message.params.method === 'Page.lifecycleEvent') record('event', message.params.method, `${message.params.source.tabId}:${message.params.params?.name}`);
              model.onEvent(message.params);
            }
            else if (message.method === 'tab-created' && initialized) void model.addTab(message.params).catch(() => {});
            else if (message.method === 'tab-removed' && initialized) model.removeTab(message.params?.tabId);
            else throw new Error('Invalid extension message.');
          } catch { void stop(); }
        });
      } else {
        client = ws;
        ws.on('message', async data => {
          let message;
          try {
            message = JSON.parse(data.toString());
            if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string' || message.method.length > 120)
              throw new Error('Invalid CDP command.');
            record('command', message.method);
            const result = await model.command(message);
            send(ws, {id: message.id, ...(message.sessionId ? {sessionId: message.sessionId} : {}), result});
            model.didSendResponse(message);
          } catch (error) {
            if (!Number.isSafeInteger(message?.id)) { void stop(); return; }
            record('error', message.method, error.message.slice(0, 300));
            try { send(ws, {id: message.id, ...(message.sessionId ? {sessionId: message.sessionId} : {}),
              error: {code: -32000, message: error.message.slice(0, 300)}}); } catch { void stop(); }
            model.didSendResponse(message);
          }
        });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `ws://127.0.0.1:${server.address().port}`;
  function stop(reason = 'stopped') {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopReason = reason;
    clearTimeout(readyTimer);
    readyReject(new Error('Relay stopped.'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Relay stopped.')); }
    pending.clear();
    for (const ws of wss.clients) ws.terminate();
    stopPromise = new Promise(resolve => server.close(resolve));
    wss.close();
    Promise.resolve().then(() => onStop?.()).catch(() => {});
    return stopPromise;
  }
  return {extensionEndpoint: base + paths.extension, cdpEndpoint: base + paths.cdp, ready, stop,
    status: () => ({initialized, stopped, reason: stopReason, lastMethod: trace.at(-1)?.method,
      tabId: model.tab?.id, targetId: model.inventory().find(target => target.tabId === model.tab?.id)?.targetId,
      targets: model.inventory(), pending: pending.size}),
    targets: () => model.inventory(), trace: () => trace.slice()};
}
