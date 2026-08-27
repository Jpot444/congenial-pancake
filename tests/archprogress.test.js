/**
 * Watching an archive title come across.
 *
 * The report: "when I'm downloading something from the archive, it doesn't
 * show in downloads as it's downloading, so I don't know what the process
 * is." Two separate faults behind that, and neither was in the card.
 *
 *   1. The queue holds everything back while the provider's single
 *      connection is in use — which is right for a download coming FROM the
 *      provider and meaningless for a file being converted off a local
 *      drive. Ask for one while watching anything and it sat at "Waiting for
 *      the connection", waiting for a connection it never needed.
 *   2. Its progress was the growing output file measured against the
 *      SOURCE's size. An old .avi becomes a much smaller mp4, so the bar
 *      crept to a third and then jumped to done — which reads as stuck.
 *      ffmpeg knows its own position; the index knows the runtime.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-arcdl';
const PORT = 8493;
const PROVIDER = 9499;
const UI = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'drive'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PROVIDER}`, username: 'u', password: 'p',
    preferredFormat: 'ts',
  }));
  fs.writeFileSync(path.join(DIR, 'drive', 'Old.avi'), 'X'.repeat(4000));
  fs.writeFileSync(path.join(DIR, 'library-index.ndjson'), JSON.stringify({
    path: 'Old.avi', dir: '.', title: 'Old Rip', date: '2008-01-01', year: 2008,
    tags: [], duration: 1200, size: 4000, width: 640, height: 480,
    container: 'avi', vcodec: 'mpeg4', acodec: 'mp3', playback: 'transcode',
  }) + '\n');

  // An ffmpeg that reports its position the way the real one does when it is
  // asked to: `-progress pipe:1`, key=value on stdout, out_time_us climbing.
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
args=("$@"); out="\${args[-1]}"
for i in $(seq 1 10); do
  printf 'BYTES%.0s' {1..30} >> "$out"
  echo "out_time_us=$(( i * 120000000 ))"
  echo "progress=continue"
  sleep 0.4
done
echo "progress=end"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffprobe'), `#!/bin/bash
echo '{"streams":[{"codec_type":"video","codec_name":"mpeg4"}],"format":{"duration":"1200"}}'
exit 0
`, { mode: 0o755 });

  // A provider that answers a stream and then trickles, so its single
  // connection is genuinely held open while the archive job is asked for.
  const provider = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const t = setInterval(() => res.write('TS'), 200);
    res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => provider.listen(PROVIDER, '127.0.0.1', r));

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      ARCHIVE_ROOT: path.join(DIR, 'drive'),
      DOWNLOADS_ROOT: path.join(DIR, 'store'),
      PATH: `${path.join(DIR, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await wait(1500);

  const req = (p, opts = {}) => new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${PORT}${p}`,
      { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
  const jobs = async () => {
    const list = JSON.parse((await req('/api/downloads')).body);
    return (list.items || [])[0] || {};
  };

  let streaming = null;
  try {
    /* ---- asked for while something is streaming ------------------------- */
    console.log('\n  asked for while the provider is busy');
    // Hold the provider's connection open, the way watching does.
    streaming = http.get(`http://127.0.0.1:${PORT}/stream?kind=live&id=1&ext=ts`, () => {});
    streaming.on('error', () => {});
    await wait(800);

    const made = await req('/api/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', archivePath: 'Old.avi', name: 'Old Rip',
        profileId: 'own1' }),
    });
    check('the job is accepted', made.status === 200, made.body.slice(0, 120));

    // Long enough that a job stuck behind the provider gate would still be
    // sitting in the queue: the grace window alone is eight seconds.
    await wait(2500);
    const going = await jobs();
    console.log('   while streaming:', JSON.stringify({ status: going.status,
      secs: going.convertSeconds, dur: going.convertDuration, bytes: going.bytes }));
    check('it starts anyway — a local conversion is not waiting on the provider',
      going.status === 'downloading', JSON.stringify(going.status));
    check('and it is not left claiming to wait for a connection',
      going.status !== 'queued' && going.status !== 'paused', going.status);

    /* ---- and it says how far along it is -------------------------------- */
    console.log('\n  and you can see how far it has got');
    check('it reports its position, read from the encoder itself',
      going.convertSeconds > 0, String(going.convertSeconds));
    check('against the real runtime, which the index knows',
      going.convertDuration === 1200, String(going.convertDuration));
    check('and the file really is growing', going.bytes > 0, String(going.bytes));

    const first = going.convertSeconds;
    await wait(1500);
    const later = await jobs();
    check('and the position keeps climbing', later.convertSeconds > first,
      `${first} → ${later.convertSeconds}`);

    // Playing something must not put it on ice either.
    check('watching does not pause it', later.status === 'downloading', later.status);

    let done = null;
    for (let i = 0; i < 20; i += 1) {
      await wait(400);
      done = await jobs();
      if (done.status === 'done' || done.status === 'error') break;
    }
    check('it finishes', done?.status === 'done', JSON.stringify(done?.status));
    check('as an mp4', done?.ext === 'mp4', done?.ext);
  } finally {
    if (streaming) streaming.destroy();
    server.kill('SIGKILL');
    provider.close();
  }

  /* ---- what the card actually says ------------------------------------- */
  //
  // The numbers above are only worth having if they reach the page.
  console.log('\n  what the card says');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  // Three states side by side: an archive conversion a quarter through, one
  // still queued, and an ordinary provider download for comparison.
  const list = {
    items: [
      { id: 'a1', name: 'Old Rip', kind: 'movie', streamId: 'archive:Old.avi',
        archivePath: 'Old.avi', ext: 'mp4', status: 'downloading',
        bytes: 120 * 1024 * 1024, total: 900 * 1024 * 1024,
        convertSeconds: 300, convertDuration: 1200 },
      { id: 'a2', name: 'Another Tape', kind: 'movie', streamId: 'archive:New.avi',
        archivePath: 'New.avi', ext: 'mp4', status: 'queued', bytes: 0, total: 0 },
      { id: 'p1', name: 'A Provider Film', kind: 'movie', streamId: '55', ext: 'mkv',
        status: 'downloading', bytes: 300 * 1024 * 1024, total: 900 * 1024 * 1024 },
    ],
    active: 'a1', queued: 1, freeBytes: 9e9,
  };
  await page.route('**/api/downloads', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) }));

  await page.goto(UI, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }
  await page.evaluate(() => { location.hash = '#/downloads'; });
  await wait(1400);

  const cards = await page.evaluate(() => {
    const out = {};
    for (const card of document.querySelectorAll('#grid .dl-card')) {
      out[card.querySelector('.card-title')?.textContent || '?'] = {
        sub: card.querySelector('.card-sub')?.textContent || '',
        badge: card.querySelector('.dl-badge')?.textContent || '',
      };
    }
    return out;
  });
  console.log('   ', JSON.stringify(cards));

  check('an archive conversion is on the page while it runs',
    Boolean(cards['Old Rip']), JSON.stringify(Object.keys(cards)));
  check('showing how much of the episode is converted, in minutes',
    /Converting — 5:00 of 20:00/.test(cards['Old Rip']?.sub || ''), cards['Old Rip']?.sub);
  check('and how big it has become so far',
    /120 MB so far/.test(cards['Old Rip']?.sub || ''), cards['Old Rip']?.sub);
  check('with a percentage taken from the runtime, not from the file size',
    cards['Old Rip']?.badge === '25%', cards['Old Rip']?.badge);
  console.log('       (13% by bytes, 25% by time — the honest one is time)');

  check('a queued one says what it is waiting for, and it is not a connection',
    /Waiting its turn to convert/.test(cards['Another Tape']?.sub || ''),
    cards['Another Tape']?.sub);

  check('while an ordinary download is still measured in bytes, as it should be',
    /300 MB of 900 MB/.test(cards['A Provider Film']?.sub || '')
    && cards['A Provider Film']?.badge === '33%',
    JSON.stringify(cards['A Provider Film']));

  await page.screenshot({ path: __dirname + '/shots/archive-download.png' });
  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
