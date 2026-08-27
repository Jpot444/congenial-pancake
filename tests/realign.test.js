/**
 * The self-correcting alignment pass.
 *
 * The risk here is not arithmetic, it is control flow: a restart loop that
 * never terminates, a session killed and not replaced, or a probe failure
 * taking playback down with it. Lifted from server.js and driven with stubs
 * for probeOutput / killSession / startRemux so every branch can be forced.
 */
const fs = require('fs');
const PATHS = require('./paths.js');
const SRC = PATHS.SERVER;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const source = fs.readFileSync(SRC, 'utf8');
function lift(name) {
  const start = source.indexOf(`async function ${name}(`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  return source.slice(start, end);
}

/** Build realign with controllable collaborators. */
function makeRealign({ sync, rate = null, linear = true, throws = false }) {
  const log = { killed: [], restarts: [] };
  const probeOutput = async () => {
    if (throws) throw new Error('ffprobe went missing');
    return { start: { sync }, drift: { rate, linear } };
  };
  const killSession = (id) => log.killed.push(id);
  const startRemux = async (input, opts) => {
    log.restarts.push(opts);
    // Second pass returns a session of its own, as the real one does.
    return { id: `session-${log.restarts.length}`, opts };
  };
  const realign = new Function('probeOutput', 'killSession', 'startRemux',
    `${lift('realign')}; return realign;`)(probeOutput, killSession, startRemux);
  return { realign, log };
}

const SESSION = { id: 'first' };
const OPTS = { fromProvider: true, videoCodec: 'h264', startSeconds: 1028, audioDelayMs: 0 };

(async () => {
  // --- a real gap gets corrected ------------------------------------------
  let { realign, log } = makeRealign({ sync: 2.913 });
  let out = await realign(SESSION, 'http://p/x.mkv', OPTS);
  console.log('   restart opts:', JSON.stringify(log.restarts[0]));
  check('a measured gap triggers exactly one restart', log.restarts.length === 1);
  check('the first session is killed rather than left running',
    log.killed.length === 1 && log.killed[0] === 'first', JSON.stringify(log.killed));
  check('the pad carries the measured gap', log.restarts[0].audioPadSeconds === 2.913,
    String(log.restarts[0].audioPadSeconds));
  check('the retry is marked aligned, so it cannot go round again',
    log.restarts[0].aligned === true);
  check('the seek point is preserved', log.restarts[0].startSeconds === 1028);
  check('the manual offset is preserved', log.restarts[0].audioDelayMs === 0);
  check('the new session is what comes back', out.id === 'session-1', JSON.stringify(out));

  // --- an aligned-enough session is left alone ----------------------------
  for (const [label, value] of [
    ['already aligned', 0],
    ['a gap too small to hear', 0.05],
    ['exactly at the threshold', 0.1],
    ['audio ahead rather than behind', -1.2],
    ['nothing measurable', null],
    ['not a number', NaN],
  ]) {
    ({ realign, log } = makeRealign({ sync: value }));
    out = await realign(SESSION, 'http://p/x.mkv', OPTS);
    check(`${label} is left alone`,
      log.restarts.length === 0 && log.killed.length === 0 && out === SESSION,
      `restarts ${log.restarts.length}, killed ${log.killed.length}`);
  }

  // --- a drift RATE is never acted on, at any value --------------------
  //
  // The correction that used to live here is gone. Two reports of the same
  // archive rip at the same resume point:
  //
  //     02:13   gap 9.030s over 279.0s  ->  "32.4ms/s"
  //     02:49   gap 9.031s over 299.4s  ->  "30.2ms/s"
  //
  // The gap is identical to the millisecond; only the span grew. That is a
  // constant divided by a growing number, not a rate — and the same report
  // put a 9.03s gap inside a segment holding 2.475s, which is impossible.
  // The measurement cannot support a correction, so there is not one.
  console.log('\n  a drift rate changes nothing, whatever it says');
  for (const [label, rate, linear] of [
    ['the rate that used to trigger it', -0.0324, true],
    ['a larger one', -0.0686, true],
    ['one the halves agreed about', -0.02, true],
    ['one they did not', -0.02, false],
  ]) {
    ({ realign, log } = makeRealign({ sync: 0, rate, linear }));
    out = await realign(SESSION, '/mnt/archive/x.mp4', OPTS);
    check(`${label} is left alone`,
      log.restarts.length === 0 && log.killed.length === 0 && out === SESSION,
      `restarts ${log.restarts.length}`);
  }
  check('and no tempo is ever passed to a rebuild',
    !/audioTempo/.test(lift('realign')), 'realign still sets a tempo');

  // An OFFSET is a different measurement and is still corrected on its own.
  ({ realign, log } = makeRealign({ sync: 1.9, rate: -0.0686, linear: true }));
  await realign(SESSION, 'http://p/film.mkv', OPTS);
  check('while a visible start offset is still corrected',
    log.restarts.length === 1 && log.restarts[0].audioPadSeconds === 1.9
    && !log.restarts[0].audioTempo, JSON.stringify(log.restarts[0]));

  // --- a broken probe must not take playback with it ----------------------
  ({ realign, log } = makeRealign({ sync: 2.9, throws: true }));
  out = await realign(SESSION, 'http://p/x.mkv', OPTS);
  check('a probe that throws leaves the session playing',
    out === SESSION && log.killed.length === 0 && log.restarts.length === 0);

  // --- the second pass never re-enters ------------------------------------
  // realign is only reached when `aligned` is false; the retry sets it true,
  // and the caller checks it. Verify the caller's guard is really there.
  check('the caller skips realign once aligned',
    /aligned \? session : realign\(session, input, opts\)/.test(source),
    'the guard in startRemux has moved or changed shape');

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
