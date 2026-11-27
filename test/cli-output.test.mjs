import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {redact, cliError, resultValue, workspaceAt, sessionKey} from '../src/redact.mjs';
import {linkDirectory} from '../src/platform.mjs';
import {
  parseArgs,
  resolveProfile,
  resolveSession,
  executeCLI,
  runCLI,
  formatResult,
  formatError,
  SNAPSHOT_INLINE_LIMIT,
} from '../src/cli.mjs';
import {fault} from '../extension/protocol.js';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('redact and cliError scrub endpoints, tokens, and retain hints and bounded diagnostics', () => {
  const secret =
    'Connection failed ws://127.0.0.1:123/cdp/' +
    'a'.repeat(64) +
    ' https://x.test/?token=secret-token&access_token=tok2 PLAYWRIGHT_MCP_EXTENSION_TOKEN=secret-env';
  const cleaned = redact(secret);
  assert.doesNotMatch(cleaned, /secret-token|secret-env|tok2|ws:\/\/|127\.0\.0\.1/);
  assert.match(cleaned, /\[endpoint redacted\]/);
  assert.match(cleaned, /\[redacted\]/);

  const err = Object.assign(
    fault('ACTION_TIMEOUT', secret, 'Check ws://127.0.0.1:999/extension/' + 'b'.repeat(64)),
    {diagnostics: {action: 'click', elapsedMs: 120}},
  );
  const formatted = cliError(err);
  assert.equal(formatted.code, 'ACTION_TIMEOUT');
  assert.equal(formatted.diagnostics.action, 'click');
  assert.doesNotMatch(JSON.stringify(formatted), /secret|ws:\/\/|127\.0\.0\.1/);
  assert.match(formatted.hint, /\[endpoint redacted\]/);
});

test('resultValue unwraps JSON strings and direct values consistently', () => {
  assert.deepEqual(resultValue({result: '{"ok":1}'}), {ok: 1});
  assert.equal(resultValue({result: 'plain-text'}), 'plain-text');
  assert.deepEqual(resultValue({value: {nested: true}}), {nested: true});
});

