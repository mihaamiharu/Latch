#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ACTIONS, fault, webUrl} from '../extension/protocol.js';
import {diagnose} from './diagnostics.mjs';
import {discoverDetailed, getArtifactsConfig, readConfig, request, setArtifactsDir} from './local.mjs';
import {isMainModule, privateDirectory, sessionsDir} from './platform.mjs';
import {readWorkspaceBinding, removeWorkspaceBinding, writeWorkspaceBinding} from './recovery-state.mjs';
import {cliError, sessionKey, workspaceAt} from './redact.mjs';
import {ROOT} from './release.mjs';
import {doctorCommand, installCommand, pairCommand, uninstallCommand} from './setup.mjs';

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
export const releaseVersion = pkg.version;

export const SNAPSHOT_INLINE_LIMIT = 12 * 1024;
export const SNAPSHOT_PREVIEW_LIMIT = 4 * 1024;

const PROFILE_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;
const SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,60}$/;

export const ACTION_COMMANDS = new Set(ACTIONS);
export const LIFECYCLE_COMMANDS = new Set([
  'tabs',
  'open',
  'connect',
  'sessions',
  'release',
  'disconnect',
  'finish',
]);
export const EXPLORATION_COMMANDS = new Set(['checkpoint', 'library']);
export const SETUP_COMMANDS = new Set(['install', 'pair', 'doctor', 'uninstall', 'agents', 'config']);
export const DIAGNOSTIC_COMMANDS = new Set(['discover', 'diagnose', 'version', 'help']);

const GLOBAL_BOOLEAN_FLAGS = new Set(['json', 'help']);
const GLOBAL_VALUE_FLAGS = new Set(['session', 'profile', 'workspace']);
const COMMAND_FLAGS = {
  open: {
    boolean: new Set(['record']),
    value: new Set(['objective', 'environment', 'focus-emulation', 'url']),
  },
  connect: {
    boolean: new Set(['record']),
    value: new Set(['objective', 'environment', 'focus-emulation', 'tab']),
  },
  snapshot: {
    boolean: new Set([]),
    value: new Set(['depth']),
  },
  screenshot: {
    boolean: new Set(['full-page']),
    value: new Set(['out']),
  },
  checkpoint: {
    boolean: new Set([]),
    value: new Set(['annotation-file', 'data-ref', 'note']),
  },
  library: {
    boolean: new Set(['all']),
    value: new Set(['run', 'decision', 'note', 'destination', 'port']),
  },
  pair: {
    boolean: new Set(['replace']),
    value: new Set(['instance', 'chrome-profile-dir', 'expect-old']),
  },
  install: {
    boolean: new Set(['skip-skills', 'skip-registry']),
    value: new Set(['root', 'registration-root', 'user-root', 'registry-key']),
  },
  uninstall: {
    boolean: new Set(['skip-skills', 'skip-registry']),
    value: new Set(['root', 'registration-root', 'user-root', 'registry-key']),
  },
  doctor: {
    boolean: new Set(['fix', 'skip-skills', 'skip-registry']),
    value: new Set(['root', 'registration-root', 'user-root', 'registry-key']),
  },
  agents: {
    boolean: new Set([]),
    value: new Set(['target']),
  },
};

export const usage = `Latch ${releaseVersion} — browser bridge for AI agents

Lifecycle:
  latch tabs
  latch open <url> [--record] [--objective <text>] [--environment <text>] [--focus-emulation on|off]
  latch connect <tabId> [--record] [--objective <text>] [--environment <text>] [--focus-emulation on|off]
  latch sessions
  latch release [tabId]
  latch disconnect
  latch finish

Actions:
  latch snapshot [selector] [--depth N]
  latch click <ref|selector>
  latch dblclick <ref|selector>
  latch fill <ref|selector> <value>
  latch type [ref|selector] <text>
  latch press [ref|selector] <key>
  latch hover <ref|selector>
  latch select <ref|selector> <value...>
  latch check <ref|selector>
  latch uncheck <ref|selector>
  latch upload <ref|selector> <path...>
  latch screenshot [ref|selector] [--out <path>] [--full-page]
  latch goto <url>
  latch back | forward | reload
  latch eval <expr>
  latch run-code <fn>
  latch console [level]
  latch network [filter]
  latch dialog <accept|dismiss> [promptText]

Exploration:
  latch checkpoint <note> [--annotation-file <path>] [--data-ref <ref>]
  latch library <list|show|serve|review|export|delete> [--run <id>] [--all] [--decision <d>] [--note <text>] [--destination <path>] [--port <n>]

Setup & Agents:
  latch install
  latch pair [--profile <alias>] [--instance <uuid> --chrome-profile-dir <dir>] [--replace --expect-old <uuid>]
  latch doctor [--fix]
  latch config [get [artifacts-dir] | set artifacts-dir <path> | unset artifacts-dir]
  latch uninstall
  latch agents <install|status|uninstall> [--target antigravity,claude,codex,cursor]

Diagnostics:
  latch discover | diagnose | version | help

Global flags:
  --json                 Output full structured JSON ({ ok: true, ... })
  -s, --session <name>   Explicit session name (auto-generated on open/connect, resolved per cwd)
  --profile <alias>      Profile alias (defaults to sole paired profile, or work)
  --workspace <path>     Workspace directory (defaults to current working directory)`;

function isFlagToken(token) {
  if (!token || token === '-' || token === '--') return false;
  if (token.startsWith('--')) return true;
  // Treat negative numbers like -5 as positional values, not short flags.
  return /^-[a-zA-Z]/.test(token);
}

function setFlag(flags, key, value) {
  if (Object.hasOwn(flags, key)) {
    throw fault('INVALID_ARGUMENT', `Repeated flag: --${key}.`);
  }
  flags[key] = value;
}

function parseNonNegativeInt(raw, code, label) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw fault(code, `Invalid ${label}: "${raw}". Expected a non-negative integer.`);
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw fault(code, `Invalid ${label}: "${raw}".`);
  }
  return num;
}

