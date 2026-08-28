/**
 * The archive drive, ported from the other session's branch onto current main.
 *
 * Half of this runs a dedicated server instance against a fake drive, because
 * "traversal is refused" and "a Range request gets a 206" are claims about a
 * running server. The other half drives the real UI against the real index
 * (5,853 entries) with the drive not mounted — the state this feature spends
 * most of its life in, and the one whose message has to be clear.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium, devices } = require('./playwright.js');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-arc';
const PORT = 8483;
const UI = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, { headers }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  }).on('error', reject);
});

(async () => {
  const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  /* ---- the encode decision --------------------------------------------- */
  //
  // A third of the drive is MPEG-4 ASP, which no browser decodes; copying it
  // through produces a black rectangle with working audio.
  console.log('\n  what gets encoded and what gets copied');
  check('h264 and hevc pass through, everything else is encoded',
    /PASSTHROUGH_VIDEO = new Set\(\['h264', 'hevc', 'h265'\]\)/.test(SERVER));
  check('the encode is x264 veryfast — measured 4.7x realtime on the Pi',
    /needsVideoEncode[\s\S]{0,200}'-c:v', 'libx264',\s*'-preset', 'veryfast'/.test(SERVER));
  check('and pinned to yuv420p, the one pixel format iOS reliably decodes',
    /'-pix_fmt', 'yuv420p'/.test(SERVER));
  check('provider remuxes still copy — the branch defaults to copy',
    /\} else \{\s*args\.push\('-c:v', 'copy'\);/.test(SERVER));

  /* ---- a server against a fake drive ------------------------------------ */
  console.log('\n  a server with a drive plugged in');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'drive', '2024'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'drive', '2023'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [
      { id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] },
      { id: 'gst1', name: 'Ben', emoji: '', color: '', prefs: {}, history: [] },
    ],
  }));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  fs.writeFileSync(path.join(DIR, 'drive', '2024', 'Alpha_Game.mp4'), 'FAKEMOVIEBYTES-ALPHA');
  fs.writeFileSync(path.join(DIR, 'drive', '2023', 'Beta_Game.avi'), 'FAKEMOVIEBYTES-BETA');
  fs.writeFileSync(path.join(DIR, 'drive', 'not-indexed.mp4'), 'SHOULD NEVER BE SERVED');
  const rec = (p, extra) => JSON.stringify({
    path: p, dir: path.dirname(p), title: path.basename(p).replace(/\.\w+$/, '').replace(/_/g, ' '),
    date: p.includes('2024') ? '2024-05-01' : '2023-04-01',
    year: p.includes('2024') ? 2024 : 2023, tags: ['game'], duration: 5400,
    size: 20, width: 640, height: 480, ...extra,
  });
  fs.writeFileSync(path.join(DIR, 'library-index.ndjson'), [
    rec('2024/Alpha_Game.mp4', { container: 'mp4', vcodec: 'h264', acodec: 'aac', playback: 'direct' }),
    rec('2023/Beta_Game.avi', { container: 'avi', vcodec: 'mpeg4', acodec: 'mp3', playback: 'transcode' }),
  ].join('\n') + '\n');

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      ARCHIVE_ROOT: path.join(DIR, 'drive') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await wait(1500);

  try {
    const st = JSON.parse((await get('/api/archive/status?profileId=own1')).body);
    console.log('   status:', JSON.stringify(st));
    check('the index is loaded and the drive shows as mounted',
      st.indexed === 2 && st.mounted === true, JSON.stringify(st));

    const root = JSON.parse((await get('/api/archive/browse?profileId=own1')).body);
    check('browsing the root shows the year folders, newest first',
      root.subdirs.map((d) => d.name).join(',') === '2024,2023', JSON.stringify(root.subdirs));

    const yr = JSON.parse((await get('/api/archive/browse?dir=2024&profileId=own1')).body);
    check('and a folder lists its files', yr.items.length === 1
      && yr.items[0].title === 'Alpha Game', JSON.stringify(yr.items));

    const found = JSON.parse((await get('/api/archive/search?q=beta&profileId=own1')).body);
    check('search reaches every file from anywhere', found.total === 1
      && found.items[0].title === 'Beta Game', JSON.stringify(found));

    const play = JSON.parse((await get(`/api/archive/play?path=${encodeURIComponent('2024/Alpha_Game.mp4')}&profileId=own1`)).body);
    console.log('   direct play:', JSON.stringify(play));
    check('a browser-native file is served directly, not converted',
      play.mode === 'direct' && /^\/archive\/file\?path=/.test(play.url), JSON.stringify(play));

    const whole = await get(play.url);
    check('and the bytes really come off the drive', whole.status === 200
      && whole.body === 'FAKEMOVIEBYTES-ALPHA', `${whole.status}: ${whole.body.slice(0, 30)}`);
    const range = await get(play.url, { Range: 'bytes=0-3' });
    check('range requests work, which is what makes seeking free',
      range.status === 206 && range.body === 'FAKE', `${range.status}: ${range.body}`);

    // The security boundary. `path` comes straight off a query string.
    console.log('\n  what is refused');
    const t1 = await get('/archive/file?path=' + encodeURIComponent('../server.js'));
    const t2 = await get('/archive/file?path=' + encodeURIComponent('not-indexed.mp4'));
    const t3 = JSON.parse((await get('/api/archive/play?path=' + encodeURIComponent('../../etc/passwd') + '&profileId=own1')).body);
    check('path traversal out of the drive is refused', t1.status === 404, String(t1.status));
    check('a real file the index does not know is refused too — this is a', t2.status === 404, String(t2.status));
    console.log('       player, not a general file server');
    check('and play refuses anything outside the index', Boolean(t3.error), JSON.stringify(t3));

    // The drive is Hunter's. The gate follows the reports pattern: the box is
    // unauthenticated by design, so this is honesty about whose tab it is,
    // not a security boundary.
    console.log('\n  whose tab it is');
    const asGuest = await get('/api/archive/browse?profileId=gst1');
    const asNobody = await get('/api/archive/browse');
    check('another profile is refused', asGuest.status === 403, String(asGuest.status));
    check('and no profile at all is refused too', asNobody.status === 403, String(asNobody.status));

    // No ffmpeg on this box, so a transcode title must say so rather than 500.
    const enc = await get(`/api/archive/play?path=${encodeURIComponent('2023/Beta_Game.avi')}&profileId=own1`);
    check('a convert-on-play title without ffmpeg fails with a plain reason',
      enc.status === 501 && /ffmpeg/.test(enc.body), `${enc.status}: ${enc.body}`);

    // Thumbnails, on a box with no ffmpeg: refused in words, not a 500.
    console.log('\n  thumbnails');
    const thumbNo = await get(`/api/archive/thumb?path=${encodeURIComponent('2024/Alpha_Game.mp4')}&profileId=own1`);
    check('a thumbnail without ffmpeg fails with a plain reason',
      thumbNo.status === 501 && /ffmpeg/.test(thumbNo.body), `${thumbNo.status}: ${thumbNo.body}`);
    const thumbUnknown = await get('/api/archive/thumb?path=nope.mp4&profileId=own1');
    check('and an unindexed path is refused', thumbUnknown.status === 404,
      String(thumbUnknown.status));
    const thumbGuest = await get(`/api/archive/thumb?path=${encodeURIComponent('2024/Alpha_Game.mp4')}&profileId=gst1`);
    check('and the owner gate covers it like the rest', thumbGuest.status === 403,
      String(thumbGuest.status));

    // Unplug the drive: the index survives, playing does not, and it says why.
    fs.renameSync(path.join(DIR, 'drive'), path.join(DIR, 'drive-unplugged'));
    const gone = await get(`/api/archive/play?path=${encodeURIComponent('2024/Alpha_Game.mp4')}&profileId=own1`);
    const stGone = JSON.parse((await get('/api/archive/status?profileId=own1')).body);
    check('an unplugged drive still browses — the index outlives the mount',
      stGone.indexed === 2 && stGone.mounted === false, JSON.stringify(stGone));
    check('but playing says plainly that the drive is not plugged in',
      gone.status === 503 && /not mounted|plugged/.test(gone.body), `${gone.status}: ${gone.body}`);
  } finally {
    server.kill('SIGKILL');
  }
  if (fails.length && serverLog) console.log('  server log:', serverLog.slice(-500));

  /* ---- thumbnails with ffmpeg present ----------------------------------- */
  //
  // A second instance whose fake ffmpeg writes a JPEG to the output path the
  // way the real one would, logging each run — so caching and same-path
  // dedupe are counted rather than assumed.
  console.log('\n  thumbnails, with ffmpeg');
  const DIR2 = '/tmp/portal-arc2';
  const PORT2 = 8484;
  fs.rmSync(DIR2, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR2, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR2, 'drive'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR2, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR2, f));
  }
  fs.writeFileSync(path.join(DIR2, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR2, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  fs.writeFileSync(path.join(DIR2, 'drive', 'Film.mp4'), 'FAKEMOVIE');
  fs.writeFileSync(path.join(DIR2, 'library-index.ndjson'), JSON.stringify({
    path: 'Film.mp4', dir: '.', title: 'Film', date: '2024-01-01', year: 2024,
    tags: [], duration: 3600, size: 9, width: 640, height: 480,
    container: 'mp4', vcodec: 'h264', acodec: 'aac', playback: 'direct',
  }) + '\n');
  fs.writeFileSync(path.join(DIR2, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
echo "run" >> "${DIR2}/thumb-calls.log"
sleep 0.3
args=("$@")
printf 'JPEGDATA' > "\${args[-1]}"
exit 0
`, { mode: 0o755 });

  const server2 = spawn('node', ['server.js'], {
    cwd: DIR2,
    env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1',
      ARCHIVE_ROOT: path.join(DIR2, 'drive'),
      PATH: `${path.join(DIR2, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await wait(1500);
  const get2 = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT2}${p}`, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode,
        body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }).on('error', reject);
  });
  try {
    const thumbPath = `/api/archive/thumb?path=${encodeURIComponent('Film.mp4')}&profileId=own1`;
    // Two at once for the same frame: one ffmpeg, both answered.
    const [a, b] = await Promise.all([get2(thumbPath), get2(thumbPath)]);
    const runs = () => fs.readFileSync(path.join(DIR2, 'thumb-calls.log'), 'utf8')
      .split('\n').filter(Boolean).length;
    check('a frame is cut and served as a JPEG', a.status === 200
      && a.headers['content-type'] === 'image/jpeg' && a.body === 'JPEGDATA',
      `${a.status} ${a.headers['content-type']} ${a.body.slice(0, 12)}`);
    check('two simultaneous requests share one ffmpeg', b.status === 200 && runs() === 1,
      `${b.status}, ${runs()} runs`);
    const again = await get2(thumbPath);
    check('and a later request is served from the cache, no ffmpeg at all',
      again.status === 200 && runs() === 1, `${again.status}, ${runs()} runs`);
    check('cached hard — the frame never changes',
      /immutable/.test(again.headers['cache-control'] || ''),
      String(again.headers['cache-control']));
  } finally {
    server2.kill('SIGKILL');
  }

  /* ---- the whole episode, every time ------------------------------------ */
  //
  // The lip-sync saga's conclusion, pinned as behaviour. Every way of asking
  // ffmpeg to START MID-FILE on these decades-old rips eventually landed the
  // tracks apart — demuxer seek, sequential read-and-discard, content-clock
  // rebuild. Playing from the top never has. So the conversion now IS the
  // whole episode: one session per file, keyed by the file, begun at zero,
  // and a resume or seek joins the session already running. Three claims,
  // each once bitten: the same file twice is ONE ffmpeg; a resume point in
  // the request changes nothing; and no invocation ever carries -ss.
  console.log('\n  the whole episode, every time');
  const DIR3 = '/tmp/portal-arc3';
  const PORT3 = 8485;
  fs.rmSync(DIR3, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR3, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR3, 'drive'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR3, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR3, f));
  }
  fs.writeFileSync(path.join(DIR3, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR3, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  fs.writeFileSync(path.join(DIR3, 'drive', 'Show.avi'), 'FAKESHOW');
  fs.writeFileSync(path.join(DIR3, 'drive', 'Other.avi'), 'FAKEOTHER');
  const rec3 = (p, title) => JSON.stringify({
    path: p, dir: '.', title, date: '2008-01-01', year: 2008,
    tags: [], duration: 2135, size: 8, width: 640, height: 480,
    container: 'avi', vcodec: 'mpeg4', acodec: 'mp3', playback: 'transcode',
  });
  fs.writeFileSync(path.join(DIR3, 'library-index.ndjson'),
    [rec3('Show.avi', 'Show'), rec3('Other.avi', 'Other')].join('\n') + '\n');
  // A conversion that behaves like the real one from the outside: writes a
  // playlist with two segments so the server calls it started, keeps
  // "converting" for a few seconds, then finishes with an ENDLIST — and logs
  // every invocation's full argument list, which is what the -ss and
  // one-run claims are judged on.
  fs.writeFileSync(path.join(DIR3, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
echo "$@" >> "${DIR3}/conv-calls.log"
args=("$@")
out="\${args[-1]}"
dir=$(dirname "$out")
printf 'x' > "$dir/seg00000.m4s"
printf 'x' > "$dir/seg00001.m4s"
printf '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXTINF:4.000,\\nseg00000.m4s\\n#EXTINF:4.000,\\nseg00001.m4s\\n' > "$out"
sleep 3
printf '#EXT-X-ENDLIST\\n' >> "$out"
exit 0
`, { mode: 0o755 });

  const server3 = spawn('node', ['server.js'], {
    cwd: DIR3,
    env: { ...process.env, PORT: String(PORT3), HOST: '127.0.0.1',
      ARCHIVE_ROOT: path.join(DIR3, 'drive'),
      PATH: `${path.join(DIR3, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await wait(1500);
  const get3 = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT3}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    const playPath = `/api/archive/play?path=${encodeURIComponent('Show.avi')}&profileId=own1`;
    const first = JSON.parse((await get3(playPath)).body);
    console.log('   first play:', JSON.stringify(first).slice(0, 200));
    check('a conversion begins, named for the file itself',
      first.mode === 'hls' && /^arc-[0-9a-f]{12}$/.test(first.session || ''),
      JSON.stringify(first));
    check('and it begins at the beginning — offset zero, whatever the history says',
      first.offset === 0, String(first.offset));

    // The decisive request: a resume deep into the episode. This used to
    // start a second conversion AT the offset — the exact fault.
    const resumed = JSON.parse((await get3(`${playPath}&start=1200`)).body);
    const convRuns = () => fs.readFileSync(path.join(DIR3, 'conv-calls.log'), 'utf8')
      .split('\n').filter(Boolean);
    check('a resume joins the same session instead of starting a rival',
      resumed.session === first.session && resumed.offset === 0,
      JSON.stringify({ first: first.session, resumed: resumed.session, offset: resumed.offset }));
    check('the same file twice is still one ffmpeg', convRuns().length === 1,
      `${convRuns().length} runs`);
    check('and no invocation ever asks ffmpeg to start mid-file',
      convRuns().every((line) => !/\s-ss\s/.test(` ${line} `)),
      convRuns().join(' | ').slice(0, 200));

    const status3 = JSON.parse((await get3(`/api/remux/status?id=${first.session}`)).body);
    check('the client can watch the conversion pass its resume point',
      status3.seconds === 8 && status3.complete === false, JSON.stringify(status3));

    // Nobody fetches a segment from here on — the viewer has walked away —
    // and the conversion still runs to its end.
    await wait(4000);
    const done3 = JSON.parse((await get3(`/api/remux/status?id=${first.session}`)).body);
    check('the conversion runs to the end with nobody watching',
      done3.complete === true, JSON.stringify(done3));
  } finally {
    // Graceful, not SIGKILL: the exit handler sweeps every session, and the
    // claim is that the sweep now KEEPS a finished episode's directory.
    server3.kill('SIGTERM');
  }
  await wait(500);

  // A finished conversion is a cache. It outlives its session, and the
  // server itself: the next sitting — days later, after a reboot — finds
  // the episode already converted and resume costs nothing.
  console.log('\n  the finished episode is kept');
  const arcDirs = () => fs.readdirSync(path.join(DIR3, 'hls'))
    .filter((n) => n.startsWith('arc-'));
  check('the converted episode survives the server shutting down',
    arcDirs().length === 1
    && fs.readFileSync(path.join(DIR3, 'hls', arcDirs()[0], 'index.m3u8'), 'utf8')
      .includes('#EXT-X-ENDLIST'),
    JSON.stringify(arcDirs()));

  const PORT4 = 8486;
  const server4 = spawn('node', ['server.js'], {
    cwd: DIR3,
    env: { ...process.env, PORT: String(PORT4), HOST: '127.0.0.1',
      ARCHIVE_ROOT: path.join(DIR3, 'drive'),
      // An allowance of effectively nothing, so the eviction is observable:
      // the moment a NEW conversion starts, every unheld cached episode is
      // over the cap and the oldest goes.
      ARCHIVE_CACHE_GB: '0.000000001',
      PATH: `${path.join(DIR3, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await wait(1500);
  const get4 = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT4}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    const playPath4 = `/api/archive/play?path=${encodeURIComponent('Show.avi')}&profileId=own1`;
    const runsNow = () => fs.readFileSync(path.join(DIR3, 'conv-calls.log'), 'utf8')
      .split('\n').filter(Boolean).length;
    const before = runsNow();
    const revived = JSON.parse((await get4(playPath4)).body);
    const st4 = JSON.parse((await get4(`/api/remux/status?id=${revived.session}`)).body);
    check('a fresh server serves the cached episode under the same name',
      revived.mode === 'hls' && /^arc-[0-9a-f]{12}$/.test(revived.session || ''),
      JSON.stringify(revived).slice(0, 160));
    check('already complete, before anything converts — resume is instant',
      st4.complete === true && runsNow() === before,
      `complete=${st4.complete}, runs ${before} -> ${runsNow()}`);
    check('and the cache remembered the real runtime for the scrubber',
      revived.sourceDuration === 2135, String(revived.sourceDuration));

    // The allowance. Converting a DIFFERENT episode starts a new session and
    // then makes room: with the cap at nothing, the finished episode nobody
    // is holding is the one that goes.
    //
    // "Nobody is holding" is the operative part, and it is why the player is
    // closed first. An episode somebody is watching this second is never
    // evicted out from under them — which is also what stops one multiview
    // cell's conversion being cleared away by another's.
    const stillHeld = arcDirs();
    const otherWhileHeld = JSON.parse((await get4(
      `/api/archive/play?path=${encodeURIComponent('Other.avi')}&profileId=own1`)).body);
    check('an episode being watched right now is never evicted for a new one',
      arcDirs().includes(revived.session), JSON.stringify({ before: stillHeld, after: arcDirs() }));
    await get4(`/api/remux/stop?id=${otherWhileHeld.session}`);
    await get4(`/api/remux/stop?id=${revived.session}`);

    const other = JSON.parse((await get4(
      `/api/archive/play?path=${encodeURIComponent('Other.avi')}&profileId=own1`)).body);
    check('a second title converts under its own name',
      /^arc-[0-9a-f]{12}$/.test(other.session || '') && other.session !== revived.session,
      JSON.stringify({ other: other.session, revived: revived.session }));
    const left = arcDirs();
    check('and the over-allowance cache gave up its oldest episode',
      !left.includes(revived.session) && left.includes(other.session),
      JSON.stringify(left));
  } finally {
    server4.kill('SIGKILL');
  }

  /* ---- saving one to the device in your hand --------------------------- */
  //
  // Two roads, because the drive holds two kinds of file. A container a
  // phone opens is handed over as it stands — instant, and it costs the box
  // nothing. Everything else (which is most of the drive) is converted once
  // into Downloads, and saved from there.
  console.log('\n  saving a title to a device');
  const PORT5 = 8488;
  const DIR5 = '/tmp/portal-arc5';
  fs.rmSync(DIR5, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR5, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR5, 'drive'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR5, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR5, f));
  }
  fs.writeFileSync(path.join(DIR5, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR5, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  fs.writeFileSync(path.join(DIR5, 'drive', 'Ready.mp4'), 'ALREADY-PLAYABLE-BYTES');
  fs.writeFileSync(path.join(DIR5, 'drive', 'Old.avi'), 'OLD-RIP');
  fs.writeFileSync(path.join(DIR5, 'library-index.ndjson'), [
    JSON.stringify({ path: 'Ready.mp4', dir: '.', title: 'Ready Made', date: '2021-02-03',
      year: 2021, tags: [], duration: 600, size: 22, width: 1920, height: 1080,
      container: 'mp4', vcodec: 'h264', acodec: 'aac', playback: 'direct' }),
    JSON.stringify({ path: 'Old.avi', dir: '.', title: 'Old Rip', date: '2008-05-06',
      year: 2008, tags: [], duration: 1200, size: 7, width: 640, height: 480,
      container: 'avi', vcodec: 'mpeg4', acodec: 'mp3', playback: 'transcode' }),
  ].join('\n') + '\n');
  // An ffmpeg that writes a plausible mp4 where it was told to, and records
  // the arguments so the conversion's shape can be judged.
  fs.writeFileSync(path.join(DIR5, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
echo "$@" >> "${DIR5}/convert-calls.log"
args=("$@")
out="\${args[-1]}"
sleep 0.4
printf 'CONVERTED-MP4-BYTES' > "$out"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(DIR5, 'fakebin', 'ffprobe'), `#!/bin/bash
echo '{"streams":[{"codec_type":"video","codec_name":"mpeg4"}],"format":{"duration":"1200"}}'
exit 0
`, { mode: 0o755 });

  const server5 = spawn('node', ['server.js'], {
    cwd: DIR5,
    env: { ...process.env, PORT: String(PORT5), HOST: '127.0.0.1',
      ARCHIVE_ROOT: path.join(DIR5, 'drive'),
      PATH: `${path.join(DIR5, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await wait(1500);
  const req5 = (p, opts = {}) => new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${PORT5}${p}`,
      { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
  const post5 = (p, obj) => req5(p, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

  try {
    // The easy road: it is already an mp4, so it is simply handed over.
    const straight = await req5(`/archive/file?path=${encodeURIComponent('Ready.mp4')}&save=1`);
    console.log('   direct save:', straight.status, straight.headers['content-disposition']);
    check('a phone-ready file is handed straight over',
      straight.status === 200 && straight.body === 'ALREADY-PLAYABLE-BYTES',
      `${straight.status}: ${straight.body.slice(0, 30)}`);
    check('as a download, with the title as its filename',
      /attachment/.test(straight.headers['content-disposition'] || '')
      && /Ready Made\.mp4/.test(decodeURIComponent(straight.headers['content-disposition'] || '')),
      straight.headers['content-disposition']);
    const noSave = await req5(`/archive/file?path=${encodeURIComponent('Ready.mp4')}`);
    check('while playback is untouched — no filename, so it streams',
      noSave.status === 200 && !noSave.headers['content-disposition'],
      String(noSave.headers['content-disposition']));

    // The other road: an .avi no phone will open is converted first.
    const queued = JSON.parse((await post5('/api/downloads', {
      kind: 'movie', archivePath: 'Old.avi', name: 'Old Rip', profileId: 'own1',
    })).body);
    console.log('   queued:', JSON.stringify(queued).slice(0, 160));
    check('an unplayable one is accepted as a job', Boolean(queued.id), JSON.stringify(queued));
    check('identified by where it is on the drive, so it is never saved twice',
      queued.streamId === 'archive:Old.avi', queued.streamId);
    check('and promised as an mp4, whatever it started as', queued.ext === 'mp4', queued.ext);

    const again = await post5('/api/downloads', {
      kind: 'movie', archivePath: 'Old.avi', name: 'Old Rip', profileId: 'own1',
    });
    check('asking twice is refused rather than converting it twice',
      again.status === 409, String(again.status));

    // Let the queue run it.
    let done = null;
    for (let i = 0; i < 40; i += 1) {
      await wait(300);
      const list = JSON.parse((await req5('/api/downloads')).body);
      done = (list.items || []).find((j) => j.id === queued.id);
      if (done && (done.status === 'done' || done.status === 'error')) break;
    }
    console.log('   after converting:', JSON.stringify(done).slice(0, 200));
    check('it converts and finishes', done?.status === 'done', JSON.stringify(done));
    check('into a real file with a size on it', done?.bytes > 0, String(done?.bytes));

    const args = fs.readFileSync(path.join(DIR5, 'convert-calls.log'), 'utf8');
    check('read straight off the drive — no copy first',
      new RegExp(`-i ${path.join(DIR5, 'drive', 'Old.avi')}`).test(args), args.slice(0, 200));
    check('an MPEG-4 rip is re-encoded, since copying it gives a black picture',
      /-c:v libx264/.test(args), args.slice(0, 200));
    check('with the moov up front, so it opens and seeks straight away',
      /-movflags \+faststart/.test(args), args.slice(0, 200));
    check('and audio a phone can decode', /-c:a aac/.test(args), args.slice(0, 200));

    const saved = await req5(`/api/downloads/${queued.id}/save`);
    check('and then it saves to the device like any other download',
      saved.status === 200 && /attachment/.test(saved.headers['content-disposition'] || ''),
      `${saved.status} ${saved.headers['content-disposition']}`);

    // The index is the boundary here as everywhere else.
    const nowhere = await post5('/api/downloads', {
      kind: 'movie', archivePath: '../../etc/passwd', name: 'nope', profileId: 'own1',
    });
    check('a path the index does not list is refused', nowhere.status === 404,
      String(nowhere.status));
  } finally {
    server5.kill('SIGKILL');
  }

  // The client's half of the contract, pinned at the source the way the
  // ffmpeg arguments are: a resume hands the player a position, never the
  // server; and a seek waits for the one conversion rather than restarting.
  console.log('\n  the client keeps its half');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('no request to the archive ever carries a start offset',
    !/archive\/play',\s*\{[^}]*start/s.test(APP),
    'an /api/archive/play call still sends start');
  check('the player starts inside the whole at the resume point',
    /startPosition: opts\.seekTo > 0 \? opts\.seekTo : 0/.test(APP));
  check('resume and seek both wait for the conversion to pass the mark',
    (APP.match(/waitForConversionSpan\(/g) || []).length >= 3,
    `${(APP.match(/waitForConversionSpan\(/g) || []).length} uses`);
  check('and the server refuses the idea outright — conversions start at zero',
    /startSeconds: 0,/.test(SERVER) && /sessionKey = `arc-/.test(SERVER));
  check('the idle reaper waits for an archive conversion to finish',
    /startsWith\('arc-'\) && !s\.exited\) continue/.test(SERVER));
  check('and killSession is where finished episodes are spared',
    /finished = id\.startsWith\('arc-'\)/.test(SERVER));
  // The Pi's card has less free space than the cache's default allowance, so
  // the cap alone could let the cache crowd the disk to zero. The floor
  // outranks it: room is made BEFORE a conversion starts writing, down to
  // the reserve plus the expected output size.
  check('the cache yields to a free-space floor, not just its cap',
    /pruneArchiveCache\(SPACE_RESERVE \+ Math\.max\(2 \* 1024 \*\* 3, item\.size/.test(SERVER)
    && /underFloor/.test(SERVER));

  /* ---- the tab itself, against the real 5,853-entry index --------------- */
  console.log('\n  the tab, on the real index with no drive attached');
  const browser = await chromium.launch();
  const page = await browser.newPage({ ...devices['iPhone 13 Pro'] });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.goto(UI, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  await page.evaluate(() => { location.hash = '#/archive'; });
  await page.waitForTimeout(1200);

  const view = await page.evaluate(() => ({
    shown: !document.querySelector('#archiveView').hidden,
    status: document.querySelector('#archiveStatus').textContent,
    warn: document.querySelector('#archiveStatus').classList.contains('is-warn'),
    chips: document.querySelectorAll('.folder-chip').length,
    cards: document.querySelectorAll('.archive-card').length,
    /* Not on the bottom bar any more. The bar carries four — Live TV,
       Movies, Series, Downloads — and the archive is one of the two reached
       from the header menu, which is that bar's overflow. What matters is that
       it is still reachable on a phone, so this follows it to where it went
       rather than to where it used to be: the archive is Hunter's own drive
       and the bar was its only route in, which is why it could not simply be
       dropped along with the tab. */
    onBar: document.querySelector('#tabBar a[data-tab="archive"]') !== null,
    inMenu: (() => {
      const a = document.querySelector('#mainNav a[data-tab="archive"]');
      return Boolean(a) && getComputedStyle(a).display !== 'none';
    })(),
    menuReachable: getComputedStyle(document.querySelector('#navToggle')).display !== 'none',
  }));
  console.log('   the tab:', JSON.stringify(view));
  check('the archive tab renders its own view', view.shown, JSON.stringify(view));
  check('with the drive missing it says so, prominently',
    view.warn && /not mounted|plugged/i.test(view.status), view.status);
  check('and the index still browses — folders or files are on screen',
    view.chips + view.cards > 0, JSON.stringify(view));
  check('it is off the phone\'s bottom bar, which carries four', !view.onBar,
    JSON.stringify(view));
  check('it is in the header menu, which is that bar\'s overflow', view.inMenu,
    JSON.stringify(view));
  check('and that menu can be opened, so the archive is not stranded',
    view.menuReachable, JSON.stringify(view));

  /* On a phone the search is its magnifier until you tap it, which is what the
     design draws and the only way it fits beside the other controls. So it gets
     tapped — and that is worth checking rather than working around, because the
     collapsed state used to be a dead end: the input was `display: none`, which
     a label cannot focus, so the icon was a button that did nothing. */
  const closed = await page.evaluate(() =>
    Math.round(document.querySelector('#searchInput').getBoundingClientRect().width));
  await page.locator('.site-header .search').click();
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => ({
    input: Math.round(document.querySelector('#searchInput').getBoundingClientRect().width),
    focused: document.activeElement?.id,
  }));
  console.log('   search:', JSON.stringify({ closed, ...opened }));
  check('the search is its icon until tapped', closed === 0, String(closed));
  check('and tapping it opens a field you can actually type in',
    opened.input > 150 && opened.focused === 'searchInput', JSON.stringify(opened));

  // Search is a server call on this tab, not a client-side filter.
  await page.fill('#searchInput', 'game');
  await page.waitForTimeout(700);
  const searched = await page.evaluate(() => ({
    crumb: [...document.querySelectorAll('#archiveCrumbs .crumb')].map((c) => c.textContent).join('|'),
  }));
  check('searching flips the crumbs into a results view',
    /Search results/.test(searched.crumb), searched.crumb);

  // Opening a card enters the normal player with the archive as its home.
  await page.fill('#searchInput', '');
  await page.waitForTimeout(700);
  await page.locator('.archive-card').first().click();
  await page.waitForTimeout(1500);
  const player = await page.evaluate(() => ({
    overlay: !document.querySelector('#playerOverlay').hidden,
    back: document.querySelector('#cinemaBackLabel').textContent,
    said: document.querySelector('#videoStatus').textContent,
  }));
  console.log('   after clicking a title:', JSON.stringify(player));
  check('a title opens the normal player', player.overlay, JSON.stringify(player));
  check('whose back button returns to the Archive, not to Movies',
    player.back === 'Archive', player.back);
  check('and with no drive the player says why, in words',
    /not mounted|plugged/i.test(player.said), player.said);

  // Every card asks for its frame, with the owner's profileId on the URL —
  // and on this box (no ffmpeg) the image fails, so the card must fall back
  // to its typographic face rather than a broken glyph.
  const faces = await page.evaluate(async () => {
    // Read the wiring off a freshly built card, synchronously — on this box
    // the thumb request 501s so fast the failed image is already gone from
    // the rendered grid by the time anything looks at it, which is itself
    // the fallback behaviour the second check pins.
    const fresh = archiveCard({ path: 'x/y.mp4', title: 'Y', playback: 'direct',
      duration: 60, date: '2024-01-01', tags: [] });
    const src = fresh.querySelector('img')?.getAttribute('src') || '';
    await new Promise((r) => setTimeout(r, 1200));
    return {
      src,
      broken: [...document.querySelectorAll('.archive-card img')]
        .some((i) => i.complete && i.naturalWidth === 0),
      titlesStand: document.querySelectorAll('.archive-card-title').length > 0,
    };
  });
  // The button that puts a film on the device in your hand, and the three
  // things it can mean. Read off freshly built cards, because a card's state
  // is decided when it is built.
  console.log('\n  the save button on a card');
  const buttons = await page.evaluate(() => {
    state.downloads = { items: [
      { id: 'j1', kind: 'movie', streamId: 'archive:done/x.avi', status: 'done',
        name: 'Done One', ext: 'mp4' },
      { id: 'j2', kind: 'movie', streamId: 'archive:busy/y.avi', status: 'downloading',
        name: 'Busy One', ext: 'mp4' },
    ], active: 'j2', queued: 0 };
    const read = (entry) => {
      const card = archiveCard(entry);
      const b = card.querySelector('.archive-dl');
      return b ? { title: b.title, saved: b.classList.contains('is-saved'),
        queued: b.classList.contains('is-queued'),
        inArt: Boolean(card.querySelector('.archive-card-art .archive-dl')) } : null;
    };
    return {
      ready: read({ path: 'a/ready.mp4', title: 'Ready', container: 'mp4',
        playback: 'direct', duration: 60, date: '2024-01-01', tags: [] }),
      old: read({ path: 'a/old.avi', title: 'Old', container: 'avi',
        playback: 'transcode', duration: 60, date: '2008-01-01', tags: [] }),
      done: read({ path: 'done/x.avi', title: 'Done One', container: 'avi',
        playback: 'transcode', duration: 60, date: '2008-01-01', tags: [] }),
      busy: read({ path: 'busy/y.avi', title: 'Busy One', container: 'avi',
        playback: 'transcode', duration: 60, date: '2008-01-01', tags: [] }),
    };
  });
  console.log('   ', JSON.stringify(buttons));
  check('every archive card carries a way to save it',
    Object.values(buttons).every(Boolean), JSON.stringify(buttons));
  check('a phone-ready file offers itself straight away',
    /Save to this device/.test(buttons.ready?.title || ''), buttons.ready?.title);
  check('one that needs converting says so before you press it',
    /Convert this AVI/.test(buttons.old?.title || ''), buttons.old?.title);
  check('one already converted offers the file itself',
    buttons.done?.saved && /save it to this device/.test(buttons.done?.title || ''),
    JSON.stringify(buttons.done));
  check('and one mid-conversion says where to watch it',
    buttons.busy?.queued && /Downloads/.test(buttons.busy?.title || ''),
    JSON.stringify(buttons.busy));

  // A thumbnail that cannot be cut removes the art box — the way to save the
  // file must not go with it, which is why the button is not inside it.
  check('the button survives a card with no thumbnail',
    buttons.ready?.inArt === false, JSON.stringify(buttons.ready));

  // Pressing it must not also open the player.
  const pressed = await page.evaluate(async () => {
    // An earlier section left the player up; the claim is about what this
    // press does, so start from nothing playing.
    closePlayer();
    await new Promise((r) => setTimeout(r, 300));
    const card = archiveCard({ path: 'a/ready.mp4', title: 'Ready', container: 'mp4',
      playback: 'direct', duration: 60, date: '2024-01-01', tags: [] });
    document.body.append(card);
    let opened = false;
    card.onclick = () => { opened = true; };
    card.querySelector('.archive-dl').click();
    await new Promise((r) => setTimeout(r, 200));
    card.remove();
    return { opened, playerOpen: !document.querySelector('#playerOverlay').hidden };
  });
  check('and saving does not also start playing it',
    pressed.opened === false && pressed.playerOpen === false, JSON.stringify(pressed));

  console.log('   card faces:', JSON.stringify(faces));
  check('cards ask the Pi for a frame of the file itself',
    /\/api\/archive\/thumb\?path=/.test(faces.src) && /profileId=/.test(faces.src),
    faces.src);
  check('and a frame that cannot be cut leaves the typographic card, not a',
    !faces.broken && faces.titlesStand, JSON.stringify(faces));
  console.log('       broken image glyph');

  // Continue watching. An archive play writes history under id
  // archive:<path>; resuming from home used to look that up in the provider
  // library and say "no longer in the library" about a file on the drive.
  console.log('\n  resuming from the home screen');
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
  const resumed = await page.evaluate(async () => {
    closePlayer();
    await new Promise((r) => setTimeout(r, 300));
    playFromHistory({ kind: 'movie', id: 'archive:2024/Alpha_Game.mp4',
      name: 'Alpha Game', key: 'archive:2024/Alpha_Game.mp4', poster: '' });
    await new Promise((r) => setTimeout(r, 1200));
    return {
      overlay: !document.querySelector('#playerOverlay').hidden,
      back: document.querySelector('#cinemaBackLabel').textContent,
      toast: document.querySelector('#toast').hidden
        ? '' : document.querySelector('#toast').textContent,
    };
  });
  console.log('   ', JSON.stringify(resumed));
  check('an archive title from Continue watching opens the player',
    resumed.overlay, JSON.stringify(resumed));
  check('as an archive title, with the Archive as its home',
    resumed.back === 'Archive', resumed.back);
  check('and never says "no longer in the library" about a file on the drive',
    !/no longer in the library/.test(resumed.toast), resumed.toast);

  // Leaving the archive must take its furniture along — to EVERY page, not
  // just home. The first version of this bug was fixed inside renderHome
  // alone, so the folders promptly bled into Downloads and the title cards
  // instead: each early-return branch of render() was hiding its neighbours
  // for itself, and each new branch forgot one. render() now hides the lot
  // before branching, so this walks the archive into every tab in turn.
  const bled = await page.evaluate(async () => {
    closePlayer();
    const out = {};
    for (const tab of ['home', 'live', 'movies', 'series', 'favorites', 'downloads']) {
      location.hash = '#/archive';
      await new Promise((r) => setTimeout(r, 400));
      location.hash = `#/${tab}`;
      await new Promise((r) => setTimeout(r, 400));
      out[tab] = document.querySelector('#archiveView').hidden;
    }
    out.homeShownLast = (() => { location.hash = '#/home'; return true; })();
    return out;
  });
  console.log('   archive hidden after leaving for:', JSON.stringify(bled));
  check('leaving the archive leaves no archive rows behind, whatever page is next',
    ['home', 'live', 'movies', 'series', 'favorites', 'downloads'].every((t) => bled[t]),
    JSON.stringify(bled));
  const homeAfter = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 500));
    return !document.querySelector('#homeView').hidden;
  });
  check('and the destination page itself is what shows', homeAfter, String(homeAfter));

  // And for everyone who is not Hunter, the tab does not exist: the links
  // vanish and typing the address bounces to home. The API refusal for them
  // is covered above; this is the half the household actually sees.
  console.log('\n  as somebody else');
  const asOther = await page.evaluate(async () => {
    profiles.current = { id: 'gst', name: 'Ben' };
    profiles.data = { ...(profiles.data || {}), owner: false };
    reporter.applyButtons();
    // Leave the archive first: assigning the hash it already holds fires no
    // navigation, and the point is to arrive as somebody else.
    location.hash = '#/live';
    await new Promise((r) => setTimeout(r, 400));
    location.hash = '#/archive';
    await new Promise((r) => setTimeout(r, 800));
    return {
      navShown: [...document.querySelectorAll('a[data-tab="archive"]')]
        .some((a) => a.style.display !== 'none'),
      landed: location.hash,
    };
  });
  console.log('   as Ben:', JSON.stringify(asOther));
  check('the archive links are gone for another profile', asOther.navShown === false,
    JSON.stringify(asOther));
  check('and typing the address bounces to home', asOther.landed === '#/home',
    asOther.landed);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
