/**
 * Multi-view does not waste the screen.
 *
 * "There is wasted space on the top and bottom half during Multiview"
 *
 * Reported from an iPad in landscape with two games up: two cells side by
 * side, each one the full height of the window, each holding a 16:9 picture
 * with about three hundred pixels of black above it and the same below. The
 * grid was the room, so a cell was whatever shape the room was, and everything
 * in the cell that was not picture-shaped was black.
 *
 * What is checked here is the shape of the cells rather than the pixels of any
 * particular stream, because the shape is the whole of it: a cell that is 16:9
 * cannot letterbox a 16:9 picture, whatever is playing in it. So each visible
 * cell is measured against 16:9, and the band that would be left inside it is
 * worked out in pixels and required to be small.
 *
 * And two, specifically, is checked in both orientations — because side by
 * side and stacked are not a matter of taste. At any given window one of them
 * puts more picture on the screen than the other, and the crossover is exactly
 * 16:9: wider than that, side by side; narrower — a tablet in landscape is
 * about 1.6 — stacked. The old layout only ever did side by side, which is why
 * the report came from an iPad and not from a desktop.
 */
const { chromium } = require('./playwright.js');
const { openMultiview } = require('./mv.js');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8481';
const SHOTS = __dirname + '/shots';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNELS = [
  { kind: 'live', id: 1, name: 'US| NBC East', logo: '', categoryId: 'c1' },
  { kind: 'live', id: 2, name: 'US| CBS West', logo: '', categoryId: 'c1' },
  { kind: 'live', id: 3, name: 'US| FOX Sports', logo: '', categoryId: 'c1' },
  { kind: 'live', id: 4, name: 'US| ESPN', logo: '', categoryId: 'c1' },
];
const CATEGORIES = [{ id: 'c1', name: 'Sports' }];

/* What the layout comes out as, measured. Everything here is read off the
   rendered boxes: how the cells are arranged, how far each one is from being
   picture-shaped, and how much picture the arrangement actually delivers. */
const MEASURE = () => {
  const shown = [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden);
  const boxes = shown.map((c) => c.getBoundingClientRect());
  /* The room the grid is given — the window less the bar at the top, the
     padding and anything the panel is holding. Every claim about "as big as
     it can be" is against this, not against the window, because the window
     includes furniture the grid was never going to get. */
  const stageBox = document.querySelector('.mv-stage');
  const style = stageBox && getComputedStyle(stageBox);
  const stageRect = stageBox ? stageBox.getBoundingClientRect() : { width: 0, height: 0 };
  const pad = (side) => (style ? parseFloat(style[`padding${side}`]) || 0 : 0);
  const stage = {
    w: stageRect.width - pad('Left') - pad('Right'),
    h: stageRect.height - pad('Top') - pad('Bottom'),
  };
  const cells = boxes.map((b) => {
    /* A 16:9 picture in this box, fitted the way `object-fit: contain` fits
       it — so the black band above and below it is arithmetic, not a guess. */
    const picW = Math.min(b.width, b.height * (16 / 9));
    const picH = Math.min(b.height, b.width * (9 / 16));
    return {
      w: Math.round(b.width),
      h: Math.round(b.height),
      ratio: b.height ? Number((b.width / b.height).toFixed(3)) : 0,
      band: Math.round((b.height - picH) / 2),
      bars: Math.round((b.width - picW) / 2),
      area: picW * picH,
    };
  });
  return {
    count: shown.length,
    rows: new Set(boxes.map((b) => Math.round(b.top))).size,
    cols: new Set(boxes.map((b) => Math.round(b.left))).size,
    cells,
    stage,
    /* How much of the stage ends up being picture. The single number the
       report was really about. */
    picture: cells.reduce((sum, c) => sum + c.area, 0),
    onScreen: boxes.every((b) => b.right <= window.innerWidth + 1
      && b.bottom <= window.innerHeight + 1 && b.width > 80 && b.height > 80),
  };
};

/* 4% of 16:9 is about four degrees of squashing — under that, a cell is
   picture-shaped for every purpose a viewer has. */
const shapely = (m, tol = 0.04) =>
  m.cells.every((c) => Math.abs(c.ratio - 16 / 9) / (16 / 9) <= tol);
