/**
 * A finished recording opens without being read from end to end.
 *
 * "im trying to play something from dvr but it just says connecting to stream
 *  and wont play" … "it did just start playing but took a long time, i dont
 *  think it was optimized"
 *
 * It was not, and the reason is in the container.
 *
 * A recording is WRITTEN fragmented on purpose —
 * `+frag_keyframe+empty_moov+default_base_moof` — so that a power cut two
 * hours into a game costs the last few seconds rather than the whole
 * programme. That is the right choice for a file that might be cut off, and
 * it stays. Its price is an empty moov: no index, no duration.
 *
 * MEASURED, because this is a claim about what a demuxer can work out from a
 * prefix. On a clip written exactly as the recorder writes one, a demuxer
 * given the first 64KB believes it is 8 seconds long; at 1MB, 33 seconds. It
 * only learns the real length by reading to the END. So opening a three-hour
 * recording meant pulling the entire file before the browser could settle its
 * timeline and start — which from the sofa is a long wait on "Connecting to
 * stream…" and then, eventually, a picture.
 *
 * Remuxed `-c copy -movflags +faststart` the same clip carries an indexed
 * moov at the front and the true duration is known from the first 64KB.
 *
 * ONE PART USED TO BE RENAMED, which is the common case and the slow one, and
 * joined parts were no better — the concat wrote the fragmented flags straight
 * back out. Both go through ffmpeg now.
 *
 * Runs the real binary. The whole finding is about what ffmpeg writes and what
 * a demuxer can read back, and neither can be established by reading code.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

/** The top-level boxes of an mp4, in order, with where each one sits. */
function boxes(file) {
  const d = fs.readFileSync(file);
  const out = [];
  let off = 0;
  while (off + 8 <= d.length && out.length < 12) {
    const size = d.readUInt32BE(off);
    const type = d.toString('latin1', off + 4, off + 8);
    out.push({ type, at: off, size });
    if (size <= 0) break;
    off += size;
  }
  return out;
}

/** What a demuxer makes of the first `bytes` of a file, and nothing more. */
function durationFromPrefix(file, bytes, scratch) {
  const cut = path.join(scratch, `cut-${bytes}-${path.basename(file)}`);
  fs.writeFileSync(cut, fs.readFileSync(file).subarray(0, bytes));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', cut], { encoding: 'utf8' });
  const said = Number(String(probe.stdout || '').trim());
  return Number.isFinite(said) && said > 0 ? said : null;
}

