import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {WebSocket} from 'ws';
import {
  runWithExploration,
  checkpointCommand,
  finishCommand,
  libraryCommand,
} from '../src/exploration.mjs';
import {
  LIMITS,
  PNG_SIGNATURE,
  boundRun,
  loadMeta,
  runPath,
  lockRun,
  ledger,
} from '../src/exploration-storage.mjs';
import {startLibraryServer} from '../src/exploration-library.mjs';
import {BrowserEngine} from '../src/browser-engine.mjs';
import {createRelay} from '../src/native-relay.mjs';
import {fault} from '../extension/protocol.js';

const samplePngBase64 = (byte = 1) =>
  Buffer.concat([
    PNG_SIGNATURE,
    Buffer.from([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, byte]),
  ]).toString('base64');

async function fixture(t, {screenshotError = false} = {}) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latch-life-')));
  const old = {root: process.env.LATCH_ARTIFACT_ROOT, capture: process.env.LATCH_CAPTURE};
  process.env.LATCH_ARTIFACT_ROOT = path.join(workspace, 'library');
  delete process.env.LATCH_CAPTURE;
  t.after(async () => {
    for (const [k, v] of [
      ['LATCH_ARTIFACT_ROOT', old.root],
      ['LATCH_CAPTURE', old.capture],
    ]) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    await fs.rm(workspace, {recursive: true, force: true});
  });

  const calls = [];
  let stepCount = 0;
  const execute = async inv => {
    calls.push(inv);
    if (inv.command === 'open') return {connected: true, created: true, extensionVersion: '1.0.0', playwrightCore: '1.65.1'};
    if (inv.command === 'connect') return {connected: true, extensionVersion: '1.0.0', playwrightCore: '1.65.1'};
    if (inv.command === 'disconnect') return {disconnected: true, preservedUserTabs: true};
    if (inv.command === 'session-capture-state') {
      stepCount++;
      return {
        currentTargetId: 'p',
        ...(screenshotError ? {} : {screenshot: samplePngBase64(stepCount)}),
        pages: [
          {
            targetId: 'p',
            url: `https://fixture/step-${stepCount}`,
            title: `Step ${stepCount}`,
            snapshot: '- textbox "Email" [ref=e1]\n- button "Save" [ref=e2]',
            ...(screenshotError ? {} : {screenshot: samplePngBase64(stepCount)}),
            frames: [],
          },
        ],
      };
    }
    return {result: ''};
  };

  const invoke = (command, extra = {}) =>
    runWithExploration(
      {
        command,
        flags: {workspace, session: 'agent', profile: 'work', ...extra.flags},
        ...(extra.action ? {action: extra.action} : {}),
        ...(extra.actionArgs ? {actionArgs: extra.actionArgs} : {}),
        ...(extra.args ? {args: extra.args} : {}),
        ...(extra.playwrightArgs ? {playwrightArgs: extra.playwrightArgs} : {}),
      },
      '1.0.0',
      execute,
    );

  return {workspace, calls, execute, invoke};
}

test('quick open/connect without --record or --objective skips heavy run allocation', async t => {
  const f = await fixture(t);
  const opened = await f.invoke('open', {flags: {url: 'https://fixture'}});
  assert.equal(opened.connected, true);
  assert.equal(opened.library, undefined);
  assert.equal(await boundRun({workspace: f.workspace, session: 'agent', profile: 'work'}), null);
  assert.equal((await libraryCommand('list', {})).runs.length, 0);

  await f.invoke('click', {action: 'click', actionArgs: {target: 'e2'}});
  assert.equal(f.calls.filter(c => c.command === 'session-capture-state').length, 0);
  await f.invoke('disconnect');
  assert.equal((await libraryCommand('list', {})).runs.length, 0);
});

