/**
 * Why the college band was empty, and how it says so when it is.
 *
 * "I am not seeing any NCAAF games listed in the live score tab, there a a
 *  bunch of games on the schedule today so they should be on there."
 *
 * The band draws whatever the box hands it — a game with no channel behind it
 * still gets a card — so an empty band is not a routing failure. It is the
 * feed. And there was no way to find that out from the sofa, because of a
 * bug this suite pins down:
 *
 *   `trouble` was computed from the WHOLE slate. Baseball answering makes the
 *   slate non-empty, so with the college feed refused and MLB fine, the
 *   college band said "the feed answered, with an empty slate" — the one
 *   sentence that rules out what actually happened. Per feed now.
 *
 * And the feed itself is no longer one address. ESPN's front end refuses this
 * box some days — SITE_HEADERS exists for that reason — and a refusal is
 * invisible in August, when the NFL is out of season and baseball comes from
 * statsapi.mlb.com. The first anybody notices is a college Saturday. So the
 * football slates ask a chain, the way baseball already does, and the report
 * names which address answered and what the others said.
 *
 * Two more claims, about which channels the guide is asked about:
 *
 *   FOOTBALL MEANS SOCCER on every provider panel there is, and the college
 *   shelf test matched it. That is free in the by-name pass — no soccer row
 *   names two American schools — and ruinous in the guide pass, which has a
 *   budget of forty channels: forty of four hundred soccer rows and the one
 *   pass that can tell two regional feeds apart never sees a college game.
 *
 *   AND THE FORTY ARE ORDERED, most obviously college first, because the
 *   library's own order has nothing to do with football.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');
const { chromium } = require('./playwright.js');

const ROOT = path.join(__dirname, '..');
const DIR = '/tmp/portal-ncaaf';
const PORT = 8487;
const FEED_PORT = 8488;
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Every box this suite starts, killed however it ends.
 *
 * A `finally` only runs if the failure is caught, and an assertion that
 * throws past one leaves a box holding its port. The next run's spawn then
 * loses the bind and every request goes to the PREVIOUS run's code — which
 * reads as a mysterious failure against source that is actually fine, and
 * would read as a pass against source that is not. */
const boxes = [];
const start = (opts) => {
  const child = spawn('node', [path.join(DIR, 'server.js')], opts);
  boxes.push(child);
  return child;
};
const stopAll = () => { for (const b of boxes) { try { b.kill(); } catch { /* gone */ } } };
process.on('exit', stopAll);
process.on('uncaughtException', (err) => { console.error(err); stopAll(); process.exit(1); });
const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve(body));
  }).on('error', reject);
});

/** One ESPN event, in the shape the site API ships. */
const EVENT = (id, away, home) => ({
  id,
  competitions: [{
    date: new Date().toISOString(),
    status: { period: 2, displayClock: '4:22', type: { state: 'in', shortDetail: 'Q2' } },
    broadcasts: [{ names: ['ESPN'] }],
    competitors: [
      { id: `${id}a`, homeAway: 'away', score: '14',
        team: { id: `${id}a`, abbreviation: away.slice(0, 4).toUpperCase(),
          location: away, name: `${away} Team`, logo: '' } },
      { id: `${id}h`, homeAway: 'home', score: '10',
        team: { id: `${id}h`, abbreviation: home.slice(0, 4).toUpperCase(),
          location: home, name: `${home} Team`, logo: '' } },
    ],
  }],
});
const SLATE = { events: [EVENT('1', 'Alabama', 'Georgia'), EVENT('2', 'Ohio State', 'Michigan')] };
/* espn.com's own scoreboard feed carries the very same event objects a couple
   of levels down. Reading both shapes is what lets the addresses stand in for
   each other. */
const NESTED = { content: { sbData: { events: SLATE.events } } };

/* And ncaa.com's own scoreboard, which is a different shape entirely — it is
   somebody else's scoreboard, not another ESPN address, which is the whole
   point of it being on the list. One live game and one that has not started,
   because the two are read out of different fields. */
