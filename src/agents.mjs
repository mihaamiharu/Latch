#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {linkDirectory} from './platform.mjs';
import {fault} from '../extension/protocol.js';

export const sourceSkill = fileURLToPath(new URL('../skills/latch/', import.meta.url));
export const sourceAntigravityPlugin = fileURLToPath(new URL('../plugins/antigravity/', import.meta.url));

const VALID_TARGETS = new Set(['antigravity', 'claude', 'codex', 'cursor']);

function samePath(a, b, platform = process.platform) {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function parseTargetList(target) {
  if (!target || target === 'all') return ['antigravity', 'claude', 'codex', 'cursor'];
  const items = String(target)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length) {
    throw fault('INVALID_ARGUMENT', 'Specify at least one target: antigravity, claude, codex, cursor, or all.');
  }
  for (const item of items) {
    if (item === 'all') return ['antigravity', 'claude', 'codex', 'cursor'];
    if (!VALID_TARGETS.has(item)) {
      throw fault('INVALID_ARGUMENT', `Unknown agent target "${item}". Use antigravity, claude, codex, cursor, or all.`);
    }
  }
  return [...new Set(items)];
}

export function targetsFor(userRoot = os.homedir(), target = 'all') {
  const selected = new Set(parseTargetList(target));
  const allTargets = [
    {
      id: 'antigravity',
      targets: ['antigravity'],
      clients: ['Antigravity'],
      path: path.join(userRoot, '.gemini', 'config', 'plugins', 'latch'),
      kind: 'plugin',
    },
    {
      id: 'claude',
      targets: ['claude'],
      clients: ['Claude Code'],
      path: path.join(userRoot, '.claude', 'skills', 'latch'),
      kind: 'skill',
    },
    {
      id: 'codex-cursor',
      targets: ['codex', 'cursor'],
      clients: ['Codex', 'Cursor'],
      path: path.join(userRoot, '.agents', 'skills', 'latch'),
      kind: 'skill',
    },
  ];
  return allTargets.filter(entry => entry.targets.some(t => selected.has(t)));
}

async function resolveSourceForTarget(target, options = {}) {
  if (target.kind === 'skill') {
    const dir = options.skillDir || sourceSkill;
    try {
      const canonical = await fs.realpath(dir);
      await fs.access(path.join(canonical, 'SKILL.md'));
      return canonical;
    } catch {
      return null;
    }
  }

  const candidates = [];
  if (options.antigravityDir) {
    candidates.push(options.antigravityDir);
  } else {
    if (options.skillDir) {
      candidates.push(path.resolve(options.skillDir, '..', '..', 'plugins', 'antigravity'));
    }
    candidates.push(sourceAntigravityPlugin);
  }

  for (const dir of candidates) {
    try {
      const canonical = await fs.realpath(dir);
      await fs.access(path.join(canonical, 'plugin.json'));
      await fs.access(path.join(canonical, 'skills', 'latch', 'SKILL.md'));
      return canonical;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export async function agentsStatus({
  skillDir = sourceSkill,
  antigravityDir,
  userRoot = os.homedir(),
  target = 'all',
  platform = process.platform,
} = {}) {
  const targets = targetsFor(userRoot, target);
  return await Promise.all(
    targets.map(async entry => {
      const canonical = await resolveSourceForTarget(entry, {skillDir, antigravityDir});
      if (!canonical) {
        return {...entry, status: 'unavailable', source: null};
      }
      try {
        const stat = await fs.lstat(entry.path);
        if (!stat.isSymbolicLink()) {
          return {...entry, status: 'conflict', source: canonical};
        }
        const linked = path.resolve(path.dirname(entry.path), await fs.readlink(entry.path));
        let resolved;
        try {
          resolved = await fs.realpath(linked);
        } catch {
          resolved = linked;
        }
        return {
          ...entry,
          status: samePath(resolved, canonical, platform) ? 'installed' : 'conflict',
          source: canonical,
          target: linked,
        };
      } catch (error) {
        if (error.code === 'ENOENT') {
          return {...entry, status: 'missing', source: canonical};
        }
        throw error;
      }
    }),
  );
}

export async function installAgents(options = {}) {
  const before = await agentsStatus(options);
  const explicitTarget = options.target && options.target !== 'all';
  if (before.some(entry => entry.status === 'unavailable' && (entry.kind === 'skill' || explicitTarget))) {
    throw fault('AGENT_SOURCE_MISSING', 'Required Latch skill or plugin source files were not found.');
  }
  if (before.some(entry => entry.status === 'conflict')) {
    throw fault(
      'AGENT_TARGET_CONFLICT',
      'A different latch skill or plugin already exists at the target path. No links were changed.',
    );
  }

  const created = [];
  try {
    for (const entry of before.filter(t => t.status === 'missing' && t.source)) {
      await fs.mkdir(path.dirname(entry.path), {recursive: true});
      await linkDirectory(entry.source, entry.path, options.platform || process.platform);
      created.push(entry.path);
    }
  } catch (error) {
    for (const createdPath of created) {
      await fs.unlink(createdPath).catch(() => {});
    }
    throw error;
  }

  return await agentsStatus(options);
}

export async function uninstallAgents(options = {}) {
  const before = await agentsStatus(options);
  for (const entry of before.filter(t => t.status === 'installed')) {
    await fs.unlink(entry.path);
  }
  return await agentsStatus(options);
}

export async function agentsCommand(action, flags = {}) {
  const normalized = action || 'status';
  const options = {
    userRoot: flags.userRoot || flags['user-root'] || os.homedir(),
    target: flags.target || 'all',
    skillDir: flags.skillDir,
    antigravityDir: flags.antigravityDir,
    platform: flags.platform || process.platform,
  };

  let targets;
  if (normalized === 'install') {
    targets = await installAgents(options);
  } else if (normalized === 'status') {
    targets = await agentsStatus(options);
  } else if (normalized === 'uninstall') {
    targets = await uninstallAgents(options);
  } else {
    throw fault(
      'INVALID_ARGUMENT',
      'Usage: latch agents <install|status|uninstall> [--target antigravity,claude,codex,cursor]',
    );
  }

  return {
    action: normalized,
    target: options.target,
    targets,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const action = args.shift() || 'status';
    const flags = {};
    while (args.length) {
      const flag = args.shift();
      if (flag === '--target' || flag === '--user-root') {
        const value = args.shift();
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
        flags[flag.slice(2)] = value;
      } else {
        throw new Error(`Unknown flag: ${flag}`);
      }
    }
    console.log(JSON.stringify({ok: true, ...(await agentsCommand(action, flags))}, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: {code: error.code || 'AGENTS_FAILED', message: error.message}}));
    process.exitCode = 1;
  }
}
