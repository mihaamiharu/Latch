import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT, EXTENSION_ID, HOST_NAME, hash, quote, verifyKit, filesIn} from './release.mjs';
import {privateDirectory, readConfig, socketPath, configPath, rootDir} from './local.mjs';
import {fault} from '../extension/protocol.js';
import {assertVersion} from './playwright.mjs';
import {targetsFor} from './install-skills.mjs';
import {assertNodeVersion, assertSetupPlatform} from './compatibility.mjs';
import {executableAt} from './setup-prerequisites.mjs';

const exec = promisify(execFile);
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const optional = async p => {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

export function setupPaths(options = {}) {
  const root = path.resolve(options.root || path.join(os.homedir(), 'Library/Application Support/Latch/runtime'));
  return {
    root,
    configuration: configPath(),
    runtimeDirectory: rootDir(),
    releases: path.join(root, 'releases'),
    extension: path.join(root, 'extension'),
    current: path.join(root, 'current'),
    receipt: path.join(root, 'receipt.json'),
    transaction: path.join(root, 'transaction.json'),
    gate: path.join(root, 'setup.lock'),
    registration: path.join(
      options.registrationRoot || path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      HOST_NAME + '.json',
    ),
    node: options.node || process.execPath,
  };
}

async function ownedRoot(p) {
  let stat;
  try {
    stat = await fs.lstat(p.root);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw fault('INSTALL_ROOT_FOREIGN', 'Installation root must be a dedicated owned directory.');
  }
  if (stat) {
    const marker = await optional(path.join(p.root, '.latch-root.json'));
    if (marker) {
      if (JSON.parse(marker).extensionId !== EXTENSION_ID) {
        throw fault('INSTALL_ROOT_FOREIGN', 'Installation marker differs.');
      }
    } else if ((await fs.readdir(p.root)).length) {
      throw fault('INSTALL_ROOT_FOREIGN', 'Nonempty unowned installation directory; preserved.');
    }
  }
  await privateDirectory(p.root);
  const marker = path.join(p.root, '.latch-root.json');
  try {
    await fs.writeFile(marker, JSON.stringify({extensionId: EXTENSION_ID, schema: 1}), {flag: 'wx', mode: 0o600});
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

async function atomic(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temp, value, {flag: 'wx', mode: 0o600});
  await fs.rename(temp, file);
}

async function pointer(file, target) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.symlink(target, temp, 'dir');
  await fs.rename(temp, file);
}

async function unreachable(instance) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(instance));
    const done = (error, value) => {
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.once('connect', () => done(null, false));
    socket.once('error', e =>
      ['ENOENT', 'ECONNREFUSED'].includes(e.code)
        ? done(null, true)
        : done(fault('BRIDGE_ACCESS_DENIED', 'Cannot establish maintenance: ' + e.code)),
    );
    socket.setTimeout(1000, () => done(fault('MAINTENANCE_UNVERIFIED', 'Bridge liveness is uncertain.')));
  });
}

async function maintenance(options) {
  const profiles = (await readConfig()).profiles || {};
  if (!options.extensionUnloaded || !options.tasksDrained) {
    throw fault(
      'MAINTENANCE_UNVERIFIED',
      'Drain tasks and unload the target extension before activation. The flags record operator attestation, not automatic browser verification.',
    );
  }
  for (const profile of Object.values(profiles)) {
    if (!(await unreachable(profile.instanceId))) {
      throw fault('INSTALL_ACTIVE', 'A configured bridge is still reachable. No activation was performed.');
    }
  }
  return {operatorAttested: true, configuredBridgesUnreachable: true};
}

async function extensionValid(p, descriptor) {
  const inventory = {};
  for (const name of await filesIn(p.extension)) {
    inventory[name] = hash(await fs.readFile(path.join(p.extension, name)));
    if (inventory[name] !== descriptor.files['extension/' + name]) {
      throw fault('INSTALL_CHANGED', 'Stable extension files changed.');
    }
  }
  if (Object.keys(descriptor.files).filter(n => n.startsWith('extension/')).length !== Object.keys(inventory).length) {
    throw fault('INSTALL_CHANGED', 'Stable extension inventory changed.');
  }
  return inventory;
}

