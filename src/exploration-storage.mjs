import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fault} from '../extension/protocol.js';
import {redact} from './redact.mjs';
import {
  libraryRoot as platformLibraryRoot,
  isProcessAlive,
  isSameRegularFile,
  privateDirectory,
} from './platform.mjs';

export const LIMITS = Object.freeze({
  commands: 256,
  ledgerBytes: 8 * 1024 * 1024,
  eventBytes: 16384,
  textBytes: 2 * 1024 * 1024,
  artifactBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
});

export const MAX_RUN = 512 * 1024 * 1024;
export const idPattern = /^[a-zA-Z0-9_-]{1,60}$/;
export const runPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const isValidPng = buffer =>
  Buffer.isBuffer(buffer) && buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');

const secretKey =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|(?:x[-_])?api[_-]?key|x-auth-token|x-access-token|endpoint|cdpEndpoint)$/i;

/**
 * Recursively redact credentials, cookies, tokens, and internal bridge endpoints.
 */
export function scrub(value, depth = 0) {
  if (depth > 24) return '[depth limit]';
  if (typeof value === 'string') {
    const cleaned = redact(value)
      .replace(
        /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*[:=]\s*)[^\r\n]+/gi,
        '$1[redacted]',
      )
      .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]+/gi, '$1 [redacted]')
      .replace(
        /([#?&](?:token|access_token|refresh_token|id_token|key|code|session|sessionid|password|signature|x-amz-signature)=)[^\s&"<>]+/gi,
        '$1[redacted]',
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
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
    throw fault('EVIDENCE_FILE_UNSAFE', 'Artifact must be a bounded regular file owned by this user.');
  }
  const handle = await fs.open(file, 'r');
  try {
    const actual = await handle.stat();
    if (!(await isSameRegularFile(stat, actual, file))) {
      throw fault('EVIDENCE_CHANGED', 'Artifact changed while opening it.');
    }
    if (actual.size > maximum) throw fault('EVIDENCE_LIMIT', 'Artifact grew beyond its byte limit.');
    const data = await handle.readFile();
    if (data.length > maximum) throw fault('EVIDENCE_LIMIT', 'Artifact grew beyond its byte limit.');
    return data;
  } finally {
    await handle.close();
  }
}

export async function directory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw fault('EVIDENCE_DIRECTORY_UNSAFE', 'Library directories must be owned physical directories.');
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
      throw fault('EVIDENCE_FILE_UNSAFE', 'Refusing to replace a nonregular artifact file.');
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

export function bounded(value, maximum = 4096) {
  if (value === undefined) return null;
  const cleaned = scrub(value);
  const data = JSON.stringify(cleaned);
  return Buffer.byteLength(data) > maximum
    ? {truncated: true, originalBytes: Buffer.byteLength(data), preview: data.slice(0, 512)}
    : cleaned;
}

async function processIdentity(pid) {
  return isProcessAlive(pid) ? `pid:${pid}` : null;
}

export const libraryRoot = () => platformLibraryRoot();
export const bindingKey = ({workspace, session, profile = 'work'}) => digest(JSON.stringify([workspace, session, profile]));

export async function libraryDirs() {
  const root = libraryRoot();
  for (const p of [
    root,
    path.join(root, 'runs'),
    path.join(root, 'bindings'),
    path.join(root, 'meta'),
    path.join(root, 'locks'),
    path.join(root, 'lock-audit'),
  ]) {
    await privateDirectory(p);
  }
  return root;
}

export async function runPath(id) {
  if (!runPattern.test(id || '')) throw fault('INVALID_RUN', 'Use a run ID from library list.');
  const root = await libraryDirs();
  const dir = path.join(root, 'runs', id);
  await directory(dir);
  return dir;
}

export async function loadMeta(id) {
  if (!runPattern.test(id || '')) throw fault('INVALID_RUN', 'Invalid run ID.');
  const meta = JSON.parse(await regularFile(path.join(await libraryDirs(), 'meta', id + '.json'), 32 * 1024 * 1024));
  if (
    meta.schema !== 1 ||
    meta.id !== id ||
    !['states', 'actions', 'annotations', 'gaps', 'finals', 'artifacts'].every(k => Array.isArray(meta[k]))
  ) {
    throw fault('EXPLORATION_SCHEMA_INVALID', 'Run metadata is invalid; preserved for inspection.');
  }
  if (!Array.isArray(meta.notices)) meta.notices = [];
  return meta;
}

export async function saveMeta(meta) {
  if (!runPattern.test(meta.id || '')) throw fault('INVALID_RUN', 'Invalid run ID.');
  const data = JSON.stringify(scrub(meta), null, 2) + '\n';
  if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw fault('EVIDENCE_LIMIT', 'Run metadata exceeded 32 MiB.');
  await atomic(path.join(await libraryDirs(), 'meta', meta.id + '.json'), data);
}

export async function boundRun(identity) {
  const file = path.join(await libraryDirs(), 'bindings', bindingKey(identity) + '.json');
  try {
    return JSON.parse(await regularFile(file, 8192));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function allocateRun(identity, options = {}) {
  const root = await libraryDirs();
  const id = crypto.randomUUID();
  const dir = path.join(root, 'runs', id);
  const file = path.join(root, 'bindings', bindingKey(identity) + '.json');
  const meta = {
    schema: 1,
    id,
    ...identity,
    objective: options.objective || 'Browser exploration',
    environment: options.environment || null,
    createdAt: new Date().toISOString(),
    status: 'starting',
    recording: {mode: 'filmstrip', screenshots: true},
    states: [],
    actions: [],
    annotations: [],
    gaps: [],
    notices: [],
    finals: [],
    artifacts: [],
  };
  try {
    await exclusive(file, JSON.stringify({id, ...identity}));
  } catch (e) {
    if (e.code === 'EEXIST') throw fault('EXPLORATION_BUSY', 'This session already has a library run.');
    throw e;
  }
  await fs.mkdir(dir, {mode: 0o700});
  for (const sub of ['snapshots', 'screenshots', 'raw']) {
    await fs.mkdir(path.join(dir, sub), {mode: 0o700});
  }
  await exclusive(path.join(dir, 'commands.jsonl'), '');
  await saveMeta(meta);
  return meta;
}

export async function unbind(meta) {
  const file = path.join(await libraryDirs(), 'bindings', bindingKey(meta) + '.json');
  try {
    const b = JSON.parse(await regularFile(file, 8192));
    if (b.id === meta.id) await fs.unlink(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

export const LOCK_WAIT_MS = 1500;
const LOCK_POLL_MIN_MS = 50;
const LOCK_POLL_MAX_MS = 100;
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// The uncontended path is a single immediate mkdir. Only when another CLI
// process still holds the lock (typically finishing its own cleanup) do we
// poll briefly before reporting EXPLORATION_BUSY. Stale locks are never
// reclaimed here; offline repair and disconnect pass waitMs: 0.
export async function lockRun(id, fn, {waitMs = LOCK_WAIT_MS, sleep = defaultSleep} = {}) {
  await runPath(id);
  const lock = path.join(await libraryDirs(), 'locks', id);
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      await fs.mkdir(lock, {mode: 0o700});
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw fault('EXPLORATION_BUSY', 'Another exploration command is active or interrupted. Stop/disconnect remains available.');
      }
      const jitter = LOCK_POLL_MIN_MS + Math.floor(Math.random() * (LOCK_POLL_MAX_MS - LOCK_POLL_MIN_MS + 1));
      await sleep(Math.min(jitter, remaining));
    }
  }
  let owner;
  try {
    owner = {pid: process.pid, identity: await processIdentity(process.pid), nonce};
    if (!owner.identity) throw fault('EXPLORATION_BUSY', 'Capture process identity is unavailable.');
    await exclusive(path.join(lock, 'owner.json'), JSON.stringify(owner));
  } catch (e) {
    await fs.rmdir(lock).catch(() => {});
    throw e;
  }
  try {
    return await fn();
  } finally {
    const actual = JSON.parse(await regularFile(path.join(lock, 'owner.json'), 8192));
    if (actual.nonce === nonce) {
      await fs.unlink(path.join(lock, 'owner.json'));
      await fs.rmdir(lock);
    }
  }
}

export async function recoverLibraryLock(id) {
  const root = await libraryDirs();
  const lock = path.join(root, 'locks', id);
  let owner;
  try {
    owner = JSON.parse(await regularFile(path.join(lock, 'owner.json'), 8192));
  } catch (e) {
    if (e.code === 'ENOENT') {
      const exists = await fs.lstat(lock).then(
        () => true,
        err => (err.code === 'ENOENT' ? false : Promise.reject(err)),
      );
      if (!exists) return false;
    }
    throw fault('EXPLORATION_BUSY', 'Interrupted library lock has no verified owner; preserve it for inspection.');
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !runPattern.test(owner.nonce || '') || !owner.identity) {
    throw fault('EXPLORATION_BUSY', 'Library lock ownership is invalid.');
  }
  const live = await processIdentity(owner.pid);
  if (live === owner.identity) throw fault('EXPLORATION_BUSY', 'Capture owner is still running.');
  const current = JSON.parse(await regularFile(path.join(lock, 'owner.json'), 8192));
  if (current.nonce !== owner.nonce) throw fault('EXPLORATION_BUSY', 'Library lock changed during inspection.');
  // Keep a nonempty, deterministic audit destination. Concurrent recoverers
  // cannot overwrite it with a successor lock; no PID is killed or reclaimed.
  await fs.rename(lock, path.join(root, 'lock-audit', id + '-' + owner.nonce));
  return true;
}

/**
 * Append a scrubbed event to `<runDir>/commands.jsonl`, refusing partial tails.
 */
export async function appendCommand(dir, event) {
  const line = JSON.stringify(scrub(event)) + '\n';
  if (Buffer.byteLength(line) > LIMITS.eventBytes) throw fault('EVIDENCE_LIMIT', 'Command metadata exceeded the event limit.');
  const file = path.join(dir, 'commands.jsonl');
  let prior;
  try {
    prior = await regularFile(file, LIMITS.ledgerBytes);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await exclusive(file, '');
    prior = Buffer.alloc(0);
  }
  if (prior.length && prior.at(-1) !== 10) {
    throw fault('EVIDENCE_LEDGER_PARTIAL', 'The command ledger has a partial tail; preserve it for offline repair.');
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

/**
 * Read and validate `<runDir>/commands.jsonl`.
 */
export async function ledger(dir) {
  let data;
  try {
    data = await regularFile(path.join(dir, 'commands.jsonl'), LIMITS.ledgerBytes);
  } catch (e) {
    if (e.code === 'ENOENT') return {events: [], partialTail: false, sha256: digest('')};
    throw e;
  }
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
      (!['succeeded', 'failed', 'unknown'].includes(event.operation?.outcome) ||
        !Array.isArray(event.artifacts) ||
        event.artifacts.some(
          a => !Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > LIMITS.artifactBytes || !/^[a-f0-9]{64}$/.test(a.sha256 || ''),
        ))
    ) {
      throw fault('EVIDENCE_LEDGER_INVALID', 'Invalid completion record.');
    }
  }
  return {events, partialTail: !!partialTail, sha256: digest(data)};
}

export async function appendObservation(meta, event) {
  const dir = await runPath(meta.id);
  const file = path.join(dir, 'events.jsonl');
  const line = JSON.stringify(scrub({schema: 1, run_id: meta.id, at: new Date().toISOString(), ...event})) + '\n';
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw fault('EVIDENCE_LIMIT', 'Exploration event exceeds its limit.');
  let previous;
  try {
    previous = await regularFile(file, 32 * 1024 * 1024);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await exclusive(file, '');
    previous = Buffer.alloc(0);
  }
  if (previous.length && previous.at(-1) !== 10) {
    throw fault('EVIDENCE_LEDGER_PARTIAL', 'Exploration event tail is incomplete; preserve it.');
  }
  if (previous.length + Buffer.byteLength(line) > 32 * 1024 * 1024) {
    throw fault('EVIDENCE_LIMIT', 'Exploration event ledger reached 32 MiB.');
  }
  const handle = await fs.open(file, 'a');
  try {
    const data = Buffer.from(line);
    const result = await handle.write(data);
    if (result.bytesWritten !== data.length) throw fault('EVIDENCE_WRITE_PARTIAL', 'Exploration event was only partially written.');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function replayObservations(meta) {
  let bytes;
  try {
    bytes = await regularFile(path.join(await runPath(meta.id), 'events.jsonl'), 32 * 1024 * 1024);
  } catch (e) {
    if (e.code === 'ENOENT') return meta;
    throw e;
  }
  const lines = bytes.toString('utf8').split('\n');
  const tail = lines.pop();
  const states = new Map();
  const actions = new Map();
  const artifacts = new Map();
  let summary;
  for (const line of lines.filter(Boolean)) {
    const e = JSON.parse(line);
    if (e.schema !== 1 || e.run_id !== meta.id) throw fault('EXPLORATION_SCHEMA_INVALID', 'Foreign event in exploration ledger.');
    if (e.type === 'state') states.set(e.state.id, e.state);
    if (e.type === 'action') actions.set(e.action.id, e.action);
    if (e.type === 'summary') summary = e.summary;
    for (const a of e.artifacts || []) artifacts.set(a.path, a);
  }
  if (summary) Object.assign(meta, summary);
  if (meta.pending && actions.has(meta.pending.step)) delete meta.pending;
  if (states.size) meta.states = [...states.values()];
  if (actions.size) meta.actions = [...actions.values()];
  for (const a of meta.artifacts) artifacts.set(a.path, a);
  meta.artifacts = [...artifacts.values()];
  if (tail) {
    meta.observationTailIncomplete = true;
    meta.status = 'interrupted';
    meta.gaps.push({reason: 'Partial observation event tail retained; incomplete event was not invented.'});
  }
  return meta;
}

export async function artifactPath(meta, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) {
    throw fault('EVIDENCE_PATH_UNSAFE', 'Unsafe artifact path.');
  }
  const dir = await runPath(meta.id);
  const file = path.join(dir, relative);
  let parent = path.dirname(file);
  while (parent !== dir) {
    await directory(parent);
    parent = path.dirname(parent);
  }
  return file;
}

export async function indexArtifact(meta, relative, type, status = 'complete') {
  const normalized = typeof relative === 'string' ? relative.replaceAll('\\', '/') : '';
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').some(p => !p || p === '.' || p === '..')) {
    throw fault('EVIDENCE_PATH_UNSAFE', 'Unsafe artifact path.');
  }
  const dir = await runPath(meta.id);
  const file = path.join(dir, normalized);
  let parent = path.dirname(file);
  while (parent !== dir) {
    await directory(parent);
    parent = path.dirname(parent);
  }
  const data = await regularFile(file, LIMITS.artifactBytes);
  const entry = {path: normalized, type, status, bytes: data.length, sha256: digest(data)};
  const total = meta.artifacts.filter(a => a.path !== normalized).reduce((n, a) => n + a.bytes, 0) + entry.bytes;
  if (total > MAX_RUN) throw fault('EVIDENCE_LIMIT', 'Exploration exceeded its 512 MiB artifact budget.');
  meta.artifacts = meta.artifacts.filter(a => a.path !== normalized);
  meta.artifacts.push(entry);
  return entry;
}

export async function listRuns() {
  const root = await libraryDirs();
  const runs = [];
  for (const n of await fs.readdir(path.join(root, 'meta'))) {
    if (!n.endsWith('.json') || !runPattern.test(n.slice(0, -5))) continue;
    try {
      runs.push(await loadMeta(n.slice(0, -5)));
    } catch {
      runs.push({id: n.slice(0, -5), status: 'unreadable', objective: 'Unreadable run metadata'});
    }
  }
  return runs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function verifyArtifacts(meta) {
  const problems = [];
  for (const a of meta.artifacts) {
    try {
      const data = await regularFile(await artifactPath(meta, a.path), LIMITS.artifactBytes);
      if (data.length !== a.bytes || digest(data) !== a.sha256) problems.push({path: a.path, code: 'CHANGED'});
    } catch (e) {
      problems.push({path: a.path, code: e.code || 'UNREADABLE'});
    }
  }
  return {verified: problems.length === 0, problems};
}

export async function activeRunIds() {
  const root = await libraryDirs();
  const active = new Set();
  for (const name of await fs.readdir(path.join(root, 'bindings'))) {
    if (!name.endsWith('.json')) continue;
    try {
      const bound = JSON.parse(await regularFile(path.join(root, 'bindings', name), 8192));
      if (runPattern.test(bound?.id || '')) active.add(bound.id);
    } catch {}
  }
  for (const name of await fs.readdir(path.join(root, 'locks'))) {
    if (runPattern.test(name)) active.add(name);
  }
  return active;
}

export async function deleteRun(id) {
  if (!runPattern.test(id || '')) throw fault('INVALID_RUN', 'Use a run ID from library list.');
  const root = await libraryDirs();
  const runDir = path.join(root, 'runs', id);
  const metaFile = path.join(root, 'meta', id + '.json');
  const lock = path.join(root, 'locks', id);
  const nonce = crypto.randomUUID();
  try {
    await fs.mkdir(lock, {mode: 0o700});
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw fault('EXPLORATION_BUSY', 'Cannot delete an active or locked exploration run.');
    }
    throw e;
  }
  let owner;
  try {
    owner = {pid: process.pid, identity: await processIdentity(process.pid), nonce};
    if (!owner.identity) throw fault('EXPLORATION_BUSY', 'Capture process identity is unavailable.');
    await exclusive(path.join(lock, 'owner.json'), JSON.stringify(owner));
  } catch (e) {
    await fs.rmdir(lock).catch(() => {});
    throw e;
  }
  try {
    for (const name of await fs.readdir(path.join(root, 'bindings'))) {
      if (!name.endsWith('.json')) continue;
      try {
        const bound = JSON.parse(await regularFile(path.join(root, 'bindings', name), 8192));
        if (bound?.id === id) {
          throw fault('EXPLORATION_BUSY', 'Cannot delete an active exploration run. Run latch finish or disconnect first.');
        }
      } catch (e) {
        if (e.code === 'EXPLORATION_BUSY') throw e;
      }
    }
    let hasMeta = false;
    try {
      const stat = await fs.lstat(metaFile);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
        throw fault('EVIDENCE_FILE_UNSAFE', 'Refusing to delete nonregular metadata file.');
      }
      hasMeta = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    let hasDir = false;
    try {
      await fs.lstat(runDir);
      await directory(runDir);
      hasDir = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!hasMeta && !hasDir) {
      throw fault('NOT_FOUND', 'Exploration run was not found.');
    }
    if (hasDir) await fs.rm(runDir, {recursive: true, force: true});
    if (hasMeta) {
      await fs.unlink(metaFile).catch(e => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
    return {deleted: true, runId: id};
  } finally {
    const actual = JSON.parse(await regularFile(path.join(lock, 'owner.json'), 8192));
    if (actual.nonce === nonce) {
      await fs.unlink(path.join(lock, 'owner.json'));
      await fs.rmdir(lock);
    }
  }
}

export async function deleteAllRuns() {
  const root = await libraryDirs();
  const ids = new Set();
  for (const name of await fs.readdir(path.join(root, 'meta'))) {
    if (name.endsWith('.json') && runPattern.test(name.slice(0, -5))) ids.add(name.slice(0, -5));
  }
  for (const name of await fs.readdir(path.join(root, 'runs'))) {
    if (runPattern.test(name)) ids.add(name);
  }
  const deleted = [];
  const skippedActive = [];
  for (const id of ids) {
    try {
      await deleteRun(id);
      deleted.push(id);
    } catch (e) {
      if (e.code === 'EXPLORATION_BUSY') skippedActive.push(id);
      else if (e.code !== 'NOT_FOUND') throw e;
    }
  }
  return {deleted, deletedCount: deleted.length, skippedActive};
}
