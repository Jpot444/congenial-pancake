/**
 * The billboard plays the channel again — on a desktop, and nowhere else.
 *
 * "the live channels dont have any background, make it play the live channel
 *  again, only for the desktop display not the tesla phone or tv"
 *
 * A live feature has no backdrop to show. Its artwork is a station mark laid
 * out at its own size, so most of a 770-pixel billboard is tinted field, which
 * is what "no background" describes. The thing that fills it is the channel.
 *
 * THIS WAS TAKEN OUT ONCE AND THE REASON STILL STANDS: a stream in the
 * billboard holds a provider connection for as long as it runs, and the
 * ingest is kept alive by its own fetching, so it never goes idle and never
 * hands the slot back on its own. On a one-account box that is the whole
 * subscription spent on a page nobody is watching yet — which is not a
 * hypothetical here; "Refused: No connection free for this channel" is a
 * sentence this box has already said out loud.
 *
 * So most of this suite is not about the picture. It is about the four ways
 * the old version spent a login on nobody, each of which is now a rule:
 *
 *   it only runs where it was asked to run — not the car, not the television,
 *   not a phone borrowing this layout;
 *   it settles before it asks, so flicking through features opens nothing;
 *   it stops when nobody is looking — another page, a hidden tab;
 *   and it gives up in silence when the box refuses.
 *
 * ONE THING IS TESTED BY CONSTRUCTION AND SAID SO HERE: the hls.js branch.
 * Every suite blocks the CDN, so `window.Hls` is undefined in this browser
 * and the code takes its direct-source branch. The picture below is a real
 * mp4 through that branch — which is what proves the element is built,
 * attached, faded in and torn down — and the m3u8 path differs only in what
 * feeds the same element.
 */
const { chromium } = require('./playwright.js');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNELS = [1, 2, 3].map((i) => ({
  kind: 'live', id: 700 + i, num: 41000 + i,
  name: ['CBS HD', 'NBC CNBC', 'ESPN HD'][i - 1], categoryId: 'c1', logo: '',
}));
const LIVE = { categories: [{ id: 'c1', name: 'USA SPORTS' }], items: CHANNELS,
  totals: { items: CHANNELS.length } };

