/**
 * Treasure Theater on a dashboard.
 *
 * "I want to have a new 'this device' for my tesla screen for when I am at
 *  charging stops or parked. The desktop screen is close to what I want, but
 *  I want this new mode built especially for the full screen UI of a tesla
 *  screen. The play, pause, captions buttons should be easily built for that
 *  kind of screen. I dont need to see delay amount, picture in picture
 *  buttons. I still want sports scores and the ticker, they can be combined
 *  into a better homescreen"
 *
 * A third shape, not a third breakpoint. A Tesla's centre screen is as wide as
 * a laptop's, so it reads as a desktop and gets a desktop's hit targets —
 * sized for a mouse, at a desk, with the screen a foot from your face. In a car
 * the screen is an arm's length away, the person is holding a coffee, and half
 * the buttons are ones nobody in a car has a use for. That is a different
 * design, and it is CHOSEN: nothing in a browser announces that it is bolted to
 * a dashboard, so this is never inferred.
 *
 * What is checked here is the three things that make it that design rather
 * than a zoomed one:
 *
 *   THE CONTROLS ARE BIG ENOUGH. Measured, in pixels, on the rendered bar.
 *   The failure in a car is never "I could not read that", it is "I pressed
 *   the wrong thing".
 *
 *   THE RIGHT BUTTONS ARE GONE, and gone in a way app.js cannot undo — it
 *   un-hides both of them for its own reasons, so a layout that only set
 *   `hidden` would lose the argument the moment a channel started.
 *
 *   IT FITS ON ONE SCREEN. Two columns, nothing below the fold, nothing pushed
 *   off the right-hand edge. A car is not a place to go looking for the thing
 *   you were about to press.
 *
 * There was a scrolling ticker along the foot for a while, and it is gone: a
 * line of scores sliding across a dashboard is movement in the corner of
 * somebody's eye that they cannot help reading, and the board beside it was
 * already answering the question. Removed rather than replaced, so the check
 * below is that nothing took its place.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

/* Model 3/Y centre screen: 1920×1200 native, and the browser gets about this
   much of it once Tesla's own chrome is off the top. */
const TESLA = { width: 1152, height: 742 };

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const named = ['Redwood Gulch', 'The Long Winter', 'Custard Pie', 'Nightfall County',
  'Copper Line', 'Dry Season', 'The Hollow', 'Sundown Road'];
const LIB = {
  movies: {
    categories: [{ id: 'c1', name: 'EN - WESTERNS' }],
    items: named.map((name, i) => ({ kind: 'movie', id: 60 + i, name,
      categoryId: 'c1', ext: 'mp4', logo: '' })),
  },
  series: {
    categories: [{ id: 's1', name: 'EN - DRAMA' }],
    items: [{ kind: 'series', id: 88, name: 'The Long Winter', categoryId: 's1', logo: '' }],
  },
  live: {
    categories: [{ id: 'sport', name: 'US - SPORTS' }],
    items: [{ kind: 'live', id: 900, name: 'MLB NETWORK', categoryId: 'sport', logo: '' }],
  },
};

const team = (abbr, score) => ({ abbr, score, logo: '' });
const SCORES = {
  games: [
    { id: 'g1', sport: 'mlb', status: 'live', clock: 'Top 7', away: team('SEA', 4), home: team('HOU', 2) },
    { id: 'g2', sport: 'mlb', status: 'live', clock: 'Bot 3', away: team('NYY', 1), home: team('BOS', 0) },
    { id: 'g3', sport: 'mlb', status: 'final', away: team('LAD', 6), home: team('SFG', 3) },
    { id: 'g4', sport: 'mlb', status: 'scheduled', detailedState: '7:10 PM', away: team('CHC', null), home: team('STL', null) },
    { id: 'g5', sport: 'mlb', status: 'live', clock: 'Bot 9', away: team('ATL', 2), home: team('NYM', 2) },
  ],
  feeds: [{ sport: 'mlb', ok: true }],
};

