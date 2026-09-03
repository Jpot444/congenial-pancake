/**
 * A show is a show, and a billboard is about you.
 *
 * Five things from one report, and four of them are the same mistake seen from
 * different angles: a HISTORY ROW is not a title. It is written per episode,
 * because an episode is what was watched, and it carries the episode's name and
 * usually no artwork at all. Drawn straight, that gives cards called
 * "Episode 1", "Episode 2", "Episode 3" over empty tinted fields — one row of
 * the same show, three times, none of them recognisable.
 *
 * The library has the show, with its name and its poster, and the row says
 * which one. So the row is looked up before it is drawn, and the shelf that
 * results is one card per TITLE with the title's own artwork on it.
 *
 *   "In continue watching, if there is a series make it bring up the card for
 *    the series, not just Episode 1, Episode 2 ect"
 *   "In series, the up next images are all blank, make them the card for the
 *    series also"
 *
 * The billboard is the other two:
 *
 *   "Hero image on desktop needs a fix, when it is a show logo it is often
 *    zoomed in beyond being recognizable. If it is a live tv logo it is too
 *    far back to see and often dark like it is with CBS."
 *
 * Both are the same fault as well: a billboard nearly three times as wide as
 * it is tall, covered with art that is neither. A poster is 2:3 — covering
 * throws most of it away and magnifies what is left. A station mark is a few
 * hundred pixels of logo — covering blows it up six-fold and crops it, and the
 * previous fix for that made it so small and so faint it read as furniture.
 * Which shape a given image is cannot be told from the URL or the kind, since
 * the provider sends both under the same field, so it is MEASURED on load.
 *
 *   "It is also always has the lead show being whatever the lead is on 'on
 *    now' I want it to be the last channel, show or movie I watched"
 *
 * And that one is not a rendering fault at all: the billboard led with
 * whichever favourite channel came first, which is a fact about a list rather
 * than about the person reading it, and never changed.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Art of a stated shape, inline, so nothing has to be fetched and the aspect
   ratio under test is exactly the one intended. */
