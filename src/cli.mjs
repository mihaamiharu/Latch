#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {discoverDetailed, request, readConfig, updateConfig, uuid} from './local.mjs';
import {diagnose} from './diagnostics.mjs';
import {replacePairing} from './pair-replace.mjs';
import {fault, safeError, webUrl} from '../extension/protocol.js';
import {workspaceAt, sessionKey, cliError} from './playwright.mjs';
import {runSessionCLI, validatePlaywrightArgs} from './playwright-command.mjs';
import {nativeWorkflowV4} from './native-workflow-v4.mjs';
import {readRecovery} from './recovery-state.mjs';
import {reconcile} from './reconcile.mjs';
import {ROOT} from './release.mjs';
import {preflight} from './preflight.mjs';
import {recordEvidence} from './evidence.mjs';
import {renderEvidence} from './evidence-report.mjs';
import {exportEvidence} from './evidence-export.mjs';
import {libraryCommand} from './exploration-library.mjs';
import {runExploration} from './exploration.mjs';
import {executeEvidenceAction} from './evidence-action.mjs';

const releaseVersion = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

const usage = `Latch ${releaseVersion}
  latch discover
  latch pair --profile work --instance <uuid> --chrome-profile-dir <directory> [--replace --expect-old <uuid>]
  latch doctor --profile work
  latch diagnose --profile work
  latch preflight --profile work --session <name> [--workspace <path>]
  latch reconcile --profile work --session <name> [--workspace <path>] [--apply --expect <plan-token>]
  latch tabs --profile work
  latch open --profile work --session <new-name> --url <http(s)-url> [--workspace <path>] [--focus-emulation on|off]
  latch connect --profile work --session <name> --tab <id> [--workspace <path>] [--focus-emulation on|off]
  latch release --profile work --session <name> --tab <id> [--workspace <path>]
  latch disconnect --profile work --session <name> [--workspace <path>]
  latch pw --profile work --session <name> [--workspace <path>] -- <playwright-command> [args...]
  latch finish --profile work --session <name> [--workspace <path>]
  latch checkpoint --profile work --session <name> [--note TEXT] [--workspace <path>]
  latch library <list|show|serve|review|export|repair> [--run ID]
  latch report --evidence-dir <path>
  latch export --evidence-dir <path> --export-dir <new-path> --include <artifact-path,...>
Managed open/connect captures a central run; use --objective TEXT, --environment TEXT,
--video on|foreground|off, then finish. Add --data-ref REF to input commands.
Legacy recording: add --evidence-dir PATH to task commands; pw supports --step ID,
--expect-result JSON or --expect-error CODE, and --inline for requested full output.
Recorded snapshot/screenshot commands supply their own fresh --filename.
All results are JSON. Work-profile extension installation/authorization is a one-time prerequisite.
pw normalizes Playwright isError responses to exit 1; it never attaches or retries.
`;

function parse(argv) {
  const command = argv.shift() || 'help';
  const flags = {};
  if (command === 'library') flags.libraryAction = argv.shift() || 'list';
  let playwrightArgs;
  const allowed = new Set([
    'profile', 'instance', 'chrome-profile-dir', 'session', 'tab', 'url', 'workspace', 'json',
    'focus-emulation', 'apply', 'expect', 'evidence-dir', 'step', 'expect-result', 'expect-error',
    'check-kind', 'context-file', 'inline', 'export-dir', 'include', 'replace', 'expect-old',
    'objective', 'environment', 'data-ref', 'note', 'run', 'decision', 'destination', 'port',
    'annotation-file', 'video',
  ]);
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--' && command === 'pw') {
      playwrightArgs = argv.splice(0);
      break;
    }
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) {
      throw fault('INVALID_ARGUMENT', 'Unknown argument. Use latch help.');
    }
    const key = flag.slice(2);
    if (['json', 'apply', 'inline', 'replace'].includes(key)) {
      if (flags[key]) throw fault('INVALID_ARGUMENT', 'Repeated flag.');
      flags[key] = true;
      continue;
    }
    const value = argv.shift();
    if (!value || value.startsWith('--') || flags[key]) {
      throw fault('INVALID_ARGUMENT', `Missing or repeated --${key}.`);
    }
    flags[key] = value;
  }
  if (command === 'pw') validatePlaywrightArgs(playwrightArgs || []);
  return {command, flags, playwrightArgs};
}

async function paired(name) {
  const config = await readConfig();
  const profile = config.profiles?.[name];
  if (!profile) throw fault('PROFILE_UNPAIRED', 'Pair the Chrome extension instance before using this profile alias.');
  const live = await request(profile.instanceId, 'status');
  return {...profile, ...live};
}

