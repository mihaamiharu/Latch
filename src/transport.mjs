import {fault} from '../extension/protocol.js';
import {readConfig, updateConfig, request} from './local.mjs';

const valid = value => ['official', 'native'].includes(value);
export function profileTransport(profile) {
  const configured = profile?.defaultTransport;
  if (configured !== undefined && !valid(configured))
    throw fault('INVALID_TRANSPORT_DEFAULT', 'Unknown profile transport preference. Inspect it or explicitly set official/native.');
  return {configuredDefault: configured ?? null, defaultTransport: configured ?? 'official'};
}
export function selectTransport({explicit, profile, legacy, nativeRecord, command}) {
  if (explicit !== undefined && !valid(explicit)) throw fault('INVALID_ARGUMENT', 'Transport must be official or native.');
  if (legacy?.transport !== undefined && !valid(legacy.transport))
    throw fault('SESSION_STATE_UNSUPPORTED', 'Unknown recorded transport; preserve and inspect this session.');
  if (legacy && nativeRecord && nativeRecord.status !== 'retired')
    throw fault('SESSION_STATE_CONFLICT', 'Legacy and native records both exist for this task. Inspect them before cleanup.');
  const preference = profileTransport(profile);
  const recorded = legacy ? legacy.transport || 'official' : nativeRecord && (nativeRecord.status !== 'retired' || command === 'disconnect') ? 'native' : null;
  return {...preference, transport: explicit || recorded || preference.defaultTransport,
    transportSource: explicit ? 'explicit' : recorded ? 'session' : preference.configuredDefault ? 'profile-default' : 'legacy-default'};
}
export async function transportPreference(alias, value) {
  if (value !== undefined && !valid(value)) throw fault('INVALID_ARGUMENT', 'Use --set official|native.');
  const inspect = config => {
    const profile = config.profiles?.[alias];
    if (!profile) throw fault('PROFILE_UNPAIRED', 'The requested profile alias is not paired.');
    return profile;
  };
  if (value === undefined) return {profile: alias, ...profileTransport(inspect(await readConfig())), appliesTo: 'new-sessions'};
  return updateConfig(async config => {
    const profile = inspect(config);
    if (value === 'native') {
      const live = await request(profile.instanceId, 'status', {}, 2500);
      const cap = live.capabilities;
      if (live.instanceId !== profile.instanceId || !cap?.nativeTransport || cap.nativeSessionSchema !== 4 || cap.recoveryContract !== 1)
        throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'Install and verify the schema-4 native bridge before selecting the native default.');
    }
    const updated = profile.defaultTransport !== value;
    profile.defaultTransport = value;
    return {profile: alias, ...profileTransport(profile), updated, appliesTo: 'new-sessions', existingSessionsUnchanged: true};
  });
}
