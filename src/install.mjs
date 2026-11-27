#!/usr/bin/env node
import path from 'node:path';
import {ROOT, EXTENSION_ID, HOST_NAME} from './release.mjs';
import {installCommand, pairCommand, doctorCommand, uninstallCommand} from './setup.mjs';
import {
  buildNativeHostManifest,
  writeLauncher,
  privateDirectory,
} from './platform.mjs';
import {assertSetupPlatform} from './compatibility.mjs';

const help = `Latch setup (Windows, macOS, Linux)
  node src/install.mjs install [--root PATH] [--registration-root PATH] [--user-root PATH] [--skip-skills]
  node src/install.mjs pair [--profile work] [--instance UUID] [--chrome-profile-dir DIR]
  node src/install.mjs doctor [--profile work] [--fix]
  node src/install.mjs uninstall [--root PATH] [--registration-root PATH] [--user-root PATH] [--skip-skills]
  node src/install.mjs prepare
prepare writes an unregistered development preview beneath dist/setup-preview only.
`;

try {
  const args = process.argv.slice(2);
  const command = args.shift() || 'help';
  const options = {};
  const names = {
    root: 'root',
    'registration-root': 'registrationRoot',
    kit: 'kit',
    node: 'node',
    'user-root': 'userRoot',
    profile: 'profile',
    instance: 'instance',
    'chrome-profile-dir': 'chromeProfileDir',
    'registry-key': 'registryKey',
    fix: 'fix',
    'skip-skills': 'skipSkills',
    'skip-registry': 'skipRegistry',
    replace: 'replace',
    'expect-old': 'expectOld',
  };
  const booleans = new Set(['fix', 'skipSkills', 'skipRegistry', 'replace']);
  while (args.length) {
    const raw = args.shift();
    if (!raw.startsWith('--')) throw new Error('Unknown setup argument.');
    const key = raw.slice(2);
    const name = names[key];
    if (!name) throw new Error('Unknown setup argument.');
    if (booleans.has(name)) {
      options[name] = true;
    } else {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Missing setup argument.');
      options[name] = value;
    }
  }
  if (['help', '--help'].includes(command)) {
    console.log(help);
  } else if (command === 'prepare') {
    await assertSetupPlatform();
    const dir = path.join(ROOT, 'dist', 'setup-preview');
    await privateDirectory(dir);
    const nativeHostLauncher = await writeLauncher({
      dir,
      name: 'native-host',
      nodeExecutable: process.execPath,
      targetScript: path.join(ROOT, 'src', 'native-host.mjs'),
    });
    const cli = await writeLauncher({
      dir,
      name: 'latch',
      nodeExecutable: process.execPath,
      targetScript: path.join(ROOT, 'src', 'cli.mjs'),
    });
    const hostManifestSource = path.join(dir, `${HOST_NAME}.json`);
    const manifest = buildNativeHostManifest({
      launcherPath: nativeHostLauncher,
      description: 'Latch development preview',
    });
    const fs = await import('node:fs/promises');
    await fs.writeFile(hostManifestSource, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({extensionId: EXTENSION_ID, nativeHostLauncher, cli, registered: false, hostManifestSource}));
  } else {
    const actions = {
      install: installCommand,
      pair: pairCommand,
      doctor: doctorCommand,
      uninstall: uninstallCommand,
    };
    if (!actions[command]) throw new Error('Unknown setup command. Use help.');
    const result = await actions[command](options);
    console.log(JSON.stringify({ok: true, ...result}, null, 2));
  }
} catch (e) {
  console.error(JSON.stringify({ok: false, error: {code: e.code || 'SETUP_FAILED', message: e.message}}));
  process.exitCode = 1;
}
