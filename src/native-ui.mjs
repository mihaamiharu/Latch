import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {readConfig} from './local.mjs';

const short = (value, n = 160) => String(value || '').slice(0, n);

export class NativeUI {
  constructor(identity, sessions, browser) {
    Object.assign(this, {identity, sessions, browser});
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  async status() {
    if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
    const config = await readConfig();
    const aliases = Object.entries(config.profiles || {})
      .filter(([, v]) => v.instanceId === this.identity.instanceId)
      .map(([k]) => short(k, 60))
      .slice(0, 8);
    await this.browser('status', {instanceId: this.identity.instanceId, epoch: this.identity.epoch});
    const tabs = await this.browser('tabs', {instanceId: this.identity.instanceId, epoch: this.identity.epoch});
    const rows = [];
    let truncated = false;

    for (const [key, entry] of this.sessions.sessions) {
      if (rows.length >= 32) {
        truncated = true;
        break;
      }
      const status = entry.relay.status();
      const owned = tabs.filter(t => t.owner === key);
      rows.push({
        key,
        session: short(entry.session || key.slice(0, 12), 60),
        workspace: short(entry.workspace ? path.basename(entry.workspace) : '', 80),
        transport: 'native',
        state: !status.stopped ? 'attached' : 'interrupted',
        leaseId: entry.leaseId,
        revision: entry.leaseId,
        hostGeneration: this.identity.hostGeneration,
        revocable: !status.stopped,
        tabCount: owned.length,
        tabs: owned.slice(0, 16).map(t => ({
          tabId: t.tabId,
          title: short(t.title),
          origin: (() => {
            try {
              return short(new URL(t.url).origin);
            } catch {
              return '';
            }
          })(),
        })),
      });
    }

    const result = {
      profile: {paired: !!aliases.length, aliases},
      nativeAvailable: !!this.identity.capabilities?.nativeTransport,
      release: this.identity.releaseVersion,
      extensionVersion: this.identity.extensionVersion,
      uiControl: 1,
      sessions: rows,
      truncated,
    };
    while (Buffer.byteLength(JSON.stringify(result)) > 49152) {
      const withTabs = rows.findLast(r => r.tabs.length);
      if (withTabs) withTabs.tabs.pop();
      else rows.pop();
      result.truncated = true;
    }
    return result;
  }

  async revoke(p) {
    if (!this.identity.capabilities?.nativeTransport) {
      throw fault('UI_UNSUPPORTED', 'This host has no native debugger transport.');
    }
    if (!/^[a-f0-9]{64}$/.test(p.key || '')) throw fault('INVALID_SESSION', 'Invalid task key.');
    const entry = this.sessions.sessions.get(p.key);
    if (
      !entry ||
      entry.leaseId !== p.leaseId ||
      p.hostGeneration !== this.identity.hostGeneration
    ) {
      throw fault('AUTHORITY_STALE', 'This task changed. Refresh before stopping it.');
    }
    if (this.sessions.busy.has(p.key)) {
      throw fault('SESSION_BUSY', 'This task is busy. No access was stopped; refresh and try again.');
    }
    try {
      await this.sessions.handle('session-disconnect', {
        instanceId: this.identity.instanceId,
        epoch: this.identity.epoch,
        hostGeneration: this.identity.hostGeneration,
        sessionKey: p.key,
        leaseId: p.leaseId,
      });
      return {accessRevoked: true, cleanup: 'confirmed', outcome: null, leaseId: p.leaseId};
    } catch (e) {
      const live = this.sessions.sessions.get(p.key);
      if (!live || live.relay.status().stopped) {
        return {
          accessRevoked: true,
          cleanup: 'unconfirmed',
          outcome: 'unknown',
          code: e.code || 'CLEANUP_FAILED',
          leaseId: p.leaseId,
        };
      }
      throw e;
    }
  }
}
