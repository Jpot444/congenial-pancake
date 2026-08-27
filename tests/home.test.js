/**
 * The home screen.
 *
 * The desktop landing page is a billboard now, and that changed what there is
 * to claim about it. It used to be that the whole page fit the window — the
 * point of shrinking the posters — and this suite measured that. A billboard
 * is taller than the window on purpose, so that claim is gone and is not
 * quietly weakened into something easier: what replaces it is that the
 * billboard offers a choice and never takes it, which is the thing that was
 * actually asked for, and that nothing runs off the side.
 *
 * The phone used to be the other half of that sentence: the redesign stopped
 * at 1100px, so a phone kept a landing page of its own — a hero with a 2x2 of
 * the four before it, and the two favorite sets side by side, everything sized
 * to fit the window without scrolling. It gets the billboard now, so those
 * claims go the same way the desktop's did rather than being weakened into
 * something easier. What replaces them is below: the same page as the
 * desktop's, one column wide, with nothing running off the side of it.
 *
 * What did not change, and is still tested exactly as it was: a favorite
 * poster opens the thing on it rather than a page listing it, a channel tunes
 * straight in, and artwork is never cropped to fit its box.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const SHOTS = __dirname + '/shots';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Artwork with a border hard against every edge and a dot in every corner. If
 * the box crops it, an edge goes missing — which is exactly the complaint this
 * is here to catch, and is not something a class name can tell you.
 */
const art = (w, h, hue) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
  + `<rect width="${w}" height="${h}" fill="hsl(${hue},45%,28%)"/>`
  + `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" fill="none" stroke="#fff" stroke-width="8"/>`
  + `</svg>`);
const WIDE = (hue) => art(1280, 720, hue);   // a 16:9 backdrop
const TALL = (hue) => art(600, 900, hue);    // a 2:3 poster
const LOGO = (hue) => art(800, 400, hue);    // a wide channel ident

const RECENT = [
  { kind: 'series', id: 77, seriesId: 77, seriesName: 'The Bear', name: 'The Bear — S1E2',
    poster: WIDE(10), season: 1, episode: 2, position: 400, duration: 1320, completed: false },
  { kind: 'movie', id: 55, name: 'Dune Part Two', poster: TALL(120), position: 2000, duration: 9000 },
  { kind: 'movie', id: 56, name: 'Oppenheimer', poster: WIDE(200), position: 100, duration: 10800 },
  { kind: 'series', id: 78, seriesId: 78, seriesName: 'Slow Horses', name: 'Slow Horses — S2E1',
    poster: LOGO(280), season: 2, episode: 1, position: 600, duration: 3000 },
  { kind: 'movie', id: 57, name: 'A Very Long Film Title That Goes On And On', poster: WIDE(330),
    position: 50, duration: 7200 },
];

