/**
 * "That title is no longer in the library" — when it is not true.
 *
 * "I just tried to restart a movie that I have in downloads, and I got a
 *  notification that the title was no longer in library. I got the same
 *  notification earlier today when I tried to restart ESPN from my recently
 *  played section."
 *
 * Two different kinds of title, the same afternoon, both of them present.
 * That is not a provider dropping things; that is the library not being
 * there and the app blaming the titles.
 *
 * THE CAUSE. loadTab() wrote whatever came back into state.library[tab] —
 * including nothing. And the first line of that function returns whatever is
 * stored, so nothing was never asked about again. One empty answer from a
 * busy provider poisoned the whole session: every id looked up in an empty
 * list is missing, so a film sitting in downloads and a channel out of
 * Continue watching were both reported gone.
 *
 * The box already refuses to cache an empty library, for exactly this reason
 * and with a comment saying so. This side did not. An empty answer is not
 * stored now, which means it is asked again on the next press.
 *
 * AND A COPY ON THE BOX NEEDS NO CATALOGUE. The file is on the drive; whether
 * the provider still lists it is beside the point. Archive titles already
 * skipped the lookup for precisely this complaint — that stopped one case
 * short of downloads.
 *
 * AND THE WORDS. "No longer in the library" says the provider stopped
 * carrying something, which somebody acts on by deleting it. "The library has
 * not loaded" is a different fact with a different remedy: press it again.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const MOVIES = [
  { kind: 'movie', id: 501, name: 'A Film On The Box', categoryId: 'm1', ext: 'mp4' },
  { kind: 'movie', id: 502, name: 'A Film Not On The Box', categoryId: 'm1', ext: 'mp4' },
];
const CHANNELS = [{ kind: 'live', id: 700, num: 700, name: 'US| ESPN ᴴᴰ', categoryId: 'c1' }];

/* One finished download, of the first film. */
const DOWNLOADS = {
  items: [{ id: 'dl1', kind: 'movie', streamId: 501, name: 'A Film On The Box',
    status: 'done', ext: 'mp4', bytes: 100, total: 100 }],
  active: null,
  queued: 0,
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  /* The provider, answering 200 with nothing — busy, rate-limiting, or
     between updates. Which is the answer this whole suite is about. */
  let empty = true;
  let libraryCalls = 0;
  await page.route('**/api/library**', (r) => {
    libraryCalls += 1;
    const tab = new URL(r.request().url()).searchParams.get('tab');
    const items = tab === 'live' ? CHANNELS : MOVIES;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(empty
        ? { categories: [], items: [], totals: { items: 0 } }
        : { categories: [{ id: 'm1', name: 'ACTION' }, { id: 'c1', name: 'USA' }],
          items, totals: { items: items.length } }) });
  });
  await page.route('**/api/downloads**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DOWNLOADS) }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  page.__played = [];
  await page.route('**/api/play**', (r) => {
    page.__played.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/api/fake","format":"mp4"}' });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => {
    state.config.mode = 'xtream';
    state.downloads = { items: [{ id: 'dl1', kind: 'movie', streamId: 501,
      name: 'A Film On The Box', status: 'done', ext: 'mp4' }], active: null, queued: 0 };
  });

  /* ---- an empty answer is not the library ------------------------------ */
  console.log('\n  a provider that answers with nothing');
  const poisoned = await page.evaluate(async () => {
    state.library.movies = null;
    await loadTab('movies', { quiet: true });
    return { stored: state.library.movies === null, held: state.library.movies };
  });
  console.log('   ', JSON.stringify(poisoned));
  /* Stored, it is never asked about again — the first line of loadTab returns
     whatever is there — and every id looked up in it is missing for the rest
     of the session. */
  check('is not written down as the library',
    poisoned.stored === true, JSON.stringify(poisoned.held));

  const askedAgain = await page.evaluate(async () => {
    const before = window.__libCalls || 0;
    await loadTab('movies', { quiet: true });
    return before;
  });
  const callsAfterTwo = libraryCalls;
  console.log('   library calls after two loads:', callsAfterTwo, askedAgain);
  check('so it is asked again rather than believed', callsAfterTwo >= 2, String(callsAfterTwo));

  /* ---- and the words are the truth ------------------------------------- */
  console.log('\n  and what a viewer is told');
  const said = await page.evaluate(async () => {
    state.library.live = null;
    await playFromHistory({ kind: 'live', id: 700, key: 'live:700', name: 'ESPN' });
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector('#toast')?.textContent || '';
  });
  console.log('   said:', said);
  /* "No longer in the library" says the provider stopped carrying it, which
     somebody acts on by deleting it. The remedy here is to press again. */
  check('the library not loading is not the title being gone',
    /not loaded/i.test(said) && !/no longer/i.test(said), said);

  /* ---- a copy on the box needs no catalogue ---------------------------- */
  console.log('\n  a film already downloaded, with no library at all');
  const fromBox = await page.evaluate(async () => {
    state.library.movies = null;
    // Emptied rather than removed: #toast is a singleton the app writes into.
    const said = document.querySelector('#toast');
    if (said) { said.textContent = ''; said.hidden = true; }
    await playFromHistory({ kind: 'movie', id: 501, key: 'movie:501',
      name: 'A Film On The Box' });
    await new Promise((r) => setTimeout(r, 600));
    return {
      open: !document.querySelector('#playerOverlay')?.hidden,
      said: document.querySelector('#toast')?.textContent || '',
    };
  });
  console.log('   ', JSON.stringify(fromBox));
  /* The file is on the drive. Whether the provider still lists it is beside
     the point, and asking is how a film somebody owns came to be reported
     as gone. */
  check('it plays, without the catalogue being consulted at all',
    fromBox.open === true, JSON.stringify(fromBox));
  check('and nobody is told it is missing', !/no longer|not loaded/i.test(fromBox.said),
    fromBox.said);

  await page.evaluate(() => closePlayer());
  await page.waitForTimeout(300);

  /* ---- and a title that really is gone still says so ------------------- */
  console.log('\n  and a title that really has gone');
  // The provider comes back. `empty` lives out here, in the route handler.
  empty = false;
  const reallyGone = await page.evaluate(async () => {
    state.library.movies = null;
    // Emptied rather than removed: #toast is a singleton the app writes into.
    const said = document.querySelector('#toast');
    if (said) { said.textContent = ''; said.hidden = true; }
    await loadTab('movies', { quiet: true });
    await playFromHistory({ kind: 'movie', id: 999, key: 'movie:999', name: 'Long Gone' });
    await new Promise((r) => setTimeout(r, 300));
    return {
      loaded: (state.library.movies?.items || []).length,
      said: document.querySelector('#toast')?.textContent || '',
    };
  });
  console.log('   ', JSON.stringify(reallyGone));
  /* The strong claim is still available, and still made — but only when the
     library is actually there to be missing from. */
  check('a real library loads and holds its titles',
    reallyGone.loaded === MOVIES.length, String(reallyGone.loaded));
  check('and a title genuinely absent from it is called that',
    /no longer in the library/i.test(reallyGone.said), reallyGone.said);

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
