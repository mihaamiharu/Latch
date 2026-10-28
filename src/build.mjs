#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const prepared = spawnSync(process.execPath, [path.join(root, 'src/install.mjs'), 'prepare'], {encoding: 'utf8'});
  if (prepared.status !== 0) throw new Error(prepared.stderr || 'Manifest preparation failed.');
  const identity = JSON.parse(prepared.stdout);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  const folder = path.join(root, 'dist/latch');
  await fs.mkdir(path.dirname(folder), {recursive: true});
  // This directory contains generated extension files only.
  await fs.rm(folder, {recursive: true, force: true});
  await fs.cp(path.join(root, 'extension'), folder, {recursive: true});
  // The old concept remains in source/assets, but is not shipped in the new package.
  for (const size of [16, 32, 48, 128]) await fs.rm(path.join(folder, `icons/icon-${size}.png`), {force: true});
  const files = ['background.js', 'controller.js', 'protocol.js', 'popup.html', 'popup.js', ...Object.values(manifest.icons)];
  for (const file of files) await fs.access(path.join(folder, file));
  const archive = path.join(root, `dist/latch-${manifest.version}.zip`);
  await fs.rm(archive, {force: true});
  const zipped = spawnSync('zip', ['-q', '-r', archive, '.'], {cwd: folder, encoding: 'utf8'});
  if (zipped.status !== 0) throw new Error(zipped.stderr || 'zip is required to create the extension package.');
  console.log(JSON.stringify({name: manifest.name, version: manifest.version, extensionId: identity.extensionId,
    unpackedDirectory: folder, archive, sourceDirectory: path.join(root, 'extension')}, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
