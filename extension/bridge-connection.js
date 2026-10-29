// One verified native control lifetime. Durable alarms are a wake fallback;
// short timers are an optimization, never a promise across worker suspension.
export function createBridgeConnection(api, {host, hello, dispatch, invalidate, activate = async () => {}, timers = globalThis, now = Date.now}) {
  const delays = [1000, 2000, 4000, 8000, 16000, 30000];
  const alarm = 'latch-native-retry', storageKey = 'latchRetry';
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
      const nonce = crypto.randomUUID(); let generation, ackSent = false;
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
          timers.clearTimeout(deadline); state = {...state, state: 'ready', connected: true, hostGeneration: generation, attempts: 0, nextAttemptAt: null, lastError: '', verifiedAt: now()};
          await persist(); return;
        }
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
    stop() { stopped = true; clearWake(); if (port) fail(port, 'Bridge stopped.'); },
  };
}
