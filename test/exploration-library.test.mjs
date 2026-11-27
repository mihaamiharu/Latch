import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  allocateRun,
  saveMeta,
  loadMeta,
  runPath,
  lockRun,
  verifyArtifacts,
  boundRun,
  indexArtifact,
  scrub,
  PNG_SIGNATURE,
} from '../src/exploration-storage.mjs';
import {addStates, writeHandoff, validateExploration, actionOf} from '../src/exploration-model.mjs';
import {libraryCommand, saveReview, startLibraryServer, exportRun} from '../src/exploration-library.mjs';

const samplePngBase64 = () =>
  Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137])]).toString('base64');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-library-'));
  const prior = process.env.LATCH_ARTIFACT_ROOT;
  process.env.LATCH_ARTIFACT_ROOT = path.join(root, 'central artifacts');
  t.after(async () => {
    prior === undefined ? delete process.env.LATCH_ARTIFACT_ROOT : (process.env.LATCH_ARTIFACT_ROOT = prior);
    await fs.rm(root, {recursive: true, force: true});
  });
  const meta = await allocateRun(
    {workspace: root, session: 'agent', profile: 'work'},
    {objective: 'Explore checkout'},
  );
  return {root, meta, dir: await runPath(meta.id)};
}

const snapshot =
  '- heading "Checkout" [level=1] [ref=e1]\n- textbox "Email" [ref=e2]\n- button "Pay" [ref=e3]\n- button "Pay" [ref=e4]';

test('central runs are isolated by workspace and reject a second binding without mixing evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(allocateRun({workspace: f.root, session: 'agent', profile: 'work'}), {code: 'EXPLORATION_BUSY'});
  const other = await allocateRun({workspace: f.root + '/other', session: 'agent', profile: 'work'});
  assert.notEqual(other.id, f.meta.id);
  assert.equal((await boundRun(f.meta)).id, f.meta.id);
  assert.equal((await libraryCommand('list', {})).runs.length, 2);
});

test('handoff has observed locators, frame context, before/after screenshot filmstrip, and verified SHA-256 hashes', async t => {
  const {meta} = await fixture(t);
  const png64 = samplePngBase64();
  const state = await addStates(
    meta,
    {
      currentTargetId: 'page1',
      pages: [{targetId: 'page1', url: 'https://example.test', title: 'Checkout', snapshot, screenshot: png64, frames: []}],
    },
    {step: 'initial'},
  );
  assert.equal(state.elements.find(e => e.snapshot_ref === 'e3').ambiguous, true);
  assert.equal(state.screenshot, 'screenshots/state-00001.png');

  const after = await addStates(
    meta,
    {
      currentTargetId: 'page1',
      pages: [
        {
          targetId: 'page1',
          url: 'https://example.test/saved',
          title: 'Saved',
          snapshot: '- status [ref=e5]: Saved',
          screenshot: png64,
          frames: [{id: 'frame-1', url: 'https://frame.test', snapshot: '- textbox "Code" [ref=e6]'}],
        },
      ],
    },
    {final: true, step: 'final'},
  );
  actionOf(
    meta,
    {command: 'click', action: 'click', actionArgs: {target: 'e3'}, flags: {}},
    {step: 'click', before: state, after, startedAt: new Date().toISOString()},
  );
  meta.status = 'finished';
  await writeHandoff(meta);

  const dir = await runPath(meta.id);
  const source = await fs.readFile(path.join(dir, 'exploration.yaml'), 'utf8');
  assert.match(source, /schema_version: 1/);
  assert.match(source, /strategy: "role"/);
  assert.match(source, /final-page1-frame-1\.yaml/);
  assert.match(source, /screenshots\/state-00001\.png/);
  assert.match(source, /screenshots\/state-00002\.png/);
  assert.doesNotMatch(source, /await page/);
  assert.doesNotMatch(source, /\bvideo:/);

  const jsonHandoff = JSON.parse(await fs.readFile(path.join(dir, 'exploration.json'), 'utf8'));
  assert.equal(jsonHandoff.screenshots.status, 'complete');
  assert.equal(jsonHandoff.screenshots.count, 2);
  assert.equal(jsonHandoff.filmstrip.length, 1);
  assert.equal(jsonHandoff.filmstrip[0].before, 'screenshots/state-00001.png');
  assert.equal(jsonHandoff.filmstrip[0].after, 'screenshots/state-00002.png');

  assert.equal((await verifyArtifacts(await loadMeta(meta.id))).verified, true);
  await fs.appendFile(path.join(dir, state.snapshot), 'tampered');
  assert.equal((await verifyArtifacts(meta)).verified, false);
  await assert.rejects(exportRun(meta.id, path.join(meta.workspace, 'export')), {code: 'EVIDENCE_INTEGRITY_FAILED'});
});

