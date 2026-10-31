import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {diagnose} from './diagnostics.mjs';
import {assertVersion} from './playwright.mjs';
import {daemonFile} from './daemon-identity.mjs';
import {rootDir} from './local.mjs';
import {SUPPORT, assertSetupPlatform} from './compatibility.mjs';
import {cliError} from './playwright.mjs';

async function writable(directory) {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, '.latch-preflight-' + crypto.randomUUID());
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); await handle.writeFile('probe'); await handle.sync(); }
  finally { if (handle) { await handle.close(); await fs.unlink(file); } }
}
async function loopback() {
  // Check this caller's local networking, without touching the browser or
  // pretending it proves access to the eventual authenticated CDP endpoint.
  await new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.end());
    let client, settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); client?.destroy();
      server.close(() => error ? reject(error) : resolve());
    };
    const timer = setTimeout(() => finish(new Error('Local loopback probe timed out.')), 2000);
    server.once('error', finish);
    server.listen(0, '127.0.0.1', () => {
      client = net.createConnection(server.address().port, '127.0.0.1');
      client.once('error', finish); client.once('connect', () => finish());
    });
  });
}
export async function preflight({alias = 'work', workspace, session}) {
  const checks = [];
  const check = async (id, operation) => {
    try { const observed = await operation(); checks.push({id, status: 'pass', observed}); return true; }
    catch (error) { checks.push({id, status: 'blocked', error: cliError(error)}); return false; }
  };
  await check('platform', assertSetupPlatform);
  await check('node', async () => { if (process.version !== SUPPORT.node) throw new Error(`Use Node ${SUPPORT.node}; found ${process.version}.`); return process.version; });
  await check('playwright-cli', () => assertVersion({workspace, timeout: 10000}));
  const health = await diagnose(alias);
  checks.push({id: 'bridge-controller', status: health.healthy ? 'pass' : 'blocked', observed: health.layers,
    ...(health.connection?.error ? {error: health.connection.error} : {})});
  const cap = health.connection?.capabilities;
  const native = health.connection?.ok && health.connection.readiness?.verified === true &&
    cap?.nativeTransport === true && cap.nativeSessionSchema === 4 && cap.recoveryContract === 1;
  checks.push({id: 'native-capability', status: native ? 'pass' : health.connection?.ok ? 'blocked' : 'unknown'});
  const paths = {workspaceRegistry: path.join(workspace, '.playwright'),
    playwrightArtifacts: path.join(workspace, '.playwright-cli'),
    daemonCache: path.dirname(daemonFile(workspace, session)), recovery: rootDir()};
  if (checks.every(item => item.status === 'pass')) {
    for (const [id, directory] of Object.entries(paths)) await check('write-' + id, async () => { await writable(directory); return {directory, probeRemoved: true}; });
    await check('local-loopback', async () => { await loopback(); return 'caller-listen-and-connect'; });
  } else {
    checks.push({id: 'writes-and-loopback', status: 'unknown', reason: 'Prerequisites failed; no task writes or networking probes were attempted.'});
  }
  return {ready: checks.every(item => item.status === 'pass'), scope: 'same-caller-prerequisites',
    profile: alias, workspace, session, checks, paths, health,
    attachment: 'not-checked', application: 'not-checked',
    permissionTools: 'not-observable-from-cli',
    guidance: 'For access denial, inspect the actual client tool inventory. Request approval for the exact blocked command only if that facility is available; otherwise stop and use a permitted local execution context. Do not change global policies or retry browser actions.',
    sideEffects: 'Creates missing task/cache directories and removes its own probe files; never attaches or changes profile defaults.'};
}