test('managed --record lifecycle captures before/after filmstrip, secrets scrubbed, and idempotent finish', async t => {
  const f = await fixture(t);
  const start = await f.invoke('open', {flags: {url: 'https://fixture/?token=secret_url_tok', record: true, objective: 'Explore'}});
  assert.ok(start.library.runId);
  assert.equal(start.library.screenshots, 1);

  await f.invoke('fill', {
    action: 'fill',
    actionArgs: {target: 'e1', value: 'private-input'},
    args: ['e1', 'private-input'],
    flags: {'data-ref': 'seeded-user'},
  });
  await f.invoke('click', {
    action: 'click',
    actionArgs: {target: 'e2'},
    args: ['e2'],
  });
  const cp = await checkpointCommand(
    {profile: 'work', session: 'agent', workspace: f.workspace, note: 'Authorization: Bearer cp_secret saved'},
    '1.0.0',
    f.execute,
  );
  assert.equal(cp.checkpoint, true);

  const result = await finishCommand({profile: 'work', session: 'agent', workspace: f.workspace}, '1.0.0', f.execute);
  assert.equal(result.library.integrity, true);
  assert.equal(result.library.cleanup, 'confirmed');
  assert.equal(result.library.status, 'finished');
  assert.ok(result.library.screenshots >= 4);

  const graph = JSON.parse(await fs.readFile(path.join(result.library.directory, 'exploration.json'), 'utf8'));
  assert.equal(graph.transitions.length, 2);
  assert.equal(graph.transitions[0].action.data_reference, 'seeded-user');
  assert.equal(graph.transitions[0].filmstrip.before, 'screenshots/state-00001.png');
  assert.equal(graph.transitions[0].filmstrip.after, 'screenshots/state-00002.png');
  assert.equal(graph.transitions[1].filmstrip.before, 'screenshots/state-00002.png');
  assert.equal(graph.transitions[1].filmstrip.after, 'screenshots/state-00003.png');
  assert.equal(graph.screenshots.status, 'complete');
  assert.equal(graph.filmstrip.length, 2);
  assert.ok(graph.final_states.length);

  for (const rel of ['exploration.json', 'exploration.yaml', 'commands.jsonl', 'events.jsonl']) {
    const content = await fs.readFile(path.join(result.library.directory, rel), 'utf8');
    assert.doesNotMatch(content, /private-input|secret_url_tok|cp_secret/);
  }

  const count = f.calls.length;
  const second = await finishCommand({profile: 'work', session: 'agent', workspace: f.workspace}, '1.0.0', f.execute);
  assert.equal(second.alreadyFinished, true);
  assert.equal(f.calls.length, count);
});

test('missing screenshot capture marks status partial explicitly without inventing images', async t => {
  const f = await fixture(t, {screenshotError: true});
  const start = await f.invoke('open', {flags: {url: 'https://fixture', objective: 'Check partial'}});
  const result = await f.invoke('finish');
  assert.equal(result.library.cleanup, 'confirmed');
  assert.equal(result.library.status, 'partial');
  const m = await loadMeta(start.library.runId);
  assert.ok(m.states.length > 0);
  assert.ok(m.gaps.some(g => g.reason.includes('screenshot unavailable') || g.reason.includes('PNG screenshot unavailable')));
});

test('recording limits stop new application actions while preserving finish capacity and invalid profiles fail early', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('open', {flags: {url: 'https://fixture', record: true, profile: 'bad profile!'}}), {
    code: 'INVALID_PROFILE',
  });
  const start = await f.invoke('open', {flags: {url: 'https://fixture', record: true}});
  const dir = await runPath(start.library.runId);
  const starts = Array.from({length: LIMITS.commands - 2}, (_, i) => ({
    schema: 1,
    event: 'started',
    runId: start.library.runId,
    step: 'step' + i,
    at: new Date().toISOString(),
    command: 'click',
    kind: 'operation',
    argumentCount: 1,
    argumentSHA256: 'a'.repeat(64),
  }));
  await fs.writeFile(path.join(dir, 'commands.jsonl'), starts.map(e => JSON.stringify(e)).join('\n') + '\n');
  const count = f.calls.length;
  await assert.rejects(f.invoke('click', {action: 'click', actionArgs: {target: 'e2'}}), {code: 'EXPLORATION_LIMIT'});
  assert.equal(f.calls.length, count);
});

test('partial command ledger halts further writes and preserves ledger for inspection', async t => {
  const f = await fixture(t);
  const start = await f.invoke('open', {flags: {url: 'https://fixture', record: true}});
  const dir = await runPath(start.library.runId);
  await fs.appendFile(path.join(dir, 'commands.jsonl'), '{"partial":');
  await assert.rejects(f.invoke('click', {action: 'click', actionArgs: {target: 'e2'}}), {code: 'EVIDENCE_LEDGER_PARTIAL'});
  assert.equal((await ledger(dir)).partialTail, true);
});

