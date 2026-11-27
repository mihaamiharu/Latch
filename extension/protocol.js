export const VERSION = 1;
export const HOST = 'com.latch.bridge';

export const OPERATIONS = new Set([
  'status',
  'tabs',
  'session-open',
  'session-connect',
  'session-list',
  'session-release',
  'session-disconnect',
  'session-action',
  'session-capture-state',
]);

export const INTERNAL_OPERATIONS = new Set([
  'status',
  'tabs',
  'native-create-tab',
  'native-reserve',
  'native-open',
  'native-check',
  'native-release',
  'native-drop',
  'native-inventory',
  'native-health',
]);

export const ACTIONS = new Set([
  'snapshot',
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'hover',
  'select',
  'check',
  'uncheck',
  'upload',
  'screenshot',
  'goto',
  'back',
  'forward',
  'reload',
  'eval',
  'run-code',
  'console',
  'network',
  'dialog',
]);

export function fault(code, message, hint) {
  return Object.assign(new Error(message), {
    code,
    ...(hint ? {hint} : {}),
  });
}

export function checkRequest(request, {internal = false} = {}) {
  const allowed = internal ? INTERNAL_OPERATIONS : OPERATIONS;
  if (
    !request ||
    request.v !== VERSION ||
    typeof request.id !== 'string' ||
    request.id.length > 120 ||
    !allowed.has(request.op) ||
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
    code: error?.code || 'BROWSER_ERROR',
    message: String(error?.message || error).slice(0, 500),
    ...(error?.hint ? {hint: String(error.hint).slice(0, 300)} : {}),
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
