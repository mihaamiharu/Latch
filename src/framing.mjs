import os from 'node:os';
const MAX = 1024 * 1024;
const little = os.endianness() === 'LE';
export function encode(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > MAX) throw new Error('Native message size out of bounds.');
  const header = Buffer.alloc(4);
  little ? header.writeUInt32LE(body.length) : header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function decoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = little ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (!size || size > MAX) throw new Error('Native message size out of bounds.');
      if (buffer.length < size + 4) return;
      const body = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      onMessage(JSON.parse(body.toString('utf8')));
    }
  };
}