test('QA review is separate and handoff export is self-contained and never merges destinations', async t => {
  const f = await fixture(t);
  await addStates(
    f.meta,
    {
      currentTargetId: 'p',
      pages: [{targetId: 'p', url: 'http://fixture', title: 'Fixture', snapshot, screenshot: samplePngBase64(), frames: []}],
    },
    {step: 'capture', final: true},
  );
  await writeHandoff(f.meta);
  await saveReview(f.meta.id, {decision: 'automate', note: 'Cover required fields'});
  assert.equal((await loadMeta(f.meta.id)).annotations.length, 0);
  const out = path.join(f.root, 'handoff');
  await exportRun(f.meta.id, out);
  assert.ok(await fs.stat(path.join(out, 'exploration.yaml')));
  assert.ok(await fs.stat(path.join(out, 'screenshots/state-00001.png')));
  assert.equal(JSON.parse(await fs.readFile(path.join(out, 'review.json'))).decision, 'automate');
  await assert.rejects(exportRun(f.meta.id, out), {code: 'EEXIST'});
});

test('schema rejects dangling transitions/filmstrip and symlinked artifacts fail verification', async t => {
  const f = await fixture(t);
  assert.throws(
    () => validateExploration({schema_version: 1, run_id: 'x', states: [], transitions: [{id: 'a', from: 'missing'}], final_states: []}),
    {code: 'EXPLORATION_SCHEMA_INVALID'},
  );
  assert.throws(
    () =>
      validateExploration({
        schema_version: 1,
        run_id: 'x',
        states: [],
        transitions: [],
        filmstrip: [{transition_id: 'missing', command: 'click', outcome: 'succeeded', before: null, after: null}],
        final_states: [],
      }),
    {code: 'EXPLORATION_SCHEMA_INVALID'},
  );
  await fs.writeFile(path.join(f.root, 'outside'), 'private');
  try {
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.dir, 'outside.yaml'));
  } catch (e) {
    if (e.code === 'EPERM') await fs.symlink(f.root, path.join(f.dir, 'outside.yaml'), 'junction');
    else throw e;
  }
  f.meta.artifacts = [{path: 'outside.yaml', type: 'snapshot', bytes: 7, sha256: 'x'}];
  await saveMeta(f.meta);
  assert.equal((await verifyArtifacts(f.meta)).verified, false);
});

test('a busy library writer blocks offline repair without blocking a browser-independent review', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const ready = new Promise(r => (entered = r));
  const barrier = new Promise(r => (release = r));
  const held = lockRun(f.meta.id, () => {
    entered();
    return barrier;
  });
  await ready;
  await assert.rejects(libraryCommand('repair', {run: f.meta.id}), {code: 'EXPLORATION_BUSY'});
  await saveReview(f.meta.id, {decision: 'investigate'});
  release();
  await held;
});

