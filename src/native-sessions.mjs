import crypto from 'node:crypto';
import {fault, webUrl} from '../extension/protocol.js';
import {createRelay} from './native-relay.mjs';
import {BrowserEngine} from './browser-engine.mjs';
import {sessionKey as computeSessionKey} from './redact.mjs';
import {writeWorkspaceBinding, removeWorkspaceBinding} from './recovery-state.mjs';

const SESSION_KEY_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,60}$/;

function defaultEngineFactory(opts) {
  return new BrowserEngine(opts).connect({targetId: opts.targetId});
}

// Serializes lifecycle and action operations per session inside native-host.
export class NativeSessions {
  constructor(
    identity,
    browser,
    {relayFactory = createRelay, engineFactory = defaultEngineFactory} = {},
  ) {
    this.identity = identity;
    this.browser = browser;
    this.relayFactory = relayFactory;
    this.engineFactory = engineFactory;
    this.sessions = new Map();
    this.busy = new Set();
  }

  resolveSessionKey(p) {
    if (p.sessionKey) return p.sessionKey;
    if (typeof p.workspace === 'string' && SESSION_NAME_PATTERN.test(p.session || '')) {
      return computeSessionKey(p.workspace, p.session);
    }
    return '';
  }

  validate(p, {requireSessionKey = true} = {}) {
    if (p.instanceId !== undefined && p.instanceId !== this.identity.instanceId) {
      throw fault('PROFILE_MISMATCH', 'The paired browser instance changed.');
    }
    if (p.epoch !== undefined && p.epoch !== this.identity.epoch) {
      throw fault('PROFILE_MISMATCH', 'The paired browser instance changed.');
    }
    if (
      this.identity.capabilities?.nativeSessionSchema === 4 &&
      p.hostGeneration !== undefined &&
      p.hostGeneration !== this.identity.hostGeneration
    ) {
      throw fault('AUTHORITY_STALE', 'Native host generation changed.');
    }
    const key = this.resolveSessionKey(p);
    if (requireSessionKey && !SESSION_KEY_PATTERN.test(key)) {
      throw fault('INVALID_SESSION', 'Invalid workspace/session key.');
    }
    return key;
  }

  handle(op, payload = {}) {
    if (op === 'session-list' || op === 'native-status' || op === 'native-trace') {
      return this.operate(op, payload);
    }
    const key = this.resolveSessionKey(payload);
    if (!SESSION_KEY_PATTERN.test(key)) {
      return Promise.reject(fault('INVALID_SESSION', 'Invalid workspace/session key.'));
    }
    if (this.busy.has(key)) {
      return Promise.reject(fault('SESSION_BUSY', 'Session operation is already in progress.'));
    }
    this.busy.add(key);
    return this.operate(op, payload).finally(() => this.busy.delete(key));
  }

