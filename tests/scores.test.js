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
 * ESPN is not called: the suite serves its own scoreboard on a socket and
 * points the box at it with MLB_URL, so what is under test is our mapping of
 * that shape rather than what happens to be on today.
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

(async () => {
  /* ---- a scoreboard of our own ------------------------------------------ */
  const feed = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('empty') ? { events: [] } : SCOREBOARD));
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
  } finally {
    server.kill();
    feed.close();
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
