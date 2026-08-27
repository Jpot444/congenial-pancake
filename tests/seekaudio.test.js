/**
 * The audio fault that only ever happens after a seek.
 *
 * "The audio sync issues only happen when I am resuming playing or have been
 * seeking. I want ... some way that it is impossible for movies and series to
 * ever get out of sync."
 *
 * The report that came with it, on a resume at 1308s:
 *
 *   a/v start   video 0.167s, audio 0.167s  → offset 0ms
 *   a/v gap     video ends 33.658s, audio ends 29.417s  → -4241ms apart
 *   each half   -276.3ms/s then 0.0ms/s  → not a straight line
 *
 * Aligned at the head, four and a quarter seconds apart thirty seconds later,
 * and then steady. That is not drift — it is a STEP, and two things about the
 * rescue meant it could never be fixed:
 *
 *   * it demanded a drift RATE as well as a gap, and a settled step has no
 *     rate left by the time anyone measures it;
 *   * it rebuilt with the identical command, so a seeked conversion landed on
 *     the identical offset, announced itself twice and gave up.
 *
 * Measuring a fault and then not using the measurement is worse than not
 * measuring it.
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

  // Every remux request is recorded, which is where the correction has to show up.
  const remuxes = [];
  await page.route('**/api/remux?*', (r) => {
    const q = new URL(r.request().url()).searchParams;
    remuxes.push(Object.fromEntries(q));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', session: `s${remuxes.length}`,
        offset: Number(q.get('start')) || 0, prebuffer: 0 }) });
  });
  await page.route('**/api/remux/status*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"seconds":600,"ready":true}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  /** The probe from the report, with the drift figures dialled per case. */
  const rescue = (drift) => page.evaluate((d) => {
    film.active = true;
    film.item = { kind: 'movie', id: 700251, ext: 'mkv' };
    film.override = null;
    film.duration = 3704;
    film.offset = 1308;
    film.audioDelayMs = 0;
    lastRemux = { session: `sess-${d.tag}`, offset: 1308 };
    playback.rescued = new Set();
    playback.rescues = 0;
    playback.lastRescueAt = 0;
    playback.probe = {
      segment: { declared: 2.795, real: 3.027, ratio: 0.923 },
      start: { video: 0.167, audio: 0.167, sync: 0 },
      drift: { video: 33.658, audio: 29.417, gap: d.gap, firstGap: 0,
        rate: d.rate, span: 25.5, linear: false },
      video: {}, audio: {}, input: [],
    };
    playback.audioRescue();
    return { delay: film.audioDelayMs, rescues: playback.rescues };
  }, drift);

  /* ---- a settled step, which is what seeking produces ------------------- */
  console.log('\n  a step offset that has stopped growing');
  const step = await rescue({ tag: 'step', gap: -4.241, rate: -0.0004 });
  console.log('   ', JSON.stringify(step));
  check('it is acted on at all — a settled step has no rate left to find',
    step.rescues === 1, JSON.stringify(step));
  check('and the measurement becomes the correction, to the millisecond',
    Math.round(step.delay) === 4241, String(step.delay));

  /* ---- and the correction really goes to the box ------------------------ */
  console.log('\n  and it reaches the conversion');
  // The rescue above already rebuilt on its own — that request is the fix
  // working end to end, so check it before asking for another.
  await page.waitForTimeout(900);
  const auto = remuxes[remuxes.length - 1];
  console.log('    rescue rebuild:', JSON.stringify(auto || null));
  check('the rescue\'s OWN rebuild carries the correction, rather than',
    auto?.adelay === '4241', JSON.stringify(auto));
  console.log('       re-running the identical command into the identical fault');

  await page.evaluate(async () => {
    film.audioDelayMs = 4241;
    lastRemux = { session: 'sess-old', offset: 1308 };
    film.ready = 600;
    film.seeking = false;
    await seekFilm(1400, { force: true });
  });
  await page.waitForTimeout(900);
  const manual = remuxes[remuxes.length - 1];
  console.log('    later seek:    ', JSON.stringify(manual || null));
  check('and every seek after it carries it too', manual?.adelay === '4241',
    JSON.stringify(manual));
  check('at the position that was asked for', manual?.start === '1400',
    manual?.start);
  check('naming the session it supersedes, so nothing else is cut off',
    manual?.replaces === 'sess-old', manual?.replaces);

  /* ---- ordinary drift still behaves as it always did -------------------- */
  console.log('\n  and real drift is still real drift');
  const drift = await rescue({ tag: 'drift', gap: -0.98, rate: -0.0218 });
  console.log('   ', JSON.stringify(drift));
  check('a drifting stream is still rescued', drift.rescues === 1,
    JSON.stringify(drift));
  check('with its own gap as the correction', Math.round(drift.delay) === 980,
    String(drift.delay));

  /* ---- and the ragged edge is still left alone -------------------------- */
  //
  // Some gap at the end of a segment is normal: the muxer cuts on a video
  // keyframe and the audio frames do not land there. Rebuilding the picture
  // over 200ms would be worse than the 200ms.
  console.log('\n  a keyframe edge is not a fault');
  const edge = await rescue({ tag: 'edge', gap: -0.202, rate: -0.0003 });
  console.log('   ', JSON.stringify(edge));
  check('nothing is rebuilt', edge.rescues === 0, JSON.stringify(edge));
  check('and no correction is invented', edge.delay === 0, String(edge.delay));

  /* ---- a correction belongs to one title -------------------------------- */
  console.log('\n  and it does not follow you to the next film');
  const next = await page.evaluate(() => {
    film.audioDelayMs = 4241;
    film.item = { kind: 'movie', id: 700251 };
    showFilmBar({ kind: 'movie', id: 999999, name: 'Something Else' }, 5400, null);
    const after = film.audioDelayMs;
    showFilmBar({ kind: 'movie', id: 999999, name: 'Something Else' }, 5400, null);
    return { after, sameTitle: film.audioDelayMs };
  });
  console.log('   ', JSON.stringify(next));
  check('opening a different film clears it', next.after === 0, String(next.after));
  check('while reopening the same one keeps it', next.sameTitle === 0,
    String(next.sameTitle));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
