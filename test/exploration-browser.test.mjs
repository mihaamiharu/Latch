import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {attachmentFixture} from './helpers/attachment-fixture.mjs';
import {evidenceApp} from './fixtures/evidence-app.mjs';
import {startLibraryServer} from '../src/exploration-library.mjs';
import {suiteGate} from './helpers/browser-suite.mjs';

test('managed exploration captures centrally, finalizes YAML/filmstrip, reviews locally and exports a complete handoff', {
  // `latch open` creates a background tab (active:false). In headless Chrome for
  // Testing on Windows its first frame after a DOM change takes 3-12s, so the
  // post-click state misses the 10s PNG budget and the run is "partial".
  skip: suiteGate('LATCH_EXPLORATION'),
  timeout: 180000,
}, async t => {
  const app = await evidenceApp();
  let f;
  let ui;
  const old = process.env.LATCH_ARTIFACT_ROOT;
  t.after(async () => {
    await ui?.close();
    await f?.close();
    await app.close();
    old === undefined ? delete process.env.LATCH_ARTIFACT_ROOT : (process.env.LATCH_ARTIFACT_ROOT = old);
  });
  f = await attachmentFixture(t, app, 'native');
  f.env.LATCH_CAPTURE = 'on';
  f.env.LATCH_ARTIFACT_ROOT = path.join(f.temp, 'central artifacts');
  process.env.LATCH_ARTIFACT_ROOT = f.env.LATCH_ARTIFACT_ROOT;

  const opened = await f.latch(0, [
    'open',
    app.origin + '/root#' + encodeURIComponent(f.run + ':exploration'),
    '--session', 'agent',
    '--focus-emulation', 'on',
    '--record',
    '--objective', 'Required-field exploration',
    '--environment', 'local fixture',
  ]);
  assert.equal(opened.created, true);
  assert.ok(opened.library.runId);
  const run = opened.library.runId;
  const initial = JSON.parse(await fs.readFile(path.join(opened.library.directory, 'exploration.json')));
  assert.ok(initial.states.length > 0, 'Initial states captured');
  const field = initial.states[0].elements.find(e => e.role === 'textbox');
  assert.ok(field);
  await f.latch(0, ['fill', field.snapshot_ref, 'proof', '--session', 'agent', '--data-ref', 'synthetic-value']);
  const afterFill = JSON.parse(await fs.readFile(path.join(opened.library.directory, 'exploration.json')));
  const state = afterFill.states.at(-1);
  const button = state.elements.find(e => e.role === 'button' && e.name === 'Save');
  assert.ok(button);
  await f.latch(0, ['click', button.snapshot_ref, '--session', 'agent']);
  await f.latch(0, ['checkpoint', 'Save displays the supplied value. Expected business behavior needs QA review.', '--session', 'agent']);
  const finished = await f.latch(0, ['finish', '--session', 'agent']);
  assert.equal(finished.library.cleanup, 'confirmed');
  assert.equal(finished.library.integrity, true);

  const handoff = JSON.parse(await fs.readFile(path.join(opened.library.directory, 'exploration.json')));
  assert.ok(handoff.transitions.some(a => a.action.type === 'fill'));
  assert.ok(handoff.final_states.some(s => s.status === 'captured'));
  assert.ok(handoff.states.some(s => s.elements.some(e => e.locator_candidate?.name === 'Save')));
  assert.ok(handoff.filmstrip.length >= 2);
  assert.equal(handoff.screenshots.status, 'complete');

  const listed = await f.latch(0, ['library', 'list']);
  assert.ok(listed.runs.some(r => r.id === run));
  ui = await startLibraryServer();
  const html = await (await fetch(`${ui.url}/run/${run}`)).text();
  assert.match(html, /Before \/ after filmstrip/);
  const exported = await f.latch(0, ['library', 'export', '--run', run, '--destination', path.join(f.evidence, 'handoff')]);
  assert.equal(exported.exported, true);
  assert.ok(await fs.stat(path.join(exported.directory, 'handoff.yaml')));
});

test('YAML includes owned popups, frame locators, transitions and final states without claiming opaque script coverage', {
  skip: suiteGate('LATCH_EXPLORATION'),
  timeout: 180000,
}, async t => {
  const {popupApp} = await import('./fixtures/popup-app.mjs');
  const app = await popupApp();
  let f;
  t.after(async () => {
    await f?.close();
    await app.close();
  });
  f = await attachmentFixture(t, app, 'native');
  f.env.LATCH_CAPTURE = 'on';
  f.env.LATCH_ARTIFACT_ROOT = path.join(f.temp, 'central artifacts');
  const opened = await f.latch(0, [
    'open',
    app.origin + '/root#' + encodeURIComponent(f.run + ':map'),
    '--session', 'agent',
    '--focus-emulation', 'on',
    '--record',
    '--objective', 'Popup and frame map',
  ]);
  await f.latch(0, ['click', '#window', '--session', 'agent']);
  await f.latch(0, ['fill', '#value', 'child-data', '--session', 'agent', '--data-ref', 'seeded-child-value']);
  await f.latch(0, ['checkpoint', 'Child form is present.', '--session', 'agent']);
  const finished = await f.latch(0, ['finish', '--session', 'agent']);
  assert.equal(finished.library.cleanup, 'confirmed');
  const handoff = JSON.parse(await fs.readFile(path.join(opened.library.directory, 'exploration.json')));
  assert.ok(handoff.pages.length >= 1);
  assert.ok(handoff.final_states.some(s => s.status === 'captured'));
  assert.ok(handoff.filmstrip.length >= 2);
});
