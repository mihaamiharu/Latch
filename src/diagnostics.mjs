import fs from 'node:fs/promises';
import os from 'node:os';
import {readConfig, configPath, rootDir, socketPath, request} from './local.mjs';
import {profileTransport} from './transport.mjs';
import {safeError} from '../extension/protocol.js';

// Read-only: reports this exact caller's context without listing browser tabs,
// reading credentials, changing pairing, or modifying client permissions.
export async function diagnose(profileAlias = 'work') {
  const result = {healthy: false, profileAlias,
    execution: {hostname: os.hostname(), platform: process.platform, uid: process.getuid?.() ?? null,
      nodeVersion: process.version, nodeExecutable: process.execPath, workingDirectory: process.cwd()},
    paths: {configuration: configPath(), runtimeDirectory: rootDir()},
    overrides: {configuration: !!process.env.QA_BROWSER_CONFIG, runtimeDirectory: !!process.env.QA_BROWSER_RUNTIME_DIR, latchHome: !!process.env.LATCH_HOME}};
  let profile;
  try {
    const config = await readConfig();
    profile = config.profiles?.[profileAlias];
    result.configuration = {readable: true, paired: !!profile};
    if (profile) result.configuration.chromeProfileDirectory = profile.chromeProfileDir;
  } catch (error) {
    result.configuration = {readable: false, paired: null, error: safeError(error)};
    return result;
  }
  if (!profile) {
    result.connection = {ok: false, error: {code: 'PROFILE_UNPAIRED', message: 'This caller could not find the requested alias in its readable configuration.'}};
    return result;
  }
  try { result.transport = profileTransport(profile); }
  catch (error) { result.transport = {error: safeError(error)}; }
  try {
    result.paths.socket = socketPath(profile.instanceId);
    try {
      const stat = await fs.lstat(result.paths.socket);
      result.socket = {exists: true, isSocket: stat.isSocket(), ownerUid: stat.uid, mode: (stat.mode & 0o777).toString(8)};
    } catch (error) { result.socket = {exists: error.code === 'ENOENT' ? false : null, error: safeError(error)}; }
    const live = await request(profile.instanceId, 'status', {}, 2500);
    result.connection = {ok: true, instanceId: live.instanceId, epoch: live.epoch, extensionVersion: live.extensionVersion, releaseVersion: live.releaseVersion,
      hostGeneration: live.hostGeneration, readiness: live.readiness, capabilities: live.capabilities || {nativeTransport: false}};
    result.layers = {configuration: 'paired', host: 'reachable', controller: live.readiness?.verified ? 'verified-round-trip' : 'legacy-host-report', native: live.capabilities?.nativeTransport ? 'available' : 'unavailable'};
    result.bridgeHealthy = true;
    result.healthy = !result.transport.error;
  } catch (error) { result.connection = {ok: false, error: safeError(error)}; }
  return result;
}
