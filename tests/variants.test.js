/**
 * One card per title, with a switch between the copies of it.
 *
 * "Some series and movies have a 4k version and versions that exist repeat
 * times because they are in different categories. I want all titles that are
 * the exact same to show up as one card ... but then a tab at the top to
 * switch between 4k, EN, MAX or whatever the category is."
 *
 * And the boundary, in the user's own example, which is the whole difficulty:
 *
 *   NL - Trading Places            ┐
 *   4K - Trading Places            ├ one card, three copies
 *   SC - Trading Places            ┘
 *   SC - Bytta roller/Trading Places   a different film with a different name
 *   NF - Trading Places (2023)         a different film with the same name
 *
 * So: an exact match on the cleaned title, year and all. Anything looser
 * merges the 2023 remake into the 1983 film.
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

/* ---- what the box makes of the provider's names ------------------------- */
const src = fs.readFileSync(PATHS.SERVER, 'utf8');
const { splitTitle } = new Function(
  `${src.slice(src.indexOf('const TITLE_TAGS'), src.indexOf('function projectItem'))}
   ; return { splitTitle };`)();

console.log('  the provider\'s five rows, as the box reads them');
const RAW = [
  'NL - Trading Places',
  '4K - Trading Places',
  'SC - Trading Places',
  'SC - Bytta roller/Trading Places',
  'NF - Trading Places (2023)',
];
for (const raw of RAW) console.log('   ', raw.padEnd(34), JSON.stringify(splitTitle(raw)));
check('the three copies come out with one name between them',
  RAW.slice(0, 3).every((r) => splitTitle(r).name === 'Trading Places'));
check('and each keeps the tag that tells it from the others',
  RAW.slice(0, 3).map((r) => splitTitle(r).tags.join('')).join(',') === 'NL,4K,SC');
check('the Norwegian retitling keeps its own name',
  splitTitle(RAW[3]).name === 'Bytta roller/Trading Places', splitTitle(RAW[3]).name);
check('and the remake keeps its year, which is what tells it apart',
  splitTitle(RAW[4]).name === 'Trading Places (2023)', splitTitle(RAW[4]).name);

/* ---- and what the grid does with them ----------------------------------- */
const ITEMS = RAW.map((raw, i) => {
  const s = splitTitle(raw);
  return { kind: 'movie', id: 200 + i, name: s.name, tag: s.tags.join(' '),
    uhd: /4K/.test(raw), ext: 'mkv', categoryId: `c${i}` };
});
const CATS = ITEMS.map((it, i) => ({ id: `c${i}`, name: `Category ${i}` }));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ info: { releasedate: '1983', genre: 'Comedy' } }) }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  await page.evaluate((args) => {
    state.config.mode = 'xtream';
    state.library.movies = { categories: args.cats, items: args.items };
  }, { items: ITEMS, cats: CATS });

  console.log('\n  the grid');
  const grid = await page.evaluate(() => {
    state.tab = 'movies';
    state.movieId = '';
    state.category = null;
    state.query = 'trading';
    render();
    return [...document.querySelectorAll('#grid .card .card-title')].map((t) => t.textContent);
  });
  console.log('   ', JSON.stringify(grid));
  check('three copies of one film become one card',
    grid.filter((t) => t === 'Trading Places').length === 1, JSON.stringify(grid));
  check('the differently-named film keeps its own card',
    grid.includes('Bytta roller/Trading Places'), JSON.stringify(grid));
  check('and so does the remake, which only shares a name',
    grid.includes('Trading Places (2023)'), JSON.stringify(grid));
  check('so five rows become three cards', grid.length === 3, JSON.stringify(grid));

  console.log('\n  the switcher on the card');
  await page.evaluate(() => { state.query = ''; location.hash = '#/movies/200'; });
  await page.waitForFunction(() => document.querySelector('.variant-pick .variant-chip'),
    null, { timeout: 8000 });
  const chips = await page.evaluate(() => ({
    title: document.querySelector('.show-title')?.textContent,
    chips: [...document.querySelectorAll('.variant-chip')].map((c) => ({
      label: c.textContent, on: c.classList.contains('is-active') })),
  }));
  console.log('   ', JSON.stringify(chips));
  check('the card names the film, not the copy', chips.title === 'Trading Places',
    chips.title);
  check('with one tab per copy and no more', chips.chips.length === 3,
    JSON.stringify(chips.chips));
  check('labelled by the tag the provider put in front of the title',
    chips.chips.map((c) => c.label.replace('4K', '')).join(',') === 'NL,,SC',
    JSON.stringify(chips.chips.map((c) => c.label)));
  check('the one being shown is marked as such',
    chips.chips.filter((c) => c.on).length === 1 && chips.chips[0].on,
    JSON.stringify(chips.chips));

  console.log('\n  and pressing one switches copy');
  await page.evaluate(() => [...document.querySelectorAll('.variant-chip')]
    .find((c) => /SC/.test(c.textContent))?.click());
  await wait(900);
  const after = await page.evaluate(() => ({
    hash: location.hash,
    title: document.querySelector('.show-title')?.textContent,
    on: [...document.querySelectorAll('.variant-chip')]
      .filter((c) => c.classList.contains('is-active')).map((c) => c.textContent),
  }));
  console.log('   ', JSON.stringify(after));
  check('it opens that copy', after.hash === '#/movies/202', after.hash);
  check('the title does not change, because the film has not',
    after.title === 'Trading Places', after.title);
  check('and the switcher follows', JSON.stringify(after.on) === '["SC"]',
    JSON.stringify(after.on));

  console.log('\n  a film sold only once gets no switcher');
  await page.evaluate(() => { location.hash = '#/movies/203'; });
  await wait(900);
  const lone = await page.evaluate(() => ({
    title: document.querySelector('.show-title')?.textContent,
    chips: document.querySelectorAll('.variant-chip').length,
  }));
  console.log('   ', JSON.stringify(lone));
  check('no tabs where there is nothing to choose', lone.chips === 0,
    JSON.stringify(lone));
  check('and it is the film it says it is',
    lone.title === 'Bytta roller/Trading Places', lone.title);

  console.log('\n  and the 4K copy leads the card');
  const lead = await page.evaluate(() => {
    const grouped = groupVariants(state.library.movies.items);
    const card = grouped.find((g) => g.name === 'Trading Places');
    return { uhd: card.uhd, id: card.id, count: card.variants.length };
  });
  console.log('   ', JSON.stringify(lead));
  check('the best copy is the one the card shows', lead.uhd === true && lead.id === 201,
    JSON.stringify(lead));
  check('with all three still held behind it', lead.count === 3, String(lead.count));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
