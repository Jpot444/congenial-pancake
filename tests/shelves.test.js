/**
 * The Movies and Series rows.
 *
 * Two claims, and they pull against each other, which is why both are here:
 *
 *   * **New Releases is newest-added first**, and stays that way as the
 *     provider adds things — so it is the one row that must NOT be shuffled.
 *   * **Every other row is shuffled**, so a shelf capped at forty is not the
 *     same forty posters for ever. For You is excluded: its order is the order
 *     you watched things in, which is the whole of what it means.
 *
 * The shuffle is seeded once per load, so a third claim matters as much: it
 * must be *stable* while you are looking at it. Re-rendering happens on every
 * pin, hide and tab change, and posters that rearranged each time would be
 * worse than never shuffling at all.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// `added` ascending with the id, so "newest first" is a sequence that can be
// read off at a glance: 60, 59, 58…
const MOVIES = {
  categories: [
    { id: 'nr', name: 'EN - NEW RELEASES 2026' },
    { id: 'ac', name: 'EN - ACTION' },
  ],
  items: Array.from({ length: 60 }, (_, i) => ({
    kind: 'movie',
    id: i + 1,
    name: `Film ${i + 1}`,
    logo: '',
    categoryId: i < 30 ? 'nr' : 'ac',
    added: 1000 + i,
  })),
};
const SERIES = {
  categories: [{ id: 's1', name: 'NETFLIX SERIES' }],
  items: Array.from({ length: 50 }, (_, i) => ({
    kind: 'series',
    id: 500 + i,
    name: `Show ${i + 1}`,
    logo: '',
    categoryId: 's1',
    genre: 'Drama',
    added: 2000 + i,
  })),
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  const load = async (tab) => {
    await page.evaluate(({ movies, series, want }) => {
      state.library.movies = movies;
      state.library.series = series;
      state.tab = want;
      state.shelf = null;
      state.category = null;
      location.hash = `#/${want}`;
      render();
    }, { movies: MOVIES, series: SERIES, want: tab });
    await page.waitForSelector('.shelf', { timeout: 10000 });
    await wait(300);
  };

  const shelves = () => page.evaluate(() =>
    buildShelves(state.tab).map((r) => ({
      title: r.title,
      ids: r.items.slice(0, 12).map((i) => i.id),
      total: r.items.length,
    })));

  // --- newest first --------------------------------------------------------
  console.log('\n  New Releases');
  await load('movies');
  let rows = await shelves();
  let newest = rows.find((r) => r.title === 'New Releases');
  console.log('   movies:', JSON.stringify(newest));
  check('the row exists on Movies', Boolean(newest), JSON.stringify(rows.map((r) => r.title)));
  // Films 1–30 are the NEW RELEASES category, added 1000…1029.
  check('newest added leads it', newest.ids[0] === 30, String(newest.ids[0]));
  check('and it counts down from there, not in library order',
    newest.ids.join() === [30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19].join(),
    JSON.stringify(newest.ids));

  await load('series');
  rows = await shelves();
  newest = rows.find((r) => r.title === 'New Releases');
  console.log('   series:', JSON.stringify(newest));
  check('the row exists on Series too', Boolean(newest));
  check('newest first there as well', newest.ids[0] === 549, String(newest.ids[0]));
  check('across the whole library rather than one category',
    newest.total === 50, String(newest.total));

  // Something added now has to arrive at the top, because that is the point.
  const arrival = await page.evaluate(() => {
    state.library.series.items.push({
      kind: 'series', id: 999, name: 'Just Added', logo: '',
      categoryId: 's1', genre: 'Drama', added: 9999999,
    });
    const row = buildShelves('series').find((r) => r.title === 'New Releases');
    return { first: row.items[0].name, total: row.items.length };
  });
  console.log('   after an arrival:', JSON.stringify(arrival));
  check('something added later goes straight to the front',
    arrival.first === 'Just Added', arrival.first);

  // --- shuffled, except the two that must not be ---------------------------
  console.log('\n  the other rows');
  await load('movies');
  rows = await shelves();
  const action = rows.find((r) => r.title === 'Action');
  console.log('   action:', JSON.stringify(action));
  check('a genre row is not library order',
    action.ids.join() !== [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42].join(),
    JSON.stringify(action.ids));
  check('and it still holds everything, only rearranged',
    action.total === 30, String(action.total));

  // Two rows must not be handed the same arrangement.
  const twoRows = await page.evaluate(() => {
    // The SAME input each time. Feeding an already-shuffled list back in is a
    // different question with a different answer, and asking it that way is
    // how this check first went wrong.
    const source = state.library.movies.items.filter((i) => i.categoryId === 'ac');
    const take = (r) => r.slice(0, 8).map((i) => i.id);
    return {
      action: take(shuffleShelf('Action', source)),
      again: take(shuffleShelf('Action', source)),
      comedy: take(shuffleShelf('Comedy', source)),
    };
  });
  check('the same row shuffles to the same thing every time',
    twoRows.action.join() === twoRows.again.join(), JSON.stringify(twoRows));
  check('while a different row gets its own arrangement rather than sharing one',
    twoRows.action.join() !== twoRows.comedy.join(), JSON.stringify(twoRows));

  // --- stable while you look at it -----------------------------------------
  console.log('\n  stable while it is on screen');
  const first = await page.evaluate(() =>
    [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title').textContent === 'Action')
      .querySelectorAll('.rail-card .card-title'))
    .then(() => page.evaluate(() => {
      const shelf = [...document.querySelectorAll('.shelf')]
        .find((s) => s.querySelector('.shelf-title').textContent === 'Action');
      return [...shelf.querySelectorAll('.card-title')].slice(0, 8).map((t) => t.textContent);
    }));
  // Re-rendering is what pinning, hiding and switching tabs all do.
  await page.evaluate(() => { render(); render(); });
  await wait(400);
  const second = await page.evaluate(() => {
    const shelf = [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title').textContent === 'Action');
    return [...shelf.querySelectorAll('.card-title')].slice(0, 8).map((t) => t.textContent);
  });
  console.log('   before:', JSON.stringify(first));
  console.log('   after: ', JSON.stringify(second));
  check('re-rendering does not rearrange the posters under you',
    first.join() === second.join(), `${first.join()} vs ${second.join()}`);

  // Leaving the page and coming back is still the same visit.
  await page.evaluate(() => { location.hash = '#/series'; render(); });
  await wait(400);
  await page.evaluate(() => { location.hash = '#/movies'; render(); });
  await wait(400);
  const third = await page.evaluate(() => {
    const shelf = [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title').textContent === 'Action');
    return [...shelf.querySelectorAll('.card-title')].slice(0, 8).map((t) => t.textContent);
  });
  check('nor does leaving the tab and coming back',
    first.join() === third.join(), `${first.join()} vs ${third.join()}`);

  // --- a fresh look next time ----------------------------------------------
  console.log('\n  a different look on the next visit');
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await load('movies');
  const reloaded = await page.evaluate(() => {
    const shelf = [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title').textContent === 'Action');
    return [...shelf.querySelectorAll('.card-title')].slice(0, 8).map((t) => t.textContent);
  });
  console.log('   reloaded:', JSON.stringify(reloaded));
  check('a reload deals a different hand',
    first.join() !== reloaded.join(), `${first.join()} vs ${reloaded.join()}`);
  // But New Releases is not a hand — it is an order, and it has to survive.
  const stillNewest = await page.evaluate(() =>
    buildShelves('movies').find((r) => r.title === 'New Releases').items
      .slice(0, 5).map((i) => i.id));
  check('while New Releases is the same order it always was',
    stillNewest.join() === [30, 29, 28, 27, 26].join(), JSON.stringify(stillNewest));

  // --- For You is left alone ------------------------------------------------
  console.log('\n  For You');
  const forYou = await page.evaluate(() => {
    state.recentlyWatched = [
      { kind: 'movie', id: 7, name: 'Film 7' },
      { kind: 'movie', id: 3, name: 'Film 3' },
      { kind: 'movie', id: 51, name: 'Film 51' },
    ];
    const row = buildShelves('movies').find((r) => r.title === 'For You');
    return row ? row.items.map((i) => i.id) : null;
  });
  console.log('   for you:', JSON.stringify(forYou));
  check('it is built at all', Array.isArray(forYou) && forYou.length === 3,
    JSON.stringify(forYou));
  check('and left in the order things were watched, not shuffled',
    forYou.join() === [7, 3, 51].join(), JSON.stringify(forYou));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
