/**
 * A provider that renumbers is not a provider that withdrew everything.
 *
 * "im getting title no longer in library messages when I try to play things
 *  from my recently played on homescreen and series"
 *
 * A watch history remembers the provider's FILING NUMBER, not the film. This
 * provider renumbers its catalogue — a re-ingest, a category reshuffle, a
 * feed rebuilt overnight — and when it does, every id written down in a
 * history points at nothing. Continue watching is where that shows up first
 * and worst: the row is right there with the poster on it and the progress bar
 * part-filled, and pressing it said the title had been withdrawn while it sat
 * in the library under a new number.
 *
 * It hits films and shows together, from the history and nowhere else, which
 * is exactly the shape of the report — browsing the library still works,
 * because the cards on a shelf were built from the library that is loaded.
 *
 * So the name is tried when the id fails. Only after every id lookup and never
 * instead of one: an id is exact and a name can collide, so this is the
 * fallback for a lookup that has already failed, where the choice is between a
 * plausible match and telling somebody their programme is gone.
 *
 * The second half is the message left over for when there is genuinely no
 * match, which must stay a plain statement. A hedge was tried here — "it may
 * just be outside the language filter" — and taken out again: the wide
 * catalogue is deliberately not loaded until somebody asks for it, so the
 * hedge fired on every real removal too, and three suites said so.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* The library AFTER the renumber: same titles, different ids. The film also
   picks up a filing prefix on the way, which is the other thing that changes
   under a re-ingest and which a plain string compare would trip over. */
const LIB = {
  movies: {
    categories: [{ id: 'c1', name: 'Westerns' }],
    items: [
      { kind: 'movie', id: 90055, name: 'EN - Redwood Gulch (1978)',
        categoryId: 'c1', ext: 'mp4', logo: '' },
      { kind: 'movie', id: 90057, name: 'Custard Pie', categoryId: 'c1', ext: 'mp4', logo: '' },
    ],
  },
  series: {
    categories: [{ id: 's1', name: 'Drama' }],
    items: [{ kind: 'series', id: 90088, name: 'The Show', categoryId: 's1', logo: '' }],
  },
  live: { categories: [], items: [] },
};

