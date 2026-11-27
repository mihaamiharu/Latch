import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {inspectEvidence} from './evidence-report.mjs';
import {regularFile, exclusive, relativeArtifact, digest, LIMITS} from './evidence-storage.mjs';

export async function exportEvidence({directory, destination, include}) {
  const source = await inspectEvidence(directory);
  if (!source.integrity.verified) {
    throw fault('EVIDENCE_INTEGRITY_FAILED', 'Repair/review source integrity before exporting selected evidence.');
  }
  const selected = [...new Set(include || [])];
  if (!selected.length) {
    throw fault('INVALID_ARGUMENT', 'Explicitly select artifact paths with --include; nothing is exported by default.');
  }
  for (const name of selected) {
    relativeArtifact(name);
    if (!source.artifacts.some(a => a.path === name && a.valid)) {
      throw fault('EVIDENCE_EXPORT_UNKNOWN', 'Select only verified artifacts from result.json.');
    }
  }
  destination = path.resolve(destination);
  // Never merge into an existing folder, replace a prior export or include
  // arbitrary neighboring files. A failed partial export stays inspectable.
  await fs.mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
  await fs.mkdir(destination, {mode: 0o700});
  const checks = source.checks
    .filter(c => c.evidence.some(p => selected.includes(p)))
    .map(c => ({...c, evidence: c.evidence.filter(p => selected.includes(p))}));
  const exported = {
    schema: 1,
    type: 'selected-export',
    runId: source.run.runId,
    releaseVersion: source.run.releaseVersion,
    sourceLedgerSHA256: source.ledgerSHA256,
    exportedAt: new Date().toISOString(),
    cleanup: source.cleanup,
    checks,
    artifacts: source.artifacts.filter(a => selected.includes(a.path)),
    privacy:
      'Only explicitly selected artifacts and their check metadata are included. Review page content and screenshots before sharing; visual redaction is not automatic.',
  };
  const hashes = {};
  for (const name of selected) {
    const data = await regularFile(path.join(directory, name), LIMITS.artifactBytes);
    const expected = source.artifacts.find(a => a.path === name);
    if (digest(data) !== expected.sha256) {
      throw fault('EVIDENCE_CHANGED', 'A selected artifact changed during export; preserve the partial export.');
    }
    await fs.mkdir(path.dirname(path.join(destination, name)), {recursive: true, mode: 0o700});
    await exclusive(path.join(destination, name), data);
    hashes[name] = digest(data);
  }
  const json = JSON.stringify(exported, null, 2) + '\n';
  await exclusive(path.join(destination, 'export.json'), json);
  hashes['export.json'] = digest(json);
  const report = [
    '# Selected Latch evidence',
    '',
    exported.privacy,
    '',
    `Source run: ${exported.runId}. Cleanup: ${exported.cleanup.status}.`,
    '',
    ...selected.map(name =>
      source.artifacts.find(a => a.path === name).type === 'screenshot'
        ? `![${path.basename(name)}](${name})`
        : `[${path.basename(name)}](${name})`,
    ),
    '',
    '[Check metadata](export.json)',
    '',
  ].join('\n');
  await exclusive(path.join(destination, 'report.md'), report);
  hashes['report.md'] = digest(report);
  await exclusive(path.join(destination, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
  return {
    directory: destination,
    report: path.join(destination, 'report.md'),
    selectedArtifacts: selected.length,
    privacy: exported.privacy,
  };
}
