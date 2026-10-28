#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {encode, decoder} from './framing.mjs';
import {rootDir, socketPath, privateDirectory, uuid} from './local.mjs';
import {checkRequest, safeError} from '../extension/protocol.js';
import {NativeSessions} from './native-sessions.mjs';

let identity;
let address;
let server;
let starting = false;
let ownsSocket = false;
let stopping = false;
let nativeSessions;
const pending = new Map();
const sockets = new Set();
function reply(socket, data) { if (!socket.destroyed) socket.end(JSON.stringify(data) + '\n'); }
function failure(id, error) { return {v: 1, id, ok: false, error: safeError(error)}; }
function write(message) { process.stdout.write(encode(message)); }
function browser(op, payload) {
  if (pending.size >= 128) return Promise.reject(Object.assign(new Error('Too many pending browser requests.'), {code: 'BRIDGE_BUSY'}));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('Browser request timed out.'), {code: 'BROWSER_TIMEOUT'}));
    }, 10000);
    pending.set(id, {resolve, reject, timer});
    write({v: 1, id, type: 'request', op, payload});
  });
}
async function start(hello) {
  if (identity || starting || hello.v !== 1 || !uuid.test(hello.instanceId) || !uuid.test(hello.epoch)) throw new Error('Invalid native handshake.');
  starting = true;
  await privateDirectory(rootDir());
  address = socketPath(hello.instanceId);
  try {
    const stat = await fs.lstat(address);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe socket path.');
    const live = await new Promise(resolve => {
      const probe = net.createConnection(address);
      const finish = result => { probe.destroy(); resolve(result); };
      probe.once('connect', () => finish(true));
      probe.once('error', () => finish(false));
      probe.setTimeout(1000, () => finish(true));
    });
    if (live) throw new Error('A bridge for this profile is already running.');
    await fs.unlink(address);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const nativeAvailable = !!hello.capabilities?.nativeTransport && /^[a-p]{32}$/.test(hello.extensionId || '') &&
    process.argv[2] === `chrome-extension://${hello.extensionId}/`;
  identity = {instanceId: hello.instanceId, epoch: hello.epoch, extensionVersion: hello.extensionVersion,
    ...(nativeAvailable ? {extensionId: hello.extensionId} : {}), capabilities: {nativeTransport: nativeAvailable}};
  nativeSessions = new NativeSessions(identity, browser);
  server = net.createServer(socket => {
    sockets.add(socket);
    let data = '';
    let received = false;
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      if (received) return;
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65536) return socket.destroy();
      if (!data.includes('\n')) return;
      received = true;
      let request;
      try {
        request = checkRequest(JSON.parse(data.slice(0, data.indexOf('\n'))));
        // Discovery can ask for status before it knows the current instance epoch.
        if (request.op === 'status' && !request.payload.instanceId) return reply(socket, {v: 1, id: request.id, ok: true, result: identity});
        if (['native-connect', 'native-verify', 'native-disconnect', 'native-status'].includes(request.op)) {
          socket.setTimeout(40000, () => socket.destroy());
          nativeSessions.handle(request.op, request.payload).then(
            result => reply(socket, {v: 1, id: request.id, ok: true, result}),
            error => reply(socket, failure(request.id, error)));
          return;
        }
        // Bootstrap endpoints are minted only by the host. A local caller may
        // not inject an extension endpoint through an internal operation.
        if (request.op.startsWith('native-')) throw Object.assign(new Error('Internal browser operation.'), {code: 'INVALID_REQUEST'});
        if (pending.size >= 128) throw Object.assign(new Error('Too many pending requests.'), {code: 'BRIDGE_BUSY'});
        if (pending.has(request.id)) throw new Error('Duplicate request ID.');
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reply(socket, failure(request.id, Object.assign(new Error('Browser request timed out.'), {code: 'BROWSER_TIMEOUT'})));
        }, 10000);
        pending.set(request.id, {socket, timer});
        write({...request, type: 'request'});
      } catch (error) { reply(socket, failure(request?.id, error)); }
    });
  });
  server.on('error', error => stop(error));
  await new Promise(resolve => server.listen(address, () => { ownsSocket = true; resolve(); }));
  await fs.chmod(address, 0o600);
}
async function stop(error) {
  if (stopping) return;
  stopping = true;
  if (error) process.stderr.write(`Latch: ${error.message}\n`);
  for (const {socket, timer, reject} of pending.values()) {
    clearTimeout(timer); socket?.destroy(); reject?.(new Error('Native bridge stopped.'));
  }
  pending.clear();
  await nativeSessions?.stop();
  for (const socket of sockets) socket.destroy();
  server?.close();
  if (address && ownsSocket) await fs.unlink(address).catch(() => {});
  process.exit(error ? 1 : 0);
}
const consume = decoder(message => {
  if (message?.type === 'hello') { void start(message).catch(stop); return; }
  if (message?.v !== 1 || typeof message.id !== 'string') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (entry.resolve) {
    message.ok ? entry.resolve(message.result) : entry.reject(Object.assign(new Error(message.error?.message || 'Browser operation failed.'), {code: message.error?.code || 'BROWSER_ERROR'}));
  } else reply(entry.socket, message);
});
process.stdin.on('data', chunk => { try { consume(chunk); } catch (error) { void stop(error); } });
process.stdin.on('end', () => void stop());
process.stdin.on('error', error => void stop(error));
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.stdout.on('error', () => void stop());