async function installBoot(p) {
  await privateDirectory(path.join(p.root, 'bin'));
  const source = [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import {pathToFileURL, fileURLToPath} from 'node:url';",
    'try {',
    '  const root = path.dirname(fileURLToPath(import.meta.url));',
    "  const receipt = JSON.parse(await fs.readFile(path.join(root, 'receipt.json'), 'utf8'));",
    "  const release = await fs.realpath(path.join(root, 'current'));",
    "  if (release !== receipt.active) throw new Error('Active release/receipt mismatch');",
    '  process.env.LATCH_CONFIG = receipt.configuration;',
    '  process.env.LATCH_RUNTIME_DIR = receipt.runtimeDirectory;',
    "  process.env.PATH = path.dirname(receipt.node) + path.delimiter + (process.env.PATH || '');",
    '  if (receipt.playwrightCLI) process.env.LATCH_PLAYWRIGHT_CLI = receipt.playwrightCLI;',
    '  const mode = process.argv[2];',
    "  if (!['native-host', 'cli'].includes(mode)) throw new Error('Invalid launcher');",
    "  const target = path.join(release, 'src', mode + '.mjs');",
    '  process.argv = [process.argv[0], target, ...process.argv.slice(3)];',
    '  await import(pathToFileURL(target).href);',
    '} catch (e) {',
    "  process.stderr.write(JSON.stringify({ok: false, error: {code: 'LATCH_ACTIVE_RUNTIME_UNAVAILABLE', message: e.message}}) + '\\n');",
    '  process.exitCode = 1;',
    '}',
  ].join('\n') + '\n';
  await atomic(path.join(p.root, 'boot.mjs'), source);
  for (const [name, mode] of [['native-host', 'native-host'], ['latch', 'cli']]) {
    const file = path.join(p.root, 'bin', name);
    await atomic(file, `#!/bin/sh\nexec ${quote(p.node)} ${quote(path.join(p.root, 'boot.mjs'))} ${quote(mode)} "$@"\n`);
    await fs.chmod(file, 0o700);
  }
}

async function replaceExtension(p, source) {
  const temp = await fs.mkdtemp(path.join(p.root, '.extension-'));
  await fs.cp(path.join(source, 'extension'), temp, {recursive: true});
  const old = path.join(p.root, '.extension-previous');
  if (await fs.lstat(old).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
    throw fault('INSTALL_RECOVERY_BLOCKED', 'Previous extension directory requires inspection; preserved.');
  }
  try {
    await fs.rename(p.extension, old);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    await fs.rename(temp, p.extension);
  } catch (e) {
    await fs.rename(old, p.extension).catch(() => {});
    throw e;
  }
  await fs.rm(old, {recursive: true, force: true});
}

async function transaction(p, fn) {
  await ownedRoot(p);
  try {
    await fs.mkdir(p.gate, {mode: 0o700});
  } catch (e) {
    if (e.code === 'EEXIST') throw fault('SETUP_BUSY', 'An installer transaction gate exists; PID/age do not authorize removal.');
    throw e;
  }
  const nonce = crypto.randomUUID();
  await fs.writeFile(path.join(p.gate, 'owner.json'), JSON.stringify({nonce, pid: process.pid}), {mode: 0o600});
  let release = true;
  try {
    return await fn();
  } catch (e) {
    if (e.retainGate) release = false;
    throw e;
  } finally {
    if (release) {
      await fs.unlink(path.join(p.gate, 'owner.json'));
      await fs.rmdir(p.gate);
    }
  }
}