  async operate(op, p) {
    const requireSessionKey = op !== 'session-list' && op !== 'native-status';
    const key = this.validate(p, {requireSessionKey});

    if (!this.identity.capabilities?.nativeTransport) {
      throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This bridge/extension has no native debugger transport.');
    }

    const entry = key ? this.sessions.get(key) : undefined;
    if (entry && p.leaseId !== undefined && p.leaseId !== entry.leaseId && !['session-list', 'native-status', 'native-trace'].includes(op)) {
      throw fault('AUTHORITY_STALE', 'Native lease changed.');
    }

    if (op === 'native-trace') return entry?.relay.trace() || [];

    if (op === 'session-list' || op === 'native-status') {
      const sessions = [];
      for (const [sKey, s] of this.sessions) {
        const relayStatus = s.relay.status();
        const page = s.engine ? await s.engine.pageSummary(s.engine.activePage).catch(() => null) : null;
        sessions.push({
          key: sKey,
          sessionKey: sKey,
          session: s.session || null,
          workspace: s.workspace || null,
          leaseId: s.leaseId,
          hostGeneration: this.identity.hostGeneration,
          tabId: s.tabId,
          rootTabId: s.tabId,
          focusEmulation: s.focusEmulation,
          activeTargetId: page?.targetId || relayStatus.targetId || null,
          page,
          ...relayStatus,
        });
      }
      return {sessions};
    }

    if (op === 'session-disconnect' || op === 'native-disconnect') {
      const workspace = p.workspace || entry?.workspace;
      const session = p.session || entry?.session;
      await this.close(key, entry, {...this.identity, ...p, sessionKey: key, leaseId: p.leaseId || entry?.leaseId});
      if (workspace) {
        await removeWorkspaceBinding(workspace, session || key).catch(() => {});
      }
      return {disconnected: true, alreadyDisconnected: !entry, preservedUserTabs: true};
    }

    if (op === 'session-release' || op === 'native-release-tab') {
      if (!entry) throw fault('SESSION_STALE', 'Native session is unavailable.');
      if (!Number.isSafeInteger(p.tabId) || p.tabId < 0) {
        throw fault('INVALID_TAB', 'Specify a numeric tabId to release.');
      }
      const result = await this.browser('native-drop', {
        instanceId: this.identity.instanceId,
        epoch: this.identity.epoch,
        hostGeneration: this.identity.hostGeneration,
        leaseId: entry.leaseId,
        sessionKey: key,
        tabId: p.tabId,
      });
      if (result.sessionClosed) {
        await this.close(key, entry, {
          instanceId: this.identity.instanceId,
          epoch: this.identity.epoch,
          hostGeneration: this.identity.hostGeneration,
          leaseId: entry.leaseId,
          sessionKey: key,
        });
        if (entry.workspace) {
          await removeWorkspaceBinding(entry.workspace, entry.session || key).catch(() => {});
        }
      }
      return {released: true, ...result, preservedUserTabs: true};
    }

    if (op === 'session-action') {
      if (!entry || entry.relay.status().stopped || entry.engine?.closed) {
        throw fault(
          'SESSION_STALE',
          'Session is not connected or its transport stopped.',
          'Run open or connect to start a fresh session.',
        );
      }
      if (!entry.engine) {
        throw fault('SESSION_STALE', 'In-process browser engine is unavailable for this session.');
      }
      return await entry.engine.action(p.action, p.args || {});
    }

    if (op === 'session-capture-state') {
      if (!entry || entry.relay.status().stopped || entry.engine?.closed) {
        throw fault(
          'SESSION_STALE',
          'Session is not connected or its transport stopped.',
          'Run open or connect to start a fresh session.',
        );
      }
      if (!entry.engine) {
        throw fault('SESSION_STALE', 'In-process browser engine is unavailable for this session.');
      }
      return await entry.engine.captureState({includeScreenshot: p.includeScreenshot !== false});
    }

    if (op === 'native-targets') {
      if (!entry) throw fault('SESSION_STALE', 'Native session is unavailable.');
      const inventory = await this.browser('native-inventory', {
        ...this.identity,
        leaseId: entry.leaseId,
        sessionKey: key,
      });
      return {
        ...inventory,
        targets: inventory.targets.map(tab => ({
          ...tab,
          targetId: entry.relay.targets().find(t => t.tabId === tab.tabId)?.targetId,
        })),
      };
    }

    if (op === 'native-verify') {
      const target = entry?.relay.targets().find(t => t.tabId === p.tabId);
      if (!entry || entry.relay.status().stopped || !target?.targetId) {
        throw fault('SESSION_STALE', 'Native session is unavailable. Disconnect before reconnecting.');
      }
      await this.browser('native-check', {...this.identity, leaseId: entry.leaseId, ...p, sessionKey: key});
      return {tabId: p.tabId, rootTabId: entry.tabId, targetId: target.targetId};
    }

    if (op === 'session-open') {
      return await this.openSession(key, entry, p);
    }
    if (op === 'session-connect' || op === 'native-connect') {
      return await this.connectSession(key, entry, p, {legacyOp: op === 'native-connect'});
    }

    throw fault('INVALID_REQUEST', 'Unsupported native session operation.');
  }

  focusOption(p, {defaultValue = true} = {}) {
    if (p.focusEmulation !== undefined && typeof p.focusEmulation !== 'boolean') {
      throw fault('INVALID_ARGUMENT', 'Focus emulation must be a boolean.');
    }
    return p.focusEmulation ?? defaultValue;
  }

