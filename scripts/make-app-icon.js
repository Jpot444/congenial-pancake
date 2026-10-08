#!/usr/bin/env node
/*
 * Build the home-screen icon from the bison.
 *
 *   node scripts/make-app-icon.js
 *
 * First paints public/bison.png in the brand red (BULL below), in place:
 * every pixel's colour is replaced and its transparency kept, so running it
 * twice changes nothing, and a white silhouette fresh from extract-bison.js
 * comes out red. Change BULL and run this to recolour the logo everywhere.
 *
 * Then writes public/app-icon.png (180x180, opaque, the bison centered on the
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
// Black — "the background should be black". The Netflix tile is black too.
const BG = [0x00, 0x00, 0x00];
// --brand-red from styles.css. The bull is drawn in it everywhere it appears —
// header, loading screen, profile screen, favicon and this icon.
const BULL = [0xe5, 0x09, 0x14];
// Breathing room, so the rounded-corner mask iOS applies never clips the mark.
// 0.09: big — it was 0.16, two thirds of the width, "isn't at full scale" —
// but with the tail and the grass well clear of the corner curve, which on a
// wide mark like this is where a tighter crop starts to lose them.
const PAD = 0.09;

/* ---- PNG in ---- */

function readPng(file) {
  const data = fs.readFileSync(file);
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error(`${file} is not a PNG`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const chunk = data.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || (chunk[9] !== 6 && chunk[9] !== 2)) {
        throw new Error('expected 8-bit RGBA or RGB — re-export the logo that way');
      }
      channels = chunk[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(chunk);
    }
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
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
    // Always handed back as RGBA, an RGB file reading as fully opaque.
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      px[o] = line[x * bpp];
      px[o + 1] = line[x * bpp + 1];
      px[o + 2] = line[x * bpp + 2];
      px[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, px, channels };
}

/* ---- PNG out ---- */

function writePng(file, size, rgba, height = size, { rgb = false } = {}) {
  const chunk = (type, payload) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const bpp = rgb ? 3 : 4;
  const stride = size * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = y * (stride + 1) + 1 + x * bpp;
      for (let c = 0; c < bpp; c += 1) raw[to + c] = rgba[from + c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = rgb ? 2 : 6;  // RGB : RGBA
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* ---- the logo, in the brand red ---- */

const LOGO = path.join(ROOT, 'public/bison.png');
const src = readPng(LOGO);
for (let i = 0; i < src.px.length; i += 4) {
  [src.px[i], src.px[i + 1], src.px[i + 2]] = BULL;   // alpha untouched
}
writePng(LOGO, src.width, src.px, src.height);

/* ---- the icon ---- */

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

/*
 * RGB, with NO alpha channel at all.
 *
 * "Now it's a small black square with the bull in it surrounded by white" —
 * and the box's own record showed iOS fetching this file and being answered
 * 200. Every pixel was opaque, but the FILE was RGBA, and iOS goes by the
 * format: an icon that can be transparent is treated as one, inset and backed
 * with white. A PNG with no alpha channel cannot be, so it is drawn edge to
 * edge.
 */
for (const name of ['app-icon.png', 'apple-touch-icon.png', 'apple-touch-icon-precomposed.png']) {
  writePng(path.join(ROOT, 'public', name), SIZE, icon, SIZE, { rgb: true });
}

/*
 * Where the pages point.
 *
 * "the Red Bull is surrounded by white" — and then, with the icon inlined as a
 * data: URI, "the bull is cut off". Both times the picture was not this icon
 * at all: it was bison.png, the transparent favicon, which iOS falls back to
 * when it cannot use the touch icon — filled to the square (which crops the
 * bull) and backed with white. iOS does not take a data: URI for this, and
 * behind Cloudflare Access its own fetch of a linked touch icon gets the login
 * page. What it CAN always get is the favicon, which the page loads inside its
 * own session.
 *
 * So every icon a page offers is this one: the touch icon and the favicon
 * both point at app-icon.png. Whichever iOS settles on, it is the finished
 * square. appicon.test.js checks the links.
 */
/* With a fingerprint of the picture on the end. iOS caches a home-screen
   icon by its ADDRESS, and can keep the old one even after the shortcut is
   deleted; a new picture at a new address is one it has never seen. The
   Access rule for the icon matches the path, so the query does not affect it. */
const version = require('crypto').createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, 'public', 'app-icon.png'))).digest('hex').slice(0, 10);
const href = `/app-icon.png?v=${version}`;
for (const page of ['public/index.html', 'public/tv/index.html']) {
  const file = path.join(ROOT, page);
  const html = fs.readFileSync(file, 'utf8');
  const next = html
    .replace(/(<link rel="apple-touch-icon" sizes="180x180" href=")[^"]*(" \/>)/, `$1${href}$2`)
    .replace(/(<link rel="icon" type="image\/png" )href="[^"]*"( \/>)/, `$1sizes="180x180" href="${href}"$2`)
    .replace(/(<link rel="icon" type="image\/png" sizes="180x180" )href="[^"]*"( \/>)/, `$1href="${href}"$2`);
  if (next !== html) fs.writeFileSync(file, next);
}
