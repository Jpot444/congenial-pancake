/**
 * The television is not held up by the scoreboard.
 *
 * "the sheild tv takes too long to load because it trys to load in sports
 *  scores so much. It also refreshes a lot and the screen changes"
 *
 * Two complaints, one mechanism seen twice.
 *
 * THE WAIT. The Live screen is the first thing this app opens, and it used to
 * await the slate before painting anything at all — the shell clears the
 * screen before calling into a screen's render, so the television sat on a
 * blank page for as long as the whole call took. Behind that one address the
 * box asks ESPN, the MLB stats API and the NCAA scoreboard: three services on
 * the far side of the internet, in front of a channel list that was already in
 * hand. And every caller meant a fresh fetch — the Live screen on each render,
 * multi-view when it opens, the player on each tune, and the Live screen again
 * on every refresh.
 *
 * THE REFRESHING. A poll every ten seconds compared the profile's write
 * counter and redrew the whole screen when it had moved. That counter moves on
 * every write to the profile, and by a distance the commonest write is a
 * position report — every player in the house says where it has got to twice a
 * minute. So the counter is almost never still, and the screen was being
 * rebuilt all evening for news that was somebody else's playhead.
 *
 * What is measured here is the behaviour, not the plumbing: when the first
 * cards appear against a deliberately slow feed, how many times that feed is
 * asked, and whether a poll that brings back nothing a screen draws from
 * leaves the screen alone.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* How long the box takes to answer for scores. Not invented for the test: the
   report that prompted this had the feed taking seconds, and three upstream
   services is what it costs. */
const SLATE_MS = 2500;

const LIVE = {
  categories: [{ id: 'c1', name: 'US| SPORTS' }, { id: 'c2', name: 'US| NEWS' }],
  items: [
    { kind: 'live', id: 101, num: 101, name: 'US| MLB NETWORK', logo: '', categoryId: 'c1' },
    { kind: 'live', id: 102, num: 102, name: 'US| ESPN', logo: '', categoryId: 'c1' },
    { kind: 'live', id: 103, num: 103, name: 'MLB 01 | Giants x Pirates', logo: '', categoryId: 'c1' },
    { kind: 'live', id: 201, num: 201, name: 'US| NEWS ONE', logo: '', categoryId: 'c2' },
  ],
  totals: { items: 4 },
};

