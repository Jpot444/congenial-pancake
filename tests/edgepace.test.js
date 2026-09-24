/**
 * Which end of the gap slipped.
 *
 * "the jumping issue happened again"
 *
 * The report that came with it was clean on every line that exists:
 *
 *   measured rate   1.000x over 10s        frames  0 dropped of 741
 *   events          waiting 0, stalled 0   skipped nothing
 *   playhead moves  none                   holes now none
 *   playlist reset  none
 *
 * And one number growing:
 *
 *   behind live     48.2s now, 37.3s when it started
 *                   slipped 10.9s since it started — time lost to stalls
 *                   that was never made back
 *
 * With `stalled 0` and `waiting 0` four lines above it. That sentence was
 * printed unconditionally whenever the gap had grown, and it had never once
 * been checked against whether anything had actually stalled.
 *
 * A GAP HAS TWO ENDS, and the report only ever watched one of them.
 * Everything in it describes the playhead — whether it keeps up, what it is
 * buffered against, whether it moved when it should not have. Reading that
 * report's own timeline:
 *
 *   playhead   28.2 → 52.6 over 26s of wall clock   = 1.00x, exactly right
 *   edge       63.2 → 100.6 over the same 26s       = 1.44x
 *
 * A live edge cannot outrun the clock. A provider doing it is publishing
 * faster than it is producing — catching up after a stumble, splicing, or
 * advertising segment durations longer than the media behind them — and every
 * one of those is felt as the picture skipping. Nothing here measured it.
 *
 * The edge is `currentTime + behind`, which is stable across a seek because
 * both terms move together. That is what makes it worth measuring separately.
 *
 * DRIVEN THROUGH A STAND-IN ENGINE. `behind` comes from hls.js's `latency`,
 * and what is under test is the arithmetic and the sentence it produces — not
 * whether a real provider happens to misbehave while a suite is watching.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
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
    await page.waitForTimeout(1300);
  }

  /*
   * A stand-in for the two things `liveStanding` reads out of hls.js, plus a
   * playhead this suite drives by hand. Time is driven by hand too: the whole
   * measurement is media-seconds per wall-second, and a suite that waited out
   * real seconds to observe a ratio would be slow and no more honest.
   */
  await page.evaluate(() => {
    window.__fake = { latency: 37.3, seat: 60, at: 0, t: 28.2 };
    engineKind = 'hls.js';
    engine = {
      get latency() { return window.__fake.latency; },
      get liveSyncPosition() { return window.__fake.seat; },
      levels: [{ details: { live: true, totalduration: 60, fragments: [{ start: 40 }] } }],
      currentLevel: 0,
      targetLatency: 32,
    };
    const video = document.querySelector('#video');
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => window.__fake.t,
      set: () => {},
    });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    /* performance.now is what record() stamps rows with, so the wall clock is
       driven from the same place as the playhead. */
    const realNow = performance.now.bind(performance);
    window.__realNow = realNow;
    performance.now = () => realNow() + window.__fake.at * 1000;
  });

  /** Advance the wall clock, the playhead and the edge, then take a sample. */
  const run = async (seconds, playheadRate, edgeRate) => page.evaluate(
    ({ secs, pRate, eRate }) => {
      for (let i = 0; i < secs; i += 1) {
        window.__fake.at += 1;
        window.__fake.t += pRate;
        /* `behind` is edge minus playhead, so moving the edge by eRate while
           the playhead moves by pRate is exactly what the gap does. */
        window.__fake.latency += eRate - pRate;
        playback.record();
      }
      return null;
    }, { secs: seconds, pRate: playheadRate, eRate: edgeRate },
  );

  const readBehind = () => page.evaluate(() => playback.behindLines().join('\n'));
  const reset = () => page.evaluate(() => {
    playback.edges = [];
    playback.history = [];
    playback.behindFirst = null;
    playback.behindWorst = null;
    playback.behindAt = 0;
    window.__fake.latency = 37.3;
    window.__fake.t = 28.2;
  });

  /* ---- the report that arrived ----------------------------------------- */
  /*
   * The numbers from it: twenty-six seconds, the playhead at 1.00x and the
   * edge at 1.44x, which opens the gap by eleven seconds without anything
   * going wrong in the player.
   */
  console.log('\n  a playhead keeping perfect time while the far end runs away');
  await reset();
  await run(26, 1.0, 1.44);
  let lines = await readBehind();
  console.log(lines.split('\n').map((l) => `    ${l}`).join('\n'));

  /* The TEXT first, and the new arithmetic after it.
   *
   * These checks read only the report, so they hold on a build that has no
   * edgePace at all — which is what makes their verdict about behaviour
   * rather than about a function being new. Asking the new function first
   * would throw there and prove nothing. */
  check('the gap is still reported as having opened',
    /slipped 1\d\.\ds/.test(lines), lines);
  /* The sentence that was wrong. Nothing stalled, and the report said stalls. */
  check('and it no longer blames stalls for it',
    !/time lost to stalls/.test(lines), lines);
  check('it names the far end as what moved',
    /far end ran ahead/.test(lines), lines);
  check('with the figure, so the claim can be checked rather than believed',
    /1\.4\dx/.test(lines), lines);
  /* The standing line, which is there whether or not a gap has opened. */
  check('and says plainly that a broadcast cannot do that',
    /FASTER than the clock, which a broadcast cannot do/.test(lines), lines);

  const pace = await page.evaluate(() => playback.edgePace());
  console.log('   ', JSON.stringify(pace));
  check('the edge pace is measured at all', pace !== null, String(pace));
  check('and it is the far end that is fast, at about 1.44x',
    pace && Math.abs(pace.rate - 1.44) < 0.05, pace && String(pace.rate));

  /* ---- a broadcast behaving -------------------------------------------- */
  /*
   * The check that keeps the one above honest. A detector that shouts on a
   * healthy stream is worse than none, and this is the ordinary case: the
   * edge and the playhead both at 1.00x, the gap unchanged.
   */
  console.log('\n  and an ordinary stream says so');
  await reset();
  await run(26, 1.0, 1.0);
  lines = await readBehind();
  console.log(lines.split('\n').map((l) => `    ${l}`).join('\n'));
  check('nothing has slipped', /holding steady/.test(lines), lines);
  check('and the edge is keeping proper time', /proper time/.test(lines), lines);
  check('with no accusation in either direction',
    !/ran ahead|stalled|cannot do/.test(lines), lines);

  /* ---- the other way round --------------------------------------------- */
  /*
   * A gap that opens because the PLAYHEAD fell behind — the case the old
   * sentence was written for, and the one it should still describe. The edge
   * keeps proper time; the picture does not.
   */
  console.log('\n  and a playhead that genuinely fell behind is named as that');
  await reset();
  await run(26, 0.6, 1.0);
  lines = await readBehind();
  console.log(lines.split('\n').map((l) => `    ${l}`).join('\n'));
  check('the gap opened', /slipped/.test(lines), lines);
  check('and this time it is the playhead',
    /this is the playhead falling behind it/.test(lines), lines);
  check('the edge is not accused of it', /edge kept proper time/.test(lines), lines);

  /* ---- and a far end that stopped -------------------------------------- */
  /*
   * The third possibility, and it closes the gap rather than opening it — so
   * it arrives on the "pulled closer" line. What matters is that the edge
   * pace still reports what the far end did, because "you are closer to live"
   * for the wrong reason is worth knowing.
   */
  console.log('\n  and a far end that stopped publishing is measured too');
  await reset();
  await run(26, 1.0, 0.3);
  const stalledPace = await page.evaluate(() => playback.edgePace());
  lines = await readBehind();
  console.log('   ', JSON.stringify(stalledPace));
  check('the edge is measured as barely moving',
    stalledPace && stalledPace.rate < 0.5, String(stalledPace && stalledPace.rate));
  check('and the line says slower than the clock',
    /slower than the clock/.test(lines), lines);

  /* ---- and it will not answer from nothing ----------------------------- */
  /*
   * A ratio taken over two seconds of a stream that has just started is noise
   * with a decimal point on it, and this report is read by somebody deciding
   * whether their provider is at fault.
   */
  console.log('\n  but it does not answer before it has a window to divide by');
  await reset();
  await run(3, 1.0, 1.44);
  const early = await page.evaluate(() => playback.edgePace());
  console.log('   ', JSON.stringify(early));
  check('three seconds in, it says nothing rather than something', early === null,
    JSON.stringify(early));
  const earlyLines = await readBehind();
  check('and the report carries no pace line yet',
    !/the edge moved at/.test(earlyLines), earlyLines);

  await page.evaluate(() => { performance.now = window.__realNow; });
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