function buildActionSpec(command, args, flags) {
  switch (command) {
    case 'snapshot': {
      if (args.length > 1) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch snapshot [selector] [--depth N]');
      }
      const actionArgs = {};
      if (args[0] !== undefined) actionArgs.selector = args[0];
      if (flags.depth !== undefined) {
        actionArgs.depth = parseNonNegativeInt(String(flags.depth), 'INVALID_ARGUMENT', 'snapshot --depth');
      }
      return {action: 'snapshot', actionArgs};
    }
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'check':
    case 'uncheck':
      if (args.length !== 1 || !args[0]) {
        throw fault('INVALID_ARGUMENT', `Usage: latch ${command} <ref|selector>`);
      }
      return {action: command, actionArgs: {target: args[0]}};
    case 'fill':
      if (args.length !== 2 || !args[0]) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch fill <ref|selector> <value>');
      }
      return {action: 'fill', actionArgs: {target: args[0], value: args[1]}};
    case 'type':
      if (args.length === 1) return {action: 'type', actionArgs: {text: args[0]}};
      if (args.length === 2 && args[0]) return {action: 'type', actionArgs: {target: args[0], text: args[1]}};
      throw fault('INVALID_ARGUMENT', 'Usage: latch type [ref|selector] <text>');
    case 'press':
      if (args.length === 1 && args[0]) return {action: 'press', actionArgs: {key: args[0]}};
      if (args.length === 2 && args[0] && args[1]) return {action: 'press', actionArgs: {target: args[0], key: args[1]}};
      throw fault('INVALID_ARGUMENT', 'Usage: latch press [ref|selector] <key>');
    case 'select':
      if (args.length < 2 || !args[0]) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch select <ref|selector> <value...>');
      }
      return {
        action: 'select',
        actionArgs: {target: args[0], values: args.length === 2 ? args[1] : args.slice(1)},
      };
    case 'upload':
      if (args.length < 2 || !args[0] || args.slice(1).some(f => !f)) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch upload <ref|selector> <path...>');
      }
      return {action: 'upload', actionArgs: {target: args[0], files: args.slice(1)}};
    case 'screenshot':
      if (args.length > 1) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch screenshot [ref|selector] [--out <path>] [--full-page]');
      }
      return {
        action: 'screenshot',
        actionArgs: {
          fullPage: !!flags['full-page'],
          ...(args[0] ? {target: args[0]} : {}),
        },
      };
    case 'goto':
      if (args.length !== 1 || !webUrl(args[0]) || args[0].length > 16384) {
        throw fault('INVALID_ARGUMENT', 'goto requires a single ordinary HTTP(S) URL.');
      }
      return {action: 'goto', actionArgs: {url: args[0]}};
    case 'back':
    case 'forward':
    case 'reload':
      if (args.length !== 0) {
        throw fault('INVALID_ARGUMENT', `Usage: latch ${command}`);
      }
      return {action: command, actionArgs: {}};
    case 'eval':
      if (args.length !== 1 || !args[0].trim()) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch eval <expr>');
      }
      return {action: 'eval', actionArgs: {expression: args[0]}};
    case 'run-code':
      if (args.length !== 1 || !args[0].trim()) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch run-code <fn>');
      }
      return {action: 'run-code', actionArgs: {code: args[0]}};
    case 'console':
      if (args.length > 1) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch console [level]');
      }
      return {action: 'console', actionArgs: args[0] ? {level: args[0]} : {}};
    case 'network':
      if (args.length > 1) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch network [filter]');
      }
      return {action: 'network', actionArgs: args[0] ? {filter: args[0]} : {}};
    case 'dialog':
      if (args.length < 1 || args.length > 2 || !['accept', 'dismiss'].includes(args[0])) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch dialog <accept|dismiss> [promptText]');
      }
      return {
        action: 'dialog',
        actionArgs: {
          action: args[0],
          ...(args[1] !== undefined ? {promptText: args[1]} : {}),
        },
      };
    default:
      return {action: null, actionArgs: null};
  }
}