/* The history, written down BEFORE it: the old ids, which now find nothing. */
const TASTE = {
  continueWatching: [],
  categoryAffinity: [],
  ratings: {},
  recentlyWatched: [
    { key: 'movie:55', kind: 'movie', id: 55, name: 'Redwood Gulch',
      position: 300, duration: 6000, at: Date.now(), poster: '' },
    { key: 'series:88:1:2', kind: 'series', id: 88, seriesId: 88, seriesName: 'The Show',
      name: 'The Show', season: 1, episode: 2, position: 300, duration: 2400,
      at: Date.now() - 1000, poster: '' },
    /* And one that really is gone, so "found it anyway" cannot be the answer
       to everything. */
    { key: 'movie:77', kind: 'movie', id: 77, name: 'A Withdrawn Picture',
      position: 100, duration: 6000, at: Date.now() - 2000, poster: '' },
  ],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/library*', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(LIB[tab] || { categories: [], items: [] }) });
  });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TASTE) }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  /* What the box was actually asked to play. This is how "it found the right
     one" is answered — by the id that went to the provider, not by what the
     screen says. */
  const asked = [];
  await page.route('**/api/play*', (r) => {
    asked.push(new URL(r.request().url()).searchParams.get('id'));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) });
  });
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/downloads*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    window.__toasts = [];
    const real = window.toast;
    window.toast = (msg, opts) => { window.__toasts.push(String(msg)); return real(msg, opts); };
  });
  await page.evaluate(() => { location.hash = '#/home'; });
  await wait(1200);
  await page.evaluate(async () => { await profiles.loadTaste(); render(); });
  await wait(800);

  const said = () => page.evaluate(() => window.__toasts.slice());
  const clear = () => page.evaluate(() => { window.__toasts.length = 0; });
  const playing = () => page.evaluate(() =>
    !document.querySelector('#playerOverlay').hidden);

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.home-recent .card-title')].map((n) => n.textContent.trim()));
  console.log('   Continue watching:', JSON.stringify(cards));
  check('the history is on the home screen to be pressed',
    cards.includes('Redwood Gulch') && cards.includes('The Show'), JSON.stringify(cards));

  /* ---- 1. a film whose id has moved ------------------------------------- */
  console.log('\n  pressing a film whose id the provider has reused');
  await clear();
  await page.evaluate(() => {
    [...document.querySelectorAll('.home-recent .card')]
      .find((n) => /Redwood Gulch/.test(n.textContent || '')).click();
  });
  await wait(2500);
  console.log('   said:', JSON.stringify(await said()), '· playing:', await playing());
  check('it plays rather than claiming to be withdrawn', await playing() === true);
  check('and says nothing about the library',
    !(await said()).some((t) => /library/i.test(t)), JSON.stringify(await said()));
  /* The one it found is the one under the NEW number, matched through the
     provider's filing prefix and a trailing year — a fold of the name, not a
     string compare. */
  console.log('   asked the box to play:', JSON.stringify(asked));
  check('having matched the title past the filing prefix and the year',
    asked.includes('90055'), JSON.stringify(asked));

  await page.evaluate(() => closePlayer());
  await wait(600);

  /* ---- 2. a show whose id has moved -------------------------------------- */
  console.log('\n  and a show, which goes through its own page to find the episode');
  await page.evaluate(() => { location.hash = '#/home'; });
  await wait(1200);
  await clear();
  await page.evaluate(() => {
    [...document.querySelectorAll('.home-recent .card')]
      .find((n) => /The Show/.test(n.textContent || '')).click();
  });
  await wait(2500);
  const at = await page.evaluate(() => location.hash);
  console.log('   said:', JSON.stringify(await said()), '· at', JSON.stringify(at));
  check('the show is found under its new number',
    /#\/series\/90088/.test(at), at);
  check('and nothing claims it was withdrawn',
    !(await said()).some((t) => /no longer in the library/i.test(t)),
    JSON.stringify(await said()));

  /* ---- 3. one that genuinely is gone -------------------------------------- */
  /*
   * The fallback must not turn into "always find something". A title that is
   * in neither the ids nor the names is gone, and saying so is the right
   * answer — it is the only one of these three that should get a message.
   */
  console.log('\n  and one that really has been withdrawn');
  await page.evaluate(() => { location.hash = '#/home'; });
  await wait(1200);
  await clear();
  await page.evaluate(() => {
    [...document.querySelectorAll('.home-recent .card')]
      .find((n) => /Withdrawn/.test(n.textContent || '')).click();
  });
  await wait(2500);
  const gone = await said();
  console.log('   said:', JSON.stringify(gone));
  check('is still reported, rather than opening something else',
    gone.length > 0 && await playing() === false, JSON.stringify(gone));

  /* ---- 4. and the wording still tells apart the two real cases ---------- */
  /*
   * "Withdrawn" and "not loaded yet" are different facts with different
   * remedies: somebody told their film is gone deletes the row, somebody told
   * the library has not loaded presses again. The pages that open a title by
   * address used to say "withdrawn" for both.
   */
  console.log('\n  and what it says in each of the two cases');
  const gone2 = await page.evaluate(() => missingWhy('movies', 'film'));
  console.log('   ', JSON.stringify(gone2));
  check('a loaded library that does not have it says so plainly',
    gone2 === 'That film is no longer in the library.', gone2);

  const empty = await page.evaluate(() => {
    const held = state.library.movies;
    state.library.movies = null;
    const msg = missingWhy('movies', 'film');
    state.library.movies = held;
    return msg;
  });
  console.log('   ', JSON.stringify(empty));
  check('and a library that has not loaded is not called a withdrawal',
    /has not loaded/i.test(empty), empty);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
