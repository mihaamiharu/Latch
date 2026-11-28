import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {WebSocket} from 'ws';
import {BrowserEngine, parseSnapshotRefs, screenshotWithNudges} from '../src/browser-engine.mjs';
import {createRelay} from '../src/native-relay.mjs';
import {encode, decoder} from '../src/framing.mjs';
import {request, socketPath} from '../src/local.mjs';
import {ACTIONS, OPERATIONS, checkRequest} from '../extension/protocol.js';

function createMockPlaywright() {
  const calls = [];
  let pageClosed = false;
  let dialogHandler = null;
  let consoleHandler = null;
  let requestHandler = null;
  let responseHandler = null;
  let currentUrl = 'https://fixture.test/start';
  let currentTitle = 'Fixture Start';

  const makeLocator = selector => ({
    async click(opts) {
      calls.push(['click', selector, opts]);
    },
    async dblclick(opts) {
      calls.push(['dblclick', selector, opts]);
    },
    async fill(val, opts) {
      calls.push(['fill', selector, val, opts]);
    },
    async pressSequentially(val, opts) {
      calls.push(['type', selector, val, opts]);
    },
    async press(key, opts) {
      calls.push(['press', selector, key, opts]);
    },
    async hover(opts) {
      calls.push(['hover', selector, opts]);
    },
    async selectOption(vals, opts) {
      calls.push(['select', selector, vals, opts]);
      return Array.isArray(vals) ? vals : [vals];
    },
    async check(opts) {
      calls.push(['check', selector, opts]);
    },
    async uncheck(opts) {
      calls.push(['uncheck', selector, opts]);
    },
    async setInputFiles(files, opts) {
      calls.push(['upload', selector, files, opts]);
    },
    async screenshot(opts) {
      calls.push(['element-screenshot', selector, opts]);
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]);
    },
    async ariaSnapshot(opts) {
      calls.push(['locator-ariaSnapshot', selector, opts]);
      return '- textbox "Email" [ref=e1]\n- button "Save" [ref=e2]';
    },
    async evaluate(fn, arg) {
      calls.push(['locator-evaluate', selector, arg]);
      return fn({tagName: 'BUTTON'}, arg);
    },
    async evaluateAll() {
      return {total: 1, nodes: [{tag: 'button', id: 'save', test_id: null, test_id_attribute: null, name: null, role: 'button', label: 'Save', input_type: null}]};
    },
  });

  const page = {
    isClosed: () => pageClosed,
    url: () => currentUrl,
    title: async () => currentTitle,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, childFrame],
    context: () => context,
    locator: sel => makeLocator(sel),
    frameLocator: fSel => ({
      locator: sel => makeLocator(`${fSel} >> ${sel}`),
    }),
    on(event, fn) {
      if (event === 'dialog') dialogHandler = fn;
      if (event === 'console') consoleHandler = fn;
      if (event === 'request') requestHandler = fn;
      if (event === 'response') responseHandler = fn;
    },
    async ariaSnapshot(opts) {
      calls.push(['ariaSnapshot', opts]);
      return '- textbox "Email" [ref=e1]\n- button "Save" [ref=e2]\n- iframe [ref=e3]:\n  - button "Inner" [ref=f1e1]';
    },
    async screenshot(opts) {
      calls.push(['screenshot', opts]);
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    },
    async goto(url, opts) {
      calls.push(['goto', url, opts]);
      currentUrl = url;
      currentTitle = 'Navigated';
    },
    async goBack(opts) {
      calls.push(['back', opts]);
      currentUrl = 'https://fixture.test/back';
    },
    async goForward(opts) {
      calls.push(['forward', opts]);
      currentUrl = 'https://fixture.test/forward';
    },
    async reload(opts) {
      calls.push(['reload', opts]);
    },
    async evaluate(fn, arg) {
      calls.push(['evaluate', arg]);
      if (arg === undefined) return {width: 1280, height: 720, device_scale: 1};
      return `eval:${arg}`;
    },
    keyboard: {
      type: async (text, opts) => calls.push(['keyboard-type', text, opts]),
      press: async key => calls.push(['keyboard-press', key]),
    },
    opener: async () => null,
  };

  const mainFrame = {name: () => '', url: () => currentUrl, locator: sel => makeLocator(sel)};
  const childFrame = {name: () => 'sub', url: () => 'https://fixture.test/frame', locator: sel => makeLocator(`frame:${sel}`)};

  const context = {
    pages: () => [page],
    on() {},
    newCDPSession: async () => ({
      send: async () => ({targetInfo: {targetId: 'target-1'}}),
      detach: async () => {},
    }),
  };

  const browser = {
    contexts: () => [context],
    on() {},
    close: async () => {
      calls.push(['browser-close']);
    },
  };

  return {
    calls,
    page,
    browser,
    emitDialog: (type, message) => {
      const d = {
        type: () => type,
        message: () => message,
        defaultValue: () => '',
        accept: async text => calls.push(['dialog-accept', text]),
        dismiss: async () => calls.push(['dialog-dismiss']),
      };
      dialogHandler?.(d);
    },
    emitConsole: (type, text) => consoleHandler?.({type: () => type, text: () => text, location: () => null}),
    emitRequest: url => requestHandler?.({method: () => 'GET', url: () => url, resourceType: () => 'fetch'}),
    emitResponse: (url, status) =>
      responseHandler?.({
        url: () => url,
        status: () => status,
        ok: () => status < 400,
        request: () => ({method: () => 'GET', resourceType: () => 'fetch'}),
      }),
    markClosed: () => {
      pageClosed = true;
    },
  };
}

