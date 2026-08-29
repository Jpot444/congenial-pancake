/**
 * Live TV's head, and the controls that go with it.
 *
 * Four changes to one page, and the reasoning behind each is the same: the
 * page was spending its most valuable space on things that were not worth it.
 *
 *   THE HEAD was "LIVE TV" set at 44px over "24 pinned · 92 categories ·
 *   11,764 channels" — the name of the page you had just pressed to reach,
 *   and three counts nobody acts on. It is the scores now: the same slate the
 *   television draws, and a card is a way into the broadcast rather than a
 *   picture of it.
 *
 *   THE SORT offered two options, one of which was the provider's own order,
 *   because a channel has no year and no rating to sort on. Multi-view stands
 *   where it stood.
 *
 *   THE VIEW TOGGLE duplicated what opening a category already does. The
 *   listings button stands where it stood.
 *
 *   THE SHEET listed ninety categories and let you jump to one. Now each
 *   carries a pin, and the rows can be dragged into the order they are drawn
 *   in — which is where the pinning ought to have been all along, because the
 *   bar only shows the pinned ones and whichever few fit after them.
 *
 * The catalogue pages still sort and still switch views, and that is checked
 * here too: one bar serves both, and giving Live TV its own controls must not
 * take Movies' away.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const CHANNELS = [
  { kind: 'live', id: 700, num: 700, name: 'US| FOX ᴴᴰ', categoryId: 'c1', logo: '' },
  { kind: 'live', id: 701, num: 701, name: 'US| MLB 01 | ROCKIES X NATIONALS', categoryId: 'c4', logo: '' },
  { kind: 'live', id: 702, num: 702, name: 'US| ESPN ᴴᴰ', categoryId: 'c2', logo: '' },
  { kind: 'live', id: 703, num: 703, name: 'CA| TSN', categoryId: 'c3', logo: '' },
  /* The row that was being picked: a placeholder for a broadcast at a stated
     time, naming both teams, with nothing on it. It sits in the MLB category
     too, so only the stamped time tells it apart from a real game row. */
  { kind: 'live', id: 704, num: 704,
    name: 'US (Peacock 023) | ROCKIES at NATIONALS (2026-08-30 12:00:00)',
    categoryId: 'c4', logo: '' },
];
const CATS = [
  { id: 'c1', name: 'USA SPORTS' },
  { id: 'c2', name: 'USA NEWS' },
  { id: 'c3', name: 'CANADA' },
  { id: 'c4', name: 'USA MLB' },
];
const LIVE = { categories: CATS, items: CHANNELS, totals: { items: CHANNELS.length } };
const FILMS = {
  categories: [{ id: 'm1', name: 'ACTION' }],
  items: [{ kind: 'movie', id: 900, name: 'A Film', categoryId: 'm1', ext: 'mp4' }],
  totals: { items: 1 },
};

/* One game with a channel of its own (both teams in the name), one carried by
   a network, and one nothing on this box has. */
const SCORES = {
  games: [
    { id: 'col-was', sport: 'mlb', status: 'live', channelMatch: 'MLB NETWORK',
      channelName: 'MLB Network', teamMatch: ['Rockies', 'Nationals'],
      detailedState: 'In Progress', warmup: false,
      away: { abbr: 'COL', teamId: 115, logo: 'https://www.mlbstatic.com/team-logos/115.svg',
        record: '60-70', score: 6, possession: true },
      home: { abbr: 'WSH', teamId: 120, logo: 'https://www.mlbstatic.com/team-logos/120.svg',
        record: '58-72', score: 1, possession: false },
      clock: 'Top 9th', inningState: 'Top', inning: '9th',
      onBase: { first: true, second: false, third: true },
      count: { balls: 2, strikes: 1, outs: 1 },
      situation: '1 out · 1st & 3rd · 2-1', progress: 40 },
    { id: 'bos-oak', sport: 'mlb', status: 'upcoming', channelMatch: 'FOX',
      channelName: 'FOX', teamMatch: ['Red Sox', 'Athletics'],
      detailedState: 'Warmup', warmup: true,
      away: { abbr: 'BOS', teamId: 111, logo: 'https://www.mlbstatic.com/team-logos/111.svg',
        record: '70-60', score: null,
        pitcher: { name: 'Jorge De La Rosa', last: 'De La Rosa', wins: 2, losses: 2, era: '2.84' } },
      home: { abbr: 'OAK', teamId: 133, logo: 'https://www.mlbstatic.com/team-logos/133.svg',
        record: '65-65', score: null,
        pitcher: { name: 'Jesse Chavez', last: 'Chavez', wins: 6, losses: 4, era: '2.93' } },
      clock: '4:05 PM', kickoff: Date.now() + 20 * 60000 },
    { id: 'nyy-bos', sport: 'mlb', status: 'final', channelMatch: 'YES NETWORK',
      channelName: 'YES Network', teamMatch: ['Yankees', 'Red Sox'],
      detailedState: 'Final', warmup: false,
      away: { abbr: 'NYY', teamId: 147, logo: '', record: '75-55', score: 2 },
      home: { abbr: 'BOS2', teamId: 111, logo: '', record: '68-62', score: 7 },
      clock: 'Final' },
  ],
};

