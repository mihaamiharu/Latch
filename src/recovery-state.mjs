import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sessionsDir,
  workspaceBindingPath,
  privateDirectory,
  isSameRegularFile,
} from './platform.mjs';
import {fault} from '../extension/protocol.js';

const KEY_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,60}$/;

function validBindingEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    KEY_PATTERN.test(entry.sessionKey || '') &&
    SESSION_NAME_PATTERN.test(entry.session || '') &&
    typeof entry.workspace === 'string'
  );
}

/** Read the active workspace session binding at <appDataDir>/sessions/<sha256(realpath(cwd))>.json. */
export async function readWorkspaceBinding(workspace = process.cwd(), platform = process.platform, env = process.env) {
  const file = workspaceBindingPath(workspace, platform, env);
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) {
      throw fault('RECOVERY_STATE_UNSAFE', 'Workspace session binding is unsafe or exceeds 64 KiB.');
    }
    handle = await fs.open(file, 'r');
    const opened = await handle.stat();
    if (!(await isSameRegularFile(stat, opened, file, platform))) {
      throw fault('RECOVERY_STATE_CHANGED', 'Workspace session binding changed while reading.');
    }
    const data = JSON.parse(await handle.readFile('utf8'));
    if (!data || data.v !== 1 || typeof data.workspace !== 'string' || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) {
      throw fault('RECOVERY_STATE_UNSUPPORTED', 'Unrecognized workspace session binding.');
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw fault('RECOVERY_STATE_CORRUPT', 'Workspace session binding is corrupt.');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Write or update a session entry in the workspace session binding file (no repo dotfiles). */
export async function writeWorkspaceBinding(workspace, entry, platform = process.platform, env = process.env) {
  if (!validBindingEntry(entry)) {
    throw fault('INVALID_SESSION', 'Invalid workspace session binding entry.');
  }
  const file = workspaceBindingPath(workspace, platform, env);
  const dir = path.dirname(file);
  await privateDirectory(path.dirname(dir), platform);
  await privateDirectory(dir, platform);

  let existing = null;
  try {
    existing = await readWorkspaceBinding(workspace, platform, env);
  } catch {
    existing = null;
  }

  const sessions = {...(existing?.sessions || {})};
  sessions[entry.session] = {
    sessionKey: entry.sessionKey,
    session: entry.session,
    workspace: entry.workspace,
    instanceId: entry.instanceId,
    tabId: entry.tabId ?? null,
    focusEmulation: entry.focusEmulation !== false,
    status: entry.status || 'attached',
    updatedAt: Date.now(),
  };

  const payload = {
    v: 1,
    workspace: entry.workspace,
    activeSession: entry.session,
    activeSessionKey: entry.sessionKey,
    sessions,
    updatedAt: Date.now(),
  };
  const body = JSON.stringify(payload, null, 2) + '\n';
  if (Buffer.byteLength(body) > 65536) {
    throw fault('RECOVERY_STATE_LARGE', 'Workspace session binding exceeds 64 KiB.');
  }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  return payload;
}

/** Remove a session from the workspace session binding, deleting the file if empty. */
export async function removeWorkspaceBinding(workspace, sessionOrKey, platform = process.platform, env = process.env) {
  const file = workspaceBindingPath(workspace, platform, env);
  const existing = await readWorkspaceBinding(workspace, platform, env).catch(() => null);
  if (!existing) return {removed: false};

  const sessions = {...existing.sessions};
  let changed = false;
  for (const [name, entry] of Object.entries(sessions)) {
    if (name === sessionOrKey || entry?.sessionKey === sessionOrKey) {
      delete sessions[name];
      changed = true;
    }
  }
  if (!changed) return {removed: false};

  const remaining = Object.values(sessions);
  if (!remaining.length) {
    await fs.unlink(file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    return {removed: true, remaining: 0};
  }

  const nextActive = remaining.at(-1);
  const payload = {
    v: 1,
    workspace: existing.workspace,
    activeSession: nextActive.session,
    activeSessionKey: nextActive.sessionKey,
    sessions,
    updatedAt: Date.now(),
  };
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(payload, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  return {removed: true, remaining: remaining.length};
}

/** List all workspace session bindings stored under <appDataDir>/sessions/. */
export async function listWorkspaceBindings(platform = process.platform, env = process.env) {
  const dir = sessionsDir(platform, env);
  const files = await fs.readdir(dir).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const bindings = [];
  for (const name of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (data?.v === 1 && data.workspace && data.sessions) {
        bindings.push({file: path.join(dir, name), ...data});
      }
    } catch {}
  }
  return bindings;
}
