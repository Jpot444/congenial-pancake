/**
 * Continue watching, for a show.
 *
 * Clicking it used to land on the show's page — the exact work the row exists
 * to skip. It now plays the episode. The other half of the ask is that the
 * player's Series button then goes to that show's page rather than back home,
 * so what is really under test is that the page is genuinely underneath the
 * player and not somewhere the back button has to go and fetch.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const EPISODES = {
  1: [
    { id: 101, episode_num: 1, title: 'Pilot', container_extension: 'mp4', info: { duration: '00:22:00' } },
    { id: 102, episode_num: 2, title: 'Second', container_extension: 'mp4', info: { duration: '00:22:00' } },
    { id: 103, episode_num: 3, title: 'Third', container_extension: 'mp4', info: { duration: '00:22:00' } },
  ],
  2: [
    { id: 201, episode_num: 1, title: 'Season Two Opener', container_extension: 'mp4', info: { duration: '00:22:00' } },
  ],
};

// What the taste endpoint hands the home screen: a show, mid-episode.
const RECENT = [{
  kind: 'series', id: 77, seriesId: 77, seriesName: 'A Show', name: 'A Show — S1E2',
  poster: '', season: 1, episode: 2, position: 400, duration: 1320, completed: false,
  key: 'series:77:s1e2',
}];

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  let seriesInfoCalls = 0;
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_series_info') {
      seriesInfoCalls += 1;
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: { plot: 'A show about a show.' }, episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  // The app refetches taste as it plays, and whatever this returns replaces
  // state.recentlyWatched. Serving a fixed list quietly put the show back on
  // the home screen under every later section, so the stub tracks what the
  // test is simulating instead.
  let recentRows = RECENT;
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ recentlyWatched: recentRows, categoryAffinity: [], ratings: {} }) }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  /**
   * Put a row on the home screen and wait for THAT row to be the one there.
   * Waiting for any `.home-recent .card` matches the previous section's card,
   * which is still on screen for a moment — and clicking it tests nothing.
   */
  const showHome = async (rows, expectText) => {
    recentRows = rows;
    await page.evaluate((r) => {
      state.recentlyWatched = r;
      state.seriesCache = {};
      state.tab = 'home';
      location.hash = '#/home';
      render();
    }, rows);
    await page.waitForFunction(
      (want) => {
        const card = document.querySelector('.home-recent .card');
        return Boolean(card) && card.textContent.includes(want);
      },
      expectText,
      { timeout: 10000 },
    );
  };

  const seed = async () => page.evaluate((recent) => {
    state.library.series = {
      categories: [{ id: 'c1', name: 'Drama' }],
      items: [{ kind: 'series', id: 77, name: 'A Show', logo: '', categoryId: 'c1' }],
    };
    state.recentlyWatched = recent;
    state.seriesCache = {};
    location.hash = '#/home';
    render();
  }, RECENT);

  await seed();
  await page.waitForSelector('.home-recent .card', { timeout: 10000 });
  check('the show is on the home screen',
    (await page.locator('.home-recent .card-title').first().textContent()) === 'A Show');

  // --- clicking it plays, rather than opening the page ---------------------
  console.log('\n  clicking Continue watching');
  await page.locator('.home-recent .card').first().click();
  await wait(3500);

  const playing = await page.evaluate(() => ({
    playerUp: !document.querySelector('#playerOverlay').hidden,
    src: document.querySelector('#video').currentSrc,
    sub: document.querySelector('#cinemaSub').textContent,
    back: document.querySelector('#cinemaBackLabel').textContent,
    hash: location.hash,
    row: [...document.querySelectorAll('.show-card .ep')]
      .findIndex((r) => r.classList.contains('is-playing')),
    queued: upNext.candidate?.label ?? null,
    pending: state.resumeEpisode,
  }));
  console.log('  ', JSON.stringify(playing));

  check('the player is up', playing.playerUp);
  check('and something is actually playing',
    playing.src.includes('fake-stream'), playing.src);
  check('it is the episode that was left off, not episode one',
    /S1 · E2|S1E2/.test(playing.sub), playing.sub);
  check('the show page is underneath, with that episode marked',
    playing.row === 1, String(playing.row));
  check('the next episode is queued, same as picking it by hand',
    playing.queued === 'S1 · E3 — Third', String(playing.queued));
  check('the request does not linger in the state',
    playing.pending === null, JSON.stringify(playing.pending));

  // --- the back button lands on the card ----------------------------------
  console.log('\n  the Series button');
  check('the back button is labelled for the show', playing.back === 'Series', playing.back);
  // Through the DOM: the chrome fades out over the video, which is exactly
  // the state someone is in when they reach for the back button.
  await page.evaluate(() => document.querySelector('#cinemaBack').click());
  await wait(1200);

  const back = await page.evaluate(() => ({
    hash: location.hash,
    playerUp: !document.querySelector('#playerOverlay').hidden,
    cardUp: Boolean(document.querySelector('.show-card')),
    episodes: document.querySelectorAll('.show-card .ep').length,
    title: document.querySelector('.show-card .title-name')?.textContent
      || document.querySelector('.show-card h1, .show-card h2')?.textContent || '',
  }));
  console.log('  ', JSON.stringify(back));
  check('it leaves the player', !back.playerUp);
  check('and lands on the show, not home', back.hash === '#/series/77', back.hash);
  check('with the card really drawn', back.cardUp && back.episodes === 3,
    JSON.stringify(back));

  // The page was built on the way in, so going back must not refetch it.
  const callsBefore = seriesInfoCalls;
  await wait(600);
  check('and without going back to the provider for it',
    seriesInfoCalls === callsBefore, `${seriesInfoCalls} calls`);

  // --- a film still goes straight in --------------------------------------
  console.log('\n  a film is unchanged');
  await page.evaluate(() => {
    state.library.movies = {
      categories: [{ id: 'm1', name: 'Films' }],
      items: [{ kind: 'movie', id: 55, name: 'A Film', logo: '', categoryId: 'm1' }],
    };
  });
  await showHome([{
    kind: 'movie', id: 55, name: 'A Film', poster: '',
    position: 300, duration: 5400, completed: false, key: 'movie:55',
  }], 'A Film');
  await page.locator('.home-recent .card').first().click();
  await wait(3000);
  const film = await page.evaluate(() => ({
    playerUp: !document.querySelector('#playerOverlay').hidden,
    src: document.querySelector('#video').currentSrc,
    back: document.querySelector('#cinemaBackLabel').textContent,
  }));
  check('a film plays straight from the home screen',
    film.playerUp && film.src.includes('fake-stream'), JSON.stringify(film));
  check('and its back button points at the film page', film.back === 'Movies', film.back);
  await page.evaluate(() => closePlayer());

  // --- an episode the provider dropped ------------------------------------
  console.log('\n  an episode that is no longer listed');
  await showHome([{
    kind: 'series', id: 77, seriesId: 77, seriesName: 'A Show', name: 'A Show — S9E9',
    poster: '', season: 9, episode: 9, position: 100, duration: 1320, completed: false,
    key: 'series:77:s9e9',
  }], 'S9\u00b7E9');
  await page.locator('.home-recent .card').first().click();
  await wait(3000);
  const missing = await page.evaluate(() => ({
    playerUp: !document.querySelector('#playerOverlay').hidden,
    cardUp: Boolean(document.querySelector('.show-card')),
    hash: location.hash,
    pending: state.resumeEpisode,
  }));
  console.log('  ', JSON.stringify(missing));
  check('the player does not sit there empty', !missing.playerUp, JSON.stringify(missing));
  check('the show page is what you get instead', missing.cardUp && missing.hash === '#/series/77',
    JSON.stringify(missing));
  check('and the dead request is not left armed for the next show',
    missing.pending === null, JSON.stringify(missing.pending));

  // Opening another show now must not fire the stale request.
  await page.evaluate(() => { location.hash = '#/series/77'; render(); });
  await wait(1500);
  check('opening a show by hand still just shows it',
    await page.locator('#playerOverlay').isHidden());

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
