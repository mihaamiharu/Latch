import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {CANDIDATE_KIT} from './helpers/candidate.mjs';
import {attachmentFixture} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';
import {installCommand, doctorCommand} from '../src/setup.mjs';

async function envOf(env, fn) {
  const keys = ['LATCH_CONFIG', 'LATCH_RUNTIME_DIR', 'PWTEST_DAEMON_SESSION_DIR'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) process.env[k] = env[k];
  try {
    return await fn();
  } finally {
    for (const k of keys) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]);
  }
}

test('exact installed candidate creates a central PNG filmstrip/YAML bundle, exports it and preserves the browser on finish', {
  skip: process.env.LATCH_EXPLORATION_INSTALLED !== '1',
  timeout: 180000,
}, async t => {
  const app = await evidenceApp();
  app.installed = true;
  app.minimalHostPath = true;
  app.artifactExtension = path.join(CANDIDATE_KIT, 'extension');
  let f;
  let setup;
  app.install = async ({temp, profile, env}) => {
    app.installedRoot = path.join(temp, 'installed runtime');
    setup = {
      kit: CANDIDATE_KIT,
      root: app.installedRoot,
      registrationRoot: path.join(profile, 'NativeMessagingHosts'),
      tasksDrained: true,
      extensionUnloaded: true,
    };
    await fs.writeFile(env.LATCH_CONFIG, '{"v":1,"profiles":{}}');
    await envOf(env, async () => {
      await installCommand(setup);
    });
  };
  t.after(async () => {
    await f?.close();
    await app.close();
  });
  f = await attachmentFixture(t, app, 'native');
  f.env.LATCH_CAPTURE = 'on';
  f.env.LATCH_ARTIFACT_ROOT = path.join(f.temp, 'library');

  const opened = await f.latch(0, [
    'open',
    app.origin + '/root#' + encodeURIComponent(f.run + ':installed'),
    '--focus-emulation', 'on',
    '--record',
    '--session', 'agent',
    '--objective', 'Installed exploration handoff',
  ]);
  assert.equal(opened.created, true);
  assert.ok(opened.library.runId);

  await f.latch(0, ['fill', '#value', 'installed-proof', '--session', 'agent', '--data-ref', 'seeded-input']);
  await f.latch(0, ['click', '#save', '--session', 'agent']);
  const annotation = path.join(f.temp, 'behavior.json');
  await fs.writeFile(annotation, JSON.stringify({kind: 'behavior', observed: 'Save displays the entered value', expected: null}));
  await f.latch(0, ['checkpoint', '--session', 'agent', '--annotation-file', annotation]);

  const done = await f.latch(0, ['finish', '--session', 'agent']);
  assert.equal(done.library.cleanup, 'confirmed');
  assert.equal(done.library.integrity, true);
  assert.ok(done.library.screenshots >= 3);

  const graph = JSON.parse(await fs.readFile(path.join(done.library.directory, 'exploration.json')));
  assert.ok(graph.final_states.some(s => s.status === 'captured'));
  assert.equal(graph.behaviors.length, 1);
  assert.equal(graph.behaviors[0].assertion_status, 'not_asserted');
  assert.equal(graph.screenshots.status, 'complete');
  assert.ok(graph.filmstrip.length >= 2);
  assert.ok(await fs.stat(path.join(done.library.directory, 'exploration.schema.json')));

  const exported = await f.latch(0, ['library', 'export', '--run', done.library.runId, '--destination', path.join(f.evidence, 'handoff')]);
  assert.equal(exported.exported, true);
  assert.equal((await f.latch(0, ['finish', '--session', 'agent'])).alreadyFinished, true);
  assert.ok((await f.latch(0, ['tabs'])).tabs.some(p => p.tabId === opened.tabId && p.owner === null));
  assert.equal((await envOf(f.env, () => doctorCommand(setup))).healthy, true);
});
