import {CANDIDATE_VERSION} from './helpers/candidate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT, HOST_NAME, EXTENSION_ID} from '../src/release.mjs';
import {build} from '../src/build.mjs';
import {inspectSetup, stageSetup, activateSetup, rollbackSetup, setupSkills, uninstallSetup, configureNativeSetup} from '../src/setup.mjs';

const exec = promisify(execFile);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(ROOT, 'work/setup-'));
  const prior = {config: process.env.LATCH_CONFIG, runtime: process.env.LATCH_RUNTIME_DIR};
  process.env.LATCH_CONFIG = path.join(dir, 'config.json');
  process.env.LATCH_RUNTIME_DIR = '/tmp/latch-setup-' + crypto.randomBytes(5).toString('hex');
  await fs.writeFile(process.env.LATCH_CONFIG, '{"v":1,"profiles":{}}\n');
  t.after(async () => {
    for (const [k, v] of [['LATCH_CONFIG', prior.config], ['LATCH_RUNTIME_DIR', prior.runtime]]) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    await fs.rm(dir, {recursive: true, force: true});
  });
  const built = await build({out: path.join(dir, 'build')});
  const options = {
    kit: built.kit,
    root: path.join(dir, 'installed with spaces'),
    registrationRoot: path.join(dir, 'registrations'),
    userRoot: path.join(dir, 'user'),
    extensionUnloaded: true,
    tasksDrained: true,
  };
  return {dir, options};
}

test('setup stages without registration, activates idempotently, installs stable managed links and preserves data on uninstall', async t => {
  const f = await fixture(t);
  const o = f.options;
  const before = await fs.readFile(process.env.LATCH_CONFIG, 'utf8');
  const plan = await inspectSetup(o);
  const staged = await stageSetup(o);
  assert.equal(staged.planToken, plan.planToken);
  await assert.rejects(fs.stat(plan.paths.registration), {code: 'ENOENT'});
  await assert.rejects(activateSetup({...o, expect: 'bad'}), {code: 'SETUP_PLAN_CHANGED'});
  const active = await activateSetup({...o, expect: plan.planToken});
  assert.equal(active.activated, true);
  assert.equal(active.verified, false);
  assert.equal(JSON.parse((await exec(active.cli, ['version'])).stdout).version, CANDIDATE_VERSION);
  await setupSkills(o);
  await setupSkills(o);
  const link = path.join(o.userRoot, '.agents/skills/latch');
  assert.equal(await fs.readlink(link), path.join(o.root, 'current/skills/latch'));
  const cwd = path.join(f.dir, 'task with spaces');
  await fs.mkdir(cwd);
  const result = await exec(process.execPath, [path.join(link, 'scripts/latch.mjs'), 'version'], {cwd});
  assert.equal(JSON.parse(result.stdout).version, CANDIDATE_VERSION);
  const again = await inspectSetup(o);
  await activateSetup({...o, expect: again.planToken});
  assert.equal(await fs.readFile(process.env.LATCH_CONFIG, 'utf8'), before);
  const marker = path.join(o.root, 'evidence.txt');
  await fs.writeFile(marker, 'keep');
  await uninstallSetup(o);
  assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
  assert.equal(await fs.readFile(process.env.LATCH_CONFIG, 'utf8'), before);
  await assert.rejects(fs.lstat(link), {code: 'ENOENT'});
});

test('foreign registration, skill collisions, missing maintenance and old installer gates remain untouched', async t => {
  const {options: o} = await fixture(t);
  await fs.mkdir(o.registrationRoot, {recursive: true});
  const reg = path.join(o.registrationRoot, HOST_NAME + '.json');
  await fs.writeFile(reg, 'foreign');
  await assert.rejects(inspectSetup(o), {code: 'INSTALL_FOREIGN_REGISTRATION'});
  assert.equal(await fs.readFile(reg, 'utf8'), 'foreign');
  await fs.unlink(reg);
  let plan = await inspectSetup(o);
  await assert.rejects(activateSetup({...o, expect: plan.planToken, extensionUnloaded: false}), {code: 'MAINTENANCE_UNVERIFIED'});
  await assert.rejects(fs.stat(reg), {code: 'ENOENT'});
  await activateSetup({...o, expect: plan.planToken});
  const skill = path.join(o.userRoot, '.claude/skills/latch');
  await fs.mkdir(skill, {recursive: true});
  await fs.writeFile(path.join(skill, 'keep'), 'user skill');
  await assert.rejects(setupSkills(o), {code: 'SKILL_CONFLICT'});
  assert.equal(await fs.readFile(path.join(skill, 'keep'), 'utf8'), 'user skill');
  await assert.rejects(fs.lstat(path.join(o.userRoot, '.agents/skills/latch')), {code: 'ENOENT'});
  await fs.mkdir(path.join(o.root, 'setup.lock'));
  await fs.writeFile(path.join(o.root, 'setup.lock/owner.json'), '{"pid":1,"startedAt":0}');
  plan = await inspectSetup(o);
  assert.ok(plan.blockers.includes('SETUP_BUSY'));
  await assert.rejects(stageSetup(o), {code: 'SETUP_BUSY'});
  assert.equal(await fs.readFile(path.join(o.root, 'setup.lock/owner.json'), 'utf8'), '{"pid":1,"startedAt":0}');
});

