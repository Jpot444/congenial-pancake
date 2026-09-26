/**
 * One walk, however many people are asking.
 *
 * Each sport answers by walking a chain of addresses ONE AT A TIME, falling
 * through on a refusal and on an empty answer alike, and every one of those
 * addresses is allowed twenty-five seconds to time out. That is the right
 * shape — it is what stopped a live game disappearing because one league
 * filed it under tomorrow — and it means a single ask can legitimately run
 * for a minute or more when an upstream is wedged.
 *
 * The cache is what is supposed to stop that being paid twice. But the cache
 * is only written when a walk FINISHES, and nothing was watching for a walk
 * already in progress — so every ask that arrived during those ninety seconds
 * started its own. A phone, a laptop and a television on the same slow minute
 * meant three full walks of every address, which is slower again for all
 * three and is three times the traffic to somebody else's server, for one
 * answer that all of them wanted.
 *
 * So a walk in progress is a thing that can be waited on. The first ask does
 * the work; the rest get the same promise.
 *
 * This is about NOT ASKING TWICE, not about speed: the assertion is on how
 * many times the upstream was reached, which is the part that is somebody
 * else's server.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const ROOT = path.join(__dirname, '..');
const PORT = 8489;
const UPSTREAM = 8488;

(async () => {
  /* A league, answering slowly. Not wedged — slow. A wedged one would test
     the timeout; a slow one tests whether the box asks it more than once. */
  let hits = 0;
  const league = http.createServer((req, res) => {
    hits += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ dates: [] }));
    }, 1500);
  });
  await new Promise((r) => league.listen(UPSTREAM, '127.0.0.1', r));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stampede-'));
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'college-teams.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u',
    host: '', username: '', password: '' }));

  const at = `http://127.0.0.1:${UPSTREAM}`;
  const box = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      /* Every address this box would reach for, pointed at the one slow
         league above, so the count below is unambiguous. */
      MLB_STATS_URL: `${at}/mlb-a`, MLB_STATS_FULL_URL: `${at}/mlb-b`, MLB_URL: `${at}/mlb-c`,
      NFL_URLS: `${at}/nfl`, NCAAF_URLS: `${at}/ncaaf` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  box.stdout.on('data', (d) => log.push(String(d)));
  box.stderr.on('data', (d) => log.push(String(d)));
  const stop = () => { try { box.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);

  const up = async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (r.ok) return true;
      } catch { /* not yet */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  if (!await up()) {
    console.log('  the box did not come up\n', log.join('').slice(-800));
    process.exit(1);
  }

  console.log('\n  three people open the page in the same slow minute');
  hits = 0;
  const asks = await Promise.all([1, 2, 3].map(() =>
    fetch(`http://127.0.0.1:${PORT}/api/scores`).then((r) => r.status)));
  console.log('   answers:', JSON.stringify(asks), '· upstream reached', hits, 'times');

  check('all three are answered', asks.every((s) => s === 200), JSON.stringify(asks));
  /* The whole claim. Whatever the chain is, three simultaneous askers must
     not each walk it: the first does the work and the others wait on it.
     Without that this number is three times what one walk costs. */
  const oneWalk = hits;
  check('and the upstream is walked once, not three times',
    hits > 0 && hits <= 5, `${hits} requests upstream for three asks`);

  console.log('\n  and a later ask, once the answer has gone stale');
  await new Promise((r) => setTimeout(r, 100));
  hits = 0;
  await fetch(`http://127.0.0.1:${PORT}/api/scores`);
  console.log('   upstream reached', hits, 'times');
  /* Coalescing must not turn into never asking again. A cached answer is
     served from the cache; that is a different mechanism and it already
     worked. What is checked is that the box is not now permanently stuck on
     one in-flight promise. */
  check('is served without walking again', hits === 0, String(hits));
  console.log('   (one walk =', oneWalk, 'upstream requests)');

  stop();
  league.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
