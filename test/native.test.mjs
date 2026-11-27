import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {encode, decoder} from '../src/framing.mjs';
import {request, socketPath} from '../src/local.mjs';

test('default runtime location fits the platform Unix socket limit', () => {
  assert.ok(Buffer.byteLength(socketPath(crypto.randomUUID())) <= 100);
});

test('native decoder handles fragmented/multiple frames and rejects oversized input', () => {
  const messages = []; const read = decoder(message => messages.push(message));
  const wire = Buffer.concat([encode({id: 'a', value: '☕'}), encode({id: 'b'})]);
  for (const byte of wire) read(Buffer.from([byte]));
  assert.deepEqual(messages, [{id: 'a', value: '☕'}, {id: 'b'}]);
  assert.throws(() => decoder(() => {})(Buffer.from([255, 255, 255, 127])), /bounds/);
});

test('native host routes real socket requests, restricts permissions and cleans up on disconnect', async t => {
  const work = fileURLToPath(new URL('../work/browser-bridge/', import.meta.url));
  await fs.mkdir(work, {recursive: true});
  const root = await fs.mkdtemp(path.join(work, 'native-'));
  const instanceId = crypto.randomUUID(), epoch = crypto.randomUUID();
  // macOS Unix sockets have a small path limit; keep only the socket directory in /tmp on darwin.
  const runtime = path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `latch-test-${crypto.randomBytes(5).toString('hex')}`);
  const oldRoot = process.env.LATCH_RUNTIME_DIR;
  process.env.LATCH_RUNTIME_DIR = runtime;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/native-host.mjs', import.meta.url))], {
    env: {...process.env}, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', data => errors += data);
  const consume = decoder(message => child.stdin.write(encode({v: 1, id: message.id, ok: true, result: {operation: message.op, echo: message.payload.value}})));
  child.stdout.on('data', consume);
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    if (oldRoot === undefined) delete process.env.LATCH_RUNTIME_DIR; else process.env.LATCH_RUNTIME_DIR = oldRoot;
    await fs.rm(runtime, {recursive: true, force: true});
    await fs.rm(root, {recursive: true, force: true});
  });
  const handshake = encode({v: 1, type: 'hello', instanceId, epoch, extensionVersion: '0.1.0'});
  child.stdin.write(handshake.subarray(0, 3)); child.stdin.write(handshake.subarray(3));
  const address = socketPath(instanceId);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { try { await fs.stat(address); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(runtime)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(address)).mode & 0o777, 0o600);
  }
  assert.equal((await request(instanceId, 'status')).instanceId, instanceId);
  assert.deepEqual(await request(instanceId, 'tabs', {instanceId, epoch, value: 42}), {operation: 'tabs', echo: 42});
  child.stdin.end();
  assert.equal(await exited, 0, errors);
  await assert.rejects(fs.stat(address), {code: 'ENOENT'});
});
