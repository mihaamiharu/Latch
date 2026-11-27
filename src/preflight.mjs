import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {diagnose} from './diagnostics.mjs';
import {cliError} from './redact.mjs';
import {rootDir} from './local.mjs';
import {sessionsDir} from './platform.mjs';
import {assertNodeVersion, assertSetupPlatform} from './compatibility.mjs';

async function writable(directory) {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, '.latch-preflight-' + crypto.randomUUID());
  let handle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
    await handle.writeFile('probe');
    await handle.sync();
  } finally {
    if (handle) {
      await handle.close();
      await fs.unlink(file);
    }
  }
}

export async function preflight({alias = 'work', workspace, session}) {
  const checks = [];
  const check = async (id, operation) => {
    try {
      const observed = await operation();
      checks.push({id, status: 'pass', observed});
      return true;
    } catch (error) {
      checks.push({id, status: 'blocked', error: cliError(error)});
      return false;
    }
  };
  await check('platform', assertSetupPlatform);
  await check('node', async () => assertNodeVersion(process.version));
  const health = await diagnose(alias);
  checks.push({
    id: 'bridge-controller',
    status: health.healthy ? 'pass' : 'blocked',
    observed: health.layers,
    ...(health.connection?.error ? {error: health.connection.error} : {}),
  });
  const cap = health.connection?.capabilities;
  const native =
    health.connection?.ok &&
    health.connection.readiness?.verified === true &&
    cap?.nativeTransport === true &&
    cap.nativeSessionSchema === 4 &&
    cap.recoveryContract === 1;
  checks.push({
    id: 'native-capability',
    status: native ? 'pass' : health.connection?.ok ? 'blocked' : 'unknown',
  });
  const paths = {
    sessions: sessionsDir(),
    runtime: rootDir(),
  };
  if (checks.every(item => item.status === 'pass')) {
    for (const [id, directory] of Object.entries(paths)) {
      await check('write-' + id, async () => {
        await writable(directory);
        return {directory, probeRemoved: true};
      });
    }
  } else {
    checks.push({
      id: 'writes',
      status: 'unknown',
      reason: 'Prerequisites failed; no state directory writes were attempted.',
    });
  }
  return {
    ready: checks.every(item => item.status === 'pass'),
    scope: 'same-caller-prerequisites',
    profile: alias,
    workspace,
    session,
    checks,
    paths,
    health,
    attachment: 'not-checked',
    application: 'not-checked',
    permissionTools: 'not-observable-from-cli',
    guidance:
      'For access denial, inspect the actual client tool inventory. Request approval for the exact blocked command only if that facility is available; otherwise stop and use a permitted local execution context. Do not change global policies or retry browser actions.',
    sideEffects:
      'Creates missing app-data session/runtime directories and removes its own probe files; never writes workspace dotfiles, attaches, or changes profile defaults.',
  };
}
