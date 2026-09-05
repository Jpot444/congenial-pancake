/**
 * A row that names a fixture is THAT fixture's row.
 *
 * "some college football games are being routed wrong. for example, the Uconn
 *  Lafayette game is routed to Flo (FLSP) 279: 2025 UConn vs Mercyhurst -
 *  Womens - 24/10 15:00, really it is on CBS HARTFORD (WFSB)"
 *
 * The channel says who is playing on it, in its own name, and it is not this
 * game. It could reach the card anyway because only ONE of the three passes
 * ever read the two sides off a row.
 *
 *   The BY-ROW pass reads them and requires both. It is not the problem.
 *
 *   The NETWORK pass treats every row as a channel that might be showing
 *   anything, so a row is eligible if a network word appears anywhere in its
 *   name — and 'Flo (FLSP) 279: 2025 UConn vs Mercyhurst' is a name with a lot
 *   of words in it.
 *
 *   The GUIDE pass reads the programme title rather than the row, so a row
 *   whose listing is generic or stale can answer for a game it has nothing to
 *   do with.
 *
 * On a college Saturday that is not a rare shape. The provider carries
 * hundreds of per-event rows across the Flo, ESPN+ and PPV shelves, most for
 * games nobody asked about and some left over from last season, and every one
 * of them names a school that somebody is playing today.
 *
 * So the rule this suite pins down: a row that names two sides is only ever
 * eligible for the game whose two sides they are. It costs the by-row pass
 * nothing — that pass already requires both — and it takes these rows away
 * from the two passes that were never in a position to judge them.
 *
 * The matcher is the shipped one, reached through the handle desktop.js
 * publishes, so this measures the function the cards actually use.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The shelves this provider really has on a Saturday: the locals that carry
 * the broadcast, the national networks, and a long tail of per-event rows.
 */
const CATEGORIES = [
  { id: 'loc', name: 'US| LOCALS' },
  { id: 'net', name: 'US| SPORTS NETWORKS' },
  { id: 'flo', name: 'US| FLO SPORTS' },
  { id: 'ncaaf', name: 'US| NCAAF' },
];
const CHANNELS = [
  { kind: 'live', id: 10, name: 'US| CBS HARTFORD (WFSB) ᴴᴰ', categoryId: 'loc', logo: '' },
  { kind: 'live', id: 11, name: 'US| CBS BOSTON (WBZ) ᴴᴰ', categoryId: 'loc', logo: '' },
  { kind: 'live', id: 20, name: 'US| ESPN ᴴᴰ', categoryId: 'net', logo: '' },
  { kind: 'live', id: 21, name: 'US| CBS SPORTS NETWORK', categoryId: 'net', logo: '' },
  /* The row from the report, verbatim in shape: an event channel naming a
     fixture that is not the one being routed — and last season's at that. */
  { kind: 'live', id: 30,
    name: 'Flo (FLSP) 279: 2025 UConn vs Mercyhurst - Womens - 24/10 15:00',
    categoryId: 'flo', logo: '' },
  { kind: 'live', id: 31,
    name: 'Flo (FLSP) 281: 2025 Lafayette vs Bucknell - Womens - 24/10 17:00',
    categoryId: 'flo', logo: '' },
  /* And the shape the by-row pass exists for, which must keep working. */
  { kind: 'live', id: 40, name: 'US| NCAAF 07 | ALABAMA X GEORGIA', categoryId: 'ncaaf', logo: '' },
  { kind: 'live', id: 41, name: 'US| NCAAF 08 | ESPN', categoryId: 'ncaaf', logo: '' },
];

const side = (abbr) => ({ abbr, score: null, logo: '', record: '' });

/* UConn at Lafayette, on the local CBS station. teamMatch is the school name,
   teamAlt the nickname, teamShort the abbreviation — the three spellings the
   feed ships and the matcher tries in that order. */
const UCONN = {
  id: 'uconn-laf', sport: 'ncaaf', status: 'live', clock: 'Q2 · 7:10',
  teamMatch: ['UConn', 'Lafayette'],
  teamAlt: ['Huskies', 'Leopards'],
  teamShort: ['CONN', 'LAF'],
  channelMatch: 'CBS',
  away: side('CONN'), home: side('LAF'),
};

/* The row the by-row pass is for. Nothing here may break it. */
const BAMA = {
  id: 'bama-uga', sport: 'ncaaf', status: 'live', clock: 'Q3 · 2:00',
  teamMatch: ['Alabama', 'Georgia'],
  teamAlt: ['Crimson Tide', 'Bulldogs'],
  teamShort: ['ALA', 'UGA'],
  channelMatch: 'ESPN',
  away: side('ALA'), home: side('UGA'),
};

/* A game whose only honest answer is the network — nothing names it. */
const PLAIN = {
  id: 'plain', sport: 'ncaaf', status: 'live', clock: 'Q1',
  teamMatch: ['Rutgers', 'Purdue'],
  teamAlt: ['Scarlet Knights', 'Boilermakers'],
  teamShort: ['RUTG', 'PUR'],
  channelMatch: 'ESPN',
  away: side('RUTG'), home: side('PUR'),
};

