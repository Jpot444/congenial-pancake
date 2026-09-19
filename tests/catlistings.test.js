/**
 * A live category opens on its schedule.
 *
 * "whenever I click on any live tv catagory now I want it to load as a
 *  listings of all the channels in that catagory showing what is on now"
 *
 * A category is a question about what to watch, and a grid of ninety logos
 * does not answer it — every tile says the same thing, which is that the
 * channel exists. The schedule answers it.
 *
 * The listings view already existed, pointed at a category and everything;
 * it was something you turned ON after arriving. What changes is which one a
 * category OPENS on, and that is a small change with three sharp edges, all
 * of them checked below:
 *
 *   - Every way in has to agree. The sidebar row, the folder tile and a
 *     reloaded address are three different code paths into the same place,
 *     and a rule that holds for two of them is a rule with a hole in it.
 *   - The way OUT has to exist. The schedule never carried a back button,
 *     because the toggle you arrived by was the way you left. Now it is the
 *     only exit.
 *   - Leaving has to land on the folders. `state.listings` left on at the top
 *     level is not the category grid — it is a schedule of your favourites,
 *     which is not what pressing "All categories" means.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Two categories, and enough channels in the first to prove the page size is
   a page rather than the whole list. */
const CHANNELS = [];
for (let i = 0; i < 52; i += 1) {
  CHANNELS.push({ kind: 'live', id: 700 + i, name: `US| SPORTS ${i}`,
    num: 200 + i, categoryId: 'sports' });
}
CHANNELS.push({ kind: 'live', id: 900, name: 'US| NEWS ONE', num: 300, categoryId: 'news' });
const CATEGORIES = [{ id: 'sports', name: 'Sports' }, { id: 'news', name: 'News' }];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  /* The listings. `known: true` matters — it is the box saying it asked and
     answered, as against not having reached that channel, and a row left
     unanswered never gets its slabs. */
  const asked = [];
  let busy = false;
  await page.route('**/api/epg/now*', (r) => {
    const ids = String(new URL(r.request().url()).searchParams.get('ids') || '')
      .split(',').filter(Boolean);
    asked.push(ids);
    const now = Math.floor(Date.now() / 1000);
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        busy,
        channels: busy
          ? ids.map((id) => ({ id, known: false, listings: [] }))
          : ids.map((id) => ({ id, known: true, listings: [
            { title: `On now ${id}`, start: now - 600, stop: now + 3000 },
            { title: `Up next ${id}`, start: now + 3000, stop: now + 6600 },
          ] })),
      }) });
  });

  /* The library, served rather than poked into state.
   *
   * The box under test is an m3u box pointed at nothing, so loadTab() throws
   * and showTab paints "Couldn't load live" and returns BEFORE render(). A
   * library assigned by hand afterwards is a library the page never renders
   * from, and the grid stays empty for a reason that has nothing to do with
   * what is being tested. Answering the call it actually makes is both
   * simpler and closer to a real box. */
  await page.route('**/api/playlist', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        live: CHANNELS.map((c) => ({ id: c.id, name: c.name, logo: '',
          group: c.categoryId, streamUrl: '', url: '' })),
        movie: [], series: [],
      }) }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(1500);

  /* ---- Live TV still opens on its categories --------------------------- */
  /*
   * Checked first, because it is what this change could most easily have
   * broken: "a category opens on listings" must not become "Live TV opens on
   * a schedule of eleven thousand channels".
   *
   * On this layout the front page is desktop.js's rails, one per category,
   * not app.js's wall of squares — renderLiveCategories is overridden to draw
   * nothing at all up here. Which is exactly why the rails' own click
   * handlers had to be part of this change: they set state.category directly
   * and would have gone on opening the old view while every door in app.js
   * opened the new one.
   */
  console.log('\n  Live TV still opens on its categories');
  let seen = await page.evaluate(() => ({
    rails: document.querySelectorAll('.rail-track').length,
    guide: document.querySelectorAll('.guide-row').length,
    listings: state.listings,
  }));
  console.log('   ', JSON.stringify(seen));
  check('the categories are what is on screen', seen.rails >= 2 && seen.guide === 0,
    JSON.stringify(seen));

  /* ---- pressing a category --------------------------------------------- */
  console.log('\n  and pressing one opens what is on, not a wall of logos');
  asked.length = 0;
  await page.evaluate(() => {
    const head = [...document.querySelectorAll('.shelf-head')]
      .find((h) => /sports/i.test(h.textContent || ''));
    head.click();
  });
  await wait(1800);
  seen = await page.evaluate(() => {
    const slabs = [...document.querySelectorAll('#grid .guide-prog')]
      .filter((s) => !s.classList.contains('is-blank'));
    return {
      listings: state.listings,
      category: state.category,
      rows: document.querySelectorAll('#grid .guide-row').length,
      titles: slabs.slice(0, 2).map((s) => s.querySelector('.guide-prog-title')?.textContent),
      times: slabs.slice(0, 2).map((s) => s.querySelector('.guide-prog-time')?.textContent),
      onNow: document.querySelectorAll('#grid .guide-prog.is-now').length,
      nowLine: Boolean(document.querySelector('#grid .guide-now-line')),
      heading: document.querySelector('#contentTitle')?.textContent,
      meta: document.querySelector('#contentMeta')?.textContent,
      button: document.querySelector('#listingsLabel')?.textContent,
    };
  });
  console.log('   ', JSON.stringify(seen));
  check('it is the schedule, not the channel grid', seen.listings === true,
    String(seen.listings));
  check('and it is that category', seen.category === 'sports', String(seen.category));
  check('a row per channel, up to a page of them', seen.rows === 40, String(seen.rows));
  check('each carrying what is airing', seen.titles.every((t) => /On now|Up next/.test(t || '')),
    JSON.stringify(seen.titles));
  check('at what time', seen.times.every((t) => /\d{1,2}:\d\d.+\d{1,2}:\d\d/.test(t || '')),
    JSON.stringify(seen.times));
  /* The one thing that makes it a guide rather than a timetable: which of
     these is happening, not merely which are listed. */
  check('and now marked on it', seen.onNow === 40 && seen.nowLine,
    JSON.stringify({ onNow: seen.onNow, line: seen.nowLine }));
  check('titled by the category', /sports/i.test(seen.heading || ''), seen.heading);
  /* The button still works, and now reads as the way back to the logos. */
  check('and the button offers the channels instead', /channels/i.test(seen.button || ''),
    seen.button);

  /* One request, not one per channel — the box caps the list at its end, so
     asking for more than it answers is asking for the rest to be dropped
     silently. */
  console.log('   asked:', JSON.stringify(asked.map((a) => a.length)));
  check('the listings were asked for in pages the box will actually answer',
    asked.length >= 1 && asked.every((a) => a.length <= 40),
    JSON.stringify(asked.map((a) => a.length)));

  /* ---- the rest of the category ---------------------------------------- */
  /*
   * "listings of ALL the channels in that catagory". A page at a time,
   * because a row the outside guide does not cover is a call to a provider
   * with one connection — but the rest has to be reachable, and the count
   * has to say it is there.
   */
  console.log('\n  and the rest of the category is one press away');
  seen = await page.evaluate(() => ({
    meta: document.querySelector('#contentMeta')?.textContent,
    more: !document.querySelector('#loadMore').hidden,
  }));
  console.log('   ', JSON.stringify(seen));
  check('it says how many there are in total', /40 of 52/.test(seen.meta || ''), seen.meta);
  check('and offers the rest', seen.more === true, String(seen.more));
  await page.evaluate(() => document.querySelector('#loadMore').click());
  await wait(1800);
  seen = await page.evaluate(() => ({
    rows: document.querySelectorAll('#grid .guide-row').length,
    more: !document.querySelector('#loadMore').hidden,
  }));
  console.log('   ', JSON.stringify(seen));
  check('pressing it shows the whole category', seen.rows === 52, String(seen.rows));
  check('and then stops offering more', seen.more === false, String(seen.more));

  /* ---- switching category from the bar --------------------------------- */
  /*
   * The bar's chips are a jump-to-rail on the front page and a way INTO a
   * category once you are in one — `pickCategory` only calls onOpen in grid
   * view. So this is the door that matters: already inside a schedule, press
   * another category and get that one's schedule, not its wall of logos.
   */
  console.log('\n  and the chips in the bar switch category the same way');
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll('#dkChips .catchip')]
      .find((c) => /news/i.test(c.dataset.c || ''));
    chip.click();
  });
  await wait(1600);
  seen = await page.evaluate(() => ({
    listings: state.listings,
    category: state.category,
    rows: document.querySelectorAll('#grid .guide-row').length,
  }));
  console.log('   ', JSON.stringify(seen));
  check('a category picked from the bar opens on its schedule too',
    seen.listings === true && seen.category === 'news' && seen.rows === 1,
    JSON.stringify(seen));

  /* ---- and a reloaded address ------------------------------------------ */
  /*
   * A typed or reloaded address restores state.category without going near
   * any click handler. A page you reach by pressing and a page you reach by
   * reloading are the same page and must not look different.
   */
  console.log('\n  and an address typed or reloaded opens on it as well');
  console.log('    hash:', await page.evaluate(() => location.hash));
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await wait(1600);
  seen = await page.evaluate(() => ({
    listings: state.listings,
    category: state.category,
    rows: document.querySelectorAll('#grid .guide-row').length,
    button: document.querySelector('#listingsLabel')?.textContent,
  }));
  console.log('   ', JSON.stringify(seen));
  check('the address that named a category still opens on its schedule',
    seen.listings === true && seen.category === 'news' && seen.rows === 1,
    JSON.stringify(seen));
  /* The button is painted from the same fact, and a button disagreeing with
     the page it is on is how somebody presses the wrong thing. */
  check('and the button agrees with the page it is on',
    /channels/i.test(seen.button || ''), seen.button);

  /* ---- the way back out ------------------------------------------------ */
  /*
   * The schedule never carried one: you arrived by pressing Listings and you
   * left by pressing it again. Now it is the only exit from a category, and a
   * page you can enter but not leave is the worst way this could have gone.
   */
  console.log('\n  and there is a way back out to the categories');
  const back = await page.evaluate(() => Boolean(document.querySelector('.folder-back')));
  check('the schedule carries one', back === true, String(back));
  await page.evaluate(() => document.querySelector('.folder-back').click());
  await wait(900);
  seen = await page.evaluate(() => ({
    category: state.category,
    listings: state.listings,
    rails: document.querySelectorAll('.rail-track').length,
    gridHidden: document.querySelector('#grid').hidden,
  }));
  console.log('   ', JSON.stringify(seen));
  check('and it lands on the categories', seen.rails >= 2 && seen.gridHidden === true,
    JSON.stringify(seen));
  /* The trap: leaving a category with state.listings still on is NOT the
     category page — it is a schedule of your favourites, which is not what
     pressing "All categories" means. */
  check('not on a schedule of something else', seen.listings === false,
    String(seen.listings));

  /* ---- a box that cannot ask says so ----------------------------------- */
  /*
   * Rows the box never got to are not channels with nothing on them. It
   * fetches a handful per pass from a provider with one connection, and it
   * does not ask at all while something is playing. Writing "No listings"
   * across those rows is the box reporting its own restraint as a fact about
   * the schedule — and forty rows all claiming nothing is on reads as a
   * broken guide rather than a busy one.
   */
  console.log('\n  and a box that cannot ask does not claim nothing is on');
  busy = true;
  await page.evaluate(() => openLiveCategory(null));
  await wait(600);
  await page.evaluate(() => {
    const head = [...document.querySelectorAll('.shelf-head')]
      .find((h) => /news/i.test(h.textContent || ''));
    head.click();
  });
  await wait(2500);
  const said = await page.evaluate(() => [...document.querySelectorAll('#grid .guide-prog-title')]
    .map((t) => t.textContent).filter(Boolean));
  console.log('   ', JSON.stringify(said));
  check('it says the guide is waiting, not that there is nothing on',
    said.length > 0 && said.every((t) => /waits while something is playing/i.test(t)),
    JSON.stringify(said));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
