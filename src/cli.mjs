#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {discoverDetailed, request, readConfig} from './local.mjs';
import {diagnose} from './diagnostics.mjs';
import {installCommand, pairCommand, doctorCommand, uninstallCommand} from './setup.mjs';
import {ACTIONS, fault, webUrl} from '../extension/protocol.js';
import {workspaceAt, sessionKey, cliError} from './redact.mjs';
import {reconcile} from './reconcile.mjs';
import {ROOT} from './release.mjs';
import {preflight} from './preflight.mjs';
import {recordEvidence} from './evidence.mjs';
import {renderEvidence} from './evidence-report.mjs';
import {exportEvidence} from './evidence-export.mjs';
import {libraryCommand} from './exploration-library.mjs';
import {runExploration, CAPTURE_SCRIPT} from './exploration.mjs';
import {executeEvidenceAction} from './evidence-action.mjs';

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const releaseVersion = pkg.version;

const usage = `Latch ${releaseVersion}
  latch install [--root PATH] [--registration-root PATH] [--user-root PATH] [--skip-skills]
  latch pair [--profile work] [--instance <uuid> --chrome-profile-dir <directory>] [--replace --expect-old <uuid>]
  latch doctor [--profile work] [--session <name>] [--workspace <path>] [--fix]
  latch uninstall [--root PATH] [--registration-root PATH] [--user-root PATH] [--skip-skills]
  latch discover
  latch diagnose --profile work
  latch preflight --profile work --session <name> [--workspace <path>]
  latch reconcile --profile work --session <name> [--workspace <path>] [--apply]
  latch tabs --profile work
  latch sessions --profile work
  latch open --profile work --session <new-name> --url <http(s)-url> [--workspace <path>] [--focus-emulation on|off]
  latch connect --profile work --session <name> --tab <id> [--workspace <path>] [--focus-emulation on|off]
  latch release --profile work --session <name> --tab <id> [--workspace <path>]
  latch disconnect --profile work --session <name> [--workspace <path>]
  latch pw --profile work --session <name> [--workspace <path>] -- <action> [args...]
  latch finish --profile work --session <name> [--workspace <path>]
  latch checkpoint --profile work --session <name> [--note TEXT] [--workspace <path>]
  latch library <list|show|serve|review|export|repair> [--run ID]
  latch report --evidence-dir <path>
  latch export --evidence-dir <path> --export-dir <new-path> --include <artifact-path,...>
`;

const PW_ALIASES = new Map([
  ['go-back', 'back'],
  ['go-forward', 'forward'],
  ['dialog-accept', 'dialog'],
  ['dialog-dismiss', 'dialog'],
]);

export function validatePwArgs(args) {
  if (!Array.isArray(args) || !args.length) {
    throw fault('INVALID_ARGUMENT', 'Use pw -- <action> [args...]. Use Latch connect/release/disconnect for session lifecycle.');
  }
  const cmd = args[0];
  const resolved = PW_ALIASES.get(cmd) || cmd;
  if (!ACTIONS.has(resolved)) {
    throw fault('INVALID_ARGUMENT', `Unsupported action "${cmd}". Use Latch connect/release/disconnect for session lifecycle.`);
  }
  for (const arg of args.slice(1)) {
    if (/^-[a-zA-Z]/.test(arg) || /^--(?:no-)?(?:s|session|json|raw|help|version)(?:=|$)/.test(arg)) {
      throw fault('INVALID_ARGUMENT', 'Latch owns the session and JSON format; do not override them.');
    }
  }
}

