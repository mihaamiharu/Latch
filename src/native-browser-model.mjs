/*
 * Adapted from Microsoft Playwright browserModel.ts and cdpRelayV2.ts,
 * revision f9a841f968dd9a4e315df2ec2930da1952971667.
 * Copyright (c) Microsoft Corporation. Licensed under Apache-2.0.
 * See third_party/playwright/LICENSE and SOURCES.md.
 * Latch changes: single explicitly selected target, bounded initialization,
 * no global-command fallback, read-only target enumeration, explicit failures.
 */
import crypto from 'node:crypto';

export class BrowserModel {
  constructor(send, emit) {
    this.send = send;
    this.emit = emit;
    this.children = new Set();
    this.tab = null;
    this.target = null;
    this.initializing = null;
    this.namespace = `latch-${crypto.randomBytes(12).toString('hex')}`;
    this.sessionId = `${this.namespace}-tab`;
    this.browserSessions = new Set();
    this.aliases = new Set();
    this.nextAlias = 1;
  }

  setTab(tab) {
    if (this.tab) throw new Error('This experiment supports one explicitly selected tab.');
    this.tab = tab;
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      if (!this.tab) throw new Error('Selected tab is unavailable.');
      await this.send('attach', {tabId: this.tab.id});
      const {targetInfo} = await this.send('command', {tabId: this.tab.id, method: 'Target.getTargetInfo'});
      if (!targetInfo?.targetId) throw new Error('Chrome returned no target identity.');
      this.target = targetInfo;
      this.emit({method: 'Target.attachedToTarget', params: {
        sessionId: this.sessionId, targetInfo: {...targetInfo, attached: true}, waitingForDebugger: false,
      }});
    })();
    return this.initializing;
  }

  onEvent({source, method, params}) {
    if (!this.tab || source?.tabId !== this.tab.id) return;
    if (source.sessionId && !this.children.has(source.sessionId)) return;
    const parent = source.sessionId ? `${this.namespace}-child-${source.sessionId}` : this.sessionId;
    if (method === 'Target.attachedToTarget' && params?.sessionId) this.children.add(params.sessionId);
    if (method === 'Target.detachedFromTarget' && params?.sessionId) this.children.delete(params.sessionId);
    const translated = method.startsWith('Target.') && params?.sessionId
      ? {...params, sessionId: `${this.namespace}-child-${params.sessionId}`} : params;
    this.emit({sessionId: parent, method, params: translated});
  }

  async command({method, params, sessionId}) {
    const browserSession = this.browserSessions.has(sessionId);
    if (!sessionId || browserSession) {
      switch (method) {
        case 'Target.attachToBrowserTarget': {
          if (this.browserSessions.size >= 64) throw new Error('Too many inspection sessions.');
          const id = `${this.namespace}-browser-${this.nextAlias++}`;
          this.browserSessions.add(id);
          return {sessionId: id};
        }
        case 'Target.attachToTarget': {
          if (!this.target || params?.targetId !== this.target.targetId)
            throw new Error('Target is not owned by this session.');
          if (this.aliases.size >= 64) throw new Error('Too many inspection sessions.');
          const id = `${this.namespace}-inspector-${this.nextAlias++}`;
          this.aliases.add(id);
          return {sessionId: id};
        }
        case 'Target.detachFromTarget': {
          const id = params?.sessionId;
          if (!this.aliases.delete(id) && !this.browserSessions.delete(id))
            throw new Error('Inspection session is not owned.');
          return {};
        }
        case 'Runtime.runIfWaitingForDebugger': {
          if (browserSession) return {};
          throw new Error('Runtime command requires an owned target.');
        }
        case 'Browser.getVersion': return {
          protocolVersion: '1.3', product: 'Chrome/Latch-Experiment',
          userAgent: 'Latch-CDP-Experiment', revision: 'phase-1', jsVersion: '',
        };
        // Playwright sets this while attaching. This experiment does not claim
        // download support or alter Chrome's profile-wide download settings.
        case 'Browser.setDownloadBehavior': return {};
        case 'Target.getBrowserContexts': return {browserContextIds: []};
        case 'Target.setDiscoverTargets': return {};
        case 'Target.setAutoAttach': await this.initialize(); return {};
        case 'Target.getTargets': return {targetInfos: this.target ? [this.target] : []};
        case 'Target.getTargetInfo': {
          if (!this.target || (params?.targetId && params.targetId !== this.target.targetId))
            throw new Error('Target is not owned by this session.');
          return {targetInfo: this.target};
        }
        default: throw new Error(`Unsupported browser-level method: ${method}`);
      }
    }
    const child = typeof sessionId === 'string' && sessionId.startsWith(`${this.namespace}-child-`)
      ? sessionId.slice(`${this.namespace}-child-`.length) : undefined;
    if (!this.target || (sessionId !== this.sessionId && !this.aliases.has(sessionId) && !this.children.has(child)))
      throw new Error('Target session is not owned by this connection.');
    return this.send('command', {tabId: this.tab.id,
      ...(child ? {sessionId: child} : {}), method, params});
  }
}