/** Parse flat latch CLI arguments into a normalized invocation object. */
export function parseArgs(argv = []) {
  const tokens = [...argv];
  const flags = {};
  const args = [];
  let command = null;
  let afterDoubleDash = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (afterDoubleDash) {
      args.push(token);
      continue;
    }
    if (token === '--') {
      if (!command) {
        throw fault('INVALID_ARGUMENT', 'Specify a command before "--". Use latch help.');
      }
      afterDoubleDash = true;
      continue;
    }

    if (!command && !isFlagToken(token)) {
      command = token;
      continue;
    }

    if (isFlagToken(token)) {
      // Handle short flags: -s, -h, -v, -V, and -s=name / -sname
      if (!token.startsWith('--')) {
        if (token === '-h') {
          setFlag(flags, 'help', true);
          continue;
        }
        if (token === '-v' || token === '-V') {
          if (!command) {
            command = 'version';
            continue;
          }
          throw fault('INVALID_ARGUMENT', `Unknown flag ${token}. Use latch help.`);
        }
        if (token === '-s') {
          const val = tokens[++i];
          if (val === undefined || isFlagToken(val)) {
            throw fault('INVALID_ARGUMENT', 'Missing value for -s / --session.');
          }
          setFlag(flags, 'session', val);
          continue;
        }
        if (token.startsWith('-s=')) {
          const val = token.slice(3);
          if (!val) throw fault('INVALID_ARGUMENT', 'Missing value for -s / --session.');
          setFlag(flags, 'session', val);
          continue;
        }
        if (token.startsWith('-s') && token.length > 2) {
          setFlag(flags, 'session', token.slice(2));
          continue;
        }
        throw fault('INVALID_ARGUMENT', `Unknown short flag "${token}". Use latch help.`);
      }

      const eqIndex = token.indexOf('=');
      const key = eqIndex === -1 ? token.slice(2) : token.slice(2, eqIndex);
      const inlineVal = eqIndex === -1 ? undefined : token.slice(eqIndex + 1);

      if (key === 'version' && !command) {
        if (inlineVal !== undefined) throw fault('INVALID_ARGUMENT', '--version takes no value.');
        command = 'version';
        continue;
      }
      if (key === 'help') {
        if (inlineVal !== undefined) throw fault('INVALID_ARGUMENT', '--help takes no value.');
        setFlag(flags, 'help', true);
        continue;
      }

      const cmdSpec = command ? COMMAND_FLAGS[command] : null;
      const isAction = command ? ACTION_COMMANDS.has(command) : false;
      const isGlobalBool = GLOBAL_BOOLEAN_FLAGS.has(key);
      const isGlobalVal = GLOBAL_VALUE_FLAGS.has(key);
      const isCmdBool = cmdSpec?.boolean.has(key) || false;
      const isCmdVal = cmdSpec?.value.has(key) || (isAction && key === 'data-ref');

      if (!isGlobalBool && !isGlobalVal && !isCmdBool && !isCmdVal) {
        throw fault(
          'INVALID_ARGUMENT',
          command ? `Unknown or unsupported flag --${key} for "${command}".` : `Unknown flag --${key} before command.`,
          'Run latch help to see supported commands and flags.',
        );
      }

      if (isGlobalBool || isCmdBool) {
        if (inlineVal !== undefined) {
          throw fault('INVALID_ARGUMENT', `Flag --${key} does not accept a value.`);
        }
        setFlag(flags, key, true);
        continue;
      }

      const value = inlineVal !== undefined ? inlineVal : tokens[++i];
      if (value === undefined || (inlineVal === undefined && isFlagToken(value))) {
        throw fault('INVALID_ARGUMENT', `Missing value for --${key}.`);
      }
      setFlag(flags, key, value);
      continue;
    }

    args.push(token);
  }

  if (flags.help || !command || command === 'help' || command === '--help') {
    return {command: 'help', flags: flags.json ? {json: true} : {}, args: [], action: null, actionArgs: null};
  }
  if (command === 'version' || command === '--version') {
    if (args.length > 0) throw fault('INVALID_ARGUMENT', 'Usage: latch version [--json]');
    return {command: 'version', flags, args: [], action: null, actionArgs: null};
  }

  const allKnown =
    LIFECYCLE_COMMANDS.has(command) ||
    ACTION_COMMANDS.has(command) ||
    EXPLORATION_COMMANDS.has(command) ||
    SETUP_COMMANDS.has(command) ||
    DIAGNOSTIC_COMMANDS.has(command);
  if (!allKnown) {
    throw fault('INVALID_COMMAND', `Unknown command "${command}".`, 'Run latch help to see supported commands.');
  }

  if (flags.session !== undefined && !SESSION_PATTERN.test(flags.session)) {
    throw fault('INVALID_SESSION', 'Specify a simple session name (1-60 chars: letters, numbers, _, -).');
  }
  if (flags.profile !== undefined && !PROFILE_PATTERN.test(flags.profile)) {
    throw fault('INVALID_PROFILE', 'Specify a simple profile alias (1-40 chars: letters, numbers, _, -).');
  }

  if (flags['focus-emulation'] !== undefined && !['on', 'off'].includes(flags['focus-emulation'])) {
    throw fault('INVALID_ARGUMENT', 'Use --focus-emulation on|off.');
  }
  if ((flags.replace || flags['expect-old']) && (command !== 'pair' || !flags.replace || !flags['expect-old'])) {
    throw fault('INVALID_ARGUMENT', 'Use --replace and --expect-old together, only with pair.');
  }

  if (ACTION_COMMANDS.has(command)) {
    const {action, actionArgs} = buildActionSpec(command, args, flags);
    return {command, flags, args, action, actionArgs};
  }

  switch (command) {
    case 'tabs':
    case 'sessions':
    case 'disconnect':
    case 'finish':
    case 'discover':
    case 'diagnose':
    case 'install':
    case 'uninstall':
    case 'pair':
    case 'doctor':
      if (args.length > 0) {
        throw fault('INVALID_ARGUMENT', `Command "${command}" does not take positional arguments.`);
      }
      break;
    case 'open': {
      const url = args[0] ?? flags.url;
      if (args.length > 1 || !webUrl(url) || url.length > 16384) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch open <http(s)-url> [--record] [--objective <text>]');
      }
      flags.url = url;
      break;
    }
    case 'connect': {
      if (args.length > 1) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch connect <tabId> [--record] [--objective <text>]');
      }
      const rawTab = args[0] ?? flags.tab;
      const tabId = parseNonNegativeInt(String(rawTab ?? ''), 'INVALID_TAB', 'tabId');
      flags.tab = tabId;
      break;
    }
    case 'release': {
      if (args.length > 1) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch release [tabId]');
      }
      if (args[0] !== undefined) {
        flags.tab = parseNonNegativeInt(args[0], 'INVALID_TAB', 'tabId');
      }
      break;
    }
    case 'checkpoint': {
      if (args.length > 1) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch checkpoint <note> [--annotation-file <path>] [--data-ref <ref>]');
      }
      if (args[0] !== undefined && flags.note !== undefined) {
        throw fault('INVALID_ARGUMENT', 'Provide checkpoint note positionally or with --note, not both.');
      }
      const note = flags.note ?? args[0];
      if (!note && !flags['annotation-file']) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch checkpoint <note> [--annotation-file <path>] [--data-ref <ref>]');
      }
      if (note !== undefined) flags.note = note;
      break;
    }
    case 'library': {
      const sub = args[0] || 'list';
      if (!['list', 'show', 'serve', 'review', 'export', 'delete', 'repair'].includes(sub)) {
        throw fault('INVALID_COMMAND', 'Use library list, show, serve, review, export, delete, or repair.');
      }
      if (['list', 'serve'].includes(sub)) {
        if (args.length > 1) {
          throw fault('INVALID_ARGUMENT', `Usage: latch library ${sub}${sub === 'serve' ? ' [--port <n>]' : ''}`);
        }
      } else {
        if (args.length > 2) {
          throw fault('INVALID_ARGUMENT', 'Usage: latch library <list|show|serve|review|export|delete> [runId] [flags]');
        }
        if (args[1] !== undefined) {
          if (flags.run !== undefined) {
            throw fault('INVALID_ARGUMENT', 'Provide run ID positionally or with --run, not both.');
          }
          flags.run = args[1];
        }
      }
      if (flags.all && sub !== 'delete') {
        throw fault('INVALID_ARGUMENT', 'Use --all only with library delete.');
      }
      if (flags.all && flags.run !== undefined) {
        throw fault('INVALID_ARGUMENT', 'Specify either --run <id> or --all, not both.');
      }
      flags.libraryAction = sub;
      break;
    }
    case 'agents': {
      if (args.length !== 1 || !['install', 'status', 'uninstall'].includes(args[0])) {
        throw fault(
          'INVALID_ARGUMENT',
          'Usage: latch agents <install|status|uninstall> [--target antigravity,claude,codex,cursor]',
        );
      }
      flags.agentsAction = args[0];
      break;
    }
    case 'config': {
      const action = args[0] || 'get';
      if (!['get', 'set', 'unset', 'reset'].includes(action)) {
        throw fault('INVALID_ARGUMENT', 'Usage: latch config <get|set|unset> artifacts-dir [path]');
      }
      const key = args[1];
      if (action === 'get') {
        if (args.length > 2 || (key !== undefined && !['artifacts-dir', 'artifactsDir'].includes(key))) {
          throw fault('INVALID_ARGUMENT', 'Usage: latch config get [artifacts-dir]');
        }
        flags.configAction = 'get';
        flags.configKey = 'artifactsDir';
        break;
      }
      if (!['artifacts-dir', 'artifactsDir'].includes(key)) {
        throw fault('INVALID_ARGUMENT', `Usage: latch config ${action} artifacts-dir${action === 'set' ? ' <path>' : ''}`);
      }
      if (action === 'set') {
        if (args.length !== 3 || !args[2].trim()) {
          throw fault('INVALID_ARGUMENT', 'Usage: latch config set artifacts-dir <path>');
        }
        flags.configAction = 'set';
        flags.configKey = 'artifactsDir';
        flags.configValue = args[2];
        break;
      }
      if (args.length !== 2) {
        throw fault('INVALID_ARGUMENT', `Usage: latch config ${action} artifacts-dir`);
      }
      flags.configAction = 'unset';
      flags.configKey = 'artifactsDir';
      break;
    }
  }

  return {command, flags, args, action: null, actionArgs: null};
}

