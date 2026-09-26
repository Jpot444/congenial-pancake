/**
 * A game pressed inside the builder goes into the set.
 *
 * "inside of build a multiview the games are not clickable"
 *
 * They were clickable. What they did was invisible.
 *
 * There is ONE scoreboard band in the whole app — `#dkScores` — and whoever
 * wants it gets it moved to them. The multi-view builder borrows it so that
 * "what is on right now" is the first thing in the sheet, which is the right
 * place to start assembling a set of live channels from. But its cards were
 * wired once, when they were drawn, to `openPlayer(channel)`.
 *
 * So pressing a game inside the builder opened the full-screen player BEHIND
 * the still-open picker. Reproduced on the shipped build:
 *
 *   {"disabled":false,"basket":[],"playerOpen":true,"pickerOpen":true}
 *
 * Nothing went into the set, the sheet stayed exactly as it was, and a player
 * nobody could see started underneath it. From the sofa that is a card that
 * does nothing.
 *
 * The fix is one module-level handler, set by whoever asks for the band and
 * cleared by the next asker, READ AT CLICK TIME rather than captured when the
 * card is drawn — because the band outlives its cards and is moved between
 * hosts with them intact, so a handler baked in at draw time would be the one
 * belonging to wherever it was drawn.
 *
 * Which means three things have to hold together, and all three are here: a
 * game in the builder ADDS, the same card back on the page still WATCHES, and
 * a page redraw cannot yank the band out of an open sheet in between.
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

const LIVE = {
  categories: [{ id: 'c1', name: 'USA SPORTS' }],
  items: [
    { kind: 'live', id: 700, num: 700, name: 'US| ESPN HD', categoryId: 'c1' },
    { kind: 'live', id: 701, num: 701, name: 'US| FOX SPORTS 1 HD', categoryId: 'c1' },
    { kind: 'live', id: 702, num: 702, name: 'US| CBS EAST', categoryId: 'c1' },
  ],
  totals: { items: 3 },
};

const now = Math.floor(Date.now() / 1000);
/* One game this box can carry and one it cannot, because they are two
   different answers and only one of them is a bug. */
