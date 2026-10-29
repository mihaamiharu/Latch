#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {HOST} from '../extension/protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const installDir = path.join(root, 'install');
const hostPath = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${HOST}.json`);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function prepare() {
  await fs.mkdir(installDir, {recursive: true});
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  let key;
  try { key = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8')).key; } catch {}
  if (!key) key = crypto.generateKeyPairSync('rsa', {modulusLength: 2048}).publicKey.export({type: 'spki', format: 'der'}).toString('base64');
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  const extensionId = [...digest].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  const manifest = {manifest_version: 3, name: 'Latch', version: pkg.version, minimum_chrome_version: '120',
    description: 'Connect selected existing Work-profile tabs to Playwright CLI from your terminal.',
    permissions: ['tabs', 'tabGroups', 'storage', 'nativeMessaging', 'alarms'],
    background: {service_worker: 'background.js', type: 'module'},
    icons: {'16': 'icons/latch-16.png', '32': 'icons/latch-32.png', '48': 'icons/latch-48.png', '128': 'icons/latch-128.png'},
    action: {default_popup: 'popup.html', default_title: 'Latch', default_icon: {'16': 'icons/latch-16.png', '32': 'icons/latch-32.png'}}, key};
  await fs.writeFile(path.join(root, 'extension/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const launcher = path.join(installDir, 'native-host');
  await fs.writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'src/native-host.mjs'))} "$@"\n`, {mode: 0o755});
  await fs.chmod(launcher, 0o755);
  const cli = path.join(installDir, 'qa-browser');
  await fs.writeFile(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'src/cli.mjs'))} "$@"\n`, {mode: 0o755});
  await fs.chmod(cli, 0o755);
  const host = {name: HOST, description: 'Work Browser Bridge local transport', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`]};
  await fs.writeFile(path.join(installDir, `${HOST}.json`), JSON.stringify(host, null, 2) + '\n');
  const result = {extensionId, extensionDirectory: path.join(root, 'extension'), hostManifestSource: path.join(installDir, `${HOST}.json`),
    hostManifestDestination: hostPath, cli, node: process.execPath};
  await fs.writeFile(path.join(installDir, 'preview.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
try {
  const command = process.argv[2] || 'prepare';
  if (command === 'prepare') console.log(JSON.stringify(await prepare(), null, 2));
  else if (command === 'apply') {
    if (process.platform !== 'darwin') throw new Error('This installer currently supports macOS Chrome only.');
    const preview = await prepare();
    const source = await fs.readFile(preview.hostManifestSource, 'utf8');
    try {
      const existing = await fs.readFile(hostPath, 'utf8');
      if (existing !== source) throw new Error('A different native host registration exists; refusing to overwrite it.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(hostPath), {recursive: true});
    await fs.writeFile(hostPath, source, {mode: 0o600});
    console.log(JSON.stringify({...preview, registered: true}, null, 2));
  } else if (command === 'uninstall') {
    const preview = JSON.parse(await fs.readFile(path.join(installDir, 'preview.json'), 'utf8'));
    const source = await fs.readFile(preview.hostManifestSource, 'utf8');
    const installed = await fs.readFile(hostPath, 'utf8');
    if (source !== installed) throw new Error('Registration differs from this installation; refusing removal.');
    await fs.unlink(hostPath);
    console.log('Native host registration removed. Remove the companion extension in Chrome to complete uninstall.');
  } else throw new Error('Usage: node src/install.mjs prepare|apply|uninstall');
} catch (error) { console.error(error.message); process.exitCode = 1; }
