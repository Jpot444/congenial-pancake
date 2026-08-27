/**
 * The Shield app's live player keeps the picture it tuned.
 *
 * The screen has three states — bare picture, guide, channel bar — and every
 * one of them is a repaint of the whole player. That is fine for chrome and
 * fatal for video: a repaint that built a fresh <video> left hls.js feeding an
 * element no longer on the page, so the chrome was right, the scrim said LIVE,
 * and the rectangle behind it stayed black. Tuning itself ENDS in a repaint,
 * which made it every channel, every time. Films and archive episodes never
 * showed it because that screen paints once and never again.
 *
 * So the claim under test is an identity one: the element the engine attached
 * to is the element in the document, and it is still that element after the
 * guide has been opened and closed. Both engines publish themselves the same
 * way — MSE hands the element a blob: source the moment it attaches — so a
 * blob on the node in the page is proof the two are the same node, without
 * needing a real stream to decode.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const LIVE = {
  categories: [{ id: 'c1', name: 'USA ENTERTAINMENT' }],
  items: [
    { kind: 'live', id: 101, num: 101, name: 'ABC WABC NEW YORK', logo: '', categoryId: 'c1' },
    { kind: 'live', id: 102, num: 102, name: 'NBC WNBC NEW YORK', logo: '', categoryId: 'c1' },
  ],
  totals: { items: 2 },
};

/* A playlist hls.js will parse. The segments behind it are not served and do
   not need to be: attachMedia happens before the first fetch, so the identity
   claim is settled either way, and a fragment that never arrives is exactly
   the case the new error handler is there for. */
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:6.000,',
  'seg0.ts',
  '#EXTINF:6.000,',
  'seg1.ts',
].join('\n');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  /* hls.js comes off a CDN, which is a network this may not have and a
     version that can change under the suite. Neither belongs in a test about
     our own wiring, so the CDN is cut and a stand-in put in its place: it
     answers isSupported, records the settings it was given, and hands the
     element the same blob: source real MSE attachment does. Everything the
     assertions below look at is our code's side of that contract. */
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.addInitScript(() => {
    window.__hls = { config: null, url: '', handlers: [] };
    class StandInHls {
      static isSupported() { return true; }
      constructor(config) { window.__hls.config = config; }
      loadSource(url) { window.__hls.url = url; }
      attachMedia(video) { video.src = URL.createObjectURL(new MediaSource()); }
      on(event) { window.__hls.handlers.push(event); }
      startLoad() {}
      recoverMediaError() {}
      destroy() {}
    }
    StandInHls.Events = { ERROR: 'hlsError', FRAG_BUFFERED: 'hlsFragBuffered' };
    StandInHls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    window.Hls = StandInHls;
  });

  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  await page.route('**/api/scores/nfl**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  /* What the box really answers for a live channel it can put through its own
     DVR window: a local playlist, and the flag that seats the player further
     back in it. */
  await page.route('**/api/play**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/hls/live-101/index.m3u8","format":"m3u8","dvr":true}' }));
  await page.route('**/hls/**/index.m3u8', (r) =>
    r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: PLAYLIST }));

  await page.goto(`${BASE}/tv/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  console.log('\n  the app comes up on Live TV');
  const home = await page.evaluate(() => ({
    channels: [...document.querySelectorAll('[data-kind="chan"]')].length,
    hls: Boolean(window.Hls && window.Hls.isSupported()),
  }));
  check('the live screen has channels to tune', home.channels > 0, JSON.stringify(home));
  check('and an HLS engine is present, so the HLS path is the one under test', home.hls);

  console.log('\n  tuning a channel');
  await page.locator('[data-kind="chan"]').first().click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);

  const tuned = await page.evaluate(() => {
    const video = document.querySelector('#overlay .player video');
    if (video) video.dataset.probe = 'tuned';
    return {
      videos: document.querySelectorAll('video').length,
      onPage: Boolean(video),
      src: video ? String(video.src).slice(0, 5) : '',
      chrome: Boolean(document.querySelector('.player-scrim')),
    };
  });
  console.log('   player:', JSON.stringify(tuned));

  check('there is a video element on the page', tuned.onPage, JSON.stringify(tuned));
  check('the engine attached to THAT element, not one thrown away',
    tuned.src === 'blob:', `src starts "${tuned.src}"`);
  check('and there is exactly one video element, not a discarded pile',
    tuned.videos === 1, String(tuned.videos));
  check('with the chrome over it', tuned.chrome);

  /* The box said this channel comes through its own DVR window, which is a
     longer playlist than the provider's — so the player seats itself further
     back in it rather than riding the ingest frontier. */
  const cfg = await page.evaluate(() => window.__hls);
  console.log('   engine:', JSON.stringify(cfg));
  check('the DVR window is joined well behind its edge',
    cfg.config && cfg.config.liveSyncDuration === 45, JSON.stringify(cfg.config));
  check('the latency chaser is parked out of reach',
    cfg.config && cfg.config.liveMaxLatencyDuration >= 600, JSON.stringify(cfg.config));
  check('and the engine was given the box\'s own playlist',
    cfg.url === '/hls/live-101/index.m3u8', cfg.url);
  check('with somebody listening for its errors', cfg.handlers.includes('hlsError'));

  console.log('\n  opening and closing the guide');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const guided = await page.evaluate(() => ({
    guide: Boolean(document.querySelector('.guide')),
    probe: document.querySelector('#overlay .player video')?.dataset.probe || '',
    src: String(document.querySelector('#overlay .player video')?.src || '').slice(0, 5),
  }));
  console.log('   guide :', JSON.stringify(guided));
  check('the guide opens', guided.guide, JSON.stringify(guided));

  /* A guide is a schedule for channels that belong together, and here that is
     the category the channel on screen is in — not the flip list, which is a
     good order to press CHANNEL UP through and a poor thing to read. */
  const schedule = await page.evaluate(() => ({
    head: document.querySelector('.guide-head h2')?.textContent || '',
    rows: [...document.querySelectorAll('.guide-name')].map((n) => n.textContent),
    multi: Boolean(document.querySelector('.guide-mv')),
  }));
  console.log('   sched :', JSON.stringify(schedule));
  check('and it is the category of what is playing, by name',
    schedule.head === 'USA ENTERTAINMENT', schedule.head);
  check('listing that category and nothing else',
    schedule.rows.length === 2 && schedule.rows.every((n) => n.startsWith('ABC') || n.startsWith('NBC')),
    schedule.rows.join(' | '));
  check('with a way into multi-view from inside it', schedule.multi);
  check('over the same video element it was already playing',
    guided.probe === 'tuned' && guided.src === 'blob:', JSON.stringify(guided));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({
    guide: Boolean(document.querySelector('.guide')),
    probe: document.querySelector('#overlay .player video')?.dataset.probe || '',
    src: String(document.querySelector('#overlay .player video')?.src || '').slice(0, 5),
    videos: document.querySelectorAll('video').length,
  }));
  console.log('   closed:', JSON.stringify(closed));
  check('BACK closes the guide', !closed.guide, JSON.stringify(closed));
  check('and the picture is still the same element, still attached',
    closed.probe === 'tuned' && closed.src === 'blob:' && closed.videos === 1,
    JSON.stringify(closed));

  await browser.close();

  /* ---- the two things that are claims about the code, not the DOM -------- */
  console.log('\n  what the engines are told');
  const PLAYER = fs.readFileSync(
    path.join(PATHS.PUBLIC, 'tv', 'js', 'screens', 'player.js'), 'utf8');
  const MULTI = fs.readFileSync(
    path.join(PATHS.PUBLIC, 'tv', 'js', 'screens', 'multi.js'), 'utf8');

  // mpegts.js fetches inside a Web Worker, which has no document base URL, so
  // the box's own relative "/api/proxy?…" throws there rather than playing.
  check('the TS feed is handed an absolute URL, which is the only kind a worker can use',
    /createPlayer\(\s*(?:\/\*[\s\S]*?\*\/\s*)?\{[^}]*url: new URL\(/.test(PLAYER),
    'player.js');
  check('and so is every multi-view cell',
    /createPlayer\(\s*(?:\/\*[\s\S]*?\*\/\s*)?\{[^}]*url: new URL\(/.test(MULTI),
    'multi.js');
  // A live playlist rolls; a fragment that fails is a thing to pick back up,
  // not a thing to die on.
  check('a fatal network error restarts the load rather than ending the channel',
    /NETWORK_ERROR\) hls\.startLoad\(\)/.test(PLAYER)
      && /NETWORK_ERROR\) cell\.hls\.startLoad\(\)/.test(MULTI));
  check('a media error is recovered', /recoverMediaError\(\)/.test(PLAYER));
  check('and a channel that never produces a picture says so',
    /PICTURE_BY_MS/.test(PLAYER) && /appRef\.toast/.test(PLAYER));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
