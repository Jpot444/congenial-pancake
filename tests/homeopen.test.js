/**
 * Opening a show from the home screen.
 *
 * "I'm getting a title not available when I try to click on a series on my
 * homescreen." The home screen is built from watch history, deliberately —
 * it renders without waiting on a library fetch, which is the point of a
 * landing page. So every card there names a title the library has not
 * necessarily loaded yet, and pressing one has to go and find it.
 *
 * Three ways that can be asked, and the history row decides which:
 *
 *   * a show sitting in the ordinary filtered library;
 *   * a show only the unfiltered catalogue knows about, which is now
 *     reachable and so now turns up in history;
 *   * a row from before series ids were recorded, whose only id is the
 *     EPISODE's — which is in no library at all, and never will be.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const NARROW_SERIES = [
  { kind: 'series', id: 700, name: 'The Ordinary Show', categoryId: 'ENGLISH SERIES' },
];
const WIDE_SERIES = [
  ...NARROW_SERIES,
  { kind: 'series', id: 900, name: 'Les Revenants', categoryId: 'FR - SERIES' },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  const taste = { recentlyWatched: [], categoryAffinity: [], ratings: {} };
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taste) }));

  const asked = [];
  await page.route('**/api/library?tab=*', async (r) => {
    const url = new URL(r.request().url());
    const tab = url.searchParams.get('tab');
    const all = url.searchParams.get('all') === '1';
    asked.push(`${tab}${all ? ':all' : ''}`);
    const items = tab === 'series' ? (all ? WIDE_SERIES : NARROW_SERIES) : [];
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, categories: [], totals: { items: items.length } }) });
  });

  // The episode list a show resumes through.
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ episodes: { 1: [
        { id: 5001, episode_num: 1, title: 'One', container_extension: 'mkv' },
        { id: 5002, episode_num: 2, title: 'Two', container_extension: 'mkv' },
      ] } }) }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  /** Put a history row on the home screen and press its card. */
  const pressHome = (row) => page.evaluate(async (r) => {
    state.config.mode = 'xtream';
    state.recentlyWatched = [r];
    document.querySelector('#toast').hidden = true;
    // Back to home from wherever the last press landed, and only then plant
    // the row — going to home reloads history from the profile otherwise.
    location.hash = '#/home';
    await new Promise((res) => setTimeout(res, 600));
    state.recentlyWatched = [r];
    state.seriesId = '';
    renderHome();
    const card = document.querySelector('#homeView .home-recent .card');
    const label = card ? card.textContent.replace(/\s+/g, ' ').trim() : '';
    card?.click();
    await new Promise((res) => setTimeout(res, 1500));
    return {
      label,
      hash: location.hash,
      toast: document.querySelector('#toast').hidden
        ? '' : document.querySelector('#toast').textContent,
      shown: document.querySelector('#seriesView')?.textContent.slice(0, 80) || '',
    };
  }, row);

  /* ---- the ordinary case ------------------------------------------------ */
  console.log('\n  a show the filtered library has');
  const ordinary = await pressHome({
    kind: 'series', id: 700, seriesId: 700, name: 'The Ordinary Show',
    seriesName: 'The Ordinary Show', season: 1, episode: 2,
    position: 300, duration: 1800, key: 'series:700:s1e2',
  });
  console.log('   ', JSON.stringify(ordinary));
  check('the card is on the home screen', /Ordinary Show/.test(ordinary.label),
    ordinary.label);
  check('pressing it opens the show rather than refusing',
    !/no longer in the library/.test(ordinary.toast), ordinary.toast);
  check('and lands on the show page', /#\/series\/700/.test(ordinary.hash), ordinary.hash);

  /* ---- a show only the wide catalogue knows -------------------------- */
  //
  // These can be in history now: All languages made them reachable, so they
  // get watched, and then they come back here with an id the filtered
  // library has never heard of.
  console.log('\n  a show only the unfiltered catalogue has');
  // Loaded because somebody pressed All languages, which is the only way it
  // is ever loaded now — see below for what happens when they have not.
  await page.evaluate(async () => {
    state.library = { live: null, movies: null, series: null };
    state.libraryAll = { live: null, movies: null, series: null };
    state.searchWide = true;
    await loadTab('series', { all: true, quiet: true });
  });
  const foreign = await pressHome({
    kind: 'series', id: 900, seriesId: 900, name: 'Les Revenants',
    seriesName: 'Les Revenants', season: 1, episode: 1,
    position: 120, duration: 2700, key: 'series:900:s1e1',
  });
  console.log('   ', JSON.stringify(foreign));
  check('it is not declared missing just because the filter hides it',
    !/no longer in the library/.test(foreign.toast), foreign.toast);
  check('and it opens', /#\/series\/900/.test(foreign.hash), foreign.hash);
  check('by looking in the catalogue already in hand', asked.includes('series:all'),
    JSON.stringify(asked));

  /* ---- and it never goes and FETCHES that catalogue by itself ----------- */
  //
  // The regression that cost a working library. Pulling the provider's whole
  // unfiltered catalogue — six figures of titles, assembled in memory — to
  // resolve one press is enough to restart a Pi with a gigabyte to its name,
  // and the next page then reports the library as empty. It stays opt-in.
  console.log('\n  and it does not go fetching the whole provider on its own');
  const noFetch = await page.evaluate(async () => {
    state.libraryAll = { live: null, movies: null, series: null };
    const before = performance.now();
    const found = await findTitle('series', '900');
    return { found: found?.name || null, ms: performance.now() - before,
      pulled: Boolean(state.libraryAll.series) };
  });
  console.log('   ', JSON.stringify(noFetch));
  check('with the wide catalogue not loaded, it is not fetched',
    noFetch.pulled === false, JSON.stringify(noFetch));
  check('and the answer comes back at once rather than after a catalogue',
    noFetch.ms < 500, `${noFetch.ms}ms`);
  check('reporting the title as missing, which is the honest answer here',
    noFetch.found === null, String(noFetch.found));

  /* ---- and a row that genuinely cannot be resolved ---------------------- */
  //
  // History from before series ids were recorded carries only the EPISODE's
  // id, which is in no library and never will be. It has to fail — but it
  // must fail SAYING so, not silently.
  console.log('\n  a row carrying an episode id and nothing else');
  const stale = await pressHome({
    kind: 'series', id: 5002, name: 'Two', seriesName: 'The Ordinary Show',
    season: 1, episode: 2, position: 60, duration: 1800, key: 'series:5002',
  });
  console.log('   ', JSON.stringify(stale));
  check('it says so rather than going quiet',
    /no longer in the library/.test(stale.toast), stale.toast);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
