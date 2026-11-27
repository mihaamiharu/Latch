import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ROOT, HOST_NAME, EXTENSION_ID} from '../src/release.mjs';
import {
  appDataDir,
  configPath,
  libraryRoot,
  sessionsDir,
  workspaceBindingPath,
  ipcEndpoint,
  nativeMessagingManifestPath,
  readNativeHostRegistration,
} from '../src/platform.mjs';
import {installCommand, pairCommand, doctorCommand, uninstallCommand} from '../src/setup.mjs';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'latch-setup-'));
  const prior = {
    config: process.env.LATCH_CONFIG,
    runtime: process.env.LATCH_RUNTIME_DIR,
    artifacts: process.env.LATCH_ARTIFACT_ROOT,
  };
  const runtime = path.join(dir, 'runtime-ipc');
  await fs.mkdir(runtime, {recursive: true});
  process.env.LATCH_CONFIG = path.join(dir, 'app', 'config.json');
  process.env.LATCH_RUNTIME_DIR = runtime;
  process.env.LATCH_ARTIFACT_ROOT = path.join(dir, 'app', 'artifacts');
  const testRegistryKey = `HKCU\\Software\\LatchTest\\${crypto.randomUUID()}\\NativeMessagingHosts\\${HOST_NAME}`;
  t.after(async () => {
    if (process.platform === 'win32') {
      await exec('reg.exe', ['delete', `HKCU\\Software\\LatchTest`, '/f'], {windowsHide: true}).catch(() => {});
    }
    for (const [k, v] of [
      ['LATCH_CONFIG', prior.config],
      ['LATCH_RUNTIME_DIR', prior.runtime],
      ['LATCH_ARTIFACT_ROOT', prior.artifacts],
    ]) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    await fs.rm(dir, {recursive: true, force: true});
  });
  return {
    dir,
    runtime,
    testRegistryKey,
    options: {
      root: path.join(dir, 'installed with spaces'),
      registrationRoot: path.join(dir, 'registrations'),
      userRoot: path.join(dir, 'user'),
      registryKey: testRegistryKey,
      skipRegistry: process.platform !== 'win32',
    },
  };
}

