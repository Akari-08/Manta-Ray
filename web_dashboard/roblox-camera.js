'use strict';
// Fixed-size raw RGBA frames arrive from the simulated Roblox raycaster.
// PNG encoding uses only Node's built-in zlib; no camera data is persisted.
const { deflateSync } = require('node:zlib');
const WIDTH = 128, HEIGHT = 72, BYTES = WIDTH * HEIGHT * 4;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, name, data, checksum]);
}
function encodeFrame(pixels) {
  if (!Buffer.isBuffer(pixels) || pixels.length !== BYTES) throw new Error('Expected exactly 128x72 RGBA pixels');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  const scanlines = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
  for (let y = 0; y < HEIGHT; y++) pixels.copy(scanlines, y * (1 + WIDTH * 4) + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = { WIDTH, HEIGHT, BYTES, encodeFrame };
