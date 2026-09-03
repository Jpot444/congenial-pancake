/**
 * A fixture channel that is not carrying the fixture.
 *
 * "On some games the stream that should be correct isnt working, for example
 *  'MLB 07 | Giants x Pirates start:… stop:…' … are not playing, when i click
 *  them a black screen opens with a 10 minute blank video. This can be fixxed
 *  with either routing to the team streams 'MLB TORONTO BLUE JAYS ᴿᴬᵂ' in MLB
 *  team PPV. Or checking all the streams to see if they work or not"
 *
 * The provider sells a channel per fixture and on some nights the one for a
 * given game never carries it. What it carries is a short canned clip on a
 * loop — black, ten minutes, ending. That is not a broadcast gone wrong, it is
 * a placeholder left in the slot, and nothing the player does turns it into a
 * ball game.
 *
 * It is obvious on the wire, which is what this suite is really about. A live
 * playlist is a SLIDING WINDOW: a few segments, no end marker, rewritten as the
 * broadcast goes on. A canned clip is a finished file: every segment at once
 * and `#EXT-X-ENDLIST` at the bottom. A playlist that says how long it is and
 * then stops is not live, whatever the channel is called.
 *
 * So both of the things asked for, from the same test:
 *
 *   ROUTING. Press a filler fixture and the box opens the club's own feed
 *   instead — read out of the fixture's own name — and says that it did.
 *
 *   CHECKING. One call reports the whole shelf, with the feed it would hand
 *   each broken one off to.
 *
 * The provider is stood up here rather than reached, because the real one is
 * behind credentials on the Pi and this has to be reproducible: a little HTTP
 * server that answers the two playlist shapes on demand.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-canned';
const PORT = 8478;
const FAKE = 8479;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { /* not json */ }
      resolve({ status: res.statusCode, body: data, text: body });
    });
  }).on('error', reject);
});

/* Ten minutes of clip, finished. Sixty six-second segments and an ENDLIST —
   which is the provider's placeholder, near enough. */
const CANNED = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  ...Array.from({ length: 100 }, (_, i) => `#EXTINF:6.000,\nfiller${i}.ts`),
  '#EXT-X-ENDLIST'].join('\n');

/* A real live window: a handful of segments, a moving sequence number, and
   pointedly no end marker. */
const LIVE = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:4412',
  ...Array.from({ length: 6 }, (_, i) => `#EXTINF:6.000,\nseg${4412 + i}.ts`)].join('\n');

/* And a finished playlist that is THREE HOURS long, which is a recording of
   the game — a perfectly good thing to hand somebody, and the case the length
   half of the test exists to protect. */
const FULL_GAME = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
  ...Array.from({ length: 1800 }, (_, i) => `#EXTINF:6.000,\ngame${i}.ts`),
  '#EXT-X-ENDLIST'].join('\n');

/* Channel ids, and what each one is really serving. */
const SERVING = {
  707: CANNED,      // MLB 07 | Giants x Pirates      — the reported one
  709: CANNED,      // MLB 09 | Blue Jays x Guardians — the other reported one
  711: LIVE,        // MLB 11 | Reds x Brewers        — fine
  713: FULL_GAME,   // a finished three-hour game
  900: LIVE,        // MLB TORONTO BLUE JAYS
  901: LIVE,        // MLB SAN FRANCISCO GIANTS
};

const stamp = (offsetHours, lengthHours) => {
  const start = new Date(Date.now() + offsetHours * 3600e3);
  const stop = new Date(start.getTime() + lengthHours * 3600e3);
  const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  return `start:${iso(start)} stop:${iso(stop)}`;
};

