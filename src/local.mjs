import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {fault} from '../extension/protocol.js';

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Darwin's per-user os.tmpdir() can exceed the Unix-domain socket path limit.
export const rootDir = () => process.env.QA_BROWSER_RUNTIME_DIR || path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `qa-browser-${process.getuid?.() ?? 'local'}`);
export const configPath = () => process.env.QA_BROWSER_CONFIG || path.join(os.homedir(), 'Library', 'Application Support', 'Work Browser Bridge', 'config.json');
export function socketPath(instanceId) {
  if (!uuid.test(instanceId)) throw fault('INVALID_PROFILE', 'Invalid extension instance ID.');
  const result = path.join(rootDir(), `${instanceId}.sock`);
  if (Buffer.byteLength(result) > 100) throw fault('SOCKET_PATH_LONG', 'Use a shorter QA_BROWSER_RUNTIME_DIR path.');
  return result;
}
export async function privateDirectory(dir) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw fault('UNSAFE_DIRECTORY', 'Bridge directory must be owned by the current user and not a symlink.');
  await fs.chmod(dir, 0o700);
}
export async function readConfig() {
  try { return JSON.parse(await fs.readFile(configPath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {v: 1, profiles: {}}; throw error; }
}
export async function writeConfig(config) {
  const dest = configPath();
  await privateDirectory(path.dirname(dest));
  const temp = `${dest}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await fs.rename(temp, dest);
}
// All CLI config mutations share one exclusive, non-reclaiming gate.
export async function updateConfig(change) {
  const dir = path.dirname(configPath());
  await privateDirectory(dir);
  const gate = configPath() + '.lock';
  try { await fs.mkdir(gate, {mode: 0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw fault('CONFIG_BUSY', 'A configuration update gate exists; inspect its owner/state instead of deleting it by PID or age.'); throw error; }
  try {
    await fs.writeFile(path.join(gate, 'owner.json'), JSON.stringify({pid: process.pid, nonce: crypto.randomUUID()}), {flag: 'wx', mode: 0o600});
    const config = await readConfig(), before = JSON.stringify(config);
    const result = await change(config);
    if (JSON.stringify(config) !== before) await writeConfig(config);
    return result;
  } finally {
    await fs.unlink(path.join(gate, 'owner.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await fs.rmdir(gate);
  }
}
export function socketError(error, address) {
  const systemCode = error.code || 'UNKNOWN';
  if (['EACCES', 'EPERM'].includes(systemCode))
    return fault('BRIDGE_ACCESS_DENIED', `Local socket access was denied (${systemCode}) at ${address}. Check this agent's execution permissions; pairing may still be configured.`);
  if (['ENOENT', 'ECONNREFUSED'].includes(systemCode))
    return fault('PROFILE_UNAVAILABLE', `Local bridge socket is unavailable (${systemCode}) at ${address}. Check browser connectivity and this process's runtime directory.`);
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
      if (Buffer.byteLength(body) > 1024 * 1024) return finish(fault('MESSAGE_TOO_LARGE', 'Bridge response exceeded the size limit.'));
      if (!body.includes('\n')) return;
      try {
        const response = JSON.parse(body.slice(0, body.indexOf('\n')));
        if (response.v !== 1 || response.id !== id) throw fault('INVALID_RESPONSE', 'Invalid bridge response.');
        if (!response.ok) throw fault(response.error?.code || 'BRIDGE_ERROR', response.error?.message || 'Bridge request failed.');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.on('close', () => { if (!complete) finish(fault('BRIDGE_DISCONNECTED', 'The native bridge disconnected.')); });
  });
}
export async function discover() {
  return (await discoverDetailed()).profiles;
}
export async function discoverDetailed() {
  let entries;
  const runtimeDirectory = rootDir();
  try { entries = await fs.readdir(runtimeDirectory); }
  catch (error) {
    if (error.code === 'ENOENT') return {profiles: [], runtimeDirectory, warnings: [], runtimeDirectoryExists: false};
    throw socketError(error, runtimeDirectory);
  }
  const results = await Promise.all(entries.filter(n => n.endsWith('.sock') && uuid.test(n.slice(0, -5))).map(async n => {
    const instanceId = n.slice(0, -5);
    try { return {profile: await request(instanceId, 'status', {}, 1500)}; }
    catch (error) { return {warning: {instanceId, code: error.code || 'BRIDGE_ERROR', message: error.message}}; }
  }));
  return {profiles: results.filter(r => r.profile).map(r => r.profile), runtimeDirectory,
    runtimeDirectoryExists: true, warnings: results.filter(r => r.warning).map(r => r.warning)};
}
