import {fault} from '../extension/protocol.js';
import {createRelay} from './native-relay.mjs';

// Fences each lease operation across callers. Browser-side reservations are
// shared with the official adapter, so switching transports cannot steal tabs.
export class NativeSessions {
  constructor(identity, browser, {relayFactory = createRelay} = {}) {
    this.identity = identity;
    this.browser = browser;
    this.relayFactory = relayFactory;
    this.sessions = new Map();
    this.busy = new Set();
  }
  handle(op, payload) {
    if (['native-status', 'native-trace'].includes(op)) return this.operate(op, payload);
    if (this.busy.has(payload.sessionKey)) return Promise.reject(fault('SESSION_BUSY', 'Native lease operation is busy.'));
    this.busy.add(payload.sessionKey);
    return this.operate(op, payload).finally(() => this.busy.delete(payload.sessionKey));
  }
  validate(p) {
    if (p.instanceId !== this.identity.instanceId || p.epoch !== this.identity.epoch)
      throw fault('PROFILE_MISMATCH', 'The paired browser instance changed.');
    if (this.identity.capabilities?.nativeSessionSchema === 4 && p.hostGeneration !== this.identity.hostGeneration) throw fault('AUTHORITY_STALE', 'Native host generation changed.');
    if (!/^[a-f0-9]{64}$/.test(p.sessionKey || '')) throw fault('INVALID_SESSION', 'Invalid workspace/session key.');
  }
  async operate(op, p) {
    this.validate(p);
    if (!this.identity.capabilities?.nativeTransport)
      throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This bridge/extension has no native debugger transport. Keep using official mode until the native build is installed.');
    const entry = this.sessions.get(p.sessionKey);
    if (entry && this.identity.capabilities?.nativeSessionSchema === 4 && p.leaseId !== entry.leaseId && !['native-status', 'native-trace'].includes(op)) throw fault('AUTHORITY_STALE', 'Native lease changed.');
    if (op === 'native-trace') return entry?.relay.trace() || [];
    if (op === 'native-status') return {sessions: [...this.sessions].map(([key, s]) => ({key, leaseId: s.leaseId, hostGeneration: this.identity.hostGeneration, tabId: s.tabId, ...s.relay.status()}))};
    if (op === 'native-disconnect') {
      await this.close(p.sessionKey, entry, p);
      return {disconnected: true, alreadyDisconnected: !entry};
    }
    if (op === 'native-targets') {
      if (!entry) throw fault('SESSION_STALE', 'Native session is unavailable.');
      const inventory = await this.browser('native-inventory', p);
      return {...inventory, targets: inventory.targets.map(tab => ({...tab, targetId: entry.relay.targets().find(t => t.tabId === tab.tabId)?.targetId}))};
    }
    if (op === 'native-release-tab') {
      if (!entry) throw fault('SESSION_STALE', 'Native session is unavailable.');
      return this.browser('native-drop', p);
    }
    if (op === 'native-verify') {
      const target = entry?.relay.targets().find(target => target.tabId === p.tabId);
      if (!entry || entry.relay.status().stopped || !target?.targetId)
        throw fault('SESSION_STALE', 'Native session is unavailable. Disconnect before reconnecting.');
      await this.browser('native-check', p);
      return {tabId: p.tabId, rootTabId: entry.tabId, targetId: target.targetId};
    }
    if (op !== 'native-connect') throw fault('INVALID_REQUEST', 'Unsupported native session operation.');
    if (p.focusEmulation !== undefined && typeof p.focusEmulation !== 'boolean') throw fault('INVALID_ARGUMENT', 'Focus emulation must be a boolean.');
    if (entry) {
      if (!entry.relay.targets().some(target => target.tabId === p.tabId)) throw fault('SESSION_TAB_LIMIT', 'Only the starting tab and its attributed children belong to this session.');
      if (!!p.focusEmulation !== entry.focusEmulation) throw fault('SESSION_OPTIONS_CHANGED', 'Disconnect before changing focus emulation.');
      if (entry.relay.status().stopped) throw fault('SESSION_STALE', 'Native transport was disconnected. Clean up before reconnecting.');
      await this.browser('native-check', p);
      return {tabId: entry.tabId, alreadyConnected: true};
    }
    if (this.sessions.size + this.busy.size > 16) throw fault('SESSION_LIMIT', 'Too many native sessions.');
    try { await this.browser('native-reserve', p); }
    catch (error) {
      if (['DEBUGGER_CONFLICT','TAB_OWNED','TAB_CHANGED','TAB_CLOSED','TAB_UNSUPPORTED','INVALID_TAB','SESSION_LIMIT','SESSION_TAB_LIMIT','TRANSPORT_MISMATCH','PROFILE_MISMATCH','AUTHORITY_STALE','DEBUGGER_PERMISSION_REQUIRED'].includes(error.code)) error.nativeCleanupConfirmed = true;
      throw error;
    }
    let relay, created;
    try {
      relay = await this.relayFactory(this.identity.extensionId, {expectedTabId: p.tabId,
        onStop: () => {
          // Transport loss revokes credentials immediately. Release the browser
          // lease in the serialized queue; retain host state as stale for audit.
          if (!created?.closing && this.sessions.get(p.sessionKey) === created) void this.browser('native-release', p).catch(() => {});
        }});
      created = {relay, leaseId: p.leaseId, tabId: p.tabId, focusEmulation: !!p.focusEmulation};
      this.sessions.set(p.sessionKey, created);
      await this.browser('native-open', {...p, endpoint: relay.extensionEndpoint});
      await relay.ready;
      return {tabId: p.tabId, cdpEndpoint: relay.cdpEndpoint, alreadyConnected: false};
    } catch (error) {
      try { await this.close(p.sessionKey, created, p); }
      catch { throw fault('NATIVE_CLEANUP_FAILED', 'Native connection failed and cleanup could not be confirmed. Retain the session record and run disconnect.'); }
      error.nativeCleanupConfirmed = true;
      throw error;
    }
  }
  async close(key, entry, p) {
    if (entry) { entry.closing = true; await entry.relay.stop(); }
    await this.browser('native-release', p);
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
  }
  async stop() {
    for (const entry of this.sessions.values()) { entry.closing = true; await entry.relay.stop(); }
    this.sessions.clear();
  }
}
