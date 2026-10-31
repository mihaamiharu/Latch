import fs from 'node:fs/promises';
import os from 'node:os';
import {readConfig, configPath, rootDir, socketPath, request} from './local.mjs';
import {profileTransport} from './transport.mjs';
import {fault, safeError} from '../extension/protocol.js';

// Read-only: reports this exact caller's context without listing browser tabs,
// reading credentials, changing pairing, or modifying client permissions.
export async function diagnose(profileAlias = 'work') {
  const result = {healthy: false, profileAlias,
    layers: {configuration: 'unknown', host: 'not-checked', controller: 'unknown', native: 'unknown', cli: 'not-checked', attachment: 'not-checked', application: 'not-checked'},
    execution: {hostname: os.hostname(), platform: process.platform, uid: process.getuid?.() ?? null,
      nodeVersion: process.version, nodeExecutable: process.execPath, workingDirectory: process.cwd()},
    paths: {configuration: configPath(), runtimeDirectory: rootDir()},
    overrides: {configuration: !!process.env.QA_BROWSER_CONFIG, runtimeDirectory: !!process.env.QA_BROWSER_RUNTIME_DIR, latchHome: !!process.env.LATCH_HOME}};
  let profile;
  try {
    const config = await readConfig();
    profile = config.profiles?.[profileAlias];
    result.configuration = {readable: true, paired: !!profile};
    result.layers.configuration = profile ? 'paired' : 'unpaired';
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
    if (live.instanceId !== profile.instanceId) throw fault('BRIDGE_IDENTITY_CHANGED', 'Status did not identify the paired profile. No task was attached.');
    result.connection = {ok: true, instanceId: live.instanceId, epoch: live.epoch, extensionVersion: live.extensionVersion, releaseVersion: live.releaseVersion,
      hostGeneration: live.hostGeneration, readiness: live.readiness, capabilities: live.capabilities ?? null};
    Object.assign(result.layers, {host: 'reachable', controller: live.readiness?.verified ? 'verified-round-trip' : 'unverified', native: live.capabilities?.nativeTransport === true ? 'available' : live.capabilities?.nativeTransport === false ? 'unavailable' : 'unknown', officialAttachment: 'not-checked'});
    result.bridgeHealthy = live.capabilities?.nativeSessionSchema === 4 ? live.readiness?.verified === true : true;
    result.healthy = result.bridgeHealthy && !result.transport.error;
  } catch (error) { result.connection = {ok: false, error: safeError(error)}; result.layers.host = error.code === 'BRIDGE_ACCESS_DENIED' ? 'access-denied' : 'unreachable'; }
  return result;
}
