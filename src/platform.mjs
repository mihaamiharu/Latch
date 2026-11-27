import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fault} from '../extension/protocol.js';

const exec = promisify(execFile);

export const HOST_NAME = 'com.latch.bridge';
export const EXTENSION_ID = 'dlkpkeiejlgggeoibejpoajedoelfcli';
export const MINIMUM_NODE_VERSION = '22.0.0';
export const MINIMUM_CHROME_VERSION = '125';
export const WINDOWS_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
export const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const quoteShell = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function appDataDir(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Latch');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Latch');
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'latch');
}

export function latchHome(defaultRoot, env = process.env) {
  return env.LATCH_HOME ? path.resolve(env.LATCH_HOME) : defaultRoot;
}

export function configPath(platform = process.platform, env = process.env) {
  if (env.LATCH_CONFIG) return path.resolve(env.LATCH_CONFIG);
  return path.join(appDataDir(platform, env), 'config.json');
}

export function libraryRoot(platform = process.platform, env = process.env) {
  if (env.LATCH_ARTIFACT_ROOT) return path.resolve(env.LATCH_ARTIFACT_ROOT);
  return path.join(path.dirname(configPath(platform, env)), 'artifacts');
}

export function sessionsDir(platform = process.platform, env = process.env) {
  return path.join(path.dirname(configPath(platform, env)), 'sessions');
}

export function workspaceBindingPath(workspace = process.cwd(), platform = process.platform, env = process.env) {
  let resolved;
  try {
    resolved = fsSync.realpathSync(workspace);
  } catch {
    resolved = path.resolve(workspace);
  }
  const digest = crypto.createHash('sha256').update(resolved).digest('hex');
  return path.join(sessionsDir(platform, env), `${digest}.json`);
}

export function runtimeDir(platform = process.platform, env = process.env) {
  if (env.LATCH_RUNTIME_DIR) return env.LATCH_RUNTIME_DIR;
  if (platform === 'win32') return path.join(appDataDir(platform, env), 'runtime');
  // Darwin's per-user os.tmpdir() can exceed the Unix-domain socket path limit.
  return path.join(platform === 'darwin' ? '/tmp' : os.tmpdir(), `latch-${process.getuid?.() ?? 'local'}`);
}

function pipeNamespace(env) {
  if (!env.LATCH_RUNTIME_DIR) return '';
  return crypto.createHash('sha256').update(path.resolve(env.LATCH_RUNTIME_DIR)).digest('hex').slice(0, 8) + '-';
}

export function ipcEndpoint(instanceId, platform = process.platform, env = process.env) {
  if (!UUID_PATTERN.test(instanceId)) throw fault('INVALID_PROFILE', 'Invalid extension instance ID.');
  if (platform === 'win32') {
    return `\\\\.\\pipe\\latch-${pipeNamespace(env)}${instanceId}`;
  }
  const result = path.join(runtimeDir(platform, env), `${instanceId}.sock`);
  if (Buffer.byteLength(result) > 100) throw fault('SOCKET_PATH_LONG', 'Use a shorter LATCH_RUNTIME_DIR path.');
  return result;
}

export function isWindowsPipe(address) {
  return typeof address === 'string' && address.startsWith('\\\\.\\pipe\\');
}

export async function discoverIpcEndpoints(platform = process.platform, env = process.env) {
  const runtimeDirectory = runtimeDir(platform, env);
  if (platform === 'win32') {
    const runtimeDirectoryExists = await fs.access(runtimeDirectory).then(() => true, () => false);
    const prefix = `latch-${pipeNamespace(env)}`;
    let entries = [];
    try {
      entries = await fs.readdir('\\\\.\\pipe\\');
    } catch {
      entries = [];
    }
    const instanceIds = entries
      .filter(name => name.startsWith(prefix))
      .map(name => name.slice(prefix.length))
      .filter(id => UUID_PATTERN.test(id));
    return {instanceIds, runtimeDirectory, runtimeDirectoryExists};
  }
  let entries;
  try {
    entries = await fs.readdir(runtimeDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return {instanceIds: [], runtimeDirectory, runtimeDirectoryExists: false};
    throw error;
  }
  const instanceIds = entries
    .filter(n => n.endsWith('.sock') && UUID_PATTERN.test(n.slice(0, -5)))
    .map(n => n.slice(0, -5));
  return {instanceIds, runtimeDirectory, runtimeDirectoryExists: true};
}

export async function privateDirectory(dir, platform = process.platform) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw fault('UNSAFE_DIRECTORY', 'Bridge directory must be owned by the current user and not a symlink.');
  }
  if (platform !== 'win32') {
    await fs.chmod(dir, 0o700);
  }
}

