#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {encode, decoder} from './framing.mjs';
import {rootDir, socketPath, privateDirectory, uuid} from './local.mjs';
import {isWindowsPipe} from './platform.mjs';
import {checkRequest, safeError} from '../extension/protocol.js';
import {NativeSessions} from './native-sessions.mjs';
import {NativeRecovery} from './native-recovery.mjs';
import {NativeUI} from './native-ui.mjs';
import {ROOT} from './release.mjs';

let identity;
let address;
let server;
let starting = false;
let ownsSocket = false;
let stopping = false;
let nativeSessions;
let recovery;
let ui;
let controlNonce;
const uiPending = new Set();
const uiTasks = new Set();
let handshake;
let ready = false;
const hostGeneration = crypto.randomUUID();
const pending = new Map();
const sockets = new Set();
const operationDrains = new Map();

function reply(socket, data) {
  if (!socket.destroyed) socket.end(JSON.stringify(data) + '\n');
}

function failure(id, error) {
  return {v: 1, id, ok: false, error: safeError(error)};
}

function write(message) {
  process.stdout.write(encode(message));
}

function browser(op, payload) {
  if (pending.size >= 128) {
    return Promise.reject(Object.assign(new Error('Too many pending browser requests.'), {code: 'BRIDGE_BUSY'}));
  }
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
  if (identity || starting || hello.v !== 1 || !uuid.test(hello.instanceId) || !uuid.test(hello.epoch)) {
    throw new Error('Invalid native handshake.');
  }
  starting = true;
  address = socketPath(hello.instanceId);
  if (isWindowsPipe(address)) {
    const live = await new Promise(resolve => {
      const probe = net.createConnection(address);
      const finish = result => {
        probe.destroy();
        resolve(result);
      };
      probe.once('connect', () => finish(true));
      probe.once('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? false : true));
      probe.setTimeout(1000, () => finish(true));
    });
    if (live) throw new Error('A bridge for this profile is already running.');
  } else {
    await privateDirectory(rootDir());
    try {
      const stat = await fs.lstat(address);
      if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe socket path.');
      const live = await new Promise(resolve => {
        const probe = net.createConnection(address);
        const finish = result => {
          probe.destroy();
          resolve(result);
        };
        probe.once('connect', () => finish(true));
        probe.once('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? false : true));
        probe.setTimeout(1000, () => finish(true));
      });
      if (live) throw new Error('A bridge for this profile is already running.');
      await fs.unlink(address);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const nativeAvailable =
    !!hello.capabilities?.nativeTransport &&
    /^[a-p]{32}$/.test(hello.extensionId || '') &&
    process.argv[2] === `chrome-extension://${hello.extensionId}/`;
  const releaseVersion = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  controlNonce = hello.nonce;
  identity = {
    releaseVersion,
    instanceId: hello.instanceId,
    epoch: hello.epoch,
    hostGeneration,
    extensionVersion: hello.extensionVersion,
    ...(nativeAvailable ? {extensionId: hello.extensionId} : {}),
    capabilities: {
      nativeTransport: nativeAvailable,
      ...(nativeAvailable ? {nativeSessionSchema: hello.capabilities.nativeSessionSchema || 4} : {}),
      ...(hello.capabilities?.recoveryContract === 1 ? {recoveryContract: 1} : {}),
      ...(hello.capabilities?.uiControl === 1 ? {uiControl: 1} : {}),
      ...(nativeAvailable && hello.capabilities?.createTab === 1 ? {createTab: 1} : {}),
    },
  };
  nativeSessions = new NativeSessions(identity, browser);
  if (nativeAvailable && identity.capabilities.nativeSessionSchema === 4) {
    recovery = new NativeRecovery(identity, nativeSessions, browser);
  }
  ui = new NativeUI(identity, nativeSessions, recovery, browser);

  server = net.createServer(socket => {
    if (sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let data = '';
    let received = false;
    let persistent = false;
    let grant;
    let grantTimer;
    let closed = false;
    let finishPromise;
    let queued = 0;
    let sequence = Promise.resolve();

    const send = value => {
      if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
    };
    const finishGrant = () => {
      if (closed) return finishPromise;
      closed = true;
      clearTimeout(grantTimer);
      if (grant) recovery?.fence(grant);
      finishPromise = sequence.finally(() => recovery?.finish(grant, {interrupted: true}));
      void finishPromise.finally(() => operationDrains.delete(socket)).catch(() => {});
      return finishPromise;
    };
    operationDrains.set(socket, finishGrant);
    socket.on('close', finishGrant);

    const operation = async request => {
      try {
        if (!recovery || !ready) {
          throw Object.assign(new Error('Native recovery is unavailable.'), {code: 'NATIVE_TRANSPORT_UNAVAILABLE'});
        }
        const p = request.payload;
        let result;
        if (p.action === 'begin') {
          if (grant || closed) {
            throw Object.assign(new Error('Operation already opened or connection ended.'), {code: 'OPERATION_FENCED'});
          }
          grant = await recovery.begin(p, socket);
          if (closed) {
            await recovery.finish(grant, {interrupted: true});
            return;
          }
          grantTimer = setTimeout(() => {
            recovery.fence(grant);
            socket.end(
              JSON.stringify(
                failure(
                  request.id,
                  Object.assign(new Error('Native operation expired; inspect its outcome.'), {code: 'OPERATION_FENCED'}),
                ),
              ) + '\n',
            );
          }, 60000);
          result = {nonce: grant.nonce};
        } else if (p.action === 'end') {
          recovery.check(grant, socket, p.nonce);
          clearTimeout(grantTimer);
          await recovery.finish(grant);
          grant = undefined;
          result = {ended: true};
        } else {
          result = await recovery.step(grant, socket, p);
        }
        send({v: 1, id: request.id, ok: true, result});
      } catch (error) {
        send(failure(request.id, error));
      }
    };

    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      if (received && !persistent) return;
      data += chunk.toString();
      if (Buffer.byteLength(data) > 65536) return socket.destroy();
      if (!data.includes('\n')) return;
      if (!received) {
        try {
          persistent = JSON.parse(data.slice(0, data.indexOf('\n'))).op === 'native-operation';
        } catch {}
      }
      if (persistent) {
        socket.setTimeout(65000, () => socket.destroy());
        while (data.includes('\n')) {
          const line = data.slice(0, data.indexOf('\n'));
          data = data.slice(data.indexOf('\n') + 1);
          let request;
          try {
            request = checkRequest(JSON.parse(line));
            if (request.op !== 'native-operation') throw new Error('Mixed operation channel.');
          } catch (error) {
            send(failure(request?.id, error));
            socket.end();
            return;
          }
          if (queued) {
            send(
              failure(
                request.id,
                Object.assign(new Error('Only one recovery request may be outstanding.'), {code: 'BRIDGE_BUSY'}),
              ),
            );
            socket.end();
            return;
          }
          queued++;
          sequence = sequence.then(() => operation(request)).finally(() => {
            queued--;
          });
        }
        received = true;
        return;
      }
      received = true;
      let request;
      try {
        request = checkRequest(JSON.parse(data.slice(0, data.indexOf('\n'))));
        // Discovery can ask for status before it knows the current instance epoch.
        if (!ready) throw Object.assign(new Error('Controller readiness is not verified.'), {code: 'BRIDGE_NOT_READY'});
        if (request.op === 'status' && !request.payload.instanceId) {
          browser('status', {instanceId: identity.instanceId, epoch: identity.epoch}).then(
            result =>
              reply(socket, {
                v: 1,
                id: request.id,
                ok: true,
                result: {
                  ...identity,
                  readiness: {verified: true, verifiedAt: Date.now()},
                  controllerSessions: result.sessions?.length,
                },
              }),
            error => reply(socket, failure(request.id, error)),
          );
          return;
        }
        if (request.op === 'native-reconcile') {
          if (!recovery) {
            throw Object.assign(new Error('Native recovery is unavailable.'), {code: 'NATIVE_TRANSPORT_UNAVAILABLE'});
          }
          recovery
            .metadata(request.payload)
            .then(() => recovery.inspect(request.payload.sessionKey))
            .then(
              result => reply(socket, {v: 1, id: request.id, ok: true, result}),
              error => reply(socket, failure(request.id, error)),
            );
          return;
        }
        if (recovery && ['native-connect', 'native-verify', 'native-disconnect', 'native-targets', 'native-release-tab'].includes(request.op)) {
          throw Object.assign(new Error('Use a connection-bound native operation grant.'), {code: 'OPERATION_GRANT_REQUIRED'});
        }
        if (
          ['native-connect', 'native-verify', 'native-disconnect', 'native-status', 'native-targets', 'native-release-tab', 'native-trace'].includes(
            request.op,
          )
        ) {
          socket.setTimeout(40000, () => socket.destroy());
          nativeSessions.handle(request.op, request.payload).then(
            result => reply(socket, {v: 1, id: request.id, ok: true, result}),
            error => reply(socket, failure(request.id, error)),
          );
          return;
        }
        // Bootstrap endpoints are minted only by the host. A local caller may
        // not inject an extension endpoint through an internal operation.
        if (request.op.startsWith('native-')) {
          throw Object.assign(new Error('Internal browser operation.'), {code: 'INVALID_REQUEST'});
        }
        if (pending.size >= 128) throw Object.assign(new Error('Too many pending requests.'), {code: 'BRIDGE_BUSY'});
        if (pending.has(request.id)) throw new Error('Duplicate request ID.');
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reply(socket, failure(request.id, Object.assign(new Error('Browser request timed out.'), {code: 'BROWSER_TIMEOUT'})));
        }, 10000);
        pending.set(request.id, {socket, timer});
        write({...request, type: 'request'});
      } catch (error) {
        reply(socket, failure(request?.id, error));
      }
    });
  });

  server.on('error', error => stop(error));
  if (isWindowsPipe(address)) {
    await new Promise(resolve => server.listen(address, () => {
      ownsSocket = true;
      resolve();
    }));
  } else {
    // Restrict the socket at creation, before another process can discover it.
    // This mask is local to the native-host process and restored after binding.
    const previousMask = process.umask(0o177);
    try {
      await new Promise(resolve => server.listen(address, () => {
        ownsSocket = true;
        resolve();
      }));
    } finally {
      process.umask(previousMask);
    }
    await fs.chmod(address, 0o600);
  }
  if (hello.capabilities?.recoveryContract === 1) {
    handshake = {
      nonce: hello.nonce,
      epoch: hello.epoch,
      timer: setTimeout(() => void stop(new Error('Controller readiness timed out.')), 5000),
    };
    write({v: 1, type: 'challenge', nonce: hello.nonce, epoch: hello.epoch, hostGeneration});
  } else {
    ready = true;
  }
}

async function stop(error) {
  if (stopping) return;
  stopping = true;
  ready = false;
  clearTimeout(handshake?.timer);
  ui?.stop();
  const drains = [...operationDrains.values()].map(drain => drain());
  for (const socket of sockets) socket.destroy();
  if (error) process.stderr.write(`Latch: ${error.message}\n`);
  for (const {socket, timer, reject} of pending.values()) {
    clearTimeout(timer);
    socket?.destroy();
    reject?.(new Error('Native bridge stopped.'));
  }
  pending.clear();
  await nativeSessions?.stop();
  await Promise.allSettled([...drains, ...uiTasks]);
  // Keep the old listening inode occupied until all journal tails settle.
  // Unlink while still listening, then close; there is no later unlink which
  // could erase a successor's newly bound socket.
  if (address && ownsSocket && !isWindowsPipe(address)) await fs.unlink(address).catch(() => {});
  server?.close();
  process.exit(error ? 1 : 0);
}

const consume = decoder(message => {
  if (
    message?.type === 'ack' &&
    handshake &&
    message.nonce === handshake.nonce &&
    message.epoch === identity?.epoch &&
    message.hostGeneration === hostGeneration
  ) {
    clearTimeout(handshake.timer);
    ready = true;
    write({
      v: 1,
      type: 'ready',
      capabilities: identity.capabilities,
      nonce: handshake.nonce,
      epoch: identity.epoch,
      hostGeneration,
    });
    handshake = undefined;
    return;
  }
  if (message?.type === 'ui-request') {
    if (
      !ready ||
      !identity?.capabilities.uiControl ||
      message.v !== 1 ||
      message.nonce !== controlNonce ||
      message.hostGeneration !== hostGeneration ||
      !uuid.test(message.id || '') ||
      !['status', 'revoke'].includes(message.op) ||
      uiPending.size >= 16 ||
      uiPending.has(message.id) ||
      JSON.stringify(message.payload || {}).length > 8192
    ) {
      return;
    }
    uiPending.add(message.id);
    const job = (async () => {
      let response;
      try {
        const result = await (message.op === 'status' ? ui.status() : ui.revoke(message.payload || {}));
        if (Buffer.byteLength(JSON.stringify(result)) > 65536) {
          throw Object.assign(new Error('Popup status exceeded its bound.'), {code: 'UI_MESSAGE_TOO_LARGE'});
        }
        response = {ok: true, result};
      } catch (error) {
        response = {ok: false, error: safeError(error)};
      } finally {
        uiPending.delete(message.id);
      }
      if (ready) {
        write({v: 1, type: 'ui-response', id: message.id, nonce: controlNonce, hostGeneration, ...response});
      }
    })();
    uiTasks.add(job);
    void job.finally(() => uiTasks.delete(job)).catch(() => {});
    return;
  }
  if (message?.type === 'hello') {
    void start(message).catch(stop);
    return;
  }
  if (message?.v !== 1 || typeof message.id !== 'string') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (entry.resolve) {
    message.ok
      ? entry.resolve(message.result)
      : entry.reject(
          Object.assign(new Error(message.error?.message || 'Browser operation failed.'), {
            code: message.error?.code || 'BROWSER_ERROR',
          }),
        );
  } else {
    reply(entry.socket, message);
  }
});

process.stdin.on('data', chunk => {
  try {
    consume(chunk);
  } catch (error) {
    void stop(error);
  }
});
process.stdin.on('end', () => void stop());
process.stdin.on('error', error => void stop(error));
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.stdout.on('error', () => void stop());
