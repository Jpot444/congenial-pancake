/**
 * Switching multi-view's picker to Movies or Series when that library has
 * never been opened.
 *
 * Multi-view is reached from Live TV, so this is the *normal* path, not an
 * edge: the picker has to fetch the library itself. It did — and then sat
 * behind a loading screen stuck at 100% for ever, because `loadTab` showed
 * that screen and left hiding it to the caller.
 *
 * The multi-view suite missed this by injecting `state.library.movies`
 * directly, which skips the fetch entirely. So this one refuses to: the
 * libraries start empty and `/api/library` is answered over the wire, with
 * Content-Length set, because the progress bar needs it and a bar that never
 * reaches 100% would hide the bug that only shows *at* 100%.
 */
const { chromium } = require('./playwright.js');
const { openMultiview, multiviewOffered } = require('./mv.js');
const BASE = 'http://127.0.0.1:8481';

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
const LIB = {
  movies: {
    categories: [{ id: 'm1', name: 'EN - ACTION' }, { id: 'm2', name: 'EN - COMEDY' }],
    items: [
      { kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mkv', categoryId: 'm1', added: 5 },
      { kind: 'movie', id: 902, name: 'Another Film', logo: '', ext: 'mkv', categoryId: 'm1', added: 6 },
      { kind: 'movie', id: 903, name: 'A Comedy', logo: '', ext: 'mkv', categoryId: 'm2', added: 7 },
    ],
  },
  series: {
    categories: [{ id: 's1', name: 'NETFLIX SERIES' }],
    items: [
      { kind: 'series', id: 77, name: 'A Show', logo: '', categoryId: 's1', added: 3 },
      { kind: 'series', id: 78, name: 'Another Show', logo: '', categoryId: 's1', added: 4 },
    ],
  },
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  let libCalls = [];
  let stall = 0;         // ms to hold the response, to catch the bar mid-flight
  let fail = false;
  await page.route('**/api/library*', async (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    libCalls.push(tab);
    if (stall) await new Promise((res) => setTimeout(res, stall));
    if (fail) return r.fulfill({ status: 500, contentType: 'application/json',
      body: '{"error":"provider timed out"}' });
    const body = JSON.stringify(LIB[tab] || { categories: [], items: [] });
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      // fetchWithProgress needs a real length or it cannot report a fraction.
      headers: { 'content-length': String(Buffer.byteLength(body)) },
      body,
    });
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

  // Live TV only. Movies and Series are deliberately left unloaded — that is
  // the state somebody is actually in when they open multi-view.
  //
  // The mode matters: the test server is pointed at an M3U, and that branch of
  // `loadTab` returns without ever showing a loading screen. The Pi talks
  // Xtream, takes the /api/library branch, and is the only one that can strand
  // the loader — so that is the branch this exercises.
  await page.evaluate((chans) => {
    state.config.mode = 'xtream';
    location.hash = '#/live';
    state.library.live = { categories: [{ id: 'c1', name: 'US| SPORTS' }], items: chans };
    render();
  }, CHANNELS);
  await wait(600);
  libCalls = [];

  const untouched = await page.evaluate(() =>
    ({ movies: state.library.movies ?? null, series: state.library.series ?? null }));
  check('Movies and Series really are unloaded to begin with',
    untouched.movies === null && untouched.series === null, JSON.stringify(untouched));

  await openMultiview(page);
  await wait(500);
  await page.locator('.mv-empty:visible').first().click();
  await wait(400);
  check('the picker opens', await page.locator('#mvPicker').isVisible());

  // --- Movies --------------------------------------------------------------
  console.log('\n  switching to Movies with nothing loaded');
  stall = 700;
  const switching = page.evaluate(() => multiview.setSource('movies'));
  await wait(300);
  const during = await page.evaluate(() => ({
    loader: !document.querySelector('#loader').hidden,
    label: document.querySelector('#loaderLabel').textContent,
  }));
  console.log('   mid-flight:', JSON.stringify(during));
  check('the loading screen comes up while it fetches', during.loader, JSON.stringify(during));
  check('and says which library it is fetching',
    /movies/i.test(during.label), during.label);

  await switching;
  await wait(500);
  stall = 0;

  const after = await page.evaluate(() => ({
    loader: !document.querySelector('#loader').hidden,
    pct: document.querySelector('#loaderPct').textContent,
    picker: !document.querySelector('#mvPicker').hidden,
    cards: [...document.querySelectorAll('#mvResults .cat-card .card-title')]
      .map((t) => t.textContent),
    sourceOn: [...document.querySelectorAll('#mvSourceSeg button')]
      .filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.source),
  }));
  console.log('   after:', JSON.stringify(after));
  // The whole bug, in one line: it reached 100% and stayed there.
  check('the loading screen goes away when the fetch is done',
    after.loader === false, `still up at ${after.pct}`);
  check('the picker is what you are left looking at', after.picker);
  check('the film categories are there to pick from',
    after.cards.length === 2 && after.cards.includes('EN - ACTION'),
    JSON.stringify(after.cards));
  check('and Movies is the selected source',
    after.sourceOn.join() === 'movies', JSON.stringify(after.sourceOn));
  check('it asked the server exactly once', libCalls.join() === 'movies',
    JSON.stringify(libCalls));

  // Into a category and back out, to prove the fetched library is usable and
  // not just drawn once.
  await page.locator('#mvResults .cat-card').first().click();
  await wait(400);
  const inside = await page.evaluate(() => ({
    title: document.querySelector('#mvPickerTitle').textContent,
    titles: [...document.querySelectorAll('#mvResults .card-title')].map((t) => t.textContent),
  }));
  console.log('   inside:', JSON.stringify(inside));
  check('a category opens onto its films',
    inside.titles.includes('A Film') && inside.titles.includes('Another Film'),
    JSON.stringify(inside));

  // --- Series --------------------------------------------------------------
  console.log('\n  and Series, the same way');
  await page.evaluate(() => multiview.setSource('series'));
  await wait(900);
  const series = await page.evaluate(() => ({
    loader: !document.querySelector('#loader').hidden,
    picker: !document.querySelector('#mvPicker').hidden,
    cards: [...document.querySelectorAll('#mvResults .cat-card .card-title')]
      .map((t) => t.textContent),
  }));
  console.log('   series:', JSON.stringify(series));
  check('no loading screen left behind there either', series.loader === false);
  check('the show categories load', series.cards.join() === 'NETFLIX SERIES',
    JSON.stringify(series.cards));
  check('two fetches in total, one per library',
    libCalls.join() === 'movies,series', JSON.stringify(libCalls));

  // Going back to a library already in hand must not fetch again.
  await page.evaluate(() => multiview.setSource('movies'));
  await wait(500);
  check('coming back to Movies does not re-fetch it',
    libCalls.join() === 'movies,series', JSON.stringify(libCalls));

  // --- when the fetch fails ------------------------------------------------
  console.log('\n  when the library will not load');
  fail = true;
  await page.evaluate(() => { state.library.series = null; });
  await page.evaluate(() => multiview.setSource('series'));
  await wait(900);
  const broken = await page.evaluate(() => ({
    loader: !document.querySelector('#loader').hidden,
    picker: !document.querySelector('#mvPicker').hidden,
    sub: document.querySelector('#mvPickerSub').textContent,
  }));
  console.log('   failed:', JSON.stringify(broken));
  // A failure that leaves the loading screen up is the same dead end as a
  // success that does — arguably worse, because nothing is coming.
  check('a failed fetch does not strand the loading screen either',
    broken.loader === false, JSON.stringify(broken));
  check('the picker stays open', broken.picker);
  check('and it says so rather than sitting silent',
    /couldn't load/i.test(broken.sub), broken.sub);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
