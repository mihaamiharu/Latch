import {fault} from '../extension/protocol.js';
import {createRelay} from './native-relay.mjs';

// Serializes lease mutations across callers. Browser-side reservations are
// shared with the official adapter, so switching transports cannot steal tabs.
export class NativeSessions {
  constructor(identity, browser, {relayFactory = createRelay} = {}) {
    this.identity = identity;
    this.browser = browser;
    this.relayFactory = relayFactory;
    this.sessions = new Map();
    this.queue = Promise.resolve();
  }
  handle(op, payload) {
    const result = this.queue.then(() => this.operate(op, payload));
    this.queue = result.catch(() => {});
    return result;
  }
  validate(p) {
    if (p.instanceId !== this.identity.instanceId || p.epoch !== this.identity.epoch)
      throw fault('PROFILE_MISMATCH', 'The paired browser instance changed.');
    if (!/^[a-f0-9]{64}$/.test(p.sessionKey || '')) throw fault('INVALID_SESSION', 'Invalid workspace/session key.');
  }
  async operate(op, p) {
    this.validate(p);
    if (!this.identity.capabilities?.nativeTransport)
      throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This bridge/extension has no native debugger transport. Keep using official mode until the native build is installed.');
    const entry = this.sessions.get(p.sessionKey);
    if (op === 'native-status') return {sessions: [...this.sessions].map(([key, s]) => ({key, tabId: s.tabId, ...s.relay.status()}))};
    if (op === 'native-disconnect') {
      await this.close(p.sessionKey, entry, p);
      return {disconnected: true, alreadyDisconnected: !entry};
    }
    if (op === 'native-verify') {
      if (!entry || entry.relay.status().stopped || !entry.relay.status().targetId)
        throw fault('SESSION_STALE', 'Native session is unavailable. Disconnect before reconnecting.');
      if (p.tabId !== entry.tabId) throw fault('TAB_NOT_OWNED', 'This session does not own that tab.');
      await this.browser('native-check', p);
      return {tabId: entry.tabId, targetId: entry.relay.status().targetId};
    }
    if (op !== 'native-connect') throw fault('INVALID_REQUEST', 'Unsupported native session operation.');
    if (p.focusEmulation !== undefined && typeof p.focusEmulation !== 'boolean') throw fault('INVALID_ARGUMENT', 'Focus emulation must be a boolean.');
    if (entry) {
      if (p.tabId !== entry.tabId) throw fault('SESSION_TAB_LIMIT', 'Native transport currently supports one tab per named session. Use another session.');
      if (!!p.focusEmulation !== entry.focusEmulation) throw fault('SESSION_OPTIONS_CHANGED', 'Disconnect before changing focus emulation.');
      if (entry.relay.status().stopped) throw fault('SESSION_STALE', 'Native transport was disconnected. Clean up before reconnecting.');
      await this.browser('native-check', p);
      return {tabId: entry.tabId, alreadyConnected: true};
    }
    if (this.sessions.size >= 16) throw fault('SESSION_LIMIT', 'Too many native sessions.');
    await this.browser('native-reserve', p);
    let relay, created;
    try {
      relay = await this.relayFactory(this.identity.extensionId, {expectedTabId: p.tabId,
        onStop: () => {
          // Transport loss revokes credentials immediately. Release the browser
          // lease in the serialized queue; retain host state as stale for audit.
          if (!created?.closing) this.queue = this.queue.then(() => this.browser('native-release', p)).catch(() => {});
        }});
      created = {relay, tabId: p.tabId, focusEmulation: !!p.focusEmulation};
      this.sessions.set(p.sessionKey, created);
      await this.browser('native-open', {...p, endpoint: relay.extensionEndpoint});
      await relay.ready;
      return {tabId: p.tabId, cdpEndpoint: relay.cdpEndpoint, alreadyConnected: false};
    } catch (error) {
      try { await this.close(p.sessionKey, created, p); }
      catch { throw fault('NATIVE_CLEANUP_FAILED', 'Native connection failed and cleanup could not be confirmed. Retain the session record and run disconnect.'); }
      throw error;
    }
  }
  async close(key, entry, p) {
    if (entry) { entry.closing = true; await entry.relay.stop(); }
    await this.browser('native-release', p);
    this.sessions.delete(key);
  }
  async stop() {
    for (const entry of this.sessions.values()) { entry.closing = true; await entry.relay.stop(); }
    this.sessions.clear();
  }
}
