/**
 * What the Shield app shows, and what it refuses to show.
 *
 * Four claims, all of which were false at once:
 *
 *   1. Art appears. Every card built its image detached from the page and put
 *      it in on load — but a lazily-loaded image that is not in a document has
 *      no viewport to be near, so the browser never started the request, the
 *      load never came, and not one poster or logo in the whole app ever
 *      arrived. Every card fell back to its name plate, for ever.
 *   2. Names are read the way the portal reads them. The provider writes its
 *      quality tags in superscript letters — ᴴᴰ, ᴿᴬᵂ, ⁶⁰ᶠᵖˢ — which survive
 *      every plain-text tidy because they are ordinary characters.
 *   3. A category is a screen. Choosing one used to swap the contents of one
 *      row and leave the games above it and every other category below, so
 *      what you got was neither the category nor the list.
 *   4. What this profile threw away stays thrown away. The bin is kept in the
 *      profile's prefs on the box, which is the same record this app already
 *      loads — a channel binned on the phone must be gone from the TV.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

/* The box's own bison, through the box's own image proxy: a real image over a
   real socket, so "the art loads" is not being taken on trust from a stub. */
const LOGO = `${BASE}/bison.png`;

const LIVE = {
  categories: [
    { id: 'c1', name: 'USA ENTERTAINMENT ᴴᴰ ⁶⁰ᶠᵖˢ' },
    { id: 'c2', name: 'USA SPORTS ᴿᴬᵂ' },
    { id: 'c3', name: 'A CATEGORY THIS PROFILE BINNED' },
  ],
  items: [
    ...Array.from({ length: 7 }, (_, i) => ({
      kind: 'live', id: 200 + i, num: 200 + i, name: `ENT CHANNEL ${i + 1} ᴿᴬᵂ ⁶⁰ᶠᵖˢ`,
      logo: LOGO, categoryId: 'c1',
    })),
    { kind: 'live', id: 301, num: 301, name: 'SPORTS ONE', logo: LOGO, categoryId: 'c2' },
    { kind: 'live', id: 999, num: 999, name: 'THROWN AWAY', logo: LOGO, categoryId: 'c2' },
    { kind: 'live', id: 777, num: 777, name: 'INSIDE A BINNED CATEGORY', logo: LOGO, categoryId: 'c3' },
  ],
  totals: { items: 10 },
};

/* The prefs record the portal writes: the bin is two lists, one of titles and
   one of whole categories. */
const PREFS = {
  favorites: [],
  pinnedCategories: [],
  deletedItems: ['live:999'],
  deletedCategories: ['c3'],
  owner: true,
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  await page.route('**/api/scores/nfl**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[]}' }));
  await page.route('**/api/profiles/*/prefs', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREFS) }));

  await page.goto(`${BASE}/tv/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  console.log('\n  the art');
  const home = await page.evaluate(() => ({
    /* `.on` is set by the load handler, so this counts pictures that actually
       arrived rather than <img> tags that exist. */
    loaded: document.querySelectorAll('.chan-art img.on').length,
    tags: document.querySelectorAll('.chan-art img').length,
    cards: document.querySelectorAll('.chan-card').length,
    plates: document.querySelectorAll('.chan-art .plate').length,
  }));
  console.log('   home:', JSON.stringify(home));
  check('every card with a logo has its picture, not its name plate',
    home.loaded > 0 && home.loaded === home.tags, JSON.stringify(home));
  check('and the plates are gone from the cards that got one',
    home.plates === home.cards - home.loaded, JSON.stringify(home));

  console.log('\n  the names');
  const names = await page.evaluate(() => ({
    cats: [...document.querySelectorAll('.cat-card .card-name')].map((n) => n.textContent),
    chans: [...document.querySelectorAll('.chan-card .card-name')].map((n) => n.textContent),
  }));
  console.log('   cats :', JSON.stringify(names.cats));
  const superscript = /[ʰ-˿ᴬ-ᵫᶠ-ᶿ⁰-₟]/;
  check('no superscript tag survives on a category',
    names.cats.every((n) => !superscript.test(n)), names.cats.join(' | '));
  check('or on a channel',
    names.chans.every((n) => !superscript.test(n)), names.chans.join(' | '));
  check('and the name that is left is still the name',
    names.cats.includes('USA ENTERTAINMENT'), names.cats.join(' | '));

  console.log('\n  the bin');
  check('a binned channel is not on screen',
    !names.chans.includes('THROWN AWAY'), names.chans.join(' | '));
  check('a binned category is not offered',
    !names.cats.some((n) => n.includes('BINNED')), names.cats.join(' | '));
  check('and nothing inside it leaks out through the channel row',
    !names.chans.includes('INSIDE A BINNED CATEGORY'), names.chans.join(' | '));

  console.log('\n  opening a category');
  await page.locator('.cat-card').first().click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);

  const cat = await page.evaluate(() => ({
    title: document.querySelector('.rowhead h2')?.textContent || '',
    cards: document.querySelectorAll('.chan-card').length,
    rows: [...new Set([...document.querySelectorAll('.chan-card')].map((c) => c.dataset.r))].length,
    cats: document.querySelectorAll('.cat-card').length,
    games: document.querySelectorAll('.game').length,
  }));
  console.log('   category:', JSON.stringify(cat));
  check('the screen is the category, named', cat.title === 'USA ENTERTAINMENT', cat.title);
  check('holding all of its channels', cat.cards === 7, String(cat.cards));
  check('as a grid rather than one long row', cat.rows === 2, `${cat.rows} row(s)`);
  check('with no other categories under it', cat.cats === 0, String(cat.cats));
  check('and no games row over it', cat.games === 0, String(cat.games));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const back = await page.evaluate(() => ({
    cats: document.querySelectorAll('.cat-card').length,
    head: document.querySelector('.rowhead h2')?.textContent || '',
  }));
  check('BACK returns to the whole of Live TV',
    back.cats > 0 && back.head === 'LIVE NOW', JSON.stringify(back));

  console.log('\n  the picture is not signed');
  /* A title burned across the middle of whatever is playing. */
  const marked = await page.evaluate(() =>
    document.querySelectorAll('.player-watermark, .quad-watermark').length);
  check('no watermark element is built anywhere', marked === 0, String(marked));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
