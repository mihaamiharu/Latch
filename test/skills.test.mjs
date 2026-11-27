import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installSkills, skillStatus, uninstallSkills, sourceSkill, targetsFor} from '../src/install-skills.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const work = path.join(ROOT, 'work', 'skill-tests');

async function fixture(t) {
  await fs.mkdir(work, {recursive: true});
  const dir = await fs.mkdtemp(path.join(work, 'case-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('slim SKILL.md is ~2-3 KB, covers locked CLI surface, and legacy bloated files are removed', async () => {
  const skillMdPath = path.join(sourceSkill, 'SKILL.md');
  const raw = await fs.readFile(skillMdPath, 'utf8');
  const bytes = Buffer.byteLength(raw, 'utf8');
  assert.ok(bytes >= 1500 && bytes <= 3200, `Expected slim SKILL.md (~2-3 KB), got ${bytes} bytes`);
  assert.match(raw, /^---\r?\nname:\s*latch\r?\n/);

  for (const snippet of [
    'latch doctor',
    'latch tabs',
    'latch open',
    'latch connect',
    'latch snapshot',
    'latch click',
    'latch fill',
    'latch screenshot',
    'latch checkpoint',
    'latch finish',
    'latch library',
    'latch disconnect',
    'latch release',
    '--record',
    '--objective',
    '--focus-emulation',
    '--json',
  ]) {
    assert.ok(raw.includes(snippet), `SKILL.md missing expected reference: ${snippet}`);
  }

  for (const removed of [
    'references/evidence.md',
    'references/operations.md',
    'references/codex-permissions.md',
    'scripts/latch.mjs',
  ]) {
    await assert.rejects(fs.access(path.join(sourceSkill, removed)), {code: 'ENOENT'});
  }

  const openaiYaml = await fs.readFile(path.join(sourceSkill, 'agents/openai.yaml'), 'utf8');
  assert.match(openaiYaml, /display_name:\s*"Latch"/);
  assert.match(openaiYaml, /\$latch/);
  assert.match(openaiYaml, /\.\/assets\/icon\.png/);
  await fs.access(path.join(sourceSkill, 'assets/icon.png'));
});

test('Antigravity plugin bundle adheres strictly to supported schema and assets', async () => {
  const pluginDir = path.join(ROOT, 'plugins', 'antigravity');
  const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));

  const allowedKeys = new Set(['name', 'displayName', 'description', 'logo', 'suggestedPrompts']);
  for (const key of Object.keys(manifest)) {
    assert.ok(allowedKeys.has(key), `Unsupported top-level field in Antigravity plugin.json: ${key}`);
  }
  assert.equal(manifest.name, 'latch');
  assert.equal(manifest.displayName, 'Latch');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 20);
  assert.equal(manifest.logo, 'assets/logo.png');
  assert.ok(Array.isArray(manifest.suggestedPrompts));
  assert.equal(manifest.suggestedPrompts.length, 3);
  for (const prompt of manifest.suggestedPrompts) {
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.trim().length > 0);
  }

  const logoBytes = await fs.readFile(path.join(pluginDir, manifest.logo));
  assert.deepEqual([...logoBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const pluginSkill = await fs.readFile(path.join(pluginDir, 'skills/latch/SKILL.md'), 'utf8');
  const canonicalSkill = await fs.readFile(path.join(sourceSkill, 'SKILL.md'), 'utf8');
  assert.equal(pluginSkill, canonicalSkill);

  const rules = await fs.readFile(path.join(pluginDir, 'rules/AGENTS.md'), 'utf8');
  assert.ok(!rules.startsWith('---'), 'plugins/antigravity/rules/AGENTS.md must be plain markdown without frontmatter');
  assert.match(rules, /signed-in Chrome/i);
  assert.match(rules, /built-in browser/i);
});

test('Claude Code plugin manifest resolves to skills/latch/SKILL.md', async () => {
  const manifestPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'latch');
  assert.equal(typeof manifest.skills, 'string');
  const skillsDir = path.resolve(ROOT, manifest.skills);
  await fs.access(path.join(skillsDir, 'latch', 'SKILL.md'));
});

test('install-skills shim preserves idempotency and conflict safety', async t => {
  const userRoot = await fixture(t);
  const first = await installSkills({userRoot});
  assert.equal(first.length, 3);
  for (const installed of first) {
    assert.equal(installed.status, 'installed');
  }
  assert.deepEqual((await installSkills({userRoot})).map(p => p.status), ['installed', 'installed', 'installed']);
  assert.deepEqual((await uninstallSkills({userRoot})).map(p => p.status), ['missing', 'missing', 'missing']);
  await fs.access(path.join(sourceSkill, 'SKILL.md'));

  const targets = targetsFor(userRoot);
  const claudeTarget = targets.find(entry => entry.id === 'claude');
  await fs.mkdir(claudeTarget.path, {recursive: true});
  const marker = path.join(claudeTarget.path, 'keep.txt');
  await fs.writeFile(marker, 'user-owned skill');
  await assert.rejects(installSkills({userRoot}), /No links were changed/);
  for (const other of targets.filter(entry => entry.id !== 'claude')) {
    await assert.rejects(fs.lstat(other.path), {code: 'ENOENT'});
  }
  assert.equal(await fs.readFile(marker, 'utf8'), 'user-owned skill');
  await uninstallSkills({userRoot});
  assert.equal(await fs.readFile(marker, 'utf8'), 'user-owned skill');
  assert.equal((await skillStatus({userRoot})).find(entry => entry.id === 'claude').status, 'conflict');
});
