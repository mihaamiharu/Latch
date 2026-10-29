import {fault} from './protocol.js';

// One verified native control lifetime. Durable alarms are a wake fallback;
// short timers are an optimization, never a promise across worker suspension.
export function createBridgeConnection(api, {host, hello, dispatch, invalidate, activate = async () => {}, timers = globalThis, now = Date.now}) {
  const delays = [1000, 2000, 4000, 8000, 16000, 30000];
  const alarm = 'latch-native-retry', storageKey = 'latchRetry';
  const uiPending = new Map();
  let activeNonce;
  let port, deadline, retryTimer, initializing, stopped = false;
  let state = {state: 'offline', connected: false, attempts: 0, nextAttemptAt: null, lastError: '', hostGeneration: null};
  let barrier = Promise.resolve().then(invalidate);
  void barrier.catch(() => {});
  const persist = () => api.storage.local.set({[storageKey]: {attempts: state.attempts, nextAttemptAt: state.nextAttemptAt, degraded: state.state === 'degraded'}});
  const clearWake = async () => { timers.clearTimeout(retryTimer); await api.alarms?.clear(alarm); };
  async function schedule() {
    await clearWake();
    await persist();
    if (state.nextAttemptAt === null || stopped) return;
    retryTimer = timers.setTimeout(() => { void attempt(); }, Math.max(0, state.nextAttemptAt - now()));
    await api.alarms?.create(alarm, {when: Math.max(state.nextAttemptAt, now() + 30000)});
  }
  function fail(next, message) {
    if (port !== next) return;
    port = undefined; timers.clearTimeout(deadline);
    for(const task of uiPending.values()){timers.clearTimeout(task.timer);task.reject(fault('BRIDGE_DISCONNECTED','Bridge disconnected; cleanup outcome may be unknown.'))}uiPending.clear();
    // Fence synchronously before any asynchronous cleanup or new handshake.
    state.connected = false; state.hostGeneration = null; state.lastError = message;
    barrier = barrier.catch(() => {}).then(invalidate);
    void barrier.catch(() => {});
    try { next.disconnect(); } catch {}
    state.attempts++;
    state.state = state.attempts >= delays.length ? 'degraded' : 'offline';
    state.nextAttemptAt = state.state === 'degraded' ? null : now() + delays[state.attempts - 1];
    void schedule();
  }
  async function attempt() {
    if (port || stopped || state.state === 'degraded') return;
    await clearWake();
    state.state = 'connecting'; state.nextAttemptAt = null;
    let next;
    try {
      await barrier;
      if (port || stopped) return;
      next = api.runtime.connectNative(host); port = next;
      const nonce = crypto.randomUUID(); activeNonce=nonce; let generation, ackSent = false;
      deadline = timers.setTimeout(() => fail(next, 'Native readiness acknowledgment timed out.'), 5000);
      next.onDisconnect.addListener(() => fail(next, api.runtime.lastError?.message || 'Native bridge disconnected.'));
      next.onMessage.addListener(async message => {
        if (port !== next) return;
        if (message?.type === 'challenge' && message.nonce === nonce && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(message.hostGeneration || '') && message.epoch === hello.epoch && !state.connected) {
          generation = message.hostGeneration;
          try {
            await barrier;
            if (port !== next) return;
            await activate(generation);
            if (port !== next) return;
            next.postMessage({v: 1, type: 'ack', nonce, hostGeneration: generation, epoch: hello.epoch});
            ackSent = true;
          } catch (e) { fail(next, e.message); }
          return;
        }
        if (message?.type === 'ready' && ackSent && generation && message.nonce === nonce && message.hostGeneration === generation && message.epoch === hello.epoch) {
          timers.clearTimeout(deadline); state = {...state, state: 'ready', connected: true, hostGeneration: generation, uiControl: message.capabilities?.uiControl===1, attempts: 0, nextAttemptAt: null, lastError: '', verifiedAt: now()};
          await persist(); return;
        }
        if(message?.type==='ui-response'&&state.connected&&message.nonce===nonce&&message.hostGeneration===generation){const task=uiPending.get(message.id);if(!task)return;uiPending.delete(message.id);timers.clearTimeout(task.timer);message.ok?task.resolve(message.result):task.reject(fault(message.error?.code||'UI_ERROR',message.error?.message||'Popup request failed.'));return;}
        if (message?.type !== 'request' || !state.connected) return;
        const response = await dispatch(message, generation);
        if (port === next && state.connected) { try { next.postMessage(response); } catch {} }
      });
      next.postMessage({...hello, nonce, capabilities: {...hello.capabilities, recoveryContract: 1}});
    } catch (e) {
      if (!next) { next = {disconnect() {}}; port = next; }
      fail(next, e.message);
    }
  }
  api.alarms?.onAlarm.addListener(event => { if (event.name === alarm && state.nextAttemptAt !== null && now() >= state.nextAttemptAt) {
    void api.storage.local.set({latchLastAlarm: {at: now(), scheduledFor: state.nextAttemptAt}}).then(() => attempt());
  } });
  return {
    async start({reset = false} = {}) {
      if (initializing) return initializing;
      if (port && state.connected) return;
      initializing = (async () => {
        if (reset) { state.attempts = 0; state.nextAttemptAt = null; state.state = 'offline'; }
        else {
          const saved = (await api.storage.local.get(storageKey))[storageKey];
          if (saved && Number.isInteger(saved.attempts) && saved.attempts >= 0 && saved.attempts <= 6) {
            state.attempts = saved.attempts;
            state.state = saved.degraded ? 'degraded' : 'offline';
            state.nextAttemptAt = Number.isFinite(saved.nextAttemptAt) ? saved.nextAttemptAt : null;
          }
        }
        if (state.state === 'degraded') return;
        if (state.nextAttemptAt && state.nextAttemptAt > now()) await schedule(); else await attempt();
      })().finally(() => { initializing = undefined; });
      return initializing;
    },
    status: () => ({...state}),
    ui(op,payload={}) {
      if(!port||!state.connected)return Promise.reject(fault('BRIDGE_NOT_READY','Local bridge is not ready.'));
      if(!state.uiControl)return Promise.reject(fault('UI_UNSUPPORTED','Update the matching Latch host to use session controls.'));
      if(!['status','revoke'].includes(op)||uiPending.size>=16||JSON.stringify(payload).length>8192)return Promise.reject(fault('UI_REQUEST_INVALID','Unsupported or busy popup request.'));
      const next=port,id=crypto.randomUUID();
      return new Promise((resolve,reject)=>{const timer=timers.setTimeout(()=>{uiPending.delete(id);reject(fault('UI_TIMEOUT','The request timed out; refresh to check its outcome.'))},op==='revoke'?35000:12000);uiPending.set(id,{resolve,reject,timer});try{next.postMessage({v:1,type:'ui-request',id,nonce:activeNonce,hostGeneration:state.hostGeneration,op,payload})}catch(e){uiPending.delete(id);timers.clearTimeout(timer);reject(e)}});
    },
    stop() { stopped = true; clearWake(); if (port) fail(port, 'Bridge stopped.'); },
  };
}