(async () => {
  /* Something that really decodes. A stubbed URL that never produces a frame
     would prove the request was made and nothing about what happens when it
     is answered — and "it faded in over the mark" is half the request.
   *
   * VP9 IN WEBM, not H.264. Playwright's Chromium is the open-source build
   * and ships without the proprietary codecs, so an mp4 comes back as
   * MEDIA_ERR_SRC_NOT_SUPPORTED and the suite measures the browser rather
   * than the page. Nothing about the code under test cares which codec
   * arrives. */
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('  no ffmpeg on this box — skipped');
    process.exit(0);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'herolive-'));
  const clip = path.join(scratch, 'hero-clip.webm');
  spawnSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=6',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-pix_fmt', 'yuv420p', clip]);
  if (!fs.existsSync(clip)) {
    console.log('  could not write a clip — skipped');
    process.exit(0);
  }
  const CLIP = fs.readFileSync(clip);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'live' ? LIVE
        : { categories: [], items: [], totals: { items: 0 } }) });
  });
  /* Real listings, because half of what this suite looks at is the grid
     underneath the billboard and a grid with nothing on it has no "on now"
     slab to have the wrong colour. One programme running now on every channel
     asked about, and two after it. */
  await page.route('**/api/epg/now**', (r) => {
    const ids = new URL(r.request().url()).searchParams.get('ids') || '';
    const now = Math.floor(Date.now() / 1000);
    const channels = ids.split(',').filter(Boolean).map((id) => ({
      id: Number(id),
      known: true,
      listings: [
        { title: 'Live: College Football', start: now - 1800, stop: now + 1800 },
        { title: 'Live: Postgame Show', start: now + 1800, stop: now + 3600 },
        { title: 'Live: College Football', start: now + 3600, stop: now + 12600 },
      ],
    }));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ channels, busy: false }) });
  });
  await page.route('**/api/scores**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"games":[],"feeds":[]}' }));

  /* Every request for a stream, which is the thing being counted: each one is
     a connection this box may not have to spare. */
  let asks = [];
  let refuse = false;
  /* Served from here rather than out of the box's public directory: the
     portal's static MIME map has no entry for webm, and teaching it one to
     satisfy a test would be the test changing the product. */
  await page.route('**/hero-clip.webm', (r) =>
    r.fulfill({ status: 200, contentType: 'video/webm', body: CLIP }));

  await page.route('**/api/play**', (r) => {
    const url = new URL(r.request().url());
    asks.push(url.searchParams.get('id'));
    if (refuse) {
      return r.fulfill({ status: 409, contentType: 'application/json',
        body: '{"error":"No connection free for this channel."}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/hero-clip.webm', format: 'mp4' }) });
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wait(1500);
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1600);
  }

  /** Home, as a profile whose last watch was a live channel. */
  const home = async (layout = 'desk') => {
    asks = [];
    await page.evaluate(({ chans, want }) => {
      document.querySelector('#tour')?.remove();
      state.config.mode = 'xtream';
      profiles.data.startersDone = true;
      profiles.data.favorites = chans.map((c) => ({ key: `live:${c.id}`, item: c }));
      /* The billboard leads with the last thing watched, so a live row here
         is what makes the first feature a channel. */
      state.recentlyWatched = [{ kind: 'live', id: chans[0].id, name: chans[0].name,
        at: Date.now() }];
      device.set(want);
      location.hash = '#/home';
      render();
    }, { chans: CHANNELS, want: layout });
    /* Longer than the settle delay, and then some: what is being measured is
       what happens once the page has stopped moving. */
    await wait(3200);
  };

  const shape = () => page.evaluate(() => {
    const video = document.querySelector('#dkHero .hero-live');
    return {
      slides: document.querySelectorAll('#dkHero .slide').length,
      video: Boolean(video),
      faded: Boolean(video && video.classList.contains('is-on')),
      marked: document.querySelectorAll('#dkHero .slide.has-live').length,
      playing: Boolean(video && !video.paused && video.currentTime > 0),
      muted: video ? video.muted === true : null,
      /* Nothing on a billboard should be reachable by a keyboard: it is
         wallpaper, and wallpaper you can tab into is a trap. */
      reachable: video ? video.tabIndex >= 0 : null,
      /* Which rule said no, in its own words. "It did not ask" and "it asked
         and the box refused" look identical from outside and are completely
         different faults. */
      why: window.__ttDesktop.heroLive.why,
    };
  });

  /* ---- on a desktop ------------------------------------------------------ */
  console.log('\n  on a desktop');
  await home('desk');
  const desk = await shape();
  console.log('   ', JSON.stringify(desk), 'asked:', JSON.stringify(asks));
  check('the channel is asked for, once', asks.length === 1, JSON.stringify(asks));
  check('and it is the one on the billboard', asks[0] === String(CHANNELS[0].id),
    JSON.stringify(asks));
  check('a picture is put behind the words', desk.video === true, JSON.stringify(desk));
  check('and it is really playing', desk.playing === true, JSON.stringify(desk));
  /* Sound on a page nobody pressed play on is the one thing this must never
     do. */
  check('silently', desk.muted === true, JSON.stringify(desk));
  check('and out of the keyboard’s way', desk.reachable === false, JSON.stringify(desk));
  /* Faded in on `playing` rather than on arrival — otherwise a stream that
     stalls leaves a black rectangle where the mark was, which is worse than
     the mark. */
  check('it fades in only once there are frames', desk.faded === true,
    JSON.stringify(desk));
  check('and the slide says so, so the mark can step aside', desk.marked === 1,
    String(desk.marked));

  /* ---- a repaint is not a second connection ------------------------------ */
  /*
   * Home rebuilds its billboard on every render — a library landing, a profile
   * poll, the guide finishing its passes — and each rebuild tears the stream
   * down. Asking again is the expensive half: `/api/play` is what reserves the
   * slot, so a page that repaints six times while somebody reads it would ask
   * six times. Within a minute the answer has not changed, so the address is
   * re-used and the box is not troubled.
   */
  console.log('\n  and a repaint of the same page');
  await page.evaluate(() => render());
  await wait(3000);
  const again = await shape();
  console.log('   ', JSON.stringify(again), 'asked:', JSON.stringify(asks));
  check('the billboard is playing again after the rebuild',
    again.playing === true, JSON.stringify(again));
  check('without asking the box for a second connection',
    asks.length === 1, JSON.stringify(asks));

  /* ---- and nowhere else -------------------------------------------------- */
  /*
   * The explicit half of the request. All three of these load the same layer —
   * the car and the television sit ON TOP of the desktop layout rather than
   * beside it — so "is this module on" is not the same question as "is this a
   * desktop", and each of the three is somewhere a page gets left up for
   * hours.
   */
  for (const [layout, called] of [['tv', 'the television'], ['car', 'the car'],
    ['phone', 'a phone']]) {
    console.log(`\n  on ${called}`);
    await home(layout);
    const got = await shape();
    console.log('   ', JSON.stringify(got), 'asked:', JSON.stringify(asks));
    check(`${called} asks the provider for nothing`, asks.length === 0,
      JSON.stringify(asks));
    check('and no stream is put on the page', got.video === false, JSON.stringify(got));
    /* The REASON, not just the absence — a billboard that stayed a still
       because the library had not loaded would pass the two checks above
       while the layout rule was broken. */
    check('because of where it is, not by accident',
      /not a desktop/.test(got.why), got.why);
  }

  /* ---- leaving the page hands it back ------------------------------------ */
  /*
   * Removing a video element does not stop what it is fetching, and what it
   * is fetching is the connection. Every navigation away from home would
   * otherwise leak one.
   */
  console.log('\n  and leaving home stops it');
  await home('desk');
  check('it is playing before we leave',
    (await shape()).playing === true, 'nothing was playing to stop');
  await page.evaluate(() => { location.hash = '#/movies'; render(); });
  await wait(900);
  const away = await page.evaluate(() => ({
    video: document.querySelectorAll('.hero-live').length,
    hero: Boolean(document.querySelector('#dkHero')),
  }));
  console.log('   ', JSON.stringify(away));
  check('the stream is gone, not merely off screen', away.video === 0,
    JSON.stringify(away));

  /* ---- and a box that has nothing to spare -------------------------------- */
  /*
   * The failure this feature risks, answered the only way a billboard may
   * answer it: by carrying on looking like a billboard. A decoration does not
   * get to put an error over the page.
   */
  console.log('\n  when the box has no connection free');
  refuse = true;
  /* The address it was given earlier is deliberately thrown away first. The
     cache above is a minute long and would carry this run straight past the
     ask, which is the very thing being tested — and on a real box reusing a
     half-minute-old address for a session that is probably still alive is the
     right answer, so it is cleared here rather than shortened there. */
  await page.evaluate(() => { window.__ttDesktop.heroLive.held = null; });
  await home('desk');
  const refused = await shape();
  const said = await page.evaluate(() =>
    (document.querySelector('#toast')?.textContent || '').trim());
  console.log('   ', JSON.stringify(refused), 'asked:', JSON.stringify(asks), 'said:', said);
  check('it asks', asks.length === 1, JSON.stringify(asks));
  check('and then leaves the billboard exactly as it was',
    refused.video === false && refused.marked === 0, JSON.stringify(refused));
  check('without a word about it', !/connection|refus|error/i.test(said), said);
  /* But it does write down what happened, where somebody looking for it can
     find it. Silence on the screen is not the same as silence everywhere. */
  check('while still recording what the box said',
    /the box answered 409/.test(refused.why), refused.why);
  refuse = false;

  /* ---- the guide it sits above ------------------------------------------- */
  /*
   * "visually the tonights guide is clashing with the red hue in the page"
   *
   * Two things were doing it. The panel was 2.2% white over black — very
   * nearly transparent — so the billboard's red glow ran straight through the
   * listings and every row sat on a different shade of red. And "on now" was
   * filled and outlined in red, which is a fine highlight for one slab and a
   * red stripe down the whole grid when every row has one.
   */
  console.log('\n  and the guide underneath it');
  await home('desk');
  const guide = await page.evaluate(() => {
    const grid = document.querySelector('.home-guide .guide-grid');
    const now = document.querySelector('.home-guide .guide-prog.is-now');
    const line = document.querySelector('.home-guide .guide-now-line');
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    /* Red enough to read as the accent: a red channel well clear of the other
       two. Measured rather than compared as a string, so it is about the
       colour and not about how it is spelled. */
    const reddish = (s) => {
      const [r, g, b, a = 1] = rgb(s);
      return a > 0.02 && r > g + 28 && r > b + 28;
    };
    return {
      gridBg: grid ? getComputedStyle(grid).backgroundColor : null,
      gridOpaque: grid ? (rgb(getComputedStyle(grid).backgroundColor)[3] ?? 1) > 0.6 : null,
      nowBg: now ? getComputedStyle(now).backgroundColor : null,
      nowBorder: now ? getComputedStyle(now).borderTopColor : null,
      nowIsRed: now ? reddish(getComputedStyle(now).backgroundColor)
        || reddish(getComputedStyle(now).borderTopColor) : null,
      lineIsRed: line ? reddish(getComputedStyle(line).backgroundColor) : null,
    };
  });
  console.log('   ', JSON.stringify(guide));
  /* The listings get their own ground rather than being a window onto the
     page's glow. */
  check('the grid is a surface, not a window onto the red',
    guide.gridOpaque === true, guide.gridBg);
  /* A highlight that is on every row is not a highlight. */
  check('and what is on now is not another red panel',
    guide.nowIsRed === false, `${guide.nowBg} / ${guide.nowBorder}`);
  /* Red is left to the one mark that really is single. */
  check('the now line keeps the red, having the field to itself',
    guide.lineIsRed === true, String(guide.lineIsRed));

  fs.rmSync(scratch, { recursive: true, force: true });
  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
