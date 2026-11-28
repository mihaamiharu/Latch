// Value-free descriptions of API traffic for the agent handoff. Bodies are
// reduced to their shape (keys and types) so tests can assert on structure
// without Latch persisting user data, tokens or card numbers.

export const MAX_BODY_BYTES = 256 * 1024;
const MAX_KEYS = 50;
const MAX_DEPTH = 5;

export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return [];
    return depth >= MAX_DEPTH ? ['…'] : [shapeOf(value[0], depth + 1)];
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object';
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_KEYS)) out[key] = shapeOf(value[key], depth + 1);
    if (keys.length > MAX_KEYS) out['…'] = `${keys.length - MAX_KEYS} more keys`;
    return out;
  }
  return typeof value;
}

const mediaType = contentType => String(contentType || '').split(';')[0].trim().toLowerCase();

// Returns {type, shape} or null. Only the shape leaves this function.
export function bodyShape(text, contentType) {
  if (typeof text !== 'string' || !text.length) return null;
  const type = mediaType(contentType);
  if (type === 'application/json' || type.endsWith('+json') || (!type && /^\s*[[{]/.test(text))) {
    try {
      return {type: 'json', shape: shapeOf(JSON.parse(text))};
    } catch {
      return {type: 'json', shape: 'unparseable'};
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return {type: 'form', shape: Object.fromEntries([...new URLSearchParams(text).keys()].slice(0, MAX_KEYS).map(k => [k, 'string']))};
  }
  if (type.startsWith('multipart/')) return {type: 'multipart', shape: null};
  if (type.startsWith('text/')) return {type: 'text', shape: null};
  return type ? {type, shape: null} : null;
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{24,})$/i;

// "https://app.test/api/orders/8492?draft=1" -> {origin, path: "/api/orders/{id}", query: ["draft"]}
export function apiPath(url) {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map(seg => (seg && ID_SEGMENT.test(decodeURIComponent(seg)) ? '{id}' : seg))
      .join('/');
    return {origin: u.origin, path, query: [...new Set(u.searchParams.keys())]};
  } catch {
    return {origin: null, path: String(url), query: []};
  }
}

// Same site: identical host, or sharing the last two DNS labels (app.x.com / api.x.com).
export function sameSite(url, baseUrl) {
  try {
    const a = new URL(url).hostname;
    const b = new URL(baseUrl).hostname;
    if (a === b) return true;
    if (/^[\d.]+$|:/.test(a) || /^[\d.]+$|:/.test(b)) return false;
    const tail = h => h.split('.').slice(-2).join('.');
    return tail(a) === tail(b);
  } catch {
    return false;
  }
}