export async function linkDirectory(target, linkPath, platform = process.platform) {
  const resolvedTarget = path.resolve(target);
  const type = platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(resolvedTarget, linkPath, type);
}

export async function replaceDirectoryLink(linkPath, target, platform = process.platform) {
  const resolvedTarget = path.resolve(target);
  if (platform === 'win32') {
    try {
      const stat = await fs.lstat(linkPath);
      if (stat.isSymbolicLink()) await fs.unlink(linkPath);
      else await fs.rm(linkPath, {recursive: true, force: true});
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.symlink(resolvedTarget, linkPath, 'junction');
    return;
  }
  const temp = `${linkPath}.${crypto.randomUUID()}.tmp`;
  await fs.symlink(resolvedTarget, temp, 'dir');
  try {
    await fs.rename(temp, linkPath);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function isSameRegularFile(lstatStat, handleStat, filePath, platform = process.platform) {
  if (!lstatStat?.isFile() || lstatStat.isSymbolicLink() || !handleStat?.isFile()) return false;
  if (platform !== 'win32') {
    return handleStat.ino === lstatStat.ino && handleStat.dev === lstatStat.dev;
  }
  // NTFS lstat() reports dev === 0 while fstat() reports the volume serial; verify path identity via realpath instead.
  const [realFile, realDir] = await Promise.all([fs.realpath(filePath), fs.realpath(path.dirname(filePath))]);
  return realFile.toLowerCase() === path.join(realDir, path.basename(filePath)).toLowerCase();
}

export function nativeMessagingManifestDir(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return path.join(appDataDir('win32', env), 'NativeMessagingHosts');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'google-chrome', 'NativeMessagingHosts');
}

export function nativeMessagingManifestPath(platform = process.platform, env = process.env, registrationRoot) {
  const dir = registrationRoot ? path.resolve(registrationRoot) : nativeMessagingManifestDir(platform, env);
  return path.join(dir, `${HOST_NAME}.json`);
}

export function launcherFileName(name, platform = process.platform) {
  return platform === 'win32' ? (name.endsWith('.cmd') ? name : `${name}.cmd`) : name;
}

export function buildNativeHostManifest({launcherPath, description = 'Latch native browser bridge'}) {
  return {
    name: HOST_NAME,
    description,
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

export async function writeLauncher({dir, name, nodeExecutable, targetScript, platform = process.platform}) {
  await privateDirectory(dir, platform);
  const file = path.join(dir, launcherFileName(name, platform));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  if (platform === 'win32') {
    const esc = s => String(s).replaceAll('%', '%%');
    const body = `@echo off\r\n"${esc(nodeExecutable)}" "${esc(targetScript)}" %*\r\n`;
    await fs.writeFile(temp, body, {flag: 'wx'});
  } else {
    const body = `#!/bin/sh\nexec ${quoteShell(nodeExecutable)} ${quoteShell(targetScript)} "$@"\n`;
    await fs.writeFile(temp, body, {flag: 'wx', mode: 0o700});
  }
  await fs.rename(temp, file);
  if (platform !== 'win32') await fs.chmod(file, 0o700);
  return file;
}

export async function registerNativeHost({
  manifestPath,
  manifest,
  platform = process.platform,
  registryKey = WINDOWS_REGISTRY_KEY,
  skipRegistry = false,
}) {
  const dir = path.dirname(manifestPath);
  await privateDirectory(dir, platform);
  const body = JSON.stringify(manifest, null, 2) + '\n';
  const temp = `${manifestPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, body, platform === 'win32' ? {flag: 'wx'} : {flag: 'wx', mode: 0o600});
  await fs.rename(temp, manifestPath);
  if (platform === 'win32' && !skipRegistry) {
    await exec('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
      windowsHide: true,
      timeout: 5000,
    });
  }
  return {manifestPath, ...(platform === 'win32' ? {registryKey: skipRegistry ? null : registryKey} : {})};
}

export async function unregisterNativeHost({
  manifestPath,
  platform = process.platform,
  registryKey = WINDOWS_REGISTRY_KEY,
  skipRegistry = false,
}) {
  let removedManifest = false;
  try {
    await fs.unlink(manifestPath);
    removedManifest = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let removedRegistryKey = false;
  if (platform === 'win32' && !skipRegistry) {
    try {
      await exec('reg.exe', ['delete', registryKey, '/f'], {windowsHide: true, timeout: 5000});
      removedRegistryKey = true;
    } catch (error) {
      const msg = String(error.stderr || error.message || '');
      if (!/unable to find/i.test(msg) && error.code !== 1) throw error;
    }
  }
  return {removedManifest, ...(platform === 'win32' ? {removedRegistryKey} : {})};
}

export async function readNativeHostRegistration({
  manifestPath,
  platform = process.platform,
  registryKey = WINDOWS_REGISTRY_KEY,
  skipRegistry = false,
}) {
  let raw = null;
  let manifest = null;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  let registryValue = null;
  if (platform === 'win32' && !skipRegistry) {
    try {
      const {stdout} = await exec('reg.exe', ['query', registryKey, '/ve'], {windowsHide: true, timeout: 5000});
      const match = stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)\r?\n?/);
      registryValue = match ? match[1].trim() : null;
    } catch {
      registryValue = null;
    }
  }
  return {exists: raw !== null, raw, manifest, ...(platform === 'win32' ? {registryValue, registryKey} : {})};
}

export async function resolveExecutable(selected, workspace = process.cwd(), env = process.env, platform = process.platform) {
  const hasSep = selected.includes('/') || (platform === 'win32' && selected.includes('\\')) || path.isAbsolute(selected);
  const pathExts =
    platform === 'win32' && !path.extname(selected)
      ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.JS;.MJS').split(';').filter(Boolean)]
      : [''];
  const bases = hasSep
    ? [path.resolve(workspace, selected)]
    : (env.PATH || '').split(path.delimiter).map(dir => path.resolve(workspace, dir || '.', selected));

  for (const base of bases) {
    for (const ext of pathExts) {
      const candidate = base + ext;
      try {
        const resolved = await fs.realpath(candidate);
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) continue;
        if (platform !== 'win32') await fs.access(resolved, constants.X_OK);
        return resolved;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
      }
    }
  }
  throw fault(
    'SETUP_EXECUTABLE_UNAVAILABLE',
    `Cannot resolve the selected executable: ${selected}. Supply its absolute path; no installation changes were made.`,
  );
}

async function isNodeShebangScript(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(128);
    const {bytesRead} = await handle.read(buf, 0, 128, 0);
    const firstLine = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    return firstLine.startsWith('#!') && /node(?:\.exe)?\b/i.test(firstLine);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

export async function spawnCommandSpec(executable, args, {nodeExecutable, env = process.env, platform = process.platform} = {}) {
  if (platform !== 'win32') {
    return {command: executable, args, options: {shell: false}};
  }
  let resolved = executable;
  const hasSep = executable.includes('/') || executable.includes('\\') || path.isAbsolute(executable);
  if (!hasSep) {
    try {
      resolved = await resolveExecutable(executable, process.cwd(), env, platform);
    } catch {
      resolved = executable;
    }
  }
  const ext = path.extname(resolved).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext) || (!ext && (await isNodeShebangScript(resolved)))) {
    return {command: nodeExecutable || process.execPath, args: [resolved, ...args], options: {shell: false}};
  }
  if (['.cmd', '.bat'].includes(ext)) {
    return {command: env.ComSpec || 'cmd.exe', args: ['/d', '/c', resolved, ...args], options: {shell: false}};
  }
  return {command: resolved, args, options: {shell: false}};
}