const CARRIED = {
  id: 'nfl-1', sport: 'nfl', status: 'live', clock: 'Q2 8:31',
  channelMatch: 'ESPN', channelName: 'ESPN',
  teamMatch: ['Chiefs', 'Bills'],
  home: { abbr: 'BUF', score: 10 }, away: { abbr: 'KC', score: 14 },
  kickoff: now - 1800,
};
const NOT_CARRIED = {
  id: 'nfl-2', sport: 'nfl', status: 'live', clock: 'Q1 2:04',
  /* A regional nobody in this library carries. */
  channelMatch: 'MASN2', channelName: 'MASN2',
  teamMatch: ['Ravens', 'Steelers'],
  home: { abbr: 'PIT', score: 3 }, away: { abbr: 'BAL', score: 7 },
  kickoff: now - 900,
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'live'
        ? LIVE : { categories: [], items: [], totals: { items: 0 } }) });
  });
  await page.route('**/api/scores**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ games: [CARRIED, NOT_CARRIED], at: Date.now(), feeds: [] }) }));
  /* The picker's listings. Not what this suite is about, and an unanswered
     one leaves rows saying "waiting" for ever. */
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"channels":[],"busy":false}' }));
  /* Nothing here should reach this, and that is the point of counting it. */
  let playCalls = 0;
  await page.route('**/api/play**', (r) => {
    playCalls += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/api/nothing","format":"m3u8"}' });
  });
  await page.route('**/progress**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
  }
  await wait(1800);

  /* Football, because the band only asks the guide for college — and a guide
     ask is a second moving part this suite has no business depending on. */
  await page.evaluate(() => {
    state.config.mode = 'xtream';
    profiles.data.scoreSport = 'nfl';
    location.hash = '#/live';
    state.category = null;
    render();
  });
  await page.waitForSelector('#dkScores', { state: 'attached', timeout: 10000 });
  await wait(1200);

  /** What a card offers and where the band currently lives. */
  const readCard = (gameId) => page.evaluate((id) => {
    const card = document.querySelector(`#dkScores .sc-card[data-game="${id}"]`);
    if (!card) return null;
    const tune = card.querySelector('.sc-tune');
    return {
      disabled: Boolean(tune && tune.disabled),
      title: (tune && tune.title) || '',
      inPicker: Boolean(document.querySelector('#dkScores')?.closest('#mvPicker')),
    };
  }, gameId);

  const shape = () => page.evaluate(() => ({
    basket: multiview.basket.map((row) => row.item.name),
    playerOpen: !document.querySelector('#playerOverlay').hidden,
    pickerOpen: !document.querySelector('#mvPicker').hidden,
    bandIn: document.querySelector('#dkScores')?.closest('#mvPicker') ? 'picker' : 'page',
  }));

  /* ---- on the Live TV page, where it has always been right -------------- */
  console.log('\n  a game on the Live TV page');
  const onPage = await readCard(CARRIED.id);
  console.log('   ', JSON.stringify(onPage));
  check('the matched game is offered at all', onPage && !onPage.disabled,
    JSON.stringify(onPage));
  /* The words, because they are what somebody reads before deciding to press
     — and the two things a press can do now must not both claim to be the
     other one. */
  check('and it says it will watch it', /^Watch on US\| ESPN HD/.test(onPage.title),
    onPage && onPage.title.split('\n')[0]);

  /* The other answer, and it is not the bug. A game no channel on this box
     carries has nothing to press, and saying so is better than a button that
     swallows the press. */
  const missing = await readCard(NOT_CARRIED.id);
  console.log('   ', JSON.stringify(missing));
  check('a game nothing here carries is plainly not offered',
    missing && missing.disabled, JSON.stringify(missing));
  check('and says why rather than going quiet',
    missing && /No channel on this box carries it/.test(missing.title),
    missing && missing.title);

  /* ---- and the same card inside the builder ---------------------------- */
  console.log('\n  the same game inside build a multiview');
  await openMultiview(page);
  await wait(500);
  await page.evaluate(() => multiview.buildSet());
  await wait(900);

  const moved = await shape();
  console.log('   ', JSON.stringify(moved));
  check('the builder has borrowed the band', moved.bandIn === 'picker',
    JSON.stringify(moved));

  const inBuilder = await readCard(CARRIED.id);
  console.log('   ', JSON.stringify(inBuilder));
  /* Redrawn under the new owner, so the promise changes with what a press
     will do. */
  check('and the card now offers to ADD it',
    inBuilder && /^Add on US\| ESPN HD/.test(inBuilder.title),
    inBuilder && inBuilder.title.split('\n')[0]);
  /* The routing reason survives the change of owner — it is a fact about the
     channel, not about the sheet. */
  check('while still saying how the channel was arrived at',
    inBuilder && /Matched because the network the feed named/.test(inBuilder.title),
    inBuilder && inBuilder.title.replace(/\n/g, ' | '));

  /* ---- a page redraw must not take the sheet apart --------------------- */
  /*
   * `decorate()` calls scoreboard() bare on every render, and a render can be
   * triggered from anywhere — a library refresh, a hash change. Before the
   * guard, one of those would move the band back to the page head out from
   * under somebody mid-choice, taking the games with it AND clearing the
   * handler that made them do the right thing.
   *
   * The press below comes AFTER this on purpose. The first cut of the guard
   * cleared the handler before deciding to return, so the band stayed put and
   * the cards still read "Add on ESPN" while the thing that made them add was
   * gone — the original fault, wearing the fix's clothes. Checking only that
   * the band did not move would have passed.
   */
  console.log('\n  and a page redraw underneath it');
  await page.evaluate(() => window.__ttDesktop.scoreboard());
  await wait(300);
  const afterRedraw = await shape();
  console.log('   ', JSON.stringify(afterRedraw));
  check('the band stays in the sheet', afterRedraw.bandIn === 'picker',
    JSON.stringify(afterRedraw));

  /* ---- the press ------------------------------------------------------- */
  console.log('\n  pressing it');
  const before = await shape();
  await page.evaluate((id) => {
    document.querySelector(`#dkScores .sc-card[data-game="${id}"] .sc-tune`).click();
  }, CARRIED.id);
  await wait(700);
  const after = await shape();
  console.log('    before', JSON.stringify(before));
  console.log('    after ', JSON.stringify(after));

  check('the channel went into the set',
    after.basket.length === 1 && after.basket[0] === 'US| ESPN HD',
    JSON.stringify(after.basket));
  /* The fault itself, stated as what the viewer saw: a player opening behind
     a sheet nobody had closed. */
  check('and no player opened behind the sheet', after.playerOpen === false,
    JSON.stringify(after));
  check('the sheet is still open, ready for the next one', after.pickerOpen === true,
    JSON.stringify(after));
  check('and nothing was asked to stream', playCalls === 0, String(playCalls));

  /* ---- handed back ----------------------------------------------------- */
  /*
   * The half that makes the handler safe. One band, one owner at a time — a
   * handler left behind would have the Live TV page quietly adding to a
   * multi-view set that is no longer being built.
   */
  console.log('\n  and once the sheet is closed again');
  await page.evaluate(() => multiview.closePicker());
  await wait(600);
  const handedBack = await shape();
  console.log('   ', JSON.stringify(handedBack));
  check('the page has its band back', handedBack.bandIn === 'page',
    JSON.stringify(handedBack));

  const backOnPage = await readCard(CARRIED.id);
  console.log('   ', JSON.stringify(backOnPage));
  check('and a game says it will watch it again',
    backOnPage && /^Watch on US\| ESPN HD/.test(backOnPage.title),
    backOnPage && backOnPage.title.split('\n')[0]);

  await page.evaluate((id) => {
    document.querySelector(`#dkScores .sc-card[data-game="${id}"] .sc-tune`).click();
  }, CARRIED.id);
  await wait(800);
  const watched = await shape();
  console.log('   ', JSON.stringify(watched), 'play calls:', playCalls);
  check('and it does — the player opens', watched.playerOpen === true,
    JSON.stringify(watched));
  check('rather than adding to a set nobody is building',
    watched.basket.length === 0, JSON.stringify(watched.basket));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
