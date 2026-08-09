// Pull the white bison mark off the red logo plate and write it out as a
// transparent PNG. Pure Node: zlib is all that's needed to read/write PNG.
const fs = require('fs');
const zlib = require('zlib');

/* ------------------------------------------------------------- decoding */

function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8; // skip signature
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`unexpected bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters.
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      const x = line[i];
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/* ------------------------------------------------------------- encoding */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writeRgbaPng(file, width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

/* ---------------------------------------------------------------- main */

const [, , input, output, cropFracArg] = process.argv;
const cropFrac = Number(cropFracArg || 0.42);

const src = readPng(input);
const { width: W, height: H, channels: C, data } = src;
console.log(`source ${W}x${H}, ${C} channels`);

// The plate is flat red behind a white mark. Green separates them best:
// red plate sits near G=31, the mark at G=255. Use that ramp as the alpha so
// antialiased edges stay smooth instead of going jagged.
const alphaAt = (x, y) => {
  const i = (y * W + x) * C;
  const g = data[i + 1];
  return Math.max(0, Math.min(255, Math.round(((g - 40) / (255 - 40)) * 255)));
};

// The emblem lives left of the vertical rule; the wordmark is to its right.
const limitX = Math.floor(W * cropFrac);
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < limitX; x++) {
    if (alphaAt(x, y) > 24) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

const pad = 4;
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
const cw = maxX - minX + 1;
const ch = maxY - minY + 1;
console.log(`emblem bounds x:${minX}-${maxX} y:${minY}-${maxY}  → ${cw}x${ch}`);

const rgba = Buffer.alloc(cw * ch * 4);
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const a = alphaAt(minX + x, minY + y);
    const o = (y * cw + x) * 4;
    rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = a;
  }
}

writeRgbaPng(output, cw, ch, rgba);
console.log(`wrote ${output} (${(fs.statSync(output).size / 1024).toFixed(1)} KB)`);
