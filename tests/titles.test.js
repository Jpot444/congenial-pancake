/**
 * Titles without the provider's prefixes, and the two numbers worth showing.
 *
 * "I want to remove the parts that proceed the title like 'MAX -' '4K-MAX-'
 * 'EN -' and only have it be the title. Anything that follows the title, like
 * the year (2003) or country (TR) are ok to keep. ... if something is 4K I
 * want to see that card with a little 4K logo. Also add to the card how big
 * movie files are, for series if I am hovering over an episode the GB size
 * should appear next to the download button."
 *
 * The stripping is a LIST rather than a shape, and that is the whole care in
 * it: "any short capitalised run before a dash" would also eat "IT - Chapter
 * Two" and "US - Us", which are films. Everything on the list is a language,
 * a country, a quality or a studio, and nothing on it is a film.
 */
const fs = require('fs');
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- the cleaner itself, lifted from the shipped server ----------------- */
const src = fs.readFileSync(PATHS.SERVER, 'utf8');
const slice = src.slice(src.indexOf('const TITLE_TAGS'), src.indexOf('function projectItem'));
const { cleanTitle, isUhd } = new Function(`${slice}; return { cleanTitle, isUhd };`)();

console.log('  what comes off the front');
const cases = [
  ['4K-MAX- Trading Places (1983)', 'Trading Places (1983)', true],
  ['EN - The Batman', 'The Batman', false],
  ['MAX - Succession', 'Succession', false],
  ['FR | Amélie (2001)', 'Amélie (2001)', false],
  ['4K - UHD - Dune (2021)', 'Dune (2021)', true],
  ['EN - US - Some Film 4K', 'Some Film 4K', true],
  ['TR - Kurtlar Vadisi (TR)', 'Kurtlar Vadisi (TR)', false],
  ['NF: Stranger Things', 'Stranger Things', false],
];
for (const [raw, want, uhd] of cases) {
  const got = cleanTitle(raw);
  check(`${JSON.stringify(raw)} → ${JSON.stringify(want)}`, got === want, got);
  check(`  and 4K reads ${uhd}`, isUhd(raw) === uhd, String(isUhd(raw)));
}

console.log('\n  the newer shapes, which no list had thought of');
// "Some pre title things are still visible like A+ - AMZ - D+ - I want all of
// them gone." A list can only ever remove prefixes somebody has already met;
// these arrive with every provider reshuffle. So a shape backs the list up:
// short, shouted, written the way codes are written.
for (const [raw, want] of [
  ['A+ - The Studio', 'The Studio'],
  ['AMZ - Reacher', 'Reacher'],
  ['D+ - Andor', 'Andor'],
  ['A+ - AMZ - Something', 'Something'],
  ['PMTP - Yellowstone', 'Yellowstone'],
]) {
  check(`${JSON.stringify(raw)} → ${JSON.stringify(want)}`,
    cleanTitle(raw) === want, cleanTitle(raw));
}
// The one that stays, because it is not filing — it is a warning, and a
// household box that quietly removed it would be doing nobody a favour.
check('XXX is kept, being the one prefix that is not filing',
  cleanTitle('XXX - Adult Film') === 'XXX - Adult Film', cleanTitle('XXX - Adult Film'));

console.log('\n  and what is left alone');
// The year, the country, anything AFTER the title: information, not noise.
check('a trailing year survives', cleanTitle('EN - Alien (1979)') === 'Alien (1979)');
check('and a trailing country', cleanTitle('Kurtlar Vadisi (TR)') === 'Kurtlar Vadisi (TR)');
// Films whose real names look like tags. This is why the list is a list.
// Words, not codes: these are not shouted, so the shape rule leaves them.
// "IT - Chapter Two" is NOT among them any more — a two-letter capital before
// a dash is indistinguishable from a filing code, and losing that one is the
// trade that was asked for when the answer was "I want all of them gone".
for (const real of ['Us (2019)', 'Mission - Impossible',
  'Frost - Nixon', 'Sicario - Day of the Soldado', 'Bytta roller/Trading Places']) {
  check(`a real title is not eaten: ${JSON.stringify(real)}`,
    cleanTitle(real) === real, cleanTitle(real));
}
check('a name made only of tags is handed back rather than emptied',
  cleanTitle('MAX -') === 'MAX -', cleanTitle('MAX -'));
check('and junk does not throw', cleanTitle(null) === '' && cleanTitle(undefined) === '');