export async function inspectSetup(options = {}) {
  const platform = await assertSetupPlatform();
  const p = setupPaths(options);
  const kit = path.resolve(options.kit || ROOT);
  const release = await verifyKit(kit);
  p.node = await executableAt(p.node);
  let node;
  try {
    node = JSON.parse(
      (await exec(p.node, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,architecture:process.arch})'], {timeout: 5000})).stdout,
    );
  } catch {
    throw fault('SETUP_NODE_VERSION', `Cannot verify the selected Node executable. Required: ${release.nodeVersion} for macOS arm64.`);
  }
  assertNodeVersion(node.version);
  if (node.platform !== platform.platform || node.architecture !== platform.architecture) {
    throw fault('SETUP_NODE_PLATFORM', 'The selected Node executable must match the qualified macOS arm64 platform.');
  }
  const rawReceipt = await optional(p.receipt);
  const receipt = rawReceipt ? JSON.parse(rawReceipt) : null;
  const registration = await optional(p.registration);
  if (registration && registration !== receipt?.registration) {
    throw fault('INSTALL_FOREIGN_REGISTRATION', 'Existing native registration is not owned by this installation.');
  }
  let activePointer = null;
  let extensionInventory = null;
  if (receipt) {
    const marker = await optional(path.join(p.root, '.latch-root.json'));
    if (
      !marker ||
      JSON.parse(marker).schema !== 1 ||
      JSON.parse(marker).extensionId !== EXTENSION_ID ||
      receipt.schema !== 1 ||
      receipt.extensionId !== EXTENSION_ID
    ) {
      throw fault('INSTALL_ROOT_FOREIGN', 'An unowned or unknown receipt cannot select an executable.');
    }
    activePointer = await fs.realpath(p.current);
    if (activePointer !== receipt.active) throw fault('INSTALL_CHANGED', 'Active release selection changed.');
    extensionInventory = await extensionValid(p, await verifyKit(receipt.active));
  }
  const playwrightCLI = await executableAt(
    options.playwrightCLI || process.env.LATCH_PLAYWRIGHT_CLI || receipt?.playwrightCLI || 'playwright-cli',
    kit,
  );
  const cliVersion = await assertVersion({workspace: kit, timeout: 10000, executable: playwrightCLI, nodeExecutable: p.node});
  const playwrightCLIEntrySHA256 = hash(await fs.readFile(playwrightCLI));
  const existingManifest = receipt ? await json(path.join(p.extension, 'manifest.json')) : null;
  const permissionDelta = (await json(path.join(kit, 'extension/manifest.json'))).permissions.filter(
    name => !existingManifest?.permissions?.includes(name),
  );
  const gate = await fs.lstat(p.gate).then(
    () => true,
    e => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );
  const token = hash(
    JSON.stringify({
      activePointer,
      extensionInventory,
      release: hash(await fs.readFile(path.join(kit, 'release.json'))),
      root: p.root,
      registration,
      node: p.node,
      playwrightCLI,
      playwrightCLIEntrySHA256,
      receipt: rawReceipt,
      configuration: p.configuration,
      runtimeDirectory: p.runtimeDirectory,
      skillLinks: receipt?.skillLinks || [],
    }),
  );
  return {
    platform,
    paths: p,
    prerequisites: {node: p.node, playwrightCLI, cliVersion, playwrightCLIEntrySHA256},
    kit,
    release,
    receipt,
    registration,
    gate,
    transaction: await optional(p.transaction),
    planToken: token,
    permissionDelta,
    changes: {
      registrationPath: registration ? JSON.parse(registration).path : null,
      newRegistrationPath: path.join(p.root, 'bin/native-host'),
      extensionDirectory: p.extension,
    },
    blockers: gate ? ['SETUP_BUSY'] : [],
  };
}

export async function stageSetup(options = {}) {
  const plan = await inspectSetup(options);
  if (plan.gate) throw fault('SETUP_BUSY', 'An installer transaction already exists; inspect it without removing its gate.');
  await ownedRoot(plan.paths);
  await privateDirectory(plan.paths.releases);
  const id = plan.release.version + '-' + hash(await fs.readFile(path.join(plan.kit, 'release.json'))).slice(0, 12);
  const dest = path.join(plan.paths.releases, id);
  try {
    await fs.access(dest);
    if (hash(await fs.readFile(path.join(dest, 'release.json'))) !== hash(await fs.readFile(path.join(plan.kit, 'release.json')))) {
      throw fault('RELEASE_HASH_CHANGED', 'Staged release descriptor changed.');
    }
    await verifyKit(dest);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const temp = await fs.mkdtemp(path.join(plan.paths.releases, '.stage-'));
    try {
      await fs.cp(plan.kit, temp, {recursive: true});
      await verifyKit(temp);
      await fs.rename(temp, dest);
    } catch (error) {
      await fs.rm(temp, {recursive: true, force: true});
      throw error;
    }
  }
  return {...plan, staged: dest, releaseId: id};
}

