import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fault} from '../extension/protocol.js';
import {isSameRegularFile, isWindowsPipe} from './platform.mjs';

// Pinned playwright-cli 0.1.20 registry layout. Read only the exact task entry;
// never scan, delete, or infer authority from a PID or an old timestamp.
export function daemonFile(workspace, session) {
  const base =
    process.env.PWTEST_DAEMON_SESSION_DIR ||
    path.join(
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches')
        : process.platform === 'win32'
          ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
          : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
      'ms-playwright',
      'daemon',
    );
  const hash = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 16);
  return path.join(base, hash, session + '.session');
}

export async function daemonIdentity(workspace, session) {
  let handle;
  try {
    const file = daemonFile(workspace, session);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) {
      throw fault('DAEMON_IDENTITY_UNCONFIRMED', 'CLI task registry is unsafe.');
    }
    handle = await fs.open(file, 'r');
    const actual = await handle.stat();
    if (!(await isSameRegularFile(stat, actual, file))) {
      throw fault('DAEMON_IDENTITY_CHANGED', 'CLI task registry changed.');
    }
    const c = JSON.parse(await handle.readFile('utf8'));
    if (
      c.workspaceDir !== workspace ||
      c.name !== session ||
      c.attached !== true ||
      typeof c.socketPath !== 'string' ||
      !Number.isFinite(c.timestamp)
    ) {
      throw fault('DAEMON_IDENTITY_UNCONFIRMED', 'CLI task registry does not identify this attached task.');
    }
    let socket;
    try {
      socket = await fs.lstat(c.socketPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const validSocket = socket
      ? isWindowsPipe(c.socketPath)
        ? socket.isFile() || socket.isSocket()
        : socket.isSocket() && (!process.getuid || socket.uid === process.getuid())
      : true;
    if (!validSocket) {
      throw fault('DAEMON_IDENTITY_UNCONFIRMED', 'CLI task socket is unsafe.');
    }
    return {
      fingerprint: crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            name: c.name,
            workspace: c.workspaceDir,
            version: c.version,
            timestamp: c.timestamp,
            socket: c.socketPath,
            registryInode: stat.ino,
            registryDevice: stat.dev,
          }),
        )
        .digest('hex'),
      socketExists: !!socket,
      socketFingerprint: socket
        ? crypto
            .createHash('sha256')
            .update(JSON.stringify(isWindowsPipe(c.socketPath) ? [c.socketPath] : [socket.dev, socket.ino]))
            .digest('hex')
        : null,
    };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError) throw fault('DAEMON_IDENTITY_UNCONFIRMED', 'CLI task registry is corrupt.');
    throw e;
  } finally {
    await handle?.close();
  }
}

export async function assertDaemon(record) {
  const current = await daemonIdentity(record.workspace, record.session);
  if (!current) return {absent: true};
  if (
    !record.daemonFingerprint ||
    current.fingerprint !== record.daemonFingerprint ||
    (current.socketExists && current.socketFingerprint !== record.daemonSocketFingerprint)
  ) {
    throw fault(
      'DAEMON_IDENTITY_CHANGED',
      'CLI ownership is unconfirmed or replaced. Native access was revoked; the CLI task was preserved.',
    );
  }
  return {absent: false};
}
