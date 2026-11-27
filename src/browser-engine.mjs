import path from 'node:path';
import {chromium} from 'playwright-core';
import {ACTIONS, fault, webUrl} from '../extension/protocol.js';
import {redact} from './redact.mjs';

const MAX_CONSOLE_ENTRIES = 500;
const MAX_NETWORK_ENTRIES = 500;
const REF_PATTERN = /^(?:f\d+)?e\d+$/;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const DOM_OBSERVATION_FN = els => ({
  total: els.length,
  nodes: els.slice(0, 2000).map(el => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    test_id: el.getAttribute('data-testid') || el.getAttribute('data-test-id'),
    test_id_attribute: el.hasAttribute('data-testid')
      ? 'data-testid'
      : el.hasAttribute('data-test-id')
        ? 'data-test-id'
        : null,
    name: el.getAttribute('name'),
    role: el.getAttribute('role'),
    label:
      el.getAttribute('aria-label') ||
      (el.labels ? [...el.labels].map(l => l.textContent.trim()).join(' ') : null),
    input_type: el.getAttribute('type'),
  })),
});

const DOM_SELECTOR = 'input,button,a,textarea,select,[role],[data-testid],[data-test-id]';

/** Parse [ref=...] entries from Playwright AI ARIA snapshot YAML. */
export function parseSnapshotRefs(snapshotText) {
  const refs = new Map();
  if (typeof snapshotText !== 'string') return refs;
  for (const line of snapshotText.split('\n')) {
    const match = line.match(/^\s*-\s+([a-z][a-z0-9_-]*)(?:\s+("(?:[^"\\]|\\.)*"))?[^\n]*?\[ref=([^\]]+)\]/i);
    if (!match) continue;
    let name = null;
    if (match[2]) {
      try {
        name = JSON.parse(match[2]);
      } catch {
        name = match[2];
      }
    }
    refs.set(match[3], {ref: match[3], role: match[1], name});
  }
  return refs;
}

function boundedRingPush(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function safeJsonValue(value) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    return JSON.parse(redact(text));
  } catch {
    return redact(String(value));
  }
}

function normalizeEngineError(error, action, focusEmulation = true) {
  if (error?.code && !error.code.startsWith('ERR_')) {
    return fault(error.code, redact(error.message), error.hint ? redact(error.hint) : undefined);
  }
  const message = redact(error?.message || String(error));
  if (error?.name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(message)) {
    const hint = focusEmulation
      ? 'Element may not be visible, enabled, or present; take a fresh snapshot to verify.'
      : 'Focus emulation is disabled; background tabs can stall actionability checks.';
    return fault('ACTION_TIMEOUT', `Action ${action} timed out: ${message}`, hint);
  }
  if (/Target page, context or browser has been closed|Target.*closed|Session.*closed|Connection closed/i.test(message)) {
    return fault('SESSION_STALE', message, 'The target page or bridge connection closed; reconnect or open a new session.');
  }
  if (/strict mode violation/i.test(message)) {
    return fault('AMBIGUOUS_LOCATOR', message, 'Multiple elements matched; run snapshot or narrow the selector.');
  }
  return fault('PLAYWRIGHT_ERROR', message);
}

function argAt(args, key, index) {
  if (Array.isArray(args)) return args[index];
  if (args && typeof args === 'object') return args[key];
  return undefined;
}

/**
 * In-process Playwright Core engine owned by native-host per session.
 * Connects over Latch's authenticated in-process CDP relay endpoint.
 */
export class BrowserEngine {
  constructor({
    cdpEndpoint,
    sessionKey,
    workspace,
    session,
    tabId,
    focusEmulation = true,
    connectOverCDP = endpoint => chromium.connectOverCDP(endpoint, {noDefaults: true}),
    onClosed = () => {},
  }) {
    this.cdpEndpoint = cdpEndpoint;
    this.sessionKey = sessionKey;
    this.workspace = workspace;
    this.session = session;
    this.rootTabId = tabId;
    this.focusEmulation = focusEmulation;
    this.connectOverCDP = connectOverCDP;
    this.onClosed = onClosed;

    this.browser = null;
    this.context = null;
    this.activePage = null;
    this.closed = false;
    this.pageTargets = new WeakMap();
    this.pageRefs = new WeakMap();
    this.trackedPages = new WeakSet();
    this.consoleEntries = [];
    this.networkEntries = [];
    this.pendingDialogs = [];
  }

