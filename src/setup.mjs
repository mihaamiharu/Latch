import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT, EXTENSION_ID, HOST_NAME} from './release.mjs';
import {
  WINDOWS_REGISTRY_KEY,
  configPath,
  libraryRoot,
  sessionsDir,
  privateDirectory,
  nativeMessagingManifestPath,
  buildNativeHostManifest,
  writeLauncher,
  registerNativeHost,
  unregisterNativeHost,
  readNativeHostRegistration,
  launcherFileName,
} from './platform.mjs';
import {readConfig, writeConfig, updateConfig, request, discoverDetailed, uuid} from './local.mjs';
import {diagnose} from './diagnostics.mjs';
import {replacePairing} from './pair-replace.mjs';
import {installSkills, uninstallSkills} from './install-skills.mjs';
import {assertNodeVersion, assertSetupPlatform} from './compatibility.mjs';
import {workspaceAt, sessionKey} from './playwright.mjs';
import {reconcile} from './reconcile.mjs';
import {daemonIdentity} from './daemon-identity.mjs';
import {fault, safeError} from '../extension/protocol.js';

function assertOwnedManifest(reg) {
  if (!reg.exists) return;
  const origin = `chrome-extension://${EXTENSION_ID}/`;
  const owned =
    reg.manifest &&
    reg.manifest.name === HOST_NAME &&
    Array.isArray(reg.manifest.allowed_origins) &&
    reg.manifest.allowed_origins.includes(origin);
  if (!owned) {
    throw fault('INSTALL_FOREIGN_REGISTRATION', 'Existing native registration is not owned by Latch; preserved.');
  }
}

export async function installCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const platformInfo = await assertSetupPlatform(platform);
  const nodeExecutable = options.node || process.execPath;
  assertNodeVersion(options.nodeVersion || process.version);

  const kit = path.resolve(options.kit || ROOT);
  const cfgPath = configPath(platform, env);
  const baseDir = path.dirname(cfgPath);
  const installRoot = path.resolve(options.root || path.join(baseDir, 'runtime'));
  const binDir = path.join(installRoot, 'bin');
  const manifestPath = nativeMessagingManifestPath(platform, env, options.registrationRoot);
  const registryKey = options.registryKey || WINDOWS_REGISTRY_KEY;
  const skipRegistry = !!options.skipRegistry;

  const existing = await readNativeHostRegistration({manifestPath, platform, registryKey, skipRegistry: true});
  assertOwnedManifest(existing);

  await privateDirectory(baseDir, platform);
  await privateDirectory(sessionsDir(platform, env), platform);
  await privateDirectory(libraryRoot(platform, env), platform);
  await privateDirectory(installRoot, platform);
  await privateDirectory(binDir, platform);

  const launcherPath = await writeLauncher({
    dir: binDir,
    name: 'native-host',
    nodeExecutable,
    targetScript: path.join(kit, 'src', 'native-host.mjs'),
    platform,
  });
  const cliLauncherPath = await writeLauncher({
    dir: binDir,
    name: 'latch',
    nodeExecutable,
    targetScript: path.join(kit, 'src', 'cli.mjs'),
    platform,
  });

  const manifest = buildNativeHostManifest({launcherPath});
  await registerNativeHost({manifestPath, manifest, platform, registryKey, skipRegistry});

  try {
    await fs.access(cfgPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeConfig({v: 1, profiles: {}});
  }

  let skills;
  if (!options.skipSkills) {
    skills = await installSkills({
      userRoot: options.userRoot,
      skillDir: path.join(kit, 'skills', 'latch'),
    });
  }

  const receipt = {
    schema: 1,
    hostName: HOST_NAME,
    extensionId: EXTENSION_ID,
    platform,
    kit,
    nodeExecutable,
    launcherPath,
    cliLauncherPath,
    manifestPath,
    ...(platform === 'win32' ? {registryKey: skipRegistry ? null : registryKey} : {}),
  };
  await fs.writeFile(path.join(installRoot, 'install.json'), JSON.stringify(receipt, null, 2) + '\n');

  return {
    installed: true,
    platform: platformInfo.platform,
    architecture: platformInfo.architecture,
    hostName: HOST_NAME,
    extensionId: EXTENSION_ID,
    configPath: cfgPath,
    libraryRoot: libraryRoot(platform, env),
    sessionsDir: sessionsDir(platform, env),
    manifestPath,
    launcherPath,
    cli: cliLauncherPath,
    ...(platform === 'win32' ? {registryKey: skipRegistry ? null : registryKey} : {}),
    extensionDirectory: path.join(kit, 'extension'),
    ...(skills ? {skills} : {}),
  };
}

