import net from 'node:net';
import crypto from 'node:crypto';
import {socketPath, socketError} from './local.mjs';
import {fault} from '../extension/protocol.js';

export async function nativeChannel(profile, metadata) {
  const address = socketPath(profile.instanceId), socket = net.createConnection(address);
  let pending, buffer = '', nonce, ended = false;
  const abort = error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; } };
  socket.on('error', e => abort(socketError(e, address)));
  socket.on('close', () => abort(fault('BRIDGE_DISCONNECTED', 'Native operation ended; its outcome may be unknown. Inspect before retrying.')));
  socket.setTimeout(65000, () => { abort(fault('OPERATION_FENCED', 'Native operation expired.')); socket.destroy(); });
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { abort(fault('MESSAGE_TOO_LARGE', 'Recovery response exceeded its bound.')); socket.destroy(); return; }
    while (buffer.includes('\n')) {
      const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1);
      try {
        const value = JSON.parse(line);
        if (!pending || value.id !== pending.id || value.v !== 1) throw fault('INVALID_RESPONSE', 'Invalid recovery response.');
        const current = pending; pending = undefined; clearTimeout(current.timer);
        value.ok ? current.resolve(value.result) : current.reject(fault(value.error?.code || 'BRIDGE_ERROR', value.error?.message || 'Recovery operation failed.'));
      } catch(e) { abort(e); socket.destroy(); }
    }
  });
  const send = (action, params = {}) => new Promise((resolve,reject) => {
    if (ended || socket.destroyed || pending) return reject(fault('OPERATION_FENCED', 'Recovery channel is unavailable or busy.'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { abort(fault('BRIDGE_TIMEOUT', 'Recovery operation timed out; outcome unknown.')); socket.destroy(); }, 35000);
    pending = {id, timer, resolve, reject};
    socket.write(JSON.stringify({v: 1, id, op: 'native-operation', payload: {instanceId: profile.instanceId, epoch: profile.epoch, hostGeneration: profile.hostGeneration, ...metadata, action, nonce, ...params}}) + '\n');
  });
  try { nonce = (await send('begin')).nonce; }
  catch(e) { socket.destroy(); throw e; }
  return {send, async close() { if (ended) return; try { await send('end'); } finally { ended = true; socket.destroy(); } }, abort() { ended = true; socket.destroy(); }};
}
