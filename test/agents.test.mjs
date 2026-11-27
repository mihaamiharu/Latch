import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
  agentsCommand,
  installAgents,
  agentsStatus,
  uninstallAgents,
  targetsFor,
  parseTargetList,
  sourceSkill,
  sourceAntigravityPlugin,
} from '../src/agents.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const agentsScript = path.join(ROOT, 'src', 'agents.mjs');
const work = path.join(ROOT, 'work', 'agent-tests');

async function fixture(t) {
  await fs.mkdir(work, {recursive: true});
  const dir = await fs.mkdtemp(path.join(work, 'case-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('parseTargetList and targetsFor map agent targets to canonical install directories', () => {
  assert.deepEqual(parseTargetList(), ['antigravity', 'claude', 'codex', 'cursor']);
  assert.deepEqual(parseTargetList('codex,cursor'), ['codex', 'cursor']);
  assert.throws(() => parseTargetList('vscode'), {code: 'INVALID_ARGUMENT'});

  const userRoot = path.join(ROOT, 'work', 'fake-home');
  const all = targetsFor(userRoot, 'all');
  assert.deepEqual(
    all.map(t => ({id: t.id, path: t.path})),
    [
      {id: 'antigravity', path: path.join(userRoot, '.gemini', 'config', 'plugins', 'latch')},
      {id: 'claude', path: path.join(userRoot, '.claude', 'skills', 'latch')},
      {id: 'codex-cursor', path: path.join(userRoot, '.agents', 'skills', 'latch')},
    ],
  );

  // codex and cursor share ~/.agents/skills/latch and deduplicate cleanly
  assert.equal(targetsFor(userRoot, 'codex,cursor').length, 1);
  assert.equal(targetsFor(userRoot, 'antigravity').length, 1);
  assert.equal(targetsFor(userRoot, 'claude').length, 1);
});

test('agentsCommand installs, inspects, and uninstalls selected and all targets cleanly', async t => {
  const userRoot = await fixture(t);

  const initial = await agentsCommand('status', {userRoot});
  assert.equal(initial.action, 'status');
  assert.deepEqual(initial.targets.map(x => x.status), ['missing', 'missing', 'missing']);

  // Install only antigravity
  const onlyAgy = await agentsCommand('install', {userRoot, target: 'antigravity'});
  assert.equal(onlyAgy.targets.length, 1);
  assert.equal(onlyAgy.targets[0].status, 'installed');
  assert.equal(
    (await fs.realpath(onlyAgy.targets[0].path)).toLowerCase(),
    (await fs.realpath(sourceAntigravityPlugin)).toLowerCase(),
  );

  // Other targets remain missing
  const mid = await agentsCommand('status', {userRoot});
  assert.deepEqual(mid.targets.map(x => x.status), ['installed', 'missing', 'missing']);

  // Install remaining targets
  const allInstalled = await agentsCommand('install', {userRoot, target: 'all'});
  assert.deepEqual(allInstalled.targets.map(x => x.status), ['installed', 'installed', 'installed']);
  const claudeTarget = allInstalled.targets.find(x => x.id === 'claude');
  const codexTarget = allInstalled.targets.find(x => x.id === 'codex-cursor');
  assert.equal(
    (await fs.realpath(claudeTarget.path)).toLowerCase(),
    (await fs.realpath(sourceSkill)).toLowerCase(),
  );
  assert.equal(
    (await fs.realpath(codexTarget.path)).toLowerCase(),
    (await fs.realpath(sourceSkill)).toLowerCase(),
  );

  // Uninstall only codex/cursor, keeping antigravity and claude
  const partialUninstall = await agentsCommand('uninstall', {userRoot, target: 'codex,cursor'});
  assert.deepEqual(partialUninstall.targets.map(x => x.status), ['missing']);
  assert.deepEqual(
    (await agentsStatus({userRoot})).map(x => x.status),
    ['installed', 'installed', 'missing'],
  );

  // Uninstall all remaining
  const done = await agentsCommand('uninstall', {userRoot});
  assert.deepEqual(done.targets.map(x => x.status), ['missing', 'missing', 'missing']);
});

test('agents install detects foreign symlink or directory conflicts and leaves state untouched', async t => {
  const userRoot = await fixture(t);
  const foreignSource = path.join(userRoot, 'other-plugin');
  await fs.mkdir(foreignSource, {recursive: true});
  await fs.writeFile(path.join(foreignSource, 'plugin.json'), '{"name":"other"}');

  const agyTarget = targetsFor(userRoot, 'antigravity')[0];
  await fs.mkdir(path.dirname(agyTarget.path), {recursive: true});
  await fs.symlink(foreignSource, agyTarget.path, process.platform === 'win32' ? 'junction' : 'dir');

  const status = await agentsStatus({userRoot});
  assert.equal(status.find(x => x.id === 'antigravity').status, 'conflict');

  await assert.rejects(installAgents({userRoot}), {code: 'AGENT_TARGET_CONFLICT'});
  // No partial links created for claude or codex-cursor
  for (const other of targetsFor(userRoot, 'claude,codex')) {
    await assert.rejects(fs.lstat(other.path), {code: 'ENOENT'});
  }

  // Uninstall preserves foreign symlink
  await uninstallAgents({userRoot});
  const stat = await fs.lstat(agyTarget.path);
  assert.ok(stat.isSymbolicLink());
});

test('src/agents.mjs CLI entrypoint handles install, status, uninstall and errors', async t => {
  const userRoot = await fixture(t);
  const installed = JSON.parse(
    (await exec(process.execPath, [agentsScript, 'install', '--target', 'claude,codex', '--user-root', userRoot])).stdout,
  );
  assert.equal(installed.ok, true);
  assert.equal(installed.action, 'install');
  assert.deepEqual(installed.targets.map(x => x.status), ['installed', 'installed']);

  await assert.rejects(exec(process.execPath, [agentsScript, 'bogus', '--user-root', userRoot]), err => {
    const parsed = JSON.parse(err.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'INVALID_ARGUMENT');
    return true;
  });
});
