// Shared plumbing for the opt-in real-browser suites (headless Chrome for
// Testing). Keeps every suite on a disposable profile and a test-only native
// messaging host, and never touches the user's installed com.latch.bridge.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HOST_NAME, configPath, ipcEndpoint} from '../../src/platform.mjs';

const exec = promisify(execFile);
export const TEST_HOST_PREFIX = 'com.latch.test_';
const HOSTS_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';
const REAL_KEY = `${HOSTS_KEY}\\${HOST_NAME}`;
export const HEADLESS_NOTE =
  'Headless Chrome for Testing run. Headless results do not establish headed focus behavior or tab-group collapse behavior.';

/** Skip reason for an opt-in browser suite, or false when it should run. */
export function suiteGate(flag, {windows = true, reason} = {}) {
  if (process.env[flag] !== '1') return `Set ${flag}=1 to run this real-browser suite.`;
  if (process.platform === 'win32' && !windows) return reason || 'Not supported on Windows.';
  if (process.platform === 'linux') return 'Real-browser suites are verified on macOS and Windows only.';
  return false;
}

export const testHostName = () => TEST_HOST_PREFIX + crypto.randomBytes(6).toString('hex');

const assertTestHost = name => {
  if (!name.startsWith(TEST_HOST_PREFIX) || !/^[a-z0-9_.]+$/.test(name)) throw new Error(`Refusing non-test native host name ${name}.`);
};

async function regValue(key) {
  try {
    const {stdout} = await exec('reg.exe', ['query', key, '/ve'], {windowsHide: true, timeout: 5000});
    const m = stdout.match(/REG_SZ\s+(.*)/);
    return m ? m[1].trim() : '';
  } catch {
    return null;
  }
}

/** Remove test host keys left behind by a crashed run (only com.latch.test_*, only when their manifest is gone). */
export async function sweepStaleTestHosts() {
  if (process.platform !== 'win32') return [];
  let stdout = '';
  try { ({stdout} = await exec('reg.exe', ['query', HOSTS_KEY], {windowsHide: true, timeout: 5000})); } catch { return []; }
  const removed = [];
  for (const line of stdout.split(/\r?\n/)) {
    const key = line.trim();
    const name = key.split('\\').pop();
    if (!name?.startsWith(TEST_HOST_PREFIX)) continue;
    const value = await regValue(key);
    if (value && (await fs.access(value).then(() => true, () => false))) continue;
    assertTestHost(name);
    await exec('reg.exe', ['delete', `${HOSTS_KEY}\\${name}`, '/f'], {windowsHide: true, timeout: 5000}).catch(() => {});
    removed.push(name);
  }
  return removed;
}

/**
 * Write a launcher that runs the native host with the fixture's private env.
 * Returns the launcher path to use in the host manifest.
 */
export async function writeHostLauncher(dir, {hostSource, env, stderrLog}) {
  const vars = ['LATCH_RUNTIME_DIR', 'LATCH_CONFIG', 'LATCH_HOME', 'LATCH_ARTIFACT_ROOT', 'LATCH_CAPTURE'].filter(k => env[k] !== undefined);
  if (process.platform === 'win32') {
    const esc = v => String(v).replaceAll('%', '%%').replaceAll('"', '');
    const file = path.join(dir, 'native-host.cmd');
    const body = ['@echo off', ...vars.map(k => `set "${k}=${esc(env[k])}"`), `"${esc(process.execPath)}" "${esc(hostSource)}" %* 2>>"${esc(stderrLog)}"`, ''].join('\r\n');
    await fs.writeFile(file, body);
    return file;
  }
  const q = v => "'" + String(v).replaceAll("'", "'\\''") + "'";
  const file = path.join(dir, 'native-host');
  await fs.writeFile(file, `#!/bin/sh\n${vars.map(k => `export ${k}=${q(env[k])}`).join('\n')}\nexec ${q(process.execPath)} ${q(hostSource)} "$@" 2>>${q(stderrLog)}\n`, {mode: 0o700});
  return file;
}

/**
 * Register a test-only native host. macOS/Linux: <profile>/NativeMessagingHosts.
 * Windows: Chrome only reads the registry, so add HKCU\...\NativeMessagingHosts\com.latch.test_*
 * pointing at a manifest inside the disposable fixture directory.
 */
