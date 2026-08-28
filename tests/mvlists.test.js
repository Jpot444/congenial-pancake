/**
 * Favorites and Recently viewed, inside multi-view's picker.
 *
 * Both exist to skip the category walk: the things somebody actually watches
 * are a short list they already have, and making them find a channel three
 * folders down to put it in a box is the work these remove.
 *
 * The two are not the same shape, and that is what most of this checks:
 *
 *   * A **favorite** is a whole library record — the heart in the player saves
 *     the item — so a channel or a film goes straight into a cell.
 *   * A **history row** is not. It carries a name and a poster and, for a
 *     show, an episode NUMBER. Turning "season 2, episode 5" into the id a
 *     stream is asked for takes the episode list, and that happens on the tap.
 *
 * Also here: the header's running tally is gone, and the thing it was really
 * saying — which cell holds a connection open — now lives on that cell.
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
const MOVIES = {
  categories: [{ id: 'm1', name: 'EN - ACTION' }],
  items: [{ kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mkv', categoryId: 'm1' }],
};
const SERIES = {
  categories: [{ id: 's1', name: 'NETFLIX SERIES' }],
  items: [{ kind: 'series', id: 77, name: 'A Show', logo: '', categoryId: 's1' }],
};
const EPISODES = {
  1: [{ id: 101, episode_num: 1, title: 'Pilot', container_extension: 'mkv' }],
  2: [
    { id: 201, episode_num: 1, title: 'Season Two', container_extension: 'mkv' },
    { id: 205, episode_num: 5, title: 'The One They Stopped On', container_extension: 'mkv' },
  ],
};

// What the profile has saved. Favorites are library records; history rows are
// not, and the difference is the point.
const FAVORITES = [
  { key: 'live:2', item: { kind: 'live', id: 2, name: 'US| NBC East', logo: '' } },
  { key: 'movie:901', item: { kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mkv' } },
  { key: 'series:77', item: { kind: 'series', id: 77, name: 'A Show', logo: '' } },
];
const HISTORY = [
  { kind: 'series', id: 205, seriesId: 77, season: 2, episode: 5, name: 'A Show', poster: '' },
  { kind: 'live', id: 1, name: 'US| NFL PPV 01', poster: '' },
  { kind: 'movie', id: 901, name: 'A Film', poster: '' },
  // A second episode of the same show, older. One row per title, so this is
  // the one that has to be folded away.
  { kind: 'series', id: 101, seriesId: 77, season: 1, episode: 1, name: 'A Show', poster: '' },
  // Something the provider has since dropped.
  { kind: 'movie', id: 4242, name: 'Gone Film', poster: '' },
];

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
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_series_info') {
      seriesInfoCalls += 1;
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {}, episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // The conversion, stubbed to bank instantly — what is under test is which
  // episode gets asked for, not ffmpeg.
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
    remuxAsks.push({
      kind: url.searchParams.get('kind'),
      id: url.searchParams.get('id'),
      ext: url.searchParams.get('ext'),
    });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ session: 'sess-1', url: '/api/fake-stream', prebuffer: 45 }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => { localStorage.setItem('portal.beta', '1'); });
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  await page.evaluate(({ chans, favs, hist, movies, series }) => {
    state.config.mode = 'xtream';
    location.hash = '#/live';
    state.library.live = { categories: [{ id: 'c1', name: 'US| SPORTS' }], items: chans };
    state.library.movies = movies;
    state.library.series = series;
    state.seriesCache = {};
    state.downloads = { items: [], active: null, queued: 0 };
    profiles.data.favorites = favs;
    state.recentlyWatched = hist;
    render();
  }, { chans: CHANNELS, favs: FAVORITES, hist: HISTORY, movies: MOVIES, series: SERIES });
  await wait(600);

  await openMultiview(page);
  await wait(500);

  // --- the header is not a readout any more --------------------------------
  console.log('\n  the tally is gone');
  const header = await page.evaluate(() => ({
    note: document.querySelector('#mvNote'),
    text: document.querySelector('#multiview .mv-top').textContent.replace(/\s+/g, ' ').trim(),
  }));
  console.log('   header:', JSON.stringify(header));
  check('the note element is gone entirely', header.note === null);
  check('and nothing counts streams at you',
    !/asked for/.test(header.text), header.text);
  check('the header still says what this is', /Multi-view/.test(header.text), header.text);

  // --- favorites -----------------------------------------------------------
  console.log('\n  favorites');
  await page.locator('.mv-empty:visible').first().click();
  await wait(400);
  await page.locator('#mvSourceSeg button[data-source="favorites"]').click();
  await wait(500);

  const favView = await page.evaluate(() => ({
    title: document.querySelector('#mvPickerTitle').textContent,
    sub: document.querySelector('#mvPickerSub').textContent,
    names: [...document.querySelectorAll('#mvResults .card-title')].map((t) => t.textContent),
    subs: [...document.querySelectorAll('#mvResults .card-sub')].map((t) => t.textContent),
    cats: document.querySelectorAll('#mvResults .cat-card').length,
    placeholder: document.querySelector('#mvSearch').placeholder,
  }));
  console.log('   favorites:', JSON.stringify(favView));
  check('the list is headed as favorites', favView.title === 'Favorites', favView.title);
  check('everything hearted is in it',
    favView.names.join() === 'US| NBC East,A Film,A Show', JSON.stringify(favView.names));
  check('no category step in front of it — it is already a short list',
    favView.cats === 0, String(favView.cats));
  check('and each one says what kind of thing it is, since the list is mixed',
    favView.subs.join() === 'Channel,Film,Show', JSON.stringify(favView.subs));
  check('the search box says what it will search',
    /favorites/i.test(favView.placeholder), favView.placeholder);

  // Search inside the list.
  await page.locator('#mvSearch').fill('film');
  await wait(300);
  const favSearch = await page.evaluate(() =>
    [...document.querySelectorAll('#mvResults .card-title')].map((t) => t.textContent));
  check('typing narrows it', favSearch.join() === 'A Film', JSON.stringify(favSearch));
  await page.locator('#mvSearch').fill('');
  await wait(300);

  // A favorited channel is a whole record, so it plays with nothing to look up.
  await page.locator('#mvResults .card').first().click();
  await wait(1500);
  const played = await page.evaluate(() => ({
    picker: !document.querySelector('#mvPicker').hidden,
    name: multiview.cells[0].name.textContent,
    playing: !multiview.cells[0].video.paused,
  }));
  console.log('   picked:', JSON.stringify(played));
  check('picking a favorite channel closes the picker', played.picker === false);
  check('and it lands in the cell', played.name === 'US| NBC East', played.name);
  check('and plays', played.playing, JSON.stringify(played));

  // A favorited SHOW is not playable — it is a list of things that are.
  console.log('\n  a favorited show opens its episodes');
  await page.evaluate(() => multiview.pick(1));
  await wait(400);
  await page.locator('#mvSourceSeg button[data-source="favorites"]').click();
  await wait(400);
  await page.locator('#mvResults .card').nth(2).click();
  await wait(900);
  const show = await page.evaluate(() => ({
    title: document.querySelector('#mvPickerTitle').textContent,
    open: !document.querySelector('#mvPicker').hidden,
    eps: [...document.querySelectorAll('#mvResults .card-title')].map((t) => t.textContent),
  }));
  console.log('   show:', JSON.stringify(show));
  check('the show opens rather than trying to play', show.open && show.title === 'A Show',
    JSON.stringify(show));
  check('onto its episodes', show.eps.length === 3, JSON.stringify(show.eps));
  // Back out of the episode list lands on the favorites, not on Live TV.
  await page.locator('#mvPickerBack').click();
  await wait(400);
  const backTo = await page.evaluate(() => document.querySelector('#mvPickerTitle').textContent);
  check('and backing out returns to the favorites', backTo === 'Favorites', backTo);

  // --- recently viewed -----------------------------------------------------
  console.log('\n  recently viewed');
  await page.locator('#mvSourceSeg button[data-source="recent"]').click();
  await wait(500);
  const recent = await page.evaluate(() => ({
    title: document.querySelector('#mvPickerTitle').textContent,
    names: [...document.querySelectorAll('#mvResults .card-title')].map((t) => t.textContent),
    subs: [...document.querySelectorAll('#mvResults .card-sub')].map((t) => t.textContent),
  }));
  console.log('   recent:', JSON.stringify(recent));
  check('the list is headed as recently viewed',
    recent.title === 'Recently viewed', recent.title);
  check('newest first, one row per title',
    recent.names.join() === 'A Show,US| NFL PPV 01,A Film,Gone Film',
    JSON.stringify(recent.names));
  check('the older episode of the same show is folded away, not listed twice',
    recent.names.filter((n) => n === 'A Show').length === 1, JSON.stringify(recent.names));
  check('and a part-watched show says where you were',
    recent.subs[0] === 'S2E5', JSON.stringify(recent.subs));

  // The interesting one: a history row is not a library record. Picking the
  // show has to resolve season 2 episode 5 into the provider's episode id.
  //
  // The cache is cleared first, because opening the show a moment ago filled
  // it — and a check that only passes when something earlier in the file
  // happened to warm it is not checking the thing it names.
  await page.evaluate(() => { state.seriesCache = {}; });
  seriesInfoCalls = 0;
  remuxAsks.length = 0;
  await page.locator('#mvResults .card').first().click();
  await wait(2500);
  const resumed = await page.evaluate(() => ({
    label: multiview.cells[1].name.textContent,
    playing: !multiview.cells[1].video.paused,
    vod: multiview.cells[1].vod,
  }));
  console.log('   resumed:', JSON.stringify(resumed), JSON.stringify(remuxAsks));
  check('it fetched the episode list to translate the episode number',
    seriesInfoCalls === 1, String(seriesInfoCalls));
  check('and asked for the episode that was actually being watched',
    remuxAsks.length === 1 && remuxAsks[0].id === '205', JSON.stringify(remuxAsks));
  check('with the container the provider listed for it',
    remuxAsks[0]?.ext === 'mkv', JSON.stringify(remuxAsks));
  check('the cell names the episode, not just the show',
    /S2E5/.test(resumed.label), resumed.label);
  check('it went in as a conversion', resumed.vod === true);
  check('and it is playing', resumed.playing, JSON.stringify(resumed));

  // Having paid for the episode list once, it is not paid for again.
  await page.evaluate(() => multiview.pick(1));
  await wait(400);
  await page.locator('#mvSourceSeg button[data-source="recent"]').click();
  await wait(400);
  await page.locator('#mvResults .card').first().click();
  await wait(2000);
  check('a second go at the same show reuses the episode list',
    seriesInfoCalls === 1, String(seriesInfoCalls));

  // A live history row needs no lookup beyond its library record.
  console.log('\n  a channel from history');
  await page.evaluate(() => multiview.pick(2));
  await wait(400);
  await page.locator('#mvSourceSeg button[data-source="recent"]').click();
  await wait(400);
  await page.locator('#mvResults .card').nth(1).click();
  await wait(1800);
  const chan = await page.evaluate(() => ({
    name: multiview.cells[2].name.textContent,
    playing: !multiview.cells[2].video.paused,
  }));
  console.log('   channel:', JSON.stringify(chan));
  check('the channel goes straight in', chan.name === 'US| NFL PPV 01', chan.name);
  check('and plays', chan.playing, JSON.stringify(chan));

  // --- a row the provider has dropped --------------------------------------
  console.log('\n  something that is no longer there');
  await page.evaluate(() => multiview.pick(3));
  await wait(400);
  await page.locator('#mvSourceSeg button[data-source="recent"]').click();
  await wait(400);
  await page.locator('#mvResults .card').nth(3).click();
  await wait(1200);
  const gone = await page.evaluate(() => {
    const cell = multiview.cells[3];
    return {
      note: cell.note.hidden ? '' : cell.note.textContent,
      empty: !cell.empty.hidden,
      item: Boolean(cell.item),
    };
  });
  console.log('   gone:', JSON.stringify(gone));
  check('it says so on the cell rather than doing nothing',
    /no longer in the library/i.test(gone.note), JSON.stringify(gone));
  check('and the cell is offered back to you to pick again', gone.empty,
    JSON.stringify(gone));
  check('with nothing left half-attached to it', gone.item === false);

  // --- the two lists when they are empty -----------------------------------
  console.log('\n  before anything has been watched or hearted');
  await page.evaluate(() => {
    profiles.data.favorites = [];
    state.recentlyWatched = [];
    multiview.setSource('favorites');
  });
  await wait(400);
  const noFavs = await page.evaluate(() =>
    document.querySelector('#mvResults .show-note')?.textContent || '');
  check('favorites says how to make one', /tap the heart/i.test(noFavs), noFavs);
  await page.evaluate(() => multiview.setSource('recent'));
  await wait(400);
  const noRecent = await page.evaluate(() =>
    document.querySelector('#mvResults .show-note')?.textContent || '');
  check('and recently viewed says it fills itself in',
    /fills up as you use/i.test(noRecent), noRecent);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