const side = (abbr, score) => ({ abbr, score, logo: '', record: '' });
const SCORES = {
  at: Date.now(),
  games: [
    { id: 'g1', sport: 'mlb', status: 'live', clock: 'Top 7',
      teamMatch: ['Giants', 'Pirates'], away: side('SF', 4), home: side('PIT', 2) },
  ],
  feeds: [{ sport: 'mlb', games: 1 }],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  let slateAsks = 0;
  await page.route('**/api/scores**', async (r) => {
    slateAsks += 1;
    await new Promise((done) => setTimeout(done, SLATE_MS));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(SCORES) });
  });
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"continueWatching":[],"categoryAffinity":[],"ratings":{}}' }));

  /* The profile record, with a write counter this suite can move. That counter
     is what the ten-second poll used to act on. */
  let rev = 5;
  await page.route('**/api/profiles', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '' }],
        current: 'own1', rev }) }));
  let favorites = [];
  await page.route('**/api/profiles/own1/prefs*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ tourDone: true, liveTourDone: true, scoreSport: 'mlb',
        favorites, pinnedCategories: [], deletedItems: [], deletedCategories: [] }) }));

  /* ---- 1. the screen goes up before the slate does ---------------------- */
  console.log('\n  opening the app against a slow feed');
  const opened = Date.now();
  await page.goto(`${BASE}/tv/`);
  /* The first thing a person is waiting for: something to press. The channel
     row needs nothing but the library, and the library was in hand. */
  await page.waitForSelector('[data-kind="chan"]', { timeout: 15000 });
  const painted = Date.now() - opened;
  console.log(`   channels on screen after ${painted}ms (the feed takes ${SLATE_MS}ms)`);
  check('the channels are up before the scoreboard has answered',
    painted < SLATE_MS, `${painted}ms`);

  /* And the games row says which of the three empties it is, rather than
     claiming there are no games while it is still asking. */
  const waiting = await page.evaluate(() =>
    (document.querySelector('[data-row="games"]')?.textContent || '').replace(/\s+/g, ' ').trim());
  console.log('   games row says:', JSON.stringify(waiting.slice(0, 80)));
  check('and the games row says it is still asking',
    /Looking for what is on/i.test(waiting), waiting.slice(0, 120));

  /* ---- 2. and fills itself in without moving anything else -------------- */
  console.log('\n  when the slate arrives');
  /* Where the cursor is, as the engine records it rather than as a class on a
     node — at this moment it may be resting on the nav, which carries no kind
     of its own, and a check that compared two empty strings would pass without
     measuring anything. */
  const cursor = () => page.evaluate(async () => {
    const { focus } = await import('/tv/js/focus.js');
    return `${focus.pos.r}:${focus.pos.c}`;
  });
  const before = await page.evaluate(() => ({
    chans: [...document.querySelectorAll('[data-kind="chan"]')].map((n) => n.dataset.c).join(','),
  }));
  before.focus = await cursor();
  await page.waitForSelector('[data-kind="game"]', { timeout: 15000 });
  await wait(400);
  const after = await page.evaluate(() => ({
    chans: [...document.querySelectorAll('[data-kind="chan"]')].map((n) => n.dataset.c).join(','),
    games: document.querySelectorAll('[data-kind="game"]').length,
  }));
  after.focus = await cursor();
  console.log('   ', JSON.stringify({ before, after }));
  check('the games appear', after.games > 0, String(after.games));
  /* The other rows are not rebuilt around them. A screen that rearranges
     itself is the second half of what was reported. */
  check('and the channel row is not disturbed', after.chans === before.chans,
    `${before.chans} → ${after.chans}`);
  check('nor is the cursor moved out from under anybody',
    Boolean(before.focus) && after.focus === before.focus,
    `${before.focus} → ${after.focus}`);

  /* ---- 3. asked once, not once per screen ------------------------------- */
  /*
   * Four callers wanted this slate and each one meant a fetch. Opening
   * multi-view, tuning a channel and coming back to Live are three ordinary
   * presses, and against a feed this slow they were three more waits.
   */
  console.log('\n  the other screens asking for the same slate');
  const asksAfterBoot = slateAsks;
  check('the boot asked for the slate once', asksAfterBoot === 1, String(asksAfterBoot));

  /* Asked the way the app asks: multi-view opening, the player tuning, and the
     Live screen painting again are three ordinary presses, and each one calls
     this. Two at once as well, because opening a screen while another is still
     waiting is the case that produced two identical requests. */
  await page.evaluate(async () => {
    const { getGames } = await import('/tv/js/scores.js');
    await Promise.all([getGames(), getGames()]);
    await getGames();
  });
  await wait(400);
  console.log(`   after three more callers the feed was asked ${slateAsks} time(s) in total`);
  check('and three more callers did not ask again', slateAsks === asksAfterBoot,
    `${asksAfterBoot} → ${slateAsks}`);

  /* ---- 4. the poll does not redraw for somebody else's playhead ---------- */
  /*
   * The counter moving is not news. It moves every time any player in the
   * house reports its position, which is twice a minute per device — and the
   * screen was rebuilt on it.
   */
  console.log('\n  when the write counter moves but nothing on screen changed');
  const mark = await page.evaluate(() => {
    const row = document.querySelector('[data-row="games"]');
    if (row) row.dataset.probe = 'original';
    return Boolean(row);
  });
  check('there is a games row to watch', mark);
  rev = 6;                                  // a position report from another room
  await page.evaluate(async () => {
    const { followBox } = await import('/tv/js/state.js');
    window.__news = await followBox({ playing: false });
  });
  const news = await page.evaluate(() => window.__news);
  console.log('   the poll reported:', JSON.stringify(news));
  check('the poll finds nothing worth redrawing for', news === null, JSON.stringify(news));

  /* And when something a screen really is drawn from changes, it does say so —
     a rule that never fired would be worse than the churn it replaced. */
  console.log('\n  and when a favourite is added elsewhere');
  rev = 7;
  favorites = [{ item: { kind: 'live', id: 101, name: 'US| MLB NETWORK' } }];
  await page.evaluate(async () => {
    const { followBox } = await import('/tv/js/state.js');
    window.__news2 = await followBox({ playing: false });
  });
  const news2 = await page.evaluate(() => window.__news2);
  console.log('   the poll reported:', JSON.stringify(news2));
  check('that is news, and the screen is told', news2 && news2.refreshed === true,
    JSON.stringify(news2));

  /* ---- 5. the scores still keep up ------------------------------------- */
  /*
   * Taking the ten-second whole-screen refresh away must not leave the games
   * row frozen at whatever it said when the screen opened — that is the same
   * row, complained about from the other direction. It refreshes itself on a
   * minute, and only itself.
   *
   * Read from the source rather than waited out: a minute of wall clock for
   * one assertion is a minute added to every run of this suite, and what is
   * being claimed here is a property of the module.
   */
  console.log('\n  the games row keeps itself up to date');
  const src = require('fs').readFileSync(
    require('path').join(require('./paths.js').PUBLIC, 'tv', 'js', 'screens', 'live.js'), 'utf8');
  check('the row asks again on its own clock',
    /SLATE_REFRESH_MS/.test(src) && /setInterval\(/.test(src), 'no periodic refresh');
  check('and it refreshes the row rather than the screen',
    /forgetGames\(\);\s*\n\s*fillGames\(/.test(src), 'the timer calls something else');
  check('and stops when the screen is left',
    /export function leave\(\)[\s\S]{0,120}clearInterval\(slateTimer\)/.test(src),
    'nothing clears the timer');

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
