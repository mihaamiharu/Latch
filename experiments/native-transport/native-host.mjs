import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import {encode, decoder} from '../../src/framing.mjs';
import {privateDirectory} from '../../src/local.mjs';
import {createRelay} from './relay.mjs';

const runtime = process.env.LATCH_SPIKE_RUNTIME;
const extensionId = process.env.LATCH_SPIKE_EXTENSION_ID;
if (!runtime || !extensionId || process.argv[2] !== `chrome-extension://${extensionId}/`)
  throw new Error('Experimental native host requires an isolated runtime and its registered caller.');
const address = path.join(runtime, 'spike.sock');
const pending = new Map();
let server, relay, ownsSocket = false, stopping = false, initialized = false;
function browser(op, args = {}) {
  if (pending.size >= 16) return Promise.reject(new Error('Too many control requests.'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Extension control timed out.')); }, 10000);
    pending.set(id, {resolve, reject, timer});
    process.stdout.write(encode({id, op, ...args}));
  });
}
async function operate(request) {
  if (request.op === 'status') return {ready: initialized, ...(relay ? {relay: relay.status()} : {})};
  if (request.op === 'tabs') return browser('tabs');
  if (request.op === 'debuggers') return browser('debuggers');
  if (request.op === 'fixtureSeed') return browser('fixtureSeed');
  if (request.op === 'trace') return relay?.trace() || [];
  if (request.op === 'disconnect') {
    try { await browser('release'); } finally { await relay?.stop(); }
    return {disconnected: true};
  }
  if (request.op !== 'connect' || relay || !Number.isSafeInteger(request.tabId))
    throw new Error('This experiment permits one connection per host lifetime.');
  const tabs = await browser('tabs');
  const tab = tabs.find(tab => tab.id === request.tabId);
  if (!tab) throw new Error('Target tab is unavailable.');
  relay = await createRelay(extensionId);
  try {
    await browser('connect', {tabId: tab.id, expectedUrl: tab.url, endpoint: relay.extensionEndpoint});
    await relay.ready;
    return {cdpEndpoint: relay.cdpEndpoint, tabId: tab.id};
  } catch (error) { await relay.stop(); throw error; }
}
async function start() {
  if (initialized || server) throw new Error('Duplicate initialization.');
  await privateDirectory(runtime);
  server = net.createServer(socket => {
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    let data = '', received = false;
    socket.on('data', chunk => {
      if (received) return;
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65536) return socket.destroy();
      if (!data.includes('\n')) return;
      received = true;
      Promise.resolve().then(() => operate(JSON.parse(data.slice(0, data.indexOf('\n')))))
        .then(result => socket.end(JSON.stringify({ok: true, result}) + '\n'),
          error => socket.end(JSON.stringify({ok: false, error: error.message}) + '\n'));
    });
  });
  server.on('error', () => void stop(1));
  await new Promise(resolve => server.listen(address, () => { ownsSocket = true; resolve(); }));
  await fs.chmod(address, 0o600);
  initialized = true;
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Native bridge stopped.')); }
  pending.clear();
  await relay?.stop();
  server?.close();
  if (ownsSocket) await fs.unlink(address).catch(() => {});
  process.exit(code);
}
const consume = decoder(message => {
  if (message?.type === 'hello' && message.extensionId === extensionId) { void start().catch(() => stop(1)); return; }
  const entry = pending.get(message?.id);
  if (!entry) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
});
process.stdin.on('data', chunk => { try { consume(chunk); } catch { void stop(1); } });
process.stdin.on('end', () => void stop());
process.stdin.on('error', () => void stop(1));
process.stdout.on('error', () => void stop(1));
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