test('platform contract computes Windows, macOS, and Linux paths and workspace bindings', () => {
  assert.equal(
    appDataDir('win32', {LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local'}),
    path.join('C:\\Users\\alice\\AppData\\Local', 'Latch'),
  );
  assert.equal(
    appDataDir('darwin', {}),
    path.join(os.homedir(), 'Library', 'Application Support', 'Latch'),
  );
  assert.equal(
    appDataDir('linux', {XDG_CONFIG_HOME: '/home/alice/.xdg'}),
    path.join('/home/alice/.xdg', 'latch'),
  );
  assert.equal(
    configPath('linux', {XDG_CONFIG_HOME: '/home/alice/.xdg'}),
    path.join('/home/alice/.xdg', 'latch', 'config.json'),
  );
  assert.equal(
    libraryRoot('linux', {XDG_CONFIG_HOME: '/home/alice/.xdg'}),
    path.join('/home/alice/.xdg', 'latch', 'artifacts'),
  );
  assert.equal(
    sessionsDir('linux', {XDG_CONFIG_HOME: '/home/alice/.xdg'}),
    path.join('/home/alice/.xdg', 'latch', 'sessions'),
  );

  const id = crypto.randomUUID();
  assert.equal(ipcEndpoint(id, 'win32', {}), `\\\\.\\pipe\\latch-${id}`);
  assert.equal(ipcEndpoint(id, 'linux', {LATCH_RUNTIME_DIR: '/tmp/latch-r'}), path.join('/tmp/latch-r', `${id}.sock`));

  assert.equal(
    nativeMessagingManifestPath('win32', {LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local'}),
    path.join('C:\\Users\\alice\\AppData\\Local', 'Latch', 'NativeMessagingHosts', `${HOST_NAME}.json`),
  );
  assert.equal(
    nativeMessagingManifestPath('darwin', {}),
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`),
  );
  assert.equal(
    nativeMessagingManifestPath('linux', {XDG_CONFIG_HOME: '/home/alice/.xdg'}),
    path.join('/home/alice/.xdg', 'google-chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`),
  );

  const binding = workspaceBindingPath(ROOT);
  const expectedHash = crypto.createHash('sha256').update(path.resolve(ROOT).replace(/[\\/]+$/, '')).digest('hex');
  assert.ok(binding.endsWith(path.join('sessions', `${expectedHash}.json`)));
});

test('installCommand, doctorCommand, and uninstallCommand work across Windows, macOS, and Linux paths and preserve data', async t => {
  const f = await fixture(t);

  // Validate Windows, macOS, and Linux registration layouts (skipping Windows reg.exe when emulating other OSes).
  for (const targetPlatform of ['win32', 'darwin', 'linux']) {
    const regRoot = path.join(f.dir, `reg-${targetPlatform}`);
    const installRoot = path.join(f.dir, `rt-${targetPlatform}`);
    const userRoot = path.join(f.dir, `user-${targetPlatform}`);
    const useRealWinRegistry = targetPlatform === 'win32' && process.platform === 'win32';
    const opts = {
      platform: targetPlatform,
      root: installRoot,
      registrationRoot: regRoot,
      userRoot,
      registryKey: f.testRegistryKey,
      skipRegistry: !useRealWinRegistry,
    };

    const installed = await installCommand(opts);
    assert.equal(installed.installed, true);
    assert.equal(installed.platform, targetPlatform);
    assert.equal(installed.hostName, HOST_NAME);
    assert.equal(installed.extensionId, EXTENSION_ID);

    const manifest = JSON.parse(await fs.readFile(installed.manifestPath, 'utf8'));
    assert.equal(manifest.name, HOST_NAME);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
    assert.equal(manifest.path, installed.launcherPath);
    assert.equal(installed.launcherPath.endsWith('.cmd'), targetPlatform === 'win32');

    if (useRealWinRegistry) {
      const reg = await readNativeHostRegistration({
        manifestPath: installed.manifestPath,
        platform: 'win32',
        registryKey: f.testRegistryKey,
      });
      assert.equal(reg.registryValue, installed.manifestPath);
    }

    const doc = await doctorCommand(opts);
    assert.equal(doc.checks.platform.ok, true);
    assert.equal(doc.checks.node.ok, true);
    assert.equal(doc.checks.nativeHost.ok, true);
    assert.equal(doc.checks.nativeHost.launcherExists, true);

    const configBefore = await fs.readFile(process.env.LATCH_CONFIG, 'utf8');
    const artifactMarker = path.join(process.env.LATCH_ARTIFACT_ROOT, 'keep.txt');
    await fs.writeFile(artifactMarker, 'preserve-me');

    const uninstalled = await uninstallCommand(opts);
    assert.equal(uninstalled.unregistered, true);
    assert.equal(uninstalled.dataPreserved, true);
    assert.equal(uninstalled.removedManifest, true);
    await assert.rejects(fs.stat(installed.manifestPath), {code: 'ENOENT'});
    assert.equal(await fs.readFile(process.env.LATCH_CONFIG, 'utf8'), configBefore);
    assert.equal(await fs.readFile(artifactMarker, 'utf8'), 'preserve-me');
  }
});

test('installCommand and uninstallCommand refuse to overwrite a foreign native host manifest', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.options.registrationRoot, {recursive: true});
  const foreignPath = path.join(f.options.registrationRoot, `${HOST_NAME}.json`);
  await fs.writeFile(foreignPath, JSON.stringify({name: 'com.other.host', allowed_origins: []}));

  await assert.rejects(installCommand(f.options), {code: 'INSTALL_FOREIGN_REGISTRATION'});
  await assert.rejects(uninstallCommand(f.options), {code: 'INSTALL_FOREIGN_REGISTRATION'});
  assert.equal(JSON.parse(await fs.readFile(foreignPath, 'utf8')).name, 'com.other.host');
});

test('doctorCommand --fix repairs missing native host registration', async t => {
  const f = await fixture(t);
  const broken = await doctorCommand(f.options);
  assert.equal(broken.checks.nativeHost.ok, false);

  const repaired = await doctorCommand({...f.options, fix: true});
  assert.equal(repaired.fixed, true);
  assert.equal(repaired.checks.nativeHost.ok, true);
});

test('pairCommand auto-discovers a single live unpaired extension instance and rejects ambiguity', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(process.env.LATCH_CONFIG), {recursive: true});
  await fs.writeFile(process.env.LATCH_CONFIG, JSON.stringify({v: 1, profiles: {}}));

  // No live instances -> NO_UNPAIRED_INSTANCE
  await assert.rejects(pairCommand({profile: 'work'}), {code: 'NO_UNPAIRED_INSTANCE'});

  const makeMockHost = async id => {
    const server = net.createServer(socket => {
      let body = '';
      socket.on('data', chunk => {
        body += chunk;
        if (!body.includes('\n')) return;
        const msg = JSON.parse(body.slice(0, body.indexOf('\n')));
        socket.end(
          JSON.stringify({
            v: 1,
            id: msg.id,
            ok: true,
            result: {
              instanceId: id,
              epoch: crypto.randomUUID(),
              extensionVersion: '1.0.0',
              releaseVersion: '1.0.0',
              readiness: {verified: true},
              capabilities: {nativeTransport: true, nativeSessionSchema: 4, uiControl: 1},
            },
          }) + '\n',
        );
      });
    });
    await new Promise(resolve => server.listen(ipcEndpoint(id), resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return server;
  };

  const id1 = crypto.randomUUID();
  await makeMockHost(id1);

  const paired = await pairCommand({profile: 'work'});
  assert.equal(paired.paired, true);
  assert.equal(paired.autoDiscovered, true);
  assert.equal(paired.instanceId, id1);
  assert.equal(paired.chromeProfileDir, 'Default');

  // Re-running pairCommand on already-paired work alias is idempotent
  const idempotent = await pairCommand({profile: 'work'});
  assert.equal(idempotent.alreadyPaired, true);
  assert.equal(idempotent.instanceId, id1);

  // Doctor sees live healthy bridge over real IPC (Named Pipe on Windows, Unix socket on POSIX)
  await installCommand(f.options);
  const health = await doctorCommand({...f.options, profile: 'work'});
  assert.equal(health.healthy, true);
  assert.equal(health.checks.bridge.ok, true);

  // Two additional unpaired instances -> MULTIPLE_UNPAIRED_INSTANCES
  const id2 = crypto.randomUUID();
  const id3 = crypto.randomUUID();
  await makeMockHost(id2);
  await makeMockHost(id3);
  await assert.rejects(pairCommand({profile: 'personal'}), {code: 'MULTIPLE_UNPAIRED_INSTANCES'});

  // CLI wiring smoke for install/doctor/uninstall
  const cliInstall = JSON.parse(
    (
      await exec(process.execPath, [
        cliEntry,
        'install',
        '--json',
        '--root',
        f.options.root,
        '--registration-root',
        f.options.registrationRoot,
        '--user-root',
        f.options.userRoot,
        '--registry-key',
        f.testRegistryKey,
        ...(process.platform !== 'win32' ? ['--skip-registry'] : []),
      ])
    ).stdout,
  );
  assert.equal(cliInstall.ok, true);
  assert.equal(cliInstall.installed, true);
});
