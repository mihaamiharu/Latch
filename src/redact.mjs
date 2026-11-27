import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {safeError} from '../extension/protocol.js';

export const CLI_META = Symbol('latch-action-meta');

export function redact(text) {
  return String(text)
    .replace(/wss?:\/\/[^\s"'<>]+/gi, '[endpoint redacted]')
    .replace(/(PLAYWRIGHT_MCP_EXTENSION_TOKEN=)[^\s"'<>]+/g, '$1[redacted]')
    .replace(/([?&](?:token|access_token|key)=)[^\s&"<>]+/gi, '$1[redacted]')
    .replace(/(\/(?:cdp|extension)\/)[a-f0-9]{64}/gi, '$1[redacted]');
}

// Local CLI failures retain bounded diagnostics; bridge errors use safeError.
export function cliError(error) {
  const base = safeError(error);
  return {
    ...base,
    message: redact(base.message),
    ...(base.hint ? {hint: redact(base.hint)} : {}),
    ...(error?.diagnostics ? {diagnostics: error.diagnostics} : {}),
    ...(error?.evidence ? {evidence: error.evidence} : {}),
    ...(error?.reporting ? {reporting: error.reporting} : {}),
    ...(error?.library ? {library: error.library} : {}),
  };
}

export async function workspaceAt(start = process.cwd()) {
  return await fs.realpath(start);
}

export const sessionKey = (workspace, session) =>
  crypto.createHash('sha256').update(JSON.stringify([workspace, session])).digest('hex');

export function resultValue(response) {
  if (response === undefined || response === null) return response;
  if (Object.hasOwn(response, 'value') && !Object.hasOwn(response, 'result')) {
    return response.value;
  }
  if (typeof response.result !== 'string') return response.result;
  try {
    return JSON.parse(response.result);
  } catch {
    return response.result;
  }
}