  async connect({targetId} = {}) {
    try {
      this.browser = await this.connectOverCDP(this.cdpEndpoint);
      this.browser.on?.('disconnected', () => {
        if (!this.closed) this.onClosed('browser-disconnected');
      });
      this.context = this.browser.contexts()[0];
      if (!this.context) {
        throw fault('SESSION_STALE', 'CDP browser context was unavailable after connection.');
      }
      this.context.on?.('page', page => {
        void this.trackPage(page).catch(() => {});
      });
      for (const page of this.context.pages()) {
        await this.trackPage(page);
      }
      if (targetId) {
        await this.selectTarget({targetId});
      } else {
        this.activePage = this.context.pages()[0] || null;
      }
      return this;
    } catch (error) {
      await this.close().catch(() => {});
      throw normalizeEngineError(error, 'connect', this.focusEmulation);
    }
  }

  async identifyPage(page) {
    if (!page || page.isClosed?.()) return null;
    const cached = this.pageTargets.get(page);
    if (cached) return cached;
    if (typeof page.context === 'function' && typeof page.context().newCDPSession === 'function') {
      const cdp = await page.context().newCDPSession(page);
      try {
        const {targetInfo} = await cdp.send('Target.getTargetInfo');
        if (targetInfo?.targetId) {
          this.pageTargets.set(page, targetInfo.targetId);
          return targetInfo.targetId;
        }
      } finally {
        await cdp.detach().catch(() => {});
      }
    }
    return null;
  }

  async trackPage(page) {
    if (!page || this.trackedPages.has(page)) return;
    this.trackedPages.add(page);
    await this.identifyPage(page).catch(() => {});
    if (!this.activePage || this.activePage.isClosed?.()) {
      this.activePage = page;
    }
    page.on?.('console', msg => {
      const targetId = this.pageTargets.get(page) || null;
      boundedRingPush(
        this.consoleEntries,
        {
          type: msg.type?.() || 'log',
          text: redact(msg.text?.() || ''),
          location: msg.location?.() || null,
          targetId,
          timestamp: Date.now(),
        },
        MAX_CONSOLE_ENTRIES,
      );
    });
    page.on?.('request', req => {
      const targetId = this.pageTargets.get(page) || null;
      boundedRingPush(
        this.networkEntries,
        {
          kind: 'request',
          method: req.method?.() || 'GET',
          url: redact(req.url?.() || ''),
          resourceType: req.resourceType?.() || null,
          targetId,
          timestamp: Date.now(),
        },
        MAX_NETWORK_ENTRIES,
      );
    });
    page.on?.('response', res => {
      const req = res.request?.();
      const targetId = this.pageTargets.get(page) || null;
      boundedRingPush(
        this.networkEntries,
        {
          kind: 'response',
          method: req?.method?.() || 'GET',
          url: redact(res.url?.() || ''),
          status: res.status?.(),
          ok: res.ok?.(),
          resourceType: req?.resourceType?.() || null,
          targetId,
          timestamp: Date.now(),
        },
        MAX_NETWORK_ENTRIES,
      );
    });
    page.on?.('requestfailed', req => {
      const targetId = this.pageTargets.get(page) || null;
      boundedRingPush(
        this.networkEntries,
        {
          kind: 'failed',
          method: req.method?.() || 'GET',
          url: redact(req.url?.() || ''),
          resourceType: req.resourceType?.() || null,
          failureText: redact(req.failure?.()?.errorText || 'Request failed'),
          targetId,
          timestamp: Date.now(),
        },
        MAX_NETWORK_ENTRIES,
      );
    });
    page.on?.('dialog', dialog => {
      this.pendingDialogs.push({
        id: `dlg-${Date.now()}-${this.pendingDialogs.length}`,
        page,
        dialog,
        type: dialog.type?.() || 'alert',
        message: redact(dialog.message?.() || ''),
        defaultValue: redact(dialog.defaultValue?.() || ''),
        timestamp: Date.now(),
      });
    });
    page.on?.('close', () => {
      this.pendingDialogs = this.pendingDialogs.filter(entry => entry.page !== page);
      if (this.activePage === page) {
        const remaining = this.context?.pages?.().filter(p => p !== page && !p.isClosed?.()) || [];
        this.activePage = remaining[0] || null;
      }
    });
  }