test('connect with --objective opts into recording and handoff matches exploration.schema.json', async t => {
  const f = await fixture(t);
  const schema = JSON.parse(await fs.readFile(new URL('../src/schemas/exploration.schema.json', import.meta.url), 'utf8'));
  const start = await f.invoke('connect', {flags: {tab: '1', objective: 'Connect recording check'}});
  assert.ok(start.library.runId);
  await f.invoke('click', {action: 'click', actionArgs: {target: 'e2'}});
  const done = await f.invoke('finish');
  const graph = JSON.parse(await fs.readFile(path.join(done.library.directory, 'exploration.json'), 'utf8'));
  for (const key of schema.required) {
    assert.ok(Object.hasOwn(graph, key), `Missing required schema key: ${key}`);
  }
  assert.equal(Object.hasOwn(graph, 'video'), false);
  for (const transition of graph.transitions) {
    for (const key of schema.$defs.transition.required) {
      assert.ok(Object.hasOwn(transition, key), `Missing transition schema key: ${key}`);
    }
  }
  const shown = await libraryCommand('show', {run: done.library.runId});
  assert.equal(shown.integrity.verified, true);
  assert.equal(shown.review.decision, 'unreviewed');
  await libraryCommand('review', {run: done.library.runId, decision: 'automate', note: 'Verified filmstrip'});
  assert.equal((await libraryCommand('show', {run: done.library.runId})).review.decision, 'automate');
});

test('disconnect revokes access despite a busy library writer and records an interruption marker', async t => {
  const f = await fixture(t);
  const start = await f.invoke('open', {flags: {url: 'https://fixture', record: true}});
  let release;
  let entered;
  const ready = new Promise(r => (entered = r));
  const held = lockRun(start.library.runId, () => {
    entered();
    return new Promise(r => (release = r));
  });
  await ready;
  const result = await f.invoke('disconnect');
  assert.equal(result.disconnected, true);
  assert.equal(result.library.status, 'interrupted');
  assert.equal(await boundRun({workspace: f.workspace, session: 'agent', profile: 'work'}), null);
  const marker = JSON.parse(await fs.readFile(path.join(await runPath(start.library.runId), 'stop-request.json')));
  assert.equal(marker.confirmed, true);
  release();
  await held;
});

