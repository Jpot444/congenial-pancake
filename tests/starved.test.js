/**
 * Telling "the wire cannot carry it" apart from everything else.
 *
 * A real report, pasted in full: 0.71×, 7 stalls, and every other reading
 * healthy. The source line was the answer and nothing in the report said so
 * — 3840x1920 HEVC Main 10, stream-copied verbatim, going down a link the
 * player itself had measured at 24 Mbit/s. The verdict read "the stream is
 * not arriving fast enough", which is true, unhelpful, and indistinguishable
 * from a box that cannot convert quickly enough.
 *
 * Two numbers settle it, and neither was being collected:
 *
 *   * what the stream actually costs, in bits per second, measured off the
 *     segments on disk rather than from a BANDWIDTH tag the box never writes;
 *   * how fast the conversion is running against the clock, which says
 *     whether the box is the bottleneck or is sitting there idle.
 *
 * A copy running at several times realtime while the viewer starves is not
 * a conversion problem, and saying so is the whole point.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

// The shape of the report that prompted this, with the readings that were
// healthy left healthy — the point is that they are no longer the story.
const HEALTHY_ELSEWHERE = {
  segment: { declared: 7.757, real: 7.998, ratio: 0.970 },
  start: { video: 0.167, audio: 0.145, sync: -0.022 },
  drift: { video: 610.443, audio: 610.065, gap: -0.378, firstGap: -0.202,
    rate: -0.0003, span: 604.2, linear: true },
  video: {}, audio: {}, input: [],
  declaredTotal: 312.2,
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  /** Put the player in the starved state the report described. */
  const judge = ({ bitrate, speed, link }) => page.evaluate((args) => {
    engineKind = 'hls.js';
    engine = { bandwidthEstimate: args.link, levels: [], currentLevel: -1,
      // One muxed buffer, which is what the box actually produces.
      bufferController: { sourceBuffer: { audiovideo: { buffered: { length: 0 } } } } };
    playback.probe = { ...args.probe, bitrate: args.bitrate, speed: args.speed };
    playback.probedAt = Date.now();
    playback.worstRate = 0.708;
    playback.events = { waiting: 7, stalled: 0, error: 0, ratechange: 0, seeked: 2 };
    playback.samples = [];
    document.querySelector('#video').playbackRate = 1;
    return { verdict: playback.verdict(), lines: playback.serverLines().join('\n') };
  }, { bitrate, speed, link, probe: HEALTHY_ELSEWHERE });

  /* ---- the film is simply bigger than the connection -------------------- */
  //
  // 27 Mbit/s of 4K HEVC down a 24 Mbit/s link, with the box writing at 3.5×
  // realtime. Nothing here is broken; the film does not fit.
  console.log('\n  a stream fatter than the link');
  const fat = await judge({ bitrate: 27.2e6, speed: 3.5, link: 24.3e6 });
  console.log('   ', fat.verdict);
  check('it still says how badly it is running', /0\.71×/.test(fat.verdict), fat.verdict);
  check('but now it says WHY, with both numbers',
    /27\.2 Mbit\/s/.test(fat.verdict) && /24\.3 Mbit\/s/.test(fat.verdict), fat.verdict);
  check('and calls it what it is rather than leaving it to be inferred',
    /more than the link can carry/.test(fat.verdict), fat.verdict);
  check('it clears the box, which is not the bottleneck',
    /box is fine/.test(fat.verdict) && /3\.5×/.test(fat.verdict), fat.verdict);
  check('and names things that would actually help',
    /smaller copy/.test(fat.verdict) && /Low bandwidth/.test(fat.verdict), fat.verdict);
  // The ghost this chases away. Starving looks exactly like lip-sync going
  // off, and the box writes muxed segments — one buffer, both tracks, which
  // cannot come apart. Saying so saves an evening spent in the drift figures.
  check('and says outright that this is not the sound sliding off the picture',
    /cannot come apart/.test(fat.verdict) && /stuttering, not drift/.test(fat.verdict),
    fat.verdict);
  check('and warns that seeking makes the rest of the film worse',
    /Seeking makes it worse/.test(fat.verdict), fat.verdict);

  console.log('\n  and the report carries the arithmetic');
  console.log('   ', fat.lines.split('\n').filter((l) => /bitrate|conversion/.test(l)).join('\n    '));
  check('the bitrate is on the report, not only in the verdict',
    /bitrate\s+27\.2 Mbit\/s of stream/.test(fat.lines), fat.lines);
  check('next to the link it has to fit down',
    /24\.3 Mbit\/s of link/.test(fat.lines), fat.lines);
  check('as a ratio, which is the number that decides it',
    /1\.12× the connection/.test(fat.lines), fat.lines);
  check('and the conversion says how fast it is running',
    /3\.5× realtime/.test(fat.lines), fat.lines);

  /* ---- the same starvation with the box to blame ------------------------ */
  //
  // A small stream and a fat link, but the conversion is limping. Blaming
  // the connection here would send somebody to their router for a fault
  // that is on the box.
  console.log('\n  the same stalls with a box that cannot keep up');
  const slowBox = await judge({ bitrate: 27.2e6, speed: 0.6, link: 24.3e6 });
  console.log('   ', slowBox.verdict);
  check('the connection is still named, because it is still too small',
    /27\.2 Mbit\/s/.test(slowBox.verdict), slowBox.verdict);
  check('but the box is NOT cleared when it is running below realtime',
    !/box is fine/.test(slowBox.verdict), slowBox.verdict);

  /* ---- and headroom is not blamed for stalls it did not cause ----------- */
  //
  // Half the link is genuine headroom. Something else is wrong, and saying
  // "too big for your connection" would be a confident wrong answer.
  console.log('\n  stalls with plenty of headroom');
  const roomy = await judge({ bitrate: 6.0e6, speed: 3.5, link: 24.3e6 });
  console.log('   ', roomy.verdict);
  check('a stream at a quarter of the link is not called too big',
    !/Mbit\/s/.test(roomy.verdict), roomy.verdict);
  check('and it falls back to saying only what it knows',
    /not arriving fast enough/.test(roomy.verdict), roomy.verdict);

  /* ---- with nothing measured, it does not guess ------------------------- */
  console.log('\n  with no measurement to go on');
  const blind = await judge({ bitrate: 0, speed: 0, link: 24.3e6 });
  console.log('   ', blind.verdict);
  check('an unmeasured stream is not accused of anything',
    /not arriving fast enough/.test(blind.verdict) && !/Mbit\/s/.test(blind.verdict),
    blind.verdict);
  check('and the report says n/a rather than a made-up zero',
    /bitrate\s+n\/a/.test(blind.lines),
    blind.lines.split('\n').filter((l) => /bitrate/.test(l)).join(''));

  /* ---- the faults that outrank it still outrank it ---------------------- */
  //
  // Drift and a broken timeline are checked before any of this, and they
  // must stay that way: a stream that is too fat AND drifting is still a
  // drifting stream, which is the fault you can actually fix.
  console.log('\n  a fault that matters more');
  const drifting = await page.evaluate(() => {
    playback.probe = {
      segment: { declared: 8.216, real: 8.361, ratio: 0.983 },
      start: { video: 0, audio: 0, sync: 0 },
      drift: { video: 44.835, audio: 43.858, gap: -0.977, firstGap: -0.02,
        rate: -0.021791, span: 44, linear: true },
      video: {}, audio: {}, input: [], bitrate: 27.2e6, speed: 3.5,
    };
    playback.probedAt = Date.now();
    return playback.verdict();
  });
  console.log('   ', drifting.slice(0, 90));
  check('drift is still reported ahead of a fat stream',
    /DRIFTING/.test(drifting), drifting);

  /* ---- the buffer column, on the right clock ---------------------------- */
  //
  // Both columns used to be on different clocks: position counted from the
  // start of the FILM, the buffer from the start of the CONVERSION. Resume at
  // 102s and every row read "position 314, buffered to 235" — as though the
  // buffer were eighty seconds behind the playhead, which is impossible, and
  // which cost an evening.
  console.log('\n  the timeline, on one clock');
  const timeline = await page.evaluate(() => {
    const at = Date.now();
    // A film resumed 102s in: session time 212, film position 314, and the
    // buffer 23s ahead of the playhead.
    playback.history = [];
    for (let i = 0; i < 12; i += 1) {
      playback.history.push({
        at: at + i * 1000, t: 212 + i, pos: 314 + i, step: 1,
        paused: false, seeking: false, rs: 4, nw: 2,
        buf: 235 + i * 0.6, f: 0, notes: '',
      });
    }
    return { lines: playback.timelineLines(), delivery: playback.deliveryRate() };
  });
  const head = timeline.lines[1];
  const row = timeline.lines[timeline.lines.length - 1];
  console.log('   ', head);
  console.log('   ', row);
  // Row 11: playing at film 325 (session 223), buffer to session 241.6 — so
  // film 344, nineteen seconds ahead. The old rendering printed 242 against
  // a position of 325 and read as a buffer eighty seconds in the past.
  const bufShown = Number(/buf\s+(\d+)/.exec(row)?.[1]);
  const posShown = Number(/\+ *\d+s\s+([\d.]+)/.exec(row)?.[1]);
  check('the buffer is shown in film time, AHEAD of the playhead where it',
    bufShown === 344 && bufShown > posShown, `buf ${bufShown} vs pos ${posShown}`);
  console.log('       belongs — not on the conversion\'s own clock, 102s behind');
  check('with the cushion spelled out, which is the number being looked for',
    /\+ *19s/.test(row), row);
  check('and the heading says so', /cushion/.test(head), head);

  /* ---- and whether the picture is arriving at all ----------------------- */
  //
  // The measured rate says how fast the clock advanced. It says nothing about
  // whether there is anything left to advance through, which is why a report
  // can read 1.00x on every row and stall four seconds later.
  console.log('\n  delivery, which is a different question from rate');
  console.log('   ', timeline.delivery.toFixed(2));
  check('a buffer growing slower than it is watched is measured as such',
    timeline.delivery > 0.55 && timeline.delivery < 0.65, String(timeline.delivery));

  const keeping = await page.evaluate(() => {
    const at = Date.now();
    playback.history = [];
    for (let i = 0; i < 12; i += 1) {
      playback.history.push({ at: at + i * 1000, t: 100 + i, pos: 100 + i, step: 1,
        paused: false, seeking: false, rs: 4, nw: 2, buf: 130 + i * 1.4, f: 0, notes: '' });
    }
    return { delivery: playback.deliveryRate(),
      line: playback.report().split('\n').find((l) => /^delivery/.test(l)) };
  });
  console.log('   ', JSON.stringify(keeping));
  check('and a buffer that is growing is not accused of shrinking',
    keeping.delivery > 1.3, String(keeping.delivery));
  check('the report carries it either way',
    /delivery\s+1\.4\dx of playback/.test(keeping.line)
    && !/cushion is being spent/.test(keeping.line), keeping.line);

  // A source swap restarts the buffer at zero. Reading across one would show
  // an enormous negative delivery and call a healthy stream doomed.
  const swapped = await page.evaluate(() => {
    const at = Date.now();
    playback.history = [];
    for (let i = 0; i < 8; i += 1) {
      playback.history.push({ at: at + i * 1000, t: 900 + i, pos: 900 + i, step: 1,
        paused: false, seeking: false, rs: 4, nw: 2, buf: 950, f: 0, notes: '' });
    }
    playback.history.push({ at: at + 8000, t: 0, pos: 0, step: null, paused: false,
      seeking: false, rs: 0, nw: 2, buf: 0, f: 0, notes: 'loadstart' });
    for (let i = 0; i < 12; i += 1) {
      playback.history.push({ at: at + 9000 + i * 1000, t: i, pos: i, step: 1,
        paused: false, seeking: false, rs: 4, nw: 2, buf: 6 + i * 1.2, f: 0, notes: '' });
    }
    return playback.deliveryRate();
  });
  console.log('   ', String(swapped));
  check('and a new source is measured from itself, not across the swap',
    swapped > 1.0 && swapped < 1.4, String(swapped));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
