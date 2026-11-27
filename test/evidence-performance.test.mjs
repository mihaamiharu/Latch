import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {evidenceApp, MiB} from './fixtures/evidence-app.mjs';
import {attachmentFixture} from './helpers/attachment-fixture.mjs';
import {screenshot, snapshot} from './helpers/evidence-capture.mjs';

const exec = promisify(execFile);
const enabled = process.env.LATCH_EVIDENCE_PERFORMANCE === '1' && process.platform === 'darwin';
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function processes(f, daemonPIDs) {
  const {stdout} = await exec('ps', ['-ax', '-o', 'pid=,ppid=,rss=,pcpu=,command=']);
  const rows = stdout
    .split('\n')
    .map(l => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      return m && {pid: +m[1], ppid: +m[2], rssKiB: +m[3], cpu: +m[4], command: m[5]};
    })
    .filter(Boolean);
  const selected = new Set([f.browserPID, ...daemonPIDs]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of rows) {
      if (selected.has(r.ppid) && !selected.has(r.pid)) {
        selected.add(r.pid);
        changed = true;
      }
    }
  }
  const owned = rows
    .filter(r => selected.has(r.pid) && (r.pid === f.browserPID || r.ppid !== 1 || r.command.includes('cliDaemon.js')))
    .map(({command, ...r}) => r);
  return {rssBytes: owned.reduce((n, p) => n + p.rssKiB * 1024, 0), cpuPercentSum: owned.reduce((n, p) => n + p.cpu, 0), processes: owned};
}

async function daemons(f) {
  const pids = [];
  for (const dir of await fs.readdir(path.join(f.temp, 'daemon')).catch(() => [])) {
    const log = path.join(f.temp, 'daemon', dir, 'agent.err');
    const result = await exec('lsof', ['-t', log]).catch(() => ({stdout: ''}));
    for (const pid of result.stdout.trim().split('\n')) if (/^\d+$/.test(pid)) pids.push(Number(pid));
  }
  return [...new Set(pids)];
}

test('headless native evidence performance and five-cycle resource cohort', {skip: !enabled, timeout: 480000}, async t => {
  const app = await evidenceApp();
  let f;
  t.after(async () => {
    await f?.close();
    await app.close();
  });
  f = await attachmentFixture(t, app, 'native');
  const samples = [];
  let warm;
  let peak = 0;
  let last;
  const pidSet = new Set();
  let busy = false;
  let sampleError;
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const p = await processes(f, [...pidSet]);
      last = p;
      peak = Math.max(peak, p.rssBytes);
    } catch (e) {
      sampleError = e;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void sample(), 250);
  t.after(() => clearInterval(timer));
  for (let round = 0; round < 6; round++) {
    const activeBeforeAttach = (await f.latch(0, ['tabs'])).tabs.find(tab => tab.tabId === f.tabs[0]).active;
    if (round > 0) assert.equal(activeBeforeAttach, true, 'Measured attach must start with the intended tab active');
    const start = performance.now();
    await f.connect(0, f.tabs[0]);
    const attachMs = performance.now() - start;
    const pids = await daemons(f);
    assert.ok(pids.length, 'Exact private daemon stderr must identify its process');
    for (const pid of pids) pidSet.add(pid);
    const focus = await f.pw(0, ['run-code', 'async(page)=>{await page.bringToFront();return await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus()}))}']);
    const focusState = JSON.parse(focus.result);
    assert.deepEqual(focusState, {visibility: 'visible', focused: true});
    const snap = await snapshot(f, 0, 64, 256, `P-snapshot-${round}`);
    const image = await screenshot(f, 0, 512, 1024, `P-pixels-${round}`);
    const live = await f.nativeStatus();
    assert.ok(live.sessions.every(s => s.pending === 0 && !s.stopped));
    const stop = performance.now();
    await f.latch(0, ['disconnect', '--session', 'agent']);
    const disconnectMs = performance.now() - stop;
    assert.equal((await f.nativeStatus()).sessions.length, 0);
    assert.ok((await f.latch(0, ['tabs'])).tabs.every(t => t.owner === null));
    await new Promise(r => setTimeout(r, 5000));
    await sample();
    const after = last;
    if (round === 0) warm = after;
    else {
      samples.push({
        round,
        attachMs,
        disconnectMs,
        snapshotMs: snap.elapsedMs,
        snapshotBytes: snap.bytes,
        screenshotMs: image.elapsedMs,
        screenshotBytes: image.bytes,
        screenshotSha256: image.sha256,
        activeBeforeAttach,
        focusState,
        after,
        liveNative: live.sessions.map(({metrics, pending, stopped}) => ({metrics, pending, stopped})),
      });
    }
    if (round > 1) for (const file of [snap.path, image.path]) await fs.unlink(file);
  }
  clearInterval(timer);
  if (sampleError) throw sampleError;
  const summary = {
    operations: Object.fromEntries(
      ['attachMs', 'snapshotMs', 'screenshotMs', 'disconnectMs'].map(key => [
        key,
        {median: median(samples.map(x => x[key])), min: Math.min(...samples.map(x => x[key])), max: Math.max(...samples.map(x => x[key]))},
      ]),
    ),
    warmRSS: warm.rssBytes,
    finalRSS: samples.at(-1).after.rssBytes,
    peakRSS: peak,
    growth: samples.at(-1).after.rssBytes - warm.rssBytes,
  };
  const concerns = [];
  if (summary.growth > Math.max(64 * MiB, summary.warmRSS * 0.25)) concerns.push('native RSS growth threshold');
  const report = {
    headless: true,
    confirmationReason: process.env.LATCH_PERFORMANCE_CONFIRMATION || 'initial cohort',
    cpu: os.cpus()[0].model,
    os: os.release(),
    versions: f.versions,
    launchArgs: f.launchArgs,
    samples,
    summary,
    concerns,
    daemonPIDs: [...pidSet],
  };
  await fs.writeFile(path.join(f.evidence, 'performance-report.json'), JSON.stringify(report, null, 2));
  await f.close();
  console.log(`Performance evidence: ${f.evidence}`);
  assert.deepEqual(concerns, [], 'Investigate concerns and, if needed, run one confirmation cohort; do not discard samples');
});
