/**
 * A fourth "this device": a television.
 *
 * "I want to add the Nvidia shield version as an additional 'this device'. In
 *  this case it will be used for when I have my laptop connected HDMI into a
 *  TV. So it won't use a remote. The main concern of this should be to have
 *  easy to use Multiview that takes up the full screen of a TV when I full
 *  screen my browser on the computer."
 *
 * A laptop on an HDMI cable reports a perfectly ordinary desktop — often a
 * LARGER one than the laptop's own screen — so the portal lays itself out for
 * a mouse a foot from your face while the person reading it is across a room.
 * Nothing in a browser announces that its output is going to a television, so
 * this is chosen by hand, exactly as the Tesla layer is.
 *
 * Four things are checked, in the order they matter:
 *
 *   MULTI-VIEW TAKES THE SCREEN. The bar at the top of multi-view costs about
 *   96px of height in a row of its own — and on a 16:9 panel height is the
 *   scarce dimension, so those 96px cost another 170 off the WIDTH of a grid
 *   that has to stay picture-shaped. Floated over the picture it costs
 *   nothing. The number to beat is what a desk gets.
 *
 *   AND THE CELLS ARE STILL PICTURE-SHAPED. The answer to "what happens to the
 *   leftover space" was: leave the bands. Nothing here may crop or stretch a
 *   game to fill a panel — the sides of the picture are where a scoreboard
 *   lives.
 *
 *   IT WORKS FROM A SOFA. Arrows move between cells and Enter acts on the one
 *   they land on, because aiming a trackpad at a quarter of a television from
 *   six feet away is the awkward part of an otherwise good screen. The pointer
 *   is not replaced by any of it: hovering moves the same ring, and every
 *   button still does what it did.
 *
 *   AND IT FITS BOTH TELEVISIONS. A 4K panel hands the page 3840 CSS pixels
 *   and a 1080p one hands it 1920, at the same physical size and the same
 *   viewing distance — so a layer pinned to one set of pixel numbers is half
 *   the right size on the other.
 */
const { chromium } = require('./playwright.js');
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
  { kind: 'live', id: 1, name: 'US| NBC EAST', logo: '', categoryId: 'c1' },
  { kind: 'live', id: 2, name: 'US| CBS WEST', logo: '', categoryId: 'c1' },
  { kind: 'live', id: 3, name: 'US| FOX SPORTS 1', logo: '', categoryId: 'c1' },
  { kind: 'live', id: 4, name: 'US| ESPN', logo: '', categoryId: 'c1' },
];
const CATS = [{ id: 'c1', name: 'Sports' }];

/* What the grid actually came out as. Everything claimed below is read off the
   rendered boxes rather than off the CSS that produced them. */
const MEASURE = () => {
  const shown = [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden);
  const boxes = shown.map((c) => c.getBoundingClientRect());
  const picture = boxes.reduce((sum, b) => {
    /* A 16:9 picture fitted into the cell the way object-fit: contain fits it,
       so a cell that is the wrong shape counts only the picture it could hold. */
    const w = Math.min(b.width, b.height * (16 / 9));
    const h = Math.min(b.height, b.width * (9 / 16));
    return sum + w * h;
  }, 0);
  return {
    cells: shown.length,
    ratios: boxes.map((b) => Number((b.width / b.height).toFixed(3))),
    /* The worst band a 16:9 picture would leave inside any one cell. */
    band: Math.max(0, ...boxes.map((b) =>
      Math.round((b.height - Math.min(b.height, b.width * (9 / 16))) / 2))),
    picture: Math.round(picture / 1000),
    screen: Math.round((window.innerWidth * window.innerHeight) / 1000),
    focused: multiview.focused,
    onScreen: boxes.every((b) => b.right <= window.innerWidth + 1
      && b.bottom <= window.innerHeight + 1),
  };
};

const shapely = (m) => m.ratios.every((r) => Math.abs(r - 16 / 9) / (16 / 9) <= 0.04);

async function boot(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/library*', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: tab === 'live' ? JSON.stringify({ categories: CATS, items: CHANNELS })
        : '{"categories":[],"items":[]}' });
  });
  for (const [glob, body] of [
    ['**/api/scores*', '{"games":[],"feeds":[]}'],
    ['**/api/xtream*', '{}'],
    ['**/api/market/lines*', '{"day":"x","lines":[]}'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await page.route(glob, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body }));
  }
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(600);
  await page.evaluate(({ items, cats }) => {
    state.library.live = { categories: cats, items };
    render();
  }, { items: CHANNELS, cats: CATS });
  return page;
}