(async () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('  no ffmpeg on this box — skipped');
    process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvropen-'));

  /* ---- what the recorder writes ---------------------------------------- */
  /*
   * The exact flags from recordArgs. Not a paraphrase: the point of the suite
   * is the difference between these and what a finished recording should be,
   * and a paraphrase could be wrong in the direction that hides it.
   */
  console.log('\n  the container a recording is written in');
  const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const recArgs = SERVER.slice(SERVER.indexOf('function recordArgs('),
    SERVER.indexOf('\n}', SERVER.indexOf('function recordArgs(')));
  check('the recorder still writes fragmented, which is what makes a cut-off '
    + 'recording playable',
    /\+frag_keyframe\+empty_moov\+default_base_moof/.test(recArgs),
    'the crash-safe flags have gone from the recorder');

  const frag = path.join(dir, 'frag.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', frag], { encoding: 'utf8' });
  check('a clip is written the way a recording is', made.status === 0 && fs.existsSync(frag),
    (made.stderr || '').slice(0, 200));

  const fragBoxes = boxes(frag);
  const fragMoov = fragBoxes.find((b) => b.type === 'moov');
  console.log('   ', fragBoxes.slice(0, 4).map((b) => `${b.type}@${b.at}/${b.size}`).join(' '));
  /* An empty moov is the whole fault in one number: a few hundred bytes where
     an index would be thousands. */
  check('its moov is the empty kind — no index in it',
    Boolean(fragMoov) && fragMoov.size < 4000, JSON.stringify(fragMoov));

  /* ---- and what that costs a player ----------------------------------- */
  console.log('\n  and what a player can work out from the start of it');
  const fragEarly = durationFromPrefix(frag, 65536, dir);
  const fragMid = durationFromPrefix(frag, 1048576, dir);
  const fragWhole = durationFromPrefix(frag, fs.statSync(frag).size, dir);
  console.log('    64KB ->', fragEarly, ' 1MB ->', fragMid, ' whole ->', fragWhole);
  check('the whole file really is about sixty seconds',
    fragWhole !== null && Math.abs(fragWhole - 60) < 2, String(fragWhole));
  /* The measurement the fix rests on. A player that cannot know the length
     without reading to the end must read to the end. */
  check('but the start of it says something much shorter',
    fragEarly !== null && fragEarly < fragWhole - 10,
    `64KB said ${fragEarly} of ${fragWhole}`);
  check('and a megabyte in it is still wrong',
    fragMid !== null && fragMid < fragWhole - 10,
    `1MB said ${fragMid} of ${fragWhole}`);

  /* ---- what the box does with it when the programme ends -------------- */
  /*
   * The finalise step, with the arguments the box uses — lifted rather than
   * retyped, so a copy cannot pass while the shipped one fails.
   */
  console.log('\n  and the same file once the box has finished it');
  const joinAt = SERVER.indexOf('function joinRecording(');
  const joinSrc = SERVER.slice(joinAt, SERVER.indexOf('\n}\n', joinAt));
  /* The ARGUMENT LIST, not the function's prose. A slice of the whole function
     matched the comment explaining why the recorder writes an empty moov and
     reported the opposite of the truth — which is the sort of check that
     passes for ever while the code says whatever it likes. */
  const argsAt = joinSrc.indexOf("spawn('ffmpeg', [");
  const spawnArgs = joinSrc.slice(argsAt, joinSrc.indexOf('], {', argsAt));
  console.log('    finalise args:',
    spawnArgs.replace(/\s+/g, ' ').replace("spawn('ffmpeg', [", '').slice(0, 170));
  check('the finished file is asked for with an index at the front',
    /'\+faststart'/.test(spawnArgs), spawnArgs.slice(0, 200));
  check('and not with the flags that leave it without one',
    !/empty_moov/.test(spawnArgs), spawnArgs.slice(0, 200));
  /* The other half of the change: one part is no longer just renamed. */
  check('and one part is finished too, not merely renamed',
    /'-i', path\.join\(RECORDINGS_DIR, parts\[0\]\)/.test(joinSrc),
    'a single part still skips ffmpeg');

  const fast = path.join(dir, 'fast.mp4');
  const remuxed = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', frag,
    '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', fast], { encoding: 'utf8' });
  check('it remuxes without re-encoding', remuxed.status === 0 && fs.existsSync(fast),
    (remuxed.stderr || '').slice(0, 200));

  const fastBoxes = boxes(fast);
  const fastMoov = fastBoxes.find((b) => b.type === 'moov');
  const fastMdat = fastBoxes.find((b) => b.type === 'mdat');
  console.log('   ', fastBoxes.slice(0, 4).map((b) => `${b.type}@${b.at}/${b.size}`).join(' '));
  check('now there is a real index', Boolean(fastMoov) && fastMoov.size > 10000,
    JSON.stringify(fastMoov));
  /* At the FRONT, which is what +faststart is for — an index after the video
     is an index the player has to go looking for. */
  check('and it is in front of the video, not behind it',
    Boolean(fastMoov) && Boolean(fastMdat) && fastMoov.at < fastMdat.at,
    JSON.stringify({ moov: fastMoov && fastMoov.at, mdat: fastMdat && fastMdat.at }));

  const fastEarly = durationFromPrefix(fast, 65536, dir);
  console.log('    64KB ->', fastEarly);
  /* The claim, end to end: the length is known from the first 64KB, so the
     player has what it needs to start. */
  check('so the length is known from the first 64KB',
    fastEarly !== null && Math.abs(fastEarly - 60) < 2,
    `64KB said ${fastEarly} of ${fragWhole}`);

  /* And nothing was lost doing it. A tidy-up that costs quality would be a
     worse trade than the slow opening. */
  const sameLength = Math.abs((durationFromPrefix(fast, fs.statSync(fast).size, dir) || 0)
    - (fragWhole || 0)) < 0.5;
  check('and the recording is still the same length', sameLength, 'lengths differ');

  /* ---- and it is only done once ---------------------------------------- */
  /*
   * `indexed` has to survive a write or this becomes a treadmill: the gate in
   * tick() asks for an index whenever the field is undefined, so a field
   * dropped by clean() would mean every restart re-remuxing the whole
   * library — worse than the slow opening it cures.
   */
  console.log('\n  and it is remembered, so it happens once and not every restart');
  const RECS = fs.readFileSync(path.join(ROOT, 'recordings.js'), 'utf8');
  const shape = RECS.slice(RECS.indexOf('const SHAPE = ['), RECS.indexOf('];', RECS.indexOf('const SHAPE = [')));
  check('`indexed` is part of what is written to disk', /'indexed'/.test(shape), shape.slice(-200));
  /* v42.5 added `format` and never added it here, so it was being dropped on
     every write — found while fixing this one. */
  check('and so is `format`, which was being dropped since it was added',
    /'format'/.test(shape), shape.slice(-200));
  const recordings = require('../recordings.js');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dvropen-store-'));
  recordings.load(store, () => {});
  const row = recordings.schedule({
    channelId: '1', channelName: 'ESPN', title: 'A Game',
    startsAt: Date.now() - 1000, endsAt: Date.now() + 1000,
  });
  const live = recordings.get(row.id);
  live.indexed = true;
  /* Through began(), which is what the box calls and what WRITES — mutating
     the row in memory and reading the file back proves nothing, which is what
     the first version of this check did. */
  recordings.began(live, {
    proc: { kill() {} }, release: null, source: 'provider', format: 'ts', stderr: () => '',
  });
  const written = JSON.parse(fs.readFileSync(path.join(store, 'index.json'), 'utf8'))
    .find((r) => r.id === row.id) || {};
  console.log('   ', JSON.stringify({ indexed: written.indexed, format: written.format }));
  check('a row that has been indexed says so after a reload',
    written.indexed === true, JSON.stringify(written));
  check('and remembers which stream it recorded',
    written.format === 'ts', JSON.stringify(written));

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
