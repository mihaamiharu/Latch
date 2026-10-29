import {readConfig, request} from './local.mjs';
import {fault, safeError} from '../extension/protocol.js';
import {recoveryInspection} from './native-recovery.mjs';
import {nativeChannel} from './native-channel.mjs';

export async function reconcile({alias, workspace, session, key, apply = false, expect}) {
  const profile = (await readConfig()).profiles?.[alias];
  if (!profile) throw fault('PROFILE_UNPAIRED', 'No paired profile is configured.');
  let identity, connectionError;
  try { identity = await request(profile.instanceId, 'status', {}, 2500); }
  catch(e) { connectionError = safeError(e); }
  const metadata = {workspace, session, sessionKey: key};
  if (!identity || identity.capabilities?.nativeSessionSchema !== 4) {
    const plan = await recoveryInspection({instanceId: profile.instanceId, key, offlineError: connectionError || {code: 'RECOVERY_UNSUPPORTED'}});
    if (apply) throw fault(connectionError?.code || 'RECOVERY_UNSUPPORTED', 'Recovery apply needs a verified schema-4 native bridge. State was preserved.');
    return {profile: alias, session, workspace, ...plan};
  }
  if (!apply) return {profile: alias, session, workspace, ...await request(profile.instanceId, 'native-reconcile', {instanceId: identity.instanceId, epoch: identity.epoch, hostGeneration: identity.hostGeneration, ...metadata}, 12000)};
  if (!/^[a-f0-9]{64}$/.test(expect || '')) throw fault('RECOVERY_EXPECT_REQUIRED', 'Apply requires --expect from the current read-only recovery plan.');
  const channel = await nativeChannel(identity, metadata);
  try { return {profile: alias, session, workspace, ...await channel.send('apply', {expect})}; }
  finally { await channel.close().catch(() => {}); }
}
