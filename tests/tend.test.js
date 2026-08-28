/**
 * The box tends its own downloads.
 *
 * There were two buttons on the Downloads page — Optimize and Retry — and
 * both asked the viewer to do the box's job. Nobody would ever decline
 * optimizing: a download left in its original container plays through an
 * on-the-fly conversion, which is the exact slowness downloads exist to
 * avoid. And a download that failed because the provider hiccuped wants
 * trying again, not a button. Both buttons are gone, so what replaced them
 * has to actually happen — on a real server, with real files, unattended.
 *
 * Slow on purpose: the box's first sweep is ten seconds after it starts, and
 * nothing here fakes the clock. Watching it do the thing by itself is the
 * whole point.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const PATHS = require('./paths.js');
const http = require('http');
const path = require('path');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-tend';
const PORT = 8490;
const PROVIDER = 9498;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PROVIDER}`, username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));

  // A provider that hands over a small file for anything asked of it.
  let served = 0;
  const provider = http.createServer((req, res) => {
    served += 1;
    const body = Buffer.from('PROVIDER-FILE-BYTES');
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => provider.listen(PROVIDER, '127.0.0.1', r));

  // The file a finished-but-unoptimized download left on disk.
  fs.writeFileSync(path.join(DIR, 'store', 'a.mkv'), 'UNOPTIMIZED-MATROSKA');

  // Four jobs, each standing for one thing the box has to decide by itself.
  const seeded = [
    { id: 'a', name: 'Left In Matroska', kind: 'movie', streamId: 'm1', ext: 'mkv',
      file: 'a.mkv', status: 'done', bytes: 20, total: 20, createdAt: Date.now(),
      finishedAt: Date.now(), profileId: 'own1' },
    { id: 'b', name: 'Failed Once', kind: 'movie', streamId: '5', ext: 'mp4',
      status: 'error', error: 'Provider returned HTTP 502', bytes: 0, total: 0,
      tries: 1, failedAt: 0, createdAt: Date.now(), profileId: 'own1' },
    { id: 'c', name: 'Over The Allowance', kind: 'movie', streamId: '6', ext: 'mp4',
      status: 'error', error: 'That is 9 GB and you have 1 GB left.', permanent: true,
      bytes: 0, total: 0, tries: 1, failedAt: 0, createdAt: Date.now(), profileId: 'own1' },
    { id: 'd', name: 'Tried Everything', kind: 'movie', streamId: '7', ext: 'mp4',
      status: 'error', error: 'Provider returned HTTP 404', bytes: 0, total: 0,
      tries: 8, failedAt: 0, createdAt: Date.now(), profileId: 'own1' },
  ];
  fs.writeFileSync(path.join(DIR, 'store', 'index.json'), JSON.stringify(seeded));

  // An ffmpeg that converts by writing where it was told, and an ffprobe the
  // conversion consults for the codec first.
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
echo "$@" >> "${DIR}/ffmpeg-calls.log"
args=("$@")
printf 'OPTIMIZED-MP4' > "\${args[-1]}"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffprobe'), `#!/bin/bash
echo '{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"600"}}'
exit 0
`, { mode: 0o755 });

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      DOWNLOADS_ROOT: path.join(DIR, 'store'),
      PATH: `${path.join(DIR, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const get = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  const jobs = async () => {
    const list = JSON.parse((await get('/api/downloads')).body);
    return Object.fromEntries((list.items || []).map((j) => [j.id, j]));
  };

  try {
    await wait(2000);
    const before = await jobs();
    console.log('   at rest:', Object.values(before)
      .map((j) => `${j.id}:${j.status}/${j.ext}`).join(' '));
    check('the box comes up holding all four', Object.keys(before).length === 4,
      JSON.stringify(Object.keys(before)));

    // Nobody presses anything from here on.
    console.log('\n  left alone for twenty seconds');
    await wait(20000);
    const after = await jobs();
    console.log('   after:  ', Object.values(after)
      .map((j) => `${j.id}:${j.status}/${j.ext}`).join(' '));

    // 1. Always optimize.
    check('a download left in its original container is converted, unasked',
      after.a?.ext === 'mp4' && after.a?.status === 'done',
      JSON.stringify(after.a));
    check('and the converted file is the one on disk now',
      fs.existsSync(path.join(DIR, 'store', 'a.mp4')),
      fs.readdirSync(path.join(DIR, 'store')).join(','));
    check('with the original removed rather than kept alongside it',
      !fs.existsSync(path.join(DIR, 'store', 'a.mkv')),
      fs.readdirSync(path.join(DIR, 'store')).join(','));

    // 2. A failure that might pass next time is tried again.
    check('a download that failed tries itself again',
      after.b?.status === 'done' || after.b?.status === 'downloading'
      || after.b?.status === 'queued',
      JSON.stringify(after.b));
    check('and really went back to the provider for it', served > 0, String(served));

    // 3. But not one where trying again cannot help.
    check('an allowance failure is left alone — deleting something is the fix',
      after.c?.status === 'error', JSON.stringify(after.c));
    check('and it keeps saying why', /allowance|GB left/i.test(after.c?.error || ''),
      after.c?.error);

    // 4. Nor one that has already had every chance.
    check('a download that has failed eight times stops being retried',
      after.d?.status === 'error' && (after.d?.tries || 0) >= 8, JSON.stringify(after.d));

    // The conversion really was a conversion, not a copy.
    const args = fs.readFileSync(path.join(DIR, 'ffmpeg-calls.log'), 'utf8');
    check('the optimize pass puts the index up front, which is the whole point',
      /-movflags \+faststart/.test(args), args.slice(0, 160));
  } finally {
    server.kill('SIGKILL');
    provider.close();
  }

  /* ---- and the buttons are gone from the page -------------------------- */
  //
  // Source-level, because a button that has been deleted cannot be clicked
  // to prove it is missing.
  console.log('\n  what the page no longer asks of you');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('no Optimize button', !/textContent = .?(Retry optimize|Optimize).?;/.test(APP)
    && !/\/optimize'/.test(APP), 'an optimize control is still built');
  check('no Retry button on a failed download',
    !/retry\.textContent = job\.status === 'paused'/.test(APP)
    && !/'Retry'/.test(APP), 'a retry control is still built');
  check('but Resume stays, because a manual pause is a decision of yours',
    /resume\.textContent = 'Resume';/.test(APP));
  check('and the card says the box is handling it',
    /Optimizing shortly/.test(APP) && /trying again shortly/.test(APP));

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