  ensureActivePage() {
    if (this.closed) {
      throw fault('SESSION_STALE', 'Browser engine session is closed.', 'Open or connect a session first.');
    }
    const pages = this.context?.pages?.().filter(p => !p.isClosed?.()) || [];
    if (!this.activePage || this.activePage.isClosed?.() || !pages.includes(this.activePage)) {
      this.activePage = pages[0] || null;
    }
    if (!this.activePage) {
      throw fault('SESSION_STALE', 'No open owned page remains in this session.', 'Reconnect or open a new tab.');
    }
    return this.activePage;
  }

  async selectTarget({targetId, index} = {}) {
    const pages = this.context?.pages?.().filter(p => !p.isClosed?.()) || [];
    if (targetId !== undefined) {
      for (const page of pages) {
        const id = await this.identifyPage(page);
        if (id === targetId) {
          this.activePage = page;
          return this.pageSummary(page);
        }
      }
      throw fault('TAB_CHANGED', 'The requested owned target is not exposed by Playwright.');
    }
    if (Number.isSafeInteger(index)) {
      const page = pages[index];
      if (!page) throw fault('TAB_UNAVAILABLE', `No owned page at index ${index}.`);
      this.activePage = page;
      return this.pageSummary(page);
    }
    return this.pageSummary(this.ensureActivePage());
  }

  async pageSummary(page) {
    if (!page || page.isClosed?.()) return null;
    const targetId = await this.identifyPage(page).catch(() => null);
    const title = await page.title().catch(() => '');
    return {
      targetId,
      url: page.url(),
      title,
    };
  }

  resolveLocator(page, args, {positionalIndex = 0} = {}) {
    const ref = argAt(args, 'ref', undefined);
    const selector = argAt(args, 'selector', undefined);
    const target = argAt(args, 'target', positionalIndex);
    const frameSelector = argAt(args, 'frame', undefined);

    const raw = ref ?? selector ?? target;
    if (typeof raw !== 'string' || !raw.length) {
      throw fault('INVALID_ARGUMENT', 'A target ref or selector is required.');
    }

    const root = frameSelector ? page.frameLocator(frameSelector) : page;
    const explicitRef = ref !== undefined || raw.startsWith('aria-ref=');
    const stripped = raw.startsWith('aria-ref=') ? raw.slice('aria-ref='.length) : raw;
    if (explicitRef || REF_PATTERN.test(stripped)) {
      const refs = this.pageRefs.get(page);
      if (!refs) {
        throw fault(
          'SNAPSHOT_REQUIRED',
          `No snapshot refs are cached yet for "${stripped}".`,
          'Run snapshot first to generate element refs.',
        );
      }
      if (!refs.has(stripped)) {
        throw fault(
          'REF_NOT_FOUND',
          `Snapshot ref "${stripped}" was not found in the latest snapshot.`,
          'Run snapshot again to refresh element refs.',
        );
      }
      return root.locator(`aria-ref=${stripped}`);
    }
    return root.locator(raw);
  }

  async snapshot(page, args = {}) {
    const selector = argAt(args, 'selector', undefined) ?? argAt(args, 'root', 0);
    const depth = argAt(args, 'depth', undefined);
    const timeout = Number.isSafeInteger(args?.timeout) ? args.timeout : 10000;
    const options = {mode: 'ai', timeout, ...(Number.isSafeInteger(depth) ? {depth} : {})};
    const yaml = selector ? await page.locator(selector).ariaSnapshot(options) : await page.ariaSnapshot(options);
    const refs = parseSnapshotRefs(yaml);
    this.pageRefs.set(page, refs);
    return {
      snapshot: redact(yaml),
      url: page.url(),
      title: await page.title().catch(() => ''),
      targetId: await this.identifyPage(page).catch(() => null),
      refCount: refs.size,
      refs: [...refs.values()],
    };
  }

