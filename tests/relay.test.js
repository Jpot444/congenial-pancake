/**
 * Watch live, without the reload.
 *
 * "After I click watch live of the preview channel it reloads the channel, I
 *  just want a seamless transition where the main screen fades away and the
 *  channel is immediately playing"
 *
 * What is measured is what somebody on the sofa would notice:
 *
 *   NO GAP. From the press to the end of the hand-over there is always a
 *   picture moving on screen, and the sound comes up at once — the billboard's
 *   own picture, carried into the player.
 *   NO "BUILDING A BUFFER". The player never shows its wait.
 *   NO JUMP. When the player's own copy takes over it is at the same moment
 *   the billboard was showing — matched by segment number and offset — not
 *   ten seconds away from it.
 *   AND IT IS QUICK about it.
 *
 * REAL hls.js, on a REAL live stream: the CDN is blocked here, so the same
 * hls.js version the page loads is served from tests/vendor (Apache-2.0, see
 * hls-LICENSE beside it), and the stream is VP9 in fragmented MP4 written by
 * ffmpeg — Playwright's Chromium has no H.264 — with the end marker taken off
 * so both copies treat it as live, and a starting segment number of 500 so a
 * match by sequence is a real match and not two zeros agreeing.
 */
const { chromium } = require('./playwright.js');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HLS_JS = path.join(__dirname, 'vendor', 'hls-1.5.17.min.js');
const CHANNEL = { kind: 'live', id: 701, num: 701, name: 'US| RELAY ONE', logo: '', categoryId: 'c1' };

