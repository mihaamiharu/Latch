import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  readWorkspaceBinding,
  writeWorkspaceBinding,
  removeWorkspaceBinding,
  listWorkspaceBindings,
} from '../src/recovery-state.mjs';
import {reconcile} from '../src/reconcile.mjs';
import {doctorCommand} from '../src/setup.mjs';
import {workspaceBindingPath, ipcEndpoint} from '../src/platform.mjs';
import {sessionKey} from '../src/redact.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-binding-'));
  const original = {config: process.env.LATCH_CONFIG, runtime: process.env.LATCH_RUNTIME_DIR};
  process.env.LATCH_CONFIG = path.join(dir, 'app', 'config.json');
  process.env.LATCH_RUNTIME_DIR = path.join(dir, 'runtime');
  await fs.mkdir(path.dirname(process.env.LATCH_CONFIG), {recursive: true});
  await fs.mkdir(process.env.LATCH_RUNTIME_DIR, {recursive: true});
  t.after(async () => {
    for (const [k, v] of [['LATCH_CONFIG', original.config], ['LATCH_RUNTIME_DIR', original.runtime]]) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    await fs.rm(dir, {recursive: true, force: true});
  });
  const workspace = await fs.realpath(dir);
  const key = sessionKey(workspace, 'agent');
  return {dir, workspace, key};
}

test('workspace session binding stores state under appDataDir/sessions without repo dotfiles', async t => {
  const f = await fixture(t);
  const instanceId = crypto.randomUUID();

  await writeWorkspaceBinding(f.workspace, {
    sessionKey: f.key,
    session: 'agent',
    workspace: f.workspace,
    instanceId,
    tabId: 42,
    focusEmulation: true,
  });

  const bindingFile = workspaceBindingPath(f.workspace);
  assert.ok(bindingFile.includes(path.join('app', 'sessions')));
  const stored = await readWorkspaceBinding(f.workspace);
  assert.equal(stored.activeSession, 'agent');
  assert.equal(stored.sessions.agent.sessionKey, f.key);
  assert.equal(stored.sessions.agent.tabId, 42);
  assert.equal((await listWorkspaceBindings()).length, 1);

  // Zero dotfiles in the workspace itself
  const workspaceEntries = await fs.readdir(f.workspace);
  assert.ok(!workspaceEntries.includes('.playwright'));
  assert.ok(!workspaceEntries.includes('.latch'));

  const removed = await removeWorkspaceBinding(f.workspace, 'agent');
  assert.equal(removed.removed, true);
  assert.equal(removed.remaining, 0);
  assert.equal(await readWorkspaceBinding(f.workspace), null);
});

test('reconcile and doctor --fix clean stale bindings and disconnect interrupted sessions', async t => {
  const f = await fixture(t);
  const instanceId = crypto.randomUUID();
  const epoch = crypto.randomUUID();
  const hostGeneration = crypto.randomUUID();
  await fs.writeFile(
    process.env.LATCH_CONFIG,
    JSON.stringify({profiles: {work: {instanceId, chromeProfileDir: 'Default'}}}),
  );

  await writeWorkspaceBinding(f.workspace, {
    sessionKey: f.key,
    session: 'agent',
    workspace: f.workspace,
    instanceId,
    tabId: 7,
    focusEmulation: true,
  });

  // Offline: read-only inspect preserves binding; apply clears stale binding
  const offline = await reconcile({alias: 'work', workspace: f.workspace, session: 'agent', key: f.key});
  assert.equal(offline.online, false);
  assert.equal(offline.status, 'interrupted');
  assert.ok(await readWorkspaceBinding(f.workspace));

  const cleared = await reconcile({alias: 'work', workspace: f.workspace, session: 'agent', key: f.key, apply: true});
  assert.equal(cleared.bindingCleared, true);
  assert.equal(await readWorkspaceBinding(f.workspace), null);

  // Online interrupted session: doctor --fix calls session-disconnect
  const disconnectedKeys = [];
  const server = net.createServer(socket => {
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk;
      if (!buf.includes('\n')) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf('\n')));
      if (req.op === 'status') {
        socket.end(
          JSON.stringify({
            v: 1,
            id: req.id,
            ok: true,
            result: {
              instanceId,
              epoch,
              hostGeneration,
              readiness: {verified: true},
              capabilities: {nativeTransport: true, nativeSessionSchema: 4, recoveryContract: 1},
            },
          }) + '\n',
        );
      } else if (req.op === 'session-list') {
        socket.end(
          JSON.stringify({
            v: 1,
            id: req.id,
            ok: true,
            result: {sessions: [{sessionKey: f.key, stopped: true}]},
          }) + '\n',
        );
      } else if (req.op === 'session-disconnect') {
        disconnectedKeys.push(req.payload.sessionKey);
        socket.end(
          JSON.stringify({
            v: 1,
            id: req.id,
            ok: true,
            result: {disconnected: true, preservedUserTabs: true},
          }) + '\n',
        );
      }
    });
  });
  await new Promise(r => server.listen(ipcEndpoint(instanceId), r));
  t.after(() => new Promise(r => server.close(r)));

  const doc = await doctorCommand({
    profile: 'work',
    session: 'agent',
    workspace: f.workspace,
    fix: true,
    root: path.join(f.dir, 'rt'),
    registrationRoot: path.join(f.dir, 'reg'),
    userRoot: path.join(f.dir, 'user'),
    skipSkills: true,
    skipRegistry: true,
  });
  assert.equal(doc.fixed, true);
  assert.equal(doc.healthy, true);
  assert.deepEqual(disconnectedKeys, [f.key]);
});
