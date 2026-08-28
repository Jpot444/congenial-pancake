/**
 * The scores the box serves, and how a game finds its channel.
 *
 * Football was the first sport wired up and for six months of the year there
 * is none of it, so the same treatment is given to baseball — from the same
 * public scoreboard, mapped on the box rather than on the television. Two
 * things are different about baseball and both are tested here:
 *
 *   - There is no clock. The half-inning IS the clock, and ESPN already
 *     writes it the way a broadcast says it, so it is taken rather than
 *     rebuilt out of a period number.
 *   - The provider carries a channel PER GAME — 'MLB 01 | Rockies x
 *     Nationals' — which is the broadcast itself rather than the network
 *     showing it. A game therefore travels with both team names, and the
 *     television tries those before the network.
 *
 * And baseball is asked of baseball first. ESPN's edge answers this box with
 * 403 — a Raspberry Pi is not a browser sitting on espn.com — so the league's
 * own statsapi.mlb.com is the first door knocked on and ESPN is the second.
 * Both shapes are mapped, and the fallback is exercised rather than assumed:
 * the second box below is pointed at a source that refuses.
 *
 * Neither real feed is called. The suite serves both shapes on a socket and
 * points the box at them, so what is under test is our mapping rather than
 * whatever happens to be on today.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-scores';
const PORT = 8484;
const FEED_PORT = 8485;
/* Not FEED_PORT + something by accident: the fallback box needs a port of its
   own, and the feed already holds the one next door. */
const SECOND_PORT = 8486;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

/* One live game with runners on, one not started, one over. Trimmed to the
   fields the mapper reads, in ESPN's own shape. */
const SCOREBOARD = {
  events: [
    {
      id: '401581001',
      competitions: [{
        date: '2026-08-27T22:05Z',
        status: { period: 5, type: { state: 'in', shortDetail: 'Top 5th' } },
        competitors: [
          { id: '1', homeAway: 'home', score: '3', team: { abbreviation: 'WSH', shortDisplayName: 'Nationals' }, records: [{ summary: '60-72' }] },
          { id: '2', homeAway: 'away', score: '5', team: { abbreviation: 'COL', shortDisplayName: 'Rockies' }, records: [{ summary: '55-77' }] },
        ],
        situation: { balls: 2, strikes: 1, outs: 1, onFirst: true, onSecond: false, onThird: true },
        broadcasts: [{ names: ['MLBN'] }],
      }],
    },
    {
      id: '401581002',
      competitions: [{
        date: '2036-08-28T23:10Z',
        status: { type: { state: 'pre', shortDetail: '7:10 PM ET' } },
        competitors: [
          { id: '3', homeAway: 'home', score: '0', team: { abbreviation: 'BOS', shortDisplayName: 'Red Sox' } },
          { id: '4', homeAway: 'away', score: '0', team: { abbreviation: 'NYY', shortDisplayName: 'Yankees' } },
        ],
        broadcasts: [{ names: ['ESPN'] }],
      }],
    },
    {
      id: '401581003',
      competitions: [{
        date: '2026-08-27T19:45Z',
        status: { period: 9, type: { state: 'post', shortDetail: 'Final' } },
        competitors: [
          { id: '5', homeAway: 'home', score: '2', team: { abbreviation: 'SF', shortDisplayName: 'Giants' } },
          { id: '6', homeAway: 'away', score: '7', team: { abbreviation: 'LAD', shortDisplayName: 'Dodgers' } },
        ],
        broadcasts: [{ names: ['SNLA'] }],
      }],
    },
  ],
};

/*
 * The same three games as statsapi.mlb.com hands them over. Different shape
 * entirely — the league nests its games under dates, writes the half-inning
 * and the ordinal as separate fields, and only carries the runners, the count
 * and the broadcast because they were asked for by name in `hydrate`.
 */