function mapPwCommand(args) {
  const cmd = args[0];
  const rest = args.slice(1);
  let filename;
  let fullPage = false;
  let depth;
  const positional = [];

  for (const arg of rest) {
    if (arg.startsWith('--filename=')) {
      filename = arg.slice('--filename='.length);
    } else if (arg === '--full-page') {
      fullPage = true;
    } else if (arg.startsWith('--depth=')) {
      depth = Number(arg.slice('--depth='.length));
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  const action = PW_ALIASES.get(cmd) || cmd;
  let actionArgs = {};
  switch (action) {
    case 'snapshot':
      actionArgs = {
        ...(positional[0] ? {selector: positional[0]} : {}),
        ...(Number.isSafeInteger(depth) ? {depth} : {}),
      };
      break;
    case 'screenshot':
      actionArgs = {
        fullPage,
        ...(positional[0] ? {target: positional[0]} : {}),
      };
      break;
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'check':
    case 'uncheck':
      actionArgs = {target: positional[0]};
      break;
    case 'fill':
      actionArgs = {target: positional[0], value: positional[1]};
      break;
    case 'type':
      actionArgs = positional.length >= 2 ? {target: positional[0], text: positional[1]} : {text: positional[0]};
      break;
    case 'press':
      actionArgs = positional.length >= 2 ? {target: positional[0], key: positional[1]} : {key: positional[0]};
      break;
    case 'select':
      actionArgs = {
        target: positional[0],
        values: positional.slice(1).length <= 1 ? positional[1] : positional.slice(1),
      };
      break;
    case 'upload':
      actionArgs = {target: positional[0], files: positional.slice(1)};
      break;
    case 'goto':
      actionArgs = {url: positional[0]};
      break;
    case 'eval':
      actionArgs = {expression: positional[0]};
      break;
    case 'run-code':
      actionArgs = {code: positional[0]};
      break;
    case 'console':
      actionArgs = {level: positional[0]};
      break;
    case 'network':
      actionArgs = {filter: positional[0]};
      break;
    case 'dialog':
      if (cmd === 'dialog-accept') {
        actionArgs = {action: 'accept', promptText: positional[0]};
      } else if (cmd === 'dialog-dismiss') {
        actionArgs = {action: 'dismiss'};
      } else {
        actionArgs = {action: positional[0] || 'accept', promptText: positional[1]};
      }
      break;
    default:
      actionArgs = {};
  }
  return {action, args: actionArgs, filename};
}

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
    'annotation-file', 'video', 'fix', 'root', 'registration-root', 'user-root', 'skip-skills',
    'registry-key', 'skip-registry',
  ]);
  const booleanFlags = new Set(['json', 'apply', 'inline', 'replace', 'fix', 'skip-skills', 'skip-registry']);
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
    if (booleanFlags.has(key)) {
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
  if (command === 'pw') validatePwArgs(playwrightArgs || []);
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
    return {
      version: releaseVersion,
      nativeSessionSchema: 4,
      uiControl: 1,
      playwrightCore: pkg.dependencies?.['playwright-core'] || null,
    };
  }
  if (command === 'open' && (!webUrl(f.url) || f.url.length > 16384 || f.tab !== undefined)) {
    throw fault('INVALID_ARGUMENT', 'Open needs --url with an ordinary HTTP(S) URL and a fresh --session; omit --tab.');
  }
  if (command !== 'open' && f.url !== undefined) {
    throw fault('INVALID_ARGUMENT', 'Use --url only with open.');
  }
  if (command === 'discover') return await discoverDetailed();

  if (command === 'install') {
    return await installCommand({
      root: f.root,
      registrationRoot: f['registration-root'],
      userRoot: f['user-root'],
      skipSkills: !!f['skip-skills'],
      registryKey: f['registry-key'],
      skipRegistry: !!f['skip-registry'],
    });
  }
  if (command === 'uninstall') {
    return await uninstallCommand({
      root: f.root,
      registrationRoot: f['registration-root'],
      userRoot: f['user-root'],
      skipSkills: !!f['skip-skills'],
      registryKey: f['registry-key'],
      skipRegistry: !!f['skip-registry'],
    });
  }

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
    return await pairCommand({
      profile: alias,
      instance: f.instance,
      chromeProfileDir: f['chrome-profile-dir'],
      replace: !!f.replace,
      expectOld: f['expect-old'],
    });
  }
  if (command === 'reconcile') {
    const workspace = await workspaceAt(f.workspace || process.cwd());
    const session = f.session;
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(session || '')) throw fault('INVALID_SESSION', 'Specify a simple --session name.');
    return reconcile({alias, workspace, session, key: sessionKey(workspace, session), apply: !!f.apply});
  }
  if (command === 'doctor') {
    return await doctorCommand({
      profile: alias,
      session: f.session,
      workspace: f.workspace,
      fix: !!f.fix,
      root: f.root,
      registrationRoot: f['registration-root'],
      userRoot: f['user-root'],
      skipSkills: !!f['skip-skills'],
      registryKey: f['registry-key'],
      skipRegistry: !!f['skip-registry'],
    });
  }

  const profile = await paired(alias);
  const payload = {instanceId: profile.instanceId, epoch: profile.epoch, hostGeneration: profile.hostGeneration};
  const call = (op, p = {}, timeout = 45000) =>
    request(profile.instanceId, op, {...payload, ...p}, timeout);
  const workspace = await workspaceAt(f.workspace || process.cwd());

  if (command === 'tabs') {
    return {profile: alias, instanceId: profile.instanceId, epoch: profile.epoch, tabs: await call('tabs', {}, 12000)};
  }
  if (command === 'sessions') {
    return {profile: alias, instanceId: profile.instanceId, epoch: profile.epoch, ...(await call('session-list', {}, 12000))};
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

  if (command === 'pw') {
    if (playwrightArgs[0] === 'run-code' && playwrightArgs[1] === CAPTURE_SCRIPT) {
      const captured = await call('session-capture-state', {sessionKey: key, includeScreenshot: false});
      return {result: captured, transport: 'native', session, workspace};
    }
    const {action, args, filename} = mapPwCommand(playwrightArgs);
    const res = await call('session-action', {sessionKey: key, action, args});
    if (filename) {
      const dest = path.resolve(workspace, filename);
      if (action === 'snapshot') {
        await fs.writeFile(dest, String(res.snapshot || ''));
      } else if (action === 'screenshot' && res.data) {
        await fs.writeFile(dest, Buffer.from(res.data, 'base64'));
      }
    }
    if (action === 'eval' || action === 'run-code') {
      return {result: JSON.stringify(res.value), value: res.value, transport: 'native', session, workspace};
    }
    if (action === 'snapshot') {
      return {result: res.snapshot, ...res, transport: 'native', session, workspace};
    }
    if (action === 'screenshot') {
      return {
        result: filename ? `Screenshot saved to ${filename}` : res,
        ...res,
        transport: 'native',
        session,
        workspace,
      };
    }
    return {result: res, ...res, transport: 'native', session, workspace};
  }

  const focusEmulation = f['focus-emulation'] === undefined ? true : f['focus-emulation'] === 'on';
  if (command === 'open') {
    const res = await call('session-open', {
      sessionKey: key,
      workspace,
      session,
      url: f.url,
      focusEmulation,
    });
    return {
      transport: 'native',
      extensionVersion: profile.extensionVersion,
      extensionRelease: profile.releaseVersion,
      profile: alias,
      ...res,
    };
  }
  if (command === 'connect') {
    const res = await call('session-connect', {
      sessionKey: key,
      workspace,
      session,
      tabId,
      focusEmulation,
    });
    return {
      transport: 'native',
      extensionVersion: profile.extensionVersion,
      extensionRelease: profile.releaseVersion,
      profile: alias,
      ...res,
    };
  }
  if (command === 'release') {
    const res = await call('session-release', {sessionKey: key, tabId});
    return {transport: 'native', ...res};
  }
  const res = await call('session-disconnect', {sessionKey: key, workspace, session});
  return {transport: 'native', session, ...res};
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
