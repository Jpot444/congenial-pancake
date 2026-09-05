/**
 * A playhead that goes backwards has to reach the report.
 *
 * "I still have a bug when I am watching live tv where my stream will jump
 *  back in time and restart my position, but I dont think it reads on the
 *  playback report. Make it come up on the report so you can diagnose what the
 *  issue is"
 *
 * It did not, and could not have. Every measurement in that report describes a
 * playhead moving FORWARDS — the measured rate, the delivery rate, the
 * cushion, dropped frames, holes stepped over — and a playhead that jumps
 * backwards satisfies all of them. The report that came with the complaint
 * says so in as many words: 1.000x over 9s, nothing stalled, 15 frames dropped
 * of 24890, `skipped nothing`, `holes now none`. The single trace the jump
 * left was `seeked 1`: a bare count, with nothing about where, when, how far,
 * or who did it. Two minutes of timeline followed, every row 1.00x, because by
 * the time anybody opens the panel the jump is minutes old and the window has
 * rolled over it.
 *
 * So this suite is about the report saying it happened, and about it saying
 * enough to tell apart the two faults that look identical from the sofa:
 *
 *   THE PLAYHEAD WAS MOVED. Something seeked. The media timeline is unchanged
 *   and the position on it went down — hls.js putting itself back on the seat
 *   after a reload does this, and so do several buttons in this app.
 *
 *   THE TIMELINE WAS REPLACED. The provider's encoder restarted, the playlist
 *   came back numbered from the beginning, and the same instant of the
 *   broadcast is now called by a smaller number. Nothing seeked. No property
 *   of the media element can see this; only the playlist can.
 *
 * Driven through the shipped `playback` object in a real browser, with the
 * media element's clock and buffer under the suite's control — there is no
 * provider here, and what is being tested is the bookkeeping rather than
 * anybody's stream.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A line of the report, by its label. */
