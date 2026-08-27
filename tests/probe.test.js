/**
 * The remux probe.
 *
 * There is no ffmpeg in this environment, so the real decoder cannot run here.
 * Everything around it can, and that is where the logic lives: which segment
 * gets picked out of a growing playlist, whether its declared length is read
 * from the right EXTINF, whether fragmented output gets its init segment
 * stitched on first, and whether the ratio ends up pointing the right way.
 *
 * probeOutput is lifted out of server.js by name and evaluated here rather
 * than copied, so this tests the shipped source and cannot drift from it. A
 * stand-in ffprobe on PATH reports a duration this test chooses, which is what
 * lets a doctored playlist be told from an honest one.
 */
const fs = require('fs');
const PATHS = require('./paths.js');
const path = require('path');
const { spawn } = require('child_process');

const SRC = PATHS.SERVER;
const WORK = path.join(__dirname, 'probework');
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

// --- lift probeOutput out of the real server source ----------------------
const source = fs.readFileSync(SRC, 'utf8');
const start = source.indexOf('function probeOutput(session) {');
if (start < 0) { console.log('  FAIL probeOutput not found in server.js'); process.exit(1); }
let depth = 0;
let end = start;
for (let i = source.indexOf('{', start); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const probeOutput = new Function('fs', 'path', 'spawn',
  `${source.slice(start, end)}; return probeOutput;`)(fs, path, spawn);

// --- a stand-in ffprobe --------------------------------------------------
function installFakeProbe(realSeconds, {
  baseTime = 0, vStart = 0, aStart = 0, vDur = null, aDur = null,
  // Per-segment answers, keyed by the segment number in the filename. Drift is
  // a change between two segments, so a fake that says the same thing about
  // every one of them cannot express it.
  bySeg = null,
} = {}) {
  const bin = path.join(WORK, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // Models a real fragment: `duration` is the moment it ENDS on the
  // presentation timeline, `start_time` is where it begins. Taking duration at
  // face value is exactly the bug this fake exists to catch.
  // Written as a shell case over the segment number when per-segment answers
  // were asked for, so the same binary can describe an opening segment and a
  // later one differently.
  const answer = (o) => `{"streams":[`
    + `{"codec_type":"video","codec_name":"h264","avg_frame_rate":"24/1","r_frame_rate":"24/1",`
    + `"time_base":"1/90000","start_time":"${o.vStart}"`
    + (o.vDur === null ? '' : `,"duration":"${o.vDur}"`) + `},`
    + `{"codec_type":"audio","codec_name":"aac","profile":"HE-AAC","sample_rate":"48000",`
    + `"channels":2,"time_base":"1/48000","start_time":"${o.aStart}"`
    + (o.aDur === null ? '' : `,"duration":"${o.aDur}"`) + `}],`
    + `"format":{"duration":"${o.baseTime + o.realSeconds}","start_time":"${o.baseTime}"}}`;

  const base = { baseTime, vStart, aStart, vDur, aDur, realSeconds };
  const branches = bySeg
    ? Object.entries(bySeg).map(([seg, over]) =>
      `  *seg${String(seg).padStart(5, '0')}*|*probe-first*)
    cat <<'JSON'
${answer({ ...base, ...over })}
JSON
    ;;`)
    : [];
  // The stitched temp file loses the segment number, so the caller's label —
  // probe-first / probe-recent — is what the branches above match on instead.
  const named = bySeg
    ? Object.entries(bySeg).map(([seg, over]) =>
      `  *probe-${seg === 'first' ? 'first' : 'recent'}*)
    cat <<'JSON'
${answer({ ...base, ...over })}
JSON
    ;;`)
    : [];

  fs.writeFileSync(path.join(bin, 'ffprobe'), `#!/bin/sh
for a in "$@"; do target="$a"; done
echo "$target" >> ${WORK}/probed.log
echo "$target" > ${WORK}/last-probed.txt
wc -c < "$target" > ${WORK}/last-size.txt 2>/dev/null || echo 0 > ${WORK}/last-size.txt
case "$target" in
${named.join('\n')}
  *)
    cat <<'JSON'
${answer(base)}
JSON
    ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

function makeSession(id, { count, extinf, fmp4 = false }) {
  const dir = path.join(WORK, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ext = fmp4 ? 'm4s' : 'ts';
  let text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n';
  if (fmp4) {
    text += '#EXT-X-MAP:URI="init.mp4"\n';
    fs.writeFileSync(path.join(dir, 'init.mp4'), Buffer.alloc(1000, 1));
  }
  for (let i = 0; i < count; i += 1) {
    const name = `seg${String(i).padStart(5, '0')}.${ext}`;
    text += `#EXTINF:${extinf.toFixed(6)},\n${name}\n`;
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(500, i));
  }
  fs.writeFileSync(path.join(dir, 'index.m3u8'), text);
  return { id, dir };
}

const probedSize = () => Number(fs.readFileSync(path.join(WORK, 'last-size.txt'), 'utf8').trim());
/** Everything ffprobe was pointed at since the last reset. */
const probedLog = () => {
  try { return fs.readFileSync(path.join(WORK, 'probed.log'), 'utf8').trim().split('\n'); }
  catch { return []; }
};
const resetLog = () => fs.rmSync(path.join(WORK, 'probed.log'), { force: true });

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  installFakeProbe(6.0);   // every segment really holds 6 seconds

  // --- an honest playlist ------------------------------------------------
  resetLog();
  let r = await probeOutput(makeSession('honest', { count: 5, extinf: 6 }));
  console.log('  honest:', JSON.stringify(r));
  check('an honest playlist rates 1.00', Math.abs(r.segment.ratio - 1) < 0.001,
    String(r.segment?.ratio));
  check('the whole playlist length is reported', Math.abs(r.declaredTotal - 30) < 0.001,
    String(r.declaredTotal));
  // Two segments get probed now — the first for the stream offsets, a recent
  // one for the timeline — and they run concurrently, so the question is what
  // was opened, not what finished last.
  const opened = probedLog().join(' ');
  check('it skips the newest segment, which is still being written',
    opened.includes('seg00003.ts') && !opened.includes('seg00004.ts'), opened);
  check('and reads the stream offsets from the very first segment',
    opened.includes('seg00000.ts'), opened);
  check('codecs come through', r.video.codec === 'h264' && r.audio.sampleRate === 48000,
    JSON.stringify(r));
  // The one datum that tells an octave-down decode from a healthy one.
  check('the audio profile comes through', r.audio.profile === 'HE-AAC',
    JSON.stringify(r.audio));

  // --- the failure this exists to catch ----------------------------------
  r = await probeOutput(makeSession('stretched', { count: 5, extinf: 60 }));
  console.log('  stretched:', JSON.stringify(r.segment));
  check('a playlist claiming ten times the content rates 10.00',
    Math.abs(r.segment.ratio - 10) < 0.01, String(r.segment?.ratio));

  // ...and the opposite direction, content outrunning the timeline.
  r = await probeOutput(makeSession('squashed', { count: 5, extinf: 0.6 }));
  check('a playlist claiming a tenth of the content rates 0.10',
    Math.abs(r.segment.ratio - 0.1) < 0.01, String(r.segment?.ratio));

  // --- fragmented output needs its init segment --------------------------
  r = await probeOutput(makeSession('fragmented', { count: 5, extinf: 6, fmp4: true }));
  console.log('  fragmented:', JSON.stringify(r.segment));
  check('a fragmented segment is stitched onto its init segment first',
    probedSize() === 1500, `probed ${probedSize()} bytes`);
  check('and still rates 1.00', Math.abs(r.segment.ratio - 1) < 0.001, String(r.segment?.ratio));
  check('the stitched temp file is cleaned up',
    !fs.existsSync(path.join(WORK, 'fragmented', 'probe-tmp.mp4')));

  // --- degenerate inputs -------------------------------------------------
  resetLog();
  r = await probeOutput(makeSession('single', { count: 1, extinf: 6 }));
  check('with only one segment it probes that one rather than nothing',
    probedLog().join(' ').includes('seg00000.ts') && Math.abs(r.segment.ratio - 1) < 0.001,
    `${probedLog().join(' ')} ${JSON.stringify(r.segment)}`);

  r = await probeOutput(makeSession('empty', { count: 0, extinf: 6 }));
  check('an empty playlist says so instead of dividing by nothing',
    /nothing written/.test(r.error || ''), JSON.stringify(r));

  r = await probeOutput({ id: 'gone', dir: path.join(WORK, 'does-not-exist') });
  check('a missing playlist is reported, not thrown', Boolean(r.error), JSON.stringify(r));


  // --- the bug that cried wolf -------------------------------------------
  // A fragment's timeline starts at its own base decode time, so ffprobe's
  // `duration` for one is the moment it ENDS. Reading that as its length made
  // a healthy 6s segment 180s long and rated every conversion 0.03.
  installFakeProbe(6.0, { baseTime: 174.0 });
  r = await probeOutput(makeSession('deepintofilm', { count: 5, extinf: 6, fmp4: true }));
  console.log('  174s into the session:', JSON.stringify(r.segment));
  check('a fragment far into the session still rates 1.00',
    Math.abs(r.segment.ratio - 1) < 0.001, String(r.segment?.ratio));
  check('and reports its length, not its end time',
    Math.abs(r.segment.real - 6) < 0.001, String(r.segment?.real));

  // --- the audio/video start offset --------------------------------------
  installFakeProbe(6.0, { baseTime: 0, vStart: 0, aStart: 0.9 });
  r = await probeOutput(makeSession('offset', { count: 5, extinf: 6, fmp4: true }));
  console.log('  offset:', JSON.stringify(r.start));
  check('an audio track starting late is measured',
    Math.abs(r.start.sync - 0.9) < 0.001, JSON.stringify(r.start));
  check('the offset is read from the FIRST segment, not a recent one',
    r.start.segment === 'seg00000.m4s', JSON.stringify(r.start));

  installFakeProbe(6.0, { baseTime: 0, vStart: 0, aStart: 0 });
  r = await probeOutput(makeSession('aligned', { count: 5, extinf: 6, fmp4: true }));
  check('aligned streams report no offset', r.start.sync === 0, JSON.stringify(r.start));

  // Both temp files have to go, not just the one.
  check('neither stitched temp file is left behind',
    !fs.existsSync(path.join(WORK, 'aligned', 'probe-recent.mp4'))
      && !fs.existsSync(path.join(WORK, 'aligned', 'probe-first.mp4')),
    fs.readdirSync(path.join(WORK, 'aligned')).join(' '));

  // --- drift, as opposed to a gap that is simply there ---------------------
  //
  // Some gap at the end of a segment is normal: the muxer cuts on a video
  // keyframe and the audio frames do not land on that instant. Drift is the
  // gap CHANGING. Telling those apart takes two measurements, and getting it
  // wrong the other way is what the first version of this did — it divided one
  // segment's gap by how long the session had been running and reported a
  // standing 5-second gap as 95ms per second of runaway.
  console.log('\n  drift, told apart from a standing gap');

  // The shape of a real report: a large gap, identical at both ends.
  installFakeProbe(6.0, {
    bySeg: {
      first: { baseTime: 0, vStart: 0, aStart: 0, vDur: 6.652, aDur: 1.537 },
      recent: { baseTime: 47.3, vStart: 47.3, aStart: 47.3, vDur: 6.652, aDur: 1.537 },
    },
  });
  r = await probeOutput(makeSession('standing', { count: 5, extinf: 6, fmp4: true }));
  console.log('  standing gap:', JSON.stringify(r.drift));
  check('the gap itself is reported',
    Math.abs(r.drift.gap + 5.115) < 0.01, String(r.drift?.gap));
  check('and so is the same gap at the opening, which is what gives it meaning',
    Math.abs(r.drift.firstGap + 5.115) < 0.01, String(r.drift?.firstGap));
  check('a gap that is not growing is not drift',
    Math.abs(r.drift.rate) < 0.001, String(r.drift?.rate));

  // A gap that really is opening up.
  installFakeProbe(6.0, {
    bySeg: {
      first: { baseTime: 0, vStart: 0, aStart: 0, vDur: 6.0, aDur: 5.9 },
      recent: { baseTime: 50, vStart: 50, aStart: 50, vDur: 6.0, aDur: 4.9 },
    },
  });
  r = await probeOutput(makeSession('drifting', { count: 5, extinf: 6, fmp4: true }));
  console.log('  drifting:', JSON.stringify(r.drift));
  // -0.1 at 6.0s, -1.1 at 56.0s: one second lost across fifty.
  check('a gap that opens up is', Math.abs(r.drift.rate + 0.02) < 0.001,
    String(r.drift?.rate));
  check('and the span it was measured over is said out loud',
    Math.abs(r.drift.span - 50) < 0.01, String(r.drift?.span));
  check('which reads as 2% — the figure that matters',
    `${(r.drift.rate * 100).toFixed(1)}%` === '-2.0%', `${(r.drift.rate * 100).toFixed(1)}%`);

  // Two segments close together turn a few milliseconds of noise into a
  // percentage, so a short span is refused rather than divided by.
  installFakeProbe(6.0, {
    bySeg: {
      first: { baseTime: 0, vStart: 0, aStart: 0, vDur: 6.0, aDur: 5.99 },
      recent: { baseTime: 2, vStart: 2, aStart: 2, vDur: 6.0, aDur: 5.9 },
    },
  });
  r = await probeOutput(makeSession('tooclose', { count: 5, extinf: 6, fmp4: true }));
  check('too small a span reports no rate rather than a wild one',
    r.drift.rate === null, JSON.stringify(r.drift));

  // Nothing to divide by, and nothing to divide.
  installFakeProbe(6.0, { baseTime: 0, vStart: 0, aStart: 0 });
  r = await probeOutput(makeSession('nodurations', { count: 5, extinf: 6, fmp4: true }));
  check('a probe without stream durations reports no rate rather than zero',
    r.drift.rate === null, JSON.stringify(r.drift));

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
