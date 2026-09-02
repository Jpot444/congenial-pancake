/**
 * Backing out lands where you were, not at the top.
 *
 * "When I back out of a search in movies tv or live it brings me back to a
 *  main screen. I want it to bring me back to whatever page I was last on.
 *  Like if I was searching I want to be brought back to whatever my search
 *  results were"
 *
 * A tab is not one page. Movies is the shelves, or one shelf, or one category,
 * or the results of a search — and only the tab itself was ever in the
 * address. The other three lived in memory, and the exact sequence that breaks
 * it is the ordinary one:
 *
 *   type "film" → results → open one → the hash becomes #/movies/55 →
 *   goTo() clears the query and empties the search box on the way past →
 *   press back → #/movies → the front of Movies, results gone.
 *
 * The search was not lost when you pressed back. It was lost when you OPENED
 * the thing, and back had nothing left to return to. So the view goes in the
 * address — #/movies?q=film, #/live?cat=SPORTS — where navigating cannot wipe
 * it and the phone's own back button restores it for nothing.
 *
 * Two things this must not do, both checked below: pressing a tab in the nav
 * must still open that tab's front page rather than resurrecting an hour-old
 * search, and typing must not push a history entry per letter — otherwise
 * getting out of "batman" takes six presses of back.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/similar*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"continueWatching":[],"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  /* A library with two obviously different names in it, so "did the filter
     survive" is answered by what is on screen rather than by a count. */
  await page.evaluate(() => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    state.library.movies = {
      categories: [{ id: 'c1', name: 'Westerns' }, { id: 'c2', name: 'Comedy' }],
      items: [
        { kind: 'movie', id: 55, name: 'Redwood Gulch', categoryId: 'c1', ext: 'mp4', logo: '' },
        { kind: 'movie', id: 56, name: 'Redwood Station', categoryId: 'c1', ext: 'mp4', logo: '' },
        { kind: 'movie', id: 57, name: 'Custard Pie', categoryId: 'c2', ext: 'mp4', logo: '' },
      ],
    };
    state.library.live = {
      categories: [{ id: 'sport', name: 'SPORTS' }, { id: 'news', name: 'NEWS' }],
      items: [
        { kind: 'live', id: 900, name: 'Ball Channel', categoryId: 'sport', logo: '' },
        { kind: 'live', id: 901, name: 'Talk Channel', categoryId: 'news', logo: '' },
      ],
    };
  });

  /* Only the grid that is actually on screen. The shelves view, the home rows
     and a film's page all keep their own cards in the document, so an
     unscoped .card-title reads several pages at once. */
  const titles = () => page.evaluate(() =>
    [...document.querySelectorAll('#grid:not([hidden]) .card-title')]
      .map((n) => n.textContent.trim()));
  /* "Opened fresh" asked of the state rather than of a container, because the
     two layers draw a tab's front page out of different furniture and this is
     a claim about both. */
  const front = () => page.evaluate(() =>
    state.query === '' && state.shelf === null && state.category === null);
  const box = () => page.evaluate(() => document.querySelector('#searchInput').value);
  const hash = () => page.evaluate(() => location.hash);

  const search = async (text) => {
    await page.evaluate(() => { document.querySelector('#searchInput').value = ''; });
    await page.locator('#searchInput').fill(text);
    await wait(700);
  };

  /* ---- 1. searching, and the address knowing it ------------------------- */
  console.log('\n  a search in Movies');
  await page.evaluate(() => { location.hash = '#/movies'; });
  await wait(900);
  await search('redwood');
  const found = await titles();
  console.log('   showing:', JSON.stringify(found), 'at', JSON.stringify(await hash()));
  check('the results are the ones searched for',
    found.length === 2 && found.every((t) => /Redwood/.test(t)), JSON.stringify(found));
  check('and the address says what is being shown',
    /[?&]q=redwood/.test(await hash()), await hash());

  /* ---- 2. typing does not fill the history ------------------------------ */
  /*
   * Written with replaceState for exactly this reason. Six letters, six
   * entries, and leaving the search means pressing back six times — which is
   * a worse bug than the one being fixed.
   */
  const depth = await page.evaluate(() => history.length);
  await search('custard');
  const after = await page.evaluate(() => history.length);
  console.log(`   history ${depth} → ${after}`);
  check('typing a second search does not stack up history entries',
    after === depth, `${depth} → ${after}`);
  await search('redwood');

  /* ---- 3. open one, and come back --------------------------------------- */
  console.log('\n  opening a result and backing out of it');
  await page.locator('#grid .card-title', { hasText: 'Redwood Gulch' }).first().click();
  await page.waitForSelector('.film-title', { timeout: 10000 });
  await wait(800);
  console.log('   opened:', JSON.stringify(await hash()));
  check('the film opens on its own page', /#\/movies\/55/.test(await hash()), await hash());

  /* The page's own back button — the one under somebody's thumb. */
  await page.locator('.film-back').first().click();
  await wait(900);
  const returned = await titles();
  console.log('   back at:', JSON.stringify(await hash()), JSON.stringify(returned));
  check('the page back button returns to the search results',
    returned.length === 2 && returned.every((t) => /Redwood/.test(t)), JSON.stringify(returned));
  check('and the search box still holds what was typed',
    (await box()) === 'redwood', await box());

  /* ---- 4. and the browser's own back does too ---------------------------- */
  /*
   * The phone's back gesture, which is what "back out" usually means. It
   * cannot be taught anything — it just goes to the previous address — so this
   * only works because the search is IN the address.
   */
  console.log('\n  and the browser back button');
  await page.locator('#grid .card-title', { hasText: 'Redwood Station' }).first().click();
  await page.waitForSelector('.film-title', { timeout: 10000 });
  await wait(800);
  await page.goBack();
  await wait(1000);
  const backed = await titles();
  console.log('   back at:', JSON.stringify(await hash()), JSON.stringify(backed));
  check('goes back to the results as well',
    backed.length === 2 && backed.every((t) => /Redwood/.test(t)), JSON.stringify(backed));
  check('with the box still filled in', (await box()) === 'redwood', await box());

  /* ---- 5. a category is a page you were on too --------------------------- */
  /*
   * The request said "movies tv or live", and in Live the thing you are on is
   * almost always a category rather than a search. It was thrown away by the
   * same line for the same reason.
   */
  console.log('\n  a category in Live TV');
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(1400);
  /* Put the stub back AFTER the move: going to Live really does load the
     library, and the box under test has no provider to load it from. */
  await page.evaluate(() => {
    state.library.live = {
      categories: [{ id: 'sport', name: 'SPORTS' }, { id: 'news', name: 'NEWS' }],
      items: [
        { kind: 'live', id: 900, name: 'Ball Channel', categoryId: 'sport', logo: '' },
        { kind: 'live', id: 901, name: 'Talk Channel', categoryId: 'news', logo: '' },
      ],
    };
    state.category = null;
    render();
  });
  await wait(500);
  /* Whichever layer is drawing. A wide window gets the desktop shell, which
     lays Live out itself — same state underneath, different furniture — and a
     suite that only knew one of them would pass on one screen size. */
  await page.evaluate(() => {
    const tile = [...document.querySelectorAll('#grid .card, [id^="dkcat-"] .shelf-head')]
      .find((n) => /SPORTS/i.test(n.textContent || ''));
    if (tile) tile.click();
  });
  await wait(800);
  console.log('   at:', JSON.stringify(await hash()));
  check('the address records which category is open',
    /[?&]cat=sport/.test(await hash()), await hash());
  /* Straight back in on that address, the way a bookmark or a reload would. */
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1400);
  const stillIn = await page.evaluate(() => String(state.category));
  console.log('   after a reload, category:', JSON.stringify(stillIn));
  check('and returning to that address opens the same category',
    stillIn === 'sport', stillIn);

  /* ---- 6. but pressing the tab is still a fresh start -------------------- */
  /*
   * The other half of getting this right. Restoring where somebody was is only
   * wanted when they are COMING BACK; pressing Movies in the nav means "show
   * me Movies", and resurrecting an hour-old search there would be its own
   * complaint.
   */
  console.log('\n  and pressing the tab itself');
  await page.evaluate(() => { location.hash = '#/movies?q=redwood'; });
  await wait(900);
  check('a search address does restore the search', (await box()) === 'redwood', await box());
  await page.evaluate(() => { location.hash = '#/movies'; });
  await wait(900);
  const fresh = await front();
  console.log('   box:', JSON.stringify(await box()), '· front page:', fresh);
  check('but the plain tab address opens the tab, not the old search',
    (await box()) === '' && fresh, `${await box()} / front ${fresh}`);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