const worstBand = (m) => Math.max(0, ...m.cells.map((c) => Math.max(c.band, c.bars)));

/**
 * The largest box of a given shape that fits the stage, and its area.
 *
 * This is the ceiling any arrangement can reach: a grid of 16:9 cells with no
 * band inside any of them IS a box of a known shape, and the most picture it
 * can put up is that box, as large as the room allows. Comparing what was
 * rendered against this is what turns "looks better" into a number.
 */
const fits = ({ w, h }, ratio) => {
  const box = w / h >= ratio ? { w: h * ratio, h } : { w, h: w / ratio };
  return { ...box, area: box.w * box.h };
};

/* The shapes each arrangement makes, out of 16:9 cells. */
const AR = { solo: 16 / 9, beside: 32 / 9, stacked: 8 / 9, three: 8 / 3, four: 16 / 9 };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  /* An iPad in landscape, which is where this was reported from: narrower
     than 16:9, which is the whole reason it looked the way it did. */
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/play*', (r) => {
    if (new URL(r.request().url()).pathname !== '/api/play') return r.continue();
    return r.fulfill({ status: 503, contentType: 'application/json',
      body: '{"error":"All connections for this account are in use."}' });
  });
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(600);
  await page.evaluate((seed) => {
    state.library.live = { categories: seed.cats, items: seed.items };
    render();
  }, { items: CHANNELS, cats: CATEGORIES });

  await openMultiview(page);
  await wait(500);
  check('the grid opens', await page.locator('#multiview').isVisible());

  const layoutFor = async (count) => {
    await page.evaluate((n) => multiview.setCount(n), count);
    await wait(300);
    return page.evaluate(MEASURE);
  };

  /* ---- 1. two, on a screen narrower than 16:9 --------------------------- */
  console.log('\n  two games on an iPad in landscape (1180x820, 1.44 wide)');
  let m = await layoutFor(2);
  console.log('   ', JSON.stringify(m.cells), `picture ${Math.round(m.picture / 1000)}k`);
  check('two cells', m.count === 2, String(m.count));
  /* Measured before anything is claimed against it: every "as big as the room
     allows" check below divides by this, and a room of nothing would let them
     all pass without meaning anything. */
  check('and the grid has a measurable room to sit in',
    m.stage.w > 400 && m.stage.h > 300, JSON.stringify(m.stage));
  check('one above the other, which is what fits this screen',
    m.rows === 2 && m.cols === 1, `rows ${m.rows} cols ${m.cols}`);
  check('each cell is the shape of the picture in it', shapely(m), JSON.stringify(m.cells));
  check('so there is no band inside a cell to speak of',
    worstBand(m) <= 8, `worst ${worstBand(m)}px`);
  /*
   * The number the report is about, stated as a comparison rather than as a
   * percentage — two 16:9 pictures cannot fill a 1.44 screen whatever you do,
   * so the question is only ever which arrangement wastes less.
   */
  const beside = fits(m.stage, AR.beside).area;
  const stackedFit = fits(m.stage, AR.stacked).area;
  console.log(`    stage ${Math.round(m.stage.w)}x${Math.round(m.stage.h)}:`
    + ` stacked would give ${Math.round(stackedFit / 1000)}k,`
    + ` side by side ${Math.round(beside / 1000)}k`);
  check('stacking is the arrangement that gives more picture here',
    stackedFit > beside, `${Math.round(stackedFit / 1000)}k vs ${Math.round(beside / 1000)}k`);
  check('and the grid takes all of it', m.picture >= stackedFit * 0.96,
    `${Math.round(m.picture / 1000)}k of ${Math.round(stackedFit / 1000)}k`);
  check('which is a good deal more picture than side by side would give',
    m.picture > beside * 1.1,
    `${Math.round(m.picture / 1000)}k vs ${Math.round(beside / 1000)}k`);
  const stacked = m.picture;
  await page.screenshot({ path: `${SHOTS}/mvspace-ipad-2.png` });

  /* ---- 2. three and four, same screen ----------------------------------- */
  console.log('\n  and the other counts on the same screen');
  for (const [count, ratio] of [[3, AR.three], [4, AR.four]]) {
    // eslint-disable-next-line no-await-in-loop
    m = await layoutFor(count);
    const best = fits(m.stage, ratio).area;
    console.log(`    ${count}:`, JSON.stringify(m.cells),
      `picture ${Math.round(m.picture / 1000)}k of ${Math.round(best / 1000)}k`);
    check(`${count} cells are picture-shaped too`, shapely(m), JSON.stringify(m.cells));
    check(`  and none of them letterboxes`, worstBand(m) <= 8, `worst ${worstBand(m)}px`);
    check(`  and the grid is as big as the room allows`, m.picture >= best * 0.96,
      `${Math.round(m.picture / 1000)}k of ${Math.round(best / 1000)}k`);
    check(`  and they all fit the screen`, m.onScreen, JSON.stringify(m));
  }

  /* ---- 3. one blown up -------------------------------------------------- */
  /* Set rather than pressed: expand() refuses a cell with nothing in it, and
     no stream is playing here. The shape of the solo layout is the question. */
  console.log('\n  one of them expanded');
  await page.evaluate(() => { multiview.solo = 0; multiview.paint(); });
  await wait(400);
  m = await page.evaluate(MEASURE);
  console.log('   ', JSON.stringify(m.cells));
  check('the solo cell is picture-shaped', m.count === 1 && shapely(m), JSON.stringify(m));
  check('and takes the whole of the room it is given',
    m.picture >= fits(m.stage, AR.solo).area * 0.96,
    `${Math.round(m.picture / 1000)}k of ${Math.round(fits(m.stage, AR.solo).area / 1000)}k`);
  await page.evaluate(() => { multiview.solo = -1; multiview.paint(); });
  await wait(300);

  /* ---- 4. a wide screen still puts two side by side --------------------- */
  /*
   * The crossover, from the other side. On a window wider than 16:9 side by
   * side is the arrangement that delivers more picture, and it is still what
   * happens — this is not "stack everything", it is "stack when stacking wins".
   */
  console.log('\n  the same two on a wide desktop (1720x760, 2.26 wide)');
  await page.setViewportSize({ width: 1720, height: 760 });
  await wait(400);
  m = await layoutFor(2);
  console.log('   ', JSON.stringify(m.cells), `picture ${Math.round(m.picture / 1000)}k`);
  check('side by side, because that is what fits a wide screen',
    m.rows === 1 && m.cols === 2, `rows ${m.rows} cols ${m.cols}`);
  check('and the cells are picture-shaped here too', shapely(m), JSON.stringify(m.cells));
  check('with no band inside them', worstBand(m) <= 8, `worst ${worstBand(m)}px`);
  check('side by side is the arrangement that wins on this shape of screen',
    fits(m.stage, AR.beside).area > fits(m.stage, AR.stacked).area,
    JSON.stringify(m.stage));
  check('and the grid takes all the room there is',
    m.picture >= fits(m.stage, AR.beside).area * 0.96,
    `${Math.round(m.picture / 1000)}k of ${Math.round(fits(m.stage, AR.beside).area / 1000)}k`);
  await page.screenshot({ path: `${SHOTS}/mvspace-desk-2.png` });

  /* ---- 5. the panel still gets its room --------------------------------- */
  /*
   * The grid gives up width to the other-games panel rather than being covered
   * by it, on a screen wide enough to afford that. Moving the room the grid
   * sits in must not have lost that.
   */
  console.log('\n  with the other-games panel out');
  const before = await page.evaluate(() =>
    document.querySelector('#mvGrid').getBoundingClientRect().right);
  await page.evaluate(() => multiview.suggest());
  await wait(500);
  const after = await page.evaluate(() => ({
    right: document.querySelector('#mvGrid').getBoundingClientRect().right,
    panel: document.querySelector('#mvSuggest')?.getBoundingClientRect().left ?? 0,
  }));
  console.log(`    grid right ${Math.round(before)} -> ${Math.round(after.right)},`
    + ` panel at ${Math.round(after.panel)}`);
  check('the grid moves clear of the panel rather than hiding under it',
    after.right <= after.panel + 1, JSON.stringify(after));

  console.log(`\n  picture on the iPad, stacked: ${Math.round(stacked / 1000)}k px²`);
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
