import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {fault} from '../extension/protocol.js';
import {
  UUID_PATTERN,
  runtimeDir,
  configPath,
  describeLibraryRoot,
  ipcEndpoint,
  privateDirectory,
  discoverIpcEndpoints,
} from './platform.mjs';

export const uuid = UUID_PATTERN;
export const rootDir = () => runtimeDir();
export {configPath, privateDirectory};

export function socketPath(instanceId) {
  return ipcEndpoint(instanceId);
}

export async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {v: 1, profiles: {}};
    throw error;
  }
}

export async function writeConfig(config) {
  const dest = configPath();
  await privateDirectory(path.dirname(dest));
  const temp = `${dest}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n', process.platform === 'win32' ? {flag: 'wx'} : {mode: 0o600, flag: 'wx'});
  await fs.rename(temp, dest);
}

// All CLI config mutations share one exclusive, non-reclaiming gate.
export async function updateConfig(change) {
  const dir = path.dirname(configPath());
  await privateDirectory(dir);
  const gate = configPath() + '.lock';
  try {
    await fs.mkdir(gate, {mode: 0o700});
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw fault('CONFIG_BUSY', 'A configuration update gate exists; inspect its owner/state instead of deleting it by PID or age.');
    }
    throw error;
  }
  try {
    await fs.writeFile(
      path.join(gate, 'owner.json'),
      JSON.stringify({pid: process.pid, nonce: crypto.randomUUID()}),
      process.platform === 'win32' ? {flag: 'wx'} : {flag: 'wx', mode: 0o600},
    );
    const config = await readConfig();
    const before = JSON.stringify(config);
    const result = await change(config);
    if (JSON.stringify(config) !== before) await writeConfig(config);
    return result;
  } finally {
    await fs.unlink(path.join(gate, 'owner.json')).catch(e => {
      if (e.code !== 'ENOENT') throw e;
    });
    await fs.rmdir(gate);
  }
}

export function getArtifactsConfig({platform = process.platform, env = process.env} = {}) {
  return {
    configPath: configPath(platform, env),
    ...describeLibraryRoot(platform, env),
  };
}

export async function setArtifactsDir(
  rawPath,
  {requireAbsolute = false, platform = process.platform, env = process.env} = {},
) {
  if (rawPath === null || rawPath === undefined || String(rawPath).trim() === '') {
    await updateConfig(config => {
      delete config.artifactsDir;
    });
    return {
      updated: true,
      reset: true,
      configPath: configPath(platform, env),
      ...describeLibraryRoot(platform, env),
    };
  }
  const trimmed = String(rawPath).trim();
  if (trimmed.length > 512 || trimmed.includes('\0')) {
    throw fault('INVALID_ARGUMENT', 'Artifacts folder path is invalid or too long.');
  }
  if (requireAbsolute && !path.isAbsolute(trimmed)) {
    throw fault('INVALID_ARGUMENT', 'Specify an absolute folder path for artifactsDir.');
  }
  const resolved = path.resolve(trimmed);
  if (path.parse(resolved).root === resolved) {
    throw fault('INVALID_ARGUMENT', 'Refusing to use a filesystem root as the artifacts folder.');
  }
  let existing = null;
  try {
    existing = await fs.lstat(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw fault('INVALID_ARGUMENT', 'Artifacts path must be a regular directory (not a file or symlink).');
  }
  await privateDirectory(resolved, platform);
  const probe = path.join(resolved, `.latch-write-probe-${crypto.randomUUID()}`);
  let handle;
  try {
    handle = await fs.open(probe, 'wx', 0o600);
    await handle.writeFile('ok');
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
      await fs.unlink(probe).catch(() => {});
    }
  }
  await updateConfig(config => {
    config.artifactsDir = resolved;
  });
  return {
    updated: true,
    reset: false,
    configPath: configPath(platform, env),
    ...describeLibraryRoot(platform, env),
  };
}

export function socketError(error, address) {
  const systemCode = error.code || 'UNKNOWN';
  if (['EACCES', 'EPERM'].includes(systemCode)) {
    return fault(
      'BRIDGE_ACCESS_DENIED',
      `Local socket access was denied (${systemCode}) at ${address}. Check this agent's execution permissions; pairing may still be configured.`,
    );
  }
  if (['ENOENT', 'ECONNREFUSED'].includes(systemCode)) {
    return fault(
      'PROFILE_UNAVAILABLE',
      `Local bridge socket is unavailable (${systemCode}) at ${address}. Check browser connectivity and this process's runtime directory.`,
    );
  }
  return fault('BRIDGE_CONNECTION_FAILED', `Local bridge connection failed (${systemCode}) at ${address}.`);
}

export function request(instanceId, op, payload = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const address = socketPath(instanceId);
    const socket = net.createConnection(address);
    let body = '';
    let complete = false;
    const finish = (error, result) => {
      if (complete) return;
      complete = true;
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    socket.setTimeout(timeout, () => finish(fault('BRIDGE_TIMEOUT', 'The browser bridge did not respond in time.')));
    socket.on('error', error => finish(socketError(error, address)));
    socket.on('connect', () => socket.write(JSON.stringify({v: 1, id, op, payload}) + '\n'));
    socket.on('data', chunk => {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
        return finish(fault('MESSAGE_TOO_LARGE', 'Bridge response exceeded the size limit.'));
      }
      if (!body.includes('\n')) return;
      try {
        const response = JSON.parse(body.slice(0, body.indexOf('\n')));
        if (response.v !== 1 || response.id !== id) throw fault('INVALID_RESPONSE', 'Invalid bridge response.');
        if (!response.ok) throw fault(response.error?.code || 'BRIDGE_ERROR', response.error?.message || 'Bridge request failed.', response.error?.hint);
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.on('close', () => {
      if (!complete) finish(fault('BRIDGE_DISCONNECTED', 'The native bridge disconnected.'));
    });
  });
}

export async function discover() {
  return (await discoverDetailed()).profiles;
}

export async function discoverDetailed() {
  let discovered;
  const runtimeDirectory = rootDir();
  try {
    discovered = await discoverIpcEndpoints();
  } catch (error) {
    throw socketError(error, runtimeDirectory);
  }
  const results = await Promise.all(
    discovered.instanceIds.map(async instanceId => {
      try {
        return {profile: await request(instanceId, 'status', {}, 1500)};
      } catch (error) {
        return {warning: {instanceId, code: error.code || 'BRIDGE_ERROR', message: error.message}};
      }
    }),
  );
  return {
    profiles: results.filter(r => r.profile).map(r => r.profile),
    runtimeDirectory: discovered.runtimeDirectory,
    runtimeDirectoryExists: discovered.runtimeDirectoryExists,
    warnings: results.filter(r => r.warning).map(r => r.warning),
  };
}
