/**
 * One node per live channel.
 *
 * The provider answers /live/<user>/<pass>/<id>.m3u8 with a 302 to one of
 * many nodes, a different one on almost every ask, and the nodes number the
 * same channel differently. The direct proxy used to ask the front door on
 * every refresh, so the player's timeline lurched between numberings —
 *
 *   live: 606171 came back renumbered (1958 → 385)
 *   live: 606171 has stayed renumbered (1958 → 389) — taking it as a genuine restart
 *
 * — and every lurch that got through was a skip. This suite stands up a front
 * door that alternates between two nodes 600 segments apart and checks that
 * once the box has been redirected, it stays on that node, and only asks the
 * front door again when the node stops working.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-livepin';
const PORT = 8471;
const PANEL = 9471;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const YEAR = 365 * 86400000;

/* The provider. `asks` counts the front door; `nodeHits` the nodes. */
let asks = 0;
let nextNode = 'a';
const nodeHits = { a: 0, b: 0 };
const down = { a: false, b: false };
const finished = { a: false, b: false };
let tick = 0;
const BASE = { a: 1000, b: 400 };

const playlistFor = (which) => {
  const start = BASE[which] + tick;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:11',
    `#EXT-X-MEDIA-SEQUENCE:${start}`];
  for (let i = 0; i < 6; i += 1) lines.push('#EXTINF:10.0,', `/hls/${which}/4821_${start + i}.ts`);
  if (finished[which]) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
};

function panelServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/player_api.php') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ user_info: {
        auth: 1, status: 'Active', is_trial: '0',
        exp_date: String(Math.floor((Date.now() + YEAR) / 1000)),
        max_connections: '2', active_cons: '0',
      } }));
    }
    if (url.pathname === '/live/u/p/4821.m3u8') {
      asks += 1;
      const which = nextNode;
      nextNode = nextNode === 'a' ? 'b' : 'a';
      res.writeHead(302, { location: `/node/${which}/live/play/tok${asks}/4821` });
      return res.end();
    }
    const hit = /^\/node\/([ab])\/live\/play\/[^/]+\/4821$/.exec(url.pathname);
    if (hit) {
      const which = hit[1];
      nodeHits[which] += 1;
      if (down[which]) {
        res.writeHead(502);
        return res.end('bad gateway');
      }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlistFor(which));
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    return res.end(Buffer.alloc(64, 1));
  });
}

function box() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'cloudflare.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`,
    username: 'u', password: 'p', preferredFormat: 'm3u8',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  /* No ffmpeg, so live goes down the direct proxy — the path that hopped. */
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
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
  req.on('error', reject);
  req.end();
});

const seqOf = (text) => Number((/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text) || [])[1]);
/* Which node each served segment came from, out of the rewritten URIs. */
const nodesIn = (text) => [...new Set(text.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const hit = /u=([A-Za-z0-9_-]+)/.exec(l);
    const url = hit ? Buffer.from(hit[1], 'base64url').toString('utf8') : l;
    return (/\/hls\/([ab])\//.exec(url) || [])[1];
  }))];

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

    const target = Buffer.from(`http://127.0.0.1:${PANEL}/live/u/p/4821.m3u8`)
      .toString('base64url');
    const refresh = () => call(`/stream?u=${target}`);

    /* ---- a dozen refreshes, the channel moving on between them -------- */
    console.log('\n  a dozen refreshes stay on the node the first one was sent to');
    const seqs = [];
    const nodes = new Set();
    for (let i = 0; i < 12; i += 1) {
      const r = await refresh();
      seqs.push(seqOf(r.text));
      nodesIn(r.text).forEach((n) => nodes.add(n));
      if (i % 2 === 1) tick += 1;
    }
    console.log('    sequences', seqs.join(' '), '· front door asked', asks, '· nodes', JSON.stringify(nodeHits));
    check('the front door is asked once', asks === 1, `asked ${asks} times`);
    check('every segment came from one node', nodes.size === 1, [...nodes].join(','));
    check('the numbering only ever goes forwards, a step at a time',
      seqs.every((s, i) => i === 0 || (s >= seqs[i - 1] && s - seqs[i - 1] <= 1)),
      seqs.join(' '));
    check('nothing had to be held or renumbered',
      !/came back renumbered|stayed renumbered|same segment twice/.test(log),
      log.split('\n').filter((l) => /live:/.test(l)).slice(-3).join(' | '));
    check('the pin is in the log', /4821\.m3u8 pinned to 127\.0\.0\.1/.test(log),
      log.split('\n').filter((l) => /live:/.test(l)).slice(-3).join(' | '));

    /* ---- the node dies ------------------------------------------------- */
    console.log('\n  when the node stops answering, the box asks for another');
    const first = [...nodes][0];
    const other = first === 'a' ? 'b' : 'a';
    down[first] = true;
    nextNode = other;
    const moved = await refresh();
    console.log('    status', moved.status, '· seq', seqOf(moved.text), '· nodes', nodesIn(moved.text).join(','));
    check('the refresh still succeeds', moved.status === 200, `status ${moved.status}`);
    check('the front door was asked again', asks === 2, `asked ${asks} times`);
    check('and says why', /lost its node/.test(log),
      log.split('\n').filter((l) => /live:/.test(l)).slice(-3).join(' | '));
    const before = asks;
    for (let i = 0; i < 4; i += 1) await refresh();
    check('and then stays on the new one', asks === before, `asked ${asks - before} more times`);

    /* ---- a node that turns into a finished playlist ------------------- */
    console.log('\n  a node that starts answering with a finished playlist is let go');
    down[first] = false;
    finished[other] = true;
    nextNode = first;
    const askedBefore = asks;
    const after = await refresh();
    check('the front door is asked again', asks === askedBefore + 1,
      `asked ${asks - askedBefore} more times`);
    check('and the live one is served, not the finished one',
      !/EXT-X-ENDLIST/.test(after.text) && nodesIn(after.text)[0] === first,
      after.text.split('\n').slice(0, 4).join(' | '));
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
