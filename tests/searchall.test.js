/**
 * One search across the whole library, and the drive in multi-view.
 *
 * Three things asked for together, and they belong together: all of them are
 * about a title being findable from wherever you happen to be standing.
 *
 *   * Typing searches Live, Movies and Series at once, each section filling
 *     in as its library arrives rather than everything waiting on the
 *     slowest.
 *   * The archive is NOT in that sweep. It is a separate index on the box,
 *     it belongs to one profile, and it is searched from the Archive page —
 *     which is exactly where its own search already lives.
 *   * Multi-view gets the drive as a source, and picking an archive title
 *     out of Recent stops claiming it is "no longer in the library" — a file
 *     on a drive never was in the provider's library to begin with.
 */
const fs = require('fs');
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');

const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const APP = fs.readFileSync(PATHS.APP, 'utf8');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const LIVE = {
  categories: [{ id: 'c1', name: 'Sports' }],
  items: [
    { kind: 'live', id: 1, name: 'Plain Sports HD', logo: '', categoryId: 'c1' },
    { kind: 'live', id: 2, name: 'Other Channel', logo: '', categoryId: 'c1' },
  ],
};
const MOVIES = {
  categories: [{ id: 'm1', name: 'Films' }],
  items: [
    { kind: 'movie', id: 11, name: 'The Plain Truth', logo: '', ext: 'mkv', categoryId: 'm1' },
    { kind: 'movie', id: 12, name: 'Something Else', logo: '', ext: 'mkv', categoryId: 'm1' },
  ],
};
const SERIES = {
  categories: [{ id: 's1', name: 'Shows' }],
  items: [
    { kind: 'series', id: 21, name: 'Plainsong', logo: '', categoryId: 's1' },
    { kind: 'series', id: 22, name: 'Unrelated', logo: '', categoryId: 's1' },
  ],
};

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));

  // Series is deliberately SLOW to answer, which is the whole point of the
  // sections filling in one at a time.
  const asked = [];
  await page.route('**/api/library?tab=*', async (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    asked.push(tab);
    if (tab === 'series') await new Promise((res) => setTimeout(res, 1500));
    const body = { live: LIVE, movies: MOVIES, series: SERIES }[tab];
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(body) });
  });
  await page.route('**/api/archive/**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/archive/status') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"indexed":3,"mounted":true}' });
    }
    if (url.pathname === '/api/archive/search') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ total: 1, items: [
          { path: '2008/Plain_Old_Tape.avi', title: 'Plain Old Tape', dir: '2008',
            date: '2008-01-01', duration: 1800, tags: [], playback: 'transcode',
            container: 'avi' }] }) });
    }
    if (url.pathname === '/api/archive/browse') {
      const dir = url.searchParams.get('dir') || '';
      if (!dir) {
        return r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ dir: '', subdirs: [{ dir: '2008', name: '2008', count: 2 }],
            items: [], total: 0 }) });
      }
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ dir, subdirs: [], total: 1, items: [
          { path: '2008/Plain_Old_Tape.avi', title: 'Plain Old Tape', dir: '2008',
            date: '2008-01-01', duration: 1800, tags: [], playback: 'transcode',
            container: 'avi' }] }) });
    }
    if (url.pathname === '/api/archive/play') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ mode: 'hls', url: '/api/fake-stream', format: 'm3u8',
          session: 'arc-1', prebuffer: 1, offset: 0, sourceDuration: 1800, subs: [] }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/remux**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/remux/status') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"seconds":99,"complete":true,"target":1,"failed":false,"error":""}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"session":"s1","url":"/api/fake-stream","prebuffer":1,"offset":0,"subs":[]}' });
  });
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'm3u8' }) }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  /* ---- one search, every library ---------------------------------------- */
  //
  // Standing on Live TV with only Live loaded: the other two have to be
  // fetched, and the page must not wait for them before showing anything.
  console.log('\n  searching from one tab, finding across all of them');
  await page.evaluate((live) => {
    state.config.mode = 'xtream';
    state.library = { live, movies: null, series: null };
    location.hash = '#/live';
    render();
  }, LIVE);
  await wait(400);

  await page.fill('#searchInput', 'plain');
  await wait(500);   // live is in hand; movies is quick; series is still out

  const early = await page.evaluate(() => ({
    title: document.querySelector('#contentTitle').textContent,
    sections: [...document.querySelectorAll('.search-section')].map((s) => ({
      tab: s.dataset.tab,
      head: s.querySelector('.search-head-title')?.textContent || '',
      note: s.querySelector('.search-head-note')?.textContent || '',
      cards: [...s.querySelectorAll('.card-title')].map((c) => c.textContent),
    })),
    loaderUp: !document.querySelector('#loader').hidden,
  }));
  console.log('   early:', JSON.stringify(early.sections));
  check('the page becomes a search, not a filtered tab',
    early.title === 'Search', early.title);
  check('with a section per library, in a fixed order',
    early.sections.map((s) => s.tab).join(',') === 'live,movies,series',
    JSON.stringify(early.sections.map((s) => s.tab)));
  check('the library already in hand answers immediately',
    early.sections[0].cards.join(',') === 'Plain Sports HD',
    JSON.stringify(early.sections[0]));
  check('and one still being fetched says so rather than looking empty',
    /searching/i.test(early.sections[2].note), early.sections[2].note);
  check('with no full-screen loader over results that are already showing',
    early.loaderUp === false, String(early.loaderUp));

  await wait(1800);
  const late = await page.evaluate(() => ({
    sections: [...document.querySelectorAll('.search-section')].map((s) => ({
      tab: s.dataset.tab,
      note: s.querySelector('.search-head-note')?.textContent || '',
      cards: [...s.querySelectorAll('.card-title')].map((c) => c.textContent),
    })),
  }));
  console.log('   late: ', JSON.stringify(late.sections));
  check('the slow one lands when it is ready',
    late.sections[2].cards.join(',') === 'Plainsong', JSON.stringify(late.sections[2]));
  check('films were found too, without opening the Movies tab',
    late.sections[1].cards.join(',') === 'The Plain Truth', JSON.stringify(late.sections[1]));
  check('everything that did not match is left out',
    !JSON.stringify(late.sections).includes('Unrelated')
    && !JSON.stringify(late.sections).includes('Other Channel'),
    JSON.stringify(late.sections));
  check('each section counts what it found', /1 match/.test(late.sections[0].note),
    late.sections[0].note);
  // Live was seeded as already-loaded, so the two that were NOT in hand are
  // the ones a search had to go and fetch by itself.
  check('the libraries that were not loaded were fetched by the search itself',
    asked.includes('movies') && asked.includes('series'), JSON.stringify(asked));

  // The drive is not in the sweep.
  check('the archive was NOT searched — it has its own page for that',
    !asked.includes('archive'), JSON.stringify(asked));

  // Searching from another tab gives the same answer, which is the point.
  await page.evaluate(() => { location.hash = '#/movies'; });
  await wait(600);
  await page.fill('#searchInput', 'plain');
  await wait(900);
  const fromMovies = await page.evaluate(() =>
    [...document.querySelectorAll('.search-section .card-title')].map((c) => c.textContent));
  console.log('   from Movies:', JSON.stringify(fromMovies));
  check('searching from Movies finds the channel and the show as well',
    fromMovies.includes('Plain Sports HD') && fromMovies.includes('Plainsong'),
    JSON.stringify(fromMovies));

  // Nothing at all is said plainly.
  await page.fill('#searchInput', 'zzzznothing');
  await wait(1000);
  const none = await page.evaluate(() => ({
    empty: document.querySelector('#emptyState').hidden
      ? '' : document.querySelector('#emptyState').textContent,
    cards: document.querySelectorAll('.search-section .card').length,
  }));
  console.log('   nothing:', JSON.stringify(none));
  check('a search with no answer says so', /Nothing matches/.test(none.empty), none.empty);
  check('and points at where the drive is searched instead',
    /Archive page/.test(none.empty), none.empty);
  check('with no stray cards left behind', none.cards === 0, String(none.cards));

  // Clearing the box puts the tab back.
  await page.fill('#searchInput', '');
  await wait(700);
  const cleared = await page.evaluate(() => ({
    sections: document.querySelectorAll('.search-section').length,
    title: document.querySelector('#contentTitle').textContent,
  }));
  check('clearing it returns to the tab you were on',
    cleared.sections === 0 && cleared.title === 'Movies', JSON.stringify(cleared));

  /* ---- the archive keeps its own search --------------------------------- */
  console.log('\n  the drive is searched from the drive');
  await page.evaluate(() => { location.hash = '#/archive'; });
  await page.waitForTimeout(1200);
  await page.fill('#searchInput', 'plain');
  await wait(800);
  const onArchive = await page.evaluate(() => ({
    archiveShown: !document.querySelector('#archiveView').hidden,
    sections: document.querySelectorAll('.search-section').length,
    crumb: [...document.querySelectorAll('#archiveCrumbs .crumb')]
      .map((c) => c.textContent).join('|'),
  }));
  console.log('   ', JSON.stringify(onArchive));
  check('on the Archive page a search stays on the Archive page',
    onArchive.archiveShown && onArchive.sections === 0, JSON.stringify(onArchive));
  check('and searches the drive', /Search results/.test(onArchive.crumb), onArchive.crumb);

  /* ---- multi-view: the drive, and Recent that works --------------------- */
  console.log('\n  multi-view');
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(600);
  await page.evaluate(() => { $('#searchInput').value = ''; state.query = ''; render(); });
  await page.locator('#multiviewBtn').click();
  await wait(600);

  const sources = await page.evaluate(() =>
    [...document.querySelectorAll('#mvSourceSeg button')]
      .filter((b) => b.style.display !== 'none')
      .map((b) => b.dataset.source));
  console.log('   sources:', JSON.stringify(sources));
  check('the picker offers the drive as a source', sources.includes('archive'),
    JSON.stringify(sources));

  await page.evaluate(() => {
    // Picking is normally begun by tapping an empty cell; this is that state.
    multiview.picking = 0;
    return multiview.setSource('archive');
  });
  await wait(900);
  const folders = await page.evaluate(() => ({
    title: document.querySelector('#mvPickerTitle').textContent,
    tiles: [...document.querySelectorAll('#mvResults .card-title')].map((t) => t.textContent),
  }));
  console.log('   folders:', JSON.stringify(folders));
  check('it opens on the drive\'s folders', folders.tiles.includes('2008'),
    JSON.stringify(folders));

  await page.evaluate(() => {
    [...document.querySelectorAll('#mvResults .card')]
      .find((c) => /2008/.test(c.textContent))?.click();
  });
  await wait(900);
  const files = await page.evaluate(() =>
    [...document.querySelectorAll('#mvResults .card-title')].map((t) => t.textContent));
  console.log('   files:  ', JSON.stringify(files));
  check('opening a folder lists what is in it', files.includes('Plain Old Tape'),
    JSON.stringify(files));

  // And picking one really plays it in the cell.
  await page.evaluate(() => {
    [...document.querySelectorAll('#mvResults .card')]
      .find((c) => /Plain Old Tape/.test(c.textContent))?.click();
  });
  await wait(2500);
  const playing = await page.evaluate(() => ({
    name: multiview.cells[0].name.textContent,
    note: multiview.cells[0].note.hidden ? '' : multiview.cells[0].note.textContent,
    src: multiview.cells[0].video.currentSrc,
  }));
  console.log('   cell:   ', JSON.stringify(playing));
  check('picking one puts it in the cell', /Plain Old Tape/.test(playing.name), playing.name);
  check('and it is really playing, not stuck on a message',
    playing.src.includes('fake-stream'), JSON.stringify(playing));

  // The bug: an archive title picked out of Recent.
  console.log('\n  an archive title in Recent');
  const recent = await page.evaluate(async () => {
    state.recentlyWatched = [{ kind: 'movie', id: 'archive:2008/Plain_Old_Tape.avi',
      name: 'Plain Old Tape', key: 'archive:2008/Plain_Old_Tape.avi', poster: '' }];
    multiview.stop(0);
    multiview.picking = 0;
    await multiview.setSource('recent');
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#mvResults .card')?.click();
    await new Promise((r) => setTimeout(r, 2500));
    return {
      note: multiview.cells[0].note.hidden ? '' : multiview.cells[0].note.textContent,
      name: multiview.cells[0].name.textContent,
      src: multiview.cells[0].video.currentSrc,
    };
  });
  console.log('   ', JSON.stringify(recent));
  check('it never says a file on the drive is "no longer in the library"',
    !/no longer in the library/i.test(recent.note), recent.note);
  check('it plays', recent.src.includes('fake-stream'), JSON.stringify(recent));

  /* ---- and the source of it -------------------------------------------- */
  check('Recent has a branch for archive rows at all',
    /startRecent\(row\) \{[\s\S]{0,700}archive:/.test(APP), 'no archive branch in startRecent');
  check('and a cell resolves one through the archive endpoint',
    /if \(item\.archivePath\) \{[\s\S]{0,400}\/api\/archive\/play/.test(APP));

  /* ---- and from the landing page, which is where you already are -------- */
  //
  // "Homepage search doesn't produce anything." Home was not among the pages
  // a search ran from, so typing there set the query, painted the landing
  // page again, and showed nothing — the one page somebody is most likely to
  // be standing on when a title occurs to them was the one page that could
  // not go and look for it.
  console.log('\n  searching from the landing page');
  await page.evaluate(() => {
    state.config.mode = 'xtream';
    location.hash = '#/home';
  });
  await wait(700);
  const homeFirst = await page.evaluate(() => ({
    home: !document.querySelector('#homeView').hidden,
    grid: !document.querySelector('#grid').hidden,
  }));
  check('the landing page is what is showing to begin with',
    homeFirst.home && !homeFirst.grid, JSON.stringify(homeFirst));

  await page.fill('#searchInput', 'plain');
  await wait(1200);
  const fromHome = await page.evaluate(() => ({
    home: !document.querySelector('#homeView').hidden,
    title: document.querySelector('#contentTitle').textContent,
    sections: [...document.querySelectorAll('#grid .search-section')].map((s) => s.dataset.tab),
    cards: [...document.querySelectorAll('#grid .search-cards > *')]
      .map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
    wide: !document.querySelector('#wideSearchBtn').hidden,
  }));
  console.log('   ', JSON.stringify(fromHome));
  check('typing there produces a search rather than the landing page again',
    fromHome.home === false && fromHome.title === 'Search', JSON.stringify(fromHome));
  check('across all three libraries, the same as everywhere else',
    JSON.stringify(fromHome.sections) === JSON.stringify(['live', 'movies', 'series']),
    JSON.stringify(fromHome.sections));
  check('and it finds the channel, the film and the show',
    fromHome.cards.join(' | ').includes('Plain Sports HD')
    && fromHome.cards.join(' | ').includes('The Plain Truth')
    && fromHome.cards.join(' | ').includes('Plainsong'), JSON.stringify(fromHome.cards));
  check('with All languages offered here too', fromHome.wide === true,
    JSON.stringify(fromHome));

  await page.fill('#searchInput', '');
  await wait(900);
  const backHome = await page.evaluate(() => ({
    home: !document.querySelector('#homeView').hidden,
    grid: !document.querySelector('#grid').hidden,
    wide: !document.querySelector('#wideSearchBtn').hidden,
  }));
  console.log('   ', JSON.stringify(backHome));
  check('and clearing it puts the landing page back',
    backHome.home && !backHome.grid && !backHome.wide, JSON.stringify(backHome));

  /* ---- and a section that has more than it shows says so ---------------- */
  //
  // "On search it will only show 60 movies at a time which is fine, add an
  // option to expand to see all things in the search." A cap that cannot be
  // lifted hides the answer somewhere below the line.
  console.log('\n  more than one section can hold');
  const MANY = { categories: [], items: Array.from({ length: 145 }, (_, i) => ({
    kind: 'movie', id: 9000 + i, name: `Plain Number ${i}`, categoryId: 'm1' })) };
  const capped = await page.evaluate((many) => {
    state.config.mode = 'xtream';
    state.library = { live: { categories: [], items: [] }, movies: many,
      series: { categories: [], items: [] } };
    state.tab = 'movies';
    state.movieId = '';
    state.query = 'plain number';
    render();
    const slot = [...document.querySelectorAll('#grid .search-section')]
      .find((s) => s.dataset.tab === 'movies');
    return { shown: slot.querySelectorAll('.search-cards > *').length,
      note: slot.querySelector('.search-head-note')?.textContent || '',
      button: slot.querySelector('.search-more')?.textContent || '' };
  }, MANY);
  console.log('   ', JSON.stringify(capped));
  check('a big answer is capped so the page stays usable',
    capped.shown === 60, String(capped.shown));
  check('and the heading says how many there really are',
    /145 matches/.test(capped.note), capped.note);
  check('with a button offering the rest, counted',
    /Show all 145/.test(capped.button), capped.button);

  // Pressed through the DOM: multi-view is left open by an earlier section of
  // this suite and sits over the page.
  await page.evaluate(() => document.querySelector(
    '.search-section[data-tab="movies"] .search-more')?.click());
  await wait(400);
  const opened = await page.evaluate(() => {
    const slot = [...document.querySelectorAll('#grid .search-section')]
      .find((s) => s.dataset.tab === 'movies');
    return { shown: slot.querySelectorAll('.search-cards > *').length,
      button: slot.querySelector('.search-more') ? 'still there' : '' };
  });
  console.log('   ', JSON.stringify(opened));
  check('pressing it draws the lot', opened.shown === 145, String(opened.shown));
  check('and the button goes, having nothing left to offer',
    opened.button === '', opened.button);

  const small = await page.evaluate(() => {
    state.query = 'plain number 7';
    render();
    const slot = [...document.querySelectorAll('#grid .search-section')]
      .find((s) => s.dataset.tab === 'movies');
    return { shown: slot.querySelectorAll('.search-cards > *').length,
      button: slot.querySelector('.search-more') ? 'there' : '' };
  });
  console.log('   ', JSON.stringify(small));
  check('a section that fits offers no button at all',
    small.shown > 0 && small.shown <= 60 && small.button === '', JSON.stringify(small));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
