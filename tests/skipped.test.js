/**
 * Ten seconds of a ball game went past and nobody was told.
 *
 * "there was just a jump in what I was watching and I completly missed a home
 *  run that was hit in the game. Critical time for an error"
 *
 * The report of it said this, and it is the whole story if you know where to
 * look:
 *
 *   buffered   1141.4-1179.5, 1189.5-1239.5
 *   + 93s  1179.1  1.00x  rs4/2 buf 1210 + 30s
 *   + 94s  1189.9      -  rs4/2 buf 1210 + 20s  waiting seeking waiting seeked
 *
 * A ten-second hole in what had been downloaded. The playhead ran to the edge
 * of it, stalled, and the player stepped over — forward ten and a half seconds
 * in one second of wall clock. The link was fine the whole time: 31 Mbit/s,
 * delivery 1.09x of playback, rate 1.000x. A segment simply never arrived.
 *
 * Stepping over a hole is the right trade — frozen for good is worse than a
 * jump — so this suite does not argue with it. It is about the three things
 * around it that were wrong.
 *
 *   THE CUSHION LIED. `buf` was the end of the LAST buffered range, so with a
 *   hole in the middle it reported the far side of it: "+30s" on every row
 *   right up to the one that hit the wall four tenths of a second later. The
 *   number that matters is the end of the range the playhead is IN.
 *
 *   THE SKIP WAS SILENT. Nothing was said, so "did I miss a play or did my
 *   eyes wander" had no answer. It says so now — and on a live channel, whose
 *   window here is a minute wide, it offers to go back and ask for the
 *   segment again.
 *
 *   AND THE REASON WAS THROWN AWAY. `if (!data.fatal) return` — and a
 *   fragment that fails to load is not fatal. The one event that explains a
 *   hole was the one event never written down, so the report could say a skip
 *   happened and nothing at all about why.
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
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"categories":[],"items":[],"totals":{"items":0}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1200);
  }

  /* The video element, standing in for one that has a hole in its buffer.
     Faked at exactly the shape the real report showed. */
  const shape = async (ranges, at) => page.evaluate(({ rs, cur }) => {
    const video = document.querySelector('#video');
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get: () => ({
        length: rs.length,
        start: (i) => rs[i][0],
        end: (i) => rs[i][1],
      }),
    });
    Object.defineProperty(video, 'currentTime',
      { configurable: true, get: () => cur, set: () => {} });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(video, 'currentSrc',
      { configurable: true, get: () => 'blob:http://127.0.0.1/x' });
  }, { rs: ranges, cur: at });

  const HOLE = [[1141.4, 1179.5], [1189.5, 1239.5]];

  /* ---- the cushion tells the truth -------------------------------------- */
  console.log('\n  four tenths of a second from a wall');
  await shape(HOLE, 1179.1);
  const ahead = await page.evaluate(() => {
    const video = document.querySelector('#video');
    return { ...bufferAhead(video), holes: bufferHoles(video) };
  });
  console.log('   ', JSON.stringify(ahead));
  /* The old number was 1239.5 — the far side of the hole — which read as
     thirty seconds of comfort. */
  check('the cushion ends at the hole, not past it',
    Math.abs(ahead.end - 1179.5) < 0.01, JSON.stringify(ahead));
  check('and it says where the picture would pick up again',
    Math.abs(ahead.resumeAt - 1189.5) < 0.01, JSON.stringify(ahead));
  check('the hole itself is measured', ahead.holes.length === 1
    && Math.abs(ahead.holes[0].seconds - 10) < 0.01, JSON.stringify(ahead.holes));

  /* ---- and the skip is announced ---------------------------------------- */
  console.log('\n  stepping over it');
  const jumped = await page.evaluate(async () => {
    playback.resetViewing();
    playback.history = [];
    const video = document.querySelector('#video');
    const said = document.querySelector('#toast');
    if (said) { said.textContent = ''; said.hidden = true; }
    // Live, because that is what was being watched and what the offer to go
    // back depends on.
    currentLiveItem = { kind: 'live', id: 1, name: 'A Channel' };
    // At the edge of the first island…
    playback.record();
    // …then the player steps across, exactly as the report showed.
    Object.defineProperty(video, 'currentTime',
      { configurable: true, get: () => 1189.9, set: () => {} });
    playback.record();
    await new Promise((r) => setTimeout(r, 200));
    return {
      gaps: playback.gaps.map((g) => ({ from: +g.from.toFixed(1), to: +g.to.toFixed(1),
        seconds: +g.seconds.toFixed(1) })),
      said: document.querySelector('#toast')?.textContent || '',
      offer: document.querySelector('#toast .toast-action')?.textContent || '',
    };
  });
  console.log('   ', JSON.stringify(jumped));
  check('the skip is recorded, with how much went past',
    jumped.gaps.length === 1 && Math.abs(jumped.gaps[0].seconds - 10.4) < 0.2,
    JSON.stringify(jumped.gaps));
  /* The complaint in one sentence: it happened and nobody was told. */
  check('and the viewer is told', /skipped/i.test(jumped.said), jumped.said);
  check('with the number of seconds in it', /10\.4s/.test(jumped.said), jumped.said);
  /* A minute-wide live window usually still holds the segment, so asking
     again is worth a press. */
  check('and offered a way back on a live channel',
    /go back/i.test(jumped.offer), jumped.offer);

  /* ---- an ordinary seek is not a skip ------------------------------------ */
  /*
   * The detector must not cry wolf. Somebody dragging the scrubber moves the
   * playhead a long way forward too, and calling that "you missed something"
   * would make the warning worthless within an evening.
   */
  console.log('\n  and somebody seeking on purpose');
  const seek = await page.evaluate(async () => {
    playback.resetViewing();
    playback.history = [];
    const video = document.querySelector('#video');
    // One unbroken range, and a jump inside it.
    Object.defineProperty(video, 'buffered', { configurable: true,
      get: () => ({ length: 1, start: () => 1100, end: () => 1240 }) });
    Object.defineProperty(video, 'currentTime',
      { configurable: true, get: () => 1150, set: () => {} });
    playback.record();
    Object.defineProperty(video, 'currentTime',
      { configurable: true, get: () => 1200, set: () => {} });
    playback.record();
    return playback.gaps.length;
  });
  console.log('   gaps recorded:', seek);
  check('is not reported as missed content', seek === 0, String(seek));

  /* ---- and the engine's reason is kept ----------------------------------- */
  /*
   * A fragment that will not load is NOT fatal, and the handler returned on
   * exactly that test before writing anything down. So the hole had a cause
   * and the report had no room for it.
   */
  console.log('\n  what the engine said');
  const kept = await page.evaluate(() => {
    playback.resetViewing();
    playback.noteEngineError({ fatal: false, type: 'networkError',
      details: 'fragLoadError', frag: { sn: 4711, start: 1179.5 },
      reason: 'HTTP 404' });
    const report = playback.report();
    return {
      n: playback.engineErrors.length,
      inReport: /fragLoadError/.test(report),
      saysSegment: /4711/.test(report),
      saysWhy: /404/.test(report),
    };
  });
  console.log('   ', JSON.stringify(kept));
  check('a non-fatal fragment failure is written down', kept.n === 1, String(kept.n));
  check('and reaches the report', kept.inReport === true);
  check('naming the segment', kept.saysSegment === true);
  check('and the reason it gave', kept.saysWhy === true);

  /* ---- and the report leads with what was missed -------------------------- */
  console.log('\n  the report');
  await shape(HOLE, 1189.9);
  const report = await page.evaluate(() => {
    playback.noteGap(1179.5, 1189.9);
    return playback.report();
  });
  const line = (name) => (report.split('\n').find((l) => l.startsWith(name)) || '').trim();
  console.log('   ', JSON.stringify(line('skipped')));
  console.log('   ', JSON.stringify(line('holes now')));
  check('says what was skipped', /10\.4s at 1179\.5/.test(line('skipped')), line('skipped'));
  check('and what is still missing from the buffer',
    /1179\.5→1189\.5 \(10\.0s\)/.test(line('holes now')), line('holes now'));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
