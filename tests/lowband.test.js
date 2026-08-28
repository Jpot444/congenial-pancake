/**
 * Low bandwidth: sending fewer bits, because that is the only thing that
 * helps a link that cannot carry the stream.
 *
 * The report that prompted it is worth keeping, because it disproves the
 * obvious fix: a download that had ALREADY been optimized still played
 * slowly on weak Wi-Fi. Optimizing converts the container and changes the
 * bitrate not at all — a 1080p title at six megabits is six megabits before
 * and after. Nothing about buffering, retrying or re-containering makes a
 * stream fit down a pipe too narrow for it. Only sending less does.
 *
 * So what is on trial here is: does every path that reaches a screen
 * actually get smaller, and does nothing get quietly copied through at full
 * size behind the switch's back.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const UI = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The shipped ffmpegArgs, lifted so the arguments under test are the real ones. */
function lift(name, extra = '') {
  const start = SERVER.indexOf(`function ${name}(`);
  let depth = 0;
  let i = SERVER.indexOf('{', start);
  for (; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1;
    else if (SERVER[i] === '}' && --depth === 0) break;
  }
  return `${extra}\n${SERVER.slice(start, i + 1)}`;
}

(async () => {
  const consts = /const LOW_HEIGHT[\s\S]*?const LOW_AUDIO = '\d+k';/.exec(SERVER)[0];
  // eslint-disable-next-line no-new-func
  const ffmpegArgs = new Function('path', 'UA',
    `${consts}\n${lift('audioFilter')}\n${lift('ffmpegArgs')}\nreturn ffmpegArgs;`
  )(path, 'ua');

  /* ---- the picture really is made smaller ------------------------------ */
  console.log('\n  what the box is told to do');
  const normal = ffmpegArgs('http://p/f.mkv', '/out', 'h264', 0, 0, 0, [], 0, 'input', false);
  const small = ffmpegArgs('http://p/f.mkv', '/out', 'h264', 0, 0, 0, [], 0, 'input', true);
  console.log('   normal video:', normal.slice(normal.indexOf('-c:v'), normal.indexOf('-c:v') + 2).join(' '));
  console.log('   small  video:', small.slice(small.indexOf('-c:v'), small.indexOf('-c:v') + 4).join(' '));

  check('normally an H.264 source is copied, which costs nothing',
    normal.join(' ').includes('-c:v copy'), normal.join(' ').slice(0, 120));
  check('but on a weak link even H.264 is re-encoded — copying is exactly what',
    !small.join(' ').includes('-c:v copy') && small.join(' ').includes('-c:v libx264'),
    small.join(' ').slice(0, 200));
  console.log('       keeps it too big to get through');
  check('scaled down to 480 lines, never up',
    /-vf scale=-2:'min\(480,ih\)'/.test(small.join(' ')), small.join(' '));
  check('with a hard ceiling, so one busy scene cannot spike and stall it',
    small.includes('-maxrate') && small.includes('-bufsize'), small.join(' '));
  check('and quieter audio too', small.join(' ').includes('-b:a 96k'), small.join(' '));
  check('while normal playback keeps full-quality audio',
    normal.join(' ').includes('-b:a 160k'), normal.join(' '));

  // The ceiling has to be a number a bad link can actually carry.
  const rate = Number(/-maxrate (\d+)k/.exec(small.join(' '))[1]);
  const audio = Number(/-b:a (\d+)k/.exec(small.join(' '))[1]);
  console.log(`   ceiling: ${rate}k video + ${audio}k audio = ${rate + audio}k`);
  check('the whole stream fits inside about a megabit',
    rate + audio <= 1100, `${rate + audio}k`);

  // An HEVC source transcoded to H.264 must not still be labelled HEVC.
  const hevcSmall = ffmpegArgs('http://p/f.mkv', '/out', 'hevc', 0, 0, 0, [], 0, 'input', true);
  check('an HEVC source comes out as H.264 and is not tagged as HEVC',
    !hevcSmall.join(' ').includes('hvc1'), hevcSmall.join(' ').slice(0, 200));
  const hevcNormal = ffmpegArgs('http://p/f.mkv', '/out', 'hevc', 0, 0, 0, [], 0, 'input', false);
  check('while a copied HEVC stream still is', hevcNormal.join(' ').includes('hvc1'));

  /* ---- live is shrunk too, and must keep up ---------------------------- */
  console.log('\n  a live channel on a weak link');
  // eslint-disable-next-line no-new-func
  const liveDvrArgs = new Function('path', 'LIVE_DVR',
    `${consts}\n${lift('liveDvrArgs')}\nreturn liveDvrArgs;`
  )(path, { segmentSeconds: 4, windowSegments: 30 });
  const liveNormal = liveDvrArgs('http://p/live.m3u8', '/out', false, false).join(' ');
  const liveSmall = liveDvrArgs('http://p/live.m3u8', '/out', false, true).join(' ');
  /* The picture is copied; the sound never is. An HE-AAC core reaching a
     decoder on its own plays an octave down and at half speed, and nothing in
     the provider's metadata distinguishes it from AAC-LC — so the audio is
     re-encoded on every channel, small link or not. */
  check('normally the PICTURE is copied through untouched',
    liveNormal.includes('-c:v copy'), liveNormal.slice(0, 120));
  check('and the sound is re-encoded either way',
    liveNormal.includes('-c:a aac -profile:a aac_low')
      && liveSmall.includes('-c:a aac -profile:a aac_low'), liveNormal.slice(-160));
  check('on a weak link it is encoded small', liveSmall.includes('libx264')
    && /scale=-2:'min\(480,ih\)'/.test(liveSmall), liveSmall.slice(0, 200));
  check('at ultrafast, because a channel that falls behind never catches up',
    liveSmall.includes('-preset ultrafast'), liveSmall.slice(0, 200));

  /* ---- the server accepts the flag on every road ----------------------- */
  console.log('\n  every way in carries it');
  check('films and episodes', /low: query\.get\('low'\) === '1'/.test(SERVER));
  check('the archive drive', /const low = query\.get\('low'\) === '1';/.test(SERVER));
  check('live channels', /ensureLiveDvr\(cfg, id, lowWanted\)/.test(SERVER));
  check('a shrunk archive conversion is cached under its own name, so nobody',
    /arc-\$\{low \? 'lo-' : ''\}/.test(SERVER));
  console.log('       is served the wrong size from the cache');
  check('and a shrunk channel is its own ingest, so one weak device does not',
    /live-\$\{low \? 'lo-' : ''\}\$\{channelId\}/.test(SERVER));
  console.log('       downgrade the television everybody else is watching');
  check('a browser-native archive file stops being handed over raw',
    /item\.playback === 'direct' && \(!low \|\| !hasFfmpeg\(\)\)/.test(SERVER));
  check('and the preference survives a restart, on the box',
    /prefs\.lowBandwidth = incoming\.lowBandwidth;/.test(SERVER)
    && /lowBandwidth: parsed\.lowBandwidth === true/.test(SERVER));

  /* ---- against a running box ------------------------------------------- */
  //
  // The claim that matters most: the same file asked for both ways produces
  // two different conversions, and the small one really was told to scale.
  console.log('\n  the same file, both ways, on a real box');
  const DIR = '/tmp/portal-low';
  const PORT = 8491;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'drive'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  // A browser-native file: normally handed over as bytes, and the case the
  // owner hit — already "optimized", still too big for the link.
  fs.writeFileSync(path.join(DIR, 'drive', 'Big.mp4'), 'FULL-SIZE-BYTES');
  fs.writeFileSync(path.join(DIR, 'library-index.ndjson'), JSON.stringify({
    path: 'Big.mp4', dir: '.', title: 'Big One', date: '2022-01-01', year: 2022,
    tags: [], duration: 3600, size: 15, width: 1920, height: 1080,
    container: 'mp4', vcodec: 'h264', acodec: 'aac', playback: 'direct',
  }) + '\n');
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
echo "$@" >> "${DIR}/calls.log"
args=("$@")
out="\${args[-1]}"
dir=$(dirname "$out")
printf 'x' > "$dir/seg00000.m4s"
printf 'x' > "$dir/seg00001.m4s"
printf '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXTINF:4.000,\\nseg00000.m4s\\n#EXTINF:4.000,\\nseg00001.m4s\\n' > "$out"
sleep 60
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

  try {
    const full = JSON.parse((await get('/api/archive/play?path=Big.mp4&profileId=own1')).body);
    check('normally a phone-ready file is handed over as it stands',
      full.mode === 'direct', JSON.stringify(full));

    const small2 = JSON.parse((await get(
      '/api/archive/play?path=Big.mp4&profileId=own1&low=1')).body);
    console.log('   asked small:', JSON.stringify(small2).slice(0, 130));
    check('on a weak link the very same file is converted instead',
      small2.mode === 'hls', JSON.stringify(small2).slice(0, 160));
    check('under a name of its own, so the two never get mixed up',
      /^arc-lo-/.test(small2.session || ''), small2.session);

    const calls = fs.readFileSync(path.join(DIR, 'calls.log'), 'utf8');
    check('and the box really was told to shrink it',
      /scale=-2/.test(calls) && /-maxrate/.test(calls), calls.slice(0, 200));
  } finally {
    server.kill('SIGKILL');
  }

  /* ---- the switch, and the offer when it is needed --------------------- */
  console.log('\n  the switch');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  let savedPrefs = null;
  await page.route('**/api/prefs', (r) => {
    if (r.request().method() === 'PUT') {
      savedPrefs = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return r.continue();
  });
  await page.goto(UI, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  const box = await page.evaluate(() => {
    const el = document.querySelector('#lowMode');
    return { exists: Boolean(el), checked: el?.checked,
      words: document.querySelector('.low-mode-words')?.textContent || '' };
  });
  check('there is a switch for it', box.exists, JSON.stringify(box));
  check('off unless asked for', box.checked === false, String(box.checked));
  check('and it says what it will actually do, including the cost',
    /1 Mbit/.test(box.words) && /softer/.test(box.words), box.words.slice(0, 160));

  await page.evaluate(() => {
    document.querySelector('#lowMode').checked = true;
    document.querySelector('#lowMode').dispatchEvent(new Event('change'));
  });
  await wait(400);
  check('turning it on is remembered on the box, not just in this tab',
    savedPrefs?.lowBandwidth === true, JSON.stringify(savedPrefs?.lowBandwidth));

  // Every request that reaches a screen now carries it.
  const carried = await page.evaluate(() => ({
    on: lowMode(),
    param: JSON.stringify(lowParam()),
  }));
  check('and every stream asked for from now on says so',
    carried.on === true && /"low":"1"/.test(carried.param), JSON.stringify(carried));

  await page.evaluate(async () => {
    prefs.data.lowBandwidth = false;
    document.querySelector('#lowMode').checked = false;
  });
  const off = await page.evaluate(() => JSON.stringify(lowParam()));
  check('with nothing added when it is off', off === '{}', off);

  // The offer. A setting nobody can find while the picture is frozen is a
  // setting that does not exist.
  console.log('\n  and it offers itself when you are stalling');
  const offered = await page.evaluate(async () => {
    lowOffered = false;
    playback.events.waiting = 0;
    // Stalls only, on a clock that really has fallen behind. A `waiting`
    // raised while seeking is not a stall at all now, and stalls on a link
    // that is keeping up are not worth telling anyone about — see
    // forget.test.js, which pins both of those.
    stallsAt = [];
    const t0 = performance.now();
    playback.samples = [{ at: t0 - 10000, t: 100, f: 0 }, { at: t0, t: 105, f: 0 }];
    document.querySelector('#playerOverlay').hidden = false;
    document.querySelector('#toast').hidden = true;
    const video = document.querySelector('#video');
    Object.defineProperty(video, 'seeking', { value: false, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      video.dispatchEvent(new Event('waiting'));
      await new Promise((r) => setTimeout(r, 40));
      seen.push(document.querySelector('#toast').hidden ? '' : 'shown');
    }
    const toastEl = document.querySelector('#toast');
    const out = {
      first: seen.indexOf('shown'),
      text: toastEl.textContent,
      action: toastEl.querySelector('.toast-action')?.textContent || '',
    };
    document.querySelector('#playerOverlay').hidden = true;
    return out;
  });
  console.log('   ', JSON.stringify(offered));
  check('it holds its tongue through the first few stalls',
    offered.first >= 3, `offered after ${offered.first + 1} stalls`);
  check('then says plainly what is wrong',
    /keeps stopping to buffer/.test(offered.text), offered.text);
  check('with the fix on a button rather than directions to a settings page',
    /smaller/i.test(offered.action), offered.action);

  const nagged = await page.evaluate(async () => {
    document.querySelector('#toast').hidden = true;
    document.querySelector('#playerOverlay').hidden = false;
    for (let i = 0; i < 4; i += 1) {
      document.querySelector('#video').dispatchEvent(new Event('waiting'));
      await new Promise((r) => setTimeout(r, 40));
    }
    const shown = !document.querySelector('#toast').hidden;
    document.querySelector('#playerOverlay').hidden = true;
    return shown;
  });
  check('and having been declined once, it does not nag', nagged === false);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
