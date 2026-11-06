import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fault, webUrl} from '../extension/protocol.js';
import {RecoveryStore, readRecovery, planToken, authorityOf, sameAuthority, partialJournals} from './recovery-state.mjs';
import {RecoveryCoordinator} from './recovery-coordinator.mjs';
import {rootDir} from './local.mjs';
import {sessionKey, workspaceAt, runCLI} from './playwright.mjs';
import {readSession} from './state.mjs';
import {daemonIdentity, assertDaemon} from './daemon-identity.mjs';

export async function legacyBlocker(key) {
  try { await fs.lstat(path.join(rootDir(), key + '.lock')); return 'LEGACY_LOCK_PRESENT'; }
  catch(e) { if (e.code !== 'ENOENT') throw e; }
  if (await readSession(key)) return 'LEGACY_SESSION_PRESENT';
  return null;
}
export async function recoveryInspection({instanceId, key, identity, live, offlineError}) {
  const record = await readRecovery(instanceId, key);
  const legacy = await legacyBlocker(key);
  const partial = await partialJournals(instanceId,key);
  const healthy = !!record && record.status === 'attached' && sameAuthority(record, {...identity, leaseId: record.leaseId}) && record.leaseId === live?.leaseId && !live?.stopped;
  const absent = !record || record.status === 'retired';
  const online = !!identity;
  const blockers = [legacy, partial.length ? 'PARTIAL_JOURNAL_PRESENT' : null, offlineError?.code, !online ? 'BRIDGE_OFFLINE' : null].filter(Boolean);
  const view = {instanceId, key, revision: record?.revision || null, hostGeneration: identity?.hostGeneration || null, liveLeaseId: live?.leaseId || null, stopped: live?.stopped ?? null, legacy, partial};
  return {sessionKey: key, record: record || null, online, healthy, status: healthy ? 'healthy' : absent ? 'absent' : 'interrupted',
    outcome: !absent && !healthy ? 'unknown' : null,
    actions: !absent && !healthy && !legacy ? ['revoke-old-native-access', 'confirm-owned-debugger-release', 'detach-exact-cli-session', 'retire-record'] : [],
    blockers, planToken: planToken(view), ...(offlineError ? {connectionError: offlineError} : {})};
}

