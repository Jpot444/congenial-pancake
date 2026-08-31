/**
 * Two bins, one icon.
 *
 * "I want to add the same recommendation 'for you' section to the series tab
 *  so I can be recommended new series to watch based on my ratings and viewing
 *  history. Only inside of the For You page on both tabs I want the trash can
 *  icon to remove it out of my recommendation page, but not hide it from the
 *  library like it does on other pages."
 *
 * Everywhere in this app the bin on a poster HIDES A TITLE: out of every
 * shelf, out of the grid, out of search, permanently, until it is fetched back
 * from Deleted. That is exactly right for the eleven copies of a film nobody
 * will ever watch.
 *
 * On For You it would be a trap. That row is made entirely of things nobody
 * here has seen — that is the whole definition of it — so the only way to find
 * out whether you want one is to open it. Making "not that one" cost the title
 * means a shrug at a poster quietly deletes a film out of a library its owner
 * has not looked at yet, and they will never know it happened.
 *
 * So: same icon, because to a hand it means the same thing — make this go
 * away. Different sentence, because the thing being made to go away is
 * different. This suite is about keeping those two apart.
 *
 *   THE FOR YOU BIN removes the card from the row, tells the box, and touches
 *   nothing else. profiles.toggleDeleted is never called; the title is still
 *   in the library, still in the grid, still findable.
 *
 *   THE ORDINARY BIN is unchanged, on the same tab, one row down.
 *
 *   AND THE ROW IS ON BOTH TABS, which is the other half of the request.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MOVIES = {
  categories: [{ id: 'ac', name: 'EN - ACTION' }],
  items: Array.from({ length: 8 }, (_, i) => ({
    kind: 'movie', id: i + 1, name: `Film ${i + 1}`, logo: '',
    categoryId: 'ac', added: 1000 + i,
  })),
};
const SERIES = {
  categories: [{ id: 's1', name: 'NETFLIX SERIES' }],
  items: Array.from({ length: 8 }, (_, i) => ({
    kind: 'series', id: 500 + i, name: `Show ${i + 1}`, logo: '',
    categoryId: 's1', genre: 'Drama', added: 2000 + i,
  })),
};

/* What the box recommends, per half of the catalogue. Two different answers,
   so a row showing the wrong one is visible rather than plausible. */
