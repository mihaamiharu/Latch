import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fault} from '../extension/protocol.js';
import {redact} from './playwright.mjs';
import {isSameRegularFile} from './platform.mjs';

export const LIMITS = Object.freeze({
  commands: 256,
  ledgerBytes: 8 * 1024 * 1024,
  eventBytes: 16384,
  textBytes: 2 * 1024 * 1024,
  artifactBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
});

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const idPattern = /^[a-zA-Z0-9_-]{1,60}$/;

const secretKey =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|(?:x[-_])?api[_-]?key|x-auth-token|x-access-token|endpoint|cdpEndpoint)$/i;

export function scrub(value, depth = 0) {
  if (depth > 24) return '[depth limit]';
  if (typeof value === 'string') {
    const cleaned = redact(value)
      .replace(/((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
      .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]+/gi, '$1 [redacted]')
      .replace(/([#?&](?:token|access_token|refresh_token|id_token|key|code|session|sessionid|password|signature|x-amz-signature)=)[^\s&"<>]+/gi, '$1[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
    // Results sometimes contain another JSON layer (Playwright's result).
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object') return JSON.stringify(scrub(parsed, depth + 1));
    } catch {}
    return cleaned;
  }
  if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey.test(k) || (k === 'value' && secretKey.test(value.name || '')) ? '[redacted]' : scrub(v, depth + 1),
      ]),
    );
  }
  return value;
}

export async function regularFile(file, maximum = LIMITS.textBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || (process.getuid && stat.uid !== process.getuid())) {
    throw fault('EVIDENCE_FILE_UNSAFE', 'Evidence must be a bounded regular file owned by this user.');
  }
  const handle = await fs.open(file, 'r');
  try {
    const actual = await handle.stat();
    if (!(await isSameRegularFile(stat, actual, file))) {
      throw fault('EVIDENCE_CHANGED', 'Evidence changed while opening it.');
    }
    if (actual.size > maximum) throw fault('EVIDENCE_LIMIT', 'Evidence grew beyond its byte limit.');
    const data = await handle.readFile();
    if (data.length > maximum) throw fault('EVIDENCE_LIMIT', 'Evidence grew beyond its byte limit.');
    return data;
  } finally {
    await handle.close();
  }
}

export async function directory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw fault('EVIDENCE_DIRECTORY_UNSAFE', 'Evidence directories must be owned physical directories.');
  }
}

export async function exclusive(file, data) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomic(file, data) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw fault('EVIDENCE_FILE_UNSAFE', 'Refusing to replace a nonregular evidence file.');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await exclusive(temporary, data);
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(e => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

export async function append(dir, event) {
  const line = JSON.stringify(scrub(event)) + '\n';
  if (Buffer.byteLength(line) > LIMITS.eventBytes) throw fault('EVIDENCE_LIMIT', 'Command metadata exceeded the event limit.');
  const file = path.join(dir, 'commands.jsonl');
  const prior = await regularFile(file, LIMITS.ledgerBytes);
  if (prior.length && prior.at(-1) !== 10) {
    throw fault('EVIDENCE_LEDGER_PARTIAL', 'The command ledger has a partial tail; preserve it and render offline.');
  }
  if (prior.length + Buffer.byteLength(line) > LIMITS.ledgerBytes) {
    throw fault('EVIDENCE_LIMIT', 'The command ledger reached its limit.');
  }
  const handle = await fs.open(file, 'a');
  try {
    const data = Buffer.from(line);
    const written = await handle.write(data);
    if (written.bytesWritten !== data.length) throw fault('EVIDENCE_WRITE_PARTIAL', 'The command event was not fully written.');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readRun(dir) {
  await directory(dir);
  const run = JSON.parse(await regularFile(path.join(dir, 'run.json'), 32768));
  if (
    run.schema !== 1 ||
    typeof run.runId !== 'string' ||
    !idPattern.test(run.session || '') ||
    typeof run.workspace !== 'string' ||
    !idPattern.test(run.profile || '')
  ) {
    throw fault('EVIDENCE_SCHEMA_UNSUPPORTED', 'Unknown evidence identity; preserve this directory.');
  }
  await directory(path.join(dir, 'raw'));
  await directory(path.join(dir, 'screenshots'));
  return run;
}

export async function ledger(dir) {
  const data = await regularFile(path.join(dir, 'commands.jsonl'), LIMITS.ledgerBytes);
  const lines = data.toString('utf8').split('\n');
  const partialTail = lines.pop();
  const events = lines.filter(Boolean).map(line => JSON.parse(line));
  if (
    events.length > LIMITS.commands * 2 ||
    events.some(e => e.schema !== 1 || !['started', 'finished'].includes(e.event) || !idPattern.test(e.step || ''))
  ) {
    throw fault('EVIDENCE_LEDGER_INVALID', 'Invalid or oversized command ledger.');
  }
  for (const event of events) {
    if (
      event.event === 'started' &&
      (!['application', 'adapter', 'environment', 'capture', 'operation', 'infrastructure'].includes(event.kind) ||
        typeof event.command !== 'string' ||
        !/^[a-z-]{1,80}$/.test(event.command))
    ) {
      throw fault('EVIDENCE_LEDGER_INVALID', 'Invalid recorded command.');
    }
    if (
      event.event === 'finished' &&
      (!['pass', 'fail', 'blocked', 'unknown'].includes(event.check?.status) ||
        !Array.isArray(event.artifacts) ||
        event.artifacts.length > 2 ||
        event.artifacts.some(
          a => !Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > LIMITS.artifactBytes || !/^[a-f0-9]{64}$/.test(a.sha256 || ''),
        ))
    ) {
      throw fault('EVIDENCE_LEDGER_INVALID', 'Invalid completion record.');
    }
  }
  return {events, partialTail: !!partialTail, sha256: digest(data)};
}

export function relativeArtifact(name) {
  if (!/^(raw|screenshots)\/[a-zA-Z0-9_-]+\.(json|yaml|png)$/.test(name)) {
    throw fault('EVIDENCE_PATH_INVALID', 'Invalid evidence artifact path.');
  }
  return name;
}

export async function artifact(dir, name, type, maximum = LIMITS.artifactBytes) {
  relativeArtifact(name);
  await directory(path.join(dir, path.dirname(name)));
  const data = await regularFile(path.join(dir, name), maximum);
  return {path: name, type, bytes: data.length, sha256: digest(data)};
}