function findChromeExecutable() {
  const candidates = [];
  for (const envName of ['CHROME_PATH', 'PLAYWRIGHT_CHROME_PATH']) {
    if (process.env[envName]) candidates.push(process.env[envName]);
  }
  const cacheDir =
    process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright');
  return fs
    .readdir(cacheDir)
    .then(async entries => {
      for (const entry of entries.filter(e => e.startsWith('chromium-')).sort().reverse()) {
        const exe =
          process.platform === 'win32'
            ? path.join(cacheDir, entry, 'chrome-win64', 'chrome.exe')
            : process.platform === 'darwin'
              ? path.join(cacheDir, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
              : path.join(cacheDir, entry, 'chrome-linux', 'chrome');
        try {
          await fs.access(exe);
          return exe;
        } catch {}
      }
      for (const c of candidates) {
        try {
          await fs.access(c);
          return c;
        } catch {}
      }
      return chromium.executablePath();
    })
    .catch(() => chromium.executablePath());
}

test('headless Chrome for Testing unified exploration captures real before/after PNG filmstrip and serves interactive UI', async t => {
  let chromeExecutable;
  try {
    chromeExecutable = await findChromeExecutable();
    await fs.access(chromeExecutable);
  } catch {
    t.skip('No Chrome for Testing binary found in ms-playwright cache.');
    return;
  }

  const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latch-filmstrip-cft-')));
  const userDataDir = path.join(tempDir, 'chrome-profile');
  await fs.mkdir(userDataDir, {recursive: true});
  const oldRoot = process.env.LATCH_ARTIFACT_ROOT;
  process.env.LATCH_ARTIFACT_ROOT = path.join(tempDir, 'artifacts');

  const app = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(`<!doctype html>
      <html>
        <head><title>Filmstrip Fixture</title></head>
        <body style="background:#f0f4f1;font-family:sans-serif;padding:24px">
          <h1 id="title">Checkout Form</h1>
          <label for="email">Email</label>
          <input id="email" type="text" />
          <button id="pay" onclick="document.body.style.background='#d9f7be';document.getElementById('status').textContent='Paid: '+document.getElementById('email').value">Pay Now</button>
          <div id="status" role="status">Ready</div>
        </body>
      </html>`);
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;

  // Launch headless Chrome for Testing with a disposable profile (AGENTS.md policy).
  const launchArgs = [
    '--headless=new',
    '--disable-gpu',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
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
  assert.ok(pageTarget);

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
    if (extWs.readyState === WebSocket.OPEN && msg.sessionId) {
      extWs.send(JSON.stringify({method: 'event', params: {source: {tabId: 1}, method: msg.method, params: msg.params}}));
    }
  });
  const preAttach = await cdpCall('Target.attachToTarget', {targetId: pageTarget.id, flatten: true});
  attachedSessionId = preAttach.sessionId;
  await extOpen;
  extWs.on('message', async raw => {
    const req = JSON.parse(raw.toString());
    try {
      if (req.method === 'command') {
        const result = await cdpCall(req.params.method, req.params.params || {}, req.params.sessionId || attachedSessionId);
        extWs.send(JSON.stringify({id: req.id, result}));
      } else {
        extWs.send(JSON.stringify({id: req.id, result: {}}));
      }
    } catch (err) {
      extWs.send(JSON.stringify({id: req.id, error: err.message}));
    }
  });

  let ui;
  t.after(async () => {
    oldRoot === undefined ? delete process.env.LATCH_ARTIFACT_ROOT : (process.env.LATCH_ARTIFACT_ROOT = oldRoot);
    await ui?.close();
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

  const engine = await new BrowserEngine({
    cdpEndpoint: relay.cdpEndpoint,
    sessionKey: 'e'.repeat(64),
    workspace: tempDir,
    session: 'cft-filmstrip',
    tabId: 1,
    focusEmulation: true,
  }).connect();

  const execute = async inv => {
    if (inv.command === 'open') {
      await engine.action('goto', {url: inv.flags.url || origin});
      return {connected: true, created: true, extensionVersion: '1.0.0', playwrightCore: '1.65.1'};
    }
    if (inv.command === 'session-capture-state') {
      return engine.captureState({includeScreenshot: true});
    }
    if (inv.command === 'disconnect') {
      await engine.close();
      return {disconnected: true, preservedUserTabs: true};
    }
    return engine.action(inv.action || inv.command, inv.actionArgs || {});
  };

  const opened = await runWithExploration(
    {command: 'open', flags: {workspace: tempDir, session: 'cft-filmstrip', profile: 'work', url: origin, record: true, objective: 'Real CFT filmstrip'}},
    '1.0.0',
    execute,
  );
  assert.ok(opened.library.runId);
  const initialMeta = await loadMeta(opened.library.runId);
  const emailRef = initialMeta.states[0].elements.find(e => e.role === 'textbox')?.snapshot_ref;
  const payRef = initialMeta.states[0].elements.find(e => e.role === 'button')?.snapshot_ref;
  assert.ok(emailRef && payRef);

  await runWithExploration(
    {
      command: 'fill',
      action: 'fill',
      actionArgs: {target: emailRef, value: 'qa@example.test'},
      flags: {workspace: tempDir, session: 'cft-filmstrip', profile: 'work', 'data-ref': 'qa-email'},
    },
    '1.0.0',
    execute,
  );
  await runWithExploration(
    {
      command: 'click',
      action: 'click',
      actionArgs: {target: payRef},
      flags: {workspace: tempDir, session: 'cft-filmstrip', profile: 'work'},
    },
    '1.0.0',
    execute,
  );
  await checkpointCommand(
    {profile: 'work', session: 'cft-filmstrip', workspace: tempDir, note: 'Paid status rendered after click'},
    '1.0.0',
    execute,
  );
  const done = await finishCommand(
    {profile: 'work', session: 'cft-filmstrip', workspace: tempDir},
    '1.0.0',
    execute,
  );
  assert.equal(done.library.status, 'finished');
  assert.equal(done.library.integrity, true);
  assert.equal(done.library.cleanup, 'confirmed');

  const graph = JSON.parse(await fs.readFile(path.join(done.library.directory, 'exploration.json'), 'utf8'));
  assert.equal(graph.filmstrip.length, 2);
  assert.equal(graph.screenshots.status, 'complete');
  const beforeBytes = await fs.readFile(path.join(done.library.directory, graph.filmstrip[1].before));
  const afterBytes = await fs.readFile(path.join(done.library.directory, graph.filmstrip[1].after));
  assert.ok(beforeBytes.subarray(0, 8).equals(PNG_SIGNATURE));
  assert.ok(afterBytes.subarray(0, 8).equals(PNG_SIGNATURE));
  assert.notDeepEqual(beforeBytes, afterBytes);

  ui = await startLibraryServer();
  const uiHtml = await (await fetch(`${ui.url}/run/${done.library.runId}`)).text();
  assert.match(uiHtml, /Before \/ after filmstrip/);
  assert.match(uiHtml, new RegExp(graph.filmstrip[1].after.replace('/', '\\/')));
  const imgResp = await fetch(`${ui.url}/artifact/${done.library.runId}/${graph.filmstrip[1].after}`);
  assert.equal(imgResp.status, 200);
  assert.equal(imgResp.headers.get('content-type'), 'image/png');
});

test('redacted fill/type input is an informational notice: clean runs finish as "finished" without persisting values', async t => {
  const f = await fixture(t);
  const start = await f.invoke('open', {flags: {url: 'https://fixture', record: true, objective: 'Notice'}});
  await f.invoke('fill', {action: 'fill', actionArgs: {target: 'e1', value: 'typed-private-value'}, args: ['e1', 'typed-private-value']});
  await f.invoke('type', {action: 'type', actionArgs: {target: 'e1', text: 'more-private-text'}, args: ['e1', 'more-private-text']});
  const result = await finishCommand({profile: 'work', session: 'agent', workspace: f.workspace}, '1.0.0', f.execute);
  assert.equal(result.library.status, 'finished');

  const meta = await loadMeta(start.library.runId);
  assert.equal(meta.gaps.length, 0);
  assert.equal(meta.notices.length, 2);
  assert.ok(meta.notices.every(n => n.code === 'INPUT_REDACTED' && /Input values are omitted/.test(n.reason)));

  const graph = JSON.parse(await fs.readFile(path.join(result.library.directory, 'exploration.json'), 'utf8'));
  assert.equal(graph.status, 'finished');
  assert.equal(graph.coverage.gaps.length, 0);
  assert.equal(graph.coverage.notices.length, 2);
  const yamlText = await fs.readFile(path.join(result.library.directory, 'exploration.yaml'), 'utf8');
  assert.match(yamlText, /Input values are omitted/);
  for (const rel of ['exploration.json', 'exploration.yaml', 'commands.jsonl', 'events.jsonl']) {
    const content = await fs.readFile(path.join(result.library.directory, rel), 'utf8');
    assert.doesNotMatch(content, /typed-private-value|more-private-text/);
  }
});

test('real capture gaps still mark a run partial even when redaction notices are present', async t => {
  const f = await fixture(t, {screenshotError: true});
  const start = await f.invoke('open', {flags: {url: 'https://fixture', record: true}});
  await f.invoke('fill', {action: 'fill', actionArgs: {target: 'e1', value: 'x'}, args: ['e1', 'x']});
  const result = await f.invoke('finish');
  assert.equal(result.library.status, 'partial');
  const meta = await loadMeta(start.library.runId);
  assert.ok(meta.gaps.some(g => /PNG screenshot unavailable/.test(g.reason)));
  assert.equal(meta.notices.length, 1);
});

test('runs saved before notices existed still load with an empty notices list', async t => {
  const f = await fixture(t);
  const start = await f.invoke('open', {flags: {url: 'https://fixture', record: true}});
  const metaFile = path.join(process.env.LATCH_ARTIFACT_ROOT, 'meta', start.library.runId + '.json');
  const legacy = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  delete legacy.notices;
  await fs.writeFile(metaFile, JSON.stringify(legacy));
  const meta = await loadMeta(start.library.runId);
  assert.deepEqual(meta.notices, []);
  const result = await f.invoke('finish');
  assert.equal(result.library.status, 'finished');
});

test('finish --close-tabs forwards closeTabs to disconnect for recorded runs; plain finish does not', async t => {
  const f = await fixture(t);
  await f.invoke('open', {flags: {url: 'https://fixture', record: true}});
  await finishCommand({profile: 'work', session: 'agent', workspace: f.workspace, closeTabs: true}, '1.0.0', f.execute);
  const closing = f.calls.filter(c => c.command === 'disconnect');
  assert.equal(closing.at(-1).flags['close-tabs'], true);

  const g = await fixture(t);
  await g.invoke('open', {flags: {url: 'https://fixture', record: true}});
  await finishCommand({profile: 'work', session: 'agent', workspace: g.workspace}, '1.0.0', g.execute);
  assert.equal(g.calls.filter(c => c.command === 'disconnect').at(-1).flags['close-tabs'], undefined);
});

test('finish waits briefly for a just-finished command lock instead of reporting interrupted', async t => {
  const f = await fixture(t);
  const start = await f.invoke('open', {flags: {url: 'https://fixture', record: true}});
  let entered;
  const ready = new Promise(r => (entered = r));
  const held = lockRun(start.library.runId, async () => {
    entered();
    await new Promise(r => setTimeout(r, 200));
  });
  await ready;
  const result = await f.invoke('finish');
  await held;
  assert.equal(result.library.status, 'finished');
  assert.equal(result.library.cleanup, 'confirmed');
});