export class NativeRecovery {
  constructor(identity, sessions, browser, {store = new RecoveryStore(identity.instanceId), coordinator = new RecoveryCoordinator()} = {}) {
    this.identity = identity; this.sessions = sessions; this.browser = browser; this.store = store; this.coordinator = coordinator;
  }
  async metadata(p) {
    if (p.instanceId !== this.identity.instanceId || p.hostGeneration !== this.identity.hostGeneration || p.epoch !== this.identity.epoch)
      throw fault('AUTHORITY_STALE', 'Native bridge authority changed. Inspect the session again.');
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(p.session || '') || typeof p.workspace !== 'string') throw fault('INVALID_SESSION', 'Workspace/session metadata is required.');
    const workspace = await workspaceAt(p.workspace);
    if (workspace !== p.workspace || sessionKey(workspace, p.session) !== p.sessionKey) throw fault('INVALID_SESSION', 'Canonical workspace/session key mismatch.');
  }
  async inspect(key) {
    const live = this.sessions.sessions.get(key);
    const controller = live && await this.browser('native-health', {...this.identity, sessionKey: key, leaseId: live.leaseId});
    return recoveryInspection({instanceId: this.identity.instanceId, key, identity: this.identity,
      live: live && {leaseId: live.leaseId, ...live.relay.status(), stopped: live.relay.status().stopped || controller?.healthy === false}});
  }
  async begin(p, owner) {
    await this.metadata(p);
    const grant = this.coordinator.begin(p.sessionKey, owner);
    try {
      if (await legacyBlocker(grant.key)) throw fault('LEGACY_STATE_BLOCKED', 'Legacy state is preserved. Drain it through its compatible disconnect path; do not remove a PID-only lock.');
      grant.record = await this.store.read(grant.key);
      grant.meta = {session: p.session, workspace: p.workspace};
      grant.base = {instanceId: this.identity.instanceId, epoch: this.identity.epoch, hostGeneration: this.identity.hostGeneration, sessionKey: grant.key};
      return grant;
    } catch(e) { this.coordinator.end(grant); throw e; }
  }
  check(g, owner, nonce) { this.coordinator.check(g, owner, nonce); }
  async save(g, patch, check) {
    check();
    // No successor grant is admitted until this operation's entire async tail
    // settles, including EOF/expiry cleanup. Thus the sole host writer cannot
    // rename an obsolete temporary over a successor record.
    g.record = await this.store.write(g.key, {...g.record, ...patch, updatedAt: Date.now()}, {check});
    check(); return g.record;
  }
  async step(g, owner, p) {
    const check = () => this.check(g, owner, p.nonce); check();
    const old = g.record, base = {...g.base, leaseId: old?.leaseId};
    if (p.action === 'inspect') return this.inspect(g.key);
    if (['connect','verify','release'].includes(p.action) && (!Number.isSafeInteger(p.tabId) || p.tabId < 0)) throw fault('INVALID_TAB','A numeric tab ID is required.');
    if (['connect','verify'].includes(p.action) && (typeof p.expectedUrl !== 'string' || p.expectedUrl.length > 16384 || !(webUrl(p.expectedUrl) || p.action === 'verify' && p.expectedUrl === 'about:blank' && g.createdTabId === p.tabId))) throw fault('INVALID_ARGUMENT','An ordinary discovered HTTP(S) URL is required.');
    if (p.action === 'connect' || p.action === 'open') {
      if (p.focusEmulation !== undefined && typeof p.focusEmulation !== 'boolean') throw fault('INVALID_ARGUMENT','Focus emulation must be a boolean.');
      if ((await partialJournals(this.identity.instanceId,g.key)).length) throw fault('PARTIAL_JOURNAL_PRESENT','An incomplete journal is preserved. Inspect it before reconnecting.'); check();
      if (p.action === 'open' && old && old.status !== 'retired') throw fault('SESSION_COLLISION', 'Use a fresh session name to open a new tab.');
      if (p.action === 'open' && this.identity.capabilities?.createTab !== 1) throw fault('OPEN_UNSUPPORTED', 'Update the Latch host and extension to use open.');
      if (old && old.status !== 'retired') {
        if (!sameAuthority(old, {...this.identity, leaseId: old.leaseId}) || old.status !== 'attached') throw fault('SESSION_STALE', 'Native session was interrupted. Inspect and reconcile before a fresh connect.');
        const connected = await this.sessions.handle('native-connect', {...base, tabId: p.tabId, expectedUrl: p.expectedUrl, focusEmulation: p.focusEmulation});
        check(); return {...connected, authority: authorityOf(old)};
      }
      const leaseId = crypto.randomUUID();
      await this.save(g, {v: 4, key: g.key, ...g.meta, ...g.base, leaseId, tabId: p.tabId ?? null, focusEmulation: !!p.focusEmulation, status: 'connecting', stage: p.action === 'open' ? 'creating-tab' : 'reserve', outcome: 'unknown', cleanup: null, appliedToken: null, daemonFingerprint: null, daemonSocketFingerprint: null}, check);
      g.acquired = true;
      let created;
      if (p.action === 'open') {
        if (this.sessions.sessions.size >= 16) throw fault('SESSION_LIMIT', 'Too many native sessions.');
        created = await this.browser('native-create-tab', {...g.base, leaseId});
        check();
        // Keep blank-tab admission within this grant, preserving RC8 journal compatibility.
        g.createdTabId = created.tabId;
        await this.save(g, {tabId: created.tabId, stage: 'reserve'}, check);
        p = {...p, tabId: created.tabId, expectedUrl: 'about:blank'};
      }
      let connected;
      try { connected = await this.sessions.handle('native-connect', {...g.base, leaseId, tabId: p.tabId, expectedUrl: p.expectedUrl, focusEmulation: p.focusEmulation}); }
      catch (error) {
        if (error.nativeCleanupConfirmed) {
          // open reserved a blank tab before bootstrap; even a rejected reserve
          // must release that lease before the journal can be retired.
          if (created) await this.sessions.handle('native-disconnect', {...g.base, leaseId});
          await this.save(g, {status: 'retired', stage: 'bootstrap-rejected', outcome: null, cleanup: 'confirmed'}, check);
          g.acquired = false; await this.store.trim();
        }
        throw error;
      }
      await this.save(g, {stage: 'cli-attach'}, check);
      return {...connected, ...(created ? {created: true, expectedUrl: 'about:blank'} : {}), authority: authorityOf(g.record)};
    }
    if (!old || old.status === 'retired') {
      if (p.action === 'disconnect') return {disconnected: true, alreadyDisconnected: true};
      if (p.action === 'apply' && old?.appliedToken === p.expect) return {reconciled: true, alreadyReconciled: true};
      if (p.action === 'apply') {
        const plan = await this.inspect(g.key); check();
        if (plan.blockers.length) throw fault('RECOVERY_BLOCKED', 'Recovery has unresolved blockers; state was preserved.');
        if (plan.planToken !== p.expect) throw fault('RECOVERY_PLAN_CHANGED', 'Recovery plan changed; inspect again.');
        return {reconciled: true, alreadyReconciled: true};
      }
      throw fault('SESSION_UNAVAILABLE', 'No native lease is recorded.');
    }
    if (p.action === 'apply') return this.apply(g, p, check);
    if (!sameAuthority(old, {...this.identity, leaseId: old.leaseId})) throw fault('AUTHORITY_STALE', 'Native authority changed; reconcile the interrupted session.');
    if (p.action === 'view') {
      const live = this.sessions.sessions.get(g.key);
      if (old.status !== 'attached' || !live || live.leaseId !== old.leaseId || live.relay.status().stopped)
        throw fault('SESSION_STALE', 'Connect a healthy native session before opening its viewer.');
      if (!live.relay.viewEndpoint) throw fault('VIEW_UNSUPPORTED', 'This host does not support live view.');
      return {endpoint: live.relay.viewEndpoint, tabId: live.tabId};
    }
    if (p.action === 'cli-attached') {
      const daemon = await daemonIdentity(old.workspace, old.session); check();
      if (!daemon?.socketExists) throw fault('DAEMON_IDENTITY_UNCONFIRMED', 'Attached CLI daemon could not be identified.');
      await this.save(g, {daemonFingerprint: daemon.fingerprint, daemonSocketFingerprint: daemon.socketFingerprint, stage: 'verify'}, check);
      return {identified: true};
    }
    if (p.action === 'verify') {
      const verified = await this.sessions.handle('native-verify', {...base, tabId: p.tabId, expectedUrl: p.expectedUrl}); check(); return verified;
    }
    if (p.action === 'targets') { const result = await this.sessions.handle('native-targets', base); check(); return result; }
    if (p.action === 'commit') {
      // Independently verify controller/relay again; caller cannot invent target
      // inventory or mark a stopped transport as attached.
      const live = this.sessions.sessions.get(g.key);
      if (!live || live.leaseId !== old.leaseId || live.relay.status().stopped) throw fault('SESSION_STALE', 'Transport stopped before commit.');
      const inventory = await this.sessions.handle('native-targets', base); check();
      await this.save(g, {status: 'attached', stage: 'verified', outcome: null, targets: inventory.targets.map(t => ({tabId: t.tabId, targetId: t.targetId, depth: t.depth})), rootTabId: inventory.rootTabId}, check);
      g.acquired = false;
      return {committed: true};
    }
    if (p.action === 'release') {
      g.cleanupRequested = true;
      await this.save(g, {stage: 'releasing', outcome: 'unknown'}, check);
      const result = await this.sessions.handle('native-release-tab', {...base, tabId: p.tabId}); check();
      if (result.sessionClosed) { const daemon = await assertDaemon(old); check(); if (!daemon.absent) await runCLI(old.session, ['detach'], {workspace: old.workspace, timeout: 10000}); check(); }
      await this.save(g, {targets: result.targets.map(t => ({tabId: t.tabId, targetId: t.targetId})), status: result.sessionClosed ? 'released' : 'attached', stage: 'released'}, check);
      g.cleanupRequested = false; return result;
    }
    if (p.action === 'disconnect' || p.action === 'rollback') {
      const unknownOutcome = old.outcome === 'unknown' || this.sessions.sessions.get(g.key)?.relay.status().stopped === true || (this.sessions.sessions.get(g.key)?.relay.status().pending || 0) > 0;
      g.cleanupRequested = true;
      await this.save(g, {status: 'interrupted', stage: 'revoking', outcome: 'unknown'}, check);
      await this.sessions.handle('native-disconnect', base); check();
      // The host performs the exact name/workspace detach. No client-side
      // registry deletion or process-name/PID based cleanup exists here.
      const daemon = await assertDaemon(g.record); check();
      if (!daemon.absent) await runCLI(old.session, ['detach'], {workspace: old.workspace, timeout: 10000}); check();
      await this.save(g, {status: 'retired', stage: 'complete', cleanup: 'confirmed', outcome: unknownOutcome ? 'unknown' : null}, check);
      g.acquired = false; g.cleanupRequested = false; await this.store.trim();
      return {disconnected: true, preservedUserTabs: true};
    }
    throw fault('INVALID_REQUEST', 'Unsupported recovery operation.');
  }
  async apply(g, p, check) {
    const start = performance.now();
    const grantCheck = check;
    check = () => { grantCheck(); if (performance.now() - start >= 30000) throw fault('RECOVERY_TIMEOUT', 'Recovery exceeded its budget; inspect the retained state.'); };
    const plan = await this.inspect(g.key); check();
    if (plan.planToken !== p.expect) throw fault('RECOVERY_PLAN_CHANGED', 'Recovery plan changed; inspect again.');
    if (plan.healthy) throw fault('SESSION_HEALTHY', 'This session is healthy. Use normal disconnect to release it.');
    if (plan.blockers.length) throw fault('RECOVERY_BLOCKED', 'Recovery has unresolved blockers.');
    const record = g.record, live = this.sessions.sessions.get(g.key);
    if (live && live.leaseId !== record.leaseId) throw fault('AUTHORITY_STALE', 'A successor lease exists; no cleanup was performed.');
    g.cleanupRequested = true;
    await this.save(g, {status: 'interrupted', stage: 'reconciling', outcome: 'unknown'}, check);
    if (live) await this.sessions.handle('native-disconnect', {...g.base, leaseId: record.leaseId});
    // A replacement host's verified handshake cleared its predecessor's native
    // controller claims. Never detach an unknown debugger by numeric tab ID.
    check();
    try {
      const daemon = await assertDaemon(record); check();
      if (!daemon.absent) await runCLI(record.session, ['detach'], {workspace: record.workspace, timeout: 10000}); check();
      await this.save(g, {status: 'retired', stage: 'complete', cleanup: 'confirmed', appliedToken: p.expect}, check);
      await this.store.trim();
      g.cleanupRequested = false;
      return {reconciled: true, outcome: 'unknown', preservedUserTabs: true, replayedActions: 0};
    } catch (e) {
      check(); await this.save(g, {status: 'interrupted', stage: 'cli-detach', cleanup: 'unconfirmed'}, check); throw e;
    }
  }
  fence(g) {
    if (!g) return; g.active = false;
    const live = this.sessions.sessions.get(g.key);
    if ((g.acquired || g.cleanupRequested) && live?.leaseId === g.record?.leaseId) void live.relay.stop('operation-ended').catch(() => {});
  }
  async finish(g, {interrupted = false} = {}) {
    if (!g) return;
    this.fence(g); // fence before awaiting the outstanding async tail
    try {
      if (g.record && g.record.status !== 'retired' && (interrupted || g.acquired || g.cleanupRequested)) {
        if (g.acquired || g.cleanupRequested) {
          const live = this.sessions.sessions.get(g.key);
          if (!live || live.leaseId === g.record.leaseId) await this.sessions.handle('native-disconnect', {...g.base, leaseId: g.record.leaseId});
        }
        // Preserve healthy persistent automation on a normal short CLI exit.
        if (g.record.status !== 'attached' || g.acquired || g.cleanupRequested) g.record = await this.store.write(g.key, {...g.record, status: 'interrupted', outcome: 'unknown', stage: 'operation-ended', updatedAt: Date.now()});
      }
    } finally { this.coordinator.end(g); }
  }
}