/* ---- the badge and the sizes, in the page ------------------------------- */
const MOVIES = [
  { kind: 'movie', id: 11, name: 'Trading Places (1983)', uhd: true, ext: 'mkv', categoryId: 'c1' },
  { kind: 'movie', id: 12, name: 'Something Ordinary', uhd: false, ext: 'mp4', categoryId: 'c1' },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/xtream*', (r) => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('action') === 'get_vod_info') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        // No `size` at all, only a bitrate and a runtime — which is what most
        // panels give, and is the case the estimate exists for.
        body: JSON.stringify({ info: { releasedate: '1983-06-08', genre: 'Comedy',
          duration: '01:56:00', duration_secs: 6960, bitrate: 24000 } }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ info: {}, episodes: { 1: [
        { id: 5001, episode_num: 1, title: 'One', container_extension: 'mkv',
          info: { size: 2_684_354_560 } },
        { id: 5002, episode_num: 2, title: 'Two', container_extension: 'mkv',
          info: { bitrate: 4000, duration: '00:45:00' } },
        { id: 5003, episode_num: 3, title: 'Three', container_extension: 'mkv', info: {} },
      ] } }) });
  });
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  console.log('\n  the 4K mark on a card');
  const badges = await page.evaluate((movies) => {
    state.config.mode = 'xtream';
    state.library.movies = { categories: [{ id: 'c1', name: 'Films' }], items: movies };
    state.tab = 'movies';
    state.movieId = '';
    state.category = 'c1';
    state.query = '';
    render();
    return [...document.querySelectorAll('#grid .card')].map((c) => ({
      title: c.querySelector('.card-title')?.textContent || '',
      uhd: c.querySelector('.badge.uhd')?.textContent || '',
    }));
  }, MOVIES);
  console.log('   ', JSON.stringify(badges));
  check('the 4K one is marked', badges[0]?.uhd === '4K', JSON.stringify(badges[0]));
  check('and the ordinary one is not', badges[1]?.uhd === '', JSON.stringify(badges[1]));
  check('with the title itself untouched by the mark',
    badges[0]?.title === 'Trading Places (1983)', badges[0]?.title);

  /* A film has its own page now rather than the card a show gets, so these
     facts have moved: the meta line under the title carries the runtime, the
     year, the genre and the size, and what the file IS has a strip of its
     own. The claims are the same claims. */
  console.log('\n  how big the film is, on its own page');
  await page.evaluate(() => { location.hash = '#/movies/11'; });
  await page.waitForFunction(
    () => /GB|MB/.test(document.querySelector('.film-meta')?.textContent || ''),
    null, { timeout: 8000 }).catch(() => {});
  const card = await page.evaluate(() => ({
    meta: document.querySelector('.film-meta')?.textContent || '',
    badge: document.querySelector('.film-poster-badge')?.textContent || '',
    specs: [...document.querySelectorAll('.film-spec')].map((c) => c.textContent).join(' | '),
  }));
  console.log('   ', JSON.stringify(card));
  // 24000 kbps over 6960s is 20.9 GB — an estimate, and the right order.
  check('the size is on the meta line', /\d+(\.\d+)? GB/.test(card.meta), card.meta);
  check('beside the year and genre it already had',
    /1983/.test(card.meta) && /Comedy/.test(card.meta), card.meta);
  check('and again in the file strip, with the bitrate it was estimated from',
    /\d+(\.\d+)? GB/.test(card.specs) && /Mbps/.test(card.specs), card.specs);
  check('4K is said on the poster, where the quality badge lives',
    /4K/.test(card.badge), card.badge);
  check('with the runtime on the meta line', /1:56/.test(card.meta), card.meta);

  console.log('\n  and how big an episode is, beside its download button');
  const eps = await page.evaluate(() => {
    state.library.series = { categories: [{ id: 's1', name: 'Shows' }],
      items: [{ kind: 'series', id: 77, name: 'A Show', categoryId: 's1' }] };
    state.movieId = '';
    location.hash = '#/series/77';
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.show-card .ep').length >= 3, null, { timeout: 10000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll('.show-card .ep')]
    .map((r) => ({
      name: r.querySelector('.ep-name')?.textContent || '',
      size: r.querySelector('.ep-size')?.textContent || '',
      // The button must still be the last thing in the row.
      last: r.lastElementChild?.className || '',
    })));
  console.log('   ', JSON.stringify(rows));
  check('a stated size is shown as given', rows[0]?.size === '2.50 GB', rows[0]?.size);
  check('and one with only a bitrate is estimated rather than left blank',
    /MB|GB/.test(rows[1]?.size || ''), rows[1]?.size);
  check('while an episode the provider says nothing about shows nothing',
    rows[2]?.size === '', rows[2]?.size);
  check('and the download button is still the last thing in the row',
    rows.every((r) => /ep-dl/.test(r.last)), JSON.stringify(rows.map((r) => r.last)));

  // Hidden until the row is under the cursor — it is only ever read as part
  // of deciding whether to press the button next to it.
  const hover = await page.evaluate(() => {
    const row = document.querySelector('.show-card .ep');
    const before = getComputedStyle(row.querySelector('.ep-size')).opacity;
    return { before };
  });
  console.log('   ', JSON.stringify(hover));
  check('it waits for the hover rather than sitting there',
    hover.before === '0', hover.before);
  await page.locator('.show-card .ep').first().hover();
  await wait(300);
  const shown = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.show-card .ep .ep-size')).opacity);
  check('and appears on it', shown === '1', shown);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