  async openSession(key, entry, p) {
    if (entry) {
      throw fault('SESSION_COLLISION', 'Use a fresh session name to open a new tab.');
    }
    if (this.identity.capabilities?.createTab !== 1) {
      throw fault('OPEN_UNSUPPORTED', 'Update the Latch host and extension to use open.');
    }
    if (p.url !== undefined && (!webUrl(p.url) || p.url.length > 16384)) {
      throw fault('INVALID_ARGUMENT', 'Open requires an ordinary HTTP(S) URL.');
    }
    if (this.sessions.size + this.busy.size > 16) {
      throw fault('SESSION_LIMIT', 'Too many native sessions.');
    }
    const focusEmulation = this.focusOption(p, {defaultValue: true});
    const leaseId = p.leaseId || crypto.randomUUID();
    const auth = {
      instanceId: this.identity.instanceId,
      epoch: this.identity.epoch,
      hostGeneration: this.identity.hostGeneration,
      leaseId,
      sessionKey: key,
    };

    const createdTab = await this.browser('native-create-tab', {
      ...auth,
      ...(p.session ? {session: p.session} : {}),
    });
    const tabId = createdTab.tabId;
    let relay;
    let created;
    try {
      relay = await this.relayFactory(this.identity.extensionId, {
        expectedTabId: tabId,
        onStop: () => {
          if (!created?.closing && this.sessions.get(key) === created) {
            void created.engine?.close().catch(() => {});
            void this.releaseBrowser(created, auth).catch(() => {});
            this.sessions.delete(key);
            if (created.workspace) {
              void removeWorkspaceBinding(created.workspace, created.session || key).catch(() => {});
            }
          }
        },
      });
      created = {
        relay,
        engine: null,
        leaseId,
        tabId,
        focusEmulation,
        workspace: p.workspace || null,
        session: p.session || null,
      };
      this.sessions.set(key, created);
      const opened = await this.browser('native-open', {
        ...auth,
        tabId,
        expectedUrl: 'about:blank',
        focusEmulation,
        endpoint: relay.extensionEndpoint,
      });
      await relay.ready;

      const rootTargetId = relay.targets().find(t => t.tabId === tabId)?.targetId;
      created.engine = await this.engineFactory({
        cdpEndpoint: relay.cdpEndpoint,
        sessionKey: key,
        workspace: p.workspace || null,
        session: p.session || null,
        tabId,
        targetId: rootTargetId,
        focusEmulation,
        onClosed: () => {
          if (!created.closing && this.sessions.get(key) === created) {
            void this.close(key, created, auth).catch(() => {});
          }
        },
      });

      if (p.workspace && p.session) {
        await writeWorkspaceBinding(p.workspace, {
          sessionKey: key,
          session: p.session,
          workspace: p.workspace,
          instanceId: this.identity.instanceId,
          tabId,
          focusEmulation,
          status: 'attached',
        });
      }

      if (p.url) {
        try {
          await created.engine.action('goto', {url: p.url});
        } catch (navError) {
          if (!relay.status().stopped && !created.engine?.closed) {
            const sessionLabel = p.session || key.slice(0, 8);
            const err = fault(
              navError.code || 'NAVIGATION_FAILED',
              navError.message || `Navigation to ${p.url} failed.`,
              navError.hint ||
                `Tab ${tabId} was created and attached (session "${sessionLabel}"); run latch goto <url>, latch snapshot, or latch disconnect.`,
            );
            err.diagnostics = {
              ...(navError.diagnostics || {}),
              createdTabId: tabId,
              session: p.session || null,
              workspace: p.workspace || null,
              connected: true,
              navigationOutcome: 'failed',
            };
            throw err;
          }
          throw navError;
        }
      }

      const page = await created.engine.pageSummary(created.engine.activePage);
      const inventory = await this.browser('native-inventory', auth);
      return {
        created: true,
        connected: true,
        sessionKey: key,
        session: p.session || null,
        workspace: p.workspace || null,
        leaseId,
        tabId,
        rootTabId: tabId,
        targetId: page?.targetId || rootTargetId || null,
        targets: inventory.targets.map(t => ({
          ...t,
          targetId: relay.targets().find(r => r.tabId === t.tabId)?.targetId,
        })),
        warnings: inventory.warnings || [],
        focusEmulation,
        page,
      };
    } catch (error) {
      if (error?.diagnostics?.connected) throw error;
      try {
        await this.close(key, created, auth);
      } catch (cleanupError) {
        const origLabel = `${error?.code || 'ERROR'}: ${error?.message || String(error)}`;
        const cleanLabel = `${cleanupError?.code || 'ERROR'}: ${cleanupError?.message || String(cleanupError)}`;
        throw fault(
          'NATIVE_CLEANUP_FAILED',
          `Native session open failed (${origLabel}) and cleanup could not be confirmed (${cleanLabel}).`,
          'Run `latch disconnect` (or reload Latch in chrome://extensions if the bridge timed out).',
        );
      }
      error.nativeCleanupConfirmed = true;
      throw error;
    }
  }

