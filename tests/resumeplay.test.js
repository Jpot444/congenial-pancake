/**
 * Resume has to actually resume.
 *
 * "a lot of the time I click the resume button on a series or movie and it
 *  restarts the whole thing"
 *
 * Two faults, and the first one is most of a library.
 *
 * THE MARK WAS DROPPED. Every road out of resolveStream honours the resume
 * point except one: a conversion is STARTED at the mark, a downloaded file and
 * an archive file seek themselves — but a title the provider already ships in
 * a container the browser opens goes through /api/play, and that branch
 * computed the mark, took it as an argument, and returned without it. The
 * player was handed no seek and played from zero.
 *
 * That is not a corner: NATIVE_CONTAINERS is mp4, m4v and mov, and this
 * provider's episodes are very often mp4. Anything needing a remux resumed
 * correctly, which is why it looked intermittent rather than broken.
 *
 * THE BUTTON AND THE PLAYER DISAGREED. The page decided whether to draw
 * "Resume 0:40" from the progress stripe's test — anything past one per cent
 * of the runtime — and the player decided whether to honour it from another:
 * at least a minute in. A forty-second stop in a forty-five minute episode
 * passes the first and fails the second, so the button offered a resume the
 * player had already decided to refuse, and refusing meant starting over.
 *
 * What is measured is where playback ends up: the seek the player is given,
 * and the `start` the box is asked to convert from.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RUNTIME = 5400;          // an hour and a half
const LEFT_AT = 2400;          // forty minutes in

/* Two films: one the browser can open as it stands, one that has to be
   converted. The difference between them is the whole bug. */
