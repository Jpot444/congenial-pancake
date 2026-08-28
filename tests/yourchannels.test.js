/**
 * Your channels — the row you arrange, and the billboard that plays one.
 *
 * Two features about the same list.
 *
 * THE ROW is the one part of this library the viewer builds themselves, so it
 * can be arranged: pick a card up and put it where you want it. The order is
 * stored as the favourites' own order on the box, which is what makes a row
 * arranged on the desktop the same row on the phone — and the permutation has
 * to be surgical, because favourites hold films and shows too and dragging a
 * channel must not shuffle the Favorites page.
 *
 * THE BILLBOARD, when it is on a channel, is that channel: the stream runs in
 * the slide, muted, behind the words. The rule that keeps it from costing
 * anything is that it plays only through the Pi's own DVR window — shared, so
 * the billboard and somebody watching for real are one ingest on the
 * provider's one connection — and never through the direct proxy, which is
 * that connection itself. A box that answers without the window gets no
 * preview at all, which is tested here as its own claim.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const CHANNELS = Array.from({ length: 5 }, (_, i) => ({
  kind: 'live', id: 700 + i, num: 700 + i, name: `US| CHANNEL ${i + 1} ᴴᴰ`, categoryId: 'c1', logo: '',
}));
const LIVE = { categories: [{ id: 'c1', name: 'USA' }], items: CHANNELS, totals: { items: 5 } };
/* A film sitting in the middle of the favourites, which is the thing a channel
   drag must not disturb. */
const FILM = { kind: 'movie', id: 900, name: 'A Film', categoryId: 'm1', ext: 'mp4' };
const PREFS = {
  favorites: [
    ...CHANNELS.slice(0, 2).map((c) => ({ key: `live:${c.id}`, item: c })),
    { key: 'movie:900', item: FILM },
    ...CHANNELS.slice(2).map((c) => ({ key: `live:${c.id}`, item: c })),
  ],
  pinnedCategories: [], deletedItems: [], deletedCategories: [], owner: true,
  tourDone: true, liveTourDone: true, reportNoticeSeen: true, dlExplainSeen: true,
};

/* A stand-in for hls.js: the CDN is not a dependency of a test about our own
   wiring, and a MediaSource with nothing in it is enough to prove the element
   was attached, told to play, and taken down again. */
const STAND_IN = () => {
  window.__hls = { url: '', config: null, destroyed: 0 };
  class StandInHls {
    static isSupported() { return true; }
    constructor(config) { window.__hls.config = config; }
    loadSource(url) { window.__hls.url = url; }
    attachMedia(video) {
      video.src = URL.createObjectURL(new MediaSource());
      setTimeout(() => video.dispatchEvent(new Event('playing')), 50);
    }
    on() {}
    startLoad() {}
    recoverMediaError() {}
    destroy() { window.__hls.destroyed += 1; }
  }
  StandInHls.Events = { ERROR: 'hlsError' };
  StandInHls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  window.Hls = StandInHls;
};

async function open(browser, { dvr = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.addInitScript(STAND_IN);
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/profiles/*/prefs', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREFS) })
    : r.continue()));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  page.__plays = [];
  await page.route('**/api/play**', (r) => {
    page.__plays.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: dvr
        ? '{"url":"/hls/live-700/index.m3u8","format":"m3u8","dvr":true}'
        // What the box answers when it has no ffmpeg or the ingest would not
        // start: the provider's own connection, proxied.
        : '{"url":"/api/proxy?u=x","format":"ts"}' });
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => { state.config.mode = 'xtream'; location.hash = '#/home'; });
  await page.waitForTimeout(2200);
  return page;
}

