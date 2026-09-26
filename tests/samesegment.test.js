/**
 * The same pictures under new numbers.
 *
 * The report that came with the jump said, truthfully, that nothing had gone
 * wrong anywhere it was looking:
 *
 *   playhead moves  none — the media clock only went forwards
 *   playlist reset  none — the window only ever moved forwards
 *   remux session   none (playing directly)
 *
 * All three are consistent with the picture repeating a few seconds, because
 * of the third one. On a DIRECT stream there is no pinned upstream: every
 * playlist refresh is an independent request the provider may answer from a
 * different node, and two nodes agree about the content but not about where
 * in their own numbering it sits. So node B hands back segments it calls
 * 946-951 carrying pictures node A already served as 943-948.
 *
 * Every existing check passes that:
 *
 *   - forwardOnlyPlaylist compares media SEQUENCE numbers, and they rose
 *   - the player's media clock only ever advances, so no seek and no move
 *   - the picture repeats, which is the one thing nothing measures
 *
 * The segment URIs are the giveaway, and the box has them because it rewrites
 * every one on its way past. A URI already served at a lower sequence,
 * arriving again at a higher one, is old content presented as new.
 *
 * Driven against a real box and a provider that really does renumber, because
 * the claim is about what the proxy does with what it is handed.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-samesegment';
const PORT = 8478;
const PANEL = 9478;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const YEAR = 365 * 86400000;

/*
 * The provider. Two "nodes" behind one address, and they disagree about
 * numbering by three segments while agreeing about the content — which is
 * exactly the shape of the fault.
 *
 * `node` is flipped by the suite rather than at random, so what is being
 * tested is the box's reaction and not a coin toss.
 */
let node = 'a';
const playlistFor = (which) => {
  /* Node A calls the same six files 940-945; node B calls them 943-948.
     Same names — the same pictures — different media sequence. */
  const start = which === 'a' ? 940 : 943;
  const files = ['s100.ts', 's101.ts', 's102.ts', 's103.ts', 's104.ts', 's105.ts'];
  return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:11',
    `#EXT-X-MEDIA-SEQUENCE:${start}`,
    ...files.flatMap((f) => ['#EXTINF:11.0,', f]),
  ].join('\n') + '\n';
};

function panelServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/player_api.php') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ user_info: {
        auth: 1, status: 'Active', is_trial: '0',
        exp_date: String(Math.floor((Date.now() + YEAR) / 1000)),
        max_connections: '2', active_cons: '0',
      } }));
    }
    if (/\.m3u8$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlistFor(node));
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    return res.end(Buffer.alloc(64, 1));
  });
  return server;
}

function box() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`,
    username: 'u', password: 'p', preferredFormat: 'ts',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  /* No ffmpeg on PATH, so the box cannot start its own ingest and every live
     channel goes down the DIRECT proxy — which is the only path this fault
     exists on, and the path the report came from. */
  fs.mkdirSync(path.join(DIR, 'nobin'), { recursive: true });
  return spawn(process.execPath, ['server.js'], {
    cwd: DIR,
    detached: true,
    env: { PATH: path.join(DIR, 'nobin'), PORT: String(PORT), HOST: '127.0.0.1',
      HOME: process.env.HOME, DOWNLOADS_ROOT: path.join(DIR, 'store') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const call = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' },
    (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, data });
      });
    });
  req.on('error', reject);
  req.end();
});

(async () => {
  const panel = panelServer();
  await new Promise((r) => panel.listen(PANEL, '127.0.0.1', r));
  const server = box();
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });

  try {
    for (let i = 0; i < 60; i += 1) {
      try { await call('/api/health'); break; } catch { await wait(250); }
    }

    /* The playlist, through the proxy, the way a player fetches it. */
    const target = Buffer.from(`http://127.0.0.1:${PANEL}/live/u/p/4821.m3u8`)
      .toString('base64url');
    const fetchPlaylist = () => call(`/stream?u=${target}`);

    /* ---- node A, twice: nothing to report ----------------------------- */
    /*
     * The same node answering twice is the ordinary case, and it must stay
     * silent. A detector that fires on an unchanged playlist would cry wolf
     * on every refresh of every channel.
     */
    console.log('\n  the same node answering twice says nothing');
    node = 'a';
    let first = await fetchPlaylist();
    check('the playlist comes through', /EXT-X-MEDIA-SEQUENCE:940/.test(first.text),
      first.text.split('\n').slice(0, 4).join(' | '));
    await fetchPlaylist();
    let report = await call('/api/live/report?id=4821');
    console.log('   ', JSON.stringify(report.data.direct || []));
    check('nothing is claimed about a steady stream',
      (report.data.direct || []).length === 0, JSON.stringify(report.data.direct));

    /* ---- and then the other node -------------------------------------- */
    /*
     * The fault. Sequence goes 940 → 943, which is FORWARD, so the guard that
     * exists to stop the window going backwards has nothing to say. The
     * content is the same six files, so the pictures go back three segments.
     */
    console.log('\n  and then a node with its own numbering, three segments on');
    node = 'b';
    const second = await fetchPlaylist();
    check('the sequence went forwards, so the old guard stays quiet',
      /EXT-X-MEDIA-SEQUENCE:943/.test(second.text),
      second.text.split('\n').slice(0, 4).join(' | '));

    report = await call('/api/live/report?id=4821');
    const direct = report.data.direct || [];
    console.log('   ', JSON.stringify(direct));
    check('but the box noticed the content repeat', direct.length === 1,
      JSON.stringify(direct));
    const replays = (direct[0] && direct[0].replays) || [];
    check('and says how far the numbering shifted under it',
      replays.length >= 1 && replays[0].by === 3,
      JSON.stringify(replays));
    check('naming the numbers it was served under, then and now',
      replays.length >= 1 && replays[0].was === 940 && replays[0].now === 943,
      JSON.stringify(replays));
    /* Said in the box's log too, since that is where somebody looking at a
       channel that keeps repeating would end up. */
    check('and it is in the box log, in words',
      /same segment twice under different numbers/.test(log),
      log.split('\n').filter((l) => /live:/.test(l)).slice(-3).join(' | '));

    /* ---- it is about the channel asked for ----------------------------- */
    /*
     * The report is asked per channel. Answering with another channel's
     * troubles would be worse than answering with none.
     */
    console.log('\n  and it belongs to the channel it happened on');
    const other = await call('/api/live/report?id=9999');
    console.log('   ', JSON.stringify(other.data.direct || []));
    check('a different channel is not told about it',
      (other.data.direct || []).length === 0, JSON.stringify(other.data.direct));

    /* ---- and it does not bury the ordinary case ----------------------- */
    /*
     * Back to node A: the pictures now really do go forward again, and the
     * proxy must not keep reporting the old event as though it were new.
     * What is kept is the history of what happened, not a stuck flag.
     */
    console.log('\n  and going back to the first node does not add a new one');
    node = 'a';
    await fetchPlaylist();
    report = await call('/api/live/report?id=4821');
    const again = ((report.data.direct || [])[0] || {}).replays || [];
    console.log('   ', JSON.stringify(again));
    /* Node A calls the files 940-945 again, which is BEHIND 943 — that is the
       renumbering guard's own case, and it holds the playlist rather than
       serving it, so no new content-replay is recorded. */
    check('the one that happened is still on the record',
      again.length >= 1, JSON.stringify(again));
    check('and it did not multiply', again.length === replays.length,
      `${replays.length} -> ${again.length}`);
  } catch (err) {
    console.log('  HARNESS ERROR', err.message);
    fails.push('harness');
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    panel.close();
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