test('caught activation failure restores the previous registration, receipt and code selection', async t => {
  const {options: o} = await fixture(t);
  const first = await inspectSetup(o);
  await activateSetup({...o, expect: first.planToken});
  const receipt = await fs.readFile(first.paths.receipt, 'utf8');
  const reg = await fs.readFile(first.paths.registration, 'utf8');
  const pointer = await fs.readlink(first.paths.current);
  const plan = await inspectSetup(o);
  const rename = fs.rename.bind(fs);
  let injected = false;
  t.mock.method(fs, 'rename', async (a, b) => {
    if (b === first.paths.receipt && !injected) {
      injected = true;
      throw Object.assign(new Error('Injected receipt failure'), {code: 'EIO'});
    }
    return rename(a, b);
  });
  await assert.rejects(activateSetup({...o, expect: plan.planToken}), {code: 'EIO'});
  assert.equal(await fs.readFile(first.paths.receipt, 'utf8'), receipt);
  assert.equal(await fs.readFile(first.paths.registration, 'utf8'), reg);
  assert.equal(await fs.readlink(first.paths.current), pointer);
  await assert.rejects(fs.stat(first.paths.gate), {code: 'ENOENT'});
});

test('real installer process loss leaves its gate and journal inspectable without reclaiming them', async t => {
  const {dir, options: o} = await fixture(t);
  const plan = await inspectSetup(o);
  await activateSetup({...o, expect: plan.planToken});
  const receipt = await fs.readFile(plan.paths.receipt, 'utf8');
  const reg = await fs.readFile(plan.paths.registration, 'utf8');
  const next = await inspectSetup(o);
  const child = path.join(dir, 'interrupt.mjs');
  await fs.writeFile(
    child,
    `import fs from 'node:fs/promises';import {activateSetup} from ${JSON.stringify(new URL('../src/setup.mjs', import.meta.url).href)};const rename=fs.rename.bind(fs);fs.rename=async(a,b)=>{await rename(a,b);if(b===${JSON.stringify(plan.paths.transaction)})process.kill(process.pid,'SIGKILL')};await activateSetup(${JSON.stringify({...o, expect: next.planToken})});`,
  );
  await assert.rejects(exec(process.execPath, [child]), error => error.signal === 'SIGKILL');
  const interrupted = await inspectSetup(o);
  assert.ok(interrupted.gate);
  assert.equal(JSON.parse(interrupted.transaction).state, 'activating');
  assert.equal(await fs.readFile(plan.paths.receipt, 'utf8'), receipt);
  assert.equal(await fs.readFile(plan.paths.registration, 'utf8'), reg);
  await assert.rejects(stageSetup(o), {code: 'SETUP_BUSY'});
});

test('wrong prerequisites and a reachable bridge block setup', async t => {
  const {dir, options: o} = await fixture(t);
  const fake = path.join(dir, 'wrong-node');
  await fs.writeFile(fake, '#!/bin/sh\nprintf \'{"version":"v20.0.0","platform":"darwin","architecture":"arm64"}\'\n', {mode: 0o700});
  await assert.rejects(inspectSetup({...o, node: fake}), {code: 'SETUP_NODE_VERSION'});
  await assert.rejects(stageSetup({...o, node: fake}), {code: 'SETUP_NODE_VERSION'});
  await assert.rejects(fs.stat(o.root), {code: 'ENOENT'});
  await fs.writeFile(fake, '#!/bin/sh\nprintf \'{"version":"v22.0.0","platform":"darwin","architecture":"x64"}\'\n', {mode: 0o700});
  await assert.rejects(stageSetup({...o, node: fake}), {code: 'SETUP_NODE_PLATFORM'});
  await assert.rejects(fs.stat(o.root), {code: 'ENOENT'});
  const wrongCLI = path.join(dir, 'wrong-cli');
  const priorCLI = process.env.LATCH_PLAYWRIGHT_CLI;
  await fs.writeFile(wrongCLI, '#!/bin/sh\nprintf \'{"version":"0.1.99"}\'\n', {mode: 0o700});
  process.env.LATCH_PLAYWRIGHT_CLI = wrongCLI;
  try {
    await assert.rejects(inspectSetup(o), {code: 'UNSUPPORTED_VERSION'});
  } finally {
    priorCLI === undefined ? delete process.env.LATCH_PLAYWRIGHT_CLI : (process.env.LATCH_PLAYWRIGHT_CLI = priorCLI);
  }
  const {default: net} = await import('node:net');
  const instance = crypto.randomUUID();
  const runtime = process.env.LATCH_RUNTIME_DIR;
  await fs.mkdir(runtime, {recursive: true});
  const server = net.createServer(s => s.end());
  await new Promise(r => server.listen(path.join(runtime, instance + '.sock'), r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    await fs.rm(runtime, {recursive: true, force: true});
  });
  await fs.writeFile(process.env.LATCH_CONFIG, JSON.stringify({profiles: {work: {instanceId: instance}}}));
  const plan = await inspectSetup(o);
  await assert.rejects(activateSetup({...o, expect: plan.planToken}), {code: 'INSTALL_ACTIVE'});
  await assert.rejects(fs.stat(plan.paths.registration), {code: 'ENOENT'});
});