export async function pairCommand(options = {}) {
  const alias = options.profile || 'work';
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias)) {
    throw fault('INVALID_PROFILE', 'Use a simple profile alias.');
  }
  const hasReplace = !!options.replace;
  const hasExpectOld = options.expectOld !== undefined;
  if ((hasReplace || hasExpectOld) && (!hasReplace || !hasExpectOld)) {
    throw fault('INVALID_ARGUMENT', 'Use --replace and --expect-old together, only with pair.');
  }

  const profileDirPattern = /^(Default|Profile \d+)$/;
  if (hasReplace) {
    if (!uuid.test(options.instance || '') || !profileDirPattern.test(options.chromeProfileDir || '')) {
      throw fault('INVALID_PAIRING', 'Specify the extension instance UUID and Chrome profile directory (Default or Profile N).');
    }
    return replacePairing({
      alias,
      instance: options.instance,
      expectOld: options.expectOld,
      chromeProfileDir: options.chromeProfileDir,
    });
  }

  let targetInstance = options.instance;
  let chromeProfileDir = options.chromeProfileDir;
  let autoDiscovered = false;

  if (targetInstance !== undefined) {
    if (!uuid.test(targetInstance) || (chromeProfileDir !== undefined && !profileDirPattern.test(chromeProfileDir))) {
      throw fault('INVALID_PAIRING', 'Specify the extension instance UUID and Chrome profile directory (Default or Profile N).');
    }
    if (chromeProfileDir === undefined) chromeProfileDir = 'Default';
  } else {
    if (chromeProfileDir !== undefined && !profileDirPattern.test(chromeProfileDir)) {
      throw fault('INVALID_PAIRING', 'Specify a valid Chrome profile directory (Default or Profile N).');
    }
    chromeProfileDir ||= 'Default';
    autoDiscovered = true;
    const discovered = await discoverDetailed();
    const config = await readConfig();
    const pairedIds = new Set(Object.values(config.profiles || {}).map(p => p?.instanceId).filter(Boolean));
    const existingAlias = config.profiles?.[alias];
    const unpaired = discovered.profiles.filter(p => p?.instanceId && !pairedIds.has(p.instanceId));

    if (unpaired.length === 0) {
      if (existingAlias && discovered.profiles.some(p => p.instanceId === existingAlias.instanceId)) {
        return {
          paired: true,
          alreadyPaired: true,
          autoDiscovered: true,
          profile: alias,
          ...existingAlias,
        };
      }
      throw fault(
        'NO_UNPAIRED_INSTANCE',
        'No live unpaired Latch extension instance found. Load the extension in Chrome and try again.',
      );
    }
    if (unpaired.length > 1) {
      throw fault(
        'MULTIPLE_UNPAIRED_INSTANCES',
        `Found ${unpaired.length} live unpaired extension instances (${unpaired.map(p => p.instanceId).join(', ')}). Specify --instance <uuid>.`,
      );
    }
    targetInstance = unpaired[0].instanceId;
  }

  const live = await request(targetInstance, 'status');
  return updateConfig(config => {
    if (config.profiles?.[alias] && config.profiles[alias].instanceId !== targetInstance) {
      throw fault(
        'PROFILE_ALREADY_PAIRED',
        'This alias is already paired to another instance. Review it, then use pair --replace --expect-old <uuid> if the instance really changed.',
      );
    }
    config.profiles ||= {};
    config.profiles[alias] = {
      ...config.profiles[alias],
      instanceId: live.instanceId,
      chromeProfileDir,
    };
    return {
      paired: true,
      autoDiscovered,
      profile: alias,
      ...config.profiles[alias],
      note: 'Profile-directory correspondence will be checked by the first connection.',
    };
  });
}

async function checkNativeRegistration({platform, env, registrationRoot, registryKey, skipRegistry}) {
  const manifestPath = nativeMessagingManifestPath(platform, env, registrationRoot);
  const reg = await readNativeHostRegistration({manifestPath, platform, registryKey, skipRegistry});
  const origin = `chrome-extension://${EXTENSION_ID}/`;
  const manifestValid =
    reg.exists &&
    reg.manifest?.name === HOST_NAME &&
    Array.isArray(reg.manifest?.allowed_origins) &&
    reg.manifest.allowed_origins.includes(origin) &&
    typeof reg.manifest?.path === 'string';
  const launcherExists = manifestValid
    ? await fs.access(reg.manifest.path).then(() => true, () => false)
    : false;
  const registryOk = platform !== 'win32' || skipRegistry || reg.registryValue === manifestPath;
  return {
    ok: manifestValid && launcherExists && registryOk,
    manifestPath,
    manifestExists: reg.exists,
    manifestValid: !!manifestValid,
    launcherPath: reg.manifest?.path || null,
    launcherExists,
    ...(platform === 'win32'
      ? {registryKey, registryValue: reg.registryValue, registryOk}
      : {}),
  };
}

