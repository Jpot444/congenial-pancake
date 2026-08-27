/**
 * The home screen.
 *
 * Two claims under test, and both are geometric rather than about markup.
 * First, that the whole page fits the window on a desktop — that is the point
 * of shrinking the posters, and a layout that "looks smaller" while still
 * scrolling has not done it. Second, that a favorite poster opens the thing on
 * it rather than a page listing it, which is one click instead of two.
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
    await page.waitForSelector('.home-hero', { timeout: 10000 });
    await wait(400);
  };
  await home();

  // --- the shape of the page ----------------------------------------------
  console.log('\n  what is on the page');
  const shape = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.home-fav-col')];
    return {
      hero: document.querySelectorAll('.home-hero').length,
      quad: document.querySelectorAll('.home-quad-card').length,
      boxes: document.querySelectorAll('.home-box').length,
      cols: cols.map((c) => ({
        label: c.querySelector('.home-label').textContent,
        tiles: c.querySelectorAll('.home-tile').length,
        more: c.querySelector('.home-more')?.textContent || null,
      })),
      // Side by side means one row: both columns start at the same height.
      sameRow: cols.length === 2
        && Math.abs(cols[0].getBoundingClientRect().top
          - cols[1].getBoundingClientRect().top) < 2,
      sideBySide: cols.length === 2
        && cols[0].getBoundingClientRect().right <= cols[1].getBoundingClientRect().left + 1,
    };
  });
  console.log('  ', JSON.stringify(shape));
  check('the big poster of the last thing watched is back', shape.hero === 1,
    String(shape.hero));
  check('with the four smaller ones alongside it', shape.quad === 4, String(shape.quad));
  check('the favorite boxes are still gone', shape.boxes === 0, `${shape.boxes} boxes`);
  check('channels and films are two columns', shape.cols.length === 2,
    JSON.stringify(shape.cols.map((c) => c.label)));
  check('side by side, not stacked', shape.sameRow && shape.sideBySide,
    JSON.stringify(shape));
  check('each showing its favorites as posters',
    shape.cols[0].tiles === 6 && shape.cols[1].tiles === 6,
    JSON.stringify(shape.cols));

  // The link through to the full list only when there is more to see.
  check('a capped column offers the rest', /15/.test(shape.cols[0].more || ''),
    String(shape.cols[0].more));
  check('a column showing everything does not', shape.cols[1].more === null,
    String(shape.cols[1].more));

  // --- it fits ------------------------------------------------------------
  console.log('\n  it fits the window');
  const fit = await page.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    heroBottom: Math.round(document.querySelector('.home-hero').getBoundingClientRect().bottom),
    lastTile: Math.round(Math.max(...[...document.querySelectorAll('.home-tile')]
      .map((t) => t.getBoundingClientRect().bottom))),
  }));
  console.log('  ', JSON.stringify(fit));
  check('no vertical scrolling on a laptop', fit.scrollH <= fit.innerH,
    `${fit.scrollH} vs ${fit.innerH}`);
  check('and none sideways', fit.scrollW <= fit.innerW, `${fit.scrollW} vs ${fit.innerW}`);
  check('the last favorite is above the fold rather than merely un-scrolled-to',
    fit.lastTile <= fit.innerH, `${fit.lastTile} vs ${fit.innerH}`);
  await page.screenshot({ path: SHOTS + '/home.png' });

  // --- nothing is cut off --------------------------------------------------
  //
  // The complaint this answers: boxes sized by the layout have whatever shape
  // is left over, the artwork has whatever shape the provider sent, and they
  // are not the same. `cover` fills the box by throwing away the difference,
  // which on a block wider than a 16:9 still means the top and bottom of it.
  console.log('\n  the whole picture');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#homeView img')].every((i) => i.complete),
    null, { timeout: 10000 });
  const whole = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#homeView img')];
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
  check('every image on the page is loaded', whole.total >= 10, String(whole.total));
  check('and not one of them is cropped to fit its box',
    whole.bad.length === 0, JSON.stringify(whole.bad));

  // --- the artwork ---------------------------------------------------------
  console.log('\n  the artwork');
  const art = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.home-fav-col')];
    const rect = (n) => n.getBoundingClientRect();
    const hero = rect(document.querySelector('.home-hero'));
    const quad = [...document.querySelectorAll('.home-quad-card')].map(rect);
    const chans = [...cols[0].querySelectorAll('.card-art')].map(rect);
    const films = [...cols[1].querySelectorAll('.card-art')].map(rect);
    const same = (list) => new Set(list.map((b) => Math.round(b.width))).size === 1;
    return {
      heroBigger: hero.width > quad[0].width * 1.5,
      quadUniform: same(quad),
      filmRatio: films[0].width / films[0].height,
      chanRatio: chans[0].width / chans[0].height,
      favUniform: same(films) && same(chans),
      favSmaller: films[0].width < quad[0].width,
    };
  });
  console.log('  ', JSON.stringify(art));
  check('the hero really is the large one', art.heroBigger, JSON.stringify(art));
  check('and the four beside it match each other', art.quadUniform, JSON.stringify(art));
  check('favorite films keep a 2:3 poster',
    Math.abs(art.filmRatio - 2 / 3) < 0.02, String(art.filmRatio));
  check('a channel ident gets a wide plate instead, so its name survives',
    art.chanRatio > 1.2, String(art.chanRatio));
  check('favorites are all one size', art.favUniform, JSON.stringify(art));
  check('and smaller than the row above them', art.favSmaller, JSON.stringify(art));

  // --- a favorite poster opens the thing, not a list -----------------------
  console.log('\n  pressing a favorite');
  await page.evaluate(() =>
    document.querySelectorAll('.home-fav-col')[1].querySelector('.home-tile').click());
  await wait(900);
  const film = await page.evaluate(() => ({
    hash: location.hash,
    playerUp: !document.querySelector('#playerOverlay').hidden,
  }));
  console.log('  ', JSON.stringify(film));
  check('a film opens its own page rather than the favorites list',
    film.hash === '#/movies/200', film.hash);

  await home();
  await page.evaluate(() =>
    document.querySelectorAll('.home-fav-col')[0].querySelector('.home-tile').click());
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

  // The link through still goes to the list.
  await home();
  await page.evaluate(() =>
    document.querySelectorAll('.home-fav-col')[0].querySelector('.home-more').click());
  await wait(700);
  check('the "all of them" link still reaches the list',
    (await page.evaluate(() => location.hash)) === '#/favlive',
    await page.evaluate(() => location.hash));

  // --- continue watching still resumes ------------------------------------
  console.log('\n  continue watching');
  await home();
  await page.evaluate(() => document.querySelectorAll('.home-quad-card')[0].click());
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
  console.log('\n  on a phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => device.setPhone(true));
  await home();
  const phone = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.home-tile')].map((t) => t.getBoundingClientRect());
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      widest: Math.max(...tiles.map((t) => t.right)),
      cols: document.querySelectorAll('.home-fav-col').length,
      stacked: (() => {
        const c = [...document.querySelectorAll('.home-fav-col')];
        return c.length === 2
          && c[1].getBoundingClientRect().top > c[0].getBoundingClientRect().top;
      })(),
      quadInARow: new Set([...document.querySelectorAll('.home-quad-card')]
        .map((t) => Math.round(t.getBoundingClientRect().top))).size,
    };
  });
  console.log('  ', JSON.stringify(phone));
  check('no sideways scroll on a phone', phone.scrollW <= phone.innerW,
    `${phone.scrollW} vs ${phone.innerW}`);
  check('and nothing hanging off the edge', phone.widest <= phone.innerW + 1,
    String(phone.widest));
  check('both favorite sets are still there', phone.cols === 2, String(phone.cols));
  check('stacked on a phone, where side by side is unreadable',
    phone.stacked, JSON.stringify(phone));
  check('and the four under the hero are one row, not a 2x2',
    phone.quadInARow === 1, String(phone.quadInARow));
  await page.screenshot({ path: SHOTS + '/home-phone.png' });

  // --- an empty profile ----------------------------------------------------
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
  const bare = await page.evaluate(() => ({
    hero: document.querySelectorAll('.home-hero').length,
    prompts: [...document.querySelectorAll('.home-empty')].map((p) => p.textContent),
    empty: document.querySelector('#emptyState').hidden
      ? '' : document.querySelector('#emptyState').textContent,
    version: document.querySelector('.home-version')?.textContent || '',
  }));
  console.log('  ', JSON.stringify(bare));
  check('no hero with nothing to put in it', bare.hero === 0, String(bare.hero));
  check('the favorite columns say how to fill them',
    bare.prompts.length === 2 && bare.prompts.every((p) => /tap the heart/.test(p)),
    JSON.stringify(bare.prompts));
  check('it says so instead', /Nothing here yet/.test(bare.empty), bare.empty);
  check('and the version is still in the corner', /^v/.test(bare.version), bare.version);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