export async function registerTestHost({name, profile, temp, manifest}) {
  assertTestHost(name);
  const body = JSON.stringify({...manifest, name});
  if (process.platform !== 'win32') {
    const hosts = path.join(profile, 'NativeMessagingHosts');
    await fs.mkdir(hosts, {recursive: true});
    const file = path.join(hosts, name + '.json');
    await fs.writeFile(file, body, {mode: 0o600, flag: 'wx'});
    return {manifestPath: file, registryKey: null, body};
  }
  const file = path.join(temp, name + '.json');
  await fs.writeFile(file, body, {flag: 'wx'});
  const registryKey = `${HOSTS_KEY}\\${name}`;
  if ((await regValue(registryKey)) !== null) throw new Error(`Test host key ${registryKey} already exists.`);
  await exec('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], {windowsHide: true, timeout: 5000});
  return {manifestPath: file, registryKey, body};
}

/** Unregister exactly what registerTestHost created, and only if it is still ours. */
export async function unregisterTestHost(reg) {
  if (!reg) return;
  if (reg.registryKey) {
    assertTestHost(reg.registryKey.split('\\').pop());
    if ((await regValue(reg.registryKey)) === reg.manifestPath)
      await exec('reg.exe', ['delete', reg.registryKey, '/f'], {windowsHide: true, timeout: 5000});
  }
  for (const file of [reg.manifestPath, reg.manifestPath + '.paused']) {
    if ((await fs.readFile(file, 'utf8').catch(() => '')) === reg.body) await fs.unlink(file);
  }
}

/** Suspend/restore a test host so Chrome cannot launch it (recovery tests). */
export async function suspendTestHost(reg) {
  if ((await fs.readFile(reg.manifestPath, 'utf8')) !== reg.body) throw new Error('Fixture registration changed');
  if (reg.registryKey) await exec('reg.exe', ['delete', reg.registryKey, '/f'], {windowsHide: true, timeout: 5000});
  await fs.rename(reg.manifestPath, reg.manifestPath + '.paused');
}
export async function restoreTestHost(reg) {
  if ((await fs.readFile(reg.manifestPath + '.paused', 'utf8')) !== reg.body) throw new Error('Fixture registration changed');
  await fs.rename(reg.manifestPath + '.paused', reg.manifestPath);
  if (reg.registryKey) await exec('reg.exe', ['add', reg.registryKey, '/ve', '/t', 'REG_SZ', '/d', reg.manifestPath, '/f'], {windowsHide: true, timeout: 5000});
}

const hash = async file => {
  const raw = await fs.readFile(file).catch(() => null);
  return raw ? crypto.createHash('sha256').update(raw).digest('hex') : null;
};

/**
 * Snapshot the user's real installation (registry value, manifest, config.json)
 * so a suite can prove afterwards that it left them untouched.
 */
export async function realInstallSnapshot() {
  const env = {...process.env};
  delete env.LATCH_CONFIG;
  const config = configPath(process.platform, env);
  const registry = process.platform === 'win32' ? await regValue(REAL_KEY) : undefined;
  return {
    registry,
    manifest: registry ? await hash(registry) : null,
    config: await hash(config),
  };
}
export async function assertRealInstallUnchanged(before) {
  const after = await realInstallSnapshot();
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error(`The real Latch installation changed during a browser suite: ${JSON.stringify({before, after})}`);
}

/** IPC endpoint (socket or named pipe) for a fixture runtime directory. */
export const fixtureEndpoint = (instanceId, runtime) => ipcEndpoint(instanceId, process.platform, {...process.env, LATCH_RUNTIME_DIR: runtime});

/** Short private runtime dir: Unix socket paths are capped near 100 bytes. */
export const fixtureRuntime = prefix =>
  path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `${prefix}-${crypto.randomBytes(5).toString('hex')}`);

/** Evidence record required by AGENTS.md for every headless run. */
export function browserEvidence({chrome, version, launchArgs, hostName, registryKey}) {
  return {
    headless: true,
    headlessMode: launchArgs.find(a => a.startsWith('--headless')) || null,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    browser: {binary: chrome, version},
    testOnlyLaunchFlags: launchArgs,
    nativeHost: {name: hostName, registryKey: registryKey || null, realHostTouched: false},
    profile: 'disposable',
    note: HEADLESS_NOTE,
  };
}
