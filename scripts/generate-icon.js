#!/usr/bin/env node
'use strict';

// Pure-Node PNG generation keeps the checked-in source text-only while giving
// electron-builder a full-size Windows icon derived from the app's three-layer mark.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

function color(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

function setPixel(x, y, rgba) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const at = (y * SIZE + x) * 4;
  pixels.set(rgba, at);
}

function roundedRect(x, y, w, h, radius, fill, stroke, dashed = false) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const cx = Math.max(x + radius, Math.min(px, x + w - radius - 1));
      const cy = Math.max(y + radius, Math.min(py, y + h - radius - 1));
      if ((px - cx) ** 2 + (py - cy) ** 2 > radius ** 2) continue;
      const edge = px < x + 6 || px >= x + w - 6 || py < y + 6 || py >= y + h - 6;
      if (edge && (!dashed || (Math.floor((px + py) / 10) % 2 === 0))) setPixel(px, py, stroke);
      else setPixel(px, py, fill);
    }
  }
}

const background = color('#f5f4ef');
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) setPixel(x, y, background);
roundedRect(22, 78, 128, 104, 20, color('#ffffff'), color('#262d2b'));
roundedRect(100, 34, 128, 104, 20, color('#dfeeed'), color('#2d7773'), true);
roundedRect(64, 120, 128, 104, 20, color('#e5efe4'), color('#486a49'));

const mark = color('#2d7773');
for (let y = 148; y < 166; y++) {
  for (let x = 92; x < 110; x++) if ((x - 101) ** 2 + (y - 157) ** 2 <= 81) setPixel(x, y, mark);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0;
  pixels.copy(raw, row + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const output = path.resolve(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, png);
console.log(`[desktop] icon: ${output}`);
