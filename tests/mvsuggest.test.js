/**
 * What else is on.
 *
 * "I want to change multiview to have some reccomended views, when I am
 *  watching a sports game and click multiview it is usually because I want to
 *  watch the other games that are on at that time. When I click that multiview
 *  a panal should come out from the right of the screen with a list of
 *  suggested games happening now or soon I may want to watch."
 *
 * Multi-view could already hold four games. Getting the second one into it
 * meant leaving the game, opening the picker, choosing Live TV, walking to the
 * right shelf and reading provider rows — five presses and a category tree, to
 * answer a question the box can already answer: the slate says which games are
 * on, and matchChannel already ties each one to the channel carrying it.
 *
 * So the answer arrives with the grid. What is checked here is the four things
 * that decide whether it is worth having:
 *
 *   IT COMES OUT WITH THE GRID, from the right, when multi-view is entered off
 *   a live game. Not behind another press — that press is the one being saved.
 *
 *   IT LISTS THE OTHER GAMES AND NOT THIS ONE. The game being watched is the
 *   reason the panel was asked for; offering it back is the one row guaranteed
 *   to be useless.
 *
 *   EVERY ROW OPENS SOMETHING. A game with no channel behind it is left out
 *   entirely, because a suggestion that opens nothing is the black screen this
 *   portal has spent a fortnight removing, dressed up as a recommendation.
 *
 *   TAPPING ONE FILLS A CELL, with the channel the slate says the game is on
 *   — and then the panel stops offering that one.
 *
 * Finals are excluded and games far off are excluded, so "now or soon" means
 * something. The fixtures below include one of each to prove it.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* The provider's shelves, named the way this one names them: a row per fixture
   on a PPV shelf, plus the networks. `US|` because that is the prefix the live
   filter keeps. */
const LIB = {
  movies: { categories: [], items: [] },
  series: { categories: [], items: [] },
  live: {
    categories: [
      { id: 'ppv', name: 'US| MLB PPV EVENTS' },
      { id: 'net', name: 'US| SPORTS NETWORKS' },
    ],
    items: [
      { kind: 'live', id: 701, name: 'MLB 01 | Giants x Pirates', categoryId: 'ppv', logo: '' },
      { kind: 'live', id: 702, name: 'MLB 02 | Blue Jays x Guardians', categoryId: 'ppv', logo: '' },
      { kind: 'live', id: 703, name: 'MLB 03 | Cubs x Cardinals', categoryId: 'ppv', logo: '' },
      { kind: 'live', id: 704, name: 'MLB 04 | Dodgers x Padres', categoryId: 'ppv', logo: '' },
      { kind: 'live', id: 900, name: 'US| MLB NETWORK ᴴᴰ', categoryId: 'net', logo: '' },
    ],
  },
};

const team = (abbr, score) => ({ abbr, score, logo: '', record: '' });
const soon = (mins) => Date.now() + mins * 60000;

/* One being watched, one live elsewhere, one starting soon, one over, one
   tomorrow, and one live game this provider does not carry at all. */
const SCORES = {
  at: Date.now(),
  games: [
    { id: 'g-watching', sport: 'mlb', status: 'live', clock: 'Top 7',
      teamMatch: ['Giants', 'Pirates'], away: team('SF', 4), home: team('PIT', 2) },
    { id: 'g-live', sport: 'mlb', status: 'live', clock: 'Bot 3',
      teamMatch: ['Blue Jays', 'Guardians'], away: team('TOR', 1), home: team('CLE', 0) },
    { id: 'g-soon', sport: 'mlb', status: 'upcoming', kickoff: soon(40),
      teamMatch: ['Cubs', 'Cardinals'], away: team('CHC', null), home: team('STL', null) },
    { id: 'g-final', sport: 'mlb', status: 'final', clock: 'Final',
      teamMatch: ['Dodgers', 'Padres'], away: team('LAD', 6), home: team('SD', 3) },
    { id: 'g-tomorrow', sport: 'mlb', status: 'upcoming', kickoff: soon(60 * 20),
      teamMatch: ['Dodgers', 'Padres'], away: team('LAD', null), home: team('SD', null) },
    /* Nothing on this provider names these two. It must not appear. */
    { id: 'g-uncarried', sport: 'mlb', status: 'live', clock: 'Top 1',
      teamMatch: ['Rockies', 'Nationals'], away: team('COL', 0), home: team('WSH', 0) },
  ],
  feeds: [{ sport: 'mlb', games: 6 }],
};