test('locked protocol enforces exact operations and actions', () => {
  assert.deepEqual(
    [...OPERATIONS].sort(),
    [
      'session-action',
      'session-capture-state',
      'session-connect',
      'session-disconnect',
      'session-list',
      'session-open',
      'session-release',
      'status',
      'tabs',
    ],
  );
  assert.equal(ACTIONS.size, 21);
  assert.throws(() => checkRequest({v: 1, id: '1', op: 'native-connect', payload: {}}), {code: 'INVALID_REQUEST'});
  assert.throws(() => checkRequest({v: 1, id: '1', op: 'native-operation', payload: {}}), {code: 'INVALID_REQUEST'});
  assert.ok(checkRequest({v: 1, id: '1', op: 'session-action', payload: {}}));
});

test('BrowserEngine executes all 21 actions, tracks refs/dialogs/console/network, redacts secrets, and captures state', async () => {
  const mock = createMockPlaywright();
  const engine = new BrowserEngine({
    cdpEndpoint: 'ws://127.0.0.1:9999/cdp/' + 'a'.repeat(64),
    sessionKey: 'b'.repeat(64),
    workspace: process.cwd(),
    session: 'unit',
    tabId: 1,
    focusEmulation: true,
    connectOverCDP: async () => mock.browser,
  });
  await engine.connect();

  // Ref before snapshot fails fast with SNAPSHOT_REQUIRED
  await assert.rejects(engine.action('click', {ref: 'e1'}), {code: 'SNAPSHOT_REQUIRED'});

  const snap = await engine.action('snapshot', {});
  assert.equal(snap.refCount, 4);
  assert.ok(parseSnapshotRefs(snap.snapshot).has('f1e1'));

  await assert.rejects(engine.action('click', {ref: 'e999'}), {code: 'REF_NOT_FOUND'});

  await engine.action('click', {ref: 'e2'});
  await engine.action('dblclick', {ref: 'e2'});
  await engine.action('fill', {ref: 'e1', value: 'hello'});
  await engine.action('type', {ref: 'e1', text: 'world'});
  await engine.action('press', {ref: 'e1', key: 'Enter'});
  await engine.action('hover', {ref: 'e2'});
  await engine.action('select', {selector: '#country', values: 'id'});
  await engine.action('check', {selector: '#agree'});
  await engine.action('uncheck', {selector: '#agree'});
  await engine.action('upload', {selector: '#file', files: ['package.json']});
  await engine.action('click', {ref: 'f1e1'});

  const shot = await engine.action('screenshot', {fullPage: true});
  assert.equal(shot.mimeType, 'image/png');
  assert.ok(Buffer.from(shot.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  const nav = await engine.action('goto', {url: 'https://fixture.test/next'});
  assert.equal(nav.url, 'https://fixture.test/next');
  await assert.rejects(engine.action('goto', {url: 'javascript:alert(1)'}), {code: 'INVALID_ARGUMENT'});
  assert.equal((await engine.action('back', {})).url, 'https://fixture.test/back');
  assert.equal((await engine.action('forward', {})).url, 'https://fixture.test/forward');
  await engine.action('reload', {});

  const ev = await engine.action('eval', {expression: '1 + 1'});
  assert.ok(ev.value);
  const rc = await engine.action('run-code', {code: 'async(page)=>page.url()'});
  assert.equal(rc.value, 'https://fixture.test/forward');

  mock.emitConsole('log', 'ok ws://127.0.0.1:1/cdp/' + 'c'.repeat(64));
  const con = await engine.action('console', {});
  assert.equal(con.entries.length, 1);
  assert.doesNotMatch(con.entries[0].text, /127\.0\.0\.1/);

  mock.emitRequest('https://fixture.test/api?token=secret123');
  mock.emitResponse('https://fixture.test/api?token=secret123', 200);
  const netLog = await engine.action('network', {});
  assert.equal(netLog.entries.length, 2);
  assert.doesNotMatch(JSON.stringify(netLog), /secret123/);

  await assert.rejects(engine.action('dialog', {action: 'accept'}), {code: 'NO_PENDING_DIALOG'});
  mock.emitDialog('prompt', 'Name?');
  const dlg = await engine.action('dialog', {action: 'accept', promptText: 'Alice'});
  assert.equal(dlg.handled, true);
  assert.equal(dlg.action, 'accept');

  const captured = await engine.captureState({includeScreenshot: true});
  assert.equal(captured.currentTargetId, 'target-1');
  assert.equal(captured.pages.length, 1);
  assert.equal(captured.pages[0].frames.length, 1);
  assert.ok(captured.screenshot);

  await engine.close();
  assert.ok(mock.calls.some(c => c[0] === 'browser-close'));
});

test('native-host accepts only locked IPC operations and cleanly rejects legacy internal ops on socket', async t => {
  const runtime = path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `latch-nh-${crypto.randomBytes(5).toString('hex')}`);
  await fs.mkdir(runtime, {mode: 0o700});
  const oldRuntime = process.env.LATCH_RUNTIME_DIR;
  process.env.LATCH_RUNTIME_DIR = runtime;

  const instanceId = crypto.randomUUID();
  const epoch = crypto.randomUUID();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/native-host.mjs', import.meta.url))], {
    env: {...process.env},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => (stderr += d));
  const consume = decoder(msg => {
    if (msg.type === 'request') {
      if (msg.op === 'status') {
        child.stdin.write(encode({v: 1, id: msg.id, ok: true, result: {sessions: []}}));
      } else if (msg.op === 'tabs') {
        child.stdin.write(encode({v: 1, id: msg.id, ok: true, result: [{tabId: 1, url: 'https://fixture.test/'}]}));
      } else {
        child.stdin.write(encode({v: 1, id: msg.id, ok: false, error: {code: 'DEBUGGER_PERMISSION_REQUIRED', message: 'mock'}}));
      }
    }
  });
  child.stdout.on('data', consume);
  const exited = new Promise(resolve => child.once('exit', resolve));

  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    oldRuntime === undefined ? delete process.env.LATCH_RUNTIME_DIR : (process.env.LATCH_RUNTIME_DIR = oldRuntime);
    await fs.rm(runtime, {recursive: true, force: true});
  });

  child.stdin.write(
    encode({
      v: 1,
      type: 'hello',
      instanceId,
      epoch,
      extensionVersion: '1.0.0',
      capabilities: {nativeTransport: false},
    }),
  );

  const addr = socketPath(instanceId);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      await fs.stat(addr);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 20));
    }
  }

  const st = await request(instanceId, 'status');
  assert.equal(st.instanceId, instanceId);
  assert.equal(st.activeSessions, 0);
  const tabs = await request(instanceId, 'tabs');
  assert.equal(tabs[0].tabId, 1);

  await assert.rejects(request(instanceId, 'native-connect', {instanceId, epoch}), {code: 'INVALID_REQUEST'});
  await assert.rejects(request(instanceId, 'native-operation', {instanceId, epoch}), {code: 'INVALID_REQUEST'});
  await assert.rejects(request(instanceId, 'session-list', {instanceId, epoch}), {code: 'NATIVE_TRANSPORT_UNAVAILABLE'});

  child.stdin.end();
  assert.equal(await exited, 0, stderr);
});