  async connectSession(key, entry, p, {legacyOp = false} = {}) {
    if (!Number.isSafeInteger(p.tabId) || p.tabId < 0) {
      throw fault('INVALID_TAB', 'Specify a numeric tabId.');
    }
    const focusEmulation = this.focusOption(p, {defaultValue: legacyOp ? false : true});
    const leaseId = p.leaseId || entry?.leaseId || crypto.randomUUID();
    const auth = {
      instanceId: this.identity.instanceId,
      epoch: this.identity.epoch,
      hostGeneration: this.identity.hostGeneration,
      leaseId,
      sessionKey: key,
    };

    let expectedUrl = p.expectedUrl;
    if (expectedUrl === undefined) {
      const allTabs = await this.browser('tabs', {
        instanceId: this.identity.instanceId,
        epoch: this.identity.epoch,
      });
      const found = Array.isArray(allTabs) ? allTabs.find(t => t.tabId === p.tabId) : null;
      if (!found) {
        throw fault('TAB_UNAVAILABLE', 'Requested tab is not in the paired profile.');
      }
      expectedUrl = found.url;
    }

    if (entry) {
      const target = entry.relay.targets().find(t => t.tabId === p.tabId);
      if (!target) {
        throw fault('SESSION_TAB_LIMIT', 'Only the starting tab and its attributed children belong to this session.');
      }
      if (p.focusEmulation !== undefined && focusEmulation !== entry.focusEmulation) {
        throw fault('SESSION_OPTIONS_CHANGED', 'Disconnect before changing focus emulation.');
      }
      if (entry.relay.status().stopped || entry.engine?.closed) {
        throw fault('SESSION_STALE', 'Native transport was disconnected. Clean up before reconnecting.');
      }
      await this.browser('native-check', {...auth, tabId: p.tabId, expectedUrl});
      if (entry.engine && target.targetId) {
        await entry.engine.selectTarget({targetId: target.targetId});
      }
      if (legacyOp) {
        return {tabId: entry.tabId, alreadyConnected: true};
      }
      const page = entry.engine ? await entry.engine.pageSummary(entry.engine.activePage) : null;
      const inventory = await this.browser('native-inventory', auth);
      return {
        connected: true,
        alreadyConnected: true,
        sessionKey: key,
        session: p.session || entry.session || null,
        workspace: p.workspace || entry.workspace || null,
        leaseId: entry.leaseId,
        tabId: p.tabId,
        rootTabId: entry.tabId,
        targetId: target.targetId,
        targets: inventory.targets.map(t => ({
          ...t,
          targetId: entry.relay.targets().find(r => r.tabId === t.tabId)?.targetId,
        })),
        warnings: inventory.warnings || [],
        focusEmulation: entry.focusEmulation,
        page,
      };
    }

    if (this.sessions.size + this.busy.size > 16) {
      throw fault('SESSION_LIMIT', 'Too many native sessions.');
    }

    try {
      await this.browser('native-reserve', {...auth, tabId: p.tabId, expectedUrl});
    } catch (error) {
      if (
        [
          'DEBUGGER_CONFLICT',
          'TAB_OWNED',
          'TAB_CHANGED',
          'TAB_CLOSED',
          'TAB_UNSUPPORTED',
          'INVALID_TAB',
          'SESSION_LIMIT',
          'SESSION_TAB_LIMIT',
          'TRANSPORT_MISMATCH',
          'PROFILE_MISMATCH',
          'AUTHORITY_STALE',
          'DEBUGGER_PERMISSION_REQUIRED',
        ].includes(error.code)
      ) {
        error.nativeCleanupConfirmed = true;
      }
      throw error;
    }

    let relay;
    let created;
    try {
      relay = await this.relayFactory(this.identity.extensionId, {
        expectedTabId: p.tabId,
        onStop: () => {
          if (!created?.closing && this.sessions.get(key) === created) {
            void created.engine?.close().catch(() => {});
            void this.releaseBrowser(created, auth).catch(() => {});
            this.sessions.delete(key);
            if (created.workspace) {
              void removeWorkspaceBinding(created.workspace, created.session || key).catch(() => {});
            }
          }
        },
      });
      created = {
        relay,
        engine: null,
        leaseId,
        tabId: p.tabId,
        focusEmulation,
        workspace: p.workspace || null,
        session: p.session || null,
      };
      this.sessions.set(key, created);
      await this.browser('native-open', {
        ...auth,
        tabId: p.tabId,
        expectedUrl,
        focusEmulation,
        endpoint: relay.extensionEndpoint,
      });
      await relay.ready;

      const rootTargetId = relay.targets().find(t => t.tabId === p.tabId)?.targetId;
      if (!legacyOp) {
        created.engine = await this.engineFactory({
          cdpEndpoint: relay.cdpEndpoint,
          sessionKey: key,
          workspace: p.workspace || null,
          session: p.session || null,
          tabId: p.tabId,
          targetId: rootTargetId,
          focusEmulation,
          onClosed: () => {
            if (!created.closing && this.sessions.get(key) === created) {
              void this.close(key, created, auth).catch(() => {});
            }
          },
        });
      }

      if (p.workspace && p.session) {
        await writeWorkspaceBinding(p.workspace, {
          sessionKey: key,
          session: p.session,
          workspace: p.workspace,
          instanceId: this.identity.instanceId,
          tabId: p.tabId,
          focusEmulation,
          status: 'attached',
        });
      }

      if (legacyOp) {
        return {tabId: p.tabId, cdpEndpoint: relay.cdpEndpoint, alreadyConnected: false};
      }

      const page = created.engine ? await created.engine.pageSummary(created.engine.activePage) : null;
      const inventory = await this.browser('native-inventory', auth);
      return {
        connected: true,
        alreadyConnected: false,
        sessionKey: key,
        session: p.session || null,
        workspace: p.workspace || null,
        leaseId,
        tabId: p.tabId,
        rootTabId: p.tabId,
        targetId: page?.targetId || rootTargetId || null,
        targets: inventory.targets.map(t => ({
          ...t,
          targetId: relay.targets().find(r => r.tabId === t.tabId)?.targetId,
        })),
        warnings: inventory.warnings || [],
        focusEmulation,
        page,
      };
    } catch (error) {
      try {
        await this.close(key, created, auth);
      } catch (cleanupError) {
        const origLabel = `${error?.code || 'ERROR'}: ${error?.message || String(error)}`;
        const cleanLabel = `${cleanupError?.code || 'ERROR'}: ${cleanupError?.message || String(cleanupError)}`;
        throw fault(
          'NATIVE_CLEANUP_FAILED',
          `Native connection failed (${origLabel}) and cleanup could not be confirmed (${cleanLabel}).`,
          'Run `latch disconnect` (or reload Latch in chrome://extensions if the bridge timed out).',
        );
      }
      error.nativeCleanupConfirmed = true;
      throw error;
    }
  }

  releaseBrowser(entry, p) {
    if (entry?.releasePromise) return entry.releasePromise;
    const promise = Promise.resolve().then(() => this.browser('native-release', p));
    if (entry) {
      entry.releasePromise = promise.catch(err => {
        if (entry.releasePromise === promise) entry.releasePromise = null;
        throw err;
      });
      return entry.releasePromise;
    }
    return promise;
  }

  async close(key, entry, p) {
    if (entry) {
      entry.closing = true;
      await entry.engine?.close().catch(() => {});
      await entry.relay.stop().catch(() => {});
    }
    await this.releaseBrowser(entry, p);
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
  }

  async stop() {
    for (const [key, entry] of this.sessions) {
      entry.closing = true;
      await entry.engine?.close().catch(() => {});
      await entry.relay.stop().catch(() => {});
      if (entry.workspace) {
        await removeWorkspaceBinding(entry.workspace, entry.session || key).catch(() => {});
      }
    }
    this.sessions.clear();
  }
}