test('local reviewer escapes page text, renders interactive before/after filmstrip, serves PNG ranges and rejects foreign reviews', async t => {
  const f = await fixture(t);
  f.meta.objective = '<img src=x onerror=alert(1)>';
  const png64 = samplePngBase64();
  const s1 = await addStates(
    f.meta,
    {currentTargetId: 'p', pages: [{targetId: 'p', url: 'http://fixture', title: 'Start </script>', snapshot, screenshot: png64, frames: []}]},
    {step: 'initial'},
  );
  const s2 = await addStates(
    f.meta,
    {currentTargetId: 'p', pages: [{targetId: 'p', url: 'http://fixture/next', title: 'Next', snapshot, screenshot: png64, frames: []}]},
    {step: 'after'},
  );
  actionOf(
    f.meta,
    {command: 'click', action: 'click', actionArgs: {target: 'e3'}, flags: {}},
    {step: 'action-1', before: s1, after: s2, startedAt: new Date().toISOString()},
  );
  await writeHandoff(f.meta);

  const app = await startLibraryServer();
  t.after(() => app.close());

  const indexHtml = await (await fetch(app.url + '/')).text();
  assert.match(indexHtml, /before\/after screenshot filmstrip/i);
  assert.match(indexHtml, /2 screenshots/);

  const html = await (await fetch(app.url + '/run/' + f.meta.id)).text();
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Before \/ after filmstrip/);
  assert.match(html, /data-view-mode="split"/);
  assert.match(html, /screenshots\/state-00001\.png/);
  assert.match(html, /screenshots\/state-00002\.png/);
  assert.doesNotMatch(html, /Start <\/script>/);

  const range = await fetch(app.url + '/artifact/' + f.meta.id + '/screenshots/state-00001.png', {headers: {Range: 'bytes=0-7'}});
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), PNG_SIGNATURE);

  const denied = await fetch(app.url + '/review/' + f.meta.id, {
    method: 'POST',
    headers: {origin: 'https://foreign.test', 'content-type': 'application/json'},
    body: JSON.stringify({decision: 'automate'}),
  });
  assert.equal(denied.status, 403);

  const unsafe = await fetch(app.url + '/artifact/' + f.meta.id + '/..%2f..%2fconfig.json');
  assert.notEqual(unsafe.status, 200);
});

test('offline recovery fences a dead process lock and reconstructs committed states without replaying actions', async t => {
  const f = await fixture(t);
  const state = await addStates(
    f.meta,
    {currentTargetId: 'p', pages: [{targetId: 'p', url: 'http://fixture', title: 'Fixture', snapshot, screenshot: samplePngBase64(), frames: []}]},
    {step: 'capture'},
  );
  const stale = {
    ...f.meta,
    states: [],
    artifacts: [],
    pending: {step: 'click', command: 'click', from: state.id, action: {type: 'click', values_stored: false}},
  };
  await saveMeta(stale);
  await fs.writeFile(
    path.join(f.dir, 'commands.jsonl'),
    JSON.stringify({schema: 1, event: 'finished', step: 'click', operation: {outcome: 'succeeded'}, artifacts: []}) + '\n',
  );
  const root = process.env.LATCH_ARTIFACT_ROOT;
  const lock = path.join(root, 'locks', f.meta.id);
  await fs.mkdir(lock);
  await fs.writeFile(
    path.join(lock, 'owner.json'),
    JSON.stringify({pid: 2147483647, identity: 'pid:2147483647', nonce: '11111111-1111-4111-8111-111111111111'}),
  );
  const result = await libraryCommand('repair', {run: f.meta.id});
  assert.equal(result.replayedActions, 0);
  const restored = await loadMeta(f.meta.id);
  assert.equal(restored.states.length, 1);
  assert.equal(restored.actions[0].outcome, 'succeeded');
  assert.equal(restored.actions[0].to, null);
  assert.equal(restored.actions[0].filmstrip.before, 'screenshots/state-00001.png');
  assert.equal(restored.actions[0].filmstrip.after, null);
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.finals.length, 0);
  assert.ok(await fs.stat(path.join(root, 'lock-audit', f.meta.id + '-11111111-1111-4111-8111-111111111111')));
});

test('scrub redacts credentials, tokens, cookies, and nested secrets across artifacts', () => {
  const dirty = {
    authorization: 'Bearer secret_jwt_token',
    nested: JSON.stringify({cookie: 'sid=super_secret', url: 'https://user:pass@example.test/?access_token=abc123'}),
    pair: {name: 'Set-Cookie', value: 'private_cookie'},
    text: 'Authorization: Basic dXNlcjpwYXNz\nhttps://example.test/?token=secret_q',
  };
  const cleaned = JSON.stringify(scrub(dirty));
  assert.doesNotMatch(cleaned, /secret_jwt_token|super_secret|user:pass|abc123|private_cookie|dXNlcjpwYXNz|secret_q/);
});
