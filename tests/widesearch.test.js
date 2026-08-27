/**
 * Searching past the English/US filter, from the search itself.
 *
 * "On desktop I need a button while I am conducting a search so I can search
 * the non english titles."
 *
 * The provider sells in every language it can — 178k films, 46k series — and
 * the stored filter throws all of it away on the box before it ever reaches
 * the browser. That is the right default; it is why the library appears at
 * all rather than after a minute. It is the wrong default for the one evening
 * somebody wants a film they know the name of.
 *
 * The Settings switch already existed and is not an answer: it is a decision
 * about the WHOLE library, it drops every cached page on the floor, and it
 * has to be remembered and put back. This is a button on the search, it
 * widens the search that is already on screen, and it leaves browsing alone.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Two catalogues for the same provider: what the filter lets through, and
// everything. The foreign titles exist only in the second.
const NARROW = {
  live: [{ kind: 'live', id: 'l1', name: 'US NEWS ONE', categoryId: 'US| NEWS' }],
  movies: [{ kind: 'movie', id: 'm1', name: 'Amelie Goes To Town', categoryId: 'EN - COMEDY' }],
  series: [{ kind: 'series', id: 's1', name: 'The Amelia Papers', categoryId: 'ENGLISH SERIES' }],
};
const WIDE = {
  live: [...NARROW.live,
    { kind: 'live', id: 'l2', name: 'FR| AMELIE TV', categoryId: 'FR| GENERAL' }],
  movies: [...NARROW.movies,
    { kind: 'movie', id: 'm2', name: 'Le Fabuleux Destin d’Amélie Poulain', categoryId: 'FR - CINEMA' },
    { kind: 'movie', id: 'm3', name: 'Amelie (VOSTFR)', categoryId: 'FR - CINEMA' }],
  series: [...NARROW.series],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  // Every library fetch is recorded, so it can be shown that the wide one is
  // asked for only when it is wanted — and only once.
  const asked = [];
  // `?tab=*` and not `library*`: a bare star does not cross the query string,
  // so the looser-looking pattern matches nothing at all.
  await page.route('**/api/library?tab=*', async (r) => {
    const url = new URL(r.request().url());
    const tab = url.searchParams.get('tab');
    const all = url.searchParams.get('all') === '1';
    asked.push(`${tab}${all ? ':all' : ''}`);
    // The wide catalogue is the whole provider and is genuinely slower.
    if (all) await wait(300);
    const items = (all ? WIDE : NARROW)[tab] || [];
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, categories: [], totals: { items: items.length } }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  // Searching happens from one of the three library pages; Home has its own
  // shape and the archive its own index. The standing test box is configured
  // for a plain m3u, which has no per-section library call at all, so say
  // xtream — the filter and everything built on it only exist there.
  await page.evaluate(() => {
    state.config.mode = 'xtream';
    location.hash = '#/movies';
    render();
  });
  await wait(1200);

  /* ---- it is not in the way when nothing is being searched -------------- */
  console.log('\n  when it appears');
  check('no button while browsing — it belongs to a search, not to a page',
    await page.locator('#wideSearchBtn').isHidden());

  await page.fill('#searchInput', 'amelie');
  await wait(900);
  const searching = await page.evaluate(() => {
    const b = document.querySelector('#wideSearchBtn');
    return { hidden: b.hidden, label: b.textContent.trim(), on: b.classList.contains('is-on') };
  });
  console.log('   ', JSON.stringify(searching));
  check('it appears as soon as a search does', searching.hidden === false,
    JSON.stringify(searching));
  check('offering, not claiming — it is off until it is pressed',
    searching.on === false && /All languages/.test(searching.label),
    JSON.stringify(searching));

  /* ---- and the narrow search really is narrow --------------------------- */
  console.log('\n  before it is pressed');
  const narrow = await page.evaluate(() => [...document.querySelectorAll('#grid .search-section')]
    .map((s) => ({ tab: s.dataset.tab,
      names: [...s.querySelectorAll('.search-cards > *')]
        .map((c) => c.textContent.replace(/\s+/g, ' ').trim()) })));
  const narrowNames = narrow.flatMap((s) => s.names).join(' | ');
  console.log('   ', narrowNames);
  check('the English title is found', /Amelie Goes To Town/.test(narrowNames), narrowNames);
  check('and the French one is not, because the box never sent it',
    !/Poulain/.test(narrowNames), narrowNames);
  check('only the filtered catalogue has been fetched',
    asked.every((a) => !a.endsWith(':all')), JSON.stringify(asked));

  /* ---- pressing it widens the search that is already on screen ---------- */
  console.log('\n  after it is pressed');
  await page.locator('#wideSearchBtn').click();
  await wait(1600);
  const wide = await page.evaluate(() => ({
    names: [...document.querySelectorAll('#grid .search-cards > *')]
      .map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
    label: document.querySelector('#wideSearchLabel').textContent,
    on: document.querySelector('#wideSearchBtn').classList.contains('is-on'),
    query: document.querySelector('#searchInput').value,
  }));
  console.log('   ', JSON.stringify(wide));
  check('the query is untouched — it widens the search, it does not restart it',
    wide.query === 'amelie', wide.query);
  // "amelie" typed on a US keyboard reaching "Amélie" is not a nicety here:
  // it is most of what a foreign catalogue is made of, and a button that
  // surfaces titles nobody can then type would be half a feature.
  check('the French film turns up, accent and all, from an unaccented query',
    /Poulain/.test(wide.names), wide.names);
  check('and the plainly-spelled one comes too',
    /Amelie \(VOSTFR\)/.test(wide.names), wide.names);
  check('the English one is still there — it is a wider net, not another one',
    /Amelie Goes To Town/.test(wide.names), wide.names);
  check('a foreign live channel comes too, not just films',
    /AMELIE TV/.test(wide.names), wide.names);
  check('and the button says it is in force now',
    wide.on === true && /Every language/.test(wide.label), JSON.stringify(wide));
  check('the wide catalogue was asked for, for all three sections',
    ['live:all', 'movies:all', 'series:all'].every((k) => asked.includes(k)),
    JSON.stringify(asked));

  /* ---- and browsing is left exactly as it was --------------------------- */
  //
  // The reason this is a button and not the Settings switch: turning the
  // filter off there drops every cached page and reloads the whole provider
  // into every grid. A search that quietly did that would be the same
  // mistake with a nicer name on it.
  console.log('\n  what it does NOT do');
  const untouched = await page.evaluate(() => ({
    browsing: (state.library.movies?.items || []).map((i) => i.name),
    wide: (state.libraryAll.movies?.items || []).length,
    stored: prefs.data.filtersEnabled,
  }));
  console.log('   ', JSON.stringify(untouched));
  check('the browsing library is still the short one',
    untouched.browsing.length === 1 && !untouched.browsing.join().includes('Poulain'),
    JSON.stringify(untouched.browsing));
  check('the wide one is kept beside it rather than on top of it',
    untouched.wide === 3, String(untouched.wide));
  check('and the stored filter is not touched, so nothing has to be put back',
    untouched.stored !== false, String(untouched.stored));

  /* ---- pressing it again goes back -------------------------------------- */
  console.log('\n  and back again');
  const before = asked.length;
  await page.locator('#wideSearchBtn').click();
  await wait(700);
  const back = await page.evaluate(() => ({
    names: [...document.querySelectorAll('#grid .search-cards > *')]
      .map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
    on: document.querySelector('#wideSearchBtn').classList.contains('is-on'),
  }));
  console.log('   ', JSON.stringify(back));
  check('it narrows again', !/Poulain/.test(back.names) && back.on === false,
    JSON.stringify(back));
  check('with nothing refetched — both catalogues are already held',
    asked.length === before, JSON.stringify(asked.slice(before)));

  /* ---- it stays on across searches -------------------------------------- */
  //
  // Somebody hunting foreign titles is rarely doing it once, and having to
  // re-press it on every query would be the Settings switch again in miniature.
  console.log('\n  it stays on for the next search');
  await page.locator('#wideSearchBtn').click();
  await wait(700);
  await page.fill('#searchInput', 'poulain');
  await wait(900);
  const next = await page.evaluate(() => ({
    on: document.querySelector('#wideSearchBtn').classList.contains('is-on'),
    names: [...document.querySelectorAll('#grid .search-cards > *')]
      .map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
  }));
  console.log('   ', JSON.stringify(next));
  check('a new query is still searched wide', next.on === true
    && /Poulain/.test(next.names), JSON.stringify(next));

  /* ---- and it is mentioned where it is needed --------------------------- */
  console.log('\n  when a narrow search finds nothing');
  await page.locator('#wideSearchBtn').click();       // back to narrow
  await wait(400);
  await page.fill('#searchInput', 'poulain');
  await wait(900);
  const emptyNote = await page.evaluate(() => {
    const e = document.querySelector('#emptyState');
    return { hidden: e.hidden, text: e.textContent };
  });
  console.log('   ', JSON.stringify(emptyNote));
  check('nothing found says so', emptyNote.hidden === false, JSON.stringify(emptyNote));
  check('and points at the button, which is exactly when it is worth knowing',
    /All languages/.test(emptyNote.text), emptyNote.text);

  /* ---- and it is not offered when there is nothing to widen ------------- */
  //
  // Filter already off in Settings means the browsing library IS everything.
  // A button offering to widen that is a lie with a globe on it.
  console.log('\n  with the filter already off');
  const pointless = await page.evaluate(async () => {
    const was = prefs.data.filtersEnabled;
    prefs.data.filtersEnabled = false;
    applyWideSearchButton();
    const hidden = document.querySelector('#wideSearchBtn').hidden;
    prefs.data.filtersEnabled = was;
    applyWideSearchButton();
    return hidden;
  });
  check('the button is not offered at all', pointless === true, String(pointless));

  /* ---- and a title found this way can actually be played ---------------- */
  //
  // "There are 3 or 4 different versions that are in the all language
  // section, but they all say that film is no longer in library when I try
  // to play." Every path that opens a title looked in the filtered library
  // and nowhere else, so an id that only the wide catalogue knows about read
  // as a title that had been withdrawn. Finding it and refusing to play it
  // is worse than not finding it.
  console.log('\n  opening what the wide search found');
  await page.evaluate(() => { state.searchWide = true; });
  await page.fill('#searchInput', 'poulain');
  await wait(1200);
  await page.evaluate(() => {
    document.querySelector('#grid .search-cards > *')?.click();
  });
  await wait(1200);
  const opened = await page.evaluate(() => ({
    hash: location.hash,
    title: document.querySelector('#seriesView .title-name')?.textContent
      || document.querySelector('#seriesView')?.textContent.slice(0, 120) || '',
    gone: /no longer in the library/.test(document.querySelector('#seriesView')?.textContent || ''),
  }));
  console.log('   ', JSON.stringify(opened));
  check('the card opens on the film that was clicked',
    /movies\//.test(opened.hash), opened.hash);
  check('and it is NOT declared withdrawn', opened.gone === false, opened.title);
  check('it is the French one, by name', /Poulain/.test(opened.title), opened.title);

  /* ---- but it never pulls the whole provider to answer one press ------- */
  //
  // The first version of this DID, and it cost a working library. A title
  // missing from the filtered list would send the app off to fetch the
  // provider's entire unfiltered catalogue — six figures of titles the box
  // assembles in memory — for a lookup that fails either way when the title
  // really is gone. On a Pi with a gigabyte to its name that is enough to
  // restart the portal mid-request, and the next page then reports the
  // library as empty. Which is exactly what happened.
  //
  // So the wide catalogue is consulted only when it is already in hand,
  // which means only after somebody has pressed All languages.
  console.log('\n  with nothing wide held, it does not go and get it');
  const cold = await page.evaluate(async () => {
    state.libraryAll = { live: null, movies: null, series: null };
    state.searchWide = false;
    const before = performance.now();
    const found = await findTitle('movies', 'm2');
    return { name: found?.name || null, ms: performance.now() - before,
      pulled: Boolean(state.libraryAll.movies) };
  });
  console.log('   ', JSON.stringify(cold));
  check('the unfiltered catalogue is NOT fetched to resolve one title',
    cold.pulled === false, JSON.stringify(cold));
  check('the answer comes straight back rather than after a catalogue',
    cold.ms < 500, `${cold.ms}ms`);
  check('and a title only that catalogue knows reads as missing, which is',
    cold.name === null, String(cold.name));
  console.log('       the same answer this gave before any of it existed');

  // And once it IS in hand, the lookup finds it — the whole point.
  const warm = await page.evaluate(async () => {
    await loadTab('movies', { all: true, quiet: true });
    const found = await findTitle('movies', 'm2');
    return found?.name || null;
  });
  console.log('   ', JSON.stringify(warm));
  check('while a catalogue already loaded answers for its own titles',
    /Poulain/.test(warm || ''), String(warm));

  const absent = await page.evaluate(() => findTitle('movies', 'nope-999')
    .then((r) => r === null));
  check('and something genuinely absent still comes back as absent',
    absent === true, String(absent));

  /* ---- and accents fold on the ordinary tab search too ------------------ */
  //
  // Same folding, both search paths. Leaving one of them literal would mean
  // a title findable from Live TV and invisible from Movies.
  console.log('\n  accents on the plain per-tab search');
  const folded = await page.evaluate(() => {
    state.searchWide = false;
    state.movieId = '';          // off the film card opened just above
    state.library.movies = { categories: [], items: [
      { kind: 'movie', id: 'x1', name: 'Amélie', categoryId: 'c' },
      { kind: 'movie', id: 'x2', name: 'Jösses Flickor', categoryId: 'c' },
      { kind: 'movie', id: 'x3', name: 'Nothing Like It', categoryId: 'c' },
    ] };
    state.tab = 'movies';
    state.category = 'c';
    const run = (q) => {
      state.query = q;
      render();
      return [...document.querySelectorAll('#grid > *')]
        .map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
    };
    return { plain: run('amelie'), umlaut: run('josses'), exact: run('Amélie') };
  });
  console.log('   ', JSON.stringify(folded));
  check('an unaccented query finds the accented title',
    /Amélie/.test(folded.plain) && !/Nothing Like It/.test(folded.plain), folded.plain);
  check('and it is not just French', /Jösses/.test(folded.umlaut), folded.umlaut);
  check('while typing the accent still works, for anyone who can',
    /Amélie/.test(folded.exact), folded.exact);

  await page.screenshot({ path: __dirname + '/shots/wide-search.png' });
  await browser.close();

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
