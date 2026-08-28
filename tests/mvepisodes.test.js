/**
 * The episode list, inside the cell that is playing the show.
 *
 * The easy way to build this would be a sheet over the whole screen, and it
 * would be the wrong thing to build: the other three cells are still playing,
 * and choosing the next episode of one show is no reason to take the game away
 * from somebody. So the claim with the most checks behind it here is a
 * geometric one — the list stays inside the box it belongs to, and every other
 * cell is still visible and still running while it is open.
 *
 * The way in is the name in the cell's own bar, because that is where the name
 * of the thing already is. It only reads as pressable when there is a show
 * behind it: on a channel or a film the name is a label, and a label that looks
 * pressable is a lie.
 */
const { chromium } = require('./playwright.js');
const { openMultiview, multiviewOffered } = require('./mv.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNELS = [
  { kind: 'live', id: 1, name: 'US| NFL PPV 01', logo: '', categoryId: 'c1' },
  { kind: 'live', id: 2, name: 'US| NBC East', logo: '', categoryId: 'c1' },
];
const SHOW = { kind: 'series', id: 77, name: 'A Show', logo: '', categoryId: 's1' };
const FILM = { kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mkv', categoryId: 'm1' };
const EPISODES = {
  1: [
    { id: 101, episode_num: 1, title: 'Pilot', container_extension: 'mkv' },
    { id: 102, episode_num: 2, title: 'The Second One', container_extension: 'mkv' },
    { id: 103, episode_num: 3, title: 'The Third', container_extension: 'mkv' },
  ],
  2: [
    { id: 201, episode_num: 1, title: 'Season Two Opens', container_extension: 'mkv' },
    { id: 205, episode_num: 5, title: 'The One They Stopped On', container_extension: 'mkv' },
  ],
};

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/api/play*', (r) => {
    if (new URL(r.request().url()).pathname !== '/api/play') return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'm3u8' }) });
  });
  let seriesInfoCalls = 0;
  await page.route('**/api/xtream*', (r) => {
    if (new URL(r.request().url()).searchParams.get('action') === 'get_series_info') {
      seriesInfoCalls += 1;
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {}, episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const remuxAsks = [];
  await page.route('**/api/remux*', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/remux/status') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"seconds":45,"complete":true,"target":45,"failed":false,"error":""}' });
    }
    if (url.pathname === '/api/remux/stop') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"stopped":true}' });
    }
    remuxAsks.push(url.searchParams.get('id'));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ session: 's1', url: '/api/fake-stream', prebuffer: 45 }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate((chans) => {
    state.library.live = { categories: [{ id: 'c1', name: 'US| SPORTS' }], items: chans };
    state.downloads = { items: [], active: null, queued: 0 };
    state.seriesCache = {};
    location.hash = '#/live';
    render();
  }, CHANNELS);
  await wait(600);

  // Two channels and an episode running side by side — the state this is about.
  await openMultiview(page);
  await wait(500);
  await page.evaluate(([chans, show]) => {
    multiview.start(0, chans[0]);
    multiview.start(1, chans[1]);
    multiview.start(2, show, { kind: 'series', id: 205, ext: 'mkv',
      label: `${show.name} — S2E5` });
  }, [CHANNELS, SHOW]);
  await wait(3000);

  // --- the way in ----------------------------------------------------------
  console.log('\n  the name in the bar');
  const names = await page.evaluate(() => multiview.cells.slice(0, 3).map((c) => ({
    text: c.name.textContent,
    link: c.name.classList.contains('is-link'),
    disabled: c.name.disabled,
    tag: c.name.tagName,
  })));
  for (const n of names) console.log('   ', JSON.stringify(n));
  check('the show\'s name is pressable', names[2].link && !names[2].disabled,
    JSON.stringify(names[2]));
  check('and says which episode is on', /S2E5/.test(names[2].text), names[2].text);
  check('while a channel\'s name is not — a label that looks pressable is a lie',
    !names[0].link && names[0].disabled && !names[1].link,
    JSON.stringify([names[0], names[1]]));

  // --- it opens inside its own cell ----------------------------------------
  console.log('\n  where the list opens');
  const before = await page.evaluate(() => multiview.cells.slice(0, 4)
    .map((c) => !c.video.paused));
  await page.evaluate(() => multiview.cells[2].name.click());
  await wait(1200);

  const geom = await page.evaluate(() => {
    const cell = multiview.cells[2].box.getBoundingClientRect();
    const sheet = multiview.cells[2].sheet.getBoundingClientRect();
    const others = multiview.cells.slice(0, 4).map((c, i) => {
      const b = c.box.getBoundingClientRect();
      return { i, hidden: c.box.hidden, w: Math.round(b.width), h: Math.round(b.height) };
    });
    return {
      open: !multiview.cells[2].sheet.hidden,
      inside: sheet.top >= cell.top - 1 && sheet.left >= cell.left - 1
        && sheet.right <= cell.right + 1 && sheet.bottom <= cell.bottom + 1,
      sheetArea: Math.round(sheet.width * sheet.height),
      screenArea: window.innerWidth * window.innerHeight,
      others,
      otherSheets: multiview.cells.slice(0, 4).filter((c) => !c.sheet.hidden).length,
    };
  });
  console.log('   geometry:', JSON.stringify(geom));
  check('the list opens', geom.open, JSON.stringify(geom));
  check('inside the cell it belongs to, not over the screen', geom.inside,
    JSON.stringify(geom));
  check('covering roughly a quarter of the screen rather than all of it',
    geom.sheetArea < geom.screenArea * 0.4,
    `${geom.sheetArea} of ${geom.screenArea}`);
  check('and only that one cell has a list up', geom.otherSheets === 1,
    String(geom.otherSheets));
  check('every other cell is still on screen at full size',
    geom.others.filter((o) => !o.hidden && o.w > 100 && o.h > 100).length === 4,
    JSON.stringify(geom.others));

  const after = await page.evaluate(() => multiview.cells.slice(0, 4)
    .map((c) => !c.video.paused));
  console.log('   playing before/after:', JSON.stringify(before), JSON.stringify(after));
  check('and the other streams never stopped playing',
    after[0] === before[0] && after[1] === before[1], JSON.stringify({ before, after }));

  // --- what is in it -------------------------------------------------------
  console.log('\n  what the list holds');
  // Scoped to the sheet that is open. Every cell has one; three of them are
  // hidden and empty, and an unscoped query finds cell 0's.
  const list = await page.evaluate(() => {
    const sheet = multiview.cells.find((c) => c && !c.sheet.hidden).sheet;
    return {
      title: sheet.querySelector('.mv-sheet-title').textContent,
      seasons: [...sheet.querySelectorAll('.mv-season')].map((s) => s.textContent),
      eps: [...sheet.querySelectorAll('.mv-ep')].map((e) => e.textContent),
      playing: [...sheet.querySelectorAll('.mv-ep.is-playing')]
        .map((e) => e.querySelector('.mv-ep-title').textContent),
    };
  });
  console.log('   list:', JSON.stringify(list));
  check('it is headed with the show', list.title === 'A Show', list.title);
  check('and carries every season, not just the one you are on',
    list.seasons.join() === 'Season 1,Season 2', JSON.stringify(list.seasons));
  check('with every episode in them', list.eps.length === 5, String(list.eps.length));
  check('and marks the one that is on, so you know where you are',
    list.playing.join() === 'The One They Stopped On', JSON.stringify(list.playing));
  check('having asked the provider once for the episodes',
    seriesInfoCalls === 1, String(seriesInfoCalls));

  // The chrome fades after three idle seconds; it must not fade over a list
  // somebody is reading.
  await wait(3600);
  const stillUp = await page.evaluate(() => ({
    idle: document.querySelector('#multiview').classList.contains('is-idle'),
    open: !multiview.cells[2].sheet.hidden,
  }));
  check('and the screen does not dim itself while the list is open',
    !stillUp.idle && stillUp.open, JSON.stringify(stillUp));

  // --- picking one ---------------------------------------------------------
  console.log('\n  picking an episode');
  remuxAsks.length = 0;
  await page.locator('.mv-sheet:visible .mv-ep', { hasText: 'The Second One' })
    .first().click();
  await wait(2500);
  const picked = await page.evaluate(() => ({
    closed: multiview.cells[2].sheet.hidden,
    label: multiview.cells[2].name.textContent,
    playing: !multiview.cells[2].video.paused,
    othersPlaying: multiview.cells.slice(0, 2).filter((c) => !c.video.paused).length,
  }));
  console.log('   picked:', JSON.stringify(picked), JSON.stringify(remuxAsks));
  check('the list closes behind you', picked.closed, JSON.stringify(picked));
  check('and the cell is asked for that episode',
    remuxAsks.join() === '102', JSON.stringify(remuxAsks));
  check('the name follows what is now playing', /S1E2/.test(picked.label), picked.label);
  check('and it plays', picked.playing, JSON.stringify(picked));
  check('while the channels beside it carry on untouched',
    picked.othersPlaying === 2, String(picked.othersPlaying));

  // A second open reuses the episode list rather than asking again.
  await page.evaluate(() => multiview.cells[2].name.click());
  await wait(800);
  check('opening it again does not re-ask the provider',
    seriesInfoCalls === 1, String(seriesInfoCalls));

  // --- closing it ----------------------------------------------------------
  console.log('\n  closing it');
  await page.locator('.mv-sheet:visible .mv-sheet-top .mv-btn').first().click();
  await wait(500);
  const shut = await page.evaluate(() => ({
    open: !multiview.cells[2].sheet.hidden,
    playing: !multiview.cells[2].video.paused,
  }));
  check('it closes back to the picture', shut.open === false, JSON.stringify(shut));
  check('which never stopped playing underneath', shut.playing, JSON.stringify(shut));

  // Stopping the cell takes the list with it: the show it was about is gone.
  await page.evaluate(() => multiview.cells[2].name.click());
  await wait(700);
  await page.evaluate(() => multiview.stop(2));
  await wait(400);
  const stopped = await page.evaluate(() => ({
    open: !multiview.cells[2].sheet.hidden,
    link: multiview.cells[2].name.classList.contains('is-link'),
  }));
  check('stopping the cell closes the list with it', stopped.open === false,
    JSON.stringify(stopped));
  check('and the name stops being a way in', stopped.link === false,
    JSON.stringify(stopped));

  // --- a film has no episodes ----------------------------------------------
  console.log('\n  a film');
  await page.evaluate((film) => {
    state.library.movies = { categories: [{ id: 'm1', name: 'Films' }], items: [film] };
    multiview.start(3, film);
  }, FILM);
  await wait(2500);
  const film = await page.evaluate(() => ({
    link: multiview.cells[3].name.classList.contains('is-link'),
    disabled: multiview.cells[3].name.disabled,
  }));
  check('a film\'s name is not a way into anything', !film.link && film.disabled,
    JSON.stringify(film));
  await page.evaluate(() => multiview.cells[3].name.click());
  await wait(400);
  check('and pressing it does nothing at all',
    (await page.evaluate(() => multiview.cells[3].sheet.hidden)) === true);

  await page.evaluate(() => multiview.cells[2].name.click());
  await page.screenshot({ path: __dirname + '/shots/mv-episodes.png' });
  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
