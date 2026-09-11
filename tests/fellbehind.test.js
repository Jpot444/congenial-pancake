/**
 * Falling behind live, and the jump at the end of it.
 *
 * "there was just a jump in the time of my live stream, but i dont think the
 *  playback caught it"
 *
 * It did not. The report that came with the complaint shows why, and it is not
 * that a jump went unrecorded — `playhead moves` was there and working. It is
 * that being behind live was read as ONE INSTANTANEOUS NUMBER at the bottom of
 * the report, and the fault is a slide:
 *
 *   latency         72.0s behind the edge, asked for 33.0s
 *     seat          364.8s, playhead -39.0s from it
 *   playlist        live, 6 segments of ~12s = 60s window
 *
 * A sixty-second window, and a playhead seventy-two seconds behind the edge.
 * The segments underneath it had already been deleted by the provider; the
 * engine's only remaining move was to jump forward onto one that still
 * existed. That is the jump. And every rate in the report was perfect —
 * `measured rate 1.000x`, `delivery 1.01x` — because a playhead that is late
 * still advances at exactly one second per second. Nothing in the report
 * connected the two, and nothing in it said the cliff was five seconds away.
 *
 * So what is checked here is the chain, not the event:
 *
 *   THE SLIDE IS VISIBLE. Where it started, where it is now, and that it moved
 *   — because "72s behind" alone can be a seat somebody chose, while "32s then
 *   72s" is time lost to stalls that was never made back.
 *
 *   THE CLIFF IS CALLED BEFORE IT IS REACHED. A playhead with less than a
 *   segment of window left behind it is a jump about to happen, and saying so
 *   in advance is the difference between a report that explains the fault and
 *   one that merely records it.
 *
 *   THE JUMP IS LABELLED FOR WHAT IT WAS. Not "something seeked, and nothing
 *   here asked for it" — which is true, useless, and stops anybody looking —
 *   but the playhead having fallen off the back of the window.
 *
 *   AND THE VERDICT IS IN THE RIGHT TENSE. The line at the top of that report
 *   read "Running at 0.00x with 7 stalls — the stream is not arriving fast
 *   enough" about a stream that had been running at 1.000x for seventy
 *   seconds. `worstRate` is the low point of the whole viewing and was being
 *   read out in the present tense, which sent the diagnosis at the network
 *   while the network was fine.
 *
 * Driven through the shipped `playback` object with the media element's clock
 * and a stand-in engine under the suite's control. There is no provider here;
 * what is under test is the bookkeeping.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The block of report lines under a label, to the next unindented one. */
