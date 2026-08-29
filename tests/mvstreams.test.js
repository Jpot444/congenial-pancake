/**
 * Four cells, one box: why a multiview cell used to die a few minutes in.
 *
 * The report was "stream failed — fragLoadError after playing for a few
 * minutes", which is the shape of a cell that has been quietly cut off and
 * then run out of the buffer it already had. Two causes, both on the server
 * and both from the same assumption — that there is only ever one viewer:
 *
 *   1. Starting a conversion killed EVERY other conversion on the box, so
 *      the second converted title in a grid killed the first.
 *   2. Closing one cell called /api/remux/stop, which stopped every other
 *      cell's conversion too.
 *
 * And one on the client: any fatal error ended the cell for good, so the
 * ordinary bad luck of four cells sharing one link was permanent.
 *
 * The server half runs against a real instance with a fake ffmpeg. The
 * sweep's decision is lifted out and exercised directly, because "who gets
 * killed" is arithmetic worth pinning to the case rather than to a symptom.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('./playwright.js');
const { openMultiview, multiviewOffered } = require('./mv.js');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-mv';
const PORT = 8487;
const UI = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  /* ---- who the sweep kills, decided directly --------------------------- */
  console.log('\n  clearing the way for a new conversion');
  const start = SERVER.indexOf('  for (const [id, sess] of [...remuxSessions]) {');
  if (start < 0) throw new Error('the sweep moved');
  const block = SERVER.slice(start, SERVER.indexOf('\n  }', start) + 4);
  const ACTIVE = Number(/const SESSION_ACTIVE_MS = ([\d_]+);/.exec(SERVER)[1].replace(/_/g, ''));

  const sweep = (sessions, replaces) => {
    const killed = [];
    // eslint-disable-next-line no-new-func
    new Function('remuxSessions', 'killSession', 'replaces', 'SESSION_ACTIVE_MS',
      block)(new Map(Object.entries(sessions)), (id) => killed.push(id), replaces, ACTIVE);
    return killed.sort();
  };

  const now = Date.now();
  const world = {
    // The cell whose conversion is being replaced by this very call.
    mine: { lastAccess: now, live: false },
    // Another cell, mid-film, fetching segments right now.
    neighbour: { lastAccess: now - 3000, live: false },
    // A live channel in a third cell.
    channel: { lastAccess: now - 90_000, live: true },
    // Nobody has asked this for anything in a long time.
    abandoned: { lastAccess: now - 5 * 60_000, live: false },
  };
  const killed = sweep(world, 'mine');
  console.log('   killed:', JSON.stringify(killed));
  check('the conversion being replaced is cleared away',
    killed.includes('mine'), JSON.stringify(killed));
  check('and so is one nobody is watching — ffmpeg must not grind on alone',
    killed.includes('abandoned'), JSON.stringify(killed));
  check('but the cell playing beside it is left alone — THIS is the bug',
    !killed.includes('neighbour'), JSON.stringify(killed));
  check('and the live channel is never touched',
    !killed.includes('channel'), JSON.stringify(killed));

  const noneNamed = sweep(world, '');
  check('naming nothing still spares everyone who is watching',
    noneNamed.join() === 'abandoned', JSON.stringify(noneNamed));
  check('an active session is one fetched from within half a minute',
    ACTIVE >= 10_000 && ACTIVE <= 60_000, String(ACTIVE));

  /* ---- and the same, against a running server -------------------------- */
  //
  // The archive path is the cheapest way to get two real conversions going
  // on one box: local files, no provider, and a fake ffmpeg standing in for
  // the encoder.
  console.log('\n  two conversions on one box');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'drive'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  const rec = (p, title) => JSON.stringify({
    path: p, dir: '.', title, date: '2020-01-01', year: 2020, tags: [],
    duration: 3600, size: 9, width: 640, height: 480,
    container: 'avi', vcodec: 'mpeg4', acodec: 'mp3', playback: 'transcode',
  });
  for (const name of ['One.avi', 'Two.avi']) {
    fs.writeFileSync(path.join(DIR, 'drive', name), 'FAKE');
  }
  fs.writeFileSync(path.join(DIR, 'library-index.ndjson'),
    [rec('One.avi', 'One'), rec('Two.avi', 'Two')].join('\n') + '\n');
  // Writes a playable-looking playlist, then keeps "converting" long enough
  // for the test to ask questions about it.
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
args=("$@")
out="\${args[-1]}"
dir=$(dirname "$out")
printf 'x' > "$dir/seg00000.m4s"
printf 'x' > "$dir/seg00001.m4s"
printf '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXTINF:4.000,\\nseg00000.m4s\\n#EXTINF:4.000,\\nseg00001.m4s\\n' > "$out"
sleep 120
exit 0
`, { mode: 0o755 });

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      ARCHIVE_ROOT: path.join(DIR, 'drive'),
      PATH: `${path.join(DIR, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await wait(1500);
  const get = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  const alive = async (id) => (await get(`/api/remux/status?id=${id}`)).status === 200;

  try {
    const one = JSON.parse((await get(
      `/api/archive/play?path=One.avi&profileId=own1`)).body);
    const two = JSON.parse((await get(
      `/api/archive/play?path=Two.avi&profileId=own1`)).body);
    check('two titles get two separate conversions',
      one.session && two.session && one.session !== two.session,
      JSON.stringify({ one: one.session, two: two.session }));
    check('and starting the second does not kill the first',
      (await alive(one.session)) && (await alive(two.session)),
      `one alive: ${await alive(one.session)}, two alive: ${await alive(two.session)}`);

    // Closing one cell.
    await get(`/api/remux/stop?id=${two.session}`);
    check('stopping one cell stops that cell', !(await alive(two.session)));
    check('and leaves the cell beside it playing', await alive(one.session));

    // The player closing still means everything.
    await get('/api/remux/stop');
    check('stopping without naming one still clears the box',
      !(await alive(one.session)));
  } finally {
    server.kill('SIGKILL');
  }

  /* ---- a cell picks itself back up ------------------------------------- */
  //
  // Driven against a stubbed hls.js: what is on trial is our error handling,
  // not the library's, and a real fatal fragment error is not something a
  // test can reliably provoke.
  console.log('\n  a cell that loses its stream');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.goto(UI, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  const install = () => page.evaluate(() => {
    const calls = [];
    class FakeHls {
      constructor(config) { this.config = config; this.handlers = {}; calls.push('new'); }
      loadSource() { calls.push('loadSource'); }
      attachMedia() { calls.push('attachMedia'); }
      on(evt, cb) { (this.handlers[evt] ||= []).push(cb); }
      startLoad(pos) { calls.push(`startLoad:${pos}`); }
      recoverMediaError() { calls.push('recoverMediaError'); }
      destroy() { calls.push('destroy'); }
      fire(evt, data) { (this.handlers[evt] || []).forEach((cb) => cb(evt, data)); }
    }
    FakeHls.isSupported = () => true;
    FakeHls.Events = { ERROR: 'hlsError', FRAG_BUFFERED: 'hlsFragBuffered' };
    FakeHls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError',
      OTHER_ERROR: 'otherError' };
    window.Hls = FakeHls;
    window.__calls = calls;
  });
  await install();

  // The grid has to be open for there to be cells at all.
  await page.evaluate(() => {
    state.config.mode = 'xtream';
    state.downloads = { items: [], active: null, queued: 0 };
    state.library.live = {
      categories: [{ id: 'c1', name: 'Sports' }],
      items: [{ kind: 'live', id: 1, name: 'A Channel', logo: '', categoryId: 'c1' }],
    };
    location.hash = '#/live';
    render();
  });
  await wait(500);
  await openMultiview(page);
  await wait(600);
  check('the grid opens, so there are cells to test',
    (await page.evaluate(() => multiview.cells.length)) > 0);

  // A cell, attached the way multiview attaches a live channel.
  const attachCell = () => page.evaluate(() => {
    window.__calls.length = 0;
    const cell = multiview.cells[0];
    cell.remux = '';
    multiview.attach(cell, '/fake.m3u8', 'm3u8', false, false);
    window.__engine = cell.engine;
    return { attached: Boolean(cell.engine), calls: [...window.__calls] };
  });
  const cellState = () => page.evaluate(() => {
    const cell = multiview.cells[0];
    return { note: cell.note.textContent, hidden: cell.note.hidden, ok: cell.ok,
      engine: Boolean(cell.engine), calls: [...window.__calls] };
  });
  const boom = (type) => page.evaluate((t) => {
    window.__engine.fire('hlsError', { fatal: true, type: t, details: 'fragLoadError' });
  }, type);

  await attachCell();
  await boom('networkError');
  await wait(150);
  let now2 = await cellState();
  console.log('   after one failure:', JSON.stringify(now2));
  check('a lost fragment does not end the cell', now2.engine, JSON.stringify(now2));
  check('it says it is reconnecting, and counts',
    /Reconnecting/.test(now2.note) && /1 of 5/.test(now2.note), now2.note);
  await wait(1400);
  now2 = await cellState();
  check('and it really asks the stream to load again',
    now2.calls.some((c) => c.startsWith('startLoad')), JSON.stringify(now2.calls));
  check('rejoining a channel at the live edge, not where it fell off',
    now2.calls.includes('startLoad:-1'), JSON.stringify(now2.calls));

  // Playing again refills the budget: a stream that hiccups once an hour
  // must recover every time, not five times ever.
  await page.evaluate(() => window.__engine.fire('hlsFragBuffered', {}));
  await boom('networkError');
  await wait(150);
  now2 = await cellState();
  check('a cell that recovered gets its full budget back',
    /1 of 5/.test(now2.note), now2.note);

  // But a stream that is genuinely gone stops, rather than retrying for ever.
  for (let i = 0; i < 6; i += 1) {
    await boom('networkError');
    await wait(60);
  }
  now2 = await cellState();
  console.log('   after repeated failure:', JSON.stringify(now2));
  check('a stream that never comes back does stop trying',
    /Stream failed/.test(now2.note), now2.note);
  check('and the engine is torn down rather than left half-alive',
    now2.engine === false, JSON.stringify(now2));

  // A media error takes the other branch.
  await attachCell();
  await boom('mediaError');
  await wait(150);
  now2 = await cellState();
  check('a decode fault is recovered in place instead',
    now2.calls.includes('recoverMediaError') && now2.engine, JSON.stringify(now2.calls));

  /* ---- and the cell names what it replaces ----------------------------- */
  console.log('\n  what the client asks the box for');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('a cell tells the box which conversion it is replacing',
    /const replaces = cell\.remux \|\| '';/.test(APP));
  check('and stops only its own when it closes',
    /remux\/stop\?id=\$\{encodeURIComponent\(cell\.remux\)\}/.test(APP));
  check('a seek names the session it is seeking within',
    /const replaces = lastRemux\.session \|\| '';/.test(APP));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