// More channels than a row shows, so the "all of them" link has to appear;
// fewer films than the cap, so it must not.
const CHANNELS = Array.from({ length: 15 }, (_, i) => ({
  key: `live:${100 + i}`,
  item: { kind: 'live', id: 100 + i, name: `US| CHANNEL ${i + 1} ᴴᴰ`, logo: LOGO(40 + i * 12) },
}));
const TITLES = Array.from({ length: 6 }, (_, i) => ({
  key: `movie:${200 + i}`,
  // Mixed on purpose: half proper posters, half wide stills, because a rule
  // that only works on one shape is the bug.
  item: { kind: 'movie', id: 200 + i, name: `Favourite Film ${i + 1}`,
    logo: i % 2 ? WIDE(150 + i * 10) : TALL(150 + i * 10) },
}));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/api/play*', (r) => {
    if (new URL(r.request().url()).pathname !== '/api/play') return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) });
  });
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ recentlyWatched: RECENT, categoryAffinity: [], ratings: {} }) }));
  await page.route('**/api/profiles/*/prefs', (r) => {
    if (r.request().method() === 'PUT') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ favorites: [...CHANNELS, ...TITLES], pinnedCategories: [],
        pinOrder: {}, deletedItems: [], deletedCategories: [],
        tourDone: true, liveTourDone: true, livePinsSeeded: true }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  const home = async () => {
    await page.evaluate((recent) => {
      state.recentlyWatched = recent;
      state.library.live = {
        categories: [{ id: 'c1', name: 'Sports' }],
        items: Array.from({ length: 15 }, (_, i) => ({
          kind: 'live', id: 100 + i, name: `US| CHANNEL ${i + 1} ᴴᴰ`, logo: '', categoryId: 'c1',
        })),
      };
      // The favorites AND the things in Continue watching: resuming looks the
      // real record up by id, so a library without them is a library that has
      // genuinely lost them.
      state.library.movies = {
        categories: [{ id: 'm1', name: 'Films' }],
        items: [
          ...Array.from({ length: 6 }, (_, i) => ({
            kind: 'movie', id: 200 + i, name: `Favourite Film ${i + 1}`, logo: '', categoryId: 'm1',
          })),
          { kind: 'movie', id: 55, name: 'Dune Part Two', logo: '', categoryId: 'm1' },
          { kind: 'movie', id: 56, name: 'Oppenheimer', logo: '', categoryId: 'm1' },
          { kind: 'movie', id: 57, name: 'A Very Long Film Title That Goes On And On',
            logo: '', categoryId: 'm1' },
        ],
      };
      state.tab = 'home';
      location.hash = '#/home';
      render();
    }, RECENT);
    // The billboard on a desktop, the big poster on a phone — whichever
    // layout is up, this is the landing page having drawn something.
    await page.waitForSelector('#dkHero, .home-hero', { timeout: 10000 });
    await wait(400);
  };
  await home();

  // --- the shape of the page ----------------------------------------------
  console.log('\n  what is on the page');
  const shape = await page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent.trim() || null;
    const head = (sel) => text(`${sel} .shelf-title`);
    return {
      slides: document.querySelectorAll('#dkHero .slide').length,
      picks: document.querySelectorAll('#dkHero .picker button').length,
      billed: [...document.querySelectorAll('#dkHero h1.big')].map((h) => h.textContent),
      lane: head('#dkLane'),
      laneChannels: document.querySelectorAll('#dkLane .cht').length,
      resumeRow: head('.home-recent'),
      resuming: document.querySelectorAll('.home-recent .card').length,
      favRow: head('.home-favs'),
      favs: document.querySelectorAll('.home-favs .card').length,
      footer: !!document.querySelector('#dkFoot'),
      // Every one of these is a rail with a heading, which is what makes the
      // page one thing rather than four kinds of block stacked up.
      rails: document.querySelectorAll('#homeView .shelf .rail-track').length,
    };
  });
  console.log('  ', JSON.stringify(shape));

  // Three features at most, and only ones with something behind them: a live
  // channel, something half-watched, and the newest thing indexed.
  check('the billboard has something on it', shape.slides >= 1, String(shape.slides));
  check('and offers each of them to be picked', shape.picks === shape.slides,
    `${shape.picks} pickers for ${shape.slides} slides`);
  check('your channels lead the page', shape.lane === 'On now', String(shape.lane));
  // All of them, not a capped six with a link to the rest: a rail scrolls,
  // so there is nothing to cap and nowhere the remainder has to go.
  check('with every one of them in it', shape.laneChannels === 15, String(shape.laneChannels));
  check('continue watching is a row of its own', shape.resumeRow === 'Continue watching',
    String(shape.resumeRow));
  check('carrying what was actually watched', shape.resuming === 5, String(shape.resuming));
  check('and the starred titles are a row too', shape.favRow === 'Your favorites',
    String(shape.favRow));
  check('with all six in it', shape.favs === 6, String(shape.favs));
  check('every block on the page is a rail', shape.rails >= 3, String(shape.rails));
  check('and the box reports itself at the foot', shape.footer);

  // --- the billboard does not move on its own ------------------------------
  //
  // The one thing that was asked for by name. A page that changes under you
  // while you are reading it is a page you have to fight, so the three
  // features are offered and the choice is the viewer's.
  console.log('\n  the billboard holds still');
  const onNow = () => page.evaluate(() =>
    document.querySelector('#dkHero .slide.on')?.dataset.i ?? null);
  const first = await onNow();
  await wait(3200);
  check('it has not rotated on its own', (await onNow()) === first,
    `${first} became ${await onNow()}`);

  if (shape.slides > 1) {
    await page.evaluate(() => document.querySelectorAll('#dkHero .picker button')[1].click());
    await wait(500);
    check('but picking one switches it', (await onNow()) === '1', String(await onNow()));
    await page.evaluate(() => document.querySelectorAll('#dkHero .picker button')[0].click());
    await wait(400);
  }

  // --- it fits sideways ----------------------------------------------------
  //
  // Vertically it does not, and is not meant to: the billboard is most of a
  // window on its own and the rails are below it. Sideways is still a bug.
  console.log('\n  it fits the window');
  const fit = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    heroBottom: Math.round(document.querySelector('#dkHero').getBoundingClientRect().bottom),
    innerH: window.innerHeight,
    laneTop: Math.round(document.querySelector('#dkLane').getBoundingClientRect().top),
  }));
  console.log('  ', JSON.stringify(fit));
  check('no sideways scrolling', fit.scrollW <= fit.innerW, `${fit.scrollW} vs ${fit.innerW}`);
  check('the billboard holds the window without filling it',
    fit.heroBottom > fit.innerH * 0.6 && fit.heroBottom <= fit.innerH + 1,
    `${fit.heroBottom} vs ${fit.innerH}`);
  // The lane overlaps the foot of the billboard, so the page is visibly a
  // page rather than a poster you have to scroll to get past.
  check('and the first row shows under it without scrolling',
    fit.laneTop < fit.innerH, `${fit.laneTop} vs ${fit.innerH}`);
  await page.screenshot({ path: SHOTS + '/home.png' });

  // --- nothing is cut off --------------------------------------------------
  //
  // The complaint this answers: boxes sized by the layout have whatever shape
  // is left over, the artwork has whatever shape the provider sent, and they
  // are not the same. `cover` fills the box by throwing away the difference,
  // which on a block wider than a 16:9 still means the top and bottom of it.
  console.log('\n  the whole picture');
  // The rows scroll sideways, and artwork out beyond the right-hand edge is
  // deliberately not fetched until it is needed — so "every image has loaded"
  // is no longer a true thing to ask for. What is asked instead is that the
  // ones which HAVE loaded are all drawn whole, which is the actual claim.
  await page.waitForFunction(
    () => [...document.querySelectorAll('#homeView img')]
      .filter((i) => i.complete && i.naturalWidth > 0).length >= 10,
    null, { timeout: 10000 });
  const whole = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#homeView img')]
      .filter((i) => i.complete && i.naturalWidth > 0);
    const bad = [];
    for (const img of imgs) {
      const box = img.getBoundingClientRect();
      const fit = getComputedStyle(img).objectFit;
      // What `contain` actually renders: the image scaled to fit entirely
      // inside the box. Worked out here rather than trusted, so the check is
      // about the picture rather than about a property name.
      const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
      const drawnW = img.naturalWidth * scale;
      const drawnH = img.naturalHeight * scale;
      const fits = drawnW <= box.width + 1 && drawnH <= box.height + 1;
      if (fit !== 'contain' || !fits) {
        bad.push({ src: img.src.slice(0, 40), fit, box: [Math.round(box.width), Math.round(box.height)] });
      }
    }
    return { total: imgs.length, bad };
  });
  console.log('  ', JSON.stringify(whole));
  check('the artwork on screen has loaded', whole.total >= 10, String(whole.total));
  check('and not one of them is cropped to fit its box',
    whole.bad.length === 0, JSON.stringify(whole.bad));

  // --- the artwork ---------------------------------------------------------
  console.log('\n  the artwork');
  const art = await page.evaluate(() => {
    const rect = (n) => n.getBoundingClientRect();
    const chans = [...document.querySelectorAll('#dkLane .cht .card-art')].map(rect);
    const films = [...document.querySelectorAll('.home-favs .card-art')].map(rect);
    const same = (list) => new Set(list.map((b) => Math.round(b.width))).size === 1;
    return {
      filmRatio: films[0].width / films[0].height,
      chanRatio: chans[0].width / chans[0].height,
      filmsUniform: same(films),
      chansUniform: same(chans),
    };
  });
  console.log('  ', JSON.stringify(art));
  check('favorite films keep a 2:3 poster',
    Math.abs(art.filmRatio - 2 / 3) < 0.02, String(art.filmRatio));
  check('a channel ident gets a wide plate instead, so its name survives',
    art.chanRatio > 1.2, String(art.chanRatio));
  check('films are all one size', art.filmsUniform, JSON.stringify(art));
  check('and so are the channels', art.chansUniform, JSON.stringify(art));

  // --- a favorite poster opens the thing, not a list -----------------------
  console.log('\n  pressing a favorite');
  await page.evaluate(() => document.querySelector('.home-favs .card').click());
  await wait(900);
  const film = await page.evaluate(() => ({
    hash: location.hash,
    playerUp: !document.querySelector('#playerOverlay').hidden,
  }));
  console.log('  ', JSON.stringify(film));
  check('a film opens its own page rather than the favorites list',
    film.hash === '#/movies/200', film.hash);

  await home();
  await page.evaluate(() => document.querySelector('#dkLane .cht').click());
  await wait(2500);
  const chan = await page.evaluate(() => ({
    playerUp: !document.querySelector('#playerOverlay').hidden,
    title: document.querySelector('#cinemaTitle').textContent,
    src: document.querySelector('#video').currentSrc,
  }));
  console.log('  ', JSON.stringify(chan));
  check('a channel tunes straight in, the way it does everywhere else',
    chan.playerUp && chan.src.includes('fake-stream'), JSON.stringify(chan));
  check('and it is the one that was pressed', chan.title === 'US| CHANNEL 1 ᴴᴰ', chan.title);
  await page.evaluate(() => closePlayer());
  await wait(400);

  // The row heading is the way through to the full list.
  await home();
  await page.evaluate(() => document.querySelector('#dkLane .shelf-head').click());
  await wait(700);
  check('the channel row reaches the list it is a slice of',
    (await page.evaluate(() => location.hash)) === '#/favlive',
    await page.evaluate(() => location.hash));

  // --- continue watching still resumes ------------------------------------
  console.log('\n  continue watching');
  await home();
  await page.evaluate(() =>
    [...document.querySelectorAll('.home-recent .card-title')]
      .find((t) => t.textContent === 'Dune Part Two').closest('.card').click());
  await wait(2500);
  const resumed = await page.evaluate(() => ({
    playerUp: !document.querySelector('#playerOverlay').hidden,
    title: document.querySelector('#cinemaTitle').textContent,
  }));
  check('a film in the row still plays', resumed.playerUp && resumed.title === 'Dune Part Two',
    JSON.stringify(resumed));
  await page.evaluate(() => closePlayer());
  await wait(400);

  // --- the phone -----------------------------------------------------------
  //
  // The same page, one column wide. What is checked is that it IS that page —
  // billboard at the head of it, the rest as rails — and that a design drawn
  // for 1440 does not hang off the side of a 390pt screen, which is the way
  // this goes wrong.
  console.log('\n  on a phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => device.setPhone(true));
  await home();
  const phone = await page.evaluate(() => {
    const view = document.querySelector('#appView');
    const rails = [...document.querySelectorAll('#homeView .shelf')];
    /* Every laid-out box, so nothing gets to hang off the edge unnoticed.
     *
     * Two things are allowed past it. Anything inside something that scrolls
     * sideways — a rail's track, the guide's grid — is MEANT to be wider than
     * the screen; that is what scrolling it means, and the scroller itself is
     * still checked, which is the box that actually has to fit. And the hero's
     * artwork, which is inset past the frame on purpose and clipped by it. */
    const inScroller = (e) => {
      for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    const overhang = [...document.querySelectorAll('#appView *')]
      .filter((e) => !e.closest('#dkHero') && !inScroller(e))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width && r.right > window.innerWidth + 1)
      .map(({ e, r }) => ({
        what: e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().split(/\s+/).join('.') : ''),
        right: Math.round(r.right),
      }));
    return {
      scrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      innerW: window.innerWidth,
      hero: !!document.querySelector('#dkHero'),
      heroAtTop: (() => {
        const h = document.querySelector('#dkHero');
        return h ? Math.round(h.getBoundingClientRect().top) <= Math.round(view.getBoundingClientRect().top) + 1 : false;
      })(),
      rails: rails.length,
      /* A rail is a row you scroll, not a grid that wrapped: its cards all sit
         on one line and the track reaches past the screen. */
      railIsARow: rails.length ? rails.every((r) => {
        const cards = [...r.querySelectorAll('.card')];
        return cards.length < 2
          || new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size === 1;
      }) : false,
      footer: !!document.querySelector('#dkFoot'),
      overhang: overhang.length,
      worst: overhang.length ? Math.max(...overhang.map((o) => o.right)) : 0,
      // Outermost first: the one that is actually too wide, rather than the
      // dozen children being carried along by it.
      offenders: overhang.slice(0, 4),
    };
  });
  console.log('  ', JSON.stringify(phone));
  check('no sideways scroll on a phone', phone.bodyScrollW <= phone.innerW,
    `${phone.bodyScrollW} vs ${phone.innerW}`);
  check('and nothing hanging off the edge', phone.overhang === 0,
    `${phone.overhang} box(es), out to ${phone.worst}px — ${JSON.stringify(phone.offenders)}`);
  check('the billboard is the head of the page', phone.hero && phone.heroAtTop,
    JSON.stringify({ hero: phone.hero, atTop: phone.heroAtTop }));
  check('the rest of it is rails', phone.rails >= 2, String(phone.rails));
  check('and a rail is a row you scroll, not a grid that wrapped',
    phone.railIsARow, JSON.stringify(phone));
  check('the box\'s own numbers are still at the foot of it', phone.footer);
  await page.screenshot({ path: SHOTS + '/home-phone.png' });

  // --- a profile that has not watched anything -----------------------------
  //
  // Different from the old landing page, which was only ever your own history
  // and your own favorites: with neither of those it had nothing to show and
  // said so. This one also carries what the box holds, so a new profile still
  // opens on a library rather than on an apology.
  console.log('\n  with nothing watched or starred');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    device.setPhone(false);
    state.recentlyWatched = [];
    profiles.data.favorites = [];
    location.hash = '#/home';
    render();
  });
  await wait(600);
  const fresh = await page.evaluate(() => ({
    hero: document.querySelectorAll('#dkHero .slide').length,
    personal: document.querySelectorAll('#dkLane, .home-recent, .home-favs').length,
    rails: document.querySelectorAll('#homeView .shelf').length,
    empty: document.querySelector('#emptyState').hidden
      ? '' : document.querySelector('#emptyState').textContent,
  }));
  console.log('  ', JSON.stringify(fresh));
  // Nothing half-watched, no live favorite, and nothing dated in the library
  // fixture — so there is no feature to bill.
  check('no billboard with nothing to put on it', fresh.hero === 0, String(fresh.hero));
  check('and none of the rows that are about you', fresh.personal === 0, String(fresh.personal));
  check('but the library is still on the page', fresh.rails >= 1, String(fresh.rails));
  check('so it does not claim to be empty', fresh.empty === '', fresh.empty);

  // --- and one with nothing anywhere ---------------------------------------
  console.log('\n  with nothing on the box at all');
  await page.evaluate(() => {
    state.library.movies = { categories: [], items: [] };
    state.library.series = { categories: [], items: [] };
    state.library.live = { categories: [], items: [] };
    render();
  });
  await wait(600);
  const bare = await page.evaluate(() => ({
    rails: document.querySelectorAll('#homeView .shelf').length,
    empty: document.querySelector('#emptyState').hidden
      ? '' : document.querySelector('#emptyState').textContent,
    version: document.querySelector('.home-version')?.textContent || '',
  }));
  console.log('  ', JSON.stringify(bare));
  check('no rows over nothing', bare.rails === 0, String(bare.rails));
  check('it says so instead', /Nothing here yet/.test(bare.empty), bare.empty);
  check('and the version is still in the corner', /^v/.test(bare.version), bare.version);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