const SCHEDULE = {
  dates: [{
    date: '2026-08-28',
    games: [
      {
        gamePk: 776543,
        gameDate: '2026-08-28T23:05:00Z',
        status: { abstractGameState: 'Live', detailedState: 'In Progress' },
        teams: {
          away: { leagueRecord: { wins: 55, losses: 77 }, score: 5, team: { teamName: 'Rockies', abbreviation: 'COL' } },
          home: { leagueRecord: { wins: 60, losses: 72 }, score: 3, team: { teamName: 'Nationals', abbreviation: 'WSH' } },
        },
        linescore: {
          currentInning: 5, currentInningOrdinal: '5th', inningState: 'Top',
          balls: 2, strikes: 1, outs: 1, offense: { first: { id: 1 }, third: { id: 2 } },
        },
        // The local network is listed first on purpose: the national one is
        // the channel this house is likelier to carry, and it must win.
        broadcasts: [{ name: 'MASN', type: 'TV' }, { name: 'MLB Network', type: 'TV', isNational: true }],
      },
      {
        gamePk: 776544,
        gameDate: '2036-08-29T23:10:00Z',
        status: { abstractGameState: 'Preview', detailedState: 'Scheduled' },
        teams: {
          away: { score: 0, team: { teamName: 'Yankees', abbreviation: 'NYY' } },
          home: { score: 0, team: { teamName: 'Red Sox', abbreviation: 'BOS' } },
        },
        broadcasts: [{ name: 'ESPN', type: 'TV', isNational: true }],
      },
      {
        gamePk: 776545,
        gameDate: '2026-08-28T19:45:00Z',
        status: { abstractGameState: 'Final', detailedState: 'Final' },
        teams: {
          away: { score: 7, team: { teamName: 'Dodgers', abbreviation: 'LAD' } },
          home: { score: 2, team: { teamName: 'Giants', abbreviation: 'SF' } },
        },
        linescore: { currentInning: 9, currentInningOrdinal: '9th', inningState: 'End' },
        broadcasts: [{ name: 'SNLA', type: 'TV' }],
      },
    ],
  }],
};