test('workspaceAt and sessionKey produce deterministic canonical hashes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-ws-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const real = await workspaceAt(dir);
  assert.equal(real, await fs.realpath(dir));
  const k1 = sessionKey(real, 'agent');
  const k2 = sessionKey(real, 'agent');
  const k3 = sessionKey(real, 'other');
  assert.match(k1, /^[a-f0-9]{64}$/);
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test('CLI emits concise text by default and structured JSON with --json for version and errors', async () => {
  const defaultVer = await exec(process.execPath, [cliEntry, '--version']);
  assert.match(defaultVer.stdout, /^latch \d+\.\d+\.\d+/);

  const jsonVer = await exec(process.execPath, [cliEntry, '--version', '--json']);
  const parsed = JSON.parse(jsonVer.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nativeSessionSchema, 4);
  assert.ok(parsed.playwrightCore);

  await assert.rejects(exec(process.execPath, [cliEntry, 'unknown-cmd', '--json']), e => {
    const err = JSON.parse(e.stderr);
    assert.equal(err.ok, false);
    assert.equal(err.error.code, 'INVALID_COMMAND');
    assert.ok(err.error.hint);
    return true;
  });

  await assert.rejects(exec(process.execPath, [cliEntry, 'unknown-cmd']), e => {
    assert.match(e.stderr, /Error \[INVALID_COMMAND\]/);
    assert.match(e.stderr, /Hint:/);
    return true;
  });
});

test('parseArgs handles full locked flat CLI surface and global flag positions', () => {
  // Lifecycle
  assert.equal(parseArgs(['tabs']).command, 'tabs');
  assert.deepEqual(
    parseArgs(['open', 'https://example.com', '--record', '--objective', 'Login flow', '--environment', 'staging', '--focus-emulation', 'off']),
    {
      command: 'open',
      flags: {url: 'https://example.com', record: true, objective: 'Login flow', environment: 'staging', 'focus-emulation': 'off'},
      args: ['https://example.com'],
      action: null,
      actionArgs: null,
    },
  );
  assert.equal(parseArgs(['connect', '42', '--record']).flags.tab, 42);
  assert.equal(parseArgs(['sessions']).command, 'sessions');
  assert.equal(parseArgs(['release']).flags.tab, undefined);
  assert.equal(parseArgs(['release', '12']).flags.tab, 12);
  assert.equal(parseArgs(['disconnect']).command, 'disconnect');
  assert.equal(parseArgs(['finish']).command, 'finish');
  assert.equal(parseArgs(['finish', '--close-tabs']).flags['close-tabs'], true);
  assert.equal(parseArgs(['disconnect', '--close-tabs']).flags['close-tabs'], true);
  assert.equal(parseArgs(['finish']).flags['close-tabs'], undefined);
  assert.throws(() => parseArgs(['open', 'https://example.com', '--close-tabs']));
  assert.throws(() => parseArgs(['release', '--close-tabs']));
  assert.throws(() => parseArgs(['finish', '--close-tabs=yes']));

  // Actions
  assert.deepEqual(parseArgs(['snapshot', '#main', '--depth', '3']).actionArgs, {selector: '#main', depth: 3});
  assert.deepEqual(parseArgs(['click', 'e1']).actionArgs, {target: 'e1'});
  assert.deepEqual(parseArgs(['dblclick', 'e2']).actionArgs, {target: 'e2'});
  assert.deepEqual(parseArgs(['fill', 'e3', 'hello']).actionArgs, {target: 'e3', value: 'hello'});
  assert.deepEqual(parseArgs(['fill', 'e3', '']).actionArgs, {target: 'e3', value: ''});
  assert.deepEqual(parseArgs(['type', 'hello']).actionArgs, {text: 'hello'});
  assert.deepEqual(parseArgs(['type', 'e4', 'hello']).actionArgs, {target: 'e4', text: 'hello'});
  assert.deepEqual(parseArgs(['press', 'Enter']).actionArgs, {key: 'Enter'});
  assert.deepEqual(parseArgs(['press', 'e4', 'Tab']).actionArgs, {target: 'e4', key: 'Tab'});
  assert.deepEqual(parseArgs(['hover', 'e5']).actionArgs, {target: 'e5'});
  assert.deepEqual(parseArgs(['select', 'e6', 'us']).actionArgs, {target: 'e6', values: 'us'});
  assert.deepEqual(parseArgs(['select', 'e6', 'a', 'b']).actionArgs, {target: 'e6', values: ['a', 'b']});
  assert.deepEqual(parseArgs(['check', 'e7']).actionArgs, {target: 'e7'});
  assert.deepEqual(parseArgs(['uncheck', 'e8']).actionArgs, {target: 'e8'});
  assert.deepEqual(parseArgs(['upload', 'e9', 'a.txt', 'b.txt']).actionArgs, {target: 'e9', files: ['a.txt', 'b.txt']});
  assert.deepEqual(parseArgs(['screenshot', 'e10', '--out', 'shot.png', '--full-page']).actionArgs, {fullPage: true, target: 'e10'});
  assert.deepEqual(parseArgs(['goto', 'https://example.org/path']).actionArgs, {url: 'https://example.org/path'});
  assert.deepEqual(parseArgs(['back']).actionArgs, {});
  assert.deepEqual(parseArgs(['forward']).actionArgs, {});
  assert.deepEqual(parseArgs(['reload']).actionArgs, {});
  assert.deepEqual(parseArgs(['eval', 'document.title']).actionArgs, {expression: 'document.title'});
  assert.deepEqual(parseArgs(['run-code', 'async p => p.url()']).actionArgs, {code: 'async p => p.url()'});
  assert.deepEqual(parseArgs(['console', 'error']).actionArgs, {level: 'error'});
  assert.deepEqual(parseArgs(['network', '/api/']).actionArgs, {filter: '/api/'});
  assert.deepEqual(parseArgs(['dialog', 'accept', 'yes']).actionArgs, {action: 'accept', promptText: 'yes'});
  assert.deepEqual(parseArgs(['dialog', 'dismiss']).actionArgs, {action: 'dismiss'});

  // Exploration, setup, agents, diagnostics
  const cp = parseArgs(['checkpoint', 'Found issue', '--annotation-file', 'note.json', '--data-ref', 'user-1']);
  assert.equal(cp.flags.note, 'Found issue');
  assert.equal(cp.flags['annotation-file'], 'note.json');
  assert.equal(cp.flags['data-ref'], 'user-1');

  const lib = parseArgs(['library', 'review', '--run', 'r1', '--decision', 'automate', '--note', 'ok']);
  assert.equal(lib.flags.libraryAction, 'review');
  assert.equal(lib.flags.run, 'r1');

  const libDelFlag = parseArgs(['library', 'delete', '--run', 'r1']);
  assert.equal(libDelFlag.flags.libraryAction, 'delete');
  assert.equal(libDelFlag.flags.run, 'r1');

  const libDelPos = parseArgs(['library', 'delete', 'r1']);
  assert.equal(libDelPos.flags.libraryAction, 'delete');
  assert.equal(libDelPos.flags.run, 'r1');

  const libDelAll = parseArgs(['library', 'delete', '--all']);
  assert.equal(libDelAll.flags.libraryAction, 'delete');
  assert.equal(libDelAll.flags.all, true);

  assert.throws(() => parseArgs(['library', 'list', '--all']), {code: 'INVALID_ARGUMENT'});

  const ag = parseArgs(['agents', 'install', '--target', 'antigravity,claude']);
  assert.equal(ag.flags.agentsAction, 'install');
  assert.equal(ag.flags.target, 'antigravity,claude');

  assert.equal(parseArgs(['doctor', '--fix']).flags.fix, true);
  assert.equal(parseArgs(['--json', '-s', 's1', '--profile', 'p1', '--workspace', '/tmp', 'tabs']).flags.session, 's1');
  assert.equal(parseArgs(['tabs', '-s=s2']).flags.session, 's2');
});

test('resolveProfile and resolveSession implement smart defaults and ambiguity errors', async () => {
  assert.equal(await resolveProfile(undefined, {readCfg: async () => ({profiles: {qa: {instanceId: '1'}}})}), 'qa');
  assert.equal(await resolveProfile(undefined, {readCfg: async () => ({profiles: {}})}), 'work');
  assert.equal(
    await resolveProfile(undefined, {readCfg: async () => ({profiles: {work: {}, personal: {}}})}),
    'work',
  );
  await assert.rejects(
    resolveProfile(undefined, {readCfg: async () => ({profiles: {personal: {}, staging: {}}})}),
    {code: 'PROFILE_AMBIGUOUS'},
  );

  const generated = await resolveSession('open', undefined, '/ws', {
    generateId: () => 's-abc123',
  });
  assert.equal(generated, 's-abc123');

  const resolved = await resolveSession('click', undefined, '/ws', {
    readBinding: async () => ({activeSession: 's-abc123', sessions: {'s-abc123': {tabId: 5}}}),
  });
  assert.equal(resolved, 's-abc123');

  await assert.rejects(
    resolveSession('click', undefined, '/ws', {readBinding: async () => null}),
    {code: 'SESSION_UNAVAILABLE'},
  );
});

test('runCLI dispatches cross-phase exploration, checkpoint, finish, library, and agents contracts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-cli-di-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const workspace = await fs.realpath(dir);

  const calls = [];
  const fakeDeps = {
    readConfig: async () => ({profiles: {sole: {instanceId: crypto.randomUUID(), chromeProfileDir: 'Default'}}}),
    workspaceAt: async () => workspace,
    readWorkspaceBinding: async () => ({activeSession: 's-active', sessions: {'s-active': {tabId: 9}}}),
    removeWorkspaceBinding: async () => ({removed: true}),
    loadExploration: async () => ({
      runWithExploration: async (inv, ver) => {
        calls.push(['runWithExploration', inv.command, inv.flags.profile, inv.flags.session, inv.flags.record, ver]);
        return {connected: true, session: inv.flags.session, profile: inv.flags.profile, tabId: 9};
      },
      checkpointCommand: async (opts, ver) => {
        calls.push(['checkpointCommand', opts, ver]);
        return {checkpoint: true, library: {runId: 'run-1'}};
      },
      finishCommand: async (opts, ver) => {
        calls.push(['finishCommand', opts, ver]);
        return {finished: true, library: {runId: 'run-1', status: 'finished', handoff: '/tmp/exploration.yaml'}};
      },
      libraryCommand: async (action, flags) => {
        calls.push(['libraryCommand', action, flags.run]);
        return {root: '/lib', runs: []};
      },
    }),
    loadAgents: async () => ({
      agentsCommand: async (action, flags) => {
        calls.push(['agentsCommand', action, flags.target]);
        return {targets: [{clients: ['Antigravity'], status: 'installed', path: '/a'}]};
      },
    }),
  };

  const openRes = await runCLI(['open', 'https://example.com', '--record', '--objective', 'Check'], fakeDeps);
  assert.equal(openRes.invocation.flags.profile, 'sole');
  assert.match(openRes.invocation.flags.session, /^s-[a-f0-9]{6}$/);

  await runCLI(['checkpoint', 'Observed login', '--data-ref', 'user1'], fakeDeps);
  await runCLI(['finish'], fakeDeps);
  await runCLI(['library', 'show', '--run', 'run-42'], fakeDeps);
  await runCLI(['agents', 'status', '--target', 'antigravity,claude'], fakeDeps);

  assert.equal(calls[0][0], 'runWithExploration');
  assert.equal(calls[0][4], true);
  assert.deepEqual(calls[1][1], {
    profile: 'sole',
    session: 's-active',
    workspace,
    note: 'Observed login',
    annotationFile: undefined,
    dataRef: 'user1',
  });
  assert.deepEqual(calls[2][1], {profile: 'sole', session: 's-active', workspace});
  assert.deepEqual(calls[3], ['libraryCommand', 'show', 'run-42']);
  assert.deepEqual(calls[4], ['agentsCommand', 'status', 'antigravity,claude']);
});

