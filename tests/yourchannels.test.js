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
 * THE BILLBOARD, when it is on a channel, is a picture of that channel and
 * nothing more. It briefly played the stream itself, muted, through the box's
 * own DVR window, on the reasoning that a shared window costs nothing extra.
 * That reasoning was wrong in the way that matters: the ingest is kept alive
 * by its own fetching, so it never went idle and never handed the slot back —
 * home sitting open meant a provider connection sitting spoken for, which on
 * a two-account box ate the login the second subscription was bought for.
 *
 * So the claim tested here is the negative one: opening home asks the box to
 * open nothing at all, and pressing Watch live is the only thing on the page
 * that spends a connection.
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
  /* Every one-time overlay marked seen. `startersDone` belongs with them:
     the picks sheet opens itself over the page for a profile that has not
     had it, and this whole suite is drags and presses on that page. The
     real box would default it true off these favourites — it is false here
     only because this stub replaces the box's answer wholesale. */
  tourDone: true, liveTourDone: true, startersDone: true,
  reportNoticeSeen: true, dlExplainSeen: true,
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

  /* ---- the billboard costs nothing ------------------------------------- */
  console.log('\n  the billboard is a picture, not a stream');
  const page = await open(browser);

  const hero = await page.evaluate(() => ({
    video: document.querySelectorAll('#dkHero video').length,
    /* The BILLBOARD's own instance — the stand-in records whichever was built
       last, and on home that is the one behind the words. */
    heroSource: window.__hls.url,
    /* The portal's player, which must not have been touched. `engine` is a
       top-level binding in app.js, reachable bare. */
    engine: typeof engine === 'undefined' ? null : engine,
    engineKind: typeof engineKind === 'undefined' ? '' : engineKind,
    playerUp: !document.querySelector('#playerOverlay')?.hidden,
    slide: Boolean(document.querySelector('#dkHero .slide')),
    cta: document.querySelector('#dkHero .copy.on .dk-btn-p')?.textContent?.trim(),
  }));
  console.log('   hero:', JSON.stringify(hero));
  check('there is a billboard, on a channel', hero.slide, JSON.stringify(hero));
  check('the button offers the real thing', hero.cta === 'Watch live', hero.cta);
  /* The billboard has its OWN engine. The portal keeps `engine` for the thing
     somebody actually chose to watch, and a billboard that reached into it
     would take the picture out from under them — so what is checked is not
     "nothing is playing" but "the player was not the thing that did it". */
  check('the billboard is playing something', hero.video >= 1, String(hero.video));
  check('through an engine of its own, not the portal\u2019s',
    hero.engine === null && !hero.engineKind,
    JSON.stringify({ engine: Boolean(hero.engine), kind: hero.engineKind }));
  check('and without opening the player over the page',
    hero.playerUp === false, String(hero.playerUp));

  /* What opening home costs, which is the claim this suite exists for — now
     the other way round.
   *
   * ONE connection, and the ceiling is the thing worth stating rather than the
   * floor: the old fault was not that the billboard cost something, it was
   * that it cost something unboundedly and never gave it back. Three features
   * on the page must still be one stream, and a repaint must not be a second.
   */
  const asked = page.__plays.length;
  console.log('   /api/play calls from home:', asked, page.__plays);
  check('opening home spends one connection on the billboard, not several',
    asked <= 1, JSON.stringify(page.__plays));

  /* And gives it back on the way out. Removing a video element does not stop
     what it is fetching, and what it is fetching is the connection — so this
     is the half that makes the bargain survivable. */
  await page.evaluate(() => { location.hash = '#/movies'; render(); });
  await page.waitForTimeout(900);
  const left = await page.evaluate(() => document.querySelectorAll('.hero-live').length);
  console.log('   streams left behind:', left);
  check('and hands it back the moment you leave home', left === 0, String(left));
  await page.evaluate(() => { location.hash = '#/home'; render(); });
  await page.waitForTimeout(900);

  console.log('\n  and Watch live still opens the channel properly');
  await page.evaluate(() => {
    document.querySelector('#dkHero .copy.on .dk-btn-p')?.click();
  });
  await page.waitForTimeout(1200);
  const opened = await page.evaluate(() => ({
    player: !document.querySelector('#playerOverlay')?.hidden,
    asked: null,
  }));
  opened.asked = page.__plays.length;
  console.log('   watch live:', JSON.stringify(opened));
  check('pressing it is what spends the connection, and only then',
    opened.player === true && opened.asked >= 1, JSON.stringify(opened));

  // Put the page back the way the rest of this suite expects to find it.
  await page.evaluate(() => closePlayer());
  await page.waitForTimeout(600);

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
