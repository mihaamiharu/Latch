import os from 'node:os';
import {fault} from '../extension/protocol.js';
import {MINIMUM_CHROME_VERSION, MINIMUM_NODE_VERSION} from './platform.mjs';

export const SUPPORT = Object.freeze({
  schema: 1,
  platforms: ['win32', 'darwin', 'linux'],
  minimumChrome: MINIMUM_CHROME_VERSION,
  node: `>=${MINIMUM_NODE_VERSION}`,
});

export function atLeast(actual, minimum) {
  if (!/^\d+(?:\.\d+){0,3}$/.test(actual || '')) return false;
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

export function assertNodeVersion(version) {
  const normalized = String(version || '').replace(/^v/, '');
  if (!atLeast(normalized, MINIMUM_NODE_VERSION)) {
    throw fault('SETUP_NODE_VERSION', `Node ${SUPPORT.node} is required; found ${version || 'unknown'}.`);
  }
  return version;
}

export async function assertSetupPlatform(platform = os.platform()) {
  if (!SUPPORT.platforms.includes(platform)) {
    throw fault(
      'SETUP_PLATFORM_UNSUPPORTED',
      `Latch supports Windows, macOS, and Linux; found ${platform}. No installation changes were made.`,
    );
  }
  return {
    platform,
    architecture: os.arch(),
    release: os.release(),
  };
}
