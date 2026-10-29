import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {configPath, privateDirectory, uuid} from './local.mjs';
import {fault} from '../extension/protocol.js';

const keyPattern = /^[a-f0-9]{64}$/;
const recordFields = new Set(['v','key','revision','instanceId','epoch','hostGeneration','leaseId','sessionKey','workspace','session','tabId','focusEmulation','status','stage','outcome','cleanup','appliedToken','daemonFingerprint','daemonSocketFingerprint','rootTabId','targets','updatedAt']);
export const recoveryDirectory = instance => {
  if (!uuid.test(instance || '')) throw fault('INVALID_PROFILE', 'Invalid recovery profile.');
  return path.join(path.dirname(configPath()), 'native-v4', instance);
};
export const recoveryPath = (instance, key) => {
  if (!keyPattern.test(key || '')) throw fault('INVALID_SESSION', 'Invalid recovery session key.');
  return path.join(recoveryDirectory(instance), key + '.json');
};
export async function readRecovery(instance, key) {
  const file = recoveryPath(instance, key);
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || process.getuid && stat.uid !== process.getuid())
      throw fault('RECOVERY_STATE_UNSAFE', 'Recovery record is unsafe or exceeds 64 KiB; preserved for inspection.');
    handle = await fs.open(file, 'r');
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw fault('RECOVERY_STATE_CHANGED', 'Recovery record changed while reading.');
    const record = JSON.parse(await handle.readFile('utf8'));
    if (record.v !== 4 || record.key !== key || record.instanceId !== instance || !uuid.test(record.revision || '') || !uuid.test(record.leaseId || '') || !uuid.test(record.hostGeneration || '') || !uuid.test(record.epoch || ''))
      throw fault('RECOVERY_STATE_UNSUPPORTED', 'Unrecognized recovery record; preserved for inspection.');
    if (typeof record.workspace !== 'string' || record.workspace.length > 4096 || !/^[a-zA-Z0-9_-]{1,60}$/.test(record.session || '') || crypto.createHash('sha256').update(JSON.stringify([record.workspace, record.session])).digest('hex') !== key || !['connecting','attached','interrupted','released','retired'].includes(record.status)) throw fault('RECOVERY_STATE_UNSUPPORTED', 'Recovery task identity or state is invalid; preserved for inspection.');
    if (Object.keys(record).some(k => !recordFields.has(k)) || record.sessionKey !== undefined && record.sessionKey !== key || typeof record.stage !== 'string' || record.stage.length > 64 || ![null,undefined,'unknown'].includes(record.outcome) || ![null,undefined,'confirmed','unconfirmed'].includes(record.cleanup) || record.targets !== undefined && (!Array.isArray(record.targets) || record.targets.length > 16 || record.targets.some(t => !t || Object.keys(t).some(k => !['tabId','targetId','depth'].includes(k)) || !Number.isSafeInteger(t.tabId) || t.tabId < 0 || t.targetId !== undefined && (typeof t.targetId !== 'string' || t.targetId.length > 128)))) throw fault('RECOVERY_STATE_UNSUPPORTED', 'Recovery record fields are invalid; preserved for inspection.');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw fault('RECOVERY_STATE_CORRUPT', 'Recovery record is incomplete or corrupt; preserved for inspection.');
    throw error;
  } finally { await handle?.close(); }
}
// Only the socket-owning host calls these writes. Clients never reclaim locks or
// perform a stat/rename compare-and-swap against another live writer.
export class RecoveryStore {
  constructor(instanceId) { this.instanceId = instanceId; this.queue = Promise.resolve(); }
  enqueue(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  read(key) { return readRecovery(this.instanceId, key); }
  write(key, record, {check = () => {}} = {}) { return this.enqueue(() => this.writeOwned(key, record, check)); }
  async writeOwned(key, record, check) {
    check();
    const file = recoveryPath(this.instanceId, key), dir = path.dirname(file);
    await privateDirectory(path.dirname(dir));
    await privateDirectory(dir);
    const next = {...record, v: 4, instanceId: this.instanceId, key, revision: crypto.randomUUID()};
    const body = JSON.stringify(next) + '\n';
    if (Buffer.byteLength(body) > 65536) throw fault('RECOVERY_STATE_LARGE', 'Recovery record exceeds 64 KiB.');
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    check();
    await fs.rename(temp, file);
    return next;
  }
  trim() { return this.enqueue(() => this.trimOwned()); }
  async trimOwned() {
    const dir = recoveryDirectory(this.instanceId);
    const retired = [];
    for (const name of await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await this.read(name.slice(0, -5)).catch(() => null);
      if (record?.status === 'retired') retired.push(record);
    }
    retired.sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const record of retired.slice(64)) await fs.unlink(recoveryPath(this.instanceId, record.key));
  }
}
export const planToken = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const authorityOf = record => Object.fromEntries(['instanceId','epoch','hostGeneration','leaseId','sessionKey'].map(k => [k, k === 'sessionKey' ? record.key : record[k]]));
export const sameAuthority = (a,b) => ['instanceId','epoch','hostGeneration','leaseId'].every(k => a?.[k] === b?.[k]);

export async function partialJournals(instance, key) {
  recoveryPath(instance,key);
  try { return (await fs.readdir(recoveryDirectory(instance))).filter(n => n.startsWith(key + '.json.') && /^[a-f0-9-]{36}\.tmp$/.test(n.slice(key.length + 6))).slice(0,16); }
  catch(e) { if(e.code==='ENOENT') return []; throw e; }
}
