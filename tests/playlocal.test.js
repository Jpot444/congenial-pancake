/**
 * A copy on the box is played from the box.
 *
 * "sometimes if i press next episode on something I have downloaded Im not
 *  convinced it plays from my pi, i think it is streaming. if i try to play
 *  someting from anywhere, the series card or anything, that I already have
 *  downloaded. I want it to play from my pi if its on its downloads"
 *
 * The intent was always there and so was the line that carries it: before
 * asking the provider for anything, resolveStream looks for a finished
 * download of the same title and plays that instead. What it looks IN is a
 * list the browser happens to be holding — and that list is a snapshot, taken
 * at boot, when the Downloads tab is opened, and before a season is queued.
 * Nothing else refreshed it.
 *
 * So an episode saved this evening and then pressed from the show's page, or
 * reached by Next episode, was checked against a list from before it existed.
 * It found nothing, went to the provider, and spent the account's one
 * connection streaming a file already sitting on the SD card. Which is exactly
 * the suspicion: it looks the same either way.
 *
 * Two things are checked, and the second is why the first was ever in doubt:
 *
 *   IT PLAYS FROM THE BOX, from every road in — the show's page, Next episode,
 *   a card — whether or not the browser had heard about the download yet.
 *
 *   AND IT SAYS SO. A copy on the box and a stream from the provider are
 *   indistinguishable once they are playing, so the player now carries a badge
 *   set from what the resolver actually did.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOW = { kind: 'series', id: 55, name: 'The Long Winter', categoryId: 's1', logo: '' };
const FILM = { kind: 'movie', id: 66, name: 'Redwood Gulch', categoryId: 'm1', ext: 'mp4', logo: '' };

const LIBRARY = {
  series: { categories: [{ id: 's1', name: 'EN - DRAMA' }], items: [SHOW] },
  movies: { categories: [{ id: 'm1', name: 'EN - FILMS' }], items: [FILM] },
  live: { categories: [], items: [] },
};

/* Two episodes. The first is what somebody is watching; the second is what
   Next episode reaches, and it is the one that was downloaded after the page
   was opened. */
