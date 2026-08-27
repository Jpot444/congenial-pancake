/**
 * Adult titles stay out of the way until they are asked for by name.
 *
 * "Only have xxx titles appear if they are specifically searched 'xxx -'."
 *
 * The provider files a great deal of this and files it everywhere: grids,
 * shelves, New Releases, and the answer to any search loose enough to catch
 * it. None of it is wanted while somebody is looking for a film with the
 * family in the room, and all of it is wanted by whoever went looking on
 * purpose. So the door is the word itself.
 *
 * Not a lock, and not pretending to be one — this box has no accounts. A door
 * that stays shut unless you open it is the honest version of the ask.
 */
const fs = require('fs');
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

/* ---- the box marks them, rather than leaving the browser to guess -------- */
const src = fs.readFileSync(PATHS.SERVER, 'utf8');
const { isAdult, splitTitle } = new Function(
  `${src.slice(src.indexOf('const TITLE_TAGS'), src.indexOf('function projectItem'))}
   ; return { isAdult, splitTitle };`)();

console.log('  what the box marks');
check('an XXX title is flagged', isAdult('XXX - Some Film'));
check('and keeps its prefix, which is the one that is not filing',
  splitTitle('XXX - Some Film').name === 'XXX - Some Film');
check('an ordinary film is not flagged', !isAdult('Trading Places (1983)'));
check('and neither is a title that merely contains the letters',
  !isAdult('Malcolm Xxxavier') && !isAdult('Triple X'), 'xxx must stand alone');
check('a channel named for it is flagged too', isAdult('XXX | Late Night'));

const ITEMS = [
  { kind: 'movie', id: 1, name: 'Trading Places (1983)', categoryId: 'c1', adult: false },
  { kind: 'movie', id: 2, name: 'Places in the Heart', categoryId: 'c1', adult: false },
  { kind: 'movie', id: 3, name: 'XXX - Something Explicit', categoryId: 'c9', adult: true },
  { kind: 'movie', id: 4, name: 'XXX - Another One Places', categoryId: 'c9', adult: true },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  const show = (query, category = null) => page.evaluate((args) => {
    state.config.mode = 'xtream';
    state.library.movies = { categories: [{ id: 'c1', name: 'Films' },
      { id: 'c9', name: 'XXX Films' }], items: args.items };
    state.tab = 'movies';
    state.movieId = '';
    state.category = args.category;
    state.query = args.query;
    render();
    return {
      cards: [...document.querySelectorAll('#grid .card .card-title')].map((t) => t.textContent),
      cats: [...document.querySelectorAll('#catList .cat')].map((c) => c.textContent),
    };
  }, { items: ITEMS, query, category });

  console.log('\n  browsing');
  // Inside a category, because with no query and no category the Movies tab
  // draws shelves rather than a grid — those are checked further down.
  const browsing = await show('', 'c1');
  console.log('   ', JSON.stringify(browsing));
  check('they are not in the grid', !browsing.cards.join('|').includes('XXX'),
    JSON.stringify(browsing.cards));
  check('the ordinary titles still are', browsing.cards.length === 2,
    JSON.stringify(browsing.cards));
  check('and the category holding them is gone from the sidebar with them,',
    browsing.cats.length > 0 && !browsing.cats.join('|').includes('XXX'),
    JSON.stringify(browsing.cats));
  console.log('       rather than sitting there promising titles that never appear');

  console.log('\n  a search that is not looking for them');
  const loose = await show('places');
  console.log('   ', JSON.stringify(loose.cards));
  check('a query that would otherwise catch one does not',
    !loose.cards.join('|').includes('XXX'), JSON.stringify(loose.cards));
  check('while still answering what was asked', loose.cards.length === 2,
    JSON.stringify(loose.cards));

  console.log('\n  and a search that is');
  const asked = await show('xxx');
  console.log('   ', JSON.stringify(asked.cards));
  check('typing the word opens the door',
    asked.cards.filter((t) => t.startsWith('XXX')).length === 2,
    JSON.stringify(asked.cards));

  const askedFull = await show('xxx places');
  console.log('   ', JSON.stringify(askedFull.cards));
  check('and it narrows like any other search',
    askedFull.cards.length === 1 && /Another One Places/.test(askedFull.cards[0]),
    JSON.stringify(askedFull.cards));

  console.log('\n  the shelves, which nobody chose the contents of');
  const shelves = await page.evaluate((items) => {
    state.library.movies = { categories: [{ id: 'c1', name: 'Films' },
      { id: 'c9', name: 'XXX Films' }], items };
    return buildShelves('movies')
      .flatMap((row) => row.items.map((i) => i.name));
  }, ITEMS);
  console.log('   ', JSON.stringify(shelves));
  check('nothing adult reaches a shelf, whatever is being searched',
    !shelves.join('|').includes('XXX'), JSON.stringify(shelves));

  console.log('\n  and multi-view has the same door');
  const mv = await page.evaluate((items) => {
    const before = browsable(items, '');
    const after = browsable(items, 'xxx');
    return { closed: before.length, open: after.length };
  }, ITEMS);
  console.log('   ', JSON.stringify(mv));
  check('shut by default, open on the word',
    mv.closed === 2 && mv.open === 4, JSON.stringify(mv));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
