import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {configPath, request, updateConfig, uuid} from './local.mjs';

// Replaces a pairing after an instance change, from an ID the operator read in the popup
// of the intended profile. Never automatic: this is what keeps one Chrome profile from
// silently taking over another profile's pairing.
export async function replacePairing({alias, instance, expectOld, chromeProfileDir}) {
  if (!uuid.test(expectOld || '')) throw fault('INVALID_PAIRING', 'Specify the currently paired instance UUID with --expect-old.');
  if (expectOld === instance) throw fault('INVALID_PAIRING', 'The new instance is already the expected old instance.');
  // A live old instance means the new ID belongs to something else, usually another profile.
  const old = await request(expectOld, 'status', {}, 2500).then(() => 'live', error => {
    if (error.code === 'PROFILE_UNAVAILABLE') return 'gone';
    throw error;
  });
  if (old === 'live') throw fault('PAIRING_OLD_INSTANCE_LIVE', 'The old instance is still running, so the new one may belong to another Chrome profile. Pairing was not changed.');
  const live = await request(instance, 'status');
  if (live.instanceId !== instance || live.readiness?.verified !== true)
    throw fault('PAIRING_NOT_VERIFIED', 'The new instance is not verified and ready. Pairing was not changed.');
  return updateConfig(async config => {
    const profile = config.profiles?.[alias];
    if (!profile) throw fault('PROFILE_UNPAIRED', 'Nothing to replace: this profile alias is not paired.');
    if (profile.instanceId !== expectOld) throw fault('PAIRING_CHANGED', 'The paired instance is not the expected old instance. Pairing was not changed.');
    if (profile.chromeProfileDir !== chromeProfileDir) throw fault('PAIRING_PROFILE_DIRECTORY_CHANGED', 'Replacing changes only the instance. Pairing was not changed.');
    const backup = path.join(path.dirname(configPath()), `config-before-replace-${expectOld.slice(0, 8)}-${Date.now()}.json`);
    await fs.writeFile(backup, JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    profile.instanceId = instance;
    return {paired: true, replaced: true, profile: alias, before: expectOld, after: instance, backup,
      note: 'Only the instance changed. Records under the old instance are preserved; verify the profile with a first connection.'};
  });
}