const CHANNELS = [
  { id: 707, name: `MLB 07 | Giants x Pirates ${stamp(-1, 7)}`, categoryId: 'ppv' },
  { id: 709, name: `MLB 09 | Blue Jays x Guardians ${stamp(-1, 7)}`, categoryId: 'ppv' },
  { id: 711, name: `MLB 11 | Reds x Brewers ${stamp(-1, 7)}`, categoryId: 'ppv' },
  { id: 713, name: `MLB 13 | Mets x Phillies ${stamp(-1, 7)}`, categoryId: 'ppv' },
  { id: 900, name: 'MLB TORONTO BLUE JAYS ᴿᴬᵂ', categoryId: 'team' },
  { id: 901, name: 'MLB SAN FRANCISCO GIANTS ᴿᴬᵂ', categoryId: 'team' },
  /* The trap. A row naming one of the sides, filed under football — the wrong
     Giants, and a library carrying both leagues really does have both. */
  { id: 902, name: 'NFL NEW YORK GIANTS ᴿᴬᵂ', categoryId: 'team' },
];

const portFree = async (port) => {
  try { await get(port, '/'); return false; } catch { return true; }
};

(async () => {
  for (const port of [PORT, FAKE]) {
    // eslint-disable-next-line no-await-in-loop
    if (!await portFree(port)) {
      console.log(`  something is already answering on ${port}. Stop it.`);
      process.exit(1);
    }
  }

  /* ---- a provider ------------------------------------------------------- */
  const asked = [];
  const provider = http.createServer((req, res) => {
    asked.push(req.url);
    const m = /\/live\/[^/]+\/[^/]+\/(\d+)\.m3u8/.exec(req.url || '');
    if (m && SERVING[m[1]]) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(SERVING[m[1]]);
    }
    /* The library, so the box has channels to reason about. */
    if ((req.url || '').includes('get_live_streams')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(CHANNELS.map((c) => ({
        stream_id: c.id, name: c.name, category_id: c.categoryId, stream_icon: '',
      }))));
    }
    if ((req.url || '').includes('get_live_categories')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([
        { category_id: 'ppv', category_name: 'US| MLB PPV EVENTS' },
        { category_id: 'team', category_name: 'US| MLB TEAM PPV' },
      ]));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  });
  await new Promise((r) => provider.listen(FAKE, '127.0.0.1', r));

  /* ---- a box pointed at it ---------------------------------------------- */
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'downloads'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${FAKE}`, username: 'u', password: 'p',
    preferredFormat: 'ts',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', prefs: { tourDone: true }, history: [] }],
  }));

  const box = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      try { await get(PORT, '/api/health'); up = true; } catch { await wait(250); }
    }
    if (!up) throw new Error('the box did not come up');

    /* The library has to be in hand before any of this can reason about it —
       the swap reads the channel list to find the club feed. */
    await get(PORT, '/api/library?tab=live');
    await wait(400);

    /* ---- 1. reading a playlist ------------------------------------------ */
    console.log('\n  what the provider is actually serving');
    for (const [id, what] of [[707, 'the reported Giants game'], [711, 'a game that is fine']]) {
      // eslint-disable-next-line no-await-in-loop
      const seen = (await get(PORT, `/api/live/check?match=${id === 707 ? 'GIANTS' : 'REDS'}`)).body;
      const row = (seen.checked || [])[0];
      console.log(`   ${what}:`, JSON.stringify(row && { name: row.name.slice(0, 26), working: row.working, seconds: row.seconds }));
    }

    const swept = (await get(PORT, '/api/live/check')).body;
    console.log('   swept:', JSON.stringify({ looked: swept.looked, broken: swept.broken }));
    const byId = new Map((swept.checked || []).map((c) => [String(c.id), c]));

    check('the sweep looked at tonight\'s fixture rows', swept.looked === 4,
      String(swept.looked));
    check('and found the two that are filler', swept.broken === 2, String(swept.broken));
    check('the Giants row is called broken', byId.get('707')?.working === false,
      JSON.stringify(byId.get('707')));
    check('the Blue Jays row too', byId.get('709')?.working === false,
      JSON.stringify(byId.get('709')));
    check('with its length, which is what gives it away',
      byId.get('707')?.seconds === 600, String(byId.get('707')?.seconds));
    check('a live window is left alone', byId.get('711')?.working === true,
      JSON.stringify(byId.get('711')));
    /*
     * The half of the test that stops this being "refuse anything finite". A
     * three-hour playlist that ends is a RECORDING of the game, and handing
     * somebody that is right.
     */
    check('and so is a finished three-hour game', byId.get('713')?.working === true,
      JSON.stringify(byId.get('713')));

    /* ---- 2. what it would play instead ---------------------------------- */
    console.log('\n  the club feed it would hand off to');
    console.log('   707 →', JSON.stringify(byId.get('707')?.instead));
    console.log('   709 →', JSON.stringify(byId.get('709')?.instead));
    check('the Giants game points at the Giants feed',
      /SAN FRANCISCO GIANTS/.test(byId.get('707')?.instead?.name || ''),
      JSON.stringify(byId.get('707')?.instead));
    /* The one from the report, verbatim. */
    check('and the Blue Jays game at the Blue Jays feed',
      /TORONTO BLUE JAYS/.test(byId.get('709')?.instead?.name || ''),
      JSON.stringify(byId.get('709')?.instead));
    /* The trap: a row naming Giants, filed under football. */
    check('never the wrong league\'s club of the same name',
      !/NFL/.test(byId.get('707')?.instead?.name || ''),
      JSON.stringify(byId.get('707')?.instead));

    /* ---- 3. and pressing one actually opens the other -------------------- */
    /*
     * The sweep is the plan; this is the thing that happens when somebody
     * presses the game. It must open the club feed AND say so — being moved to
     * a different channel without being told is its own kind of broken.
     */
    console.log('\n  pressing the game');
    const played = (await get(PORT, '/api/play?kind=live&id=709&ext=ts')).body;
    console.log('   ', JSON.stringify({ swapped: played.swapped, url: (played.url || '').slice(0, 40) }));
    check('the box plays something', Boolean(played.url), JSON.stringify(played));
    check('and says it moved you', Boolean(played.swapped), JSON.stringify(played.swapped));
    check('naming the channel it moved you to',
      /TORONTO BLUE JAYS/.test(played.swapped?.to || ''), JSON.stringify(played.swapped));
    /* The stream it opened is the club's, not the fixture's.
     *
     * Read out of the proxy URL, which carries the provider address base64'd
     * in `u` — decoded here rather than pattern-matched, because "900 appears
     * somewhere in this string" would also be satisfied by a timestamp. */
    const opened = (() => {
      try {
        const u = new URL(played.url, 'http://x').searchParams.get('u') || '';
        return Buffer.from(u, 'base64').toString('utf8');
      } catch { return ''; }
    })();
    console.log('    opened:', opened.replace(/\/u\/p\//, '/…/…/'));
    check('and the stream it opened is that one',
      /\/900\./.test(opened), opened || played.url);

    const fine = (await get(PORT, '/api/play?kind=live&id=711&ext=ts')).body;
    console.log('   a working game:', JSON.stringify({ swapped: fine.swapped }));
    check('a channel that is working is not interfered with',
      !fine.swapped && Boolean(fine.url), JSON.stringify(fine));

    /* ---- 4. and it never refuses on a bad answer ------------------------- */
    /*
     * Unreachable is not the same as filler. Refusing to play a channel
     * because the check itself failed would be this fix causing the fault it
     * was written for, so a check that cannot get an answer says nothing.
     */
    console.log('\n  and when the check itself cannot get an answer');
    await new Promise((r) => provider.close(r));
    const blind = (await get(PORT, '/api/play?kind=live&id=707&ext=ts')).body;
    console.log('   ', JSON.stringify({ url: (blind.url || '').slice(0, 40), error: blind.error }));
    check('the channel is still opened rather than refused',
      Boolean(blind.url) && !blind.error, JSON.stringify(blind));

    console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  } finally {
    box.kill('SIGKILL');
    try { provider.close(); } catch { /* already shut */ }
  }
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