(async () => {
  const browser = await chromium.launch();

  /* ---- the billboard, playing ------------------------------------------ */
  console.log('\n  the billboard is the channel');
  const page = await open(browser);

  const hero = await page.evaluate(() => {
    const video = document.querySelector('#dkHero .live-preview');
    return {
      video: Boolean(video),
      muted: video?.muted,
      inline: video?.hasAttribute('playsinline'),
      playing: Boolean(document.querySelector('#dkHero .slide.is-playing')),
      source: window.__hls.url,
      seat: window.__hls.config?.liveSyncDuration,
      cta: document.querySelector('#dkHero .copy.on .dk-btn-p')?.textContent?.trim(),
    };
  });
  console.log('   hero:', JSON.stringify(hero));
  check('the channel is running in the slide', hero.video && hero.playing, JSON.stringify(hero));
  check('with no sound, which is what makes it a billboard and not a player',
    hero.muted === true, String(hero.muted));
  check('and inline, so a phone does not throw it into its own full screen',
    hero.inline === true, String(hero.inline));
  check('through the box\'s own window, not the provider\'s connection',
    hero.source === '/hls/live-700/index.m3u8', hero.source);
  check('seated where the player seats itself in the same window',
    hero.seat === 45, String(hero.seat));
  check('and the button still offers the full thing', hero.cta === 'Watch live', hero.cta);

  /* Home is redrawn several times while it settles. Asking the box to open
     the channel once per redraw is eight calls for one billboard, which on a
     single-connection box is not a small thing. */
  const asked = page.__plays.filter((u) => u.includes('kind=live')).length;
  console.log('   /api/play calls:', asked);
  check('the box is asked for the channel once, however often home redraws',
    asked === 1, String(asked));
  check('and asked for the DVR window by name',
    page.__plays[0]?.includes('ext=m3u8'), page.__plays[0]);

  console.log('\n  and it stops when nobody is looking at it');
  await page.evaluate(() => { location.hash = '#/movies'; });
  await page.waitForTimeout(1200);
  const gone = await page.evaluate(() => ({
    video: document.querySelectorAll('.live-preview').length,
    destroyed: window.__hls.destroyed,
  }));
  check('leaving home takes the stream down with it',
    gone.video === 0 && gone.destroyed >= 1, JSON.stringify(gone));

  /* ---- a box with no window to play through ---------------------------- */
  console.log('\n  a box that cannot offer its own window');
  const plain = await open(browser, { dvr: false });
  const noPreview = await plain.evaluate(() => ({
    video: document.querySelectorAll('#dkHero .live-preview').length,
    mark: Boolean(document.querySelector('#dkHero .slide')),
  }));
  console.log('   plain:', JSON.stringify(noPreview));
  check('nothing plays, because that answer IS the provider\'s one connection',
    noPreview.video === 0, JSON.stringify(noPreview));
  check('and the billboard is still there, as the mark it always was',
    noPreview.mark, JSON.stringify(noPreview));
  await plain.close();

  /* ---- dragging the row ------------------------------------------------ */
  console.log('\n  your channels, rearranged');
  await page.evaluate(() => { location.hash = '#/live'; });
  await page.waitForTimeout(1800);

  const rail = await page.evaluate(() => ({
    first: document.querySelector('#dkLive .shelf:first-child .shelf-title')?.textContent,
    count: document.querySelector('#dkLive .shelf:first-child .shelf-count')?.textContent,
    order: [...document.querySelectorAll('#dkLive .shelf:first-child .cht .mk')].map((m) => m.textContent),
  }));
  console.log('   rail:', JSON.stringify(rail));
  check('your channels lead the page', rail.first === 'Your channels', rail.first);
  check('and say they can be rearranged', /drag to reorder/i.test(rail.count || ''), rail.count);
  check('in the order they are stored in, not sorted for you',
    rail.order.join(',') === 'CHANNEL 1,CHANNEL 2,CHANNEL 3,CHANNEL 4,CHANNEL 5',
    JSON.stringify(rail.order));

  await page.evaluate(() =>
    document.querySelector('#dkLive .shelf:first-child').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  const grip = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#dkLive .shelf:first-child .cht')];
    const a = cards[0].getBoundingClientRect();
    const c = cards[2].getBoundingClientRect();
    return {
      from: { x: a.left + 24, y: a.bottom - 12 },
      to: { x: c.left + c.width / 2 + 20, y: c.bottom - 12 },
    };
  });
  await page.mouse.move(grip.from.x, grip.from.y);
  await page.mouse.down();
  await page.mouse.move(grip.from.x + 40, grip.from.y, { steps: 5 });
  await page.mouse.move(grip.to.x, grip.to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);

  const after = await page.evaluate(() => ({
    order: [...document.querySelectorAll('#dkLive .shelf:first-child .cht .mk')].map((m) => m.textContent),
    saved: (profiles.data.favorites || []).map((f) => f.key),
    playerOpen: !document.querySelector('#playerOverlay')?.hidden,
  }));
  console.log('   after:', JSON.stringify(after));
  check('the card lands where it was dropped',
    after.order.join(',') === 'CHANNEL 2,CHANNEL 3,CHANNEL 1,CHANNEL 4,CHANNEL 5',
    JSON.stringify(after.order));
  /* The film was third in the favourites and has to still be third: the
     channels are permuted through the positions they already occupied. */
  check('and the order is stored on the box, channels only',
    after.saved.join(',') === 'live:701,live:702,movie:900,live:700,live:703,live:704',
    JSON.stringify(after.saved));
  check('letting go does not tune the channel that happened to be underneath',
    !after.playerOpen, String(after.playerOpen));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
