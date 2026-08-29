/**
 * The Shield's slate — the same scoreboard the portal draws, at ten feet.
 *
 * The television had the first version of this row and then fell behind it:
 * the portal grew club marks, a diamond and a count, a field with the ball on
 * it, probable pitchers, and a switch between three sports, and the Shield was
 * still drawing three lines of text per card. This is that gap closed, and
 * what it asserts is the part that could go wrong in the move rather than the
 * part that was already proven on the desktop.
 *
 * The two claims worth the most:
 *
 *   THE SWITCH IS REACHABLE WITH A D-PAD. The portal's is a mouse target; the
 *   television has four arrows and an OK, and a control nobody can reach is
 *   not a control. It sits between the navigation and the games so ▲ from the
 *   first card finds it, and the setting it writes is the profile's own — the
 *   same one the portal reads, so a switch thrown here is thrown there.
 *
 *   THE COLLEGE GRID DOES NOT EAT THE ROWS BELOW IT. A Saturday wraps into
 *   ten lines of games, each its own focus row, sitting between the games row
 *   and the channels. Numbered carelessly they would land on top of the
 *   channels and the categories, and ▼ off the last game would go somewhere
 *   nobody meant.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const LOGO = `${BASE}/bison.png`;

const LIVE = {
  categories: [
    { id: 'c1', name: 'USA MLB' },
    { id: 'c2', name: 'USA NCAAF' },
  ],
  items: [
    { kind: 'live', id: 301, num: 301, name: 'US| MLB 01 | ROCKIES X NATIONALS',
      logo: LOGO, categoryId: 'c1' },
    { kind: 'live', id: 302, num: 302, name: 'US| FOX ᴴᴰ', logo: LOGO, categoryId: 'c1' },
    { kind: 'live', id: 401, num: 401, name: 'US| NCAAF 07 | ALABAMA X GEORGIA',
      logo: LOGO, categoryId: 'c2' },
  ],
  totals: { items: 3 },
};

const PREFS = {
  favorites: [], pinnedCategories: [], deletedItems: [], deletedCategories: [],
  owner: true, scoreSport: 'mlb',
};

/* One of each, so every shape the card can take is on screen at once. */
const SCORES = {
  games: [
    { id: 'col-was', sport: 'mlb', status: 'live', channelMatch: 'MLB NETWORK',
      channelName: 'MLB Network', teamMatch: ['Rockies', 'Nationals'],
      away: { abbr: 'COL', logo: LOGO, record: '60-70', score: 6 },
      home: { abbr: 'WSH', logo: LOGO, record: '58-72', score: 1 },
      clock: 'Top 9th',
      onBase: { first: true, second: false, third: true },
      count: { balls: 2, strikes: 1, outs: 1 },
      situation: '1 out · 1st & 3rd · 2-1' },
    { id: 'bos-oak', sport: 'mlb', status: 'upcoming', channelMatch: 'FOX',
      channelName: 'FOX', teamMatch: ['Red Sox', 'Athletics'], warmup: true,
      away: { abbr: 'BOS', logo: LOGO, record: '70-60', score: null,
        pitcher: { last: 'De La Rosa', wins: 2, losses: 2, era: '2.84' } },
      home: { abbr: 'OAK', logo: LOGO, record: '65-65', score: null,
        pitcher: { last: 'Chavez', wins: 6, losses: 4, era: '2.93' } },
      clock: '4:05 PM', kickoff: Date.now() + 20 * 60000 },
    { id: 'chi-gb', sport: 'nfl', status: 'live', channelMatch: 'FOX',
      channelName: 'FOX', teamMatch: ['Bears', 'Packers'],
      away: { abbr: 'CHI', logo: LOGO, record: '4-6', score: 17, possession: true },
      home: { abbr: 'GB', logo: LOGO, record: '8-2', score: 13 },
      clock: 'Q2 · 4:22',
      drive: { down: 3, distance: 7, text: '3rd & 7', spot: 'GB 41',
        yardLine: 59, driving: 'right', redZone: false } },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `cfb-${i}`, sport: 'ncaaf', status: 'live', channelMatch: 'CBS',
      channelName: 'CBS', teamMatch: ['Alabama', 'Georgia'],
      away: { abbr: 'ALA', logo: LOGO, record: '9-1', score: 21 },
      home: { abbr: 'UGA', logo: LOGO, record: '10-0', score: 24 },
      clock: 'Q3 · 7:15',
      drive: { down: 1, distance: 10, text: '1st & 10', spot: 'ALA 30',
        yardLine: 30, driving: 'left', redZone: false },
    })),
  ],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  await page.route('**/api/scores**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SCORES) }));
  let saved = null;
  await page.route('**/api/profiles/*/prefs', (r) => {
    if (r.request().method() === 'PUT') {
      saved = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREFS) });
  });

  await page.goto(`${BASE}/tv/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);

  /* ---- baseball, the shape it arrives in ------------------------------- */
  console.log('\n  the baseball slate');
  const mlb = await page.evaluate(() => ({
    sport: document.querySelector('.sportchip.on')?.dataset.sport,
    chips: [...document.querySelectorAll('.sportchip')].map((c) => c.dataset.sport),
    cards: [...document.querySelectorAll('.game')].map((c) => ({
      score: c.querySelector('.game-score')?.textContent ?? null,
      half: c.querySelector('.game-half')?.textContent ?? null,
      marks: c.querySelectorAll('.game-mark img').length,
      diamond: [...c.querySelectorAll('.game-diamond i')]
        .map((b) => (b.classList.contains('on') ? '1' : '0')).join(''),
      count: [...c.querySelectorAll('.game-countrow')]
        .map((r) => `${r.querySelector('b').textContent}${r.querySelectorAll('i.on').length}`)
        .join(','),
      field: Boolean(c.querySelector('.game-field')),
      start: c.querySelector('.game-start')?.textContent ?? null,
      warmup: c.querySelector('.game-warmup')?.textContent ?? null,
      starters: [...c.querySelectorAll('.game-starter')].map((p) => p.textContent.trim()),
    })),
  }));
  console.log('   mlb:', JSON.stringify(mlb, null, 1));

  check('the switch offers all three sports',
    mlb.chips.join(',') === 'nfl,mlb,ncaaf', JSON.stringify(mlb.chips));
  check('and says which one is showing', mlb.sport === 'mlb', mlb.sport);
  /* Two baseball games on the slate; the football and college ones are
     behind the switch, not on the screen. */
  check('only the chosen sport is on the row', mlb.cards.length === 2,
    String(mlb.cards.length));

  const [playing, soon] = mlb.cards;
  check('a club is its own mark, not its initials', playing.marks === 2, String(playing.marks));
  check('with the score between the two of them', playing.score === '6 - 1', playing.score);
  check('and the half-inning under it', playing.half === 'Top 9th', playing.half);
  /* Second, third, first — the diamond as it is seen from behind the plate. */
  check('the diamond is lit where the runners are', playing.diamond === '011', playing.diamond);
  check('and the count is the count', playing.count === 'B2,S1,O1', playing.count);

  check('a game about to start shows its first pitch',
    soon.start === '4:05 PM' && soon.score === null, JSON.stringify([soon.start, soon.score]));
  check('and WARMUP when the league says the broadcast is up',
    soon.warmup === 'WARMUP', soon.warmup);
  check('with the two probables, record and ERA',
    soon.starters.join(' | ') === 'BOSDe La Rosa (2-2, 2.84) | OAKChavez (6-4, 2.93)',
    JSON.stringify(soon.starters));

  /* ---- the switch, driven the way a television drives it ---------------- */
  console.log('\n  reaching the switch with the D-pad alone');
  const reach = await page.evaluate(() => {
    /* Down from the navigation, which is where the app opens, and the next
       row down has to be the switch rather than the games. */
    const rows = [...document.querySelectorAll('[data-r]')]
      .map((n) => Number(n.dataset.r));
    return { rows: [...new Set(rows)].sort((a, b) => a - b) };
  });
  console.log('   rows:', JSON.stringify(reach.rows));
  check('the switch sits between the navigation and the games',
    reach.rows[0] === 0 && reach.rows[1] > 0 && reach.rows[1] < 1,
    JSON.stringify(reach.rows));

  await page.evaluate(() => {
    const chip = document.querySelector('.sportchip[data-sport="nfl"]');
    chip.click();
  });
  await page.waitForTimeout(1500);

  const nfl = await page.evaluate(() => ({
    sport: document.querySelector('.sportchip.on')?.dataset.sport,
    cards: [...document.querySelectorAll('.game')].map((c) => ({
      field: Boolean(c.querySelector('.game-field')),
      diamond: Boolean(c.querySelector('.game-diamond')),
      down: c.querySelector('.game-drive b')?.textContent ?? null,
      spot: c.querySelector('.game-drive span')?.textContent ?? null,
      ball: c.querySelector('.game-field .ball')?.style.left ?? null,
      going: [...(c.querySelector('.game-field .ball')?.classList ?? [])]
        .find((k) => k.startsWith('go-')) ?? null,
    })),
  }));
  console.log('   nfl:', JSON.stringify(nfl));
  check('the switch moves the row to football',
    nfl.sport === 'nfl' && nfl.cards.length === 1, JSON.stringify([nfl.sport, nfl.cards.length]));
  check('a football game gets a field, not a diamond',
    nfl.cards[0].field === true && nfl.cards[0].diamond === false, JSON.stringify(nfl.cards[0]));
  check('with the down and the spot on it',
    nfl.cards[0].down === '3rd & 7' && nfl.cards[0].spot === 'GB 41',
    JSON.stringify(nfl.cards[0]));
  /* The ball is on the HOME side's 41, and the home end zone is the right
     one — so that is 59 yards from the left end, not 41. */
  check('the ball on the right side of the field for whose 41 it is',
    nfl.cards[0].ball === '59%', nfl.cards[0].ball);
  check('and pointing at the end zone the offence is driving for',
    nfl.cards[0].going === 'go-right', nfl.cards[0].going);

  /* The setting is the profile's own, which is what makes a switch thrown on
     the television a switch thrown on the phone. */
  console.log('   saved:', JSON.stringify(saved && saved.scoreSport));
  check('the choice is written back to the profile, not kept in this app',
    saved && saved.scoreSport === 'nfl', JSON.stringify(saved && saved.scoreSport));

  /* ---- college, which is a grid ---------------------------------------- */
  console.log('\n  a college Saturday');
  await page.evaluate(() => document.querySelector('.sportchip[data-sport="ncaaf"]').click());
  await page.waitForTimeout(1500);

  const college = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.game')];
    const rows = [...new Set(cards.map((c) => Number(c.dataset.r)))].sort((a, b) => a - b);
    const others = [...document.querySelectorAll('.chan-card, .cat-card')]
      .map((n) => Number(n.dataset.r));
    return {
      count: cards.length,
      lines: rows.length,
      rows,
      /* Where everything else on the screen sits, so the grid can be shown
         not to have landed on top of it. */
      below: [...new Set(others)].sort((a, b) => a - b),
      small: cards[0]?.classList.contains('is-ncaaf'),
      field: Boolean(cards[0]?.querySelector('.game-field')),
    };
  });
  console.log('   college:', JSON.stringify(college));

  check('every college game is on screen', college.count === 9, String(college.count));
  /* Nine games, four to a line: three lines rather than one row to scroll. */
  check('wrapped into a grid rather than one long row',
    college.lines === 3, JSON.stringify(college.rows));
  check('and drawn smaller, because there are four to a line',
    college.small === true, String(college.small));
  check('with the same field a pro game gets', college.field === true, String(college.field));

  /* The claim that would break the remote: a grid numbered carelessly lands
     on the channels and the categories, and ▼ off the last game goes
     somewhere nobody meant. */
  check('the grid stays above everything below it, so the D-pad still works',
    college.rows.every((r) => college.below.every((b) => r < b)),
    JSON.stringify([college.rows, college.below]));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
