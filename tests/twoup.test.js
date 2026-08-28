/**
 * Two logins, two things at once — the claim the second subscription buys.
 *
 * Adding an account to the pool was the easy half. The half that actually
 * changes what the house can do is every rule written when there was one
 * connection, because those rules were not written as "wait for a free slot",
 * they were written as "wait until nothing is playing" — and on a two-login
 * box those are different sentences.
 *
 * The one that mattered, reported from the sofa: a film playing and a
 * download sitting at "Waiting for the connection" for the length of it, with
 * a whole free login next to it. Two separate causes, and this suite exists
 * to keep both shut.
 *
 *   1. The queue's grace period — meant as "don't bounce a download up and
 *      down while somebody flips channels" — waited on the last moment
 *      ANYTHING was streaming. That timestamp is refreshed on every check
 *      while a film plays, so the window never opened.
 *
 *   2. A converted film took no slot at all, so the pool's own count could
 *      not see it. That one hurts in the opposite direction: the box thinks
 *      it is idle and sends the next stream down a login already in use.
 *
 * Both are tested the only way that means anything — a real box, a real
 * download, and a real stream held open across it.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-twoup';
const PORT = 8496;
const PANEL = 9496;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const YEAR = 365 * 86400000;
const USERS = { u: 'p', u2: 'p2' };

/* The provider: a panel that admits two logins, a film that never ends, and
   a file small enough to arrive while the test is watching. */
function panelServer() {
  /* Which logins have a pipe open right now. This is the provider's side of
     the count, and it is what catches the box sending two streams down one
     account: the second would be a second open connection on the same login,
     which is exactly what a single-connection account refuses. */
  const open = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/player_api.php') {
      const user = url.searchParams.get('username');
      const ok = USERS[user] === url.searchParams.get('password');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok
        ? { user_info: { auth: 1, status: 'Active', is_trial: '0',
          exp_date: String(Math.floor((Date.now() + YEAR) / 1000)),
          max_connections: '1', active_cons: String(open.get(user) || 0) } }
        : { user_info: { auth: 0 } }));
    }

    // /movie/<user>/<pass>/<id>.<ext>
    const parts = url.pathname.split('/').filter(Boolean);
    const user = parts[1] || '';
    open.set(user, (open.get(user) || 0) + 1);
    res.on('close', () => open.set(user, Math.max(0, (open.get(user) || 1) - 1)));
    server.peak = Math.max(server.peak || 0, open.get(user));

    if (/^endless/.test(parts[3] || '')) {
      // A film being watched: bytes for as long as anybody is reading.
      res.writeHead(200, { 'content-type': 'video/mp4' });
      const tick = setInterval(() => res.write(Buffer.alloc(4096, 1)), 200);
      res.on('close', () => clearInterval(tick));
      return undefined;
    }
    const body = Buffer.alloc(64 * 1024, 7);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
    return res.end(body);
  });
  server.peak = 0;
  return server;
}

function boxFor(accounts) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`,
    username: accounts[0].username, password: accounts[0].password,
    preferredFormat: 'm3u8', accounts,
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  return spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      DOWNLOADS_ROOT: path.join(DIR, 'store') },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const call = (p, method = 'GET', body) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: p, method,
    headers: body ? { 'content-type': 'application/json' } : {},
  }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let data = {};
      try { data = JSON.parse(text); } catch { /* not json */ }
      resolve({ status: res.statusCode, data });
    });
  });
  req.on('error', reject);
  if (body) req.write(JSON.stringify(body));
  req.end();
});

/** Open a film and keep reading it, the way a player does. */
function watch(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${url}`, (res) => {
      let bytes = 0;
      res.on('data', (d) => { bytes += d.length; });
      resolve({ stop: () => req.destroy(), read: () => bytes, status: res.statusCode });
    });
    req.on('error', reject);
  });
}

async function jobs() {
  const list = await call('/api/downloads');
  return Object.fromEntries((list.data.items || []).map((j) => [j.id, j]));
}