const EPISODES = {
  1: [
    { id: 5001, episode_num: 1, title: 'Pilot', container_extension: 'mp4' },
    { id: 5002, episode_num: 2, title: 'Second', container_extension: 'mp4' },
  ],
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
  await page.route('**/api/profiles/*/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_series_info') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {}, episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  /*
   * What the box has on disk. Starts empty, exactly as it would if these were
   * saved after the page was opened — which is the state the whole report
   * lives in.
   */
  let saved = [];
  let downloadAsks = 0;
  await page.route('**/api/downloads*', (r) => {
    if (new URL(r.request().url()).pathname !== '/api/downloads') return r.continue();
    downloadAsks += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: saved, active: null, queued: 0 }) });
  });

  /* Every trip to the provider. If any of these fire for something already on
     disk, the account's one connection has been spent on a local file. */
  const streamed = [];
  await page.route('**/api/play*', (r) => {
    const q = new URL(r.request().url()).searchParams;
    streamed.push({ how: 'play', kind: q.get('kind'), id: q.get('id') });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/stream?u=provider","format":"file"}' });
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
    const q = url.searchParams;
    streamed.push({ how: 'remux', id: q.get('id'), download: q.get('download') });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/hls/s1/index.m3u8', format: 'm3u8', session: 's1',
        prebuffer: 45, offset: 0, subs: [] }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await page.evaluate(() => {
    const video = document.querySelector('#video');
    video.play = () => Promise.resolve();
  });
  await page.evaluate((lib) => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    Object.assign(state.library, lib);
  }, LIBRARY);

  /* What the player was actually pointed at, which is the only thing that
     settles where it is playing from. */
  const wasGiven = () => page.evaluate(() => ({
    src: document.querySelector('#video').getAttribute('src') || '',
    badge: !document.querySelector('#vodSource')?.hidden,
  }));

  /* ---- 1. an episode saved after the page was opened -------------------- */
  /*
   * The reported case. The browser's list is from before this file existed,
   * so the old code checked it, found nothing, and streamed.
   */
  console.log('\n  an episode downloaded since the page was opened');
  saved = [{ id: 'dl1', status: 'done', kind: 'series', streamId: 5002,
    name: 'The Long Winter — S1E2', ext: 'mp4' }];
  streamed.length = 0;
  await page.evaluate(({ show, ep }) => resolveStream(show, {
    kind: 'series', id: ep, ext: 'mp4',
  }), { show: SHOW, ep: 5002 }).catch(() => {});
  await wait(600);
  console.log('   went to the provider:', JSON.stringify(streamed));
  check('nothing is asked of the provider', streamed.length === 0, JSON.stringify(streamed));

  const local = await page.evaluate(({ show, ep }) => resolveStream(show, {
    kind: 'series', id: ep, ext: 'mp4',
  }), { show: SHOW, ep: 5002 });
  console.log('   resolved to:', JSON.stringify(local));
  check('and it resolves to the file on the box',
    /^\/api\/downloads\/dl1\/file$/.test(local.url || ''), JSON.stringify(local));
  check('marked as coming from the box', local.local === true, JSON.stringify(local));

  /* ---- 2. and the same title with nothing saved still streams ----------- */
  /*
   * The rule has to stay a rule about what is actually on disk. A resolver
   * that answered "the box" either way would be no answer.
   */
  console.log('\n  and one that is not on the box');
  streamed.length = 0;
  const away = await page.evaluate(({ show }) => resolveStream(show, {
    kind: 'series', id: 5001, ext: 'mp4',
  }), { show: SHOW });
  console.log('   resolved to:', JSON.stringify(away), JSON.stringify(streamed));
  check('goes to the provider', streamed.length === 1, JSON.stringify(streamed));
  check('and is not marked as local', !away.local, JSON.stringify(away));

  /* ---- 3. what the guarantee costs -------------------------------------- */
  /*
   * One small request to a box on the same network, per play. There is no time
   * window in front of it on purpose: every window wide enough to be worth
   * having is wide enough to miss a download that finished a moment ago, which
   * is exactly when somebody presses play on it.
   *
   * What IS shared is a request already in flight — four multi-view cells
   * starting together are one question, not four.
   */
  console.log('\n  what the guarantee costs');
  downloadAsks = 0;
  await page.evaluate(({ show }) => Promise.all([
    resolveStream(show, { kind: 'series', id: 5002, ext: 'mp4' }),
    resolveStream(show, { kind: 'series', id: 5002, ext: 'mp4' }),
    resolveStream(show, { kind: 'series', id: 5002, ext: 'mp4' }),
    resolveStream(show, { kind: 'series', id: 5002, ext: 'mp4' }),
  ]), { show: SHOW });
  console.log(`   four cells starting at once asked the box ${downloadAsks} time(s)`);
  check('callers starting together share one request',
    downloadAsks === 1, String(downloadAsks));

  /* And opening a title is one request, not the two it would be if the player
     asked for the list and then the resolver asked again. */
  downloadAsks = 0;
  await page.evaluate(() => { closePlayer(); });
  await wait(300);
  await page.evaluate((film) => openPlayer(film, { resume: 'restart' }), FILM);
  await wait(1500);
  console.log(`   opening a title asked the box ${downloadAsks} time(s)`);
  check('and opening a title asks once', downloadAsks === 1, String(downloadAsks));

  /* ---- 4. a film, from a card ------------------------------------------- */
  console.log('\n  a film that is on the box, opened from its card');
  saved = [{ id: 'dl2', status: 'done', kind: 'movie', streamId: 66,
    name: 'Redwood Gulch', ext: 'mp4' }];
  await page.evaluate(() => { closePlayer(); });
  await wait(300);
  streamed.length = 0;
  await page.evaluate((film) => openPlayer(film, { resume: 'restart' }), FILM);
  await wait(1800);
  const film = await wasGiven();
  console.log('   the player was given:', JSON.stringify(film));
  console.log('   went to the provider:', JSON.stringify(streamed));
  check('the player is pointed at the box\'s own file',
    /\/api\/downloads\/dl2\/file/.test(film.src), film.src);
  check('and the provider is never asked', streamed.length === 0, JSON.stringify(streamed));

  /* ---- 5. and it says so ------------------------------------------------ */
  /*
   * The other half of the report — "I'm not convinced" is a request to be able
   * to tell. Set from what the resolver did, so it cannot claim one thing
   * while the player does another.
   */
  check('the player says it is coming from the box', film.badge === true,
    JSON.stringify(film));

  console.log('\n  and a title that really is streaming does not claim otherwise');
  saved = [];
  await page.evaluate(() => { closePlayer(); });
  await wait(300);
  await page.evaluate((f) => openPlayer(f, { resume: 'restart' }), FILM);
  await wait(1800);
  const streaming = await wasGiven();
  console.log('   the player was given:', JSON.stringify(streaming));
  check('no badge on a provider stream', streaming.badge === false,
    JSON.stringify(streaming));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
