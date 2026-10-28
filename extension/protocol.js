export const VERSION = 1;
export const HOST = 'com.qa_browser.bridge';
export const OFFICIAL_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export const OPERATIONS = new Set(['status', 'tabs', 'register', 'claim', 'verify', 'release', 'forget',
  'native-connect', 'native-verify', 'native-disconnect', 'native-status',
  'native-reserve', 'native-open', 'native-check', 'native-release']);
export function fault(code, message) {
  return Object.assign(new Error(message), {code});
}
export function checkRequest(request) {
  if (!request || request.v !== VERSION || typeof request.id !== 'string' || request.id.length > 120 ||
      !OPERATIONS.has(request.op) || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))
    throw fault('INVALID_REQUEST', 'Unsupported or invalid bridge request.');
  return request;
}
export function safeError(error) {
  return {code: error.code || 'BROWSER_ERROR', message: String(error.message || error).slice(0, 500)};
}
export function bridgeLocator(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'chrome-extension:' || url.hostname !== OFFICIAL_ID || url.pathname !== '/connect.html') return null;
  if (url.searchParams.get('protocolVersion') !== '2') return null;
  try {
    const relay = new URL(url.searchParams.get('mcpRelayUrl'));
    if (relay.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(relay.hostname) ||
        relay.username || relay.password || relay.search || relay.hash || !/^\/extension\/[a-f0-9-]{36}$/.test(relay.pathname)) return null;
    return relay.href;
  } catch { return null; }
}
export function webUrl(raw) {
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
