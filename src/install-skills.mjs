#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {linkDirectory} from './platform.mjs';

export const sourceSkill = fileURLToPath(new URL('../skills/latch/', import.meta.url));
export function targetsFor(userRoot = os.homedir()) {
  return [
    {clients: ['Codex', 'Cursor'], path: path.join(userRoot, '.agents/skills/latch')},
    {clients: ['Claude Code'], path: path.join(userRoot, '.claude/skills/latch')},
  ];
}
export async function skillStatus({skillDir = sourceSkill, userRoot = os.homedir()} = {}) {
  const canonical = await fs.realpath(skillDir);
  return await Promise.all(targetsFor(userRoot).map(async target => {
    try {
      const stat = await fs.lstat(target.path);
      if (!stat.isSymbolicLink()) return {...target, status: 'conflict'};
      const linked = path.resolve(path.dirname(target.path), await fs.readlink(target.path));
      let resolved;
      try { resolved = await fs.realpath(linked); } catch { resolved = linked; }
      return {...target, status: resolved === canonical ? 'installed' : 'conflict', target: linked};
    } catch (error) { if (error.code === 'ENOENT') return {...target, status: 'missing'}; throw error; }
  }));
}
export async function installSkills(options = {}) {
  const canonical = await fs.realpath(options.skillDir || sourceSkill);
  await fs.access(path.join(canonical, 'SKILL.md'));
  const before = await skillStatus(options);
  if (before.some(target => target.status === 'conflict')) throw new Error('A different latch skill already exists. No links were changed.');
  const created = [];
  try {
    for (const target of before.filter(target => target.status === 'missing')) {
      await fs.mkdir(path.dirname(target.path), {recursive: true});
      await linkDirectory(canonical, target.path);
      created.push(target.path);
    }
  } catch (error) {
    for (const createdPath of created) await fs.unlink(createdPath).catch(() => {});
    throw error;
  }
  return await skillStatus(options);
}
export async function uninstallSkills(options = {}) {
  const before = await skillStatus(options);
  for (const target of before.filter(target => target.status === 'installed')) await fs.unlink(target.path);
  return await skillStatus(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || 'install';
    const options = {install: installSkills, status: skillStatus, uninstall: uninstallSkills};
    if (!options[command]) throw new Error('Usage: node src/install-skills.mjs install|status|uninstall');
    console.log(JSON.stringify({ok: true, source: sourceSkill, skills: await options[command]()}, null, 2));
  } catch (error) { console.error(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1; }
}
