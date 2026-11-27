import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDirectory} from './local.mjs';
import {libraryRoot as platformLibraryRoot, isProcessAlive} from './platform.mjs';
import {atomic, exclusive, regularFile, directory, scrub, digest} from './evidence-storage.mjs';
import {fault} from '../extension/protocol.js';

export {atomic, exclusive, regularFile, scrub, digest};

async function processIdentity(pid) {
  return isProcessAlive(pid) ? `pid:${pid}` : null;
}

export const MAX_VIDEO = 512 * 1024 * 1024;
export const MAX_RUN = 2 * 1024 * 1024 * 1024;
export const runPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
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
    video: {status: 'not_started'},
    states: [],
    actions: [],
    annotations: [],
    gaps: [],
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

export async function lockRun(id, fn) {
  await runPath(id);
  const lock = path.join(await libraryDirs(), 'locks', id);
  const nonce = crypto.randomUUID();
  try {
    await fs.mkdir(lock, {mode: 0o700});
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw fault('EXPLORATION_BUSY', 'Another exploration command is active or interrupted. Stop/disconnect remains available.');
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
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) {
    throw fault('EVIDENCE_PATH_UNSAFE', 'Unsafe artifact path.');
  }
  const dir = await runPath(meta.id);
  const file = path.join(dir, relative);
  let parent = path.dirname(file);
  while (parent !== dir) {
    await directory(parent);
    parent = path.dirname(parent);
  }
  const max = type === 'video' ? MAX_VIDEO : 32 * 1024 * 1024;
  const data = await regularFile(file, max);
  const entry = {path: relative, type, status, bytes: data.length, sha256: digest(data)};
  const total = meta.artifacts.filter(a => a.path !== relative).reduce((n, a) => n + a.bytes, 0) + entry.bytes;
  if (total > MAX_RUN) throw fault('EVIDENCE_LIMIT', 'Exploration exceeded its 2 GiB artifact budget.');
  meta.artifacts = meta.artifacts.filter(a => a.path !== relative);
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
      const data = await regularFile(
        await artifactPath(meta, a.path),
        a.type === 'video' ? MAX_VIDEO : 32 * 1024 * 1024,
      );
      if (data.length !== a.bytes || digest(data) !== a.sha256) problems.push({path: a.path, code: 'CHANGED'});
    } catch (e) {
      problems.push({path: a.path, code: e.code || 'UNREADABLE'});
    }
  }
  return {verified: problems.length === 0, problems};
}