(async () => {
  /* ---- a scoreboard of our own ------------------------------------------ */
  const feed = http.createServer((req, res) => {
    /* Three doors: the league's own schedule, ESPN's scoreboard, and one that
       refuses — which is what ESPN actually does to this box. */
    if (req.url.includes('refused')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('no');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('stats')) return res.end(JSON.stringify(SCHEDULE));
    return res.end(JSON.stringify(req.url.includes('empty') ? { events: [] } : SCOREBOARD));
  });
  await new Promise((r) => feed.listen(FEED_PORT, '127.0.0.1', r));

  /* ---- a box pointed at it ---------------------------------------------- */
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const file of ['server.js', 'local-library.js', 'epg-guide.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(DIR, file));
  }
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u', host: '', username: '', password: '',
  }));

  const server = spawn('node', [path.join(DIR, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MLB_STATS_URL: `http://127.0.0.1:${FEED_PORT}/stats`,
      MLB_URL: `http://127.0.0.1:${FEED_PORT}/mlb`,
      NFL_URL: `http://127.0.0.1:${FEED_PORT}/empty`,
    },
    stdio: 'ignore',
  });

  for (let i = 0; i < 40; i += 1) {
    try {
      await get('/');
      break;
    } catch {
      await wait(250);
    }
  }

  try {
    console.log('\n  the baseball slate');
    const res = await get('/api/scores/mlb');
    const games = JSON.parse(res.body).games || [];
    console.log('   games:', games.map((g) => `${g.status}/${g.clock}`).join(', '));
    check('three games, mapped', games.length === 3, String(games.length));

    const live = games.find((g) => g.status === 'live');
    check('the live one carries the score', live && live.away.score === 5 && live.home.score === 3,
      JSON.stringify(live && [live.away, live.home]));
    check('and the half-inning as the broadcast writes it', live && live.clock === 'Top 5th',
      live && live.clock);
    // Up the diamond, the way it is said out loud.
    check('runners, outs and count read like a scoreboard',
      live && live.situation === '1 out · 1st & 3rd · 2-1', live && live.situation);
    check('the away side is at bat in the top of the inning',
      live && live.away.possession === true && live.home.possession === false,
      JSON.stringify(live && [live.away.possession, live.home.possession]));
    check('and it says which sport it is', live && live.sport === 'mlb', live && live.sport);

    const soon = games.find((g) => g.status === 'upcoming');
    check('an unplayed game is upcoming, not live', Boolean(soon), games.map((g) => g.status).join(','));
    const over = games.find((g) => g.status === 'final');
    check('and a finished one is final', over && over.clock === 'Final', over && over.clock);

    /* Both teams travel with the game, which is what lets the television find
       the provider's channel for THAT GAME rather than the network. */
    check('both teams travel with the game',
      live && live.teamMatch.join(',') === 'Rockies,Nationals', JSON.stringify(live && live.teamMatch));

    console.log('\n  where it came from');
    const report = JSON.parse((await get('/api/scores')).body);
    const mlbFeed = (report.feeds || []).find((f) => f.sport === 'mlb') || {};
    check('the league is the source that answered',
      mlbFeed.source === 'statsapi.mlb.com', JSON.stringify(mlbFeed));
    check('and the report names both doors it can knock on',
      Array.isArray(mlbFeed.url) && mlbFeed.url.length === 2, JSON.stringify(mlbFeed.url));

    /* A national broadcast beats the local one: it is the channel this house
       is likelier to carry. */
    check('the national broadcast is the one offered',
      live && live.channelMatch === 'MLB Network', live && live.channelMatch);

    console.log('\n  both sports in one call');
    const both = JSON.parse((await get('/api/scores')).body);
    check('answers with the sports that have games',
      (both.games || []).length === 3 && both.games.every((g) => g.sport === 'mlb'),
      String((both.games || []).length));
    check('and an out-of-season sport costs an empty list, not an error',
      !both.error, both.error);

    console.log('\n  finding the channel');
    /* The matcher runs in the television. Exercised here against the shape the
       box actually emits, since the two are only useful together. */
    const scores = fs.readFileSync(path.join(ROOT, 'public/tv/js/scores.js'), 'utf8');
    check('the matcher tries both team names before the network',
      /teamMatch[\s\S]{0,600}teams\.every\(/.test(scores)
        && scores.indexOf('teams.every(') < scores.indexOf('channelMatch || game.channelName'),
      'public/tv/js/scores.js');
    check('and the television asks for every sport rather than for football',
      /const ENDPOINT = '\/api\/scores'/.test(scores));
    /* ---- and when the league is the one that will not answer ----------- */
    console.log('\n  the fallback');
    const second = spawn('node', [path.join(DIR, 'server.js')], {
      env: {
        ...process.env,
        PORT: String(SECOND_PORT),
        HOST: '127.0.0.1',
        MLB_STATS_URL: `http://127.0.0.1:${FEED_PORT}/refused`,
        MLB_URL: `http://127.0.0.1:${FEED_PORT}/mlb`,
        NFL_URL: `http://127.0.0.1:${FEED_PORT}/empty`,
      },
      stdio: 'ignore',
    });
    try {
      let body = '';
      for (let i = 0; i < 40; i += 1) {
        try {
          body = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${SECOND_PORT}/api/scores/mlb`, (r) => {
              let out = '';
              r.on('data', (d) => { out += d; });
              r.on('end', () => resolve(out));
            }).on('error', reject);
          });
          break;
        } catch {
          await wait(250);
        }
      }
      const fell = JSON.parse(body || '{}');
      check('a refused first source does not end the row — the second answers',
        (fell.games || []).length === 3, `${(fell.games || []).length} games`);
      check('and nothing is reported as broken, because nothing was',
        !fell.error, fell.error);
    } finally {
      second.kill();
    }
  } finally {
    server.kill();
    feed.close();
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