const line = (report, label) => (report.split('\n')
  .find((l) => l.startsWith(label)) || '').trim();

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/library*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"categories":[],"items":[]}' }));
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }

  /*
   * The media element, with its clock and its buffer on a string. Everything
   * under test reads those two and nothing else about playback, so a stream is
   * not needed and would only make the numbers unrepeatable.
   */
  await page.evaluate(() => {
    const video = document.querySelector('#video');
    window.__clock = { t: 100, from: 60, to: 160 };
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

    /* The once-a-second watchdog is silenced for the duration.
     *
     * In the portal it is the ONLY caller of record(), so samples are always
     * about a second apart and comfortably inside the window record() will
     * compare. Here it would interleave with the suite's own calls and land
     * pairs a few milliseconds apart, which record() rightly declines to
     * measure — a flaky suite rather than a finding. The function under test
     * is driven directly instead. */
    playback.tick = () => {};
  });

  /* Wall time really passes here: record() ignores a pair of samples less than
     200ms or more than 4s apart, because on a real page the first is a repaint
     and the second is a tab that was asleep. Both ends are given room. */
  const GAP = 320;
  const run = async (seconds, step) => {
    for (let i = 0; i < seconds; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await page.evaluate((by) => {
        window.__clock.t += by;
        window.__clock.to += by;
        playback.record();
      }, step);
      // eslint-disable-next-line no-await-in-loop
      await wait(GAP);
    }
  };

  const jump = async (to) => {
    await wait(GAP);
    await page.evaluate((t) => { window.__clock.t = t; playback.record(); }, to);
  };

  /* ---- 1. an ordinary stretch says nothing ------------------------------ */
  /*
   * The "none" matters as much as the finding. A section that appeared only
   * when something went wrong would leave "did it happen while I was
   * watching?" unanswered, which is the state the old report was in.
   */
  console.log('\n  while nothing is wrong');
  await page.evaluate(() => { playback.resetViewing(); playback.reset(); });
  await run(6, 0.26);
  const quiet = await page.evaluate(() => playback.report());
  console.log('   ', JSON.stringify(line(quiet, 'playhead moves')));
  check('the report has a line for this at all',
    /playhead moves/.test(quiet), 'no such line');
  check('and it says nothing moved', /playhead moves\s+none/.test(quiet),
    line(quiet, 'playhead moves'));
  check('and that the playlist window only went forwards',
    /playlist reset\s+none/.test(quiet), line(quiet, 'playlist reset'));

  /* ---- 2. the jump itself ----------------------------------------------- */
  console.log('\n  and when it jumps back');
  await run(4, 0.26);
  await jump(60);                        // the reported symptom: back to the top
  await run(4, 0.26);

  const after = await page.evaluate(() => playback.report());
  const moved = line(after, 'playhead moves');
  console.log('   ', JSON.stringify(moved));
  /* Both halves, because a report with no such line at all would satisfy
     "does not say none" — which is exactly the report this was asked for. */
  check('the report says the playhead moved',
    Boolean(moved) && !/none/.test(moved), JSON.stringify(moved));
  check('and which way', /BACK/.test(moved), moved);
  /* How far, and between which two points. "It jumped" is not diagnosable;
     "it jumped 41.6s, from 101.6 to 60.0" is. The distance is read out of the
     line rather than matched against a literal — the exact figure depends on
     how many samples went by first, and pinning it would be testing the
     suite's own timing. */
  const far = Number((moved.match(/BACK\s+([\d.]+)s/) || [])[1]);
  check('and how far, in seconds', far > 30, `${far}`);
  check('and between which two points', /→/.test(moved), moved);
  /* Nothing in the app asked for it, and the report has to be willing to say
     so — that is the difference between a bug and a button. */
  /* And which of the two faults it was. A seek fires `seeking`/`seeked`
     whoever caused it, so the presence of one separates "something moved the
     playhead" from "the timeline moved under a playhead that never moved" —
     which are the two things that look identical from the sofa. */
  check('and that nothing here asked for it',
    /nothing here asked for it|no seek at all/.test(moved), moved);

  /* The seconds either side. A jump on its own says it happened; these say
     what the buffer and the readyState were doing when it did. */
  check('with the seconds around it kept',
    /the seconds around the last one/.test(after) && />>> the jump <<</.test(after),
    'no surrounding rows');
  const rows = after.split('\n')
    .filter((l) => /rs\d\/\d\s+buf/.test(l) && !/^\s{10}\+/.test(l)).length;
  console.log('   rows kept around it:', rows);
  check('and enough of them to read', rows >= 6, String(rows));

  /* ---- 3. a jump we asked for is not a mystery -------------------------- */
  /*
   * Pressing the Live pill moves the playhead on purpose. A report that
   * called that "nothing here asked for it" would send the next hour after a
   * button working exactly as designed.
   */
  console.log('\n  a jump this app asked for');
  await page.evaluate(() => { playback.resetViewing(); playback.reset(); });
  await run(4, 0.26);
  await page.evaluate(() => {
    playback.expectMove('the Live pill was pressed');
    window.__clock.t += 30;
    playback.record();
  });
  await run(2, 0.26);
  const asked = line(await page.evaluate(() => playback.report()), 'playhead moves');
  console.log('   ', JSON.stringify(asked));
  check('is written down as ours', /Live pill/.test(asked), asked);
  check('and not as unexplained', !/nothing here asked for it/.test(asked), asked);

  /* ---- 4. the ground moving rather than the playhead --------------------- */
  /*
   * The fault the media element cannot see. A live playlist only ever slides
   * forwards; one that comes back with a lower media sequence is an encoder
   * that restarted, and every position the player was holding stopped meaning
   * anything at that moment.
   */
  console.log('\n  when the playlist itself is replaced');
  await page.evaluate(() => { playback.resetViewing(); playback.reset(); });
  const playlist = (startSN, first) => ({
    live: true,
    startSN,
    endSN: startSN + 5,
    totalduration: 61,
    fragments: Array.from({ length: 6 }, (_, i) => ({
      start: first + i * 12, duration: 12,
    })),
  });
  await page.evaluate((p) => playback.notePlaylist(p), playlist(1200, 400));
  await page.evaluate((p) => playback.notePlaylist(p), playlist(1201, 412));
  const sliding = await page.evaluate(() => playback.report());
  check('a window that slides forwards is not a reset',
    /playlist reset\s+none/.test(sliding), line(sliding, 'playlist reset'));

  await page.evaluate((p) => playback.notePlaylist(p), playlist(1, 0));
  const reset = await page.evaluate(() => playback.report());
  const resetLine = line(reset, 'playlist reset');
  console.log('   ', JSON.stringify(resetLine));
  check('but one that comes back numbered from the start is',
    !/none/.test(resetLine), resetLine);
  check('and it says which sequence it went back to',
    /1201→1/.test(resetLine.replace(/\s+/g, '')), resetLine);
  check('and that the timeline went back too',
    /timeline/.test(resetLine), resetLine);

  /* And a jump landing just after one is blamed on it rather than left
     unexplained — which is the whole point of tracking the playlist. */
  console.log('\n  a jump just after a reset');
  await page.evaluate(() => { window.__clock.t = 400; window.__clock.to = 460; });
  await run(4, 0.26);
  await jump(5);
  await run(2, 0.26);
  const blamed = line(await page.evaluate(() => playback.report()), 'playhead moves');
  console.log('   ', JSON.stringify(blamed));
  check('is put down to the playlist being replaced',
    /playlist was replaced/.test(blamed), blamed);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
