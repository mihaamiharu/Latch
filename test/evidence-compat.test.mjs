import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {evidenceApp, MiB} from './fixtures/evidence-app.mjs';
import {attachmentFixture} from './helpers/attachment-fixture.mjs';
import {screenshot, snapshot, responseBody, captureCLI} from './helpers/evidence-capture.mjs';

const enabled = process.env.LATCH_EVIDENCE === '1' && process.platform === 'darwin';
test('headless evidence integrity: native', {skip: !enabled, timeout: 360000}, async t => {
  const app = await evidenceApp();
  let f;
  t.after(async () => {
    await f?.close();
    await app.close();
  });
  f = await attachmentFixture(t, app, 'native');
  await f.connect(0, f.tabs[0]);
  const results = [];
  results.push(await screenshot(f, 0, 64, 64, 'A1-small-pixels'));
  results.push(await snapshot(f, 0, 10, 32, 'A1-small-dom'));
  results.push(await responseBody(f, app, 0, 'binary', 1024, 'A1-small-body'));
  if (process.env.LATCH_EVIDENCE_PROBE !== '1') {
    for (const [w, h] of [[512, 1024], [1024, 1024], [2048, 2048]]) {
      const r = await screenshot(f, 0, w, h, `A2-pixels-${w}`);
      assert.ok(r.bytes > MiB);
      results.push(r);
    }
    for (const n of [1024, 4096]) results.push(await snapshot(f, 0, n, 1100, 'A3-dom-' + n));
    for (const kind of ['text', 'binary']) {
      for (const size of [MiB, 4 * MiB, 16 * MiB]) results.push(await responseBody(f, app, 0, kind, size, `A4-${kind}-${size}`));
    }
  }
  const direct = await captureCLI(f, 0, ['run-code', "async(page)=>await page.evaluate(()=> '雪'.repeat(800000))"], {
    name: 'O2-direct-output',
  });
  assert.ok(direct.stdoutBytes > 2 * MiB);
  assert.equal(JSON.parse(direct.response.result), '雪'.repeat(800000));
  results.push({case: 'O2', stdoutBytes: direct.stdoutBytes, bytes: 2400000});
  const interrupted = await responseBody(f, app, 0, 'binary', MiB, 'A5-interrupt', {interrupt: true, expectFailure: true});
  assert.equal(JSON.parse(interrupted.response.result).ok, false);
  assert.equal(app.receipts.find(r => r.operation === 'A5-interrupt').state, 'interrupted');
  results.push({case: 'A5', completeArtifact: false, response: interrupted.response});
  const delayed = await responseBody(f, app, 0, 'binary', 1024, 'T1-delayed', {delay: 11000, expectFailure: true});
  assert.equal(!!delayed.response.isError, false, 'The valid awaited response must survive the inner deadline');
  assert.deepEqual(JSON.parse(delayed.response.result), {ok: true, bytes: 1024});
  results.push({case: 'T1', isError: !!delayed.response.isError, response: delayed.response, elapsedMs: delayed.elapsedMs});
  await fs.writeFile(
    path.join(f.evidence, 'evidence-report.json'),
    JSON.stringify({transport: 'native', versions: f.versions, headless: true, launchArgs: f.launchArgs, results}, null, 2),
  );
  await f.close();
  console.log(`Evidence results: ${f.evidence}`);
});