const HISTORY = [
  { key: 'movie:60', kind: 'movie', id: 60, name: 'Redwood Gulch', position: 2400, duration: 6000, at: Date.now(), poster: '' },
  { key: 'series:88:1:2', kind: 'series', id: 88, seriesId: 88, seriesName: 'The Long Winter', name: 'The Long Winter', season: 1, episode: 2, position: 600, duration: 2400, at: Date.now() - 1e3, poster: '' },
  { key: 'movie:62', kind: 'movie', id: 62, name: 'Custard Pie', position: 300, duration: 5400, at: Date.now() - 2e3, poster: '' },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: TESLA, hasTouch: true });
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

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }

  /* ---- 1. it is a choice, and it sticks ---------------------------------- */
  /*
   * Chosen from the settings segment the way a person does it, not set by
   * poking the module — the control is the feature.
   */
  console.log('\n  choosing it');
  const before = await page.evaluate(() => document.documentElement.className);
  await page.evaluate(() => { document.querySelector('#touchToggle').click(); });
  await wait(400);
  const offered = await page.evaluate(() =>
    [...document.querySelectorAll('#layoutSeg button')].map((b) => b.textContent.trim()));
  console.log('   offered:', JSON.stringify(offered));
  check('the layout control offers a third shape',
    offered.length === 3 && offered.includes('Tesla'), JSON.stringify(offered));

  await page.evaluate(() => {
    [...document.querySelectorAll('#layoutSeg button')]
      .find((b) => b.dataset.layout === 'car').click();
  });
  await wait(700);
  await page.evaluate(() => { document.querySelector('#deviceClose')?.click(); });
  const shell = await page.evaluate(() => document.documentElement.className);
  console.log(`   shell: ${JSON.stringify(before)} → ${JSON.stringify(shell)}`);
  check('the car layer goes on', /\bcar\b/.test(shell), shell);
  /* On TOP of the desktop one, not instead of it. The desktop screen was
     already most of the way to what the car wants, and the whole design
     depends on `.desk` still drawing the shell underneath. */
  check('and the desktop layer stays underneath it', /\bdesk\b/.test(shell), shell);
  check('and it is remembered for next time',
    await page.evaluate(() => localStorage.getItem('portal.layout')) === 'car');

  /* ---- 2. the home screen ------------------------------------------------ */
  console.log('\n  the home screen');
  await page.evaluate((lib) => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    Object.assign(state.library, lib);
    location.hash = '#/home';
  }, LIB);
  await wait(1600);
  await page.evaluate((rows) => { state.recentlyWatched = rows; renderHome(); }, HISTORY);
  await wait(2500);

  const home = await page.evaluate((vp) => {
    const px = (n) => Math.round(n);
    const box = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height), bottom: px(r.bottom) };
    };
    return {
      arranged: !!document.querySelector('#homeView.car-home'),
      watch: box('.car-watch'),
      scores: box('.car-scores'),
      ticker: document.querySelectorAll('.car-ticker, .tick-track, .tick-game').length,
      areas: getComputedStyle(document.querySelector('#homeView.car-home')
        || document.body).gridTemplateAreas,
      cards: document.querySelectorAll('.car-watch .card, .car-watch .rail-card').length,
      scoreCards: document.querySelectorAll('.car-scores .sc-card').length,
      heroGone: !document.querySelector('#dkHero')
        || getComputedStyle(document.querySelector('#dkHero')).display === 'none',
      wide: document.documentElement.scrollWidth,
      tall: document.documentElement.scrollHeight,
      vp,
    };
  }, TESLA);
  console.log('   ', JSON.stringify({ watch: home.watch, scores: home.scores }));
  console.log('    cards', home.cards, '· score cards', home.scoreCards,
    '· ticker bits', home.ticker);

  check('home is rearranged for the car', home.arranged === true);
  /* Two columns, side by side — the whole reason this shape exists. */
  check('what you were watching is one column',
    home.watch && home.watch.w > 400, JSON.stringify(home.watch));
  check('the scores are the other, beside it not above it',
    home.scores && home.scores.x > home.watch.x + home.watch.w - 1
      && Math.abs(home.scores.y - home.watch.y) < 4,
    JSON.stringify([home.watch, home.scores]));
  /* And nothing along the foot. The ticker that used to live there was taken
     out rather than replaced, so the two columns have the whole screen. */
  check('there is no ticker', home.ticker === 0, String(home.ticker));
  check('and nothing stands where it did', !/ticker/.test(home.areas), home.areas);

  check('the cards are the ones the rest of the portal draws', home.cards > 0,
    String(home.cards));
  check('the scoreboard is really the scoreboard', home.scoreCards >= 3,
    String(home.scoreCards));
  /*
   * The cinematic hero the desktop leads with is six hundred pixels of a
   * seven-hundred-pixel screen. Right for a page somebody browses, wrong for
   * one where the point is that nothing needs scrolling.
   */
  check('the desktop hero is not on the dashboard', home.heroGone === true);
  check('and none of it is below the fold',
    home.tall <= TESLA.height + 2, `${home.tall} vs ${TESLA.height}`);
  check('nor off the right-hand edge',
    home.wide <= TESLA.width + 1, `${home.wide} vs ${TESLA.width}`);

  /* ---- 3. the bar you actually press ------------------------------------- */
  console.log('\n  the player controls');
  const bar = await page.evaluate(() => {
    document.querySelector('#playerOverlay').hidden = false;
    document.querySelector('#vodBar').hidden = false;
    document.querySelector('#ccWrap').hidden = false;
    /* Un-hidden ON PURPOSE. app.js shows these two for its own reasons — pip
       when the browser can do it, the pill whenever a channel starts — so a
       layout that only set `hidden` would lose the argument here. This is the
       check that it does not. */
    document.querySelector('#pipBtn').hidden = false;
    document.querySelector('#livePill').hidden = false;
    const px = (n) => Math.round(n);
    const of = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { w: px(r.width), h: px(r.height), font: getComputedStyle(n).fontSize,
        shown: getComputedStyle(n).display !== 'none' && r.width > 0 };
    };
    return {
      play: of('#vodPlay'), back: of('#vodBack10'), fwd: of('#vodFwd10'),
      cc: of('#ccBtn'), mute: of('#vodMute'), full: of('#vodFull'),
      track: of('#vodTrack'), knob: of('#vodKnob'),
      pip: of('#pipBtn'), pill: of('#livePill'),
    };
  });
  console.log('   ', JSON.stringify(bar));

  /* 44pt is the desk-distance guideline. A dashboard is further away and
     moves, so these are bigger than that on purpose. */
  check('play and pause is the biggest thing in the bar',
    bar.play.w >= 88 && bar.play.h >= 88, JSON.stringify(bar.play));
  check('the transport around it is comfortably over a fingertip',
    bar.back.h >= 64 && bar.fwd.h >= 64 && bar.mute.h >= 64,
    JSON.stringify([bar.back, bar.fwd, bar.mute]));
  check('captions is a real target, not a glyph',
    bar.cc.shown && bar.cc.w >= 88 && bar.cc.h >= 64 && parseFloat(bar.cc.font) >= 20,
    JSON.stringify(bar.cc));
  check('and the scrubber can be landed on',
    bar.track.h >= 12 && bar.knob.w >= 24, JSON.stringify([bar.track, bar.knob]));

  /* The two the request named, and they must stay gone against app.js. */
  check('picture in picture is gone', bar.pip.shown === false, JSON.stringify(bar.pip));
  check('and so is the delay readout', bar.pill.shown === false, JSON.stringify(bar.pill));

  /* ---- 4. and the other two shapes are untouched -------------------------- */
  /*
   * A third layout that changed the first two would be a regression wearing a
   * feature's clothes. Checked by going back to the desktop and finding it as
   * it was.
   */
  console.log('\n  and switching back');
  /* The player stays OPEN across the switch. Measuring the bar with the
     overlay closed measures a hidden element, which is zero wide whatever the
     layout says — a check that passes for the wrong reason and would go on
     passing if the car sizing leaked into the desktop. */
  await page.evaluate(() => { device.set('desk'); });
  await wait(900);
  const back = await page.evaluate(() => {
    const px = (n) => Math.round(n);
    const play = document.querySelector('#vodPlay').getBoundingClientRect();
    return {
      shell: document.documentElement.className,
      carHome: !!document.querySelector('#homeView.car-home'),
      fitted: !!document.querySelector('.app-shell.car-fit'),
      playW: px(play.width),
      searchWide: px(document.querySelector('.site-header .search').getBoundingClientRect().width),
    };
  });
  console.log('   ', JSON.stringify(back));
  check('the car layer comes off', !/\bcar\b/.test(back.shell), back.shell);
  check('home stops being the car arrangement', back.carHome === false);
  check('and the shell gets its scroll back', back.fitted === false);
  check('and the desktop gets its own controls back',
    back.playW > 0 && back.playW < 88, String(back.playW));
  check('including its search box', back.searchWide > 120, String(back.searchWide));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