/**
 * Resolve profile alias:
 * - Explicit --profile wins (validated).
 * - Sole paired profile wins if only 1 profile is configured.
 * - 'work' if 0 profiles or if 'work' is among multiple profiles.
 * - Helpful PROFILE_AMBIGUOUS error if multiple profiles exist without 'work'.
 */
export async function resolveProfile(explicitProfile, {readCfg = readConfig} = {}) {
  if (explicitProfile !== undefined) {
    if (!PROFILE_PATTERN.test(explicitProfile)) {
      throw fault('INVALID_PROFILE', 'Use a simple profile alias.');
    }
    return explicitProfile;
  }
  const config = await readCfg();
  const names = Object.keys(config?.profiles || {});
  if (names.length === 1) return names[0];
  if (names.length === 0 || names.includes('work')) return 'work';
  throw fault(
    'PROFILE_AMBIGUOUS',
    `Multiple paired profiles found (${names.join(', ')}) and none is named "work".`,
    `Pass --profile <alias> (one of: ${names.join(', ')}).`,
  );
}

/** Generate a short readable session ID for open/connect when -s is omitted. */
export function generateSessionId() {
  return `s-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Resolve session name:
 * - Explicit -s/--session wins.
 * - On open/connect: auto-generates a short readable session ID.
 * - On action/checkpoint/finish/disconnect/release: resolves active session for workspace.
 */
export async function resolveSession(
  command,
  explicitSession,
  workspace,
  {readBinding = readWorkspaceBinding, generateId = generateSessionId} = {},
) {
  if (explicitSession !== undefined) {
    if (!SESSION_PATTERN.test(explicitSession)) {
      throw fault('INVALID_SESSION', 'Specify a simple session name.');
    }
    return explicitSession;
  }
  if (command === 'open' || command === 'connect') {
    return generateId();
  }
  const binding = await readBinding(workspace);
  const active = binding?.activeSession;
  if (active && binding?.sessions?.[active]) {
    return active;
  }
  throw fault(
    'SESSION_UNAVAILABLE',
    'No active session is bound to this workspace.',
    'Run `latch open <url>` or `latch connect <tabId>` first, or pass `-s <session>`.',
  );
}

async function paired(name, {readCfg = readConfig, rpc = request} = {}) {
  const config = await readCfg();
  const profile = config.profiles?.[name];
  if (!profile) {
    throw fault(
      'PROFILE_UNPAIRED',
      `Profile "${name}" is not paired.`,
      'Load the Latch extension in Chrome and run `latch pair`.',
    );
  }
  const live = await rpc(profile.instanceId, 'status');
  return {...profile, ...live};
}

function boundedPreview(text, maxBytes = SNAPSHOT_PREVIEW_LIMIT) {
  const lines = text.split('\n');
  const kept = [];
  let bytes = 0;
  for (const line of lines) {
    const next = (kept.length ? 1 : 0) + Buffer.byteLength(line, 'utf8');
    if (bytes + next > maxBytes && kept.length > 0) break;
    if (bytes + next > maxBytes) {
      kept.push(Buffer.from(line, 'utf8').subarray(0, maxBytes).toString('utf8'));
      break;
    }
    kept.push(line);
    bytes += next;
  }
  return kept.join('\n');
}

async function saveLargeSnapshot(snapshot, session) {
  const dir = path.join(sessionsDir(), 'snapshots');
  await privateDirectory(path.dirname(dir));
  await privateDirectory(dir);
  const safe = String(session || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(dir, `snapshot-${safe}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.yaml`);
  await fs.writeFile(file, snapshot, process.platform === 'win32' ? {flag: 'wx'} : {flag: 'wx', mode: 0o600});
  return file;
}

async function saveScreenshotFile(base64Data, {out, workspace, session}) {
  const buf = Buffer.from(base64Data, 'base64');
  let dest;
  if (out) {
    dest = path.resolve(workspace, out);
    await fs.mkdir(path.dirname(dest), {recursive: true});
    await fs.writeFile(dest, buf);
  } else {
    const dir = path.join(sessionsDir(), 'screenshots');
    await privateDirectory(path.dirname(dir));
    await privateDirectory(dir);
    const safe = String(session || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
    dest = path.join(dir, `screenshot-${safe}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`);
    await fs.writeFile(dest, buf, process.platform === 'win32' ? {flag: 'wx'} : {flag: 'wx', mode: 0o600});
  }
  return {dest, bytes: buf.length};
}

async function defaultLoadExploration() {
  const mod = await import('./exploration.mjs');
  if (typeof mod.runWithExploration === 'function') return mod;
  const libMod = await import('./exploration-library.mjs');
  return {
    runWithExploration: async (invocation, _version, execute) => execute(invocation),
    checkpointCommand: async () => {
      throw fault('UNSUPPORTED', 'checkpoint requires Phase 5 exploration module.');
    },
    finishCommand: async (opts, _version, execute) =>
      execute({command: 'disconnect', flags: {profile: opts.profile, session: opts.session, workspace: opts.workspace}}),
    libraryCommand: mod.libraryCommand || libMod.libraryCommand,
  };
}

async function defaultLoadAgents() {
  return await import('./agents.mjs');
}

function makeDeps(overrides = {}) {
  return {
    readConfig,
    getArtifactsConfig,
    setArtifactsDir,
    request,
    discoverDetailed,
    diagnose,
    installCommand,
    pairCommand,
    doctorCommand,
    uninstallCommand,
    readWorkspaceBinding,
    writeWorkspaceBinding,
    removeWorkspaceBinding,
    workspaceAt,
    loadExploration: defaultLoadExploration,
    loadAgents: defaultLoadAgents,
    saveLargeSnapshot,
    saveScreenshotFile,
    ...overrides,
  };
}

/** Execute a parsed CLI invocation (or direct programmatic invocation like executeCLI({command, flags})). */
export async function executeCLI(invocation, depOverrides = {}) {
  const deps = makeDeps(depOverrides);
  const command = invocation.command;
  const f = invocation.flags || {};
  const args = invocation.args || [];

  if (['help', '--help'].includes(command)) {
    return {usage};
  }
  if (['version', '--version'].includes(command)) {
    return {
      version: releaseVersion,
      nativeSessionSchema: 4,
      uiControl: 1,
      playwrightCore: pkg.dependencies?.['playwright-core'] || null,
    };
  }

  // Validate open/connect URL & tab invariants before contacting Chrome.
  const openUrl = command === 'open' ? (args[0] ?? f.url) : undefined;
  if (command === 'open' && (!webUrl(openUrl) || openUrl.length > 16384 || f.tab !== undefined)) {
    throw fault('INVALID_ARGUMENT', 'Open needs an ordinary HTTP(S) URL; omit --tab.');
  }
  if (command !== 'open' && f.url !== undefined) {
    throw fault('INVALID_ARGUMENT', 'Use URL only with open.');
  }
  if (f['focus-emulation'] !== undefined && (!['connect', 'open'].includes(command) || !['on', 'off'].includes(f['focus-emulation']))) {
    throw fault('INVALID_ARGUMENT', 'Use --focus-emulation on|off with connect or open.');
  }
  if ((f.replace || f['expect-old']) && (command !== 'pair' || !f.replace || !f['expect-old'])) {
    throw fault('INVALID_ARGUMENT', 'Use --replace and --expect-old together, only with pair.');
  }

  if (command === 'discover') {
    return await deps.discoverDetailed();
  }
  if (command === 'install') {
    return await deps.installCommand({
      root: f.root,
      registrationRoot: f['registration-root'],
      userRoot: f['user-root'],
      skipSkills: !!f['skip-skills'],
      registryKey: f['registry-key'],
      skipRegistry: !!f['skip-registry'],
    });
  }
  if (command === 'uninstall') {
    return await deps.uninstallCommand({
      root: f.root,
      registrationRoot: f['registration-root'],
      userRoot: f['user-root'],
      skipSkills: !!f['skip-skills'],
      registryKey: f['registry-key'],
      skipRegistry: !!f['skip-registry'],
    });
  }
  if (command === 'agents') {
    const action = f.agentsAction ?? args[0];
    if (!['install', 'status', 'uninstall'].includes(action)) {
      throw fault('INVALID_ARGUMENT', 'Usage: latch agents <install|status|uninstall> [--target antigravity,claude,codex,cursor]');
    }
    const {agentsCommand} = await deps.loadAgents();
    return await agentsCommand(action, {target: f.target});
  }
  if (command === 'config') {
    const action = f.configAction || 'get';
    if (action === 'get') return deps.getArtifactsConfig();
    if (action === 'unset') return await deps.setArtifactsDir(null);
    return await deps.setArtifactsDir(path.resolve(process.cwd(), f.configValue));
  }
  if (command === 'library') {
    const libraryAction = f.libraryAction ?? args[0] ?? 'list';
    const exp = await deps.loadExploration();
    return await exp.libraryCommand(libraryAction, f);
  }
  if (command === 'pair') {
    const alias = f.profile || 'work';
    if (!PROFILE_PATTERN.test(alias)) throw fault('INVALID_PROFILE', 'Use a simple profile alias.');
    return await deps.pairCommand({
      profile: alias,
      instance: f.instance,
      chromeProfileDir: f['chrome-profile-dir'],
      replace: !!f.replace,
      expectOld: f['expect-old'],
    });
  }

  const alias = await resolveProfile(f.profile, {readCfg: deps.readConfig});

  if (command === 'diagnose') {
    return await deps.diagnose(alias);
  }
  if (command === 'doctor') {
    return await deps.doctorCommand({
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

  const profile = await paired(alias, {readCfg: deps.readConfig, rpc: deps.request});
  const payload = {instanceId: profile.instanceId, epoch: profile.epoch, hostGeneration: profile.hostGeneration};
  const call = (op, p = {}, timeout = 45000) =>
    deps.request(profile.instanceId, op, {...payload, ...p}, timeout);
  const workspace = await deps.workspaceAt(f.workspace || process.cwd());

  if (command === 'tabs') {
    return {profile: alias, instanceId: profile.instanceId, epoch: profile.epoch, tabs: await call('tabs', {}, 12000)};
  }
  if (command === 'sessions') {
    return {profile: alias, instanceId: profile.instanceId, epoch: profile.epoch, ...(await call('session-list', {}, 12000))};
  }

  if (
    !LIFECYCLE_COMMANDS.has(command) &&
    !ACTION_COMMANDS.has(command) &&
    !['session-capture-state', 'capture-state'].includes(command)
  ) {
    throw fault('INVALID_COMMAND', `Unknown command "${command}". Use latch help.`);
  }

  const session = await resolveSession(command, f.session, workspace, {
    readBinding: deps.readWorkspaceBinding,
  });
  const key = sessionKey(workspace, session);

  if (!profile.capabilities?.nativeTransport || profile.capabilities?.nativeSessionSchema !== 4) {
    throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This bridge/extension requires schema-4 native debugger transport.');
  }

  if (command === 'session-capture-state' || command === 'capture-state') {
    const includeScreenshot = f.includeScreenshot !== false && f.captureScreenshot !== false;
    return await call('session-capture-state', {sessionKey: key, includeScreenshot});
  }

  if (ACTION_COMMANDS.has(command)) {
    const action = invocation.action || command;
    const actionArgs = invocation.actionArgs || buildActionSpec(command, args, f).actionArgs;
    const res = await call('session-action', {sessionKey: key, action, args: actionArgs});

    if (action === 'snapshot' && typeof res?.snapshot === 'string') {
      const bytes = Buffer.byteLength(res.snapshot, 'utf8');
      if (bytes > SNAPSHOT_INLINE_LIMIT) {
        const snapshotFile = await deps.saveLargeSnapshot(res.snapshot, session);
        const preview = boundedPreview(res.snapshot, SNAPSHOT_PREVIEW_LIMIT);
        return {
          ...res,
          snapshotFile,
          bytes,
          truncated: true,
          preview,
          snapshot: preview,
          session,
          workspace,
        };
      }
      return {...res, bytes, session, workspace};
    }

    if (action === 'screenshot' && res?.data) {
      const {dest, bytes} = await deps.saveScreenshotFile(res.data, {out: f.out, workspace, session});
      const {data: _omitted, ...rest} = res;
      return {
        ...rest,
        saved: true,
        path: dest,
        bytes,
        session,
        workspace,
      };
    }

    return {...res, session, workspace};
  }

  const focusEmulation = f['focus-emulation'] === undefined ? true : f['focus-emulation'] === 'on';

  if (command === 'open') {
    if (profile.capabilities?.createTab !== 1) {
      throw fault('OPEN_UNSUPPORTED', 'Open requires the updated native Latch host/extension.');
    }
    const res = await call('session-open', {
      sessionKey: key,
      workspace,
      session,
      url: openUrl,
      focusEmulation,
    });
    await deps.writeWorkspaceBinding(workspace, {
      sessionKey: key,
      session,
      workspace,
      instanceId: profile.instanceId,
      tabId: res.tabId ?? null,
      focusEmulation,
      status: 'attached',
    });
    return {
      transport: 'native',
      extensionVersion: profile.extensionVersion,
      extensionRelease: profile.releaseVersion,
      profile: alias,
      session,
      workspace,
      ...res,
    };
  }

  if (command === 'connect') {
    const rawTab = args[0] ?? f.tab;
    const tabId = Number(rawTab);
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      throw fault('INVALID_TAB', 'Specify a numeric tabId.');
    }
    const res = await call('session-connect', {
      sessionKey: key,
      workspace,
      session,
      tabId,
      focusEmulation,
    });
    await deps.writeWorkspaceBinding(workspace, {
      sessionKey: key,
      session,
      workspace,
      instanceId: profile.instanceId,
      tabId: res.tabId ?? tabId,
      focusEmulation,
      status: 'attached',
    });
    return {
      transport: 'native',
      extensionVersion: profile.extensionVersion,
      extensionRelease: profile.releaseVersion,
      profile: alias,
      session,
      workspace,
      ...res,
    };
  }

  if (command === 'release') {
    let tabId = args[0] !== undefined ? Number(args[0]) : f.tab !== undefined ? Number(f.tab) : undefined;
    if (tabId === undefined) {
      const binding = await deps.readWorkspaceBinding(workspace).catch(() => null);
      tabId = binding?.sessions?.[session]?.tabId;
      if (!Number.isSafeInteger(tabId)) {
        const list = await call('session-list', {}, 12000).catch(() => null);
        const found = list?.sessions?.find(s => s.sessionKey === key || s.session === session);
        tabId = found?.tabId ?? found?.rootTabId;
      }
    }
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      throw fault('INVALID_TAB', 'No active tabId found for this session; specify a numeric tabId.');
    }
    const res = await call('session-release', {sessionKey: key, tabId});
    if (res?.sessionClosed) {
      await deps.removeWorkspaceBinding(workspace, session).catch(() => {});
    }
    return {transport: 'native', session, tabId, ...res};
  }

  if (command === 'disconnect') {
    const res = await call('session-disconnect', {sessionKey: key, workspace, session});
    await deps.removeWorkspaceBinding(workspace, session).catch(() => {});
    return {transport: 'native', session, workspace, ...res};
  }

  throw fault('INVALID_COMMAND', `Command "${command}" must run via runCLI.`);
}

/** Run CLI end-to-end: parse argv, resolve smart defaults, route exploration/agents, and return result. */
export async function runCLI(argv, depOverrides = {}) {
  const deps = makeDeps(depOverrides);
  const invocation = parseArgs(argv);
  const {command, flags, args} = invocation;

  if (command === 'help') {
    return {invocation, result: {usage}};
  }
  if (['version', 'discover', 'install', 'uninstall', 'agents', 'library', 'pair', 'config'].includes(command)) {
    return {invocation, result: await executeCLI(invocation, deps)};
  }

  const profile = await resolveProfile(flags.profile, {readCfg: deps.readConfig});
  flags.profile = profile;

  if (['diagnose', 'doctor', 'tabs', 'sessions'].includes(command)) {
    return {invocation, result: await executeCLI(invocation, deps)};
  }

  const workspace = await deps.workspaceAt(flags.workspace || process.cwd());
  flags.workspace = workspace;
  const session = await resolveSession(command, flags.session, workspace, {
    readBinding: deps.readWorkspaceBinding,
  });
  flags.session = session;

  const exec = inv => executeCLI(inv, deps);

  if (command === 'release') {
    return {invocation, result: await exec(invocation)};
  }

  const exp = await deps.loadExploration();
  if (command === 'checkpoint') {
    const result = await exp.checkpointCommand(
      {
        profile,
        session,
        workspace,
        note: flags.note,
        annotationFile: flags['annotation-file'],
        dataRef: flags['data-ref'],
      },
      releaseVersion,
      exec,
    );
    return {invocation, result};
  }
  if (command === 'finish') {
    const result = await exp.finishCommand({profile, session, workspace}, releaseVersion, exec);
    await deps.removeWorkspaceBinding(workspace, session).catch(() => {});
    return {invocation, result};
  }

  const result = await exp.runWithExploration(invocation, releaseVersion, exec);
  if (command === 'disconnect') {
    await deps.removeWorkspaceBinding(workspace, session).catch(() => {});
  }
  return {invocation, result};
}

function formatScalarValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** Format successful CLI output cleanly for either default LLM/human mode or --json mode. */
export function formatResult(command, result, {json = false, action = null} = {}) {
  if (result === undefined) return undefined;
  if (json) {
    return JSON.stringify({ok: true, ...result}, null, 2);
  }
  if (command === 'help') {
    return result.usage ?? usage;
  }
  if (command === 'version') {
    return `latch ${result.version} (schema ${result.nativeSessionSchema}, playwright-core ${result.playwrightCore || 'bundled'})`;
  }
  if (command === 'tabs') {
    const tabs = result.tabs || [];
    if (!tabs.length) return `No open tabs [profile: ${result.profile}].`;
    const lines = [`Tabs (${tabs.length}) [profile: ${result.profile}]:`];
    for (const t of tabs) {
      lines.push(`  [${t.tabId}] ${t.title || '(untitled)'} — ${t.url}${t.active ? ' (active)' : ''}${t.owner ? ' [owned]' : ''}`);
    }
    return lines.join('\n');
  }
  if (command === 'sessions') {
    const sessions = result.sessions || [];
    if (!sessions.length) return `No active sessions [profile: ${result.profile}].`;
    const lines = [`Sessions (${sessions.length}) [profile: ${result.profile}]:`];
    for (const s of sessions) {
      lines.push(`  ${s.session || s.sessionKey?.slice(0, 12)} | tab ${s.tabId} | ${s.stopped ? 'stopped' : 'active'} | ${s.page?.url || ''}`);
    }
    return lines.join('\n');
  }
  if (command === 'open' || command === 'connect') {
    const lines = [
      `Session "${result.session}" connected (tab ${result.tabId}, profile ${result.profile}, focus-emulation ${result.focusEmulation === false ? 'off' : 'on'})`,
      `URL: ${result.page?.url || result.url || 'about:blank'}${result.page?.title ? ` — ${result.page.title}` : ''}`,
    ];
    if (result.library?.runId) lines.push(`Recording run: ${result.library.runId}`);
    return lines.join('\n');
  }
  if (command === 'release') {
    return `Released tab ${result.tabId}${result.sessionClosed ? ' (session closed)' : ''}.`;
  }
  if (command === 'disconnect') {
    return `Disconnected session "${result.session}" (user tabs preserved).`;
  }
  if (command === 'finish') {
    if (result.library) {
      const lines = [`Finished exploration ${result.library.runId} (${result.library.status || 'finished'})`];
      if (result.library.handoff) lines.push(`Handoff: ${result.library.handoff}`);
      else if (result.library.directory) lines.push(`Directory: ${result.library.directory}`);
      return lines.join('\n');
    }
    return `Finished session "${result.session || ''}".`;
  }
  if (command === 'checkpoint') {
    return `Checkpoint recorded${result.library?.runId ? ` (run ${result.library.runId})` : ''}.`;
  }
  if (command === 'snapshot') {
    const header = `Snapshot: ${result.title || '(untitled)'} (${result.url || ''}) [${result.refCount ?? 0} refs]`;
    if (result.snapshotFile) {
      return [
        header,
        `Full snapshot (${result.bytes} bytes > 12 KB) saved to: ${result.snapshotFile}`,
        'Preview:',
        result.preview ?? '',
      ].join('\n');
    }
    return `${header}\n${result.snapshot || ''}`.trimEnd();
  }
  if (command === 'screenshot') {
    return `Screenshot saved: ${result.path} (${result.bytes} bytes)${result.url ? ` — ${result.url}` : ''}`;
  }
  if (command === 'eval' || command === 'run-code') {
    return formatScalarValue(result.value);
  }
  if (command === 'console') {
    const entries = result.entries || [];
    if (!entries.length) return `Console: 0 entries (total ${result.total ?? 0}).`;
    return [
      `Console (${entries.length}/${result.total ?? entries.length}):`,
      ...entries.map(e => `  [${e.type}] ${e.text}`),
    ].join('\n');
  }
  if (command === 'network') {
    const entries = result.entries || [];
    if (!entries.length) return `Network: 0 entries (total ${result.total ?? 0}).`;
    return [
      `Network (${entries.length}/${result.total ?? entries.length}):`,
      ...entries.map(e => `  [${e.kind}] ${e.method || ''} ${e.status ?? ''} ${e.url}`.replace(/\s+/g, ' ').trim()),
    ].join('\n');
  }
  if (command === 'dialog') {
    return `Dialog ${result.action} (${result.type}): ${result.message || '(no message)'}`;
  }
  if (ACTION_COMMANDS.has(command) || action) {
    const pageInfo = result.url ? ` — ${result.title ? `${result.title} ` : ''}(${result.url})` : '';
    return `OK (${command})${pageInfo}`;
  }
  if (command === 'library') {
    if (Array.isArray(result.runs)) {
      if (!result.runs.length) return `No explorations in ${result.root}.`;
      return [
        `Explorations (${result.runs.length}) [${result.root}]:`,
        ...result.runs.map(r => `  ${r.id} | ${r.status} | ${r.objective} (${r.states ?? 0} states, ${r.transitions ?? 0} transitions)`),
      ].join('\n');
    }
    if (result.run) {
      return `Run ${result.run.id}: ${result.run.status} — ${result.run.objective}\nHandoff: ${result.handoff}\nReview: ${result.review?.decision || 'unreviewed'}`;
    }
    if (result.exported) return `Exported ${result.runId} (${result.files} files) to ${result.directory}`;
    if (result.deleted === true && result.runId) return `Deleted exploration ${result.runId}.`;
    if (Array.isArray(result.deleted)) {
      const skipped = result.skippedActive?.length ? ` Skipped ${result.skippedActive.length} active run(s).` : '';
      return `Deleted ${result.deletedCount} exploration(s).${skipped}`;
    }
    if (result.decision) return `Saved review (${result.decision}) for ${result.run_id || ''}.`;
    return JSON.stringify(result, null, 2);
  }
  if (command === 'install') {
    const lines = [
      `Installed Latch (${result.platform}/${result.architecture})`,
      `Manifest: ${result.manifestPath}`,
      `CLI: ${result.cli}`,
      ...(result.extensionDirectory ? [`Extension: ${result.extensionDirectory}`] : []),
    ];
    return lines.join('\n');
  }
  if (command === 'uninstall') {
    return `Uninstalled Latch native host (user data preserved).`;
  }
  if (command === 'pair') {
    return `Paired profile "${result.profile}" -> ${result.instanceId || result.after} (${result.chromeProfileDir || 'Default'})`;
  }
  if (command === 'doctor') {
    return `Doctor: ${result.healthy ? 'healthy' : 'unhealthy'} (profile "${result.profileAlias || 'work'}")${result.fixed ? ' [fixed]' : ''}`;
  }
  if (command === 'diagnose') {
    return `Diagnose: ${result.healthy ? 'healthy' : 'unhealthy'} (profile "${result.profileAlias}", host ${result.layers?.host || 'unknown'})`;
  }
  if (command === 'discover') {
    const profiles = result.profiles || [];
    if (!profiles.length) return `No live Latch extension instances discovered in ${result.runtimeDirectory}.`;
    return [
      `Discovered ${profiles.length} instance(s):`,
      ...profiles.map(p => `  ${p.instanceId} (ext ${p.extensionVersion || '?'}, ready=${!!p.readiness?.verified})`),
    ].join('\n');
  }
  if (command === 'agents') {
    const items = Array.isArray(result) ? result : result.targets || result.results || result.agents || result.skills;
    if (Array.isArray(items)) {
      return items.map(t => `  ${(t.clients || [t.target || t.name]).join(', ')}: ${t.status} (${t.path || ''})`).join('\n');
    }
    return JSON.stringify(result, null, 2);
  }
  if (command === 'config') {
    const actionLabel = result.reset ? 'Reset artifacts folder to default' : result.updated ? 'Saved artifacts folder' : 'Artifacts folder';
    const note = result.envOverride ? ' (overridden by LATCH_ARTIFACT_ROOT env)' : '';
    return [
      `${actionLabel}: ${result.path} [${result.source}]${note}`,
      `Default: ${result.defaultPath}`,
      `Config: ${result.configPath}`,
    ].join('\n');
  }
  return JSON.stringify(result, null, 2);
}

/** Format CLI error output cleanly for --json or default mode. */
export function formatError(error, {json = false} = {}) {
  const err = cliError(error);
  if (json) {
    return JSON.stringify({ok: false, error: err});
  }
  const summary = {
    code: err.code,
    message: err.message,
    ...(err.hint ? {hint: err.hint} : {}),
  };
  const lines = [`Error [${summary.code}]: ${summary.message}`];
  if (summary.hint) lines.push(`Hint: ${summary.hint}`);
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const rawArgv = process.argv.slice(2);
  const wantsJson = rawArgv.includes('--json');
  try {
    const {invocation, result} = await runCLI(rawArgv);
    const out = formatResult(invocation.command, result, {
      json: !!invocation.flags.json,
      action: invocation.action,
    });
    if (out !== undefined) console.log(out);
  } catch (error) {
    console.error(formatError(error, {json: wantsJson}));
    process.exitCode = 1;
  }
}
