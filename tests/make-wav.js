// A 120-second 8kHz mono WAV. Chromium plays it in a <video> element, which is
// all the watchdog needs: currentTime advances, readyState/buffered are real.
const fs = require('fs');
const rate = 8000, secs = 120;
const n = rate * secs;
const data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i += 1) {
  data.writeInt16LE(Math.round(Math.sin(i / 20) * 3000), i * 2);
}
const head = Buffer.alloc(44);
head.write('RIFF', 0);
head.writeUInt32LE(36 + data.length, 4);
head.write('WAVE', 8);
head.write('fmt ', 12);
head.writeUInt32LE(16, 16);
head.writeUInt16LE(1, 20);
head.writeUInt16LE(1, 22);
head.writeUInt32LE(rate, 24);
head.writeUInt32LE(rate * 2, 28);
head.writeUInt16LE(2, 32);
head.writeUInt16LE(16, 34);
head.write('data', 36);
head.writeUInt32LE(data.length, 40);
fs.writeFileSync(process.argv[2], Buffer.concat([head, data]));
console.log('wrote', process.argv[2], head.length + data.length, 'bytes');
