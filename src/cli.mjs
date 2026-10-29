#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {discoverDetailed, request, readConfig, updateConfig, uuid} from './local.mjs';
import {diagnose} from './diagnostics.mjs';
import {fault, safeError} from '../extension/protocol.js';
import {workspaceAt, sessionKey, runCLI, assertVersion, connectionURL, selectAndVerify, redact} from './playwright.mjs';
import {readSession, writeSession, forgetSession, locked} from './state.mjs';
import {nativeWorkflow} from './native-workflow.mjs';
import {nativeWorkflowV4} from './native-workflow-v4.mjs';
import {readRecovery} from './recovery-state.mjs';
import {reconcile} from './reconcile.mjs';
import {ROOT} from './release.mjs';
import {selectTransport, transportPreference} from './transport.mjs';
const releaseVersion=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8')).version;

const usage = `Latch ${releaseVersion}
  qa-browser discover
  qa-browser pair --profile work --instance <uuid> --chrome-profile-dir <directory>
  qa-browser doctor --profile work
  qa-browser transport --profile work [--set official|native]
  qa-browser diagnose --profile work
  qa-browser reconcile --profile work --session <name> [--workspace <path>] [--apply --expect <plan-token>]
  qa-browser tabs --profile work
  qa-browser connect --profile work --session <name> --tab <id> [--workspace <path>] [--transport official|native] [--focus-emulation on|off]
  qa-browser release --profile work --session <name> --tab <id> [--workspace <path>]
  qa-browser disconnect --profile work --session <name> [--workspace <path>]
All results are JSON. Work-profile extension installation/authorization is a one-time prerequisite.
`;
function parse(argv) {
  const command = argv.shift() || 'help';
  const flags = {};
  const allowed = new Set(['profile', 'instance', 'chrome-profile-dir', 'session', 'tab', 'workspace', 'json', 'transport', 'focus-emulation', 'apply', 'expect', 'set']);
  while (argv.length) {
    const flag = argv.shift();
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw fault('INVALID_ARGUMENT', 'Unknown argument. Use qa-browser help.');
    const key = flag.slice(2);
    if (['json', 'apply'].includes(key)) { if (flags[key]) throw fault('INVALID_ARGUMENT', 'Repeated flag.'); flags[key] = true; continue; }
    const value = argv.shift();
    if (!value || value.startsWith('--') || flags[key]) throw fault('INVALID_ARGUMENT', `Missing or repeated --${key}.`);
    flags[key] = value;
  }
  return {command, flags};
}
async function paired(name) {
  const config = await readConfig();
  const profile = config.profiles?.[name];
  if (!profile) throw fault('PROFILE_UNPAIRED', 'Pair the Work extension instance before using this profile alias.');
  const live = await request(profile.instanceId, 'status');
  return {...profile, ...live};
}
async function main() {
  const {command, flags: f} = parse(process.argv.slice(2));
  if (['help', '--help'].includes(command)) { console.log(usage); return; }
  if (['version','--version'].includes(command)) return {version:releaseVersion,nativeSessionSchema:4,uiControl:1,validatedCLI:'0.1.20'};
  if (command === 'discover') return await discoverDetailed();
  const alias = f.profile || 'work';
  if (f.transport && !['official', 'native'].includes(f.transport)) throw fault('INVALID_ARGUMENT', 'Transport must be official or native.');
  if (f['focus-emulation'] && (command !== 'connect' || !['on', 'off'].includes(f['focus-emulation'])))
    throw fault('INVALID_ARGUMENT', 'Use --focus-emulation on|off with native connect.');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias)) throw fault('INVALID_PROFILE', 'Use a simple profile alias.');
  if (f.set !== undefined && command !== 'transport') throw fault('INVALID_ARGUMENT', 'Use --set only with transport.');
  if (command === 'transport') return transportPreference(alias, f.set);
  if (command === 'diagnose') return await diagnose(alias);
  if (command === 'pair') {
    if (!uuid.test(f.instance || '') || !/^(Default|Profile \d+)$/.test(f['chrome-profile-dir'] || ''))
      throw fault('INVALID_PAIRING', 'Specify the extension instance UUID and Chrome profile directory (Default or Profile N).');
    const live = await request(f.instance, 'status');
    return updateConfig(config => {
      if (config.profiles?.[alias] && config.profiles[alias].instanceId !== f.instance)
        throw fault('PROFILE_ALREADY_PAIRED', 'This alias is already paired to another instance. Review the config before changing it.');
      config.profiles ||= {};
      config.profiles[alias] = {...config.profiles[alias], instanceId: live.instanceId, chromeProfileDir: f['chrome-profile-dir']};
      return {paired: true, profile: alias, ...config.profiles[alias], note: 'Profile-directory correspondence will be checked by the first connection.'};
    });
  }
  if (command === 'reconcile') {
    const workspace = await workspaceAt(f.workspace || process.cwd()), session = f.session;
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(session || '')) throw fault('INVALID_SESSION', 'Specify a simple --session name.');
    return reconcile({alias, workspace, session, key: sessionKey(workspace, session), apply: !!f.apply, expect: f.expect});
  }
  let doctorSelection;
  if (command === 'doctor') {
    const configured = (await readConfig()).profiles?.[alias];
    const workspace = await workspaceAt(f.workspace || process.cwd());
    if (f.session && !/^[a-zA-Z0-9_-]{1,60}$/.test(f.session)) throw fault('INVALID_SESSION', 'Invalid session name.');
    const key = f.session ? sessionKey(workspace, f.session) : null;
    doctorSelection = selectTransport({explicit: f.transport, profile: configured, command,
      legacy: key ? await readSession(key) : null, nativeRecord: key && configured ? await readRecovery(configured.instanceId, key) : null});
  }
  if (command === 'doctor' && doctorSelection.transport === 'native') {
    const health = await diagnose(alias);
    if (!f.session) return {...health, ...doctorSelection, bridgeHealthy: health.healthy, healthy: health.healthy && !!health.connection?.capabilities?.nativeTransport, nativeRecoverySupported: health.connection?.capabilities?.nativeSessionSchema === 4};
    const workspace = await workspaceAt(f.workspace || process.cwd()), session = f.session;
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(session)) throw fault('INVALID_SESSION', 'Invalid session name.');
    const recovery = await reconcile({alias, workspace, session, key: sessionKey(workspace, session)});
    const {daemonIdentity} = await import('./daemon-identity.mjs');
    let daemon;
    try { const live = await daemonIdentity(workspace,session); daemon = {present: !!live, socketExists: live?.socketExists || false, matchesRecordedTask: !!live && live.fingerprint === recovery.record?.daemonFingerprint && live.socketFingerprint === recovery.record?.daemonSocketFingerprint}; }
    catch(e) { daemon = {present: null, error: safeError(e)}; }
    return {...health, ...doctorSelection, bridgeHealthy: health.healthy, healthy: health.healthy && !!health.connection?.capabilities?.nativeTransport && recovery.healthy && daemon.present === true && daemon.socketExists && daemon.matchesRecordedTask, recovery, daemon};
  }
  const profile = await paired(alias);
  const payload = {instanceId: profile.instanceId, epoch: profile.epoch};
  const call = (op, p = {}) => request(profile.instanceId, op, {...payload, ...p}, op.startsWith('native-') ? 35000 : 12000);
  const workspace = await workspaceAt(f.workspace || process.cwd());
  const options = {workspace, chromeProfileDir: profile.chromeProfileDir};
  if (command === 'doctor') {
    if (f.transport === 'native' && !profile.capabilities?.nativeTransport)
      throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This bridge/extension has no native debugger transport.');
    return {profile: alias, ...profile, ...doctorSelection, cliVersion: await assertVersion(options), workspace};
  }
  if (command === 'tabs') return {profile: alias, instanceId: profile.instanceId, epoch: profile.epoch, tabs: await call('tabs')};
  if (!['connect', 'release', 'disconnect'].includes(command)) throw fault('INVALID_COMMAND', 'Unknown command. Use qa-browser help.');
  const session = f.session;
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(session || '')) throw fault('INVALID_SESSION', 'Specify a simple --session name.');
  const key = sessionKey(workspace, session);
  const tabId = Number(f.tab);
  if (command !== 'disconnect' && (!Number.isSafeInteger(tabId) || tabId < 0)) throw fault('INVALID_TAB', 'Specify a numeric --tab ID.');
  const legacy = await readSession(key);
  const nativeRecord = await readRecovery(profile.instanceId, key);
  const selection = selectTransport({explicit: f.transport, profile, legacy, nativeRecord, command});
  const selectedTransport = selection.transport;
  if (selectedTransport === 'native' && profile.capabilities?.nativeSessionSchema === 4 && !legacy) {
    return {...selection, ...await nativeWorkflowV4({command, profile, call, alias, workspace, session, key, tabId, options, requestedFocusEmulation: f['focus-emulation'] === undefined ? undefined : f['focus-emulation'] === 'on'})};
  }
  if (selectedTransport !== 'native' && nativeRecord && nativeRecord.status !== 'retired') throw fault('TRANSPORT_MISMATCH', 'Reconcile/disconnect the native lease before changing transport.');
  return await locked(key, async () => {
    const existing = await readSession(key);
    const lockedSelection = selectTransport({explicit: f.transport, profile, legacy: existing, nativeRecord: await readRecovery(profile.instanceId, key), command});
    const transport = lockedSelection.transport;
    if (existing && transport !== (existing.transport || 'official')) throw fault('TRANSPORT_MISMATCH', 'Disconnect before changing this session transport.');
    if (existing && existing.v !== undefined && ![2, 3].includes(existing.v)) throw fault('SESSION_STATE_UNSUPPORTED', 'Unsupported recorded session version. Inspect before repair.');
    if (transport === 'native') {
      if (!profile.capabilities?.nativeTransport) throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'The paired bridge/extension is not native-capable. Continue using official mode until the native build is installed.');
      if (command === 'connect' && profile.capabilities.nativeSessionSchema !== 3)
        throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This native bridge needs the popup-capable protocol update. Disconnect old sessions before upgrading.');
      return {...lockedSelection, ...await nativeWorkflow({command, call, payload, alias, workspace, session, key, tabId, options,
        requestedFocusEmulation: f['focus-emulation'] === undefined ? undefined : f['focus-emulation'] === 'on'})};
    }
    if (f['focus-emulation']) throw fault('INVALID_ARGUMENT', 'Focus emulation is available only in native mode.');
    if (command === 'connect') {
      await assertVersion(options);
      const targets = await call('tabs');
      const target = targets.find(t => t.tabId === tabId);
      if (!target) throw fault('TAB_UNAVAILABLE', 'The tab is not available in the paired Work profile.');
      const old = await readSession(key);
      if (old && (old.instanceId !== profile.instanceId || old.epoch !== profile.epoch))
        throw fault('SESSION_STALE', 'The browser instance changed. Disconnect/reconcile this recorded session before reconnecting.');
      // Playwright uses .playwright to isolate its workspace registry; otherwise projects can share a global namespace.
      await fs.mkdir(path.join(workspace, '.playwright'), {recursive: true});
      let state = old;
      let created = false;
      if (!state) {
        const inventory = await runCLI(session, ['list'], options);
        const collision = (inventory.browsers || []).some(b => b.name === session && b.status === 'open' && b.workspace === workspace);
        if (collision) throw fault('SESSION_COLLISION', 'A CLI session with this name already exists outside this bridge. Choose a new name.');
        await runCLI(session, ['attach', '--extension=chrome'], options);
        created = true;
        try {
          const connectUrl = await connectionURL(session, options);
          const registered = await call('register', {sessionKey: key, connectUrl});
          state = {...payload, sessionKey: key, session, workspace, ...registered};
          await writeSession(key, state);
        } catch (error) { await runCLI(session, ['detach'], options).catch(() => {}); throw error; }
      }
      let claimed;
      try {
        const status = await call('status');
        if (!status.sessions.some(s => s.key === key && s.groupId === state.groupId)) throw fault('SESSION_STALE', 'Browser-side registration was lost. Reconnect after releasing this session.');
        claimed = await call('claim', {sessionKey: key, tabId, expectedUrl: target.url});
        const verified = await selectAndVerify(session, target.url, options);
        await call('verify', {sessionKey: key, tabId, expectedUrl: target.url});
        return {...lockedSelection, connected: true, profile: alias, session, workspace, tabId, groupId: claimed.groupId,
          alreadyConnected: claimed.alreadyConnected, page: verified, nextCommand: ['playwright-cli', `-s=${session}`, 'snapshot']};
      } catch (error) {
        if (claimed && !claimed.alreadyConnected) await call('release', {sessionKey: key, tabId}).catch(() => {});
        if (created) {
          await call('forget', {sessionKey: key}).catch(() => {});
          await runCLI(session, ['detach'], options).catch(() => {});
          await forgetSession(key);
        }
        throw error;
      }
    }
    const state = await readSession(key);
    if (!state) throw fault('SESSION_UNAVAILABLE', 'This workspace/session is not registered with the bridge.');
    if (state.instanceId !== profile.instanceId || state.epoch !== profile.epoch) throw fault('SESSION_STALE', 'Browser instance changed; inspect stale records before attempting release.');
    if (command === 'release') return {...lockedSelection, ...await call('release', {sessionKey: key, tabId})};
    const tabs = await call('tabs');
    for (const tab of tabs.filter(t => t.owner === key)) await call('release', {sessionKey: key, tabId: tab.tabId});
    await call('forget', {sessionKey: key});
    await runCLI(session, ['detach'], options);
    await forgetSession(key);
    return {...lockedSelection, disconnected: true, session, preservedUserTabs: true};
  });
}
try {
  const result = await main();
  if (result !== undefined) console.log(JSON.stringify({ok: true, ...result}, null, 2));
} catch (error) {
  const safe = safeError(error);
  safe.message = redact(safe.message);
  console.error(JSON.stringify({ok: false, error: safe}));
  process.exitCode = 1;
}
