import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {readConfig, setArtifactsDir} from './local.mjs';
import {describeLibraryRoot} from './platform.mjs';
import {boundRun, listRuns, runPattern} from './exploration-storage.mjs';
import {startLibraryServer} from './exploration-library.mjs';

const short = (value, n = 160) => String(value || '').slice(0, n);

export class NativeUI {
  constructor(identity, sessions, browser) {
    Object.assign(this, {identity, sessions, browser});
    this.stopped = false;
    this.libraryServer = null;
    this.libraryStarting = null;
  }

  stop() {
    this.stopped = true;
    if (this.libraryServer) {
      const server = this.libraryServer;
      this.libraryServer = null;
      void server.close().catch(() => {});
    }
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
    const libraryInfo = describeLibraryRoot();
    const runCount = (await listRuns().catch(() => [])).length;

    for (const [key, entry] of this.sessions.sessions) {
      if (rows.length >= 32) {
        truncated = true;
        break;
      }
      const status = entry.relay.status();
      const owned = tabs.filter(t => t.owner === key);
      let runId = null;
      if (entry.workspace && entry.session) {
        const profileCandidates = aliases.length ? aliases : ['work'];
        for (const alias of profileCandidates) {
          const bound = await boundRun({workspace: entry.workspace, session: entry.session, profile: alias}).catch(() => null);
          if (bound?.id) {
            runId = bound.id;
            break;
          }
        }
      }
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
        runId,
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
      library: {
        runCount,
        path: libraryInfo.path,
        defaultPath: libraryInfo.defaultPath,
        configuredPath: libraryInfo.configuredPath,
        source: libraryInfo.source,
        envOverride: libraryInfo.envOverride,
        serverUrl: this.libraryServer?.url || null,
      },
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

  async openLibrary(payload = {}) {
    if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
    const runId = payload.runId ? String(payload.runId) : null;
    if (runId && !runPattern.test(runId)) {
      throw fault('INVALID_RUN', 'Invalid exploration run ID.');
    }
    if (!this.libraryServer) {
      if (!this.libraryStarting) {
        this.libraryStarting = startLibraryServer({port: 0}).finally(() => {
          this.libraryStarting = null;
        });
      }
      const started = await this.libraryStarting;
      if (this.stopped) {
        void started.close().catch(() => {});
        throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
      }
      this.libraryServer = started;
    }
    const baseUrl = this.libraryServer.url;
    return {
      url: runId ? `${baseUrl}/run/${runId}` : baseUrl,
      baseUrl,
      ...(runId ? {runId} : {}),
    };
  }

  async setConfig(payload = {}) {
    if (this.stopped) throw fault('BRIDGE_DISCONNECTED', 'Local bridge is stopping.');
    const key = payload.key;
    if (key !== 'artifactsDir' && key !== 'artifacts-dir') {
      throw fault('INVALID_ARGUMENT', 'Unsupported config key. Expected artifactsDir.');
    }
    const reset = payload.reset === true || payload.value === null || payload.value === undefined || payload.value === '';
    const updated = reset
      ? await setArtifactsDir(null)
      : await setArtifactsDir(payload.value, {requireAbsolute: true});
    const runCount = (await listRuns().catch(() => [])).length;
    return {
      ...updated,
      library: {
        runCount,
        path: updated.path,
        defaultPath: updated.defaultPath,
        configuredPath: updated.configuredPath,
        source: updated.source,
        envOverride: updated.envOverride,
        serverUrl: this.libraryServer?.url || null,
      },
    };
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