const art = (w, h, fill) => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
  + `<rect width="100%" height="100%" fill="${fill}"/></svg>`).toString('base64')}`;
const POSTER = art(600, 900, '#7a2f2f');   // 2:3, the shape a show's logo is
const MARK = art(400, 220, '#111111');     // small, wide and near black — CBS
const BACKDROP = art(1600, 900, '#25405a'); // 16:9, a real backdrop

const LIB = {
  movies: {
    categories: [{ id: 'c1', name: 'EN - WESTERNS' }],
    items: [
      { kind: 'movie', id: 60, name: 'Redwood Gulch', categoryId: 'c1', ext: 'mp4', logo: POSTER },
      { kind: 'movie', id: 61, name: 'Wide Country', categoryId: 'c1', ext: 'mp4', logo: BACKDROP },
    ],
  },
  series: {
    categories: [{ id: 's1', name: 'EN - DRAMA' }],
    items: [{ kind: 'series', id: 88, name: 'The Long Winter', categoryId: 's1', logo: POSTER }],
  },
  live: {
    categories: [{ id: 'sport', name: 'US - SPORTS' }],
    items: [{ kind: 'live', id: 900, name: 'US| CBS ᴴᴰ', categoryId: 'sport', logo: MARK }],
  },
};

/*
 * The history exactly as the report describes it: three episodes of one show,
 * each remembering only its own episode name, none carrying a seriesId and
 * none carrying a poster. This is the shape that produced "Episode 1, Episode
 * 2" — and the no-seriesId part is why grouping by id was not enough.
 */
const HISTORY = [
  { key: 'series:5001', kind: 'series', id: 5001, seriesName: 'The Long Winter',
    name: 'Episode 3', season: 1, episode: 3, position: 600, duration: 2400,
    at: Date.now(), poster: '' },
  { key: 'series:5002', kind: 'series', id: 5002, seriesName: 'The Long Winter',
    name: 'Episode 2', season: 1, episode: 2, position: 1200, duration: 2400,
    at: Date.now() - 1e3, poster: '' },
  { key: 'series:5003', kind: 'series', id: 5003, seriesName: 'The Long Winter',
    name: 'Episode 1', season: 1, episode: 1, position: 2300, duration: 2400,
    at: Date.now() - 2e3, poster: '' },
  { key: 'movie:60', kind: 'movie', id: 60, name: 'Redwood Gulch',
    position: 900, duration: 6000, at: Date.now() - 3e3, poster: '' },
];

const open = async (browser, width, height) => {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/library*', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(LIB[tab] || { categories: [], items: [] }) });
  });
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await page.evaluate((lib) => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    Object.assign(state.library, lib);
  }, LIB);
  return page;
};

/* Home first, THEN the history — going to a page reloads it from the profile,
   so a row planted on the way in is wiped by the navigation. */
const goWithHistory = async (page, hash, rows) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await wait(1400);
  await page.evaluate((r) => { state.recentlyWatched = r; render(); }, rows);
  await wait(2200);
};

(async () => {
  const browser = await chromium.launch();
  const page = await open(browser, 1440, 900);

  /* ---- 1. Continue watching is a shelf of TITLES ----------------------- */
  console.log('\n  continue watching');
  await goWithHistory(page, '#/home', HISTORY);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.home-recent .card')].map((n) => ({
      title: n.querySelector('.card-title')?.textContent || '',
      sub: n.querySelector('.card-sub')?.textContent || '',
      art: !!n.querySelector('.card-art img'),
    })));
  console.log('   ', JSON.stringify(cards));

  check('one card per show, not one per episode', cards.length === 2,
    `${cards.length} cards for 3 episodes of one show plus a film`);
  check('titled as the show', cards[0]?.title === 'The Long Winter', cards[0]?.title);
  check('never as the episode',
    !cards.some((c) => /^Episode \d/.test(c.title)), JSON.stringify(cards.map((c) => c.title)));
  /* The row carries no poster; the library does, and that is the whole fix. */
  check('with the show\'s own artwork on it', cards[0]?.art === true);
  /* Where you are in it still belongs on the card — under the show's name,
     which is the one place an episode number reads as help rather than as the
     title of the thing. */
  check('and the episode kept as the line underneath', cards[0]?.sub === 'S1·E3',
    cards[0]?.sub);

  /* ---- 2. the billboard leads with the last thing watched --------------- */
  console.log('\n  the billboard');
  const lead = await page.evaluate(() => ({
    title: document.querySelector('#dkHero .copy.on .big')?.textContent || '',
    eyebrow: document.querySelector('#dkHero .copy.on .eyebrow')?.textContent.trim() || '',
    slide: document.querySelector('#dkHero .slide.on')?.className || '',
  }));
  console.log('   ', JSON.stringify(lead));
  check('it leads with what was watched last', lead.title === 'The Long Winter', lead.title);
  check('and says so', /Continue watching/i.test(lead.eyebrow), lead.eyebrow);

  /* A 2:3 poster on a billboard nearly three times as wide as it is tall.
     Covering throws most of it away and magnifies what is left, which is the
     show logo zoomed past recognition. */
  check('a poster is laid out whole rather than covered with',
    /is-poster/.test(lead.slide), lead.slide);
  const poster = await page.evaluate(() => {
    const i = document.querySelector('#dkHero .slide.on .art img');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x),
      natural: `${i.naturalWidth}x${i.naturalHeight}`,
      fit: getComputedStyle(i).objectFit };
  });
  console.log('   ', JSON.stringify(poster));
  check('at its own shape, not stretched to the billboard\'s',
    poster && Math.abs((poster.w / poster.h) - (600 / 900)) < 0.06,
    JSON.stringify(poster));
  /* On the right, where the copy is not. Centred, it sits under the words. */
  check('and clear of the words', poster && poster.x > 700, JSON.stringify(poster));

  /* ---- 3. a channel mark, which is the other end of the same problem ---- */
  console.log('\n  and when the last thing was a channel');
  await page.evaluate(() => {
    state.recentlyWatched = [{ key: 'live:900', kind: 'live', id: 900,
      name: 'US| CBS ᴴᴰ', position: 0, duration: 0, at: Date.now(), poster: '' }];
    render();
  });
  await wait(2200);
  const mark = await page.evaluate(() => {
    const slide = document.querySelector('#dkHero .slide.on');
    const i = slide?.querySelector('.art img');
    const r = i?.getBoundingClientRect();
    const lit = slide ? getComputedStyle(slide.querySelector('.art'), '::before') : null;
    return {
      title: document.querySelector('#dkHero .copy.on .big')?.textContent || '',
      slide: slide?.className || '',
      w: r ? Math.round(r.width) : 0,
      x: r ? Math.round(r.x) : 0,
      opacity: i ? Number(getComputedStyle(i).opacity) : 0,
      zIndex: i ? getComputedStyle(i).zIndex : '',
      litWidth: lit ? lit.width : '',
    };
  });
  console.log('   ', JSON.stringify(mark));
  check('the channel leads when the channel was last', mark.title === 'CBS', mark.title);
  check('its mark is laid out, not covered with', /is-mark/.test(mark.slide), mark.slide);
  /* "Too far back to see" was two things at once: small, and faint. */
  check('drawn up to the room it is given rather than left at its own size',
    mark.w >= 380, `${mark.w}px from a 400px file`);
  check('and bright enough to be a mark rather than a smudge',
    mark.opacity >= 0.85, String(mark.opacity));
  /*
   * Opacity alone does nothing for a mark that is itself dark — CBS's eye is
   * near black, and no opacity separates black from a black billboard. The
   * plate behind it is lifted instead, and it has to be BEHIND: a pseudo
   * element after the children paints on top of them and washes the mark out,
   * which is what the first attempt did.
   */
  check('with a light behind it, for the marks that are dark',
    mark.litWidth && parseFloat(mark.litWidth) > 100, mark.litWidth);
  check('and the mark in front of that light, not under it',
    mark.zIndex === '1', mark.zIndex);

  /* ---- 4. a real backdrop is still a backdrop -------------------------- */
  /*
   * The half that stops this being "never cover with anything". Art that is
   * genuinely wide IS a backdrop and should fill the billboard — measuring is
   * the point, so the measurement has to be able to come out the other way.
   */
  console.log('\n  and a real backdrop');
  await page.evaluate(() => {
    state.recentlyWatched = [{ key: 'movie:61', kind: 'movie', id: 61,
      name: 'Wide Country', position: 100, duration: 6000, at: Date.now(), poster: '' }];
    render();
  });
  await wait(2200);
  const wide = await page.evaluate(() => ({
    slide: document.querySelector('#dkHero .slide.on')?.className || '',
    fit: (() => {
      const i = document.querySelector('#dkHero .slide.on .art img');
      return i ? getComputedStyle(i).objectFit : '';
    })(),
  }));
  console.log('   ', JSON.stringify(wide));
  check('16:9 art still covers the billboard', !/is-poster|is-mark/.test(wide.slide),
    wide.slide);
  check('as a backdrop, which is what it is', wide.fit === 'cover', wide.fit);

  /* ---- 5. Up next, on the Series page ---------------------------------- */
  console.log('\n  up next');
  await goWithHistory(page, '#/series', HISTORY);
  const next = await page.evaluate(() =>
    [...document.querySelectorAll('#dkUpNext .dk-ep')].map((n) => ({
      name: n.querySelector('.nm')?.textContent || '',
      art: !!n.querySelector('.still img'),
    })));
  console.log('   ', JSON.stringify(next));
  check('one card per show here too', next.length === 1,
    `${next.length} cards for 3 episodes of one show`);
  check('named as the show', next[0]?.name === 'The Long Winter', next[0]?.name);
  /* The reported symptom, exactly: these were an empty tinted field. */
  check('and no longer blank', next[0]?.art === true, JSON.stringify(next[0]));

  /* ---- 6. and the Tesla ticker is gone --------------------------------- */
  /*
   * "get rid of that scrolling bar in tesla view, dont replace it just get rid
   *  of it." Removed rather than swapped for something quieter, and the room
   *  goes back to the two columns.
   */
  console.log('\n  the Tesla view');
  await page.evaluate(() => { device.set('car'); });
  await wait(600);
  await goWithHistory(page, '#/home', HISTORY);
  const car = await page.evaluate(() => ({
    ticker: document.querySelectorAll('.car-ticker, .tick-track, .tick-game').length,
    watch: !!document.querySelector('.car-watch'),
    scores: !!document.querySelector('.car-scores'),
    rows: getComputedStyle(document.querySelector('#homeView.car-home') || document.body)
      .gridTemplateAreas,
  }));
  console.log('   ', JSON.stringify(car));
  check('there is no ticker anywhere', car.ticker === 0, String(car.ticker));
  check('and nothing took its place — the two columns have the room',
    car.watch && car.scores && !/ticker/.test(car.rows), car.rows);

  await page.evaluate(() => { device.set('desk'); });
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
