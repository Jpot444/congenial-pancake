/**
 * Build a multiview: assemble the set, then watch it.
 *
 * From a screen recording of somebody else's app, and the request was exact:
 * "I want my player to match that function of 'build a multiview'".
 *
 * What it does there: a sheet with your picks along the top — each one
 * removable — the catalogue underneath with its own filters, and one pinned
 * button that puts the whole lot on screen at once.
 *
 * What this player did instead: the grid exists first, and every empty cell
 * has a + that opens a picker scoped to THAT CELL. For swapping one picture
 * while the other three keep playing, that is the better shape and it stays.
 * For starting a multiview it is four trips through the same picker with a
 * grid of holes staring back between them.
 *
 * So the two live side by side, and the picker underneath is the same picker —
 * same sources, same search, same categories. The only thing that changes is
 * what a tap on a result MEANS, which is why every commit point was funnelled
 * through one `take()` rather than left as three places that have to agree.
 */
const { chromium } = require('./playwright.js');
const { openMultiview } = require('./mv.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ident = (t) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="45"><text y="24">${t}</text></svg>`);

const CHANNELS = [
  { kind: 'live', id: 1, name: 'US| NFL PPV 01', logo: ident('NFL'), categoryId: 'c1' },
  { kind: 'live', id: 2, name: 'US| NBC East', logo: ident('NBC'), categoryId: 'c1' },
  { kind: 'live', id: 3, name: 'US| CBS West', logo: ident('CBS'), categoryId: 'c1' },
  { kind: 'live', id: 4, name: 'US| FOX Sports', logo: ident('FOX'), categoryId: 'c1' },
  { kind: 'live', id: 5, name: 'US| ESPN Deep', logo: ident('ESPN'), categoryId: 'c1' },
];
const CATEGORIES = [{ id: 'c1', name: 'Sports' }];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  /* Every cell asks for a stream; none of them has to arrive for this suite,
     which is about which cells were ASKED for and with what. */
  let playCalls = [];
  let playAt = [];
  await page.route('**/api/play*', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname !== '/api/play') return r.continue();
    playCalls.push(url.searchParams.get('id'));
    playAt.push(Date.now());
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/api/nothing","format":"m3u8"}' });
  });
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(600);
  await page.evaluate((c) => {
    state.library.live = { categories: c.cats, items: c.items };
    render();
  }, { items: CHANNELS, cats: CATEGORIES });

  await openMultiview(page);
  await wait(700);

  /* ---- the way in ------------------------------------------------------ */
  console.log('\n  the way in');
  check('multi-view offers building a set, not only filling cells',
    await page.evaluate(() => {
      const b = document.querySelector('#mvBuildBtn');
      return Boolean(b && b.getClientRects().length);
    }), 'no build control on the multi-view bar');
  /* The per-cell + stays. It is the right control for changing ONE picture,
     and removing it would make swapping a channel cost a rebuild. */
  check('and every empty cell still has its own +, for swapping just one',
    await page.evaluate(() => document.querySelectorAll('#mvGrid .mv-empty').length >= 2),
    'the per-cell picker went away');

  /* ---- assembling ------------------------------------------------------ */
  console.log('\n  assembling a set');
  await page.evaluate(() => multiview.buildSet());
  await wait(400);
  let seen = await page.evaluate(() => ({
    basket: !document.querySelector('#mvBasket').hidden,
    go: !document.querySelector('#mvBasketGo').hidden,
    count: document.querySelector('#mvBasketCount').textContent,
    disabled: document.querySelector('#mvBasketWatch').disabled,
  }));
  console.log('   ', JSON.stringify(seen));
  check('the set and its button are on screen', seen.basket && seen.go, JSON.stringify(seen));
  /* The heading carries the mode. The picker's own title is the LOCATION —
     "Sports", "Favorites", a show's name — and is left to say that. */
  check('and the sheet says what it is for', /build a multiview/i.test(seen.count), seen.count);
  check('with the ceiling named before anything is picked',
    /up to 4/.test(seen.count), seen.count);
  check('and no way to start something empty', seen.disabled === true, String(seen.disabled));

  /* Added through the shipped path — the picker's own result cards — rather
     than by calling basketAdd, so the funnel through take() is what is under
     test and not a method nothing presses. */
  const addByName = async (name) => {
    await page.evaluate((n) => {
      const card = [...document.querySelectorAll('#mvResults .card')]
        .find((c) => (c.querySelector('.card-title')?.textContent || '').includes(n));
      if (card) card.click();
    }, name);
    await wait(250);
  };
  await page.evaluate(() => { $('#mvSearch').value = 'NFL'; multiview.results('NFL'); });
  await wait(300);
  await addByName('NFL PPV 01');
  await page.evaluate(() => { $('#mvSearch').value = 'NBC'; multiview.results('NBC'); });
  await wait(300);
  await addByName('NBC East');

  seen = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#mvBasketRows .mv-basket-row h4')]
      .map((h) => h.textContent),
    count: document.querySelector('#mvBasketCount').textContent,
    label: document.querySelector('#mvBasketWatch').textContent,
    disabled: document.querySelector('#mvBasketWatch').disabled,
    playedYet: null,
  }));
  console.log('   ', JSON.stringify(seen.rows), seen.count);
  check('each pick joins the set', seen.rows.length === 2, JSON.stringify(seen.rows));
  check('and it counts them against the ceiling', /2 of 4/.test(seen.count), seen.count);
  check('the button says how many it will open', /2/.test(seen.label), seen.label);
  check('and it can be pressed from two, not only from four',
    seen.disabled === false, String(seen.disabled));
  /* The point of building first: NOTHING is playing yet. A set that started
     each pick as it was chosen would be the old behaviour wearing a list. */
  check('and nothing has been asked of the provider yet',
    playCalls.length === 0, JSON.stringify(playCalls));

  /* ---- removing --------------------------------------------------------- */
  console.log('\n  and taking one back out');
  await page.evaluate(() => document.querySelector('#mvBasketRows .mv-basket-x').click());
  await wait(250);
  seen = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#mvBasketRows .mv-basket-row h4')]
      .map((h) => h.textContent),
    count: document.querySelector('#mvBasketCount').textContent,
  }));
  check('it leaves the set', seen.rows.length === 1, JSON.stringify(seen.rows));
  check('and the one that goes is the one whose × was pressed',
    /NBC/.test(seen.rows[0] || ''), JSON.stringify(seen.rows));

  /* ---- the ceiling ----------------------------------------------------- */
  /*
   * A + that silently does nothing reads as broken rather than as full, so
   * the fifth is refused OUT LOUD and the sentence names the way out.
   */
  console.log('\n  and a fifth is refused in words');
  for (const name of ['CBS West', 'FOX Sports', 'ESPN Deep']) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate((n) => { $('#mvSearch').value = n; multiview.results(n); }, name);
    // eslint-disable-next-line no-await-in-loop
    await wait(250);
    // eslint-disable-next-line no-await-in-loop
    await addByName(name);
  }
  let full = await page.evaluate(() => ({
    rows: document.querySelectorAll('#mvBasketRows .mv-basket-row').length,
    count: document.querySelector('#mvBasketCount').textContent,
  }));
  check('four fit', full.rows === 4 && /4 of 4/.test(full.count), JSON.stringify(full));

  await page.evaluate(() => { $('#mvSearch').value = 'NFL'; multiview.results('NFL'); });
  await wait(250);
  await addByName('NFL PPV 01');
  full = await page.evaluate(() => ({
    rows: document.querySelectorAll('#mvBasketRows .mv-basket-row').length,
    toast: document.querySelector('#toast')?.textContent || '',
  }));
  console.log('   ', JSON.stringify(full));
  check('the fifth does not silently vanish', full.rows === 4, String(full.rows));
  check('it is said out loud, and the sentence names the way out',
    /remove one/i.test(full.toast), full.toast);

  /* The same thing twice is refused too, and for the same reason: two cells
     showing one channel is two connections spent on one picture. */
  console.log('\n  and the same thing twice is refused too');
  /* Rebuilt from scratch to a known pair, because slicing whatever happened
     to be in the set left the test asserting a duplicate of something that
     was not in it — which passed for the wrong reason and then failed for
     the right one. */
  await page.evaluate(() => {
    multiview.basket = [];
    multiview.paintBasket();
    $('#mvSearch').value = 'NFL';
    multiview.results('NFL');
  });
  await wait(250);
  await addByName('NFL PPV 01');
  await page.evaluate(() => { $('#mvSearch').value = 'NBC'; multiview.results('NBC'); });
  await wait(250);
  await addByName('NBC East');
  /* Now the same one again. */
  await page.evaluate(() => { $('#mvSearch').value = 'NFL'; multiview.results('NFL'); });
  await wait(250);
  await addByName('NFL PPV 01');
  const dupe = await page.evaluate(() => ({
    rows: document.querySelectorAll('#mvBasketRows .mv-basket-row').length,
    toast: document.querySelector('#toast')?.textContent || '',
  }));
  check('it is not added a second time', dupe.rows === 2, String(dupe.rows));
  check('and it says why', /already/i.test(dupe.toast), dupe.toast);

  /* ---- watching it ----------------------------------------------------- */
  console.log('\n  and then the whole set at once');
  playCalls = [];
  playAt = [];
  await page.evaluate(() => document.querySelector('#mvBasketWatch').click());
  await wait(1500);
  const playSpread = playAt.length > 1 ? playAt[playAt.length - 1] - playAt[0] : null;
  console.log('   asks spread over', playSpread, 'ms');
  const after = await page.evaluate(() => ({
    picker: document.querySelector('#mvPicker').hidden,
    count: multiview.count,
    filled: multiview.cells.filter((c) => c && c.item).map((c) => c.item.name),
    basket: multiview.basket.length,
    building: multiview.building,
  }));
  console.log('   ', JSON.stringify(after));
  check('the sheet closes', after.picker === true, String(after.picker));
  check('every pick is in a cell', after.filled.length === 2, JSON.stringify(after.filled));
  /* The grid becomes the size of the set. Two picks and two holes beside them
     would be the screen arguing with the choice just made. */
  check('and the grid is the size of the set, not left at four',
    after.count === 2, String(after.count));
  check('with the set put down afterwards', after.basket === 0 && !after.building,
    JSON.stringify(after));
  check('and each cell really asked for its own stream',
    playCalls.length === 2, JSON.stringify(playCalls));
  /*
   * ALL OF THEM AT ONCE, not one after the next.
   *
   * "it loads the streams in one at a time after i press start watching, one
   *  press start watching I want all streams already going."
   *
   * They were awaited in turn, which filled the grid one picture at a time.
   * Nothing about waiting made the provider more willing — the same
   * connections are asked for either way — so they go together now, and the
   * gap between the first ask and the last is what says so.
   */
  check('and they were asked for together, not one after the other',
    playSpread !== null && playSpread < 400, `${playSpread}ms between first and last`);

  /* ---- editing what is playing ----------------------------------------- */
  /*
   * Reopening is an EDIT, not a fresh start: the set arrives holding what is
   * on screen. Starting empty would mean re-picking everything to change one
   * thing, which is the cost the whole feature exists to remove.
   */
  console.log('\n  and reopening it edits what is on, rather than starting over');
  await page.evaluate(() => multiview.buildSet());
  await wait(400);
  const again = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#mvBasketRows .mv-basket-row h4')]
      .map((h) => h.textContent),
  }));
  console.log('   ', JSON.stringify(again.rows));
  check('it opens holding what is already playing',
    again.rows.length === 2, JSON.stringify(again.rows));

  /* And a picture that survives an edit is not restarted — its buffer and its
     provider slot are worth more than the tidiness of rebuilding it. */
  playCalls = [];
  await page.evaluate(() => {
    /* Drop one, keep the other, and commit. */
    multiview.basket = multiview.basket.slice(0, 1);
    multiview.paintBasket();
    document.querySelector('#mvBasketWatch').click();
  });
  await wait(1200);
  const edited = await page.evaluate(() => ({
    filled: multiview.cells.filter((c) => c && c.item).map((c) => c.item.name),
  }));
  console.log('   ', JSON.stringify(edited), 'new /api/play calls:', playCalls.length);
  check('the one that stayed is still there',
    edited.filled.length === 1, JSON.stringify(edited.filled));
  check('and it was not torn down and started again for nothing',
    playCalls.length === 0, JSON.stringify(playCalls));

  /* ---- what Live TV opens on ------------------------------------------- */
  /*
   * "In the 'pick something' area add the live sports display that is on my
   *  live tv homescreen. Below that, instead of catagories, make it the
   *  listings for my favorite shows ... only bigger and with the logos for
   *  the broadcasts. Put the catagories below that."
   *
   * The ORDER is the substance: each section is more likely than the one
   * below it to hold the thing being looked for. Categories were the only
   * thing here and are the least likely of the three.
   */
  console.log('\n  and Live TV opens on what is on, then yours, then the rest');
  await page.evaluate(() => {
    /* Two of the channels marked as favourites, so the middle section has
       something to draw. Idempotent, because toggling twice un-favourites. */
    for (const item of state.library.live.items.slice(0, 2)) {
      if (!profiles.hasFav(item)) profiles.toggleFav(item);
    }
    multiview.closePicker();
    multiview.buildSet();
  });
  await wait(700);
  const land = await page.evaluate(() => {
    const box = document.querySelector('#mvResults');
    const order = [...box.children].map((n) => n.className);
    return {
      landing: box.classList.contains('mv-landing'),
      order,
      favs: box.querySelectorAll('.mv-land-favs .card').length,
      cats: box.querySelectorAll('.mv-land-cats .card').length,
      heads: [...box.querySelectorAll('.mv-land-head h3')].map((h) => h.textContent),
    };
  });
  console.log('   ', JSON.stringify(land));
  check('the sections are in that order', 
    land.order.findIndex((c) => /mv-land-favs/.test(c))
      < land.order.findIndex((c) => /mv-land-cats/.test(c))
    && land.order.findIndex((c) => /mv-land-favs/.test(c)) > -1,
    JSON.stringify(land.order));
  check('your own channels are there, above the categories',
    land.favs === 2, String(land.favs));
  check('and the categories are still reachable, just last',
    land.cats >= 1, String(land.cats));
  check('each section says what it is',
    land.heads.includes('Your channels') && land.heads.includes('All channels'),
    JSON.stringify(land.heads));
  /* The band is BORROWED — one band exists in the whole app and desktop.js
     hands it out. Only present in desktop layout, which is where this runs. */
  check('and the live band is borrowed rather than a second copy of it',
    await page.evaluate(() => {
      const inSheet = document.querySelector('#mvResults #dkScores');
      return Boolean(inSheet) && document.querySelectorAll('#dkScores').length === 1;
    }), 'either no band or two of them');

  /* And handed back, or the page behind loses the most visible thing on it. */
  await page.evaluate(() => multiview.closePicker());
  await wait(400);
  check('and handed back when the sheet closes',
    await page.evaluate(() => {
      const band = document.querySelector('#dkScores');
      return Boolean(band) && !band.closest('#mvResults');
    }), 'the band was left inside the picker');

  /* ---- the panel that opened itself ------------------------------------ */
  /*
   * "Get rid of the auto popup of 'other games' but keep the button there."
   *
   * Opening multi-view from inside a game used to open the suggestions panel
   * with it, answering a question that had not been asked. The button stays.
   */
  console.log('\n  and other games no longer opens itself');
  const suggest = await page.evaluate(() => ({
    panel: document.querySelector('#mvSuggest')?.hidden,
    button: Boolean(document.querySelector('#mvSuggestBtn')?.getClientRects().length),
  }));
  check('the panel is not showing', suggest.panel === true, String(suggest.panel));
  check('but the button still is', suggest.button === true, String(suggest.button));
  /* Source-level, because what is being asserted is the ABSENCE of a call
     that only fires on a path this suite does not take. */
  const APP = require('fs').readFileSync(
    require('./paths.js').ROOT + '/public/app.js', 'utf8');
  const carry = APP.slice(APP.indexOf("$('#cinemaMultiview')"));
  check('and carrying a channel in no longer opens it either',
    !/multiview\.suggest\(\);/.test(carry.slice(0, 1200)),
    'the auto-open is still wired to the player button');

  /* ---- cancelling ------------------------------------------------------ */
  console.log('\n  and a set abandoned half-built does not linger');
  await page.evaluate(() => {
    multiview.buildSet();
    $('#mvSearch').value = 'CBS';
    multiview.results('CBS');
  });
  await wait(300);
  await addByName('CBS West');
  await page.evaluate(() => multiview.closePicker());
  await wait(200);
  const gone = await page.evaluate(() => ({
    basket: multiview.basket.length,
    building: multiview.building,
    shown: !document.querySelector('#mvBasket').hidden,
  }));
  check('it is thrown away with the sheet',
    gone.basket === 0 && gone.building === false, JSON.stringify(gone));
  check('and cannot reappear behind the next single-cell pick',
    gone.shown === false, String(gone.shown));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
