import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fault} from '../extension/protocol.js';

// Candidate qualification is deliberately narrower than Chrome's API floor
// (125). Expanding these claims requires evidence, not just API availability.
export const SUPPORT = Object.freeze({
  schema: 1,
  platform: 'darwin', architectures: ['arm64'], minimumMacOS: '27.0.1',
  minimumChrome: '147', node: 'v22.21.1', playwrightCLI: '0.1.20',
});
export function requiresSupportContract(version) {
  return version !== '0.1.2' && !/^0\.2\.0-rc\.[123]$/.test(version);
}
function atLeast(actual, minimum) {
  if (!/^\d+(?:\.\d+){0,3}$/.test(actual || '')) return false;
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}
export async function assertSetupPlatform() {
  const platform = os.platform(), architecture = os.arch();
  if (platform !== SUPPORT.platform)
    throw fault('SETUP_PLATFORM_UNSUPPORTED', 'This release installs only on macOS. No installation changes were made.');
  if (!SUPPORT.architectures.includes(architecture))
    throw fault('SETUP_ARCHITECTURE_UNSUPPORTED', `This candidate is qualified for Apple Silicon (arm64); found ${architecture}. Intel is not yet qualified.`);
  let version;
  try { version = (await promisify(execFile)('/usr/bin/sw_vers', ['-productVersion'], {timeout: 5000})).stdout.trim(); }
  catch { throw fault('SETUP_MACOS_UNVERIFIED', 'Cannot determine macOS version; no installation changes were made.'); }
  assertMacOSVersion(version);
  return {platform, architecture, macOS: version};
}
export function assertMacOSVersion(version) {
  if (!atLeast(version, SUPPORT.minimumMacOS))
    throw fault('SETUP_MACOS_UNSUPPORTED', `This candidate requires macOS ${SUPPORT.minimumMacOS} or later; found ${version}. Older releases are unqualified.`);
}
