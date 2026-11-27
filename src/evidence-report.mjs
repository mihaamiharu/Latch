import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {readRun, ledger, artifact, atomic, scrub, relativeArtifact, LIMITS} from './evidence-storage.mjs';

const text = value =>
  String(value ?? 'N/A')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_\[\]|]/g, '\\$&')
    .replace(/[\r\n]/g, ' ');

const short = value => text(typeof value === 'string' ? value.slice(0, 240) : JSON.stringify(value)?.slice(0, 240));

export async function inspectEvidence(dir, {verifyArtifacts = true} = {}) {
  dir = path.resolve(dir);
  const run = await readRun(dir);
  const history = await ledger(dir);
  const starts = new Map();
  const finishes = new Map();
  for (const event of history.events) {
    if (event.runId !== run.runId) throw fault('EVIDENCE_IDENTITY_MISMATCH', 'Another run appears in this evidence ledger.');
    const map = event.event === 'started' ? starts : finishes;
    if (map.has(event.step) || (event.event === 'finished' && !starts.has(event.step))) {
      throw fault('EVIDENCE_LEDGER_INVALID', 'Duplicate or orphan command event.');
    }
    map.set(event.step, event);
  }
  const checks = [];
  const artifacts = [];
  const problems = [];
  let bytes = 0;
  for (const start of starts.values()) {
    const finish = finishes.get(start.step);
    checks.push({
      id: start.step,
      kind: start.kind,
      command: start.command,
      expected: start.expected,
      status: finish?.check?.status || 'unknown',
      observed: finish?.check?.observed ?? 'No durable completion event; action outcome is unknown.',
      operation: finish?.operation || {outcome: 'unknown', helperExitCode: null, upstreamExitCode: null},
      evidence: (finish?.artifacts || [])
        .map(a => a.path)
        .filter(p => {
          try {
            relativeArtifact(p);
            return true;
          } catch {
            return false;
          }
        }),
      startedAt: start.at,
      finishedAt: finish?.at || null,
    });
    for (const indexed of finish?.artifacts || []) {
      try {
        if (!verifyArtifacts) {
          relativeArtifact(indexed.path);
          bytes += indexed.bytes;
          if (bytes > LIMITS.totalBytes) throw fault('EVIDENCE_LIMIT', 'Indexed evidence exceeds the run byte limit.');
          artifacts.push({...indexed, valid: null});
          continue;
        }
        const actual = await artifact(dir, indexed.path, indexed.type);
        bytes += actual.bytes;
        if (bytes > LIMITS.totalBytes) throw fault('EVIDENCE_LIMIT', 'Indexed evidence exceeds the run byte limit.');
        const valid = actual.bytes === indexed.bytes && actual.sha256 === indexed.sha256;
        artifacts.push({...indexed, valid});
        if (!valid) problems.push({path: indexed.path, code: 'EVIDENCE_HASH_CHANGED'});
      } catch (error) {
        artifacts.push({...indexed, valid: false});
        problems.push({path: indexed.path, code: error.code || 'EVIDENCE_UNREADABLE'});
      }
    }
  }
  if (history.partialTail) problems.push({code: 'EVIDENCE_LEDGER_PARTIAL'});
  const disconnected = [...starts.values()].filter(e => e.command === 'disconnect').at(-1);
  const cleanupResult = disconnected && finishes.get(disconnected.step);
  const cleanup = cleanupResult?.cleanup?.confirmed
    ? {status: 'confirmed', step: disconnected.step, preservedUserTabs: cleanupResult.cleanup.preservedUserTabs}
    : {status: cleanupResult ? 'failed' : 'unconfirmed', step: disconnected?.step || null};
  const assertions = checks.filter(c => ['application', 'adapter'].includes(c.kind));
  const infrastructure = checks.filter(c => c.kind === 'infrastructure');
  const status = [...assertions, ...infrastructure.filter(c => c.command !== 'disconnect')].some(c => c.status === 'fail')
    ? 'fail'
    : [...assertions, ...infrastructure.filter(c => c.command !== 'disconnect')].some(c => c.status === 'blocked')
      ? 'blocked'
      : !assertions.length ||
          assertions.some(c => c.status !== 'pass') ||
          checks.some(c => c.operation.outcome === 'unknown' && c.status !== 'pass' && c.command !== 'disconnect')
        ? 'unknown'
        : 'pass';
  const connected = [...finishes.values()].find(e => e.connection?.connected);
  return {
    schema: 1,
    run,
    generatedAt: new Date().toISOString(),
    ledgerSHA256: history.sha256,
    outcome: status,
    applicationOutcome: checks.some(c => c.kind === 'application')
      ? checks.some(c => c.kind === 'application' && c.status === 'fail')
        ? 'fail'
        : checks.some(c => c.kind === 'application' && c.status === 'blocked')
          ? 'blocked'
          : checks.filter(c => c.kind === 'application').every(c => c.status === 'pass')
            ? 'pass'
            : 'unknown'
      : 'unknown',
    connection: connected?.connection || null,
    cleanup,
    checks,
    artifacts,
    integrity: {
      verified: problems.length ? false : verifyArtifacts ? true : null,
      mode: verifyArtifacts ? 'current-files' : 'capture-time-index',
      problems,
    },
    limitations: [
      'Command success alone does not establish an application PASS.',
      'Unfinished commands and lost responses have unknown application outcomes; never replay them to regenerate evidence.',
      'Text redaction covers recognized credentials and headers; page content and screenshots can still contain private data. No automatic visual redaction is promised.',
      'Client and permission claims retain their supplied provenance; the CLI does not inspect agent transcripts or infer sandbox policy.',
    ],
  };
}