const NCAA = {
  updated_at: new Date().toISOString(),
  games: [
    { game: {
      gameID: '6301234',
      gameState: 'live',
      currentPeriod: '2nd',
      contestClock: '4:22',
      startTime: '12:00PM ET',
      startTimeEpoch: String(Math.floor(Date.now() / 1000) - 3600),
      network: 'FOX',
      away: { score: '14', description: '(4-1)',
        names: { char6: 'MICH', short: 'Michigan', seo: 'michigan' } },
      home: { score: '10', description: '(5-0)',
        names: { char6: 'OHIOST', short: 'Ohio State', seo: 'ohio-state' } },
    } },
    { game: {
      gameID: '6301235',
      gameState: 'pre',
      currentPeriod: '',
      contestClock: '',
      startTime: '7:30PM ET',
      startTimeEpoch: String(Math.floor(Date.now() / 1000) + 5400),
      network: 'ESPN',
      away: { score: '', description: '(3-2)',
        names: { char6: 'ALA', short: 'Alabama', seo: 'alabama' } },
      home: { score: '', description: '(4-1)',
        names: { char6: 'UGA', short: 'Georgia', seo: 'georgia' } },
    } },
  ],
};

/* And TheSportsDB's, which is a third shape again: a day's fixtures, with a
   badge per club and a status word rather than a period and a clock. */
const SPORTSDB = {
  events: [
    { idEvent: '2051001', strEvent: 'Michigan vs Ohio State',
      strHomeTeam: 'Ohio State Buckeyes', strAwayTeam: 'Michigan Wolverines',
      intHomeScore: '10', intAwayScore: '14',
      strStatus: '2Q', strProgress: '2Q 4:22',
      dateEvent: '2026-08-29', strTime: '16:00:00',
      strTimestamp: new Date(Date.now() - 3600000).toISOString(),
      strTVStation: 'FOX',
      strHomeTeamBadge: 'https://r2.thesportsdb.com/osu.png',
      strAwayTeamBadge: 'https://r2.thesportsdb.com/mich.png' },
    { idEvent: '2051002', strEvent: 'Alabama vs Georgia',
      strHomeTeam: 'Georgia Bulldogs', strAwayTeam: 'Alabama Crimson Tide',
      intHomeScore: null, intAwayScore: null,
      strStatus: 'NS', strProgress: '',
      dateEvent: '2026-08-29', strTime: '23:30:00',
      strTimestamp: new Date(Date.now() + 5400000).toISOString(),
      strTVStation: 'ESPN' },
  ],
};

