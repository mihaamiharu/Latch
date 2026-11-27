import {readConfig, request} from './local.mjs';
import {fault, safeError} from '../extension/protocol.js';
import {readWorkspaceBinding, removeWorkspaceBinding} from './recovery-state.mjs';

/**
 * Simplified session inspection and cleanup.
 * With playwright-core running inside native-host, recovery reduces to
 * inspecting live/bound sessions and disconnecting or cleaning stale bindings.
 */
export async function reconcile({alias = 'work', workspace, session, key, apply = false}) {
  const profile = (await readConfig()).profiles?.[alias];
  if (!profile) throw fault('PROFILE_UNPAIRED', 'No paired profile is configured.');

  let identity;
  let connectionError;
  try {
    identity = await request(profile.instanceId, 'status', {}, 2500);
  } catch (e) {
    connectionError = safeError(e);
  }

  const binding = await readWorkspaceBinding(workspace).catch(() => null);
  const bound = binding?.sessions?.[session] || null;

  if (!identity) {
    if (apply) {
      await removeWorkspaceBinding(workspace, session || key).catch(() => {});
      return {profile: alias, session, workspace, disconnected: false, bindingCleared: !!bound, online: false};
    }
    return {
      profile: alias,
      session,
      workspace,
      sessionKey: key,
      online: false,
      healthy: false,
      status: bound ? 'interrupted' : 'absent',
      binding: bound,
      connectionError,
    };
  }

  const list = await request(profile.instanceId, 'session-list', {
    instanceId: identity.instanceId,
    epoch: identity.epoch,
  });
  const live = (list.sessions || []).find(s => s.sessionKey === key);
  const healthy = !!live && !live.stopped;

  if (apply) {
    if (live) {
      const disconnected = await request(profile.instanceId, 'session-disconnect', {
        instanceId: identity.instanceId,
        epoch: identity.epoch,
        hostGeneration: identity.hostGeneration,
        sessionKey: key,
        workspace,
        session,
      });
      return {profile: alias, session, workspace, ...disconnected};
    }
    await removeWorkspaceBinding(workspace, session || key).catch(() => {});
    return {profile: alias, session, workspace, disconnected: true, alreadyDisconnected: true, preservedUserTabs: true};
  }

  return {
    profile: alias,
    session,
    workspace,
    sessionKey: key,
    online: true,
    healthy,
    status: healthy ? 'healthy' : bound || live ? 'interrupted' : 'absent',
    live: live || null,
    binding: bound,
  };
}