async function findChromeForTesting() {
  if (process.env.LATCH_CHROME) return process.env.LATCH_CHROME;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cacheDir =
    process.platform === 'win32'
      ? path.join(localAppData, 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
        : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
  const entries = await fs.readdir(cacheDir).catch(() => []);
  const dirs = entries.filter(e => e.startsWith('chromium-')).sort().reverse();
  for (const dir of dirs) {
    const rel =
      process.platform === 'win32'
        ? 'chrome-win64/chrome.exe'
        : process.platform === 'linux'
          ? 'chrome-linux/chrome'
          : 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    const candidate = path.join(cacheDir, dir, rel);
    const ok = await fs.access(candidate).then(() => true, () => false);
    if (ok) return candidate;
  }
  return null;
}

const chromeExecutable = await findChromeForTesting();

test(
  'headless Chrome for Testing integration via in-process CDP relay and BrowserEngine (disposable profile)',
  {skip: !chromeExecutable, timeout: 60000},
  async t => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-cft-'));
    const userDataDir = path.join(tempDir, 'disposable-profile');
    const uploadFile = path.join(tempDir, 'sample-upload.txt');
    await fs.writeFile(uploadFile, 'latch-upload-content');

    const app = http.createServer((req, res) => {
      if (req.url === '/iframe.html') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html><body><button id="frame-btn" onclick="window.__clicked=(window.__clicked||0)+1;this.textContent=\'Frame Clicked\'">Inside Frame</button></body></html>');
        return;
      }
      if (req.url === '/popup.html') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html><title>Popup Page</title><body><h1 id="popup-heading">Popup Loaded</h1></body></html>');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`<!doctype html>
        <html>
          <head><title>Latch Phase 3 Fixture</title></head>
          <body>
            <label for="name">Name</label>
            <input id="name" type="text" />
            <label for="agree"><input id="agree" type="checkbox" /> Agree</label>
            <label for="role">Role</label>
            <select id="role"><option value="dev">Developer</option><option value="qa">QA</option></select>
            <label for="file">Upload</label>
            <input id="file" type="file" />
            <button id="submit" onclick="document.getElementById('out').textContent=document.getElementById('name').value + ':' + document.getElementById('role').value + ':' + document.getElementById('agree').checked">Submit</button>
            <button id="open-popup" onclick="window.open('/popup.html','pop')">Open Popup</button>
            <button id="trigger-dialog" onclick="window.__dlg=confirm('Proceed?')">Ask Dialog</button>
            <div id="out"></div>
            <iframe id="sub" src="/iframe.html"></iframe>
          </body>
        </html>`);
    });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const appOrigin = `http://127.0.0.1:${app.address().port}`;

    // Launch headless Chrome for Testing with a disposable profile (never touching installed Work Chrome).
    const launchArgs = [
      '--headless=new',
      '--disable-gpu',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      'about:blank',
    ];
    const browserProc = spawn(chromeExecutable, launchArgs, {stdio: ['ignore', 'pipe', 'pipe']});
    let stderrText = '';
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome DevTools URL timeout: ${stderrText}`)), 15000);
      browserProc.stderr.on('data', chunk => {
        stderrText += chunk.toString();
        const match = stderrText.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      browserProc.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited early (${code}): ${stderrText}`));
      });
    });

    // Bridge real Chrome's page target CDP directly to Latch's in-process createRelay extension endpoint.
    const extensionId = 'dlkpkeiejlgggeoibejpoajedoelfcli';
    const relay = await createRelay(extensionId, {expectedTabId: 1});
    const listUrl = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list');
    let pageTarget;
    for (let attempt = 0; attempt < 50; attempt++) {
      const targetsJson = await (await fetch(listUrl)).json();
      pageTarget = targetsJson.find(tgt => tgt.type === 'page');
      if (pageTarget) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(pageTarget, 'Expected initial fixture page target');

    const chromeWs = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      chromeWs.once('open', resolve);
      chromeWs.once('error', reject);
    });
    let cdpSeq = 0;
    const cdpPending = new Map();
    let attachedSessionId;
    const extWs = new WebSocket(relay.extensionEndpoint, {origin: `chrome-extension://${extensionId}`});
    const extOpen = new Promise((resolve, reject) => {
      extWs.once('open', resolve);
      extWs.once('error', reject);
    });
    const childToTab = new Map();
    const tabToSession = new Map();
    let nextTabId = 1;

    const cdpCall = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++cdpSeq;
        cdpPending.set(id, {resolve, reject});
        chromeWs.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
      });

    chromeWs.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id) {
        const p = cdpPending.get(msg.id);
        if (p) {
          cdpPending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
        return;
      }
      if (extWs.readyState === WebSocket.OPEN) {
        if (
          msg.method === 'Target.attachedToTarget' &&
          msg.params?.targetInfo?.type === 'page' &&
          msg.params?.targetInfo?.targetId !== pageTarget.id
        ) {
          const popupTabId = ++nextTabId;
          childToTab.set(msg.params.sessionId, popupTabId);
          tabToSession.set(popupTabId, msg.params.sessionId);
          extWs.send(
            JSON.stringify({
              method: 'tab-created',
              params: {id: popupTabId, url: msg.params.targetInfo.url || 'about:blank', openerTabId: 1},
            }),
          );
          return;
        }
        if (msg.sessionId) {
          const tabId = msg.sessionId === attachedSessionId ? 1 : childToTab.get(msg.sessionId) || 1;
          const source =
            msg.sessionId === attachedSessionId || childToTab.has(msg.sessionId)
              ? {tabId}
              : {tabId: 1, sessionId: msg.sessionId};
          extWs.send(JSON.stringify({method: 'event', params: {source, method: msg.method, params: msg.params}}));
        }
      }
    });

    // Wait until the initial fixture page has committed its frame tree URL
    const preAttach = await cdpCall('Target.attachToTarget', {targetId: pageTarget.id, flatten: true});
    attachedSessionId = preAttach.sessionId;
    tabToSession.set(1, attachedSessionId);
    await cdpCall('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    for (let attempt = 0; attempt < 20; attempt++) {
      const tree = await cdpCall('Page.getFrameTree', {}, attachedSessionId);
      if (tree?.frameTree?.frame?.url) break;
      await new Promise(r => setTimeout(r, 50));
    }

    await extOpen;
    extWs.on('message', async raw => {
      const req = JSON.parse(raw.toString());
      try {
        if (req.method === 'attach') {
          if (req.params.tabId === 1 && !attachedSessionId) {
            const attached = await cdpCall('Target.attachToTarget', {targetId: pageTarget.id, flatten: true});
            attachedSessionId = attached.sessionId;
            tabToSession.set(1, attachedSessionId);
          }
          extWs.send(JSON.stringify({id: req.id, result: {}}));
        } else if (req.method === 'command') {
          const sid = req.params.sessionId || tabToSession.get(req.params.tabId) || attachedSessionId;
          const result = await cdpCall(req.params.method, req.params.params || {}, sid);
          extWs.send(JSON.stringify({id: req.id, result}));
        } else {
          extWs.send(JSON.stringify({id: req.id, result: {}}));
        }
      } catch (err) {
        extWs.send(JSON.stringify({id: req.id, error: err.message}));
      }
    });

    t.after(async () => {
      extWs.close();
      chromeWs.close();
      await relay.stop();
      const exited = new Promise(resolve => browserProc.once('exit', resolve));
      if (browserProc.exitCode === null) {
        if (process.platform === 'win32' && browserProc.pid) {
          spawn('taskkill', ['/F', '/T', '/PID', String(browserProc.pid)], {stdio: 'ignore'});
        } else {
          browserProc.kill('SIGKILL');
        }
      }
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]).catch(() => {});
      app.closeAllConnections();
      app.close();
      await fs.rm(tempDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}).catch(() => {});
    });

    extWs.send(JSON.stringify({method: 'ready', params: {id: 1, url: pageTarget.url, title: pageTarget.title}}));
    await relay.ready;

    // Connect real playwright-core BrowserEngine over Latch's in-process relay CDP endpoint
    const engine = await new BrowserEngine({
      cdpEndpoint: relay.cdpEndpoint,
      sessionKey: 'd'.repeat(64),
      workspace: tempDir,
      session: 'cft-real',
      tabId: 1,
      focusEmulation: true,
    }).connect();

    await engine.action('goto', {url: appOrigin + '/'});
    const snap = await engine.action('snapshot', {});
    assert.ok(snap.refCount >= 5);
    const nameRef = snap.refs.find(r => r.role === 'textbox' && r.name === 'Name')?.ref;
    const agreeRef = snap.refs.find(r => r.role === 'checkbox')?.ref;
    const roleRef = snap.refs.find(r => r.role === 'combobox')?.ref;
    const submitRef = snap.refs.find(r => r.role === 'button' && r.name === 'Submit')?.ref;
    const frameBtnRef = snap.refs.find(r => r.role === 'button' && r.name === 'Inside Frame')?.ref;
    assert.ok(nameRef && agreeRef && roleRef && submitRef && frameBtnRef, 'Expected ARIA refs including iframe ref');

    await engine.action('fill', {ref: nameRef, value: 'LatchUser'});
    await engine.action('check', {ref: agreeRef});
    await engine.action('select', {ref: roleRef, values: 'qa'});
    await engine.action('upload', {selector: '#file', files: [uploadFile]});
    await engine.action('click', {ref: submitRef});
    const out = await engine.action('eval', {expression: 'document.getElementById("out").textContent'});
    assert.equal(out.value, 'LatchUser:qa:true');

    // Ref inside iframe
    await engine.action('click', {ref: frameBtnRef});
    const frameClicked = await engine.action('run-code', {
      code: 'async(page)=>page.frameLocator("#sub").locator("#frame-btn").textContent()',
    });
    assert.equal(frameClicked.value, 'Frame Clicked');

    // Dialog handling
    await engine.action('eval', {expression: 'setTimeout(() => { window.__dlg = confirm("Proceed?"); }, 30)'});
    for (let attempt = 0; attempt < 30 && !engine.pendingDialogs.length; attempt++) {
      await new Promise(r => setTimeout(r, 25));
    }
    const dlg = await engine.action('dialog', {action: 'accept'});
    assert.equal(dlg.handled, true);
    assert.equal(dlg.action, 'accept');
    const dlgOutcome = await engine.action('eval', {expression: 'window.__dlg'});
    assert.equal(dlgOutcome.value, true);

    // Popup handling via relay tab-created
    await engine.action('click', {selector: '#open-popup'});
    for (let attempt = 0; attempt < 40 && engine.context.pages().length < 2; attempt++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(engine.context.pages().length, 2, 'Expected popup page attached via relay');

    // Capture state (ARIA snapshots + DOM observations + PNG base64)
    const state = await engine.captureState({includeScreenshot: true});
    assert.equal(state.pages.length, 2);
    assert.ok(state.pages[0].frames.length >= 1);
    assert.ok(state.screenshot);
    assert.ok(Buffer.from(state.screenshot, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

    // Clean disconnect preserves the user's open Chrome page
    await engine.close();
    const afterTargets = await (await fetch(wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
    assert.ok(afterTargets.some(tgt => tgt.id === pageTarget.id), 'Disconnect must preserve user tab');
  },
);

function fakeScreenshotPage({primary, raw}) {
  const calls = {raw: 0, detached: 0};
  return {
    calls,
    screenshot: () => primary(calls),
    context: () => ({
      newCDPSession: async () => ({
        send: async () => {
          calls.raw += 1;
          return raw(calls);
        },
        detach: async () => {
          calls.detached += 1;
        },
      }),
    }),
  };
}

test('screenshotWithNudges returns a fast capture without nudging', async () => {
  const page = fakeScreenshotPage({primary: async () => Buffer.from('pw'), raw: () => ({data: ''})});
  const shot = await screenshotWithNudges(page, {nudgeDelays: [20, 20]});
  assert.equal(shot.toString(), 'pw');
  assert.equal(page.calls.raw, 0);
});

test('screenshotWithNudges nudges a stalled capture and keeps the Playwright image', async () => {
  let release;
  const stalled = new Promise(resolve => (release = resolve));
  const page = fakeScreenshotPage({
    primary: () => stalled,
    raw: () => {
      release(Buffer.from('pw'));
      return {data: Buffer.from('raw').toString('base64')};
    },
  });
  const shot = await screenshotWithNudges(page, {nudgeDelays: [20, 20, 20]});
  assert.equal(shot.toString(), 'pw', 'Playwright image wins once the nudge unblocks it');
  assert.equal(page.calls.raw, 1, 'Stops nudging once the primary capture settles');
  assert.equal(page.calls.detached, 1, 'Nudge sessions are detached');
});

test('screenshotWithNudges falls back to a nudge image when Playwright fails', async () => {
  const page = fakeScreenshotPage({
    primary: () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 100ms exceeded')), 100)),
    raw: () => ({data: Buffer.from('raw').toString('base64')}),
  });
  const shot = await screenshotWithNudges(page, {timeout: 100, nudgeDelays: [20]});
  assert.equal(shot.toString(), 'raw');
});

test('screenshotWithNudges returns null when nothing can be captured', async () => {
  const page = fakeScreenshotPage({
    primary: () => Promise.reject(new Error('closed')),
    raw: () => {
      throw new Error('closed');
    },
  });
  assert.equal(await screenshotWithNudges(page, {nudgeDelays: [20]}), null);
});