const PREFS = {
  favorites: [],
  pinnedCategories: ['live:c1'],
  deletedItems: [], deletedCategories: [], owner: true,
  tourDone: true, liveTourDone: true, reportNoticeSeen: true, dlExplainSeen: true,
};

async function open(browser, { scores = SCORES, status = 200 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) => {
    // The box takes `tab`, not `kind` — a route that reads the wrong one
    // answers every page with the film list and quietly makes the channel
    // matching below look broken.
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'live' ? LIVE : FILMS) });
  });
  await page.route('**/api/profiles/*/prefs', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREFS) })
    : r.continue()));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/epg/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  /* The league's marks come through the box's image proxy, which cannot reach
     mlbstatic.com from a test machine — and a mark that does not load is
     removed on purpose, so without this every card would be exercising the
     fallback instead of the badge. */
  await page.route('**/img?u=**', (r) => r.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect '
      + 'width="40" height="40" fill="#456"/></svg>',
  }));
  page.__scoreCalls = 0;
  await page.route('**/api/scores**', (r) => {
    page.__scoreCalls += 1;
    return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(scores) });
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => { state.config.mode = 'xtream'; location.hash = '#/live'; });
  await page.waitForTimeout(2200);
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const page = await open(browser);

  /* ---- the head is the slate ------------------------------------------- */
  console.log('\n  what is on, where the page title was');
  const head = await page.evaluate(() => ({
    band: Boolean(document.querySelector('#dkScores')),
    titleShown: !document.querySelector('#contentTitle')?.parentElement?.hidden,
    title: document.querySelector('.sc-title')?.textContent,
    meta: document.querySelector('.sc-meta')?.textContent,
    cards: [...document.querySelectorAll('.sc-card')].map((c) => ({
      cls: c.className,
      chan: c.querySelector('.sc-tune')?.title || '',
      dead: c.querySelector('.sc-tune').disabled,
      score: c.querySelector('.sc-score')?.textContent ?? null,
      half: c.querySelector('.sc-half, .sc-final')?.textContent ?? null,
      time: c.querySelector('.sc-time')?.textContent ?? null,
      warmup: c.querySelector('.sc-warmup')?.textContent ?? null,
      marks: [...c.querySelectorAll('.sc-mark img')].map((i) => i.getAttribute('src')),
      fallbacks: [...c.querySelectorAll('.sc-mark.no-mark .sc-fallback')].map((f) => f.textContent),
      bases: ['second', 'third', 'first'].map((b) => {
        const n = c.querySelector(`.sc-diamond .b-${b}`);
        return n ? `${b}:${n.classList.contains('on') ? 'on' : 'off'}` : '';
      }).filter(Boolean),
      count: [...c.querySelectorAll('.sc-countrow')].map((r) =>
        `${r.querySelector('b').textContent}${[...r.querySelectorAll('i.on')].length}`
        + `/${r.querySelectorAll('i').length}`).join(','),
      pitchers: [...c.querySelectorAll('.sc-pitcher')].map((p) => p.textContent.trim()),
    })),
  }));
  console.log('   head:', JSON.stringify(head, null, 1));

  check('the scores stand in the head', head.band, String(head.band));
  check('and the words they replaced are gone, not merely covered',
    head.titleShown === false, String(head.titleShown));
  check('the row says what it is', head.title === 'Live now', head.title);
  check('and how much of it is actually on', /1 game on now/.test(head.meta || ''), head.meta);
  check('a card per game', head.cards.length === 3, String(head.cards.length));

  /* The claim that makes the row a way in rather than a picture: a provider
     that carries a channel per game gets THAT game's channel, not the
     network's. */
  const [first, soon, over] = head.cards;
  check('a live game leads the row', first.cls.includes('is-live'), first.cls);
  check('with the score between the two marks', first.score === '6 - 1', first.score);
  check('and the half-inning under it', first.half === 'Top 9th', first.half);
  check('the clubs are their own marks, not their initials',
    first.marks.length === 2 && first.marks.every((m) => /team-logos%2F/.test(m)),
    JSON.stringify(first.marks));
  check('the diamond is lit where the runners are',
    first.bases.join(',') === 'second:off,third:on,first:on', JSON.stringify(first.bases));
  check('and the count is the count', first.count === 'B2/4,S1/3,O1/3', first.count);
  check('a game with a channel is pressable',
    first.dead === false, String(first.dead));

  /* The provider carries rows like "US (Peacock 023) | Marlins at Nationals
     (2026-08-30 12:00:00)": a placeholder for a broadcast at a stated time,
     naming both teams, with nothing playing on it. It is the best match by
     name, which is exactly why it kept being chosen — and opening it gives a
     channel that is not on. */
  check('a dated event row is never what a card opens, however well it matches',
    !/Peacock/i.test(first.chan || ''), first.chan);
  check('the provider\'s own game row is',
    first.chan === 'Watch on US| MLB 01 | ROCKIES X NATIONALS', first.chan);

  check('a game about to start shows the time, not a score',
    soon.time === '4:05 PM' && soon.score === null, JSON.stringify([soon.time, soon.score]));
  /* The club and the pitcher are separate elements set apart by the layout,
     so textContent runs them together — the words are what is being checked,
     not the gap between them. */
  check('the two probables, with their record and ERA',
    soon.pitchers.join(' | ') === 'BOSDe La Rosa (2-2, 2.84) | OAKChavez (6-4, 2.93)',
    JSON.stringify(soon.pitchers));
  /* The moment the broadcast comes up is the moment tuning to it is worth
     doing, and the league says so in its own status. */
  check('and WARMUP is drawn the moment the league says the broadcast is on',
    soon.warmup === 'Warmup' && soon.cls.includes('is-warmup'),
    JSON.stringify([soon.warmup, soon.cls]));

  check('a game that has finished says so rather than showing a live dot',
    over.cls.includes('is-final') && over.half === 'Final', JSON.stringify([over.cls, over.half]));
  /* A mark the league did not give us must leave the abbreviation showing
     rather than a hole where a badge should be. */
  check('a club with no mark keeps its initials',
    over.fallbacks.join(',') === 'NYY,BOS2', JSON.stringify(over.fallbacks));

  /* ---- starring a game ------------------------------------------------- */
  console.log('\n  starring one puts it at the front');
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('.sc-card')].map((c) => c.dataset.game));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.sc-card')]
      .find((c) => c.dataset.game === 'nyy-bos');
    card.querySelector('.sc-star').click();
  });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    order: [...document.querySelectorAll('.sc-card')].map((c) => c.dataset.game),
    lit: [...document.querySelectorAll('.sc-card.is-pinned')].map((c) => c.dataset.game),
    stored: (profiles.data.pinnedGames || []).map((p) => p.id),
  }));
  console.log('   before:', JSON.stringify(before), '\n   after: ', JSON.stringify(after));
  /* A finished game sat last; starred, it leads — which is the whole point of
     starring one. */
  check('the starred game leads the row', after.order[0] === 'nyy-bos',
    JSON.stringify(after.order));
  check('and wears the ribbon', after.lit.join(',') === 'nyy-bos', JSON.stringify(after.lit));
  check('with the star kept on the box, not just on the card',
    after.stored.join(',') === 'nyy-bos', JSON.stringify(after.stored));

  console.log('\n  and starring it again takes it back out');
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.sc-card')]
      .find((c) => c.dataset.game === 'nyy-bos');
    card.querySelector('.sc-star').click();
  });
  await page.waitForTimeout(700);
  const undone = await page.evaluate(() => ({
    order: [...document.querySelectorAll('.sc-card')].map((c) => c.dataset.game),
    stored: (profiles.data.pinnedGames || []).map((p) => p.id),
  }));
  check('the row goes back to what was on first',
    undone.order.join(',') === before.join(','), JSON.stringify(undone.order));
  check('and nothing is left starred', undone.stored.length === 0, JSON.stringify(undone.stored));

  /* The star is a control sitting on top of a card that is itself a button:
     pressing it must not also tune the game underneath it. */
  check('and starring never tuned the game underneath',
    await page.evaluate(() => Boolean(document.querySelector('#playerOverlay')?.hidden)), '');

  console.log('\n  pressing one tunes it');
  await page.evaluate(() => document.querySelector('.sc-tune:not(:disabled)').click());
  await page.waitForTimeout(900);
  const tuned = await page.evaluate(() => ({
    open: !document.querySelector('#playerOverlay')?.hidden,
    name: document.querySelector('#playerTitle')?.textContent || '',
  }));
  console.log('   tuned:', JSON.stringify(tuned));
  check('the card opens the broadcast it named', tuned.open === true, JSON.stringify(tuned));
  await page.evaluate(() => closePlayer());
  await page.waitForTimeout(600);

  /* ---- the controls ---------------------------------------------------- */
  console.log('\n  the bar carries Live TV\'s own two controls');
  const bar = await page.evaluate(() => {
    /* Occupying space on the page, which is the question — a control inside
       a hidden bar still computes its own display. */
    const seen = (sel) => {
      const n = document.querySelector(sel);
      return Boolean(n) && n.getClientRects().length > 0;
    };
    return {
      all: seen('#dkAllBtn'),
      sort: seen('#dkCatbar .dk-sel'),
      view: seen('#dkViewSeg'),
      mv: seen('#dkMvBtn'),
      listings: seen('#dkListingsBtn'),
      listingsText: document.querySelector('#dkListingsBtn span')?.textContent,
      oldMv: seen('#multiviewBtn'),
      oldListings: seen('#listingsBtn'),
    };
  });
  console.log('   bar:', JSON.stringify(bar));
  check('the sort is gone, because a channel has nothing to sort by',
    bar.sort === false, String(bar.sort));
  check('and so is the rows/grid toggle', bar.view === false, String(bar.view));
  check('multi-view stands where the sort stood', bar.mv === true, String(bar.mv));
  check('the listings stand where the toggle stood',
    bar.listings === true && bar.listingsText === 'Listings',
    JSON.stringify([bar.listings, bar.listingsText]));
  check('and neither is shown twice on the page',
    bar.oldMv === false && bar.oldListings === false, JSON.stringify([bar.oldMv, bar.oldListings]));

  console.log('\n  and they press the real thing');
  await page.evaluate(() => document.querySelector('#dkListingsBtn').click());
  await page.waitForTimeout(1000);
  const listed = await page.evaluate(() => ({
    on: state.listings,
    label: document.querySelector('#dkListingsBtn span')?.textContent,
  }));
  console.log('   listings:', JSON.stringify(listed));
  check('the borrowed button turns the listings on', listed.on === true, String(listed.on));
  check('and says how to turn them off again', listed.label === 'Channels', listed.label);
  await page.evaluate(() => document.querySelector('#dkListingsBtn').click());
  await page.waitForTimeout(1000);

  await page.evaluate(() => document.querySelector('#dkMvBtn').click());
  await page.waitForTimeout(900);
  const mv = await page.evaluate(() => !document.querySelector('#multiview')?.hidden);
  check('and the other one opens multi-view', mv === true, String(mv));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  /* ---- the sheet ------------------------------------------------------- */
  console.log('\n  every category, with a pin on it');
  await page.evaluate(() => document.querySelector('#dkAllBtn').click());
  await page.waitForTimeout(700);
  const sheet = await page.evaluate(() => ({
    open: document.querySelector('#dkSheet')?.classList.contains('open'),
    rows: [...document.querySelectorAll('#dkCatList .cat-row')].map((r) => ({
      name: r.querySelector('.cat-row-name')?.textContent,
      pin: Boolean(r.querySelector('.row-pin')),
      pinned: r.classList.contains('pinned'),
    })),
    lead: document.querySelector('#dkSheetLead')?.textContent,
  }));
  console.log('   sheet:', JSON.stringify(sheet));
  check('the sheet opens', sheet.open === true, String(sheet.open));
  check('every row carries a pin, not only the pinned ones',
    sheet.rows.length === 4 && sheet.rows.every((r) => r.pin), JSON.stringify(sheet.rows));
  check('the one already pinned leads and is marked',
    sheet.rows[0].name === 'USA SPORTS' && sheet.rows[0].pinned === true,
    JSON.stringify(sheet.rows[0]));
  check('and the lead says they can be arranged', /drag/i.test(sheet.lead || ''), sheet.lead);

  console.log('\n  pinning one from the sheet');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#dkCatList .cat-row')]
      .find((r) => r.dataset.catId === 'c3');
    row.querySelector('.row-pin').click();
  });
  await page.waitForTimeout(900);
  const pinnedNow = await page.evaluate(() => ({
    stored: profiles.data.pinnedCategories,
    chips: [...document.querySelectorAll('#dkChips .catchip.pinned')].map((c) => c.dataset.catId),
  }));
  console.log('   pinned:', JSON.stringify(pinnedNow));
  check('the pin sticks on the box, not just on the row',
    pinnedNow.stored.includes('live:c3'), JSON.stringify(pinnedNow.stored));
  check('and the bar above picks it up', pinnedNow.chips.includes('c3'),
    JSON.stringify(pinnedNow.chips));
  /* The pin has to claim its own click: a pin that also opened the category
     would close the sheet under the hand that was arranging it. */
  check('and pinning did not open the category underneath it',
    await page.evaluate(() => document.querySelector('#dkSheet').classList.contains('open')), '');

  console.log('\n  dragging one into place');
  const grip = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#dkCatList .cat-row')];
    const from = rows.find((r) => r.dataset.catId === 'c3').getBoundingClientRect();
    const to = rows.find((r) => r.dataset.catId === 'c1').getBoundingClientRect();
    return {
      from: { x: from.left + from.width / 2, y: from.top + from.height / 2 },
      to: { x: to.left + 8, y: to.top + to.height / 2 },
    };
  });
  await page.mouse.move(grip.from.x, grip.from.y);
  await page.mouse.down();
  await page.mouse.move(grip.from.x - 30, grip.from.y, { steps: 5 });
  await page.mouse.move(grip.to.x, grip.to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);

  const dragged = await page.evaluate(() => ({
    order: profiles.pinOrder('live'),
    chips: [...document.querySelectorAll('#dkChips .catchip.pinned')].map((c) => c.dataset.catId),
  }));
  console.log('   dragged:', JSON.stringify(dragged));
  check('the row lands where it was dropped, and the order is stored',
    dragged.order.join(',') === 'c3,c1', JSON.stringify(dragged.order));
  check('which is the order the bar draws them in',
    dragged.chips.join(',') === 'c3,c1', JSON.stringify(dragged.chips));

  await page.evaluate(() => window.__ttDesktop.closeSheet());
  await page.waitForTimeout(500);

  /* ---- the catalogue pages keep theirs --------------------------------- */
  console.log('\n  and Movies still sorts and still switches view');
  await page.evaluate(() => { location.hash = '#/movies'; });
  await page.waitForTimeout(2000);
  const movies = await page.evaluate(() => {
    /* Occupying space on the page, which is the question — a control inside
       a hidden bar still computes its own display. */
    const seen = (sel) => {
      const n = document.querySelector(sel);
      return Boolean(n) && n.getClientRects().length > 0;
    };
    return {
      sort: seen('#dkCatbar .dk-sel'),
      view: seen('#dkViewSeg'),
      mv: seen('#dkMvBtn'),
      listings: seen('#dkListingsBtn'),
      title: document.querySelector('#contentTitle')?.textContent,
      titleShown: !document.querySelector('#contentTitle')?.parentElement?.hidden,
      band: Boolean(document.querySelector('#dkScores')),
    };
  });
  console.log('   movies:', JSON.stringify(movies));
  check('the sort is back where it belongs', movies.sort === true, String(movies.sort));
  check('and so is the view toggle', movies.view === true, String(movies.view));
  check('Live TV\'s two are not on a page that has no channels',
    movies.mv === false && movies.listings === false, JSON.stringify([movies.mv, movies.listings]));
  check('the page title comes back, rather than the last page\'s head sticking',
    movies.titleShown === true && /movies/i.test(movies.title || ''),
    JSON.stringify([movies.titleShown, movies.title]));
  check('and the scores go with the page they belong to', movies.band === false, String(movies.band));
  await page.close();

  /* ---- an empty slate says which kind of empty it is ------------------- */
  console.log('\n  a slate with nothing on it');
  const quiet = await open(browser, { scores: { games: [] } });
  const quietRow = await quiet.evaluate(() => document.querySelector('.sc-empty')?.textContent || '');
  console.log('   quiet:', quietRow);
  check('says the feed answered, rather than leaving a blank band',
    /feed answered/.test(quietRow), quietRow);
  await quiet.close();

  console.log('\n  a slate nobody could be asked for');
  const broken = await open(browser, { scores: { error: 'HTTP 403 · HTTP 403' }, status: 200 });
  const brokenRow = await broken.evaluate(() => document.querySelector('.sc-empty')?.textContent || '');
  console.log('   broken:', brokenRow);
  check('says what went wrong', /403/.test(brokenRow), brokenRow);
  /* The whole address, not the path: a line telling somebody to open
     '/api/scores' asks them to work out what to put in front of it. */
  check('and names the door to knock on, in full',
    /http:\/\/127\.0\.0\.1:8481\/api\/scores/.test(brokenRow), brokenRow);
  await broken.close();

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