test('large ARIA snapshots (>12 KB) save to disk and emit bounded preview + path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-snap-'));
  const oldConfig = process.env.LATCH_CONFIG;
  process.env.LATCH_CONFIG = path.join(dir, 'app', 'config.json');
  t.after(async () => {
    if (oldConfig === undefined) delete process.env.LATCH_CONFIG;
    else process.env.LATCH_CONFIG = oldConfig;
    await fs.rm(dir, {recursive: true, force: true});
  });

  const hugeSnapshot = Array.from({length: 500}, (_, i) => `- button "Item ${i}" [ref=e${i + 1}]`).join('\n');
  assert.ok(Buffer.byteLength(hugeSnapshot, 'utf8') > SNAPSHOT_INLINE_LIMIT);

  const instanceId = crypto.randomUUID();
  const result = await executeCLI(parseArgs(['snapshot', '-s', 'snap1', '--workspace', dir]), {
    readConfig: async () => ({profiles: {work: {instanceId, chromeProfileDir: 'Default'}}}),
    request: async (_id, op) => {
      if (op === 'status') {
        return {
          instanceId,
          epoch: 'e1',
          hostGeneration: 'h1',
          capabilities: {nativeTransport: true, nativeSessionSchema: 4},
        };
      }
      if (op === 'session-action') {
        return {
          snapshot: hugeSnapshot,
          url: 'https://example.com',
          title: 'Big Page',
          refCount: 500,
        };
      }
    },
  });

  assert.equal(result.truncated, true);
  assert.ok(result.snapshotFile);
  assert.equal(await fs.readFile(result.snapshotFile, 'utf8'), hugeSnapshot);

  const text = formatResult('snapshot', result, {json: false});
  assert.match(text, /saved to:/);
  assert.ok(text.includes(result.snapshotFile));
  assert.ok(Buffer.byteLength(text, 'utf8') < Buffer.byteLength(hugeSnapshot, 'utf8'));

  const errText = formatError(fault('REF_NOT_FOUND', 'Ref missing', 'Run snapshot again.'), {json: false});
  assert.match(errText, /REF_NOT_FOUND/);
  assert.match(errText, /Run snapshot again\./);
});

