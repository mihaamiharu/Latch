/*
 * Adapted from Microsoft Playwright browserModel.ts and cdpRelayV2.ts,
 * revision f9a841f968dd9a4e315df2ec2930da1952971667.
 * Copyright (c) Microsoft Corporation. Licensed under Apache-2.0.
 * See third_party/playwright/LICENSE and SOURCES.md.
 * Latch changes: explicit root/attributed-child ownership, scoped inspection,
 * per-target lifecycle and no browser-wide command fallback.
 */
import crypto from 'node:crypto';
import {ChildSessions} from '../extension/child-sessions.js';

export class BrowserModel {
  constructor(send, emit, {onRetire=()=>{}}={}) {
    this.send = send; this.emit = emit;
    this.onRetire=onRetire;
    this.namespace = `latch-${crypto.randomBytes(12).toString('hex')}`;
    this.records = new Map(); this.routes = new Map(); this.browserSessions = new Set();
    this.nextId = 0; this.autoAttach = false;
  }
  get tab() { return this.root?.tab; }
  get target() { return this.root?.info; }
  get sessionId() { return this.root?.sessionId; }
  setTab(tab) {
    if (this.root) throw new Error('Starting tab is already registered.');
    this.root = this.record(tab); this.records.set(tab.id, this.root);
  }
  record(tab, parent) {
    return {tab, parent, sessionId: `${this.namespace}-page-${++this.nextId}`, children: new ChildSessions(), aliases: new Set(), info: null};
  }
  async addTab(tab) {
    if (this.records.has(tab.id)) return;
    const parent = this.records.get(tab.openerTabId);
    if (!parent || !Number.isSafeInteger(tab.id) || this.records.size >= 16)
      throw new Error('Popup has no owned parent or exceeds its session limit.');
    const record = this.record(tab, parent);
    this.records.set(tab.id, record);
    if (this.autoAttach) {
      try { await this.attach(record); }
      catch (error) {
        // A short-lived popup may disappear before debugger attachment. Its
        // removal is local to that page, not a reason to lose surviving pages.
        if (this.records.has(tab.id)) {
          this.removeTab(tab.id);
          await this.send('drop', {tabId: tab.id}).catch(() => {});
        }
      }
    }
  }
  async initialize() {
    this.autoAttach = true;
    await Promise.all([...this.records.values()].map(record => this.attach(record)));
  }
  async attach(record) {
    if (record.initializing) return record.initializing;
    record.initializing = (async () => {
      if (record.parent && !record.parent.info) await this.attach(record.parent);
      await this.send('attach', {tabId: record.tab.id});
      const {targetInfo} = await this.send('command', {tabId: record.tab.id, method: 'Target.getTargetInfo'});
      if (!this.records.has(record.tab.id)) return;
      if (!targetInfo?.targetId) throw new Error('Chrome returned no target identity.');
      if (record.parent?.info && targetInfo.openerId && targetInfo.openerId !== record.parent.info.targetId)
        throw new Error('Popup opener changed during attachment.');
      record.info = {...targetInfo, ...(record.parent?.info ? {openerId: record.parent.info.targetId} : {})};
      this.routes.set(record.sessionId, {record});
      this.emit({method: 'Target.attachedToTarget', params: {sessionId: record.sessionId,
        targetInfo: {...record.info, attached: true}, waitingForDebugger: false}});
    })();
    return record.initializing;
  }
  removeTab(tabId) {
    const record = this.records.get(tabId);
    if (!record) return;
    this.records.delete(tabId);
    this.onRetire(tabId);
    record.frameTreeResolve?.();
    for (const [id, route] of this.routes) if (route.record === record) {
      if(route.alias)this.emit({...(route.parentSessionId?{sessionId:route.parentSessionId}:{}),method:'Target.detachedFromTarget',
        params:{sessionId:id,targetId:route.nativeSession?record.children.get(route.nativeSession)?.targetId:record.info?.targetId}});
      this.routes.delete(id);
    }
    if (record.info) this.emit({method: 'Target.detachedFromTarget', params: {
      sessionId: record.sessionId, targetId: record.info.targetId}});
  }
  inventory() {
    return [...this.records.values()].map(record => ({tabId: record.tab.id, targetId: record.info?.targetId,
      openerTabId: record.parent?.tab.id, root: record === this.root}));
  }
  didSendResponse(message) {
    if (message.method === 'Page.getFrameTree') this.routes.get(message.sessionId)?.record.frameTreeResolve?.();
  }
  onEvent({source, method, params}) {
    const record = this.records.get(source?.tabId);
    if (!record) return;
    const parentId = source.sessionId ? record.children.get(source.sessionId)?.wire : record.sessionId;
    if (!parentId) return;
    let translated = params;
    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      const wire = `${this.namespace}-child-${++this.nextId}`;
      const {duplicate}=record.children.add({id:params.sessionId,wire,parent:source.sessionId,
        targetId:params.targetInfo?.targetId,type:params.targetInfo?.type,info:params.targetInfo},
        [...this.records.values()].reduce((n,r)=>n+r.children.size,0));
      if(duplicate)return;
      this.routes.set(wire, {record, nativeSession: params.sessionId});
      translated = {...params, sessionId: wire};
    } else if (method === 'Target.detachedFromTarget' && params?.sessionId) {
      const child = record.children.get(params.sessionId);
      if (!child) return;
      translated = {...params, sessionId: child.wire};
      const removedChildren=record.children.remove(params.sessionId);
      this.onRetire(record.tab.id,removedChildren.map(child=>child.id));
      for(const removed of removedChildren){
        this.routes.delete(removed.wire);
        for(const alias of removed.aliases){
          const route=this.routes.get(alias);this.routes.delete(alias);
          this.emit({...(route?.parentSessionId?{sessionId:route.parentSessionId}:{}),method:'Target.detachedFromTarget',params:{sessionId:alias,targetId:removed.targetId}});
        }
      }
    }
    if (method === 'Page.frameNavigated' && !source.sessionId && !params?.frame?.parentId && record.info)
      record.info.url = params.frame.url;
    this.emit({sessionId: parentId, method, params: translated});
    // Inspection sessions are separate CDP clients for the same owned page.
    const aliases=source.sessionId?record.children.get(source.sessionId)?.aliases:record.aliases;
    for (const alias of aliases||[]) this.emit({sessionId: alias, method, params: translated});
  }
  async command({method, params, sessionId}) {
    if (!sessionId || this.browserSessions.has(sessionId)) {
      switch (method) {
        case 'Target.attachToBrowserTarget': {
          if (this.browserSessions.size >= 64) throw new Error('Too many inspection sessions.');
          const id = `${this.namespace}-browser-${++this.nextId}`; this.browserSessions.add(id); return {sessionId: id};
        }
        case 'Target.attachToTarget': {
          const record = [...this.records.values()].find(record => record.info?.targetId === params?.targetId||[...record.children.values()].some(c=>c.targetId===params?.targetId));
          if (!record) throw new Error('Target is not owned by this session.');
          const child=[...record.children.values()].find(c=>c.targetId===params?.targetId);
          const aliases=child?child.aliases:record.aliases;
          if (aliases.size >= 64) throw new Error('Too many inspection sessions.');
          const id = `${this.namespace}-inspector-${++this.nextId}`;
          aliases.add(id); this.routes.set(id, {record, alias: true,parentSessionId:sessionId,...(child?{nativeSession:child.id}:{})}); return {sessionId: id};
        }
        case 'Target.detachFromTarget': {
          const route = this.routes.get(params?.sessionId);
          if (route?.alias) { (route.nativeSession?route.record.children.get(route.nativeSession)?.aliases:route.record.aliases)?.delete(params.sessionId); this.routes.delete(params.sessionId); }
          else if (!this.browserSessions.delete(params?.sessionId)) throw new Error('Inspection session is not owned.');
          return {};
        }
        case 'Target.closeTarget': {
          const record = [...this.records.values()].find(record => record.info?.targetId === params?.targetId);
          if (!record) throw new Error('Target is not owned by this session.');
          await this.send('close', {tabId: record.tab.id}); return {success: true};
        }
        case 'Runtime.runIfWaitingForDebugger': {
          if (sessionId) return {}; throw new Error('Runtime command requires an owned target.');
        }
        case 'Browser.getVersion': return {protocolVersion: '1.3', product: 'Chrome/Latch-Preview', userAgent: 'Latch-CDP-Preview', revision: 'phase-3', jsVersion: ''};
        case 'Browser.setDownloadBehavior': return {}; // No managed download claim.
        case 'Target.getBrowserContexts': return {browserContextIds: []};
        case 'Target.setDiscoverTargets': return {};
        case 'Target.setAutoAttach': await this.initialize(); return {};
        case 'Target.getTargets': return {targetInfos: [...this.records.values()].map(record => record.info).filter(Boolean)};
        case 'Target.getTargetInfo': {
          const record = [...this.records.values()].find(record => record.info && (!params?.targetId || record.info.targetId === params.targetId));
          if (!record) throw new Error('Target is not owned by this session.'); return {targetInfo: record.info};
        }
        default: throw new Error(`Unsupported browser-level method: ${method}`);
      }
    }
    const route = this.routes.get(sessionId);
    if (!route || !this.records.has(route.record.tab.id)) throw new Error('Target session is not owned by this connection.');
    if (method === 'Target.getTargetInfo' && !route.nativeSession) {
      if (params?.targetId && params.targetId !== route.record.info.targetId) throw new Error('Target is not owned by this session.');
      return {targetInfo: route.record.info};
    }
    if (!route.nativeSession && method === 'Page.getFrameTree' && !route.record.frameTreeBarrier)
      route.record.frameTreeBarrier = new Promise(resolve => { route.record.frameTreeResolve = resolve; });
    // chrome.debugger can return lifecycle history and execution contexts
    // before the frame-tree response reaches Playwright. Preserve startup
    // ordering so its frame/listeners exist before those events arrive.
    if (!route.nativeSession && ['Page.setLifecycleEventsEnabled', 'Runtime.enable'].includes(method) && route.record.frameTreeBarrier)
      await route.record.frameTreeBarrier;
    return this.send('command', {tabId: route.record.tab.id,
      ...(route.nativeSession ? {sessionId: route.nativeSession} : {}), method, params});
  }
}
