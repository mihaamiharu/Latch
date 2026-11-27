import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {readConfig} from './local.mjs';
import {recoveryDirectory, sameAuthority} from './recovery-state.mjs';

const short = (value, n = 160) => String(value || '').slice(0, n);

export class NativeUI {
  constructor(identity, sessions, recovery, browser) {
    Object.assign(this, {identity, sessions, recovery, browser});
    this.grants = new Set();
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    for (const grant of this.grants) this.recovery.fence(grant);
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
    const keys = new Set(this.sessions.sessions.keys());
    let truncated = false;
    if (this.recovery) {
      const names = await fs.readdir(recoveryDirectory(this.identity.instanceId)).catch(e => {
        if (e.code === 'ENOENT') return [];
        throw e;
      });
      for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort()) {
        if (keys.size >= 128) {
          truncated = true;
          break;
        }
        keys.add(name.slice(0, -5));
      }
    }
    const rows = [];
    for (const key of keys) {
      if (rows.length >= 32) {
        truncated = true;
        break;
      }
      const live = this.sessions.sessions.get(key);
      let record;
      try {
        record = await this.recovery?.store.read(key);
      } catch {
        rows.push({key, session: 'Unrecognized task record', transport: 'native', state: 'blocked', revocable: false, tabs: []});
        continue;
      }
      if (!record || record.status === 'retired') continue;
      const current = sameAuthority(record, {...this.identity, leaseId: record.leaseId});
      const status = live?.relay.status();
      const owned = current ? tabs.filter(t => t.owner === key) : [];
      rows.push({
        key,
        session: short(record.session, 60),
        workspace: short(path.basename(record.workspace), 80),
        transport: 'native',
        state: current && status && !status.stopped ? record.status : 'interrupted',
        leaseId: record.leaseId,
        revision: record.revision,
        hostGeneration: this.identity.hostGeneration,
        revocable: current && !!live && !status.stopped && record.status === 'attached',
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
      nativeAvailable: !!this.recovery,
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
    if (!this.recovery) throw fault('UI_UNSUPPORTED', 'This host has no schema-4 native recovery.');
    if (!/^[a-f0-9]{64}$/.test(p.key || '')) throw fault('INVALID_SESSION', 'Invalid task key.');
    const old = await this.recovery.store.read(p.key);
    if (
      !old ||
      old.leaseId !== p.leaseId ||
      old.revision !== p.revision ||
      !sameAuthority(old, {...this.identity, leaseId: p.leaseId}) ||
      p.hostGeneration !== this.identity.hostGeneration
    ) {
      throw fault('AUTHORITY_STALE', 'This task changed. Refresh before stopping it.');
    }
    const owner = {};
    const g = await this.recovery.begin(
      {...this.identity, sessionKey: p.key, workspace: old.workspace, session: old.session},
      owner,
    );
    this.grants.add(g);
    try {
      if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
      if (g.record?.leaseId !== p.leaseId || g.record?.revision !== p.revision) {
        throw fault('AUTHORITY_STALE', 'This task changed. Refresh before stopping it.');
      }
      await this.recovery.step(g, owner, {nonce: g.nonce, action: 'disconnect'});
      return {accessRevoked: true, cleanup: 'confirmed', outcome: g.record.outcome || null, leaseId: p.leaseId};
    } catch (e) {
      const live = this.sessions.sessions.get(p.key);
      if (g.cleanupRequested && (!live || live.relay.status().stopped)) {
        return {
          accessRevoked: true,
          cleanup: 'unconfirmed',
          outcome: 'unknown',
          code: e.code || 'CLEANUP_FAILED',
          leaseId: p.leaseId,
        };
      }
      throw e;
    } finally {
      try {
        await this.recovery.finish(g);
      } catch (e) {
        const live = this.sessions.sessions.get(p.key);
        if (live && !live.relay.status().stopped) throw e;
      } finally {
        this.grants.delete(g);
      }
    }
  }
}