test('screenshot --out, release without tabId, connect --focus-emulation off, and formatResult outputs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-cli-more-'));
  const oldConfig = process.env.LATCH_CONFIG;
  process.env.LATCH_CONFIG = path.join(dir, 'app', 'config.json');
  t.after(async () => {
    if (oldConfig === undefined) delete process.env.LATCH_CONFIG;
    else process.env.LATCH_CONFIG = oldConfig;
    await fs.rm(dir, {recursive: true, force: true});
  });

  const workspace = await fs.realpath(dir);
  const instanceId = crypto.randomUUID();
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const calls = [];
  let bindingState = null;

  const deps = {
    readConfig: async () => ({profiles: {work: {instanceId, chromeProfileDir: 'Default'}}}),
    workspaceAt: async () => workspace,
    readWorkspaceBinding: async () => bindingState,
    writeWorkspaceBinding: async (_ws, entry) => {
      bindingState = {activeSession: entry.session, sessions: {[entry.session]: entry}};
      return bindingState;
    },
    removeWorkspaceBinding: async () => {
      bindingState = null;
      return {removed: true, remaining: 0};
    },
    loadExploration: async () => ({
      runWithExploration: async (inv, _ver, exec) => exec(inv),
    }),
    request: async (_id, op, payload) => {
      calls.push({op, payload});
      if (op === 'status') {
        return {
          instanceId,
          epoch: 'e1',
          hostGeneration: 'h1',
          capabilities: {nativeTransport: true, nativeSessionSchema: 4, createTab: 1},
        };
      }
      if (op === 'session-connect') {
        return {connected: true, tabId: payload.tabId, focusEmulation: payload.focusEmulation, page: {url: 'https://a.test/', title: 'A'}};
      }
      if (op === 'session-action' && payload.action === 'screenshot') {
        return {mimeType: 'image/png', data: pngBytes.toString('base64'), bytes: pngBytes.length, url: 'https://a.test/', title: 'A'};
      }
      if (op === 'session-release') {
        return {released: true, sessionClosed: true, preservedUserTabs: true};
      }
    },
  };

  // Connect without -s with --focus-emulation off
  const conn = await runCLI(['connect', '77', '--focus-emulation', 'off'], deps);
  assert.equal(conn.result.focusEmulation, false);
  assert.equal(bindingState.sessions[conn.result.session].tabId, 77);
  assert.match(formatResult('connect', conn.result), /focus-emulation off/);

  // Screenshot with --out writes file without leaking base64 into result
  const shot = await runCLI(['screenshot', '--out', 'shots/page.png'], deps);
  assert.equal(shot.result.saved, true);
  assert.equal(shot.result.data, undefined);
  assert.deepEqual(await fs.readFile(path.join(workspace, 'shots/page.png')), pngBytes);
  assert.match(formatResult('screenshot', shot.result), /Screenshot saved:/);

  // Screenshot without --out saves under sessionsDir/screenshots
  const autoShot = await runCLI(['screenshot'], deps);
  assert.equal(autoShot.result.saved, true);
  assert.deepEqual(await fs.readFile(autoShot.result.path), pngBytes);

  // Release without [tabId] resolves tabId 77 from binding and clears binding on sessionClosed
  const rel = await runCLI(['release'], deps);
  assert.equal(rel.result.tabId, 77);
  assert.equal(rel.result.sessionClosed, true);
  assert.equal(bindingState, null);
  assert.match(formatResult('release', rel.result), /Released tab 77 \(session closed\)/);

  // Concise formatResult spot-checks across commands
  assert.match(formatResult('tabs', {profile: 'work', tabs: [{tabId: 1, title: 'Home', url: 'https://a.test', active: true}]}), /\[1\] Home/);
  assert.match(formatResult('sessions', {profile: 'work', sessions: []}), /No active sessions/);
  assert.equal(formatResult('eval', {value: 'hello'}), 'hello');
  assert.match(formatResult('console', {entries: [{type: 'error', text: 'boom'}], total: 1}), /\[error\] boom/);
  assert.match(formatResult('network', {entries: [{kind: 'response', method: 'GET', status: 200, url: 'https://a.test'}], total: 1}), /GET 200/);
  assert.match(formatResult('dialog', {action: 'accept', type: 'confirm', message: 'Sure?'}), /Dialog accept \(confirm\): Sure\?/);
  assert.match(formatResult('help', {usage: 'Latch usage'}), /Latch usage/);
  assert.equal(formatResult('library', {deleted: true, runId: 'r1'}), 'Deleted exploration r1.');
  assert.equal(
    formatResult('library', {deleted: ['r1'], deletedCount: 1, skippedActive: ['r2']}),
    'Deleted 1 exploration(s). Skipped 1 active run(s).',
  );
  assert.equal(formatResult('library', {deleted: [], deletedCount: 0, skippedActive: []}), 'Deleted 0 exploration(s).');
});