export async function renderEvidence(dir, options) {
  dir = path.resolve(dir);
  const result = await inspectEvidence(dir, options);
  const lines = [
    '# Latch verification report',
    '',
    `Outcome: **${result.outcome.toUpperCase()}** · Cleanup: **${result.cleanup.status}** · Integrity: **${result.integrity.verified === true ? 'verified' : result.integrity.verified === false ? 'needs attention' : 'capture-time hashes; offline verification pending'}**`,
    '',
    `Session: ${text(result.run.session)}. Workspace: ${text(result.run.workspace)}. Branch: ${text(result.run.branch)}.`,
    `Latch ${text(result.run.releaseVersion)}; Node ${text(result.run.nodeVersion)}.`,
    `Client/context: ${short(result.run.context)}.`,
    `Connection: ${short(result.connection)}.`,
    '',
    '| Check | Kind | Result | Expected | Observed | Evidence |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const check of result.checks) {
    lines.push(
      `| ${text(check.id)} | ${text(check.kind)} | ${text(check.status)} | ${short(check.expected)} | ${short(check.observed)}; exits: helper ${check.operation.helperExitCode ?? 'unknown'}, Playwright ${check.operation.upstreamExitCode ?? 'N/A'} | ${check.evidence.map(p => `[${text(path.basename(p))}](${p})`).join(', ')} |`,
    );
  }
  lines.push('', '## Screenshots', '');
  const shots = result.artifacts.filter(a => a.type === 'screenshot' && a.valid !== false && a.complete !== false);
  if (!shots.length) lines.push('No verified screenshots were captured.');
  for (const shot of shots.slice(0, 3)) lines.push(`![${text(path.basename(shot.path))}](${shot.path})`, '');
  if (shots.length > 3) lines.push('Additional screenshots are linked in the checks above.');
  lines.push('', '## Limitations', '', ...result.limitations.map(s => '- ' + s));
  if (result.integrity.verified === false) lines.push('', 'Integrity problems: ' + short(result.integrity.problems));
  lines.push('', '[Machine result](result.json) · [Command ledger](commands.jsonl)', '');
  await atomic(path.join(dir, 'result.json'), JSON.stringify(scrub(result), null, 2) + '\n');
  await atomic(path.join(dir, 'report.md'), lines.join('\n'));
  return {
    directory: dir,
    report: path.join(dir, 'report.md'),
    result: path.join(dir, 'result.json'),
    outcome: result.outcome,
    cleanup: result.cleanup.status,
    integrity: result.integrity.verified,
    checks: result.checks.length,
    artifacts: result.artifacts.length,
  };
}