const LIBRARY = {
  movies: {
    categories: [{ id: 'm1', name: 'EN - FILMS' }],
    items: [
      { kind: 'movie', id: 600, name: 'Native Copy', categoryId: 'm1', ext: 'mp4', logo: '' },
      { kind: 'movie', id: 601, name: 'Needs Converting', categoryId: 'm1', ext: 'mkv', logo: '' },
    ],
  },
  series: { categories: [], items: [] },
  live: {
    categories: [{ id: 'c1', name: 'US| SPORTS' }],
    items: [{ kind: 'live', id: 900, name: 'US| MLB NETWORK', categoryId: 'c1', logo: '' }],
  },
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library*', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(LIBRARY[tab] || { categories: [], items: [] }) });
  });
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/downloads*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"active":null}' }));

  /* Where this profile left each title. */
  const positions = { 'movie:600': LEFT_AT, 'movie:601': LEFT_AT };
  await page.route('**/api/profiles/*/progress*', (r) => {
    const key = new URL(r.request().url()).searchParams.get('key');
    const at = positions[key];
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(at === undefined
        ? { found: false }
        : { found: true, position: at, duration: RUNTIME, completed: false }) });
  });

  /* What the box was asked for. `start` is the conversion's mark; a title that
     needs no conversion never reaches it and has to be seeked instead. */
  const plays = [];
  const remuxes = [];
  await page.route('**/api/play*', (r) => {
    const q = new URL(r.request().url()).searchParams;
    plays.push({ kind: q.get('kind'), id: q.get('id') });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/stream?u=abc","format":"file"}' });
  });
  await page.route('**/api/remux*', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/remux/status') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"seconds":90,"complete":true,"target":45,"failed":false}' });
    }
    if (url.pathname === '/api/remux/stop') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    const start = Math.floor(Number(url.searchParams.get('start') || 0));
    remuxes.push({ id: url.searchParams.get('id'), start });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/hls/s1/index.m3u8', format: 'm3u8', session: 's1',
        prebuffer: 45, offset: start, sourceDuration: RUNTIME, subs: [] }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }

  /* The media element, with a real duration and a clock the suite can read.
     Where the playhead ends up is the only thing this suite is about. */
  await page.evaluate(() => {
    const video = document.querySelector('#video');
    window.__seeks = [];
    let t = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return t; },
      set(v) { t = v; window.__seeks.push(Math.round(v)); },
    });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 5400 });
    video.play = () => Promise.resolve();
    /* The player seeks on `loadedmetadata`, which never fires for a source
       that is not really being fetched. Firing it is what stands in for the
       browser having opened the file. */
    const realAttr = video.setAttribute.bind(video);
    Object.defineProperty(video, 'src', {
      configurable: true,
      set(v) {
        realAttr('src', v);
        setTimeout(() => video.dispatchEvent(new Event('loadedmetadata')), 20);
      },
      get() { return video.getAttribute('src') || ''; },
    });
  });

  await page.evaluate((lib) => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    Object.assign(state.library, lib);
    state.recentlyWatched = [
      { key: 'movie:600', kind: 'movie', id: 600, name: 'Native Copy',
        position: 2400, duration: 5400, at: Date.now() },
      { key: 'movie:601', kind: 'movie', id: 601, name: 'Needs Converting',
        position: 2400, duration: 5400, at: Date.now() - 1000 },
    ];
  }, LIBRARY);

  const openAndWatch = async (item, resume) => {
    await page.evaluate(() => { window.__seeks = []; });
    await page.evaluate(({ it, r }) => openPlayer(it, { resume: r }), { it: item, r: resume });
    await wait(1800);
    return page.evaluate(() => window.__seeks);
  };

  /* ---- 1. a film the browser can open as it stands ---------------------- */
  /*
   * The reported failure. Nothing to convert, so nothing was started at a
   * mark — and nothing seeked either.
   */
  console.log('\n  resuming a film that needs no conversion');
  const nativeSeeks = await openAndWatch(LIBRARY.movies.items[0], 'resume');
  console.log('   asked the box for:', JSON.stringify(plays));
  console.log('   the player seeked to:', JSON.stringify(nativeSeeks));
  check('the box is asked to play it', plays.length === 1, JSON.stringify(plays));
  check('and the player is put where it was left',
    nativeSeeks.includes(LEFT_AT), JSON.stringify(nativeSeeks));
  check('rather than at the beginning',
    !nativeSeeks.length || nativeSeeks[nativeSeeks.length - 1] !== 0,
    JSON.stringify(nativeSeeks));

  /* ---- 2. and the conversion path, which always worked ------------------ */
  /*
   * Kept, because it is the half that made this look intermittent: anything
   * needing a remux resumed correctly all along, so whether Resume worked
   * depended on a container.
   */
  console.log('\n  resuming one that has to be converted');
  await page.evaluate(() => closePlayer());
  await wait(300);
  remuxes.length = 0;
  await openAndWatch(LIBRARY.movies.items[1], 'resume');
  console.log('   the box was asked to convert from:', JSON.stringify(remuxes));
  check('the conversion is started at the mark',
    remuxes.length === 1 && remuxes[0].start === LEFT_AT, JSON.stringify(remuxes));

  /* ---- 3. Start over really starts over --------------------------------- */
  console.log('\n  starting one over on purpose');
  await page.evaluate(() => closePlayer());
  await wait(300);
  plays.length = 0;
  const overSeeks = await openAndWatch(LIBRARY.movies.items[0], 'restart');
  console.log('   the player seeked to:', JSON.stringify(overSeeks));
  check('nothing carries the old position in',
    !overSeeks.includes(LEFT_AT), JSON.stringify(overSeeks));

  /* ---- 4. the button and the player agree ------------------------------- */
  /*
   * The other half. A forty-second stop in a long title passes the stripe's
   * test and fails the player's, so the page used to draw "Resume 0:40" and
   * then hand the player a decision it had already made against.
   */
  console.log('\n  a stop too early to be worth resuming');
  const early = await page.evaluate(() => ({
    stripe: watchedProgress({ kind: 'movie', id: 600 }),
    offered: worthResuming({ position: 40, duration: 5400, completed: false }),
    player: worthResuming({ position: 40, duration: 5400, completed: false }),
  }));
  console.log('   ', JSON.stringify(early));
  check('the page does not offer to resume from it',
    early.offered === false, JSON.stringify(early));
  check('and the page and the player use the one rule',
    early.offered === early.player, JSON.stringify(early));

  const late = await page.evaluate(() => ({
    ok: worthResuming({ position: 2400, duration: 5400, completed: false }),
    finished: worthResuming({ position: 5300, duration: 5400, completed: false }),
    marked: worthResuming({ position: 2400, duration: 5400, completed: true }),
  }));
  console.log('   ', JSON.stringify(late));
  check('a real stop is still worth resuming', late.ok === true, JSON.stringify(late));
  check('one at the very end is not', late.finished === false, JSON.stringify(late));
  check('nor one already finished', late.marked === false, JSON.stringify(late));

  /* ---- 5. live is exempt ------------------------------------------------ */
  /*
   * A channel has no position to go back to, and a seek into one would land
   * somewhere meaningless inside its window.
   */
  console.log('\n  and a channel is not seeked anywhere');
  await page.evaluate(() => closePlayer());
  await wait(300);
  const liveSeeks = await openAndWatch(LIBRARY.live.items[0], 'ask');
  console.log('   the player seeked to:', JSON.stringify(liveSeeks));
  check('nothing seeks a live channel', !liveSeeks.some((s) => s > 0),
    JSON.stringify(liveSeeks));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