const rows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#mvSuggestBody .mv-sg')].map((n) => ({
    title: n.querySelector('.mv-sg-title')?.textContent || '',
    when: n.querySelector('.mv-sg-when')?.textContent || '',
    score: n.querySelector('.mv-sg-score')?.textContent || '',
    chan: n.querySelector('.mv-sg-chan')?.textContent || '',
    live: n.classList.contains('is-live'),
  })));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/library*', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(LIB[tab] || { categories: [], items: [] }) });
  });
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SCORES) }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"continueWatching":[],"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  /* Nothing is going to be decoded here — what matters is which channel the
     cell ASKED for, which the request log below answers. */
  const asked = [];
  await page.route('**/api/play*', (r) => {
    const q = new URL(r.request().url()).searchParams;
    asked.push({ kind: q.get('kind'), id: q.get('id') });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/stream?u=x', format: 'ts' }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await page.evaluate((lib) => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    Object.assign(state.library, lib);
  }, LIB);

  /* ---- 1. it comes out with the grid ------------------------------------ */
  /*
   * Entered the way the ask describes it: watching a game, pressing
   * Multi-view. The player's own button, not the module poked directly — the
   * button is the feature.
   */
  console.log('\n  pressing Multi-view while a game is on');
  await page.evaluate(() => {
    currentLiveItem = { kind: 'live', id: 701, name: 'MLB 01 | Giants x Pirates', categoryId: 'ppv' };
    document.querySelector('#playerOverlay').hidden = false;
    document.querySelector('#cinemaMultiview').click();
  });
  await wait(1200);

  const open = await page.evaluate(() => {
    const panel = document.querySelector('#mvSuggest');
    const r = panel.getBoundingClientRect();
    return {
      hidden: panel.hidden,
      openClass: panel.classList.contains('is-open'),
      /* From the RIGHT: its right edge is the window's right edge, and it is
         not the full width of it. */
      right: Math.round(window.innerWidth - r.right),
      width: Math.round(r.width),
      viewport: window.innerWidth,
      mv: !document.querySelector('#multiview').hidden,
    };
  });
  console.log('   ', JSON.stringify(open));
  check('multi-view opened', open.mv === true, JSON.stringify(open));
  check('and the panel came with it', open.hidden === false && open.openClass === true,
    JSON.stringify(open));
  check('out of the right-hand edge', open.right === 0 && open.width > 0
    && open.width < open.viewport / 2, JSON.stringify(open));

  /* ---- 2. what it offers ------------------------------------------------ */
  console.log('\n  what it offers');
  const list = await rows(page);
  for (const row of list) console.log(`    ${JSON.stringify(row)}`);

  check('the game being watched is not offered back',
    !list.some((r) => /SF|PIT/.test(r.title)), JSON.stringify(list.map((r) => r.title)));
  check('the other live game is', list.some((r) => r.title === 'TOR at CLE'),
    JSON.stringify(list.map((r) => r.title)));
  check('and so is the one starting soon', list.some((r) => r.title === 'CHC at STL'),
    JSON.stringify(list.map((r) => r.title)));
  /* Now OR SOON. A game that finished and a game tomorrow are both answers to
     a different question. */
  check('a game that is over is not', !list.some((r) => r.when === 'Final'),
    JSON.stringify(list));
  check('nor is one tomorrow', list.length === 2, JSON.stringify(list.map((r) => r.title)));
  /* The one the provider does not carry. A row pointing at nothing is the
     failure this feature could most easily introduce. */
  check('nor a game this provider does not carry',
    !list.some((r) => /COL|WSH/.test(r.title)), JSON.stringify(list.map((r) => r.title)));

  check('the live one is marked as live', list.find((r) => r.title === 'TOR at CLE')?.live === true,
    JSON.stringify(list[0]));
  check('with its score on it', list.find((r) => r.title === 'TOR at CLE')?.score === '1–0',
    JSON.stringify(list[0]));
  check('and the one to come says how long', /^In \d+ min$/.test(
    list.find((r) => r.title === 'CHC at STL')?.when || ''),
  JSON.stringify(list.find((r) => r.title === 'CHC at STL')));
  /* Live first: it is the one worth taking, and nobody should have to read
     every clock to find it. */
  check('the live game is at the top', list[0]?.title === 'TOR at CLE',
    JSON.stringify(list.map((r) => r.title)));

  /* Each row names the channel it will open, because being moved onto a
     channel you did not choose is the complaint this whole area came from. */
  check('each row names the channel it opens',
    list.every((r) => /MLB 0\d/.test(r.chan)), JSON.stringify(list.map((r) => r.chan)));

  /* ---- 3. tapping one --------------------------------------------------- */
  console.log('\n  tapping one');
  asked.length = 0;
  await page.evaluate(() => {
    document.querySelectorAll('#mvSuggestBody .mv-sg')[0].click();
  });
  await wait(1400);

  const after = await page.evaluate(() => ({
    cells: multiview.cells.slice(0, multiview.count).map((c) => (c.item ? String(c.item.id) : '')),
    still: !document.querySelector('#mvSuggest').hidden,
  }));
  console.log('   asked for:', JSON.stringify(asked));
  console.log('   cells:', JSON.stringify(after.cells));
  check('the box asked for the channel that game is on',
    asked.some((a) => a.kind === 'live' && a.id === '702'), JSON.stringify(asked));
  check('and it went into the next free cell', after.cells[1] === '702',
    JSON.stringify(after.cells));
  check('the game already playing was not disturbed', after.cells[0] === '701',
    JSON.stringify(after.cells));
  check('the panel stays up for the next one', after.still === true);

  const left = await rows(page);
  console.log('   left:', JSON.stringify(left.map((r) => r.title)));
  check('and stops offering the one just taken',
    !left.some((r) => r.title === 'TOR at CLE'), JSON.stringify(left.map((r) => r.title)));

  /* ---- 4. it can be put away and asked for again ------------------------ */
  console.log('\n  the button on the bar');
  await page.evaluate(() => { document.querySelector('#mvSuggestClose').click(); });
  await wait(300);
  check('closing it hides it',
    await page.evaluate(() => document.querySelector('#mvSuggest').hidden) === true);
  await page.evaluate(() => { document.querySelector('#mvSuggestBtn').click(); });
  await wait(1000);
  check('and the bar button brings it back',
    await page.evaluate(() => document.querySelector('#mvSuggest').hidden) === false);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
