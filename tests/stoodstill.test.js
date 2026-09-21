/**
 * A pause is not the network being slow.
 *
 * "It is running at 1.00× now, but fell to 0.02× with 7 stalls — the stream
 *  is not arriving fast enough."
 *
 * It was arriving fine, and the report's own timeline said so in the plainest
 * possible terms — eighty-eight consecutive rows reading `paused`, the buffer
 * GROWING through them from 309s to 340s, a `pause` event at the top and a
 * `play` event at the bottom:
 *
 *   + 31s    244.9  paused  rs4/2 buf  309 + 64s bhd  68s  pause
 *   …
 *   +119s    245.7       -  rs4/2 buf  340 + 95s bhd 154s  play
 *
 * Nothing was slow. Somebody had pressed pause.
 *
 * THE RATE READ 0.02x BECAUSE THE WINDOW SPANNED THE PAUSE. sample() declined
 * to take a sample while paused and left the window alone, so the first
 * sample after the resume was measured against the last one from before it:
 * eighty-eight seconds of standing still divided into a second and a half of
 * media. 1.4 / 88 = 0.016, which is the figure that was reported. `worstRate`
 * then kept it for the whole viewing and the banner turned it into a sentence
 * about the link.
 *
 * AND THE PAUSE WAS THE CAUSE OF EVERYTHING ELSE IN THAT REPORT. A live
 * window is sixty seconds wide. Pausing for longer does not pause the
 * broadcast — the edge keeps moving, the segments under the playhead expire,
 * and on resume the engine's only move is a long way forward. The report
 * carried the forced 139-second jump, seven waitings and five fragment
 * failures, described every one of them, and never mentioned the pause.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
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

  /* Something real to pause. Recorded in the page so the suite carries no
     media file of its own. */
  await page.evaluate(async () => {
    const video = document.querySelector('#video');
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d');
    let n = 0;
    const draw = () => { ctx.fillStyle = `hsl(${(n += 7) % 360} 70% 40%)`; ctx.fillRect(0, 0, 160, 90); };
    draw();
    const stream = canvas.captureStream(25);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    rec.ondataavailable = (e) => chunks.push(e.data);
    const paint = setInterval(draw, 40);
    rec.start();
    await new Promise((r) => setTimeout(r, 6000));
    rec.stop();
    clearInterval(paint);
    await new Promise((r) => { rec.onstop = r; });
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    video.muted = true;
    await new Promise((r) => {
      if (video.readyState >= 1) return r();
      video.addEventListener('loadedmetadata', r, { once: true });
    });
  });
  await wait(500);

  /* ---- the measurement ------------------------------------------------- */
  /*
   * A window built by playing, then a pause, then a resume — and the question
   * is what the rate says about the second of those.
   *
   * The pause here is four seconds rather than eighty-eight. The arithmetic
   * that produced 0.016x is the same at any length: the reported rate is the
   * media that moved divided by the wall clock that passed, and the whole
   * fault is that the wall clock included time nothing was supposed to move
   * in. Four seconds is enough to make that unambiguous and short enough for
   * a suite.
   */
  console.log('\n  a window built by playing, then four seconds of standing still');
  const seen = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    playback.samples = [];
    playback.worstRate = null;
    playback.pauses = [];
    await video.play().catch(() => {});
    /* A few real samples, the way the one-second tick would take them. */
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 700));
      playback.sample();
    }
    const whilePlaying = playback.measuredRate();
    const windowBefore = playback.samples.length;

    video.pause();
    await new Promise((r) => setTimeout(r, 100));
    /* Ticks keep running while paused — that is the point. */
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      playback.sample();
    }
    const windowWhilePaused = playback.samples.length;

    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
    playback.sample();
    const rightAfterResume = playback.measuredRate();
    const span = playback.span();

    return {
      whilePlaying, windowBefore, windowWhilePaused, rightAfterResume, span,
      worst: playback.worstRate,
      pauses: playback.pauses.map((p) => Number(p.seconds.toFixed(1))),
    };
  });
  console.log('   ', JSON.stringify(seen));

  check('playing reads as playing', seen.whilePlaying !== null
    && Math.abs(seen.whilePlaying - 1) < 0.35, String(seen.whilePlaying));
  /* The fix, stated as the thing that changed: the window does not survive
     the pause, so there is no pair of samples straddling it to divide. */
  check('the window is dropped rather than left spanning the pause',
    seen.windowWhilePaused === 0, String(seen.windowWhilePaused));
  /* Which is what stops the resume being measured against before the pause.
     Either there is no answer yet, or the answer is about playback. */
  check('so the resume is not reported as a stalled link',
    seen.rightAfterResume === null || seen.rightAfterResume > 0.5,
    `${seen.rightAfterResume} over ${seen.span.toFixed(1)}s`);
  /* And the number that drove the sentence — kept for the whole viewing and
     printed as `worst measured` — is not a pause either. */
  check('and the worst moment of the viewing is not a pause',
    seen.worst === null || seen.worst > 0.5, String(seen.worst));

  /* ---- and the pause is on the record --------------------------------- */
  /*
   * The other half. The report described the forced jump, the waitings and
   * the fragment failures, and never mentioned the thing that caused them.
   */
  console.log('\n  and the standing still is written down as itself');
  check('the pause was noticed', seen.pauses.length === 1, JSON.stringify(seen.pauses));
  check('and its length is about right',
    seen.pauses[0] > 3.5 && seen.pauses[0] < 6, String(seen.pauses[0]));

  /* A quick press is not what this is for, and a run of them would bury the
     long one it exists to show. */
  console.log('\n  but a quick press is not');
  const quick = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    playback.pauses = [];
    video.pause();
    await new Promise((r) => setTimeout(r, 200));
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    return playback.pauses.length;
  });
  check('nothing written down for a two-hundred-millisecond pause',
    quick === 0, String(quick));

  /* ---- the report says so --------------------------------------------- */
  /*
   * "the stream is not arriving fast enough" is a sentence a person reads, so
   * the last check is the text.
   */
  console.log('\n  and the report names it');
  const lines = await page.evaluate(() => {
    playback.pauses = [{ at: Date.now() - 45_000, seconds: 88 }];
    return playback.moveLines().join('\n');
  });
  console.log(lines.split('\n').filter((l) => /stood still/.test(l))
    .map((l) => `    ${l}`).join('\n'));
  check('a long pause is on the report as standing still',
    /stood still/.test(lines) && /paused 88s/.test(lines), lines);

  /* And it is offered as the CAUSE of a forced jump, which is the line that
     was describing a consequence with no cause attached. */
  const explained = await page.evaluate(() => {
    playback.pauses = [{ at: Date.now() - 20_000, seconds: 88 }];
    return playback.lastLongPause(180);
  });
  console.log('   ', JSON.stringify(explained));
  check('and a jump that follows one can point at it',
    explained && explained.seconds === 88, JSON.stringify(explained));
  const notBlamed = await page.evaluate(() => {
    playback.pauses = [{ at: Date.now() - 600_000, seconds: 88 }];
    return playback.lastLongPause(180);
  });
  check('but a pause from ten minutes ago is not blamed for it',
    notBlamed === null, JSON.stringify(notBlamed));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
