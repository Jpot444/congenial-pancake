/**
 * Searching by the words you remember, not the ones you can spell in order.
 *
 * "I want to expand the search function to find things more relevantly, even
 * if it pulls some more things that I am not looking for. If I am searching a
 * few words in the title I want to see it, even if it is not the start of the
 * title."
 *
 * It used to be one contiguous substring. "dark knight" found The Dark Knight
 * and "knight dark" found nothing; "batman knight" found nothing either, for a
 * film with both words in its name. Typing a few half-remembered words is the
 * normal way to look for something, and it was the one way that did not work.
 *
 * Widening it is easy and on its own would be useless — every word anywhere
 * matches a great many titles. The ranking is the feature: be generous, then
 * put the obvious answer first.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const FILMS = [
  'The Dark Knight (2008)',
  'The Dark Knight Rises (2012)',
  'Batman Begins (2005)',
  'Batman v Superman: Dawn of Justice',
  'Knight and Day',
  'A Knights Tale',
  'Dune (2021)',
  'Dune: Part Two Behind The Scenes Featurette',
  'Manhattan (1979)',
  'Spider Man: No Way Home',
  'Trading Places (1983)',
  'Places in the Heart',
].map((name, i) => ({ kind: 'movie', id: 100 + i, name, categoryId: 'c1' }));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  const search = (q) => page.evaluate((args) =>
    rankedMatches(args.films, args.q).map((i) => i.name), { films: FILMS, q });

  console.log('\n  words in any order');
  const reversed = await search('knight dark');
  console.log('   ', JSON.stringify(reversed.slice(0, 3)));
  check('backwards still finds it', reversed[0] === 'The Dark Knight (2008)',
    JSON.stringify(reversed));
  check('and the sequel comes with it',
    reversed.includes('The Dark Knight Rises (2012)'), JSON.stringify(reversed));
  check('while a film with only one of the words is left out',
    !reversed.includes('Knight and Day'), JSON.stringify(reversed));

  console.log('\n  words that are not next to each other in the title');
  const apart = await search('batman justice');
  console.log('   ', JSON.stringify(apart));
  check('a word from each end of the title still finds it',
    apart[0] === 'Batman v Superman: Dawn of Justice', JSON.stringify(apart));

  console.log('\n  not the start of the title');
  const middle = await search('places');
  console.log('   ', JSON.stringify(middle));
  check('a word in the middle of one title and the start of another finds both',
    middle.includes('Trading Places (1983)')
    && middle.includes('Places in the Heart'), JSON.stringify(middle));

  console.log('\n  and the obvious answer is first');
  const dune = await search('dune');
  console.log('   ', JSON.stringify(dune));
  check('the short exact one outranks the long one it is buried in',
    dune[0] === 'Dune (2021)', JSON.stringify(dune));

  const phrase = await search('dark knight');
  console.log('   ', JSON.stringify(phrase.slice(0, 2)));
  check('the whole phrase at the front beats the same phrase plus more',
    phrase[0] === 'The Dark Knight (2008)', JSON.stringify(phrase));

  const man = await search('man');
  console.log('   ', JSON.stringify(man));
  check('a word at the start of a word beats one buried inside one',
    man.indexOf('Spider Man: No Way Home') < man.indexOf('Manhattan (1979)')
    || !man.includes('Manhattan (1979)'), JSON.stringify(man));
  check('though the buried one is still offered, being generous on purpose',
    man.includes('Manhattan (1979)'), JSON.stringify(man));

  console.log('\n  and the things that must not change');
  check('an accent is still no obstacle', (await page.evaluate(() =>
    rankedMatches([{ name: 'Le Fabuleux Destin d’Amélie Poulain' }], 'amelie poulain')
      .length)) === 1);
  check('nothing matches an empty query',
    (await search('')).length === 0 && (await search('   ')).length === 0);
  check('and a word in no title finds nothing',
    (await search('zzzz')).length === 0);
  check('punctuation typed in the query is not taken literally',
    (await search('batman: justice'))[0] === 'Batman v Superman: Dawn of Justice');

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