const FOR_YOU = {
  movie: [
    { ...MOVIES.items[0], why: ['Directed by Somebody'] },
    { ...MOVIES.items[1], why: ['With Somebody Else'] },
    { ...MOVIES.items[2], why: [] },
  ],
  series: [
    { ...SERIES.items[0], why: ['More drama'] },
    { ...SERIES.items[1], why: [] },
  ],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  /* Every recommendation the box is asked for, and what it was asked about. */
  const asked = [];
  await page.route('**/api/profiles/*/foryou**', (r) => {
    const kind = new URL(r.request().url()).searchParams.get('kind') || '(none)';
    asked.push(kind);
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: FOR_YOU[kind === 'series' ? 'series' : 'movie'],
        needs: '', picks: [], similar: { asked: 1, answered: 1, source: 'themoviedb' },
      }) });
  });

  /* And every "not that one" it is told about. */
  const binned = [];
  await page.route('**/api/profiles/*/notinterested', (r) => {
    binned.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"notInterested":[]}' });
  });
  /* If the ordinary bin were reached, it saves through prefs. Nothing in this
     suite should touch it except the one press that is meant to. */
  const prefSaves = [];
  await page.route('**/api/profiles/*/prefs', (r) => {
    if (r.request().method() === 'PUT') prefSaves.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  const open = async (tab) => {
    await page.evaluate(({ movies, series, want }) => {
      state.library.movies = movies;
      state.library.series = series;
      state.tab = want;
      state.shelf = null;
      state.category = null;
      location.hash = `#/${want}`;
      render();
    }, { movies: MOVIES, series: SERIES, want: tab });
    await page.waitForSelector('.shelf', { timeout: 10000 });
    await wait(600);
    await page.evaluate(() => render());
    await wait(200);
  };

  /* The For You shelf as it is actually on the page, by its heading rather
     than by its position — a row taken by its place in a list is a row taken
     on a coincidence. */
  const forYouShelf = () => page.evaluate(() => {
    const section = [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title')?.textContent === 'For You');
    if (!section) return null;
    return {
      cards: [...section.querySelectorAll('.card')].map((c) => ({
        name: c.querySelector('.card-title')?.textContent || '',
        why: c.querySelector('.card-why')?.textContent || '',
        forYouBin: Boolean(c.querySelector('.card-bin.is-foryou')),
        anyBin: Boolean(c.querySelector('.card-bin')),
      })),
    };
  });

  /* ---- the row is on both tabs ----------------------------------------- */
  console.log('\n  the recommendation row, on both tabs');
  await open('movies');
  const films = await forYouShelf();
  console.log('   movies:', JSON.stringify(films && films.cards.map((c) => c.name)));
  check('Movies has one', films && films.cards.length === 3,
    JSON.stringify(films && films.cards.length));
  check('and each card says why it is there',
    films && films.cards[0].why.length > 0, JSON.stringify(films && films.cards[0]));

  await open('series');
  const shows = await forYouShelf();
  console.log('   series:', JSON.stringify(shows && shows.cards.map((c) => c.name)));
  /* The series row used to be the shows you had recently watched, wearing the
     name of a recommendation. Now it is a recommendation. */
  check('Series has one too', shows && shows.cards.length === 2,
    JSON.stringify(shows && shows.cards.length));
  check('and it holds shows rather than films',
    shows && shows.cards.every((c) => /^Show /.test(c.name)),
    JSON.stringify(shows && shows.cards.map((c) => c.name)));
  console.log('   asked about:', JSON.stringify(asked));
  /* Two catalogues and two sets of signals, so two questions. One shared
     answer would mean whichever tab was opened last won both rows. */
  check('the box is asked about each half separately',
    asked.includes('movie') && asked.includes('series'), JSON.stringify(asked));

  /* ---- and the bin on it is a different bin ---------------------------- */
  console.log('\n  the bin inside For You');
  check('every card on the row has one',
    shows && shows.cards.every((c) => c.forYouBin), JSON.stringify(shows && shows.cards));

  /* Pressed on the series row, because that is the tab that did not have this
     row at all until now. */
  const after = await page.evaluate(async () => {
    /* Watched rather than stubbed: the claim is that the library bin is not
       reached, and the only honest way to say that is to see whether the
       function that hides titles was called. */
    const real = profiles.toggleDeleted.bind(profiles);
    let hid = 0;
    profiles.toggleDeleted = (item) => { hid += 1; return real(item); };

    const section = [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title')?.textContent === 'For You');
    const card = section.querySelector('.card');
    const name = card.querySelector('.card-title').textContent;
    card.querySelector('.card-bin.is-foryou').click();
    await new Promise((r) => setTimeout(r, 500));

    const now = [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title')?.textContent === 'For You');
    return {
      pressed: name,
      hid,
      left: [...now.querySelectorAll('.card-title')].map((t) => t.textContent),
      /* Still in the library, still in the grid, still findable — the three
         things the OTHER bin takes away. */
      inLibrary: state.library.series.items.some((i) => i.name === name),
      deleted: profiles.isDeleted(state.library.series.items.find((i) => i.name === name)),
      inGrid: buildShelves('series')
        .filter((r) => r.title !== 'For You')
        .some((r) => r.items.some((i) => i.name === name)),
    };
  });
  console.log('   ', JSON.stringify(after));
  check('the card leaves the row', !after.left.includes(after.pressed),
    JSON.stringify(after.left));
  check('and the box is told which one it was',
    binned.some((b) => b.kind === 'series'), JSON.stringify(binned));
  /* The whole of the request, in one line: this press must not be the other
     press. */
  check('the library bin is never reached', after.hid === 0, String(after.hid));
  check('the title is still in the library', after.inLibrary === true);
  check('and not marked hidden', after.deleted === false);
  check('and still on the ordinary shelves', after.inGrid === true, JSON.stringify(after.inGrid));
  check('and nothing was written to the hidden list',
    prefSaves.every((p) => !(p.deletedItems || []).length), JSON.stringify(prefSaves));

  /* ---- and the full page of the row is the same row --------------------- */
  console.log('\n  and opening the whole row');
  const opened = await page.evaluate(async () => {
    state.shelf = 'For You';
    state.visible = 60;
    render();
    await new Promise((r) => setTimeout(r, 300));
    const cards = [...document.querySelectorAll('#grid .card')];
    const out = {
      cards: cards.length,
      forYouBins: cards.filter((c) => c.querySelector('.card-bin.is-foryou')).length,
      libraryBins: cards.filter((c) => c.querySelector('.card-bin:not(.is-foryou)')).length,
    };
    state.shelf = null;
    render();
    await new Promise((r) => setTimeout(r, 200));
    return out;
  });
  console.log('   ', JSON.stringify(opened));
  /* A card is the same card however much of the row is on screen. Finding the
     library bin on the full page would mean one poster meant two different
     things depending on where you pressed it. */
  check('every card still carries the suggestion bin',
    opened.cards > 0 && opened.forYouBins === opened.cards, JSON.stringify(opened));
  check('and none of them the library one', opened.libraryBins === 0, JSON.stringify(opened));

  /* ---- while the ordinary bin is untouched ----------------------------- */
  console.log('\n  and the ordinary bin, one row down, still hides things');
  const ordinary = await page.evaluate(async () => {
    const section = [...document.querySelectorAll('.shelf')]
      .find((s) => s.querySelector('.shelf-title')?.textContent !== 'For You');
    const card = section.querySelector('.card');
    const name = card.querySelector('.card-title').textContent;
    const bin = card.querySelector('.card-bin');
    const isForYou = bin.classList.contains('is-foryou');
    bin.click();
    await new Promise((r) => setTimeout(r, 400));
    const item = state.library.series.items.find((i) => i.name === name);
    return { name, isForYou, deleted: profiles.isDeleted(item) };
  });
  console.log('   ', JSON.stringify(ordinary));
  check('its bin is the library one', ordinary.isForYou === false);
  check('and it does what it always did', ordinary.deleted === true, JSON.stringify(ordinary));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
