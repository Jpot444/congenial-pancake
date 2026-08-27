/**
 * The top of the live player, and whose taps land where.
 *
 * A live channel keeps the browser's own video controls, and on iOS those are
 * drawn in the TOP-LEFT corner of the picture — fullscreen and
 * picture-in-picture, right where our back button and channel name are. They
 * looked like they were covering the buttons. They were not: `.cinema-top` is a
 * full-width strip with a gradient on it and 26px of padding, and the strip was
 * swallowing every tap that landed anywhere along the top of the frame.
 *
 * A gradient is not a button. So the strip passes taps through and the controls
 * inside it take their own, which is checked here by asking what is actually
 * under the finger — and by putting the fault back to prove the checks would
 * have caught it.
 *
 * Belt and braces on top of that: live gets a fullscreen button of our own, in
 * the corner our buttons already live in, so a game never depends on reaching
 * around somebody else's overlay.
 */
const { chromium, devices } = require('./playwright.js');
const PATHS = require('./paths.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNEL = { kind: 'live', id: 1, logo: '', categoryId: 'c1',
  name: 'NFL | 12 - 8/15 1PM VIKINGS AT GIANTS' };
const FILM = { kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mp4', categoryId: 'm1' };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  // Landscape on a phone: the shape the fault was reported in, and the one
  // where the top strip is widest relative to the picture.
  const page = await browser.newPage({ ...devices['iPhone 13 Pro landscape'] });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/api/play*', (r) => {
    if (new URL(r.request().url()).pathname !== '/api/play') return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'm3u8' }) });
  });
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate((ch) => {
    state.library.live = { categories: [{ id: 'c1', name: 'US| SPORTS' }], items: [ch] };
    state.downloads = { items: [], active: null, queued: 0 };
    location.hash = '#/live';
    render();
    openPlayer(ch);
  }, CHANNEL);
  await wait(2500);

  // Where iOS draws its own controls: the top-left of the video element. Three
  // points across that corner, because the native strip is a row not a dot.
  const corner = () => page.evaluate(() => {
    const v = document.querySelector('#video').getBoundingClientRect();
    return [[24, 22], [60, 22], [100, 14]].map(([dx, dy]) => {
      const el = document.elementFromPoint(v.left + dx, v.top + dy);
      // className is not a string on an SVG element, and the strip answers to
      // its id rather than its class — name it by whichever exists.
      return el ? (el.id || (typeof el.className === 'string' && el.className)
        || el.tagName) : null;
    });
  });

  console.log('\n  the corner iOS puts its controls in');
  const now = await corner();
  console.log('   under the finger:', JSON.stringify(now));
  check('taps in that corner reach the video, not our chrome',
    now.every((hit) => hit === 'video'), JSON.stringify(now));

  // Put the fault back. If these checks would pass either way they are not
  // checking anything.
  const broken = await page.evaluate(async () => {
    document.querySelector('.cinema-top').style.pointerEvents = 'auto';
    const v = document.querySelector('#video').getBoundingClientRect();
    const hits = [[24, 22], [60, 22], [100, 14]].map(([dx, dy]) => {
      const el = document.elementFromPoint(v.left + dx, v.top + dy);
      return el ? (el.id || (typeof el.className === 'string' && el.className)
        || el.tagName) : null;
    });
    document.querySelector('.cinema-top').style.pointerEvents = '';
    return hits;
  });
  console.log('   with the strip taking taps again:', JSON.stringify(broken));
  check('and the strip really was what took them, before',
    broken.some((hit) => /cinemaTop|cinema-top/.test(String(hit))), JSON.stringify(broken));

  // The controls in the strip still work — passing taps through must not have
  // switched the back button off with it.
  console.log('\n  the controls in it still take theirs');
  const backHit = await page.evaluate(() => {
    const b = document.querySelector('#cinemaBack').getBoundingClientRect();
    const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return el ? (el.closest('#cinemaBack') ? 'cinemaBack' : (el.id || el.className)) : null;
  });
  check('the back button is still the thing under the back button', backHit === 'cinemaBack',
    String(backHit));

  const titleThrough = await page.evaluate(() => {
    const t = document.querySelector('#cinemaTop .cinema-titles');
    const b = t.getBoundingClientRect();
    // Just past the end of the text, still inside the strip.
    const el = document.elementFromPoint(b.right + 40, b.top + b.height / 2);
    return el ? (el.id || (typeof el.className === 'string' && el.className)
      || el.tagName) : null;
  });
  console.log('   beside the channel name:', JSON.stringify(titleThrough));
  check('and empty space beside the name is not a tap target',
    !/cinemaTop|cinema-top/.test(String(titleThrough)), String(titleThrough));

  // --- the name stops before the buttons ------------------------------------
  //
  // The strip reserved a flat 200px for that corner, which was right for the
  // four buttons there when it was written and wrong the moment a fifth
  // arrived: the channel name ran on underneath the LIVE pill. Which buttons
  // are up depends on what is playing, so the figure cannot be a constant.
  console.log('\n  the name and the buttons');
  const room = await page.evaluate(() => {
    const title = document.querySelector('#cinemaTop .cinema-titles h2')
      .getBoundingClientRect();
    const actions = document.querySelector('.player-bar-actions').getBoundingClientRect();
    const reserved = getComputedStyle(document.querySelector('.cinema-top')).paddingRight;
    return { titleRight: Math.round(title.right), actionsLeft: Math.round(actions.left),
      reserved, actionsWidth: Math.round(actions.width) };
  });
  console.log('   room:', JSON.stringify(room));
  check('the channel name stops before the buttons start',
    room.titleRight <= room.actionsLeft, JSON.stringify(room));
  check('and the space reserved for them is measured, not a flat guess',
    parseFloat(room.reserved) >= room.actionsWidth, JSON.stringify(room));

  // --- the native strip is gone on Apple touch ------------------------------
  //
  // Its buttons render in the top-left corner of the picture — directly under
  // our back button, which eats the tap — and everything it offered is in our
  // top bar now. This page runs as an iPhone, so the strip must be off and
  // our play/pause standing in for it.
  console.log('\n  the native control strip, on an iPhone');
  const strip = await page.evaluate(() => {
    const bar = document.querySelector('#liveBar');
    const barBox = bar.getBoundingClientRect();
    const video = document.querySelector('#video').getBoundingClientRect();
    const cc = document.querySelector('#ccWrap').getBoundingClientRect();
    return {
      controls: document.querySelector('#video').controls,
      barShown: !bar.hidden,
      playInBar: Boolean(bar.contains(document.querySelector('#livePlay'))),
      playTitle: document.querySelector('#livePlay').title,
      // The whole point of the strip: the crowded top row loses two buttons
      // and the thumb gets them at the bottom of the screen instead.
      barLow: barBox.top > video.top + video.height / 2,
      ccInBar: bar.contains(document.querySelector('#ccWrap')),
      ccRight: cc.left > barBox.left + barBox.width / 2,
      ccOffTop: !document.querySelector('.player-bar-actions')
        .contains(document.querySelector('#ccWrap')),
    };
  });
  console.log('   ', JSON.stringify(strip));
  check('live on Apple touch runs on our chrome alone', strip.controls === false,
    JSON.stringify(strip));
  check('with a play/pause of ours standing in', strip.barShown && strip.playInBar,
    JSON.stringify(strip));
  check('at the bottom of the screen, where a thumb already is', strip.barLow,
    JSON.stringify(strip));
  check('and captions docked at the bottom right, out of the crowded top row',
    strip.ccInBar && strip.ccRight && strip.ccOffTop, JSON.stringify(strip));
  const toggled = await page.evaluate(async () => {
    document.querySelector('#livePlay').click();
    await new Promise((r) => setTimeout(r, 300));
    const paused = document.querySelector('#video').paused;
    const title = document.querySelector('#livePlay').title;
    document.querySelector('#livePlay').click();
    await new Promise((r) => setTimeout(r, 300));
    return { paused, title, resumed: !document.querySelector('#video').paused };
  });
  check('that really pauses and resumes the channel',
    toggled.paused && toggled.resumed, JSON.stringify(toggled));
  check('and the icon follows the element', toggled.title === 'Play', toggled.title);
  // Everywhere that is not Apple touch, the strip stays — the decision is the
  // one expression, so the desktop half is checked at the source.
  const SRC = fs.readFileSync(PATHS.APP, 'utf8');
  check('while desktop live keeps the native strip',
    (SRC.match(/controls = !\(currentLiveItem && isIOS\(\)\)/g) || []).length >= 2);

  // --- our own way to full screen ------------------------------------------
  console.log('\n  a fullscreen button of our own');
  const ours = await page.evaluate(() => {
    const b = document.querySelector('#liveFull');
    const box = b.getBoundingClientRect();
    const v = document.querySelector('#video').getBoundingClientRect();
    return {
      shown: !b.hidden,
      // Top-right, with the rest of our buttons — the opposite corner from
      // the one iOS uses, so the two can never argue.
      rightHalf: box.left > v.left + v.width / 2,
      topStrip: box.top < v.top + 120,
      hit: (() => {
        const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return el && el.closest('#liveFull') ? 'liveFull' : (el && (el.id || el.className));
      })(),
    };
  });
  console.log('   ours:', JSON.stringify(ours));
  check('live has a fullscreen button in our own chrome', ours.shown, JSON.stringify(ours));
  check('in the opposite corner from the one iOS uses, so they cannot argue',
    ours.rightHalf && ours.topStrip, JSON.stringify(ours));
  check('and it is reachable', ours.hit === 'liveFull', String(ours.hit));

  // It is live's. A film already has one in the film bar and two would be one
  // too many.
  await page.evaluate((film) => {
    state.library.movies = { categories: [{ id: 'm1', name: 'Films' }], items: [film] };
    closePlayer();
  }, FILM);
  await wait(500);
  await page.evaluate(() => openPlayer(state.library.movies.items[0]));
  await wait(2500);
  const onFilm = await page.evaluate(() => ({
    live: !document.querySelector('#liveFull').hidden,
    vod: Boolean(document.querySelector('#vodFull')),
  }));
  console.log('   on a film:', JSON.stringify(onFilm));
  check('a film does not get a second one', onFilm.live === false, JSON.stringify(onFilm));
  check('having its own in the film bar already', onFilm.vod);

  // Both buttons go through the same call, or they drift.
  const APP = fs.readFileSync(PATHS.APP, 'utf8');
  check('and both buttons run the same fullscreen path',
    /\$\('#vodFull'\)\.addEventListener\('click', goFullscreen\);/.test(APP)
    && /\$\('#liveFull'\)\.addEventListener\('click', goFullscreen\);/.test(APP),
    'the two buttons have separate handlers');

  await page.evaluate(() => closePlayer());
  await wait(400);
  await page.evaluate((ch) => openPlayer(ch), CHANNEL);
  await wait(2000);
  await page.screenshot({ path: __dirname + '/shots/live-ios.png' });

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
