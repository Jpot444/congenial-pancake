/**
 * The phone tab bar stays at the bottom.
 *
 * It was `position: fixed; bottom: 0` over a scrolling document, which is
 * correct everywhere except the one place this runs. WebKit detaches fixed
 * elements during momentum scrolling and rubber-banding, so scrolling past the
 * end of a shelf bounced the whole page and dragged the bar up into the middle
 * of the screen. There is no holding a fixed element still through that bounce:
 * the bounce IS the browser moving the viewport out from under it.
 *
 * So the bar is not fixed any more. The document is pinned to the screen, the
 * view inside it is the only thing that scrolls, and the bar is an ordinary row
 * at the bottom of the frame — nothing for it to drift against.
 *
 * Chromium does not rubber-band the way WebKit does, so this cannot reproduce
 * the bounce itself. What it CAN check is the structural claim underneath,
 * which is the actual fix: the document does not scroll, the view does, and the
 * bar sits on the bottom edge and stays there through everything.
 */
const { chromium, devices } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Enough shelves that the page is several screens tall, which is the state the
// bar drifted in — a short page never scrolls and never showed the fault.
const SERIES = {
  categories: [
    { id: 's1', name: 'NETFLIX SERIES' },
    { id: 's2', name: 'HBO MAX SERIES' },
    { id: 's3', name: 'AMAZON SERIES' },
  ],
  items: Array.from({ length: 300 }, (_, i) => ({
    kind: 'series',
    id: 500 + i,
    name: `Show number ${i + 1} with a reasonably long name`,
    logo: '',
    categoryId: ['s1', 's2', 's3'][i % 3],
    genre: ['Drama', 'Comedy', 'Reality', 'Kids'][i % 4],
    added: 2000 + i,
  })),
};

