import http from 'node:http';
import crypto from 'node:crypto';
import {WebSocket, WebSocketServer} from 'ws';
import {BrowserModel} from './native-browser-model.mjs';
import {liveViewStream} from './live-view-stream.mjs';
import {TRANSPORT_LIMITS,prepareWire,browserDeadline} from '../extension/transport-limits.js';

const MAX_PENDING = TRANSPORT_LIMITS.pending;

// Experimental single-session relay. Credentials stay in memory and in the
// caller's private native/control channel, never in diagnostic trace output.
export async function createRelay(extensionId, {expectedTabId, onStop} = {}) {
  const paths = {extension: `/extension/${crypto.randomBytes(32).toString('hex')}`,
    cdp: `/cdp/${crypto.randomBytes(32).toString('hex')}`,
    view: `/view/${crypto.randomBytes(32).toString('hex')}`};
  const trace = [];
  const pending = new Map();
  const metrics={sentBytes:0,receivedBytes:0,maxSentMessage:0,maxReceivedMessage:0,maxAdmittedBytes:0,maxObservedBuffered:0,pendingHighWater:0,commands:0,events:0,timeouts:0};
  const retiredRequests=new Set();
  let sequence = 0, extension, client, stopped = false, initialized = false, stopPromise, stopReason, externalScreencast = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const readyTimer = setTimeout(() => { readyReject(new Error('Extension initialization timed out.')); void stop(); }, 10000);
  function record(direction, method, outcome) {
    if (trace.length < 4096) trace.push({direction, method, ...(outcome ? {outcome} : {})});
  }
  function send(ws, value) {
    if (ws?.readyState !== WebSocket.OPEN) throw new Error('Transport is disconnected.');
    try {
      const before=ws.bufferedAmount,{text,bytes}=prepareWire(value,before);
      metrics.sentBytes+=bytes;metrics.maxSentMessage=Math.max(metrics.maxSentMessage,bytes);
      metrics.maxAdmittedBytes=Math.max(metrics.maxAdmittedBytes,before+bytes);
      ws.send(text);metrics.maxObservedBuffered=Math.max(metrics.maxObservedBuffered,ws.bufferedAmount);
    } catch(error) { void stop(error.code||'send-error'); throw error; }
  }
  function call(method, params) {
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending browser commands.'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const deadline=browserDeadline(method,params);
      const timer = setTimeout(() => {
        metrics.timeouts++;metrics.lastTimeout={method:params?.method||method,deadlineMs:deadline};
        pending.delete(id); record('error', method, 'command-timeout'); reject(new Error(`Browser command ${params?.method||method} timed out after ${deadline}ms.`)); setImmediate(()=>void stop('command-timeout'));
      }, deadline);
      pending.set(id, {resolve, reject, timer,method,params});metrics.pendingHighWater=Math.max(metrics.pendingHighWater,pending.size);
      try { send(extension, {id, method, params}); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const view = liveViewStream({call, rootTab: () => model.tab?.id, isStopped: () => stopped});
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
  const wss = new WebSocketServer({noServer: true, maxPayload: TRANSPORT_LIMITS.message, perMessageDeflate: false});
  const rejected = socket => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
  server.on('upgrade', (req, socket, head) => {
    const role = req.url === paths.extension ? 'extension' : req.url === paths.cdp ? 'cdp' : req.url === paths.view ? 'view' : null;
    const origin = req.headers.origin;
    if (stopped || !role || req.headers.host !== `127.0.0.1:${server.address()?.port}` ||
        (role === 'extension' ? origin !== `chrome-extension://${extensionId}` : origin !== undefined) ||
        (role === 'extension' ? !!extension : role === 'view' ? !initialized || !client || externalScreencast || !view.available() : !!client || !initialized)) return rejected(socket);
    wss.handleUpgrade(req, socket, head, ws => {
      if (role === 'view') { void view.attach(ws); return; }
      ws.on('error', error => void stop(error.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'?'WIRE_MESSAGE_TOO_LARGE':`${role}-error`));
      ws.on('close', (_code,reason) => {const text=reason.toString();void stop(['TRANSPORT_BACKLOG','WIRE_MESSAGE_TOO_LARGE'].includes(text)?text:`${role}-disconnected`)});
      if (role === 'extension') {
        extension = ws;
        ws.on('message', data => {
          metrics.receivedBytes+=data.length;metrics.maxReceivedMessage=Math.max(metrics.maxReceivedMessage,data.length);
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
              metrics.events++;
              // Viewer-owned PNGs never fan out into the agent's CDP socket.
              if (!view.event(message.params)) model.onEvent(message.params);
            }
            else if (message.method === 'tab-created' && initialized) void model.addTab(message.params).catch(() => {});
            else if (message.method === 'tab-removed' && initialized) { if (message.params?.tabId === model.tab?.id) view.stop(); model.removeTab(message.params?.tabId); }
            else throw new Error('Invalid extension message.');
          } catch { void stop(); }
        });
      } else {
        client = ws;
        ws.on('message', async data => {
          metrics.receivedBytes+=data.length;metrics.maxReceivedMessage=Math.max(metrics.maxReceivedMessage,data.length);metrics.commands++;
          let message;
          try {
            message = JSON.parse(data.toString());
            if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string' || message.method.length > 120)
              throw new Error('Invalid CDP command.');
            record('command', message.method);
            if (view.active() && ['Page.startScreencast','Page.stopScreencast','Page.screencastFrameAck'].includes(message.method))
              throw new Error('Live view owns this session screencast. Close the viewer before recording.');
            const result = await model.command(message);
            if (message.method === 'Page.startScreencast') externalScreencast = true;
            if (message.method === 'Page.stopScreencast') externalScreencast = false;
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
    view.stop();
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
  return {extensionEndpoint: base + paths.extension, cdpEndpoint: base + paths.cdp,
    viewEndpoint: base + paths.view, ready, stop,
    status: () => ({initialized, stopped, reason: stopReason, lastMethod: trace.at(-1)?.method,
      tabId: model.tab?.id, targetId: model.inventory().find(target => target.tabId === model.tab?.id)?.targetId,
      targets: model.inventory(), pending: pending.size, view: view.status(), metrics:{...metrics},resources:{clients:wss.clients.size,listening:server.listening,pendingTimers:pending.size+(!initialized&&!stopped?1:0)}}),
    targets: () => model.inventory(), trace: () => trace.slice()};
}
