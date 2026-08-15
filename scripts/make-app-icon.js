#!/usr/bin/env node
/*
 * Build the home-screen icon from the bison.
 *
 *   node scripts/make-app-icon.js
 *
 * Writes public/app-icon.png (180x180, opaque, the bison centered on the
 * app's own background) plus two byte-identical copies at the bare paths
 * iPadOS asks for on its own: apple-touch-icon.png and
 * apple-touch-icon-precomposed.png.
 *
 * This file exists because the raw logo was the icon for a while, and the
 * iPad said no. public/bison.png is 219x148 with a transparent background —
 * an iPhone quietly pads and fills it, but iPadOS renders a non-square,
 * transparent touch icon as a blank white tile. What iOS actually wants is
 * boring: square, opaque, 180x180. So the logo stays the logo, and the icon
 * is manufactured from it — by this script, so the two cannot drift apart
 * without it being one command to fix.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SIZE = 180;
// --bg from styles.css: the room the app itself sits in.
const BG = [0x15, 0x10, 0x0f];
// Breathing room, so the rounded-corner mask iOS applies never clips the mark.
const PAD = 0.16;

/* ---- PNG in ---- */

function readPng(file) {
  const data = fs.readFileSync(file);
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error(`${file} is not a PNG`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const chunk = data.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || chunk[9] !== 6) {
        throw new Error('expected 8-bit RGBA — re-export the logo that way');
      }
    } else if (type === 'IDAT') {
      idat.push(chunk);
    }
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 4 ? line[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(px, y * stride);
    prev = line;
  }
  return { width, height, px };
}

/* ---- PNG out ---- */

function writePng(file, size, rgba) {
  const chunk = (type, payload) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* ---- the icon ---- */

const src = readPng(path.join(ROOT, 'public/bison.png'));

const avail = SIZE * (1 - 2 * PAD);
const scale = Math.min(avail / src.width, avail / src.height);
const dw = src.width * scale;
const dh = src.height * scale;
const ox = (SIZE - dw) / 2;
const oy = (SIZE - dh) / 2;

// Bilinear sample of the source at fractional coordinates.
const sample = (x, y) => {
  const cx = Math.min(Math.max(x, 0), src.width - 1.001);
  const cy = Math.min(Math.max(y, 0), src.height - 1.001);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) {
    const p00 = src.px[(y0 * src.width + x0) * 4 + c];
    const p10 = src.px[(y0 * src.width + x0 + 1) * 4 + c];
    const p01 = src.px[((y0 + 1) * src.width + x0) * 4 + c];
    const p11 = src.px[((y0 + 1) * src.width + x0 + 1) * 4 + c];
    const top = p00 + (p10 - p00) * fx;
    const bot = p01 + (p11 - p01) * fx;
    out[c] = top + (bot - top) * fy;
  }
  return out;
};

const icon = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const i = (y * SIZE + x) * 4;
    let [r, g, b] = BG;
    if (x >= ox && x < ox + dw && y >= oy && y < oy + dh) {
      const [sr, sg, sb, sa] = sample((x - ox) / scale, (y - oy) / scale);
      const a = sa / 255;
      r = Math.round(sr * a + BG[0] * (1 - a));
      g = Math.round(sg * a + BG[1] * (1 - a));
      b = Math.round(sb * a + BG[2] * (1 - a));
    }
    icon[i] = r;
    icon[i + 1] = g;
    icon[i + 2] = b;
    icon[i + 3] = 255; // opaque everywhere — the whole point
  }
}

for (const name of ['app-icon.png', 'apple-touch-icon.png', 'apple-touch-icon-precomposed.png']) {
  writePng(path.join(ROOT, 'public', name), SIZE, icon);
}
console.log(`app-icon: ${SIZE}x${SIZE} opaque, bison ${Math.round(dw)}x${Math.round(dh)} centered`);