(async () => {
  /* ================= the feed, and the addresses it lives at ============= */
  const feed = http.createServer((req, res) => {
    if (req.url.includes('/400')) {          // a limit the server thinks is too large
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('bad limit');
    }
    if (req.url.includes('/403')) {          // the edge refusing the box
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('no');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('/core')) return res.end(JSON.stringify(NESTED));
    if (req.url.includes('/ncaa')) return res.end(JSON.stringify(NCAA));
    if (req.url.includes('/sdb')) return res.end(JSON.stringify(SPORTSDB));
    if (req.url.includes('/empty')) return res.end(JSON.stringify({ events: [] }));
    return res.end(JSON.stringify(SLATE));
  });
  feed.__hits = [];
  feed.on('request', (req) => feed.__hits.push(req.url));
  await new Promise((r) => feed.listen(FEED_PORT, '127.0.0.1', r));

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const file of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(DIR, file));
  }
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u', host: '', username: '', password: '',
  }));

  const at = (p) => `http://127.0.0.1:${FEED_PORT}${p}`;
  const box = start({
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      // Two refusals of the kind actually seen, then the address that works.
      /* Every address is a fake one, so nothing in this suite reaches out to
         the real internet behind its own back. The last two must never be
         asked here — the one before them answers. */
      NCAAF_URLS: [at('/400'), at('/403'), at('/core'), at('/ncaa')].join(','),
      NFL_URL: at('/empty'),
      MLB_STATS_URL: at('/403'),
      MLB_URL: at('/403'),
    },
    stdio: 'ignore',
  });

  try {
    for (let i = 0; i < 40; i += 1) {
      try { await get('/'); break; } catch { await wait(250); }
    }

    console.log('\n  one refused address does not empty the band');
    const report = JSON.parse(await get('/api/scores'));
    const college = (report.feeds || []).find((f) => f.sport === 'ncaaf') || {};
    console.log('   ncaaf feed:', JSON.stringify(college));
    check('the games arrive', college.games === 2, String(college.games));
    check('from the third address, because the first two would not have it',
      String(college.source).includes('/core'), String(college.source));
    /* The whole point of the report: an empty band has several causes and
       they are indistinguishable from the sofa. */
    check('and the report says what the other two said',
      (college.tried || []).length === 2
      && /400/.test(JSON.stringify(college.tried))
      && /403/.test(JSON.stringify(college.tried)),
      JSON.stringify(college.tried));
    /* The order is by how much the answer is WANTED, not by how likely it is
       to work: falling through on failure only means the box always settles
       on the best address that actually answers, and adding a worse-but-more-
       reliable one to the end of the list can never cost it a better one. */
    check('which is to say it settles on the best address that answers, not the first',
      String(college.source) === at('/core'), String(college.source));
    check('with nothing reported as broken, because the slate arrived',
      !college.error, college.error);
    check('the report lists every address it may knock on',
      Array.isArray(college.url) && college.url.length === 4, JSON.stringify(college.url));
    check('and the NCAA\'s own scoreboard was not one of them, because ESPN answered',
      !feed.__hits.some((u) => u.includes('/ncaa')), JSON.stringify(feed.__hits));

    console.log('\n  and the nested shape is read as the flat one');
    const games = (report.games || []).filter((g) => g.sport === 'ncaaf');
    console.log('   games:', games.map((g) => `${g.away.abbr}-${g.home.abbr}`).join(', '));
    check('two college games, mapped the same way as the site API\'s',
      games.length === 2 && games.every((g) => g.status === 'live'),
      JSON.stringify(games.map((g) => g.status)));
    check('carrying both schools, which is how a game finds its channel',
      games[0] && games[0].teamMatch.join(',') === 'Alabama,Georgia',
      JSON.stringify(games[0] && games[0].teamMatch));

    console.log('\n  an empty answer is an answer, and is not asked twice');
    /* Falling through on empty would mean three requests to somebody else's
       server every thirty seconds all through a quiet Tuesday. */
    const nfl = (report.feeds || []).find((f) => f.sport === 'nfl') || {};
    console.log('   nfl feed:', JSON.stringify(nfl));
    check('no games, no error, and no second address tried',
      nfl.games === 0 && !nfl.error && !nfl.tried, JSON.stringify(nfl));
  } finally {
    box.kill();
  }

  /* ---- when ESPN refuses the whole way down --------------------------- */
  /*
   * Which is what the box actually reported from the sofa: 403 on every
   * college address AND on the NFL one, and an empty body from cdn.espn.com.
   * The user agent is already a browser's, so no sixth ESPN address was going
   * to change that — the list needed somebody else's scoreboard on it.
   *
   * College has one and football does not, which is what this box shows: the
   * college feed falls past ESPN onto ncaa.com and comes back with games,
   * while the NFL feed runs out of addresses and says so.
   */
  console.log('\n  when ESPN will not talk to this box at all');
  const DEAD_PORT = 8489;
  const deadBox = start({
    env: {
      ...process.env,
      PORT: String(DEAD_PORT),
      HOST: '127.0.0.1',
      /* Distinct paths per feed so a hit can be attributed to the feed that
         made it — otherwise "did it ask twice" cannot be answered. */
      NCAAF_URLS: [at('/403-col-a'), at('/400-col-b'), at('/ncaa')].join(','),
      NFL_URLS: [at('/403-pro-a'), at('/400-pro-b')].join(','),
      MLB_STATS_URL: at('/403-mlb'),
      MLB_URL: at('/403-mlb2'),
    },
    stdio: 'ignore',
  });
  try {
    const ask = () => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${DEAD_PORT}/api/scores`, (r) => {
        let out = '';
        r.on('data', (d) => { out += d; });
        r.on('end', () => resolve(out));
      }).on('error', reject);
    });
    let body = '';
    for (let i = 0; i < 40; i += 1) {
      try { body = await ask(); break; } catch { await wait(250); }
    }
    const answer = JSON.parse(body || '{}');
    const dead = (answer.feeds || []).find((f) => f.sport === 'nfl') || {};
    const fallen = (answer.feeds || []).find((f) => f.sport === 'ncaaf') || {};

    console.log('   college feed:', JSON.stringify(fallen));
    check('college falls past ESPN onto the NCAA\'s own scoreboard',
      fallen.games === 2 && String(fallen.source).includes('/ncaa'),
      JSON.stringify([fallen.games, fallen.source]));
    check('having tried the two before it first',
      (fallen.tried || []).length === 2, JSON.stringify(fallen.tried));

    const college2 = (answer.games || []).filter((g) => g.sport === 'ncaaf');
    console.log('   mapped:', JSON.stringify(college2.map(
      (g) => [g.status, g.clock, g.away.abbr, g.away.score, g.home.abbr, g.home.score])));
    const on = college2.find((g) => g.status === 'live');
    const soon = college2.find((g) => g.status === 'upcoming');
    check('a game in progress carries the period and the clock the way a broadcast says it',
      on && on.clock === '2nd · 4:22', on && on.clock);
    check('and the score on both sides', on && on.away.score === 14 && on.home.score === 10,
      JSON.stringify(on && [on.away.score, on.home.score]));
    check('with the record read out of the parentheses ncaa.com writes it in',
      on && on.away.record === '4-1', on && on.away.record);
    /* Both schools travel with the game, which is what lets a card find the
       provider's row for THAT GAME rather than the network. */
    check('both schools travel with it, and both abbreviations behind them',
      on && on.teamMatch.join(',') === 'Michigan,Ohio State'
      && on.teamShort.join(',') === 'MICH,OHIOST',
      JSON.stringify(on && [on.teamMatch, on.teamShort]));
    check('the network comes with it too, which is the last pass the matcher has',
      on && on.channelMatch === 'FOX', on && on.channelMatch);
    /* Only ESPN publishes the down and the spot. A field with no ball on it
       is honest; a field with a guessed one is not. */
    check('and no drive is invented, because this source does not publish one',
      on && on.drive === null, JSON.stringify(on && on.drive));
    check('a game that has not started is upcoming, with its start time',
      soon && soon.status === 'upcoming' && /\d/.test(soon.clock)
      && soon.away.score === null,
      JSON.stringify(soon && [soon.status, soon.clock, soon.away.score]));

    /* ---- and a third publisher's shape again ------------------------- */
    /*
     * The list mixes publishers, so nothing on it can be told what shape it
     * answers in — the box works that out from the answer. Which is also
     * what lets an address typed in by hand, or asked by the probe, need no
     * second setting saying what kind of thing lives there.
     */
    console.log('\n  a day of fixtures, from a third publisher again');
    const sdbPort = 8490;
    const sdbBox = start({
      env: {
        ...process.env,
        PORT: String(sdbPort),
        HOST: '127.0.0.1',
        NCAAF_URL: at('/sdb'),
        NFL_URL: at('/sdb'),
        MLB_STATS_URL: at('/403-mlb'),
        MLB_URL: at('/403-mlb2'),
      },
      stdio: 'ignore',
    });
    try {
      let raw = '';
      for (let i = 0; i < 40; i += 1) {
        try {
          raw = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${sdbPort}/api/scores`, (r) => {
              let out = '';
              r.on('data', (d) => { out += d; });
              r.on('end', () => resolve(out));
            }).on('error', reject);
          });
          break;
        } catch { await wait(250); }
      }
      const sdb = (JSON.parse(raw || '{}').games || []).filter((g) => g.sport === 'ncaaf');
      console.log('   mapped:', JSON.stringify(sdb.map(
        (g) => [g.status, g.clock, g.away.abbr, g.away.score, g.channelMatch])));
      const on2 = sdb.find((g) => g.status === 'live');
      const soon2 = sdb.find((g) => g.status === 'upcoming');
      check('the same list reads a shape it was never told about',
        sdb.length === 2, String(sdb.length));
      check('a game in progress carries its progress as the clock',
        on2 && on2.clock === '2Q 4:22', on2 && on2.clock);
      check('and the scores', on2 && on2.away.score === 14 && on2.home.score === 10,
        JSON.stringify(on2 && [on2.away.score, on2.home.score]));
      /* The one thing this publisher gives that nobody else on these lists
         does, and the reason the cards have marks again. */
      check('with a badge per club, which is what puts the marks back',
        on2 && /mich\.png$/.test(on2.away.logo), on2 && on2.away.logo);
      check('the club as it names it, and the nickname behind it for a row that uses one',
        on2 && on2.teamMatch[0] === 'Michigan Wolverines' && on2.teamAlt[0] === 'Wolverines',
        JSON.stringify(on2 && [on2.teamMatch, on2.teamAlt]));
      check('the network, which is the last pass the matcher has',
        on2 && on2.channelMatch === 'FOX', on2 && on2.channelMatch);
      check('and NS is a game that has not started, not a game with no score',
        soon2 && soon2.status === 'upcoming' && soon2.away.score === null,
        JSON.stringify(soon2 && [soon2.status, soon2.away.score]));

      /* ---- every address, asked ---------------------------------------- */
      /*
       * The ordinary report says what the addresses BEFORE the winner said
       * and nothing about the ones after, which is the right report for a
       * scoreboard and useless for finding out why there is no scoreboard.
       * Three rounds were spent guessing which address was the broken one
       * from a report that could not say.
       */
      console.log('\n  and every address, asked on purpose');
      const probed = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${DEAD_PORT}/api/scores/probe?sport=ncaaf`, (r) => {
          let out = '';
          r.on('data', (d) => { out += d; });
          r.on('end', () => { if (!out.startsWith('{')) console.log('   RAW:', out.slice(0, 200)); resolve(JSON.parse(out || '{}')); });
        }).on('error', reject);
      });
      console.log('   probed:', JSON.stringify(probed).slice(0, 400));
      const rows = (probed.feeds || [])[0]?.addresses || [];
      console.log('   probe:', JSON.stringify(rows.map((r) => [r.status, r.games, r.bytes])));
      check('it asks all of them, including the ones a poll never reaches',
        rows.length === 3, String(rows.length));
      check('and says what each one actually answered',
        rows[0].status === 403 && rows[1].status === 400 && rows[2].status === 200,
        JSON.stringify(rows.map((r) => r.status)));
      /* The question a status code cannot answer: an address can answer 200
         with perfectly good JSON in a shape nothing here understands, and
         from the sofa that is indistinguishable from a refusal. */
      check('and how many games this box could read out of it',
        rows[2].games === 2, JSON.stringify(rows[2]));
      check('with the start of the body, so a login wall says so',
        typeof rows[0].head === 'string', JSON.stringify(rows[0]).slice(0, 120));
      check('asked for one sport only when one is named',
        (probed.feeds || []).length === 1, String((probed.feeds || []).length));
    } finally {
      sdbBox.kill();
    }

    console.log('   nfl feed:', JSON.stringify(dead));
    check('football has no such second source, and says so rather than pretending it is Tuesday',
      dead.games === 0 && Boolean(dead.error), JSON.stringify(dead));
    /* A 403 and a 400 read as one confusing sentence without the count, and
       the count is what says "this was a list and all of it failed" rather
       than "the feed is down". */
    check('the message names the reasons and how many addresses gave them',
      /403/.test(dead.error) && /400/.test(dead.error) && /2 addresses tried/.test(dead.error),
      dead.error);
    check('and both are in the report', (dead.tried || []).length === 2,
      JSON.stringify(dead.tried));

    /* A chain is only cheap while something on it answers. Asked again a
       moment later it must not walk the whole list again — five addresses
       every thirty seconds is ten requests a minute at somebody else's
       server for as long as a page is open, which is how a box gets itself
       blocked properly rather than intermittently. (The failure back-off is
       two minutes rather than thirty seconds; a suite that proved the length
       of it would have to sit still for half a minute, so what is checked
       here is the property that matters: asking twice does not ask ESPN
       twice.) */
    feed.__hits = [];
    await ask();
    await ask();
    const again = feed.__hits.filter((u) => u.includes('col') || u.includes('pro'));
    console.log('   football hits for two more asks:', again.length, feed.__hits);
    check('and asking again does not walk either football list again',
      again.length === 0, JSON.stringify(feed.__hits));
  } finally {
    deadBox.kill();
    feed.close();
  }

  /* ================= and what the band says when it is empty ============= */
  const browser = await chromium.launch();
  const CHANNELS = [
    { kind: 'live', id: 700, num: 700, name: 'US| ESPN ᴴᴰ', categoryId: 'ncaaf', logo: '' },
    { kind: 'live', id: 701, num: 701, name: 'US| NCAAF 07 | ALABAMA X GEORGIA',
      categoryId: 'ncaaf', logo: '' },
    /* The shelf that broke the guide pass. Named FOOTBALL, which on every
       provider panel there is means soccer, and big enough to eat the budget
       forty times over if it is not excluded. */
    ...Array.from({ length: 60 }, (_, i) => ({
      kind: 'live', id: 900 + i, num: 900 + i,
      name: `UK| SKY FOOTBALL ${i}`, categoryId: 'soccer', logo: '',
    })),
  ];
  const LIVE = {
    categories: [{ id: 'ncaaf', name: 'USA NCAAF' }, { id: 'soccer', name: 'UK FOOTBALL' }],
    items: CHANNELS,
    totals: { items: CHANNELS.length },
  };
  const PREFS = { favorites: [], pinnedCategories: [], deletedItems: [], deletedCategories: [],
    owner: true, tourDone: true, liveTourDone: true, reportNoticeSeen: true, dlExplainSeen: true,
    scoreSport: 'ncaaf' };

  /* Baseball is fine and college is refused — which is the exact shape the
     old code could not describe, because a slate with games in it was taken
     as proof that every feed had answered. */
  const SCORES = {
    games: [{ id: 'm1', sport: 'mlb', status: 'live', channelMatch: 'MLB NETWORK',
      channelName: 'MLB Network', teamMatch: ['Rockies', 'Nationals'],
      away: { abbr: 'COL', score: 6 }, home: { abbr: 'WSH', score: 1 }, clock: 'Top 9th' }],
    feeds: [
      { sport: 'nfl', games: 0 },
      { sport: 'ncaaf', games: 0, error: 'HTTP 403 · HTTP 403 · HTTP 403' },
      { sport: 'mlb', games: 1 },
    ],
  };

  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/profiles/*/prefs', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREFS) })
    : r.continue()));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  page.__epgAsked = [];
  await page.route('**/api/epg/now**', (r) => {
    page.__epgAsked.push(String(new URL(r.request().url()).searchParams.get('ids') || ''));
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' });
  });
  await page.route('**/api/scores**', (r) => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(SCORES) }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => { state.config.mode = 'xtream'; location.hash = '#/live'; });
  await page.waitForTimeout(2600);

  console.log('\n  a college band with a refused feed behind it');
  const note = await page.evaluate(() => ({
    sport: profiles.data.scoreSport,
    empty: document.querySelector('.sc-empty')?.textContent || '',
    cards: document.querySelectorAll('.sc-card').length,
  }));
  console.log('   ', JSON.stringify(note));
  check('the band is showing college', note.sport === 'ncaaf', note.sport);
  check('and says the feed did not answer, not that it did',
    /did not answer/.test(note.empty) && !/feed answered/.test(note.empty), note.empty);
  check('naming what came back', /403/.test(note.empty), note.empty);
  check('and the door to knock on, in full',
    /http:\/\/127\.0\.0\.1:8481\/api\/scores/.test(note.empty), note.empty);

  console.log('\n  and the guide is asked about football, not about soccer');
  const asked = page.__epgAsked.join(' ');
  console.log('   asked:', asked.slice(0, 160));
  /* Sixty soccer rows sit in front of two college ones in library order. The
     budget is forty. Without the exclusion the two college channels are never
     reached, and the pass that can tell two regional feeds apart is dead. */
  check('the college rows are asked about',
    /\b700\b/.test(asked) && /\b701\b/.test(asked), asked.slice(0, 200));
  check('and not one soccer row is, though sixty of them come first',
    !/\b9\d\d\b/.test(asked), asked.slice(0, 200));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