const block = (report, label) => {
  const lines = report.split('\n');
  const at = lines.findIndex((l) => l.startsWith(label));
  if (at < 0) return '';
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  for (const [glob, body] of [
    ['**/api/library*', '{"categories":[],"items":[]}'],
    ['**/api/scores*', '{"games":[],"feeds":[]}'],
    ['**/api/profiles/*/taste', '{}'],
    ['**/api/xtream*', '{}'],
    ['**/api/market/lines*', '{"day":"2026-09-11","lines":[]}'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await page.route(glob, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body }));
  }

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }

  /*
   * The media element and the engine, both on a string.
   *
   * `engine` and `engineKind` are the module-level bindings the report reads;
   * a stand-in with the four properties liveStanding() asks for is enough, and
   * a real stream would make none of these numbers repeatable.
   */
  await page.evaluate(() => {
    const video = document.querySelector('#video');
    window.__clock = { t: 100, from: 60, to: 160 };
    /* A 60-second window, exactly as the provider in the report serves: six
       12-second segments, the oldest of them at `backEdge`. */
    window.__live = { latency: 32, seat: 132, backEdge: 40, total: 60 };
    window.__last = performance.now();
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return window.__clock.t; },
      set(v) { window.__clock.t = v; },
    });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get: () => ({ length: 1,
        start: () => window.__clock.from,
        end: () => window.__clock.to }),
    });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(video, 'seeking', { configurable: true, get: () => false });
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(video, 'networkState', { configurable: true, get: () => 2 });

    /* The engine, as much of it as the report reads. */
    engineKind = 'hls.js';
    engine = {
      get latency() { return window.__live.latency; },
      get liveSyncPosition() { return window.__live.seat; },
      targetLatency: 32,
      currentLevel: 0,
      bandwidthEstimate: 2.2e6,
      levels: [{
        bitrate: 3e6,
        get details() {
          const start = window.__live.backEdge;
          return {
            live: true,
            targetduration: 12,
            totalduration: window.__live.total,
            startSN: 1000,
            endSN: 1005,
            fragments: Array.from({ length: 5 }, (_, i) => ({
              start: start + i * 12, duration: 12,
            })),
          };
        },
      }],
    };
    /* The once-a-second watchdog is the only caller of record() in the portal,
       so samples are always about a second apart. Here it would interleave
       with the suite's own calls and land pairs milliseconds apart, which
       record() rightly declines to measure. */
    playback.tick = () => {};
  });

  /* record() ignores a pair of samples less than 200ms or more than 4s apart.
     Both ends are given room. */
  const GAP = 300;

  /*
   * A tick of ordinary playback, at exactly 1.00x.
   *
   * The media clock is advanced by the REAL wall time since the previous tick
   * rather than by a fixed amount, because section 6 turns on the measured
   * rate being genuinely 1.00x: a clock advanced a whole second per 300ms of
   * wall would read 3.3x and the verdict under test would be describing a
   * stream that does not exist.
   */
  const run = async (ticks, { behind = null } = {}) => {
    for (let i = 0; i < ticks; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await page.evaluate((opts) => {
        const now = performance.now();
        const dt = (now - window.__last) / 1000;
        window.__last = now;
        window.__clock.t += dt;
        window.__clock.to += dt;
        /* The window slides with the playhead while nothing is wrong, so the
           latency holds — which is what "not sliding" means. */
        window.__live.backEdge += dt;
        window.__live.seat += dt;
        if (opts.behind !== null) window.__live.latency = opts.behind;
        playback.record();
        playback.sample();
      }, { behind });
      // eslint-disable-next-line no-await-in-loop
      await wait(GAP);
    }
  };

  /*
   * A stall: the edge and the window move on, the playhead does not.
   *
   * Each tick costs a second of latency. That is the accounting the suite is
   * testing rather than hls.js's own latency arithmetic — what matters is that
   * a playhead which stops while the window keeps going ends up further behind
   * and that the report says so.
   */
  const stall = async (ticks) => {
    for (let i = 0; i < ticks; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await page.evaluate(() => {
        const now = performance.now();
        const dt = (now - window.__last) / 1000;
        window.__last = now;
        window.__live.backEdge += dt;
        window.__live.seat += dt;
        window.__live.latency += 1;
        playback.record();
        playback.sample();
      });
      // eslint-disable-next-line no-await-in-loop
      await wait(GAP);
    }
  };

  /* ---- 1. an ordinary stretch says so ---------------------------------- */
  /*
   * The "steady" reading matters as much as the alarm. A section that only
   * appeared when something was wrong would leave "was it sliding while I was
   * watching?" unanswered — which is the state the old report was in.
   */
  console.log('\n  sitting where it was asked to sit');
  await page.evaluate(() => { playback.resetViewing(); playback.reset(); });
  await run(8);
  let report = await page.evaluate(() => playback.report());
  let behind = block(report, 'behind live');
  console.log(behind.split('\n').map((l) => `    ${l.trim()}`).join('\n'));
  check('the report has a behind-live section at all', Boolean(behind), 'no such section');
  check('it says where it is now', /32\.0s now/.test(behind), behind);
  check('and where it started', /32\.0s when it started/.test(behind), behind);
  check('and that it is not sliding', /holding steady/.test(behind), behind);
  check('and how much window is left behind the playhead',
    /window holds 60s/.test(behind) && /of it left behind/.test(behind), behind);
  check('no alarm while there is nothing to alarm about',
    !/>>>/.test(behind), behind);
  check('and the timeline carries the number row by row',
    /bhd\s+32s/.test(report), (report.split('\n').find((l) => /bhd/.test(l)) || '').trim());

  /* ---- 2. stalls, and the deficit they leave --------------------------- */
  /*
   * The reported chain. Three stalls, and between them the stream runs at a
   * flawless 1.00x — which is exactly why every rate in the original report
   * read as healthy while the playhead slid a minute away from the edge.
   */
  console.log('\n  three stalls, and a perfect 1.00x in between');
  await stall(10);
  await run(6);
  await stall(8);
  await run(6);
  await stall(6);
  await run(6);

  report = await page.evaluate(() => playback.report());
  behind = block(report, 'behind live');
  console.log(behind.split('\n').map((l) => `    ${l.trim()}`).join('\n'));
  const now = Number((behind.match(/([\d.]+)s now/) || [])[1]);
  console.log(`    measured rate right now: ${(await page.evaluate(() => playback.measuredRate()))?.toFixed?.(2)}`);
  check('the slide is on the report', now > 55, `${now}`);
  check('and named as a slide rather than a number', /slipped/.test(behind), behind);
  check('with how much of it was lost', /slipped 2[0-9]\.\ds/.test(behind), behind);
  check('and said to be time the stalls cost',
    /never made back/.test(behind), behind);

  /* ---- 3. the cliff, called before it is reached ----------------------- */
  /*
   * The line the reported jump needed. The playhead is nearly out of the
   * window and nothing has happened yet — no jump, no stall, every rate
   * perfect. This is the last moment at which the report can be useful.
   */
  console.log('\n  and then the window catches up with the playhead');
  await page.evaluate(() => {
    /* Eight seconds of window left behind the playhead: inside a segment of
       the back edge, which is the point of no return. */
    window.__live.backEdge = window.__clock.t - 8;
    window.__live.latency = 68;
  });
  await run(2, { behind: 68 });
  report = await page.evaluate(() => playback.report());
  behind = block(report, 'behind live');
  console.log(behind.split('\n').map((l) => `    ${l.trim()}`).join('\n'));
  check('the report warns before the jump, not after',
    /less than a segment of room left/.test(behind), behind);
  check('and says what will happen next', /forced jump forward/.test(behind), behind);

  let verdict = await page.evaluate(() => playback.verdict());
  console.log(`    verdict: ${verdict}`);
  check('and it is the headline verdict, not a detail further down',
    /behind the live edge/.test(verdict) && /jump/.test(verdict), verdict);

  /* ---- 4. over the edge ------------------------------------------------ */
  console.log('\n  and past it');
  await page.evaluate(() => {
    window.__live.backEdge = window.__clock.t + 6;   // the playhead is behind the oldest segment
    window.__live.latency = 74;
  });
  await run(2, { behind: 74 });
  report = await page.evaluate(() => playback.report());
  behind = block(report, 'behind live');
  console.log(behind.split('\n').map((l) => `    ${l.trim()}`).join('\n'));
  check('the report says the playhead is past the back of the window',
    /PAST THE BACK OF IT/.test(behind), behind);
  check('and that the segments under it are gone',
    /have expired/.test(behind), behind);

  /* ---- 5. the jump itself, labelled for what it was -------------------- */
  /*
   * The engine's only remaining move. Before this, the report called it
   * "something seeked, and nothing here asked for it" — true, and the least
   * useful of the available truths.
   */
  console.log('\n  the jump the engine has to make');
  await wait(GAP);
  await page.evaluate(() => {
    window.__clock.t = window.__live.seat;      // forward, onto the seat
    window.__clock.to = window.__live.seat + 20;
    window.__live.latency = 32;
    playback.record();
  });
  await run(3, { behind: 32 });
  report = await page.evaluate(() => playback.report());
  const moves = block(report, 'playhead moves');
  console.log(`    ${moves.split('\n')[0].trim()}`);
  check('the jump is on the report', /forward/.test(moves), moves.split('\n')[0]);
  check('and blamed on the window running out rather than on a mystery seek',
    /fallen \d+s behind the oldest segment/.test(moves), moves.split('\n')[0]);
  check('and not on "something seeked, and nothing here asked for it"',
    !/nothing here asked for it/.test(moves.split('\n')[0]), moves.split('\n')[0]);

  /* ---- 6. the verdict is in the right tense ---------------------------- */
  /*
   * The first line of the original report: "Running at 0.00x with 7 stalls"
   * about a stream running at 1.000x. worstRate is the low point of the whole
   * viewing, and reading it out in the present tense is the one mistake that
   * points a diagnosis at the wrong subsystem.
   */
  console.log('\n  the tense of the verdict');
  await page.evaluate(() => {
    /* Back to a healthy, well-seated stream that HAS stalled in its past —
       exactly the state the reported reading was taken in.
       reset() is what the portal calls when a stream is re-attached: it clears
       the measurement window and the event counts, and deliberately does NOT
       clear worstRate, because the first thing anybody does about bad playback
       is reload and a worst reading that reset with the session would be wiped
       by the very act of reacting to it. That surviving low point being read
       out in the present tense is the bug under test. */
    playback.reset();
    window.__live.backEdge = window.__clock.t - 30;
    window.__live.latency = 32;
    playback.worstRate = 0;
    playback.events.waiting = 7;
  });
  await run(10, { behind: 32 });
  verdict = await page.evaluate(() => playback.verdict());
  const rateNow = await page.evaluate(() => playback.measuredRate());
  console.log(`    running at ${rateNow === null ? 'n/a' : rateNow.toFixed(3)}x · verdict: ${verdict}`);
  check('the stream really is healthy right now', rateNow !== null && rateNow > 0.9,
    `${rateNow}`);
  check('so the verdict does not claim it is running at the worst it ever did',
    !/^Running at 0\.00/.test(verdict), verdict);
  /* The multiplication sign the report actually prints, not an ASCII x. */
  check('it says what it is doing now', /running at 1\.0\d× now/i.test(verdict), verdict);
  check('and that the bad reading is in the past', /fell to 0\.00/.test(verdict), verdict);
  check('while still reporting the stalls', /7 stalls/.test(verdict), verdict);

  /* ---- 7. and none of this on a film ----------------------------------- */
  /*
   * A conversion has no live edge and no window to fall out of. A report that
   * invented a behind-live figure for one would be worse than silent.
   */
  console.log('\n  a film, which has no edge to be behind');
  /* A new title, which is what this is: resetViewing() is what the portal
     calls on one, and the rows recorded while a live stream was up really were
     32s behind — a timeline that dropped that on switching titles would be
     lying about the stream it was describing. */
  await page.evaluate(() => {
    engineKind = 'hls.js';
    engine = null;
    playback.resetViewing();
    playback.reset();
  });
  await run(4);
  report = await page.evaluate(() => playback.report());
  /* Anchored to the start of the line: `playhead moves` prints "(32.0s behind
     live)" inside its own line, and a bare search for the words finds that. */
  check('no behind-live section where there is no live stream',
    !report.split('\n').some((l) => l.startsWith('behind live')),
    block(report, 'behind live'));
  check('and no behind column in the timeline either',
    !/bhd/.test(report), (report.split('\n').find((l) => /bhd/.test(l)) || '').trim());

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
