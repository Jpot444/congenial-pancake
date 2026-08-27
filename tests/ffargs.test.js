/**
 * The ffmpeg arguments themselves.
 *
 * No ffmpeg here to run them against, so the next best thing is to assert on
 * the command actually built — lifted out of server.js by name so it cannot
 * drift from what ships. The claim under test is narrow and checkable: audio
 * is never copied, and it always comes out as stereo AAC-LC at a fixed rate,
 * whatever the source was.
 */
const fs = require('fs');
const PATHS = require('./paths.js');
const path = require('path');

const SRC = PATHS.SERVER;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const source = fs.readFileSync(SRC, 'utf8');
function lift(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  return source.slice(start, end);
}
// ffmpegArgs calls audioFilter, so both come across — a stub for the filter
// would let the real chain drift out from under these checks.
const ffmpegArgs = new Function('path', 'UA',
  `${lift('audioFilter')}; ${lift('ffmpegArgs')}; return ffmpegArgs;`)(path, 'test-agent');

const pairs = (args) => {
  const out = {};
  args.forEach((a, i) => { if (a.startsWith('-')) out[a] = args[i + 1]; });
  return out;
};
const after = (args, flag) => args[args.indexOf(flag) + 1];

// Every shape the provider throws at it: H.264 and HEVC, cold and seeked,
// remote and from local disk.
for (const [label, args] of [
  ['h264 from the provider', ffmpegArgs('http://p/x.mkv', '/out', 'h264', 0)],
  ['h264 seeked', ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1323)],
  ['hevc from the provider', ffmpegArgs('http://p/x.mkv', '/out', 'hevc', 0)],
  ['from a local file', ffmpegArgs('/downloads/x.mkv', '/out', 'h264', 0)],
]) {
  console.log(`\n  ${label}`);
  const p = pairs(args);
  check('audio is never copied', p['-c:a'] === 'aac', `-c:a ${p['-c:a']}`);
  check('the profile is pinned to AAC-LC', p['-profile:a'] === 'aac_low',
    String(p['-profile:a']));
  check('the sample rate is pinned to 48kHz', p['-ar'] === '48000', String(p['-ar']));
  check('it comes out stereo', p['-ac'] === '2', String(p['-ac']));
  // The seek fix: pad the audio so it starts where the video does.
  check('the audio is padded to start with the video',
    /first_pts=0/.test(String(p['-af'])), String(p['-af']));
  // async=1 turns filling and trimming ON and leaves the tempo alone. Any
  // value above 1 licenses stretching by that many samples a second, which is
  // a tempo change a remux must never make.
  check('gap filling is armed',
    /\basync=1(?![\d.])/.test(String(p['-af'])), String(p['-af']));
  check('and stretching is not licensed',
    !/async=(?!1(?![\d.]))[\d.]+/.test(String(p['-af'])), String(p['-af']));
  check('the hard/soft threshold is stated rather than defaulted',
    /min_hard_comp=0\.100/.test(String(p['-af'])), String(p['-af']));
  check('no manual offset unless one was asked for',
    !/adelay|atrim/.test(String(p['-af'])), String(p['-af']));
  check('video is still copied, never re-encoded', p['-c:v'] === 'copy', String(p['-c:v']));
  check('no stray copy of the audio anywhere in the command',
    !args.some((a, i) => a === '-c:a' && args[i + 1] === 'copy'), args.join(' '));
}

// -ss has to stay ahead of -i or the seek decodes from the top of the film.
console.log('\n  seeking');
const seeked = ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1323);
const cold = ffmpegArgs('http://p/x.mkv', '/out', 'h264', 0);
check('  -ss is placed before -i', seeked.indexOf('-ss') < seeked.indexOf('-i'),
  seeked.join(' '));
check('  and carries the requested offset', after(seeked, '-ss') === '1323',
  after(seeked, '-ss'));
check('  a cold start passes no -ss at all', !cold.includes('-ss'));