  async action(actionName, args = {}) {
    if (!ACTIONS.has(actionName)) {
      throw fault('INVALID_ARGUMENT', `Unsupported browser action: ${actionName}.`);
    }
    if (args?.targetId !== undefined) {
      await this.selectTarget({targetId: args.targetId});
    }
    const page = this.ensureActivePage();
    const timeout = Number.isSafeInteger(args?.timeout) ? args.timeout : 30000;

    try {
      switch (actionName) {
        case 'snapshot':
          return await this.snapshot(page, args);

        case 'click': {
          const locator = this.resolveLocator(page, args);
          await locator.click({
            timeout,
            ...(args?.button ? {button: args.button} : {}),
            ...(Number.isSafeInteger(args?.clickCount) ? {clickCount: args.clickCount} : {}),
            ...(Array.isArray(args?.modifiers) ? {modifiers: args.modifiers} : {}),
          });
          return {clicked: true, ...(await this.pageSummary(page))};
        }

        case 'dblclick': {
          const locator = this.resolveLocator(page, args);
          await locator.dblclick({
            timeout,
            ...(args?.button ? {button: args.button} : {}),
            ...(Array.isArray(args?.modifiers) ? {modifiers: args.modifiers} : {}),
          });
          return {dblclicked: true, ...(await this.pageSummary(page))};
        }

        case 'fill': {
          const value = argAt(args, 'value', 1);
          if (value === undefined || value === null) {
            throw fault('INVALID_ARGUMENT', 'fill requires a value.');
          }
          const locator = this.resolveLocator(page, args);
          await locator.fill(String(value), {timeout});
          return {filled: true, ...(await this.pageSummary(page))};
        }

        case 'type': {
          const hasTarget = Boolean(
            argAt(args, 'ref', undefined) ?? argAt(args, 'selector', undefined) ?? argAt(args, 'target', undefined),
          );
          if (Array.isArray(args) && args.length >= 2) {
            const locator = this.resolveLocator(page, args);
            await locator.pressSequentially(String(args[1]), {timeout});
          } else if (hasTarget) {
            const text = argAt(args, 'text', 1) ?? argAt(args, 'value', 1);
            if (text === undefined || text === null) throw fault('INVALID_ARGUMENT', 'type requires text.');
            const locator = this.resolveLocator(page, args);
            await locator.pressSequentially(String(text), {
              timeout,
              ...(Number.isSafeInteger(args?.delay) ? {delay: args.delay} : {}),
            });
          } else {
            const text = argAt(args, 'text', 0) ?? argAt(args, 'value', 0);
            if (text === undefined || text === null) throw fault('INVALID_ARGUMENT', 'type requires text.');
            await page.keyboard.type(String(text), {
              ...(Number.isSafeInteger(args?.delay) ? {delay: args.delay} : {}),
            });
          }
          return {typed: true, ...(await this.pageSummary(page))};
        }

        case 'press': {
          const hasTarget = Boolean(
            argAt(args, 'ref', undefined) ?? argAt(args, 'selector', undefined) ?? argAt(args, 'target', undefined),
          );
          if (Array.isArray(args) && args.length >= 2) {
            const locator = this.resolveLocator(page, args);
            await locator.press(String(args[1]), {timeout});
            return {pressed: String(args[1]), ...(await this.pageSummary(page))};
          }
          const key = argAt(args, 'key', 0);
          if (!key || typeof key !== 'string') throw fault('INVALID_ARGUMENT', 'press requires a key name.');
          if (hasTarget) {
            const locator = this.resolveLocator(page, args);
            await locator.press(key, {timeout});
          } else {
            await page.keyboard.press(key);
          }
          return {pressed: key, ...(await this.pageSummary(page))};
        }

        case 'hover': {
          const locator = this.resolveLocator(page, args);
          await locator.hover({timeout});
          return {hovered: true, ...(await this.pageSummary(page))};
        }

        case 'select': {
          const values = argAt(args, 'values', undefined) ?? argAt(args, 'value', 1);
          if (values === undefined) throw fault('INVALID_ARGUMENT', 'select requires a value or values.');
          const locator = this.resolveLocator(page, args);
          const selected = await locator.selectOption(values, {timeout});
          return {selected, ...(await this.pageSummary(page))};
        }

        case 'check': {
          const locator = this.resolveLocator(page, args);
          await locator.check({timeout});
          return {checked: true, ...(await this.pageSummary(page))};
        }

        case 'uncheck': {
          const locator = this.resolveLocator(page, args);
          await locator.uncheck({timeout});
          return {unchecked: true, ...(await this.pageSummary(page))};
        }

        case 'upload': {
          const rawFiles =
            argAt(args, 'files', undefined) ??
            argAt(args, 'paths', undefined) ??
            (Array.isArray(args) ? args.slice(1) : undefined);
          const fileList = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];
          if (!fileList.length || fileList.some(f => typeof f !== 'string' || !f)) {
            throw fault('INVALID_ARGUMENT', 'upload requires one or more file paths.');
          }
          const resolvedFiles = fileList.map(f =>
            path.isAbsolute(f) ? f : path.resolve(this.workspace || process.cwd(), f),
          );
          const locator = this.resolveLocator(page, args);
          await locator.setInputFiles(resolvedFiles, {timeout});
          return {uploaded: resolvedFiles.length, ...(await this.pageSummary(page))};
        }

        case 'screenshot': {
          const fullPage = Boolean(args?.fullPage);
          const hasTarget = Boolean(args?.ref ?? args?.selector ?? args?.target);
          const buffer = hasTarget
            ? await this.resolveLocator(page, args).screenshot({type: 'png', timeout})
            : await page.screenshot({fullPage, type: 'png', timeout});
          return {
            mimeType: 'image/png',
            data: buffer.toString('base64'),
            bytes: buffer.length,
            ...(await this.pageSummary(page)),
          };
        }

        case 'goto': {
          const url = argAt(args, 'url', 0);
          if (!webUrl(url) || url.length > 16384) {
            throw fault('INVALID_ARGUMENT', 'goto requires an ordinary http(s) URL.');
          }
          await page.goto(url, {waitUntil: args?.waitUntil || 'load', timeout});
          return await this.pageSummary(page);
        }

        case 'back': {
          await page.goBack({waitUntil: args?.waitUntil || 'load', timeout});
          return await this.pageSummary(page);
        }

        case 'forward': {
          await page.goForward({waitUntil: args?.waitUntil || 'load', timeout});
          return await this.pageSummary(page);
        }

        case 'reload': {
          await page.reload({waitUntil: args?.waitUntil || 'load', timeout});
          return await this.pageSummary(page);
        }

        case 'eval': {
          const expression = argAt(args, 'expression', 0) ?? argAt(args, 'code', 0);
          if (typeof expression !== 'string' || !expression.trim()) {
            throw fault('INVALID_ARGUMENT', 'eval requires a JavaScript expression.');
          }
          const hasTarget = Boolean(args?.ref ?? args?.selector ?? args?.target);
          const evaluator = hasTarget
            ? await this.resolveLocator(page, args).evaluate((el, code) => {
                try {
                  const candidate = (0, eval)(`(${code})`);
                  return typeof candidate === 'function' ? candidate(el) : candidate;
                } catch {
                  return (0, eval)(code);
                }
              }, expression)
            : await page.evaluate(code => {
                try {
                  const candidate = (0, eval)(`(${code})`);
                  return typeof candidate === 'function' ? candidate() : candidate;
                } catch {
                  return (0, eval)(code);
                }
              }, expression);
          return {value: safeJsonValue(evaluator)};
        }

        case 'run-code': {
          const code = argAt(args, 'code', 0) ?? argAt(args, 'fn', 0);
          if (typeof code !== 'string' || !code.trim()) {
            throw fault('INVALID_ARGUMENT', 'run-code requires a function or code string.');
          }
          let fn;
          try {
            const compiled = new Function(`return (${code})`)();
            if (typeof compiled === 'function') fn = compiled;
          } catch {}
          if (!fn) {
            fn = new AsyncFunction('page', code);
          }
          const value = await fn(page);
          return {value: safeJsonValue(value)};
        }

        case 'console': {
          const level = argAt(args, 'level', 0);
          const limit = Number.isSafeInteger(args?.limit) ? Math.max(1, args.limit) : 200;
          const filtered = level ? this.consoleEntries.filter(e => e.type === level) : this.consoleEntries;
          const entries = filtered.slice(-limit);
          if (args?.clear) this.consoleEntries.length = 0;
          return {entries, total: filtered.length};
        }

        case 'network': {
          const filter = argAt(args, 'filter', 0);
          const limit = Number.isSafeInteger(args?.limit) ? Math.max(1, args.limit) : 200;
          const filtered = filter
            ? this.networkEntries.filter(e => e.url.includes(String(filter)))
            : this.networkEntries;
          const entries = filtered.slice(-limit);
          if (args?.clear) this.networkEntries.length = 0;
          return {entries, total: filtered.length};
        }

        case 'dialog': {
          const pending = this.pendingDialogs.shift();
          if (!pending) {
            throw fault(
              'NO_PENDING_DIALOG',
              'No browser dialog is currently open.',
              'Trigger an alert, confirm, or prompt before calling dialog.',
            );
          }
          const mode = argAt(args, 'action', 0);
          const accept =
            args?.accept !== undefined
              ? Boolean(args.accept)
              : mode
                ? mode !== 'dismiss'
                : true;
          const promptText = argAt(args, 'promptText', 1);
          if (accept) {
            await pending.dialog.accept(promptText !== undefined ? String(promptText) : undefined);
          } else {
            await pending.dialog.dismiss();
          }
          return {
            handled: true,
            action: accept ? 'accept' : 'dismiss',
            type: pending.type,
            message: pending.message,
          };
        }
      }
    } catch (error) {
      throw normalizeEngineError(error, actionName, this.focusEmulation);
    }
  }

  /**
   * Capture active page/frame ARIA snapshots, DOM locator observations (matching CAPTURE_SCRIPT),
   * and PNG base64 screenshots for Exploration Library before/after filmstrip.
   */
  async captureState({includeScreenshot = true} = {}) {
    const active = this.ensureActivePage();
    const currentTargetId = await this.identifyPage(active);
    const pages = [];
    let activeScreenshot = null;

    for (const p of this.context.pages()) {
      if (p.isClosed?.()) continue;
      try {
        const targetId = await this.identifyPage(p);
        const opener = typeof p.opener === 'function' ? await p.opener().catch(() => null) : null;
        const openerTargetId = opener ? await this.identifyPage(opener).catch(() => null) : null;
        const frames = [];
        for (const [i, frame] of (p.frames?.() || []).entries()) {
          if (frame === p.mainFrame?.()) continue;
          try {
            const frameSnapshot = await frame.locator('body').ariaSnapshot({mode: 'ai', timeout: 3000});
            const frameDom = await frame.locator(DOM_SELECTOR).evaluateAll(DOM_OBSERVATION_FN);
            frames.push({
              id: `frame-${i}`,
              name: frame.name(),
              url: frame.url(),
              snapshot: redact(frameSnapshot),
              dom: frameDom,
            });
          } catch {
            frames.push({id: `frame-${i}`, url: frame.url(), error: 'Frame snapshot unavailable'});
          }
        }
        const snapshot = await p.ariaSnapshot({mode: 'ai', timeout: 5000});
        this.pageRefs.set(p, parseSnapshotRefs(snapshot));
        const dom = await p.locator(DOM_SELECTOR).evaluateAll(DOM_OBSERVATION_FN);
        const viewport = await p.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          device_scale: window.devicePixelRatio,
        }));
        let screenshot = null;
        if (includeScreenshot) {
          try {
            const buf = await p.screenshot({type: 'png', timeout: 5000});
            screenshot = buf.toString('base64');
            if (p === active) activeScreenshot = screenshot;
          } catch {}
        }
        pages.push({
          targetId,
          openerTargetId,
          viewport,
          url: p.url(),
          title: await p.title().catch(() => ''),
          snapshot: redact(snapshot),
          dom,
          frames,
          ...(screenshot ? {screenshot} : {}),
        });
      } catch {}
    }

    return {
      currentTargetId,
      pages,
      ...(activeScreenshot ? {screenshot: activeScreenshot} : {}),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pendingDialogs.splice(0)) {
      await pending.dialog.dismiss?.().catch(() => {});
    }
    if (this.browser) {
      await this.browser.close?.().catch(() => {});
      this.browser = null;
    }
    this.context = null;
    this.activePage = null;
  }
}