test('CLI executes when invoked through a symlink or junction (npm link)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-link-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const linkedRoot = path.join(dir, 'linked-latch');
  const repoRoot = path.resolve(path.dirname(cliEntry), '..');
  await linkDirectory(repoRoot, linkedRoot);
  const {stdout} = await exec(process.execPath, [path.join(linkedRoot, 'src', 'cli.mjs'), 'version', '--json']);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nativeSessionSchema, 4);
});

test('latch config manages artifactsDir with LATCH_ARTIFACT_ROOT env > config.json > default precedence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-cfg-cli-'));
  const customDir = path.join(dir, 'custom-runs');
  const envDir = path.join(dir, 'env-runs');
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const env = {...process.env, LATCH_CONFIG: path.join(dir, 'config.json')};
  delete env.LATCH_ARTIFACT_ROOT;

  const initial = JSON.parse((await exec(process.execPath, [cliEntry, 'config', 'get', '--json'], {env})).stdout);
  assert.equal(initial.ok, true);
  assert.equal(initial.source, 'default');
  assert.equal(initial.envOverride, false);

  const setOut = (await exec(process.execPath, [cliEntry, 'config', 'set', 'artifacts-dir', customDir], {env})).stdout;
  assert.match(setOut, /Saved artifacts folder:/);
  assert.match(setOut, /\[config\]/);

  const afterSet = JSON.parse((await exec(process.execPath, [cliEntry, 'config', 'get', '--json'], {env})).stdout);
  assert.equal(afterSet.source, 'config');
  assert.equal(afterSet.path, path.resolve(customDir));

  const envOverridden = JSON.parse(
    (await exec(process.execPath, [cliEntry, 'config', 'get', '--json'], {env: {...env, LATCH_ARTIFACT_ROOT: envDir}})).stdout,
  );
  assert.equal(envOverridden.source, 'env');
  assert.equal(envOverridden.envOverride, true);
  assert.equal(envOverridden.path, path.resolve(envDir));

  const unsetRes = JSON.parse((await exec(process.execPath, [cliEntry, 'config', 'unset', 'artifacts-dir', '--json'], {env})).stdout);
  assert.equal(unsetRes.reset, true);
  assert.equal(unsetRes.source, 'default');
});