(async () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('  no ffmpeg on this box — skipped');
    process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  spawnSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8',
    '-g', '30', '-keyint_min', '30', '-c:a', 'libopus', '-b:a', '64k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
    '-start_number', '500', path.join(dir, 'index.m3u8')]);
  const listFile = path.join(dir, 'index.m3u8');
  if (!fs.existsSync(listFile)) {
    console.log('  could not write a stream — skipped');
    process.exit(0);
  }
  /* Live: no end marker, so neither copy treats it as a finished film. */
  fs.writeFileSync(listFile, fs.readFileSync(listFile, 'utf8').replace(/#EXT-X-ENDLIST\s*$/, ''));

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  /* The later route wins in Playwright, so the blanket block goes first and
     hls.js is carved out of it after. */
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/cdn.jsdelivr.net/npm/hls.js@*/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(HLS_JS) }));
  await page.route('**/hls/live-701/**', (r) => {
    const name = path.basename(new URL(r.request().url()).pathname);
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return r.fulfill({ status: 404, body: '' });
    const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
      : name.endsWith('.m4s') ? 'video/iso.segment' : 'video/mp4';
    return r.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
  });
  let plays = [];
  await page.route('**/api/play**', (r) => {
    plays.push(new URL(r.request().url()).searchParams.get('billboard') === '1' ? 'billboard' : 'player');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/hls/live-701/index.m3u8', format: 'm3u8', dvr: true }) });
  });
  const LIVE = { categories: [{ id: 'c1', name: 'US| ENT' }], items: [CHANNEL], totals: { items: 1 } };
  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'live' ? LIVE : { categories: [], items: [], totals: { items: 0 } }) });
  });
  await page.route('**/api/profiles/*/taste', (r) => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({
      recentlyWatched: [{ kind: 'live', id: CHANNEL.id, name: CHANNEL.name,
        key: `live:${CHANNEL.id}`, at: Date.now() }],
      continueWatching: [], categoryAffinity: [], ratings: {} }) }));
  await page.route('**/api/epg/now**', (r) => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"channels":[],"busy":false}' }));
  await page.route('**/api/scores**', (r) => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/xtream**', (r) => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"epg_listings":[]}' }));

  await page.addInitScript(() => {
    localStorage.setItem('portal.profile', 'own1');
    localStorage.setItem('portal.layout', 'desk');
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Hls && window.__ttDesktop, null, { timeout: 15000 });
  await page.evaluate(() => {
    document.querySelector('#tour')?.remove();
    state.config.mode = 'xtream';
    location.hash = '#/home';
    render();
  });

  /* ---- the billboard first ------------------------------------------------ */
  console.log('\n  the billboard');
  await page.waitForFunction(() => {
    const v = document.querySelector('#dkHero .hero-live.is-on');
    return v && !v.paused && v.currentTime > 0.5;
  }, null, { timeout: 25000 }).catch(() => {});
  const before = await page.evaluate(() => ({
    playing: Boolean(document.querySelector('#dkHero .hero-live.is-on')),
    why: window.__ttDesktop.heroLive.why,
  }));
  console.log('   ', JSON.stringify(before));
  check('the channel is playing behind the words', before.playing === true, JSON.stringify(before));

  /* ---- the press ---------------------------------------------------------- */
  console.log('\n  pressing Watch live');
  /* Watched from inside the page, every 50ms from the press on: is there a
     picture moving, is there sound, and did the player ever say it was
     building a buffer. */
  const sentAt = Date.now();
  plays = [];
  /* The trace starts in the same instant as the press, inside the page, so
     nothing before the press — a still-muted billboard — is counted. */
  await page.evaluate(() => {
    window.__trace = [];
    const t0 = performance.now();
    const status = () => (document.querySelector('#videoStatus')?.textContent || '').trim();
    const sample = () => {
      /* Before the player opens, the picture is still the billboard's, in
         place; after, it is the relay layer; then the player's own. */
      const relayV = document.querySelector('.relay-video')
        || document.querySelector('#dkHero .hero-live');
      const main = document.querySelector('#video');
      const relayLive = relayV && !relayV.paused && !relayV.classList.contains('is-leaving');
      const mainLive = main && !main.paused && main.readyState >= 3;
      window.__trace.push({
        t: Math.round(performance.now() - t0),
        picture: Boolean(relayLive || mainLive),
        sound: Boolean((relayLive && !relayV.muted) || (mainLive && !main.muted)),
        relay: Boolean(document.querySelector('.relay-video')),
        status: status(),
      });
    };
    const btn = document.querySelector('#dkHero .copy.on [data-go]')
      || document.querySelector('#dkHero [data-go]');
    btn.click();
    sample();
    window.__traceTimer = setInterval(sample, 50);
  });

  /* Done when the hand-over has finished: no relay layer, the player's own
     video playing. */
  await page.waitForFunction(() => {
    const main = document.querySelector('#video');
    return !document.querySelector('.relay-video') && main && !main.paused && main.currentTime > 0;
  }, null, { timeout: 15000 }).catch(() => {});
  const took = Date.now() - sentAt;
  await wait(400);
  const trace = await page.evaluate(() => { clearInterval(window.__traceTimer); return window.__trace; });
  /* The end is the first sample after the relay layer has come and gone. */
  const firstRelay = trace.findIndex((x) => x.relay);
  const end = trace.findIndex((x, i) => i > firstRelay && !x.relay);
  const during = trace.slice(1, end > 0 ? end : trace.length);
  const gaps = during.filter((x) => !x.picture);
  const silent = during.filter((x) => !x.sound);
  const buffering = trace.filter((x) => /building a buffer/i.test(x.status));
  console.log(`    hand-over finished in ${took}ms, ${during.length} samples;`
    + ` gaps ${gaps.length}, silent ${silent.length}, "building" ${buffering.length}`);
  console.log('    asked the box:', JSON.stringify(plays));

  check('the overlay is up', await page.evaluate(() => !document.querySelector('#playerOverlay').hidden));
  check('there was a relay — the billboard’s own picture carried into the player',
    trace.some((x) => x.relay), JSON.stringify(trace.slice(0, 4)));
  check('a picture on screen the whole way through, no blank', gaps.length === 0,
    JSON.stringify(gaps.slice(0, 3)));
  /* A sample or two of silence is the instant of the swap itself. */
  check('and sound all the way through', silent.length <= 2, JSON.stringify(silent.slice(0, 3)));
  check('the player never says it is building a buffer', buffering.length === 0,
    JSON.stringify(buffering.slice(0, 2)));
  check('the player’s own copy takes over within a few seconds', took < 6000, `${took}ms`);

  /* ---- and at the same moment --------------------------------------------- */
  /*
   * Asked of the playing video after the swap: which segment and how far into
   * it, against where the billboard was when it was pressed plus the time
   * since. Both copies read one playlist, so segment numbers mean the same
   * thing to each.
   */
  const where = await page.evaluate(() => {
    const v = document.querySelector('#video');
    const frags = engine?.levels?.[Math.max(0, engine.currentLevel)]?.details?.fragments || [];
    const f = frags.find((x) => v.currentTime >= x.start && v.currentTime < x.start + x.duration);
    return f ? { sn: f.sn, offset: v.currentTime - f.start, muted: v.muted } : null;
  });
  console.log('    player now at', JSON.stringify(where));
  check('the player has the sound now', where && where.muted === false, JSON.stringify(where));
  /* A segment is 2s here. The billboard sat about 32s behind the end of a
     60s playlist (segments 500-529), so it was around 513-514 when pressed;
     a reload would seat the player 45s back instead, around 507 — six or
     more segments away. */
  check('and it is where the billboard was, not seated somewhere else',
    where && where.sn >= 512 && where.sn <= 518, JSON.stringify(where));
  check('one ask of the box for the player, and the stream was already open',
    plays.filter((p) => p === 'player').length <= 1, JSON.stringify(plays));

  await page.evaluate(() => closePlayer());
  await wait(300);
  check('closing the player leaves nothing behind',
    await page.evaluate(() => !document.querySelector('.relay-video')));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