// Accurate seeking trims the audio to the mark but cannot trim a copied video
// stream, which is what left the two starting 1184ms apart.
check('  a seek turns accurate seeking off, so both streams keep their head',
  seeked.includes('-noaccurate_seek'), seeked.join(' '));
check('  and it is an input option, ahead of -i',
  seeked.indexOf('-noaccurate_seek') < seeked.indexOf('-i'), seeked.join(' '));
check('  a cold start does not need it', !cold.includes('-noaccurate_seek'));
check('  timestamps are still rebased to zero',
  after(seeked, '-avoid_negative_ts') === 'make_zero',
  String(after(seeked, '-avoid_negative_ts')));

// Everything is fMP4 now, so hls.js never has to rebuild a transport stream.
const hevc = ffmpegArgs('http://p/x.mkv', '/out', 'hevc', 0);
const h264 = ffmpegArgs('http://p/x.mkv', '/out', 'h264', 0);
check('  HEVC is tagged hvc1', after(hevc, '-tag:v') === 'hvc1');
check('  H.264 is not tagged hvc1', !h264.includes('-tag:v'));
for (const [label, args] of [['HEVC', hevc], ['H.264', h264]]) {
  check(`  ${label} is packaged as fragmented MP4`,
    after(args, '-hls_segment_type') === 'fmp4', String(after(args, '-hls_segment_type')));
  check(`  ${label} segments are .m4s`,
    after(args, '-hls_segment_filename').endsWith('.m4s'),
    after(args, '-hls_segment_filename'));
  check(`  ${label} names an init segment`,
    after(args, '-hls_fmp4_init_filename') === 'init.mp4',
    String(after(args, '-hls_fmp4_init_filename')));
  check(`  ${label} writes no transport-stream segments`,
    !args.some((a) => String(a).endsWith('.ts')), args.join(' '));
}

// Reconnect flags only make sense against a URL.
check('  a local file gets no reconnect flags',
  !ffmpegArgs('/downloads/x.mkv', '/out', 'h264', 0).includes('-reconnect'));
check('  a provider URL does', ffmpegArgs('http://p/x.mkv', '/out', 'h264', 0).includes('-reconnect'));


// The manual offset has to survive the whole argument build, not just the
// filter helper it comes from.
console.log('\n  manual audio offset');
const nudged = pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1323, -250));
check('  a negative offset reaches the command',
  /atrim=start=0\.250/.test(String(nudged['-af'])), String(nudged['-af']));
check('  and does not disturb the video copy', nudged['-c:v'] === 'copy');
const pushed = pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 0, 400));
check('  a positive offset reaches the command',
  /adelay=400:all=1/.test(String(pushed['-af'])), String(pushed['-af']));


// The automatic alignment pass: a measured gap becomes silence on the front.
console.log('\n  automatic alignment');
const plain = pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1028, 0, 0));
check('  no pad means the track starts where it was handed over',
  /first_pts=0/.test(String(plain['-af'])), String(plain['-af']));
const padded = pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1028, 0, 2.913));
console.log('   ', padded['-af']);
check('  a measured gap becomes a negative first_pts in samples',
  /first_pts=-139824\b/.test(String(padded['-af'])), String(padded['-af']));
check('  padding does not disturb the gap filling',
  /\basync=1(?![\d.])/.test(String(padded['-af'])), String(padded['-af']));
check('  padding and a manual offset coexist',
  /first_pts=-48000/.test(String(pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1, 250, 1))['-af']))
    && /adelay=250/.test(String(pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1, 250, 1))['-af'])),
  String(pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1, 250, 1))['-af']));
check('  a negative pad is ignored rather than trimming the head off',
  /first_pts=0/.test(String(pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1, 0, -5))['-af'])),
  String(pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1, 0, -5))['-af']));
check('  an absurd pad is clamped',
  /first_pts=-1440000\b/.test(String(pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1, 0, 900))['-af'])),
  String(pairs(ffmpegArgs('http://p/x.mkv', '/out', 'h264', 1, 0, 900))['-af']));

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