const route = (page, game, epg) => page.evaluate(({ g, chans, cats, listings }) => {
  const map = new Map(Object.entries(listings || {}));
  const out = window.__ttDesktop.matchChannel(g, chans, cats, map);
  return out ? out.name : null;
}, { g: game, chans: CHANNELS, cats: CATEGORIES, listings: epg || {} });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/library*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ categories: CATEGORIES, items: CHANNELS }) }));
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  check('the matcher the cards use is reachable',
    await page.evaluate(() => typeof window.__ttDesktop?.matchChannel) === 'function');

  /* ---- 1. the reported game ---------------------------------------------- */
  console.log('\n  UConn at Lafayette');
  const got = await route(page, UCONN);
  console.log('   routed to:', JSON.stringify(got));
  /* The row names UConn, and it names a fixture — but the other side of that
     fixture is Mercyhurst, so it is not this game's channel whatever else
     about it looks right. */
  check('does not go to a Flo row for a different fixture',
    !/Mercyhurst/i.test(got || ''), got);
  /* Nor to the OTHER stale row, which names Lafayette. One school in common is
     not a match; it is half of one. */
  check('nor to one that names the other school',
    !/Bucknell/i.test(got || ''), got);
  /*
   * It lands on CBS, which is as far as this pass can honestly get.
   *
   * The feed names a bare network, and this box has two channels with CBS in
   * the name: the local station carrying the game and the sibling national
   * network. Nothing in a name tells those apart — 'CBS SPORTS NETWORK' is not
   * CBS any more than CNBC is NBC, but it is not a substring either, so the
   * whole-word rule that fixed CNBC has nothing to say here. Choosing between
   * two feeds of the same network is what the guide pass is for, and section 4
   * is where that is checked. What this section is about is that the answer is
   * a CBS channel at all rather than an unrelated fixture's event row.
   */
  check('it goes to a CBS channel', /CBS/.test(got || ''), got);

  /* ---- 2. the by-row pass is untouched ----------------------------------- */
  /*
   * The whole college matcher leans on this: a provider that carries a row per
   * game has already done the work. A rule that protected against stale event
   * rows by making every fixture row unreachable would have cost more than the
   * bug did.
   */
  console.log('\n  and the row the by-row pass exists for');
  const bama = await route(page, BAMA);
  console.log('   routed to:', JSON.stringify(bama));
  check('a fixture row still answers for its own fixture',
    bama === 'US| NCAAF 07 | ALABAMA X GEORGIA', bama);

  /* ---- 3. the network pass still works where it should ------------------- */
  console.log('\n  a game with no row of its own');
  const plain = await route(page, PLAIN);
  console.log('   routed to:', JSON.stringify(plain));
  /* ESPN, and specifically the NCAAF shelf's ESPN rather than the plain one —
     the provider's own row for the sport is the broadcast, and the bare
     network is the channel that happens to be showing it. */
  check('falls through to the network it was told', /ESPN/.test(plain || ''), plain);
  check('and never to a stale event row that merely has words in it',
    !/Flo \(FLSP\)/.test(plain || ''), plain);

  /* ---- 4. the guide pass cannot override the row either ------------------ */
  /*
   * The guide reads the programme title, not the row. A Flo event channel
   * whose listing is stale or generic used to be able to answer for a game it
   * has nothing to do with — and the row's own name was sitting there the
   * whole time saying who was on it.
   */
  console.log('\n  when the guide disagrees with the row');
  const misled = await route(page, UCONN, {
    30: 'UConn at Lafayette',            // the Flo row, listed as our game
    10: 'College Football',              // the local station, listed generically
  });
  console.log('   routed to:', JSON.stringify(misled));
  check('a row that names another fixture is still not offered',
    !/Mercyhurst/i.test(misled || ''), misled);

  /* But a guide listing on a row that is NOT fixture-named is exactly what the
     guide pass is for, and it must still win — it is the only pass that can
     tell two regional feeds of the same network apart. */
  const guided = await route(page, UCONN, { 11: 'UConn at Lafayette' });
  console.log('   with a listing on the Boston station:', JSON.stringify(guided));
  check('the guide still decides between two feeds of the same network',
    guided === 'US| CBS BOSTON (WBZ) ᴴᴰ', guided);

  /* ---- 5. the card says how it decided ----------------------------------- */
  /*
   * A wrong card is nearly impossible to argue with from the sofa: the three
   * passes disagree invisibly once one of them has won. "Matched on the
   * network" and "the guide says this is what is on it" are two completely
   * different faults, and they looked identical.
   */
  console.log('\n  and the card can say why');
  const why = await page.evaluate(({ g, chans, cats }) =>
    window.__ttDesktop.matchChannelWhy(g, chans, cats, new Map()),
  { g: UCONN, chans: CHANNELS, cats: CATEGORIES });
  console.log('   ', JSON.stringify(why));
  check('the routing carries the pass that produced it',
    why && why.pass === 'network', JSON.stringify(why));
  check('and what that pass had to go on', why && /CBS/.test(why.evidence || ''),
    JSON.stringify(why));

  const rowWhy = await page.evaluate(({ g, chans, cats }) =>
    window.__ttDesktop.matchChannelWhy(g, chans, cats, new Map()),
  { g: BAMA, chans: CHANNELS, cats: CATEGORIES });
  check('a by-row match says so', rowWhy && rowWhy.pass === 'row', JSON.stringify(rowWhy));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
