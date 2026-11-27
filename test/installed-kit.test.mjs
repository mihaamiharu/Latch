import {CANDIDATE_VERSION, CANDIDATE_CHROME_VERSION, CANDIDATE_KIT} from './helpers/candidate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {attachmentFixture, valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';
import {installCommand, doctorCommand} from '../src/setup.mjs';

const exec = promisify(execFile);
const enabled = process.env.LATCH_INSTALLED_KIT === '1' && process.platform === 'darwin';

async function envOf(env, fn) {
  const names = ['LATCH_CONFIG', 'LATCH_RUNTIME_DIR', 'PWTEST_DAEMON_SESSION_DIR'];
  const before = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) process.env[n] = env[n];
  try {
    return await fn();
  } finally {
    for (const n of names) before[n] === undefined ? delete process.env[n] : (process.env[n] = before[n]);
  }
}

test('installed kit clean install operates natively without external extension', {skip: !enabled, timeout: 180000}, async t => {
  const app = await evidenceApp();
  app.installed = true;
  app.minimalHostPath = true;
  app.artifactExtension = path.join(CANDIDATE_KIT, 'extension');
  let setupOptions;
  let f;
  app.install = async ({temp, profile, env}) => {
    app.installedRoot = path.join(temp, 'installed runtime');
    setupOptions = {
      kit: CANDIDATE_KIT,
      root: app.installedRoot,
      registrationRoot: path.join(profile, 'NativeMessagingHosts'),
      extensionUnloaded: true,
      tasksDrained: true,
    };
    await fs.writeFile(env.LATCH_CONFIG, '{"v":1,"profiles":{}}\n');
    await envOf(env, async () => {
      await installCommand(setupOptions);
    });
  };
  t.after(async () => {
    await f?.close();
    await app.close();
  });
  f = await attachmentFixture(t, app, 'native');
  assert.equal(f.identity.extensionVersion, CANDIDATE_CHROME_VERSION);
  assert.equal(f.identity.releaseVersion, CANDIDATE_VERSION);
  assert.equal(f.identity.capabilities.uiControl, 1);
  const selected = await envOf(f.env, () => doctorCommand(setupOptions));
  assert.equal(selected.transport, 'native');
  assert.equal(selected.healthy, true);
  const ready = await f.latch(0, ['preflight', '--session', 'agent']);
  assert.equal(ready.ready, true);
  assert.equal(ready.attachment, 'not-checked');
  const a = await f.latch(0, ['connect', '--session', 'agent', '--tab', String(f.tabs[0])]);
  assert.equal(a.transport, 'native');
  await f.latch(1, ['connect', '--session', 'agent', '--focus-emulation', 'on', '--tab', String(f.tabs[1])]);
  assert.equal((await f.latch(0, ['connect', '--session', 'agent', '--tab', String(f.tabs[0])])).alreadyConnected, true);
  assert.equal(valueOf(await f.pw(0, ['run-code', 'async(page)=>page.locator("#actor").innerText()'])), f.run + ':a');
  assert.equal(valueOf(await f.pw(1, ['run-code', 'async(page)=>page.locator("#actor").innerText()'])), f.run + ':b');
  await envOf(f.env, async () => assert.equal((await doctorCommand(setupOptions)).healthy, true));

  const packagedEvidence = path.join(f.workspaces[0], 'work/latch/packaged');
  const runtimeCLI = path.join(app.installedRoot, 'bin/latch');
  const flags = ['pw', '--session', 'agent', '--workspace', f.workspaces[0], '--evidence-dir', packagedEvidence];
  const result = JSON.parse(
    (
      await exec(runtimeCLI, [...flags, '--step', 'actor', '--inline', '--', 'run-code', 'async(page)=>page.locator("#actor").innerText()'], {
        cwd: f.workspaces[0],
        env: f.env,
      })
    ).stdout,
  );
  assert.equal(valueOf(result), f.run + ':a');
  await assert.rejects(
    exec(runtimeCLI, [...flags, '--step', 'expected-error', '--expect-error', 'PLAYWRIGHT_ERROR', '--', 'run-code', 'async(page)=>{throw new Error("installed-kit-action-failure")}'], {
      cwd: f.workspaces[0],
      env: f.env,
    }),
    e => e.code === 1 && JSON.parse(e.stderr).error.diagnostics.upstreamError.includes('installed-kit-action-failure'),
  );
  for (let i = 0; i < 2; i++) {
    await f.latch(i, ['disconnect', '--session', 'agent', ...(i === 0 ? ['--evidence-dir', packagedEvidence, '--step', 'cleanup'] : [])]);
  }
  const report = JSON.parse(await fs.readFile(path.join(packagedEvidence, 'result.json')));
  assert.equal(report.cleanup.status, 'confirmed');
  assert.equal(report.integrity.verified, true);
  assert.equal(report.run.software.provenance, 'descriptor-reported');
  assert.equal(report.checks.find(c => c.id === 'expected-error').operation.helperExitCode, 1);
  assert.equal(f.identity.capabilities.createTab, 1);

  const freshEvidence = path.join(f.workspaces[0], 'work/latch/fresh-packaged');
  try {
    const opened = await f.latch(0, [
      'open',
      '--session',
      'fresh',
      '--url',
      app.origin + '/root#' + encodeURIComponent(f.run + ':packaged-fresh'),
      '--focus-emulation',
      'on',
      '--evidence-dir',
      freshEvidence,
      '--step',
      'open',
      '--inline',
    ]);
    assert.equal(opened.created, true);
    assert.ok(!f.tabs.includes(opened.tabId));
    await f.latch(0, [
      'pw',
      '--session',
      'fresh',
      '--evidence-dir',
      freshEvidence,
      '--step',
      'actor',
      '--expect-result',
      JSON.stringify(f.run + ':packaged-fresh'),
      '--',
      'run-code',
      'async(page)=>page.locator("#actor").innerText()',
    ]);
    await f.latch(0, ['pw', '--session', 'fresh', '--evidence-dir', freshEvidence, '--step', 'capture', '--', 'screenshot']);
    await f.latch(0, ['disconnect', '--session', 'fresh', '--evidence-dir', freshEvidence, '--step', 'cleanup']);
    const freshReport = JSON.parse(await fs.readFile(path.join(freshEvidence, 'result.json')));
    assert.equal(freshReport.cleanup.status, 'confirmed');
    assert.equal(freshReport.integrity.verified, true);
  } finally {
    await f.latch(0, ['disconnect', '--session', 'fresh']).catch(() => {});
  }
  await fs.writeFile(
    path.join(f.evidence, 'installed-kit.json'),
    JSON.stringify({headless: true, versions: f.versions, launchArgs: f.launchArgs, verified: true}, null, 2),
  );
  console.log('Installed kit: ' + f.evidence);
});
