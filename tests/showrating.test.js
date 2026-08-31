/**
 * A show's page can say whether the show was any good.
 *
 * "I want a rating system where I can select like or dislike to tune my
 *  recommendations... Movies does that already sort of. I want it for series."
 *
 * The thumbs were built into the FILM page and nowhere else, so a show could
 * be watched, favourited and finished and never tell the box the one thing
 * For You is actually made of. Half the library had no way to answer the
 * question the recommendations are built on.
 *
 * And the other half of the request, which is the part that is easy to get
 * wrong: "Sometimes I have already watched a show or movie and want to use it
 * as an example of something I like, but dont want to watch it again right
 * now." So the press must be a RATING and nothing else — no history row, no
 * Continue watching, nothing marked seen. What it may do is take the show out
 * of the suggestions, because a row answering "you like this thing you told
 * me you like" has answered nothing.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIES = {
  categories: [{ id: 's1', name: 'NETFLIX SERIES' }],
  items: [
    { kind: 'series', id: 500, name: 'The Long Show', categoryId: 's1',
      genre: 'Crime, Drama', logo: '', rating: '8.8' },
    { kind: 'series', id: 501, name: 'Another Show', categoryId: 's1',
      genre: 'Comedy', logo: '', rating: '7.2' },
  ],
  totals: { items: 2 },
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'series'
        ? SERIES : { categories: [], items: [], totals: { items: 0 } }) });
  });
  await page.route('**/api/series**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ info: { genre: 'Crime, Drama', plot: 'A show.' },
        seasons: [], episodes: {} }) }));
  /* The box's ratings, kept the way the box keeps them: a zero DELETES rather
     than storing a zero, and whatever is held is what every other endpoint
     hands back — otherwise leaving the page and coming back reads as the
     rating never having been made. */
  const ratings = {};
  const rated = [];
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ recentlyWatched: [], categoryAffinity: [], ratings }) }));
  await page.route('**/api/profiles/*/foryou**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"items":[],"needs":"seeds","picks":[],"similar":{}}' }));

  await page.route('**/api/profiles/*/rating', (r) => {
    const said = JSON.parse(r.request().postData() || '{}');
    rated.push(said);
    if (said.value) ratings[said.key] = said.value;
    else delete ratings[said.key];
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ratings }) });
  });
  /* Every history row the page starts. This list is the one that has to stay
     empty: a rating is not a watch. */
  const watched = [];
  await page.route('**/api/profiles/*/history', (r) => {
    if (r.request().method() !== 'GET') {
      watched.push(JSON.parse(r.request().postData() || '{}'));
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"history":[]}' });
  });

  /* networkidle, so the boot has finished and the app shell is actually up:
     forcing the config by hand races startApp() and leaves the page on the
     setup screen with everything below it hidden — which looks like a missing
     button rather than an app that never started. */
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1200);
  }
  await page.evaluate((rows) => { state.library.series = rows; }, SERIES);

  /* ---- the show's own page --------------------------------------------- */
  console.log('\n  a show page');
  await page.evaluate(() => { location.hash = '#/series/500'; });
  await page.waitForSelector('.show-card', { timeout: 10000 });
  await wait(600);

  const there = await page.evaluate(() => {
    const up = document.querySelector('.show-card .film-thumb.is-up');
    const down = document.querySelector('.show-card .film-thumb.is-down');
    return {
      up: up ? up.textContent : null,
      down: down ? down.textContent : null,
      // Sized to its words rather than stretched across the row.
      wide: up ? up.getBoundingClientRect().width : 0,
      row: Boolean(document.querySelector('.show-actions .film-thumbs')),
    };
  });
  console.log('   ', JSON.stringify(there));
  /* The whole visible ask: the control exists on a series page at all. */
  check('carries a like and a not-for-me', Boolean(there.up && there.down),
    JSON.stringify(there));
  check('in the row of things you do without playing it', there.row === true);
  check('and they are buttons, not a stretched bar',
    there.wide > 30 && there.wide < 260, String(there.wide));

  /* ---- pressing it ------------------------------------------------------ */
  console.log('\n  pressing like');
  await page.click('.show-card .film-thumb.is-up');
  await wait(700);
  const after = await page.evaluate(() => ({
    on: document.querySelector('.show-card .film-thumb.is-up')?.classList.contains('on'),
    said: document.querySelector('#toast')?.textContent || '',
  }));
  console.log('   ', JSON.stringify({ ...after, rated, watched: watched.length }));
  check('it is written down under the show, not an episode',
    rated.length === 1 && rated[0].key === 'series:500' && rated[0].value === 1,
    JSON.stringify(rated));
  check('and the button shows it is on', after.on === true);
  /* The sentence that answers the worry: marking something as liked must not
     read as queueing it up. */
  check('and says plainly that nothing was marked watched',
    /nothing was marked/i.test(after.said), after.said);
  /* The claim that matters most. A rating is not a watch — no history row, so
     nothing appears in Continue watching and nothing is counted as seen. */
  check('no watch is recorded', watched.length === 0, JSON.stringify(watched));

  console.log('\n  pressing it again clears it');
  await page.click('.show-card .film-thumb.is-up');
  await wait(600);
  const cleared = await page.evaluate(() =>
    document.querySelector('.show-card .film-thumb.is-up')?.classList.contains('on'));
  console.log('   rated:', JSON.stringify(rated));
  check('the rating is taken back',
    rated.length === 2 && rated[1].value === 0 && cleared === false,
    JSON.stringify({ rated, cleared }));

  console.log('\n  and not for me');
  await page.click('.show-card .film-thumb.is-down');
  await wait(600);
  const downState = await page.evaluate(() => ({
    down: document.querySelector('.show-card .film-thumb.is-down')?.classList.contains('on'),
    up: document.querySelector('.show-card .film-thumb.is-up')?.classList.contains('on'),
  }));
  console.log('   ', JSON.stringify(downState), JSON.stringify(rated[rated.length - 1]));
  check('the other thumb is written and the pair is exclusive',
    rated[rated.length - 1].value === -1 && downState.down === true && downState.up === false,
    JSON.stringify(downState));
  check('and still nothing was watched', watched.length === 0, JSON.stringify(watched));

  /* ---- and it survives coming back -------------------------------------- */
  console.log('\n  and it is still there on the way back');
  await page.evaluate(() => { location.hash = '#/series'; });
  await wait(500);
  await page.evaluate(() => { location.hash = '#/series/500'; });
  await page.waitForSelector('.show-card', { timeout: 10000 });
  await wait(500);
  const back = await page.evaluate(() =>
    document.querySelector('.show-card .film-thumb.is-down')?.classList.contains('on'));
  check('the page opens showing what was said about it', back === true, String(back));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