export async function activateSetup(options = {}) {
  const staged = await stageSetup(options);
  const p = staged.paths;
  if (options.expect !== staged.planToken) {
    throw fault('SETUP_PLAN_CHANGED', 'Inspect the current installation plan before activating.');
  }
  return transaction(p, async () => {
    const fresh = await inspectSetup(options);
    if (fresh.planToken !== options.expect) throw fault('SETUP_PLAN_CHANGED', 'Installation changed before activation.');
    // The gate created by this transaction is expected here; no other gate is reclaimed.
    const proof = await maintenance(options);
    const priorActive = fresh.receipt?.active || null;
    const previous = priorActive === staged.staged ? fresh.receipt.previous : priorActive;
    const launchers = [];
    for (const file of ['boot.mjs', 'bin/native-host', 'bin/latch']) {
      const full = path.join(p.root, file);
      const raw = await optional(full);
      launchers.push({file: full, raw, mode: raw === null ? null : (await fs.stat(full)).mode & 0o777});
    }
    const before = {receipt: await optional(p.receipt), registration: await optional(p.registration), active: priorActive};
    await atomic(p.transaction, JSON.stringify({state: 'activating', candidate: staged.staged, before, proof}));
    try {
      await installBoot(p);
      await pointer(p.current, staged.staged);
      await replaceExtension(p, staged.staged);
      const registration =
        JSON.stringify(
          {
            name: HOST_NAME,
            description: 'Latch local browser transport',
            path: path.join(p.root, 'bin/native-host'),
            type: 'stdio',
            allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
          },
          null,
          2,
        ) + '\n';
      await privateDirectory(path.dirname(p.registration));
      await atomic(p.registration, registration);
      const receipt = {
        schema: 1,
        version: staged.release.version,
        chromeVersion: staged.release.chromeVersion,
        configuration: p.configuration,
        runtimeDirectory: p.runtimeDirectory,
        active: staged.staged,
        previous,
        registration,
        node: p.node,
        playwrightCLI: fresh.prerequisites.playwrightCLI,
        playwrightCLIEntrySHA256: fresh.prerequisites.playwrightCLIEntrySHA256,
        extensionId: EXTENSION_ID,
        skillLinks: fresh.receipt?.skillLinks || [],
        skillBefore: fresh.receipt?.skillBefore || [],
        maintenance: proof,
      };
      await atomic(p.receipt, JSON.stringify(receipt, null, 2) + '\n');
      await atomic(p.transaction, JSON.stringify({state: 'activated-awaiting-browser-verification', active: staged.staged, previous}));
      return {
        activated: true,
        verified: false,
        version: receipt.version,
        extensionDirectory: p.extension,
        cli: path.join(p.root, 'bin/latch'),
        retainedPrevious: previous,
      };
    } catch (e) {
      try {
        if (before.active) {
          await pointer(p.current, before.active);
          await replaceExtension(p, before.active);
        } else {
          await fs.unlink(p.current).catch(() => {});
          await fs.rm(p.extension, {recursive: true, force: true});
        }
        for (const [file, raw] of [[p.receipt, before.receipt], [p.registration, before.registration]]) {
          raw === null ? await fs.unlink(file).catch(() => {}) : await atomic(file, raw);
        }
        for (const item of launchers) {
          if (item.raw === null) {
            await fs.unlink(item.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
          } else {
            await atomic(item.file, item.raw);
            await fs.chmod(item.file, item.mode);
          }
        }
        await atomic(p.transaction, JSON.stringify({state: 'activation-failed-restored', code: e.code || 'SETUP_FAILED'}));
      } catch {
        const failure = fault('SETUP_ROLLBACK_UNCONFIRMED', 'Activation failed and restoration is unconfirmed; transaction gate retained.');
        failure.retainGate = true;
        throw failure;
      }
      throw e;
    }
  });
}

export async function rollbackSetup(options = {}) {
  await assertSetupPlatform();
  const p = setupPaths(options);
  return transaction(p, async () => {
    const raw = await optional(p.receipt);
    const receipt = JSON.parse(raw);
    if (!receipt.previous) throw fault('ROLLBACK_UNAVAILABLE', 'No retained previous release.');
    await maintenance(options);
    if ((await optional(p.registration)) !== receipt.registration || (await fs.realpath(p.current)) !== receipt.active) {
      throw fault('INSTALL_CHANGED', 'Installed selection or registration changed; rollback was not applied.');
    }
    await extensionValid(p, await verifyKit(receipt.active));
    const old = await verifyKit(receipt.previous);
    const active = receipt.active;
    await atomic(p.transaction, JSON.stringify({state: 'rolling-back', before: receipt}));
    try {
      await pointer(p.current, receipt.previous);
      await replaceExtension(p, receipt.previous);
      const next = {
        ...receipt,
        active: receipt.previous,
        previous: active,
        version: old.version,
        chromeVersion: old.chromeVersion || old.version,
      };
      await atomic(p.receipt, JSON.stringify(next, null, 2) + '\n');
      await atomic(p.transaction, JSON.stringify({state: 'rollback-awaiting-browser-verification', active: next.active}));
      return {rolledBack: true, verified: false, version: old.version, extensionDirectory: p.extension};
    } catch (error) {
      try {
        await pointer(p.current, active);
        await replaceExtension(p, active);
        await atomic(p.receipt, raw);
        await atomic(p.transaction, JSON.stringify({state: 'rollback-failed-restored', code: error.code || 'SETUP_FAILED'}));
      } catch {
        const failure = fault('SETUP_ROLLBACK_UNCONFIRMED', 'Rollback restoration is unconfirmed; transaction gate retained.');
        failure.retainGate = true;
        throw failure;
      }
      throw error;
    }
  });
}

export async function verifySetup(options = {}) {
  const p = setupPaths(options);
  const receipt = await json(p.receipt);
  await extensionValid(p, await verifyKit(receipt.active));
  if ((await fs.realpath(p.current)) !== receipt.active || (await optional(p.registration)) !== receipt.registration) {
    throw fault('INSTALL_CHANGED', 'Installed registration or active release changed.');
  }
  const result = await exec(path.join(p.root, 'bin/latch'), ['diagnose', '--profile', options.profile || 'work'], {timeout: 15000});
  const health = JSON.parse(result.stdout);
  if (!health.healthy) throw fault('INSTALL_NOT_READY', 'Installed profile is not ready. Inspect diagnostics.');
  if (
    health.connection?.extensionVersion !== receipt.chromeVersion ||
    health.connection?.releaseVersion !== receipt.version ||
    health.connection?.capabilities?.nativeSessionSchema !== 4 ||
    health.connection?.capabilities?.uiControl !== 1
  ) {
    throw fault('INSTALL_CAPABILITY_MISMATCH', 'Reload/accept the candidate extension before verifying.');
  }
  return {verified: true, scope: 'identity-and-readiness', applicationSmokeRequired: true, version: receipt.version, health};
}

export async function configureNativeSetup(options = {}) {
  await assertSetupPlatform();
  const verified = await verifySetup(options);
  if (!verified.health.connection?.capabilities?.nativeTransport) {
    throw fault('NATIVE_TRANSPORT_UNAVAILABLE', 'This extension build has no native debugger transport.');
  }
  return {
    defaultTransport: 'native',
    verified: true,
    scope: 'identity-readiness-and-native-default',
    applicationSmokeRequired: true,
  };
}

export async function setupSkills(options = {}) {
  await assertSetupPlatform();
  const p = setupPaths(options);
  return transaction(p, async () => {
    const receipt = await json(p.receipt);
    const target = path.join(p.current, 'skills/latch');
    await fs.access(path.join(target, 'SKILL.md'));
    const links = targetsFor(options.userRoot).map(t => t.path);
    const before = [];
    for (const file of links) {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isSymbolicLink()) throw fault('SKILL_CONFLICT', 'An unrelated skill directory exists.');
        const raw = await fs.readlink(file);
        const resolved = path.resolve(path.dirname(file), raw);
        if (!(receipt.skillLinks.includes(file) && resolved === target)) {
          throw fault('SKILL_CONFLICT', 'An unrelated skill link exists.');
        }
        before.push({path: file, target: raw});
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        before.push({path: file, target: null});
      }
    }
    const changed = [];
    try {
      for (const item of before) {
        if (item.target === target) continue;
        await fs.mkdir(path.dirname(item.path), {recursive: true});
        await pointer(item.path, target);
        changed.push(item);
      }
      const prior = receipt.skillBefore.length ? receipt.skillBefore : before;
      await atomic(p.receipt, JSON.stringify({...receipt, skillLinks: links, skillBefore: prior}, null, 2) + '\n');
    } catch (e) {
      for (const item of changed.reverse()) {
        item.target === null ? await fs.unlink(item.path) : await pointer(item.path, item.target);
      }
      throw e;
    }
    return {skillsInstalled: true, links};
  });
}

export async function uninstallSetup(options = {}) {
  await assertSetupPlatform();
  const p = setupPaths(options);
  return transaction(p, async () => {
    const receipt = await json(p.receipt);
    await maintenance(options);
    if ((await optional(p.registration)) !== receipt.registration) {
      throw fault('INSTALL_FOREIGN_REGISTRATION', 'Registration differs; preserved.');
    }
    for (const file of receipt.skillLinks) {
      const stat = await fs.lstat(file).catch(() => null);
      if (stat?.isSymbolicLink() && path.resolve(path.dirname(file), await fs.readlink(file)) === path.join(p.current, 'skills/latch')) {
        await fs.unlink(file);
      }
    }
    await fs.unlink(p.registration);
    await atomic(p.transaction, JSON.stringify({state: 'unregistered', dataPreserved: true}));
    return {unregistered: true, dataPreserved: true};
  });
}