/** Open multi-view without depending on where the button is drawn today. */
const openGrid = async (page, count) => {
  await page.evaluate(() => multiview.open());
  await wait(600);
  await page.evaluate((n) => multiview.setCount(n), count);
  await wait(400);
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();

  /* ---- 1. the layout is a choice, and it sticks ------------------------- */
  /*
   * Nothing in a browser says "my output is on a television", so this can only
   * be chosen — and it has to survive the page being reloaded, which is what
   * happens every time the laptop is plugged back in.
   */
  console.log('\n  choosing it');
  let page = await boot(browser, 1920, 1080);
  const before = await page.evaluate(() => ({
    layout: device.layout, tv: document.documentElement.classList.contains('tv'),
  }));
  check('a laptop is not guessed to be a television', before.layout === 'desk',
    JSON.stringify(before));
  /* Reached the way a person reaches it: the device button in the header opens
     "This device", and the layout is a button in there beside Phone, Desktop
     and Tesla. */
  await page.locator('#touchToggle').click();
  await wait(300);
  check('"This device" offers a TV beside the other three',
    await page.locator('#layoutSeg button[data-layout="tv"]').isVisible(),
    'no TV button in the picker');

  await page.locator('#layoutSeg button[data-layout="tv"]').click();
  await wait(400);
  await page.locator('#deviceClose').click();
  await wait(300);
  let now = await page.evaluate(() => ({
    layout: device.layout,
    tv: document.documentElement.classList.contains('tv'),
    desk: document.documentElement.classList.contains('desk'),
    touch: document.documentElement.classList.contains('touch'),
    stored: localStorage.getItem('portal.layout'),
  }));
  console.log('   ', JSON.stringify(now));
  check('choosing it puts the page in TV layout', now.tv === true, JSON.stringify(now));
  check('on top of the desktop one rather than instead of it', now.desk === true,
    JSON.stringify(now));
  /* The difference from the car layer, and the reason it is a fourth layout
     rather than a wider car: there is a trackpad here. */
  check('and it is not treated as a finger — there is a pointer', now.touch === false,
    JSON.stringify(now));

  await page.reload({ waitUntil: 'networkidle' });
  await wait(1600);
  now = await page.evaluate(() => ({
    layout: device.layout, tv: document.documentElement.classList.contains('tv'),
  }));
  check('and it is still a television after a reload', now.tv === true, JSON.stringify(now));

  /* ---- 2. multi-view takes the screen ----------------------------------- */
  /*
   * The reported ask. Measured against what a DESK gets on the same panel,
   * because "fills the screen" is a comparison and the alternative is
   * cropping games, which was ruled out.
   */
  console.log('\n  multi-view on a 1080p panel');
  await openGrid(page, 4);
  const tv = await page.evaluate(MEASURE);
  console.log('    tv  ', JSON.stringify(tv));
  check('four cells', tv.cells === 4, String(tv.cells));
  check('every one of them picture-shaped', shapely(tv), JSON.stringify(tv.ratios));
  check('so nothing letterboxes inside a cell', tv.band <= 8, `${tv.band}px`);
  check('and they all fit the panel', tv.onScreen, JSON.stringify(tv));

  /* The same grid at a desk, for the comparison. */
  await page.evaluate(() => { multiview.close(); device.set('desk'); render(); });
  await wait(500);
  await openGrid(page, 4);
  const desk = await page.evaluate(MEASURE);
  console.log('    desk', JSON.stringify(desk));
  check('a desk leaves the bar a row of its own, which costs picture',
    desk.picture < tv.picture, `${desk.picture}k vs ${tv.picture}k`);
  console.log(`    ${Math.round((tv.picture / tv.screen) * 100)}% of the panel is picture`
    + ` on a television, ${Math.round((desk.picture / desk.screen) * 100)}% at a desk`);
  check('and a television gets nearly all of it',
    tv.picture / tv.screen > 0.93, `${Math.round((tv.picture / tv.screen) * 100)}%`);

  await page.evaluate(() => { multiview.close(); device.set('tv'); render(); });
  await wait(400);

  /* ---- 3. two and three still leave the bands --------------------------- */
  /*
   * The answer to "what should happen with the leftover space" was: leave it.
   * Only four cells (or one) fill a 16:9 panel; the alternative for two is
   * cropping the sides off both games, and the sides of a picture are where a
   * scoreboard lives. So this checks that nothing here quietly started doing
   * that to fill a television.
   */
  console.log('\n  and the counts that cannot fill a 16:9 panel');
  for (const count of [2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await openGrid(page, count);
    // eslint-disable-next-line no-await-in-loop
    const m = await page.evaluate(MEASURE);
    console.log(`    ${count}:`, JSON.stringify(m.ratios), `band ${m.band}px`);
    check(`${count} cells stay picture-shaped rather than filling the screen`,
      shapely(m), JSON.stringify(m.ratios));
    check('  and no game is cropped to make it fit', m.band <= 8, `${m.band}px`);
  }

  /* ---- 4. driving it from the sofa ------------------------------------- */
  console.log('\n  arrows and Enter');
  await openGrid(page, 4);
  await page.evaluate(() => multiview.setFocus(-1));
  await page.keyboard.press('ArrowRight');
  await wait(200);
  let ring = await page.evaluate(() => ({
    focused: multiview.focused,
    marked: [...document.querySelectorAll('.mv-cell.is-focused')].length,
  }));
  console.log('   ', JSON.stringify(ring));
  check('the first press lands somewhere rather than nowhere',
    ring.focused >= 0, JSON.stringify(ring));
  check('and exactly one cell wears the ring', ring.marked === 1, JSON.stringify(ring));

  /* Moving about the 2x2. Read as positions rather than as indices, because
     which index sits where is the grid's business and cells can be dragged. */
  const where = () => page.evaluate(() => {
    const cell = multiview.cells[multiview.focused];
    if (!cell) return null;
    const b = cell.box.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top) };
  });
  await page.evaluate(() => multiview.setFocus(0));
  const topLeft = await where();
  await page.keyboard.press('ArrowRight');
  await wait(150);
  const right = await where();
  await page.keyboard.press('ArrowDown');
  await wait(150);
  const down = await where();
  console.log('   ', JSON.stringify({ topLeft, right, down }));
  check('right moves right and stays on the same row',
    right.x > topLeft.x && right.y === topLeft.y, JSON.stringify({ topLeft, right }));
  check('down moves down and stays in the same column',
    down.y > right.y && down.x === right.x, JSON.stringify({ right, down }));

  await page.keyboard.press('ArrowRight');
  await wait(150);
  const edge = await where();
  check('and the edge of the grid is the edge', edge.x === down.x && edge.y === down.y,
    JSON.stringify({ down, edge }));

  /* Enter on an empty cell is the thing somebody actually does first. */
  await page.keyboard.press('Enter');
  await wait(400);
  check('Enter on an empty cell opens the picker',
    await page.locator('#mvPicker').isVisible(), 'the picker did not open');
  /* And the arrows belong to the picker while it is up, not to the grid
     underneath — a list is a thing you scroll. */
  const parked = await page.evaluate(() => multiview.focused);
  await page.keyboard.press('ArrowRight');
  await wait(150);
  check('the arrows do not move the grid under an open picker',
    (await page.evaluate(() => multiview.focused)) === parked, 'the ring moved');
  await page.keyboard.press('Escape');
  await wait(300);

  /* ---- 5. and the trackpad still works --------------------------------- */
  /*
   * "Arrow keys but also the trackpad." Nothing above may have come at the
   * pointer's expense: hovering a cell brings the ring with it, so a hand that
   * reaches for the trackpad mid-evening does not have to work out where the
   * keyboard had got to first.
   */
  console.log('\n  and the trackpad');
  const centre = (i) => page.evaluate((n) => {
    const b = multiview.cells[n].box.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  }, i);
  /* Parked on one cell first, so moving to the other is a real crossing.
     pointerenter fires on the boundary, and a pointer that never left is a
     pointer that never entered. */
  const parkedOn = await centre(0);
  await page.mouse.move(parkedOn.x, parkedOn.y);
  await wait(200);
  await page.evaluate(() => multiview.setFocus(0));
  const target = await centre(3);
  await page.mouse.move(target.x, target.y);
  await wait(250);
  ring = await page.evaluate(() => multiview.focused);
  check('hovering a cell brings the ring to it', ring === 3, String(ring));

  /* And a plain click still does exactly what it always did. */
  await page.mouse.click(target.x, target.y);
  await wait(400);
  check('and clicking one still opens the picker',
    await page.locator('#mvPicker').isVisible(), 'the picker did not open');
  await page.keyboard.press('Escape');
  await wait(300);
  await page.screenshot({ path: `${SHOTS}/tvmode-multi-1080p.png` });

  /* ---- 6. the other television ----------------------------------------- */
  /*
   * A 4K panel is the same physical screen at the same distance and twice the
   * CSS pixels. A layer pinned to one set of numbers is half the right size on
   * one of them, so the sizes are read on both.
   */
  console.log('\n  and on a 4K panel');
  await page.close();
  page = await boot(browser, 3840, 2160);
  await page.evaluate(() => { device.set('tv'); render(); });
  await wait(500);
  await openGrid(page, 4);
  const big = {
    ...(await page.evaluate(MEASURE)),
    ...(await page.evaluate(() => ({
      control: Math.round(
        document.querySelector('#mvCountSeg button').getBoundingClientRect().height),
      name: parseFloat(getComputedStyle(document.querySelector('.mv-name')).fontSize),
    }))),
  };
  console.log('   ', JSON.stringify(big));
  check('the grid still fills it', big.picture / big.screen > 0.93,
    `${Math.round((big.picture / big.screen) * 100)}%`);
  check('and the cells are still picture-shaped', shapely(big), JSON.stringify(big.ratios));
  check('the controls grew with the panel rather than staying 1080p-sized',
    big.control > 70, `${big.control}px`);
  check('and so did the type', big.name > 21, `${big.name}px`);
  await page.screenshot({ path: `${SHOTS}/tvmode-multi-4k.png` });

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