(async () => {
  const browser = await chromium.launch();
  // A real iPhone profile: the viewport, the pixel ratio and, most importantly,
  // a coarse pointer, which is what puts the app in phone layout at all.
  const page = await browser.newPage({ ...devices['iPhone 13 Pro'] });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  console.log('\n  phone layout');
  const layout = await page.evaluate(() => ({
    phone: device.phone,
    tabbar: !document.querySelector('#tabBar').hidden,
    cls: document.body.classList.contains('has-tabbar'),
  }));
  console.log('   layout:', JSON.stringify(layout));
  check('an iPhone lands in phone layout with the bar up',
    layout.phone && layout.tabbar && layout.cls, JSON.stringify(layout));

  await page.evaluate((lib) => {
    state.library.series = lib;
    location.hash = '#/series';
    state.tab = 'series';
    state.shelf = null;
    state.category = null;
    render();
  }, SERIES);
  await page.waitForSelector('.shelf', { timeout: 10000 });
  await wait(600);

  // --- the document does not scroll ----------------------------------------
  console.log('\n  what scrolls');
  const frame = await page.evaluate(() => {
    const view = document.querySelector('#appView');
    return {
      docScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      viewOverflow: getComputedStyle(view).overflowY,
      viewScrolls: view.scrollHeight > view.clientHeight + 1,
      barPosition: getComputedStyle(document.querySelector('#tabBar')).position,
    };
  });
  console.log('   frame:', JSON.stringify(frame));
  check('the document itself cannot scroll', frame.bodyOverflow === 'hidden'
    && !frame.docScrolls, JSON.stringify(frame));
  check('the view is what scrolls, and it has somewhere to go',
    frame.viewOverflow === 'auto' && frame.viewScrolls, JSON.stringify(frame));
  check('the bar is in normal flow rather than floating over it',
    frame.barPosition === 'static', frame.barPosition);

  // --- it sits on the bottom edge ------------------------------------------
  console.log('\n  where the bar sits');
  const at = async () => page.evaluate(() => {
    const b = document.querySelector('#tabBar').getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom),
      h: window.innerHeight, scrolled: Math.round(document.querySelector('#appView').scrollTop) };
  });
  const start = await at();
  console.log('   at rest:', JSON.stringify(start));
  check('it ends exactly at the bottom of the screen',
    Math.abs(start.bottom - start.h) <= 1, JSON.stringify(start));

  // --- and stays there -----------------------------------------------------
  //
  // Including past the end, which is the case that broke it: the bar came up
  // off the bottom with the bounce.
  console.log('\n  through scrolling');
  const seen = [];
  for (const to of [500, 2000, 8000, 99999]) {
    await page.evaluate((y) => { document.querySelector('#appView').scrollTop = y; }, to);
    await wait(250);
    seen.push(await at());
  }
  // One more that a finger would do: fling past the end and let it settle.
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, 4000);
  await wait(600);
  seen.push(await at());
  for (const s of seen) console.log('   ', JSON.stringify(s));

  check('it never leaves the bottom edge, however far down you go',
    seen.every((s) => Math.abs(s.bottom - s.h) <= 1), JSON.stringify(seen));
  check('and never creeps up the screen',
    new Set(seen.map((s) => s.top)).size === 1, JSON.stringify(seen.map((s) => s.top)));
  check('the view really did scroll while it stayed put',
    seen.some((s) => s.scrolled > 1000), JSON.stringify(seen.map((s) => s.scrolled)));

  // --- the frame is exactly the screen -------------------------------------
  //
  // This is the one that matters, and the one the first version of the frame
  // got wrong. It was `height: 100dvh`, which on an iPhone home-screen app
  // resolved TALLER than what you can see — so the frame overhung the bottom
  // of the glass and took its last row, the bar, with it. The bar was not
  // drifting any more; it was simply off the screen.
  //
  // `position: fixed; inset: 0` is the layout viewport by definition. There is
  // no unit to resolve and so nothing to be wrong about.
  console.log('\n  the frame against the screen');
  const frameBox = await page.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom),
      h: Math.round(b.height), winH: window.innerHeight,
      position: getComputedStyle(document.body).position };
  });
  console.log('   frame box:', JSON.stringify(frameBox));
  check('the frame is pinned rather than sized in viewport units',
    frameBox.position === 'fixed', frameBox.position);
  check('it starts at the top of the screen', frameBox.top === 0, String(frameBox.top));
  check('and ends exactly at the bottom — never overhanging it',
    frameBox.bottom === frameBox.winH, JSON.stringify(frameBox));

  // --- the frame follows the VISIBLE viewport ------------------------------
  //
  // This is the one that was missed twice. `100dvh` and `inset: 0` both size to
  // the LAYOUT viewport, and on an iPhone home-screen icon created before this
  // app declared itself standalone, that box runs on behind Safari's bottom
  // toolbar — so a bar correctly placed at its bottom edge is underneath the
  // toolbar and invisible. Two different-looking fixes, the same mistake.
  //
  // Chromium has no such chrome, so the shrinking cannot be reproduced. What
  // CAN be checked is the mechanism that fixes it: the frame is sized from a
  // measured height, not a viewport unit, and it follows that measurement down.
  console.log('\n  the frame follows what is visible');
  const sized = await page.evaluate(() => ({
    prop: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
    vv: Math.round(window.visualViewport?.height || window.innerHeight),
    frame: Math.round(document.body.getBoundingClientRect().height),
  }));
  console.log('   measured:', JSON.stringify(sized));
  check('the frame height is measured rather than left to a viewport unit',
    sized.prop.endsWith('px'), sized.prop || '(unset)');
  check('and the measurement is the visible viewport',
    Math.abs(parseInt(sized.prop, 10) - sized.vv) <= 1, JSON.stringify(sized));

  // Shrink it by hand, the way browser chrome appearing would. The bar has to
  // come up with it rather than staying at the bottom of a taller box.
  const shrunk = await page.evaluate(() => {
    document.documentElement.style.setProperty('--app-h', '500px');
    const bar = document.querySelector('#tabBar').getBoundingClientRect();
    return { frame: Math.round(document.body.getBoundingClientRect().height),
      barBottom: Math.round(bar.bottom), winH: window.innerHeight };
  });
  console.log('   with 500px visible:', JSON.stringify(shrunk));
  check('a shorter visible area shortens the frame', shrunk.frame === 500,
    JSON.stringify(shrunk));
  check('and the bar comes up with it rather than hiding below the fold',
    shrunk.barBottom === 500, JSON.stringify(shrunk));
  await page.evaluate(() => { appHeight.apply(); });
  await wait(200);

  // And the app says it is an app, so the chrome that caused this is not there
  // at all on an icon added from now on.
  const metas = await page.evaluate(() => ({
    apple: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
    generic: document.querySelector('meta[name="mobile-web-app-capable"]')?.content,
  }));
  check('and the page declares itself standalone, so a new home-screen icon '
    + 'has no browser chrome to hide behind',
    metas.apple === 'yes' && metas.generic === 'yes', JSON.stringify(metas));

  // --- every page you can browse -------------------------------------------
  //
  // Home is its own renderer and its own layout, which is where the bar went
  // missing. The rest are the grid, so they share a path — but "every page
  // before you pick something" is the claim, so every page is checked.
  console.log('\n  every browsing page');
  const tabs = ['home', 'live', 'movies', 'series', 'favorites', 'downloads'];
  const perTab = [];
  for (const tab of tabs) {
    await page.evaluate((t) => {
      location.hash = `#/${t}`;
      state.tab = t;
      state.shelf = null;
      state.category = null;
      render();
    }, tab);
    await wait(500);
    // Scroll to the end of whatever this page is, which is when it went wrong.
    await page.evaluate(() => {
      const v = document.querySelector('#appView');
      if (v) v.scrollTop = v.scrollHeight;
    });
    await wait(250);
    perTab.push(await page.evaluate((t) => {
      const b = document.querySelector('#tabBar').getBoundingClientRect();
      return { tab: t, hidden: document.querySelector('#tabBar').hidden,
        top: Math.round(b.top), bottom: Math.round(b.bottom), winH: window.innerHeight };
    }, tab));
  }
  for (const t of perTab) console.log('   ', JSON.stringify(t));
  check('the bar is on every page you can browse',
    perTab.every((t) => !t.hidden), JSON.stringify(perTab.filter((t) => t.hidden)));
  check('at the bottom of every one of them, scrolled to the end',
    perTab.every((t) => t.bottom === t.winH), JSON.stringify(perTab));
  check('and at the same height on all of them, so it does not jump between tabs',
    new Set(perTab.map((t) => t.top)).size === 1, JSON.stringify(perTab.map((t) => t.top)));

  await page.evaluate(() => {
    location.hash = '#/series';
    state.tab = 'series';
    render();
  });
  await wait(500);

  // --- nothing is hidden behind it -----------------------------------------
  //
  // The bar used to sit ON the page, so the page carried padding to end above
  // it. In the frame it sits BESIDE the page, and that padding would now be a
  // gap — so the check is that the last row is reachable, not that a magic
  // number is still there.
  console.log('\n  the end of the page');
  const tail = await page.evaluate(() => {
    const view = document.querySelector('#appView');
    view.scrollTop = view.scrollHeight;
    const cards = [...view.querySelectorAll('.rail-card, .card')];
    const last = cards[cards.length - 1];
    const bar = document.querySelector('#tabBar').getBoundingClientRect();
    const box = last.getBoundingClientRect();
    return { bottom: Math.round(box.bottom), barTop: Math.round(bar.top),
      gap: Math.round(bar.top - box.bottom) };
  });
  console.log('   tail:', JSON.stringify(tail));
  check('the last poster on the page is above the bar, not under it',
    tail.bottom <= tail.barTop + 1, JSON.stringify(tail));
  check('and not stranded miles above it by padding that is no longer needed',
    tail.gap < 200, JSON.stringify(tail));

  await page.screenshot({ path: __dirname + '/shots/tabbar-phone.png' });

  // --- a desktop is untouched ----------------------------------------------
  console.log('\n  a desktop');
  const desk = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await desk.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await desk.goto(BASE, { waitUntil: 'networkidle' });
  if (await desk.locator('#profileGate').isVisible()) {
    await desk.locator('.profile-tile').first().click();
    await desk.waitForTimeout(1500);
  }
  await desk.evaluate((lib) => {
    device.setPhone(false);
    state.library.series = lib;
    location.hash = '#/series';
    state.tab = 'series';
    render();
  }, SERIES);
  await desk.waitForSelector('.shelf', { timeout: 10000 });
  await wait(400);
  const deskFrame = await desk.evaluate(() => ({
    bar: !document.querySelector('#tabBar').hidden,
    bodyOverflow: getComputedStyle(document.body).overflowY,
    docScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
  }));
  console.log('   desktop:', JSON.stringify(deskFrame));
  check('no tab bar on a desktop', deskFrame.bar === false);
  check('and the document still scrolls the way it always has',
    deskFrame.bodyOverflow !== 'hidden' && deskFrame.docScrolls,
    JSON.stringify(deskFrame));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
