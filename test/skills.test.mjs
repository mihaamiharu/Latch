import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {installSkills, skillStatus, uninstallSkills, sourceSkill, targetsFor} from '../src/install-skills.mjs';

const work = fileURLToPath(new URL('../work/skill-tests/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(work, {recursive: true});
  const dir = await fs.mkdtemp(path.join(work, 'case-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
test('shared install is idempotent; uninstall removes only links and preserves the canonical skill', async t => {
  const userRoot = await fixture(t);
  const first = await installSkills({userRoot});
  assert.equal(first.length, 2);
  for (const installed of first) {
    assert.equal(installed.status, 'installed');
    assert.equal(await fs.realpath(installed.path), await fs.realpath(sourceSkill));
  }
  assert.deepEqual((await installSkills({userRoot})).map(p => p.status), ['installed', 'installed']);
  assert.deepEqual((await uninstallSkills({userRoot})).map(p => p.status), ['missing', 'missing']);
  await fs.access(path.join(sourceSkill, 'SKILL.md'));
});
test('existing non-managed skills are preserved and collisions cause no partial install', async t => {
  const userRoot = await fixture(t);
  const targets = targetsFor(userRoot);
  await fs.mkdir(targets[1].path, {recursive: true});
  const marker = path.join(targets[1].path, 'keep.txt');
  await fs.writeFile(marker, 'user-owned skill');
  await assert.rejects(installSkills({userRoot}), /No links were changed/);
  await assert.rejects(fs.lstat(targets[0].path), {code: 'ENOENT'});
  assert.equal(await fs.readFile(marker, 'utf8'), 'user-owned skill');
  await uninstallSkills({userRoot});
  assert.equal(await fs.readFile(marker, 'utf8'), 'user-owned skill');
  assert.equal((await skillStatus({userRoot}))[1].status, 'conflict');
});
function execute(script, args, {cwd, env = {}}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {cwd, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr}));
  });
}
test('skill wrapper preserves task cwd, argument boundaries and nonzero runtime status', async t => {
  const dir = await fixture(t);
  const runtime = path.join(dir, 'runtime'); const cwd = path.join(dir, 'separate project');
  await fs.mkdir(path.join(runtime, 'src'), {recursive: true}); await fs.mkdir(cwd);
  await fs.writeFile(path.join(runtime, 'src/cli.mjs'), 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.exitCode=7;');
  const result = await execute(path.join(sourceSkill, 'scripts/latch.mjs'), ['tabs', '--workspace', cwd], {cwd, env: {LATCH_HOME: runtime}});
  assert.equal(result.code, 7);
  const value = JSON.parse(result.stdout);
  assert.equal(await fs.realpath(value.cwd), await fs.realpath(cwd));
  assert.deepEqual(value.args, ['tabs', '--workspace', cwd]);
});
test('skill wrapper fails clearly when a separately copied skill cannot find its runtime', async t => {
  const cwd = await fixture(t);
  const result = await execute(path.join(sourceSkill, 'scripts/latch.mjs'), ['doctor'], {cwd, env: {LATCH_HOME: path.join(cwd, 'missing')}});
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'LATCH_RUNTIME_UNAVAILABLE');
});
