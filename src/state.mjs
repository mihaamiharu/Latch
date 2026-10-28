import fs from 'node:fs/promises';
import path from 'node:path';
import {rootDir, privateDirectory} from './local.mjs';
import {fault} from '../extension/protocol.js';
export const statePath = key => path.join(rootDir(), `${key}.session.json`);
export async function readSession(key) {
  try { return JSON.parse(await fs.readFile(statePath(key), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeSession(key, state) {
  await privateDirectory(rootDir());
  const tmp = `${statePath(key)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
  await fs.rename(tmp, statePath(key));
}
export async function forgetSession(key) { await fs.unlink(statePath(key)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
export async function locked(key, fn) {
  await privateDirectory(rootDir());
  const lock = path.join(rootDir(), `${key}.lock`);
  try { await fs.mkdir(lock, {mode: 0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw fault('SESSION_BUSY', 'Another bridge operation holds this session lock.'); throw error; }
  try {
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
    return await fn();
  } finally {
    await fs.unlink(path.join(lock, 'owner.json')).catch(() => {});
    await fs.rmdir(lock).catch(() => {});
  }
}
