/**
 * A show's own page: poster left, seasons above the episodes, and the player's
 * back button landing on it rather than on the grid.
 *
 * Driven through the real router and the real library, with only the provider
 * stubbed, because the parts most likely to be wrong are the routing and the
 * return path rather than the markup.
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

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));

  // The series tab reloads taste on every visit, clobbering anything a test
  // plants in state directly — so the history rows are served from here.
  let tasteRows = [];
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ recentlyWatched: tasteRows, categoryAffinity: [], ratings: {} }) }));
  const setTaste = async (rows) => { tasteRows = rows; };

  // A real image behind the poster proxy, so "did it load" can be answered by
  // whether the browser decoded it rather than by what the src attribute says.
  // A 2x3 PNG: the src being right is not the same as the picture arriving.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGP8//' +
    '8/AzJgYkAD5AsAAP//DkYCbYrGZ2sAAAAASUVORK5CYII=', 'base64');
  let posterHits = 0;
  await page.route('**/img?u=*', (r) => {
    posterHits += 1;
    // Mirrors the real proxy, which fetches `u` over http and 404s anything it
    // cannot: answering every request would let a URL wrapped around itself
    // sail through here and fail only on the box.
    const u = new URL(r.request().url()).searchParams.get('u') || '';
    if (!/^https?:\/\//.test(u)) return r.fulfill({ status: 404, body: 'Not found' });
    return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_series_info') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          info: { releaseDate: '2019', genre: 'Drama', plot: 'A show about a thing.' },
          episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  // A library with one show in it, so the grid has something to click.
  await page.evaluate(() => {
    state.library.series = {
      categories: [{ id: 'c1', name: 'Drama' }],
      // Shaped the way loadTab leaves them: the logo has already been run
      // through img(), so it arrives as a proxy path.
      items: [{ kind: 'series', id: 77, name: 'A Show', categoryId: 'c1', rating: '8.1',
        logo: `/img?u=${encodeURIComponent('http://provider/poster.jpg')}` }],
    };
  });

  // --- the route opens the card ------------------------------------------
  console.log('\n  opening a show');
  await page.evaluate(() => { location.hash = '#/series/77'; });
  await page.waitForSelector('.show-card .ep', { timeout: 10000 });

  const shape = await page.evaluate(() => {
    const poster = document.querySelector('.show-poster').getBoundingClientRect();
    const picker = document.querySelector('.show-card .season-picker').getBoundingClientRect();
    const list = document.querySelector('.show-card .ep-list').getBoundingClientRect();
    return {
      poster: { left: poster.left, right: poster.right, top: poster.top },
      picker: { left: picker.left, top: picker.top },
      list: { left: list.left, top: list.top },
      title: document.querySelector('.show-title').textContent,
      heading: document.querySelector('#contentTitle').textContent,
      backVisible: (() => {
        const b = document.querySelector('.show-back');
        const st = getComputedStyle(b);
        return { text: b.textContent.trim(), bg: st.backgroundColor, color: st.color };
      })(),
      meta: document.querySelector('.show-meta').textContent,
      plot: document.querySelector('.show-plot').textContent,
      seasons: [...document.querySelectorAll('.show-card .season-chip[data-season]')].map((c) => c.textContent),
      episodes: [...document.querySelectorAll('.show-card .ep-name')].map((e) => e.textContent),
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  });
  console.log('   ', JSON.stringify({ seasons: shape.seasons, episodes: shape.episodes }));
  // The fault this caught: loadTab has already proxied every logo, so wrapping
  // it again pointed the proxy at itself and the card printed the show's name
  // where the poster should be.
  const poster = await page.evaluate(() => {
    const image = document.querySelector('.show-poster img');
    if (!image) return { missing: true,
      fallback: document.querySelector('.show-poster .fallback')?.textContent || '' };
    return { src: image.getAttribute('src'), complete: image.complete,
      w: image.naturalWidth, h: image.naturalHeight };
  });
  console.log('   poster:', JSON.stringify(poster), 'proxy hits', posterHits);
  check('the poster is an image, not the show\'s name in a box', !poster.missing,
    JSON.stringify(poster));
  check('and it actually decoded', poster.w > 0 && poster.h > 0, JSON.stringify(poster));
  check('the proxy path is used once, not wrapped around itself',
    poster.src === `/img?u=${encodeURIComponent('http://provider/poster.jpg')}`, poster.src);
  check('the proxy was really asked for it', posterHits >= 1, String(posterHits));

  check('the show is named', shape.title === 'A Show', shape.title);
  check('and not printed twice down the page', shape.heading === 'Series', shape.heading);
  check('the back link reads as a button rather than a white slab',
    shape.backVisible.bg !== 'rgb(255, 255, 255)'
      && shape.backVisible.color !== shape.backVisible.bg,
    JSON.stringify(shape.backVisible));
  check('and says where it goes', /All series/.test(shape.backVisible.text),
    shape.backVisible.text);
  check('with its year, genre and rating', /2019.*Drama.*8\.1/.test(shape.meta), shape.meta);
  check('and its synopsis', /A show about a thing/.test(shape.plot), shape.plot);
  check('the poster is on the left of the episodes',
    shape.poster.right <= shape.list.left + 1, JSON.stringify(shape));
  check('the seasons bar sits above the episode names',
    shape.picker.top < shape.list.top, JSON.stringify(shape));
  check('and is aligned with them, not with the poster',
    Math.abs(shape.picker.left - shape.list.left) < 2, JSON.stringify(shape));
  check('every season is offered', shape.seasons.join(',') === 'Season 1,Season 2',
    shape.seasons.join(','));
  check('the first season\'s episodes are listed',
    shape.episodes.join(',') === 'Pilot,Second,Third', shape.episodes.join(','));
  check('nothing overflows sideways', shape.docW <= shape.winW + 1,
    `${shape.docW} vs ${shape.winW}`);
  check('the player is not open', await page.locator('#playerOverlay').isHidden());
  await page.screenshot({ path: SHOTS + '/showcard.png' });

  // --- the seasons bar switches the list ---------------------------------
  await page.evaluate(() =>
    [...document.querySelectorAll('.show-card .season-chip[data-season]')]
      .find((c) => c.textContent === 'Season 2').click());
  await wait(400);
  const s2 = await page.evaluate(() =>
    [...document.querySelectorAll('.show-card .ep-name')].map((e) => e.textContent));
  check('picking a season swaps the episodes', s2.join(',') === 'Season Two Opener',
    s2.join(','));

  // --- picking an episode plays it ---------------------------------------
  console.log('\n  playing an episode');
  await page.evaluate(() =>
    [...document.querySelectorAll('.show-card .season-chip[data-season]')]
      .find((c) => c.textContent === 'Season 1').click());
  await wait(300);
  await page.evaluate(() => document.querySelectorAll('.show-card .ep')[1].click());
  await wait(3000);
  const playing = await page.evaluate(() => ({
    open: !document.querySelector('#playerOverlay').hidden,
    sub: document.querySelector('#cinemaSub').textContent,
    src: document.querySelector('#video').currentSrc,
    backLabel: document.querySelector('#cinemaBackLabel').textContent,
  }));
  console.log('   ', JSON.stringify(playing));
  check('the player opens', playing.open);
  check('on the episode that was picked', /S1 · E2/.test(playing.sub), playing.sub);
  check('and is really playing', playing.src.includes('fake-stream'), playing.src);
  check('the back button says Series', playing.backLabel === 'Series', playing.backLabel);

  // --- and back lands on the card, not the grid --------------------------
  await page.evaluate(() => document.querySelector('#cinemaBack').click());
  await wait(1500);
  const back = await page.evaluate(() => ({
    hash: location.hash,
    cardShown: !document.querySelector('#seriesView').hidden,
    gridShown: !document.querySelector('#grid').hidden,
    playerShut: document.querySelector('#playerOverlay').hidden,
    episodes: [...document.querySelectorAll('.show-card .ep-name')].map((e) => e.textContent),
  }));
  console.log('   ', JSON.stringify(back));
  check('back from the player lands on the show', back.hash === '#/series/77', back.hash);
  check('the card is showing', back.cardShown);
  check('and the grid is not', !back.gridShown);
  check('the player is shut', back.playerShut);
  check('the episode list came back with it',
    back.episodes.join(',') === 'Pilot,Second,Third', back.episodes.join(','));

  // --- leaving the show goes to the grid ---------------------------------
  await page.evaluate(() => document.querySelector('.show-back').click());
  await wait(1200);
  const out = await page.evaluate(() => ({
    hash: location.hash,
    cardShown: !document.querySelector('#seriesView').hidden,
  }));
  check('the back link leaves the show', out.hash === '#/series', out.hash);
  check('and the card is put away', !out.cardShown, JSON.stringify(out));

  // --- the phone stacks it -----------------------------------------------
  console.log('\n  phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { device.setPhone(true); location.hash = '#/series/77'; });
  await page.waitForSelector('.show-card .ep', { timeout: 10000 });
  const phone = await page.evaluate(() => {
    const poster = document.querySelector('.show-poster').getBoundingClientRect();
    const list = document.querySelector('.show-card .ep-list').getBoundingClientRect();
    return { posterBottom: poster.bottom, listTop: list.top, posterW: poster.width,
      docW: document.documentElement.scrollWidth, winW: window.innerWidth };
  });
  console.log('   ', JSON.stringify(phone));
  check('the poster stacks above the episodes rather than beside them',
    phone.posterBottom <= phone.listTop + 1, JSON.stringify(phone));
  check('and does not eat the screen', phone.posterW <= 200, String(phone.posterW));
  check('no sideways scroll on the phone', phone.docW <= phone.winW + 1,
    `${phone.docW} vs ${phone.winW}`);
  await page.screenshot({ path: SHOTS + '/showcard-phone.png' });

  // --- where you left the show -------------------------------------------
  //
  // The card answers "which one was I on?" itself: a strip up top naming the
  // exact episode with a Resume button, the list opening on that season, and
  // the episode row wearing a mark. Asked for in those words by the owner.
  console.log('\n  where you left the show');
  await setTaste([{ kind: 'series', seriesId: 77, id: 201,
    season: 2, episode: 1, position: 600, duration: 1320 }]);
  await page.evaluate(() => { location.hash = '#/series'; });
  await wait(600);
  await page.evaluate(() => { location.hash = '#/series/77'; });
  await page.waitForSelector('.show-card .ep', { timeout: 10000 });
  const left = await page.evaluate(() => ({
    label: document.querySelector('.last-watched-label')?.textContent || '',
    title: document.querySelector('.last-watched-title')?.textContent || '',
    note: document.querySelector('.last-watched-note')?.textContent || '',
    button: document.querySelector('.last-watched-go')?.textContent || '',
    season: document.querySelector('.season-chip.is-active')?.textContent || '',
    marked: [...document.querySelectorAll('.ep.is-last .ep-name')]
      .map((e) => e.textContent),
  }));
  console.log('   ', JSON.stringify(left));
  check('the card says which episode you are on',
    left.label === 'You are on' && /S2 · E1/.test(left.title), JSON.stringify(left));
  check('and how much of it is left', /12:00 left/.test(left.note), left.note);
  check('with a Resume button', left.button === 'Resume', left.button);
  check('the list opens on that season, not season one',
    /Season 2/.test(left.season), left.season);
  check('and the episode row itself is marked',
    left.marked.length === 1 && /Last watched/.test(left.marked[0]),
    JSON.stringify(left.marked));

  // Resume presses play on that exact episode.
  await page.evaluate(() => document.querySelector('.last-watched-go').click());
  await wait(2000);
  const resumed = await page.evaluate(() => ({
    open: !document.querySelector('#playerOverlay').hidden,
    sub: document.querySelector('#playerSub').textContent,
  }));
  check('Resume starts that very episode', resumed.open && /S2 · E1/.test(resumed.sub),
    JSON.stringify(resumed));
  await page.evaluate(() => closePlayer());
  await wait(400);

  // A FINISHED episode hands you the next one instead of a rewatch.
  await setTaste([{ kind: 'series', seriesId: 77, id: 103,
    season: 1, episode: 3, position: 1310, duration: 1320, completed: true }]);
  await page.evaluate(() => { location.hash = '#/series'; });
  await wait(600);
  await page.evaluate(() => { location.hash = '#/series/77'; });
  await page.waitForSelector('.last-watched', { timeout: 10000 });
  const done = await page.evaluate(() => ({
    label: document.querySelector('.last-watched-label')?.textContent || '',
    note: document.querySelector('.last-watched-note')?.textContent || '',
    button: document.querySelector('.last-watched-go')?.textContent || '',
  }));
  console.log('   ', JSON.stringify(done));
  check('a finished episode reads as finished',
    done.label === 'Last watched' && done.note === 'Finished', JSON.stringify(done));
  check('and offers the next one', done.button === 'Play the next one', done.button);
  await page.evaluate(() => document.querySelector('.last-watched-go').click());
  await wait(2000);
  const rolled = await page.evaluate(() => ({
    sub: document.querySelector('#playerSub').textContent,
  }));
  check('which rolls into the following season', /S2 · E1/.test(rolled.sub), rolled.sub);
  await page.evaluate(() => closePlayer());

  // And a show never touched carries none of it.
  await setTaste([]);
  await page.evaluate(() => { location.hash = '#/series'; });
  await wait(600);
  await page.evaluate(() => { location.hash = '#/series/77'; });
  await page.waitForSelector('.show-card .ep', { timeout: 10000 });
  const fresh = await page.evaluate(() => ({
    strip: document.querySelector('.last-watched') !== null,
    season: document.querySelector('.season-chip.is-active')?.textContent || '',
  }));
  check('an unwatched show has no strip and opens on season one',
    !fresh.strip && /Season 1/.test(fresh.season), JSON.stringify(fresh));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
