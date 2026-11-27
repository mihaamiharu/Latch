export const VERSION = 1;
export const HOST = 'com.latch.bridge';
export const OPERATIONS = new Set([
  'status',
  'tabs',
  'native-connect',
  'native-verify',
  'native-disconnect',
  'native-status',
  'native-targets',
  'native-release-tab',
  'native-trace',
  'native-create-tab',
  'native-health',
  'native-operation',
  'native-reconcile',
  'native-reserve',
  'native-open',
  'native-check',
  'native-release',
  'native-drop',
  'native-inventory',
]);

export function fault(code, message) {
  return Object.assign(new Error(message), {code});
}

export function checkRequest(request) {
  if (
    !request ||
    request.v !== VERSION ||
    typeof request.id !== 'string' ||
    request.id.length > 120 ||
    !OPERATIONS.has(request.op) ||
    !request.payload ||
    typeof request.payload !== 'object' ||
    Array.isArray(request.payload)
  ) {
    throw fault('INVALID_REQUEST', 'Unsupported or invalid bridge request.');
  }
  return request;
}

export function safeError(error) {
  return {
    code: error.code || 'BROWSER_ERROR',
    message: String(error.message || error).slice(0, 500),
  };
}

export function webUrl(raw) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
}