export async function doctorCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const alias = options.profile || 'work';
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias)) {
    throw fault('INVALID_PROFILE', 'Use a simple profile alias.');
  }
  if (options.session && !/^[a-zA-Z0-9_-]{1,60}$/.test(options.session)) {
    throw fault('INVALID_SESSION', 'Invalid session name.');
  }

  let platformCheck;
  try {
    platformCheck = {ok: true, ...(await assertSetupPlatform(platform))};
  } catch (error) {
    platformCheck = {ok: false, error: safeError(error)};
  }

  let nodeCheck;
  try {
    nodeCheck = {ok: true, version: assertNodeVersion(options.nodeVersion || process.version)};
  } catch (error) {
    nodeCheck = {ok: false, error: safeError(error)};
  }

  const registryKey = options.registryKey || WINDOWS_REGISTRY_KEY;
  const skipRegistry = !!options.skipRegistry;
  let nativeHostCheck = await checkNativeRegistration({
    platform,
    env,
    registrationRoot: options.registrationRoot,
    registryKey,
    skipRegistry,
  });

  let fixed = false;
  if (!nativeHostCheck.ok && options.fix && platformCheck.ok && nodeCheck.ok) {
    await installCommand(options);
    nativeHostCheck = await checkNativeRegistration({
      platform,
      env,
      registrationRoot: options.registrationRoot,
      registryKey,
      skipRegistry,
    });
    fixed = true;
  }

  const health = await diagnose(alias);
  const bridgeCheckOk = health.healthy && !!health.connection?.capabilities?.nativeTransport;
  const nativeRecoverySupported = health.connection?.ok
    ? health.connection?.capabilities
      ? health.connection.capabilities.nativeSessionSchema === 4
      : null
    : null;

  const baseResult = {
    ...health,
    transport: 'native',
    bridgeHealthy: health.bridgeHealthy ?? false,
    nativeRecoverySupported,
    ...(fixed ? {fixed: true} : {}),
    checks: {
      platform: platformCheck,
      node: nodeCheck,
      nativeHost: nativeHostCheck,
      bridge: {
        ok: bridgeCheckOk,
        paired: health.configuration?.paired ?? false,
        readinessVerified: health.connection?.readiness?.verified ?? false,
        nativeTransport: health.connection?.capabilities?.nativeTransport ?? false,
      },
    },
  };

  if (!options.session) {
    return {
      ...baseResult,
      healthy: platformCheck.ok && nodeCheck.ok && bridgeCheckOk,
    };
  }

  const workspace = await workspaceAt(options.workspace || process.cwd());
  const recovery = await reconcile({
    alias,
    workspace,
    session: options.session,
    key: sessionKey(workspace, options.session),
  });
  let daemon;
  try {
    const live = await daemonIdentity(workspace, options.session);
    daemon = {
      present: !!live,
      socketExists: live?.socketExists || false,
      matchesRecordedTask:
        !!live &&
        live.fingerprint === recovery.record?.daemonFingerprint &&
        live.socketFingerprint === recovery.record?.daemonSocketFingerprint,
    };
  } catch (error) {
    daemon = {present: null, error: safeError(error)};
  }

  return {
    ...baseResult,
    healthy:
      platformCheck.ok &&
      nodeCheck.ok &&
      bridgeCheckOk &&
      recovery.healthy &&
      daemon.present === true &&
      daemon.socketExists &&
      daemon.matchesRecordedTask,
    recovery,
    daemon,
  };
}

export async function uninstallCommand(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  await assertSetupPlatform(platform);

  const cfgPath = configPath(platform, env);
  const baseDir = path.dirname(cfgPath);
  const installRoot = path.resolve(options.root || path.join(baseDir, 'runtime'));
  const binDir = path.join(installRoot, 'bin');
  const manifestPath = nativeMessagingManifestPath(platform, env, options.registrationRoot);
  const registryKey = options.registryKey || WINDOWS_REGISTRY_KEY;
  const skipRegistry = !!options.skipRegistry;

  const existing = await readNativeHostRegistration({manifestPath, platform, registryKey, skipRegistry: true});
  assertOwnedManifest(existing);

  const unregistered = await unregisterNativeHost({manifestPath, platform, registryKey, skipRegistry});

  const removedLaunchers = [];
  for (const name of ['native-host', 'latch']) {
    const file = path.join(binDir, launcherFileName(name, platform));
    try {
      await fs.unlink(file);
      removedLaunchers.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await fs.unlink(path.join(installRoot, 'install.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });

  let skillsRemoved = false;
  if (!options.skipSkills) {
    await uninstallSkills({userRoot: options.userRoot});
    skillsRemoved = true;
  }

  return {
    unregistered: true,
    dataPreserved: true,
    manifestPath,
    ...unregistered,
    removedLaunchers,
    skillsRemoved,
  };
}