export async function executeCLI({command, flags: f, playwrightArgs}) {
  if (['help', '--help'].includes(command)) {
    console.log(usage);
    return;
  }
  if (['version', '--version'].includes(command)) {
    return {version: releaseVersion, nativeSessionSchema: 4, uiControl: 1, validatedCLI: '0.1.20'};
  }
  if (command === 'open' && (!webUrl(f.url) || f.url.length > 16384 || f.tab !== undefined)) {
    throw fault('INVALID_ARGUMENT', 'Open needs --url with an ordinary HTTP(S) URL and a fresh --session; omit --tab.');
  }
  if (command !== 'open' && f.url !== undefined) {
    throw fault('INVALID_ARGUMENT', 'Use --url only with open.');
  }
  if (command === 'discover') return await discoverDetailed();

  const alias = f.profile || 'work';
  if (f['focus-emulation'] && (!['connect', 'open'].includes(command) || !['on', 'off'].includes(f['focus-emulation']))) {
    throw fault('INVALID_ARGUMENT', 'Use --focus-emulation on|off with connect or open.');
  }
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias)) throw fault('INVALID_PROFILE', 'Use a simple profile alias.');
  if ((f.replace || f['expect-old']) && (command !== 'pair' || !f.replace || !f['expect-old'])) {
    throw fault('INVALID_ARGUMENT', 'Use --replace and --expect-old together, only with pair.');
  }
  if (command === 'diagnose') return await diagnose(alias);
  if (command === 'preflight') {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(f.session || '')) {
      throw fault('INVALID_SESSION', 'Specify a simple --session name for task preflight.');
    }
    return preflight({alias, workspace: await workspaceAt(f.workspace || process.cwd()), session: f.session});
  }
  if (command === 'pair') {
    if (!uuid.test(f.instance || '') || !/^(Default|Profile \d+)$/.test(f['chrome-profile-dir'] || '')) {
      throw fault('INVALID_PAIRING', 'Specify the extension instance UUID and Chrome profile directory (Default or Profile N).');
    }
    if (f.replace) {
      return replacePairing({
        alias,
        instance: f.instance,
        expectOld: f['expect-old'],
        chromeProfileDir: f['chrome-profile-dir'],
      });
    }
    const live = await request(f.instance, 'status');
    return updateConfig(config => {
      if (config.profiles?.[alias] && config.profiles[alias].instanceId !== f.instance) {
        throw fault('PROFILE_ALREADY_PAIRED', 'This alias is already paired to another instance. Review it, then use pair --replace --expect-old <uuid> if the instance really changed.');
      }
      config.profiles ||= {};
      config.profiles[alias] = {
        ...config.profiles[alias],
        instanceId: live.instanceId,
        chromeProfileDir: f['chrome-profile-dir'],
      };
      return {
        paired: true,
        profile: alias,
        ...config.profiles[alias],
        note: 'Profile-directory correspondence will be checked by the first connection.',
      };
    });
  }
  if (command === 'reconcile') {
    const workspace = await workspaceAt(f.workspace || process.cwd());
    const session = f.session;
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(session || '')) throw fault('INVALID_SESSION', 'Specify a simple --session name.');
    return reconcile({alias, workspace, session, key: sessionKey(workspace, session), apply: !!f.apply, expect: f.expect});
  }
  if (command === 'doctor') {
    const workspace = await workspaceAt(f.workspace || process.cwd());
    if (f.session && !/^[a-zA-Z0-9_-]{1,60}$/.test(f.session)) throw fault('INVALID_SESSION', 'Invalid session name.');
    const health = await diagnose(alias);
    if (!f.session) {
      return {
        ...health,
        transport: 'native',
        bridgeHealthy: health.bridgeHealthy ?? false,
        healthy: health.healthy && !!health.connection?.capabilities?.nativeTransport,
        nativeRecoverySupported: health.connection?.ok
          ? health.connection?.capabilities
            ? health.connection.capabilities.nativeSessionSchema === 4
            : null
          : null,
      };
    }
    const session = f.session;
    const recovery = await reconcile({alias, workspace, session, key: sessionKey(workspace, session)});
    const {daemonIdentity} = await import('./daemon-identity.mjs');
    let daemon;
    try {
      const live = await daemonIdentity(workspace, session);
      daemon = {
        present: !!live,
        socketExists: live?.socketExists || false,
        matchesRecordedTask:
          !!live &&
          live.fingerprint === recovery.record?.daemonFingerprint &&
          live.socketFingerprint === recovery.record?.daemonSocketFingerprint,
      };
    } catch (e) {
      daemon = {present: null, error: safeError(e)};
    }
    return {
      ...health,
      transport: 'native',
      bridgeHealthy: health.bridgeHealthy ?? false,
      healthy:
        health.healthy &&
        !!health.connection?.capabilities?.nativeTransport &&
        recovery.healthy &&
        daemon.present === true &&
        daemon.socketExists &&
        daemon.matchesRecordedTask,
      recovery,
      daemon,
    };
  }

  const profile = await paired(alias);
  const payload = {instanceId: profile.instanceId, epoch: profile.epoch};
  const call = (op, p = {}) => request(profile.instanceId, op, {...payload, ...p}, op.startsWith('native-') ? 35000 : 12000);
  const workspace = await workspaceAt(f.workspace || process.cwd());
  const options = {workspace, chromeProfileDir: profile.chromeProfileDir};

  if (command === 'tabs') {
    return {profile: alias, instanceId: profile.instanceId, epoch: profile.epoch, tabs: await call('tabs')};
  }
  if (!['connect', 'open', 'release', 'disconnect', 'pw'].includes(command)) {
    throw fault('INVALID_COMMAND', 'Unknown command. Use latch help.');
  }
  const session = f.session;
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(session || '')) throw fault('INVALID_SESSION', 'Specify a simple --session name.');
  const key = sessionKey(workspace, session);
  const tabId = Number(f.tab);
  if (['connect', 'release'].includes(command) && (!Number.isSafeInteger(tabId) || tabId < 0)) {
    throw fault('INVALID_TAB', 'Specify a numeric --tab ID.');
  }
  if (!profile.capabilities?.nativeTransport || profile.capabilities?.nativeSessionSchema !== 4) {
    throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This bridge/extension requires schema-4 native debugger transport.');
  }
  if (command === 'open' && profile.capabilities?.createTab !== 1) {
    throw fault('OPEN_UNSUPPORTED', 'Open requires the updated native Latch host/extension and a fresh session.');
  }
  const nativeRecord = await readRecovery(profile.instanceId, key);
  if (command === 'pw') {
    return runSessionCLI({args: playwrightArgs, profile, session, workspace, key, nativeRecord, options});
  }
  return {
    transport: 'native',
    extensionVersion: profile.extensionVersion,
    extensionRelease: profile.releaseVersion,
    ...await nativeWorkflowV4({
      command,
      profile,
      call,
      alias,
      workspace,
      session,
      key,
      tabId,
      url: f.url,
      options,
      requestedFocusEmulation: f['focus-emulation'] === undefined ? undefined : f['focus-emulation'] === 'on',
    }),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const invocation = parse(process.argv.slice(2));
    if (invocation.command === 'report' && !invocation.flags['evidence-dir']) {
      throw fault('INVALID_ARGUMENT', 'Report needs --evidence-dir.');
    }
    if (invocation.command === 'report' && Object.keys(invocation.flags).some(k => !['evidence-dir', 'json'].includes(k))) {
      throw fault('INVALID_ARGUMENT', 'Report is offline; use only --evidence-dir.');
    }
    if (
      invocation.command === 'export' &&
      (!invocation.flags['evidence-dir'] ||
        !invocation.flags['export-dir'] ||
        !invocation.flags.include ||
        Object.keys(invocation.flags).some(k => !['evidence-dir', 'export-dir', 'include', 'json'].includes(k)))
    ) {
      throw fault('INVALID_ARGUMENT', 'Export needs --evidence-dir, --export-dir and explicit --include artifact paths.');
    }
    if (!['report', 'export'].includes(invocation.command) && (invocation.flags['export-dir'] || invocation.flags.include)) {
      throw fault('INVALID_ARGUMENT', 'Use export options only with export.');
    }
    const result =
      invocation.command === 'library'
        ? await libraryCommand(invocation.flags.libraryAction, invocation.flags)
        : invocation.command === 'report'
          ? await renderEvidence(invocation.flags['evidence-dir'])
          : invocation.command === 'export'
            ? await exportEvidence({
                directory: invocation.flags['evidence-dir'],
                destination: invocation.flags['export-dir'],
                include: invocation.flags.include.split(','),
              })
            : await runExploration(
                invocation,
                releaseVersion,
                invocation.flags['evidence-dir'] || ['open', 'connect', 'pw', 'disconnect', 'finish', 'checkpoint'].includes(invocation.command)
                  ? executeEvidenceAction
                  : executeCLI,
              );
    if (result !== undefined) console.log(JSON.stringify({ok: true, ...result}, null, 2));
    if (invocation.command === 'report' && result?.integrity === false) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: cliError(error)}));
    process.exitCode = 1;
  }
}