/* Fourteen seconds is the number that makes a held download distinguishable
   from a slow one: the queue pumps every three, and the grace window is
   eight. Anything that has not moved by then is not being slow, it is being
   held back. */
const LONG_ENOUGH = 14000;

(async () => {
  const provider = panelServer();
  await new Promise((r) => provider.listen(PANEL, '127.0.0.1', r));

  const upFor = async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        await call('/');
        return true;
      } catch {
        await wait(250);
      }
    }
    return false;
  };

  /* ─── one login: the old behaviour, which was never wrong ─────────────── */
  console.log('\n  one login, a film, and a download behind it');
  let box = boxFor([{ id: 'p1', host: `http://127.0.0.1:${PANEL}`, username: 'u', password: 'p' }]);
  await upFor();

  let play = await call('/api/play?kind=movie&id=endless1&ext=mp4');
  let held = await watch(play.data.url);
  await wait(1500);
  check('the film plays', held.read() > 0, String(held.read()));

  await call('/api/downloads', 'POST', {
    name: 'Something Else', kind: 'movie', streamId: '55', ext: 'mp4', profileId: 'own1',
  });
  await wait(LONG_ENOUGH);
  let after = Object.values(await jobs())[0] || {};
  console.log('   one login:', JSON.stringify({ status: after.status, bytes: after.bytes }));
  check('the download waits, because there is nothing for it to run on',
    after.status === 'queued' || after.status === 'paused', JSON.stringify(after));
  check('and the box says it has no room', (await call('/api/epg/now?ids=1')).data.busy === true,
    JSON.stringify((await call('/api/epg/now?ids=1')).data.busy));

  held.stop();
  await wait(12000);
  after = Object.values(await jobs())[0] || {};
  console.log('   after the film stops:', JSON.stringify({ status: after.status }));
  check('and takes its turn the moment the film stops',
    after.status === 'done' || after.status === 'downloading', JSON.stringify(after));
  box.kill();
  await wait(700);

  /* ─── two logins: the thing that was bought ───────────────────────────── */
  console.log('\n  two logins, a film, and a download beside it');
  provider.peak = 0;
  box = boxFor([
    { id: 'p1', host: `http://127.0.0.1:${PANEL}`, username: 'u', password: 'p' },
    { id: 'p2', host: `http://127.0.0.1:${PANEL}`, username: 'u2', password: 'p2', label: 'Trial' },
  ]);
  await upFor();

  play = await call('/api/play?kind=movie&id=endless1&ext=mp4');
  held = await watch(play.data.url);
  await wait(1500);
  check('the film plays', held.read() > 0, String(held.read()));

  const free = await call('/api/providers');
  console.log('   pool:', JSON.stringify({ free: free.data.free, capacity: free.data.capacity,
    inUse: free.data.inUse }));
  check('the box knows the film is holding one of the two logins',
    free.data.inUse === 1 && free.data.free === 1, JSON.stringify(free.data));

  await call('/api/downloads', 'POST', {
    name: 'Something Else', kind: 'movie', streamId: '55', ext: 'mp4', profileId: 'own1',
  });
  await wait(LONG_ENOUGH);
  after = Object.values(await jobs())[0] || {};
  console.log('   two logins:', JSON.stringify({ status: after.status, bytes: after.bytes }));
  /* The whole feature, in one assertion: the download did not wait for the
     film. This is what was failing from the sofa — "still getting a waiting
     for connection when I play a movie at the same time". */
  check('the download runs BESIDE the film rather than waiting for it',
    after.status === 'done' || after.status === 'downloading',
    JSON.stringify(after));
  check('and the film never stopped for it', held.read() > 0, String(held.read()));

  /* The provider's own count is the check that cannot be fooled: one open
     connection per login is what a single-connection account allows, and two
     on the same one is the failure this pool exists to avoid. */
  console.log('   the provider\'s own peak per login:', provider.peak);
  check('with each login carrying one connection, never two on the same one',
    provider.peak <= 1, String(provider.peak));

  held.stop();
  box.kill();
  provider.close();

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