test('unsupported platform or architecture blocks every installer mutation before creating the root', async t => {
  const {options: o} = await fixture(t);
  const before = await fs.readFile(process.env.LATCH_CONFIG);
  for (const [method, value, code] of [
    ['platform', 'linux', 'SETUP_PLATFORM_UNSUPPORTED'],
    ['arch', 'x64', 'SETUP_ARCHITECTURE_UNSUPPORTED'],
  ]) {
    const mock = t.mock.method(os, method, () => value);
    for (const action of [inspectSetup, stageSetup, activateSetup, rollbackSetup, setupSkills, uninstallSetup, configureNativeSetup]) {
      await assert.rejects(action(o), {code});
    }
    await assert.rejects(fs.stat(o.root), {code: 'ENOENT'});
    await assert.rejects(fs.stat(o.registrationRoot), {code: 'ENOENT'});
    assert.deepEqual(await fs.readFile(process.env.LATCH_CONFIG), before);
    mock.mock.restore();
  }
});

test('managed CLI pins its validated executable and Node for minimal PATH, rejects changed plans and never substitutes a missing CLI', async t => {
  const {dir, options: original} = await fixture(t);
  const calls = path.join(dir, 'selected-calls');
  const otherCalls = path.join(dir, 'other-calls');
  const selected = path.join(dir, "selected cli 'with spaces'.js");
  const other = path.join(dir, 'other-cli.js');
  const script = file =>
    `#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(file)},JSON.stringify({node:process.execPath,version:process.version})+'\\n');console.log(JSON.stringify({version:'0.1.20'}));`;
  await fs.writeFile(selected, script(calls), {mode: 0o700});
  await fs.writeFile(other, script(otherCalls), {mode: 0o700});
  const o = {...original, playwrightCLI: selected};
  const first = await inspectSetup(o);
  assert.equal(first.prerequisites.playwrightCLI, selected);
  await fs.appendFile(selected, '\n// changed since inspection');
  await assert.rejects(activateSetup({...o, expect: first.planToken}), {code: 'SETUP_PLAN_CHANGED'});
  await assert.rejects(fs.stat(first.paths.registration), {code: 'ENOENT'});
  const plan = await inspectSetup(o);
  await activateSetup({...o, expect: plan.planToken});
  const before = await fs.readFile(plan.paths.receipt);
  const config = await fs.readFile(process.env.LATCH_CONFIG);
  const receipt = JSON.parse(before);
  assert.equal(receipt.playwrightCLI, selected);
  assert.equal(receipt.playwrightCLIEntrySHA256, plan.prerequisites.playwrightCLIEntrySHA256);
  const env = {...process.env, PATH: '/usr/bin:/bin', LATCH_PLAYWRIGHT_CLI: other};
  const cli = path.join(o.root, 'bin/latch');
  const preflight = JSON.parse((await exec(cli, ['preflight', '--workspace', dir, '--session', 'task'], {cwd: dir, env})).stdout);
  assert.equal(preflight.checks.find(c => c.id === 'playwright-cli').status, 'pass');
  const invoked = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(invoked.at(-1).node, plan.paths.node);
  await assert.rejects(fs.stat(otherCalls), {code: 'ENOENT'});
  await fs.unlink(selected);
  const missing = JSON.parse((await exec(cli, ['preflight', '--workspace', dir, '--session', 'task'], {cwd: dir, env})).stdout);
  assert.equal(missing.checks.find(c => c.id === 'playwright-cli').error.code, 'CLI_UNAVAILABLE');
  await assert.rejects(fs.stat(otherCalls), {code: 'ENOENT'});
  assert.equal(JSON.parse((await exec(cli, ['version'], {env})).stdout).version, CANDIDATE_VERSION);
  assert.deepEqual(await fs.readFile(plan.paths.receipt), before);
  assert.deepEqual(await fs.readFile(process.env.LATCH_CONFIG), config);
  await assert.rejects(stageSetup(o), {code: 'SETUP_EXECUTABLE_UNAVAILABLE'});
});

test('an unowned receipt cannot supply an executable during inspection', async t => {
  const {dir, options: o} = await fixture(t);
  const called = path.join(dir, 'foreign-was-run');
  const script = path.join(dir, 'foreign-cli');
  await fs.writeFile(script, `#!/bin/sh\n/usr/bin/touch '${called}'\nprintf '{"version":"0.1.20"}'\n`, {mode: 0o700});
  await fs.mkdir(o.root, {recursive: true});
  await fs.writeFile(path.join(o.root, 'receipt.json'), JSON.stringify({schema: 1, extensionId: EXTENSION_ID, playwrightCLI: script}));
  await assert.rejects(inspectSetup(o), {code: 'INSTALL_ROOT_FOREIGN'});
  await assert.rejects(fs.stat(called), {code: 'ENOENT'});
});
