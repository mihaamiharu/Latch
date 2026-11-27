#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ROOT, EXTENSION_ID, HOST_NAME, hash, filesIn, releaseManifest, verifyKit} from './release.mjs';
import {SUPPORT} from './compatibility.mjs';
import {isMainModule} from './platform.mjs';

// Fixed DOS timestamp for 2000-01-01T00:00:00Z so archives are byte-reproducible across OSes.
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (20 << 9) | (1 << 5) | 1;

async function writeDeterministicZip(sourceDir, archivePath, names) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const rawName of names) {
    const name = rawName.replaceAll('\\', '/');
    const nameBuf = Buffer.from(name, 'utf8');
    const data = await fs.readFile(path.join(sourceDir, rawName));
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, {level: 9});
    const method = deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, payload);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  await fs.writeFile(archivePath, Buffer.concat([...localParts, centralDir, eocd]));
}

// A revision alone overstates provenance: a modified tree is not that commit.
export function sourceProvenance(root) {
  const git = (...args) => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  const revision = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain');
  return {
    sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
    sourceDirty: status.status === 0 ? status.stdout.trim() !== '' : null,
  };
}

export async function build({root = ROOT, out = path.join(root, 'dist')} = {}) {
  const manifest = await releaseManifest(root);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const kit = path.join(out, 'latch-' + pkg.version);
  const extension = path.join(out, 'latch');
  await fs.mkdir(out, {recursive: true});
  for (const p of [kit, extension]) await fs.rm(p, {recursive: true, force: true});
  await fs.mkdir(kit);
  for (const folder of [
    'extension',
    'src',
    'skills/latch',
    'plugins/antigravity',
    'node_modules/playwright-core',
    'node_modules/ws',
  ]) {
    await fs.cp(path.join(root, folder), path.join(kit, folder), {recursive: true});
  }
  for (const file of ['package.json', 'package-lock.json']) {
    await fs.copyFile(path.join(root, file), path.join(kit, file));
  }
  await fs.copyFile(path.join(root, 'SETUP.md'), path.join(kit, 'README.md'));
  await fs.copyFile(path.join(root, 'docs/SUPPORT.md'), path.join(kit, 'SUPPORT.md'));
  await fs.copyFile(path.join(root, 'docs/EXPLORATION-LIBRARY.md'), path.join(kit, 'EXPLORATION-LIBRARY.md'));
  for (const file of ['PRIVACY.md', 'THIRD_PARTY_NOTICES.md']) {
    await fs.copyFile(path.join(root, file), path.join(kit, file));
  }
  await fs.rm(path.join(kit, 'src/build.mjs'));
  await fs.writeFile(path.join(kit, 'extension/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const files = {};
  for (const name of await filesIn(kit)) {
    files[name] = hash(await fs.readFile(path.join(kit, name)));
  }
  // No clock or user-machine paths in the descriptor: identical payloads hash identically.
  const descriptor = {
    schema: 1,
    ...sourceProvenance(root),
    version: pkg.version,
    chromeVersion: manifest.version,
    extensionId: EXTENSION_ID,
    hostName: HOST_NAME,
    nodeVersion: SUPPORT.node,
    playwrightCoreVersion: pkg.dependencies?.['playwright-core'],
    nativeSchema: 4,
    uiControl: 1,
    support: SUPPORT,
    files,
  };
  await fs.writeFile(path.join(kit, 'release.json'), JSON.stringify(descriptor, null, 2) + '\n');
  await verifyKit(kit);
  await fs.cp(path.join(kit, 'extension'), extension, {recursive: true});
  const stamp = new Date('2000-01-01T00:00:00Z');
  for (const dir of [kit, extension]) {
    for (const name of await filesIn(dir)) {
      if (process.platform !== 'win32') await fs.chmod(path.join(dir, name), 0o644);
      await fs.utimes(path.join(dir, name), stamp, stamp);
    }
  }
  const archives = [];
  for (const [dir, name] of [[kit, `latch-${pkg.version}-kit.zip`], [extension, `latch-${pkg.version}.zip`]]) {
    const archive = path.join(out, name);
    await fs.rm(archive, {force: true});
    await writeDeterministicZip(dir, archive, await filesIn(dir));
    archives.push({path: archive, sha256: hash(await fs.readFile(archive))});
  }
  return {version: pkg.version, extensionId: EXTENSION_ID, kit, unpackedDirectory: extension, archives};
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await build(), null, 2));
  } catch (e) {
    console.error(JSON.stringify({ok: false, error: {code: e.code || 'BUILD_FAILED', message: e.message}}));
    process.exitCode = 1;
  }
}
