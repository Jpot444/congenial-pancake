/**
 * A film's own page: the same card as a show, with one button and a runtime
 * where the seasons and episodes would be.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const SHOTS = __dirname + '/shots';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGP8//' +
  '8/AzJgYkAD5AsAAP//DkYCbYrGZ2sAAAAASUVORK5CYII=', 'base64');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/img?u=*', (r) => {
    const u = new URL(r.request().url()).searchParams.get('u') || '';
    if (!/^https?:\/\//.test(u)) return r.fulfill({ status: 404, body: 'Not found' });
    return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  let vodCalls = 0;
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_vod_info') {
      vodCalls += 1;
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {
          releasedate: '2014', genre: 'Sci-Fi',
          plot: 'A farmer goes to space about it.',
          duration: '02:49:00', duration_secs: 10140 } }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/downloads*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  await page.evaluate(() => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    state.library.movies = {
      categories: [{ id: 'c1', name: 'Sci-Fi' }],
      // mp4 so playback resolves through /api/play rather than the remuxer:
      // this suite is about the card, and the conversion path has suites of
      // its own. A .mkv here would need the whole remux pipeline stubbed to
      // answer one question the card does not ask.
      items: [{ kind: 'movie', id: 55, name: 'A Film', categoryId: 'c1', rating: '8.6',
        ext: 'mp4', logo: `/img?u=${encodeURIComponent('http://provider/film.jpg')}` }],
    };
  });

  // --- the card ----------------------------------------------------------
  console.log('\n  opening a film');
  await page.evaluate(() => { location.hash = '#/movies/55'; });
  await page.waitForSelector('.play-title', { timeout: 10000 });
  await wait(800);

  const card = await page.evaluate(() => {
    const poster = document.querySelector('.show-poster img');
    const play = document.querySelector('.play-title').getBoundingClientRect();
    const list = document.querySelector('.show-card .ep-list');
    return {
      title: document.querySelector('.show-title').textContent,
      meta: document.querySelector('.show-meta').textContent,
      plot: document.querySelector('.show-plot').textContent,
      plotShown: !document.querySelector('.show-plot').hidden,
      runtime: document.querySelector('.title-runtime').textContent,
      posterLoaded: Boolean(poster) && poster.naturalWidth > 0,
      posterRight: poster ? poster.getBoundingClientRect().right : 0,
      playLeft: play.left,
      hasEpisodes: Boolean(list),
      hasSeasons: Boolean(document.querySelector('.show-card .season-picker')),
      fav: document.querySelector('.show-fav').textContent,
      heading: document.querySelector('#contentTitle').textContent,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  });
  console.log('   ', JSON.stringify(card));
  check('the film is named', card.title === 'A Film', card.title);
  check('the poster loaded rather than falling back to the name',
    card.posterLoaded, JSON.stringify(card));
  check('and sits left of the play button', card.posterRight <= card.playLeft + 1,
    JSON.stringify(card));
  check('the year, genre and rating are there',
    /2014.*Sci-Fi.*8\.6/.test(card.meta), card.meta);
  check('the description is there', /farmer goes to space/.test(card.plot) && card.plotShown,
    card.plot);
  check('the runtime is shown, formatted', card.runtime === '2:49:00', card.runtime);
  check('there are no seasons on a film', !card.hasSeasons);
  check('and no episode list', !card.hasEpisodes);
  check('favorites works the same as on a show', /favorites/i.test(card.fav), card.fav);
  check('the heading is the section, not the title twice', card.heading === 'Movies',
    card.heading);
  check('nothing overflows sideways', card.docW <= card.winW + 1,
    `${card.docW} vs ${card.winW}`);
  check('the player is not open', await page.locator('#playerOverlay').isHidden());
  check('the details were asked for once', vodCalls === 1, String(vodCalls));
  await page.screenshot({ path: SHOTS + '/moviecard.png' });

  // --- play ---------------------------------------------------------------
  console.log('\n  pressing play');
  await page.locator('.play-title').click();
  await wait(3000);
  const playing = await page.evaluate(() => ({
    open: !document.querySelector('#playerOverlay').hidden,
    title: document.querySelector('#playerTitle').textContent,
    src: document.querySelector('#video').currentSrc,
    backLabel: document.querySelector('#cinemaBackLabel').textContent,
  }));
  console.log('   ', JSON.stringify(playing));
  check('the player opens', playing.open, JSON.stringify(playing));
  check('on the right film', playing.title === 'A Film', playing.title);
  check('and is really playing', playing.src.includes('fake-stream'), playing.src);
  check('the details were not fetched a second time', vodCalls === 1, String(vodCalls));

  // --- back lands on the film's page --------------------------------------
  await page.evaluate(() => document.querySelector('#cinemaBack').click());
  await wait(1200);
  const back = await page.evaluate(() => ({
    hash: location.hash,
    cardShown: !document.querySelector('#seriesView').hidden,
    playShown: Boolean(document.querySelector('.play-title')),
    playerShut: document.querySelector('#playerOverlay').hidden,
  }));
  console.log('   ', JSON.stringify(back));
  check('back from the player lands on the film', back.hash === '#/movies/55', back.hash);
  check('with its card showing', back.cardShown && back.playShown, JSON.stringify(back));
  check('and the player shut', back.playerShut);

  await page.evaluate(() => document.querySelector('.show-back').click());
  await wait(1000);
  check('the back link leaves the film',
    (await page.evaluate(() => location.hash)) === '#/movies');

  // --- the download button beside favorites --------------------------------
  console.log('\n  the download button on the card');
  const dlBtn = await page.evaluate(async () => {
    location.hash = '#/movies/55';
    await new Promise((r) => setTimeout(r, 800));
    state.downloads = { items: [], active: null, queued: 0 };
    render();
    await new Promise((r) => setTimeout(r, 400));
    const fresh = document.querySelector('.show-dl')?.textContent;
    state.downloads = { items: [
      { id: 'x', kind: 'movie', streamId: '55', status: 'done', name: 'film' },
    ], active: null, queued: 0 };
    render();
    await new Promise((r) => setTimeout(r, 400));
    return {
      fresh,
      saved: document.querySelector('.show-dl')?.textContent,
      besideFav: Boolean(document.querySelector('.show-actions .show-fav')
        && document.querySelector('.show-actions .show-dl')),
    };
  });
  console.log('   ', JSON.stringify(dlBtn));
  check('a film card offers a download beside favorites',
    dlBtn.besideFav && dlBtn.fresh === 'Download', JSON.stringify(dlBtn));
  check('and says so when the film is already on the box',
    dlBtn.saved === 'Downloaded', JSON.stringify(dlBtn));

  // --- a channel still tunes straight in ----------------------------------
  console.log('\n  live is untouched');
  const liveHash = await page.evaluate(async () => {
    const before = location.hash;
    openTitle({ kind: 'live', id: 9, name: 'A Channel' });
    return { before, after: location.hash };
  });
  check('a channel does not get a page of its own',
    liveHash.after === liveHash.before, JSON.stringify(liveHash));
  await page.evaluate(() => closePlayer());

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
