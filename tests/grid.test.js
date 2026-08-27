/**
 * How many posters to a row.
 *
 * There used to be a setting for this — 2, 3 or 4, chosen by hand in the device
 * sheet, phone layout only. It defaulted to 2, which is why an iPad opened on
 * two 385px posters: half a screen each, on the device with the most room.
 * Picking a number per device is the wrong shape of answer anyway, because the
 * number that is right depends on a width nobody wants to think about, and it
 * is wrong again on the next phone.
 *
 * So there is no number. The grid names one target WIDTH per card shape and
 * `repeat(auto-fill, minmax(<target>, 1fr))` works out the count. The target is
 * a clamp, and the clamp is the whole trick: a flat minimum that gives three on
 * a phone forces six on a tablet, because an iPad is only about twice a phone
 * across. The middle term lets the poster grow with the space instead of just
 * multiplying, so the count climbs one step at a time.
 *
 * Two claims, and the second is the one that keeps catching people out:
 *
 *   * the counts below are what each device actually renders, and
 *   * a poster never gets NARROWER as the screen gets wider.
 *
 * The second is why the middle term is measured in `cqi` against the content
 * column rather than `vw` against the window. From 860px up, a 236px category
 * sidebar sits beside the grid. Measured against the window, an iPad in
 * landscape believed it had 1024px, asked for 168px posters, and fitted five of
 * them into the 692px it really had — 124px each, narrower than the same poster
 * on a phone.
 *
 * The desktop is checked too, and the claim there is that NOTHING moved: six
 * across at 170px is what it fitted before any of this.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Enough to fill several rows at every width, so the top row is always full and
// the count read off it is the column count rather than however many there were.
const MOVIES = {
  categories: [{ id: 'ac', name: 'EN - ACTION' }],
  items: Array.from({ length: 60 }, (_, i) => ({
    kind: 'movie',
    id: i + 1,
    name: `Film ${i + 1}`,
    logo: '',
    categoryId: 'ac',
    added: 1000 + i,
  })),
};

/* Every device the design names, plus the two that broke it.
 *
 * `cols` is the browse page — a category open as a grid, which is the page the
 * design draws and the one this is about. `withSidebar` is the same page
 * reached the other way, by picking a category from the sidebar column, which
 * puts that 236px column back and takes it out of the grid's width. Both are
 * real states and the count differs between them, so both are checked rather
 * than one of them being quietly the answer. */
const CASES = [
  { name: 'iPhone SE',         w: 375,  h: 667,  cols: 3, withSidebar: 3 },
  { name: 'iPhone 15 Pro',     w: 393,  h: 852,  cols: 3, withSidebar: 3 },
  { name: 'iPhone Pro Max',    w: 440,  h: 956,  cols: 3, withSidebar: 3 },
  { name: 'iPad 11 portrait',  w: 820,  h: 1180, cols: 5, withSidebar: 5 },
  { name: 'iPad 11 landscape', w: 1024, h: 768,  cols: 5, withSidebar: 4 },
  { name: 'desktop',           w: 1440, h: 900,  cols: 7, withSidebar: 6 },
];

/* The count read off the rendered boxes: how many cards share the top row.
   Several .grid elements exist at once — multi-view's channel picker keeps a
   hidden one — so this takes the visible grid that actually holds cards. */
function measure() {
  const grid = [...document.querySelectorAll('.grid')]
    .filter((g) => g.querySelector('.card') && g.getClientRects().length)
    .sort((a, b) => b.children.length - a.children.length)[0];
  if (!grid) return { cols: null, note: 'no visible grid with cards' };
  const kids = [...grid.children];
  const top = Math.round(kids[0].getBoundingClientRect().top);
  return {
    cols: kids.filter((k) => Math.abs(Math.round(k.getBoundingClientRect().top) - top) < 2).length,
    poster: Math.round(kids[0].getBoundingClientRect().width),
    column: Math.round(grid.getBoundingClientRect().width),
  };
}

(async () => {
  const browser = await chromium.launch();
  const seen = [];

  for (const c of CASES) {
    // hasTouch is what puts a device in phone layout — a coarse pointer on a
    // screen narrower than 820. Set on the context rather than by toggling
    // afterwards, so the page reads the same thing real hardware would.
    const page = await browser.newPage({
      viewport: { width: c.w, height: c.h },
      hasTouch: c.w < 1200,
      isMobile: c.w < 500,
    });
    page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

    await page.route('**/api/profiles/*/taste', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (await page.locator('#profileGate').isVisible()) {
      await page.locator('.profile-tile').first().click();
      await wait(1500);
    }

    // Land on Movies first: setting the hash runs the router, and the router
    // clears whatever was open — so the page is chosen after that settles.
    await page.evaluate((lib) => {
      state.library.movies = lib;
      location.hash = '#/movies';
    }, MOVIES);
    await wait(900);

    /* The browse page: one shelf opened as a grid, which is how the category
       bar opens a category and the page the design draws. No sidebar. */
    await page.evaluate(() => {
      state.shelf = window.buildShelves('movies')[0].title;
      state.visible = 60;
      render();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.grid')]
      .some((g) => g.querySelector('.card') && g.getClientRects().length), { timeout: 10000 });
    await wait(400);
    const m = await page.evaluate(measure);

    /* The same page reached from the sidebar, which puts its column back. */
    await page.evaluate(() => { state.shelf = null; state.category = 'ac'; render(); });
    await wait(700);
    const withSidebar = await page.evaluate(measure);

    seen.push({ device: c, got: m, sidebar: withSidebar });
    console.log(`   ${c.name.padEnd(19)} ${String(c.w).padStart(4)}pt  `
      + `column ${String(m.column).padStart(4)}px → ${m.cols} across @ ${m.poster}px`
      + `   (from the sidebar: ${withSidebar.cols} @ ${withSidebar.poster}px)`);

    await page.screenshot({ path: `${__dirname}/shots/grid-${c.w}.png` });
    await page.close();
  }

  // --- the count each device lands on --------------------------------------
  console.log('\n  how many to a row');
  for (const { device, got } of seen) {
    check(`${device.name} · ${device.w}pt fits ${device.cols} across`,
      got.cols === device.cols, `got ${got.cols}${got.note ? ` (${got.note})` : ''}`);
  }

  console.log('\n  and with the sidebar column open');
  for (const { device, sidebar } of seen) {
    check(`${device.name} fits ${device.withSidebar} across beside the sidebar`,
      sidebar.cols === device.withSidebar, `got ${sidebar.cols}`);
  }

  // --- and none of them is a hand-picked number ----------------------------
  //
  // Three different counts out of one rule is the point. If every device came
  // back with the same number the clamp has collapsed to a fixed minimum and
  // the counts above would be passing by coincidence.
  const distinct = new Set(seen.map((s) => s.got.cols));
  check('the count really does follow the screen rather than being one number',
    distinct.size >= 3, `counts seen: ${[...distinct].join(', ')}`);

  // --- a poster never shrinks as the screen grows --------------------------
  //
  // The claim `cqi` exists to keep. Measured across the row of devices in
  // ascending width: a wider screen may add a column, but the poster it lands
  // on must not end up narrower than the one a smaller screen showed.
  console.log('\n  posters do not shrink as the screen grows');
  const byWidth = [...seen].sort((a, b) => a.device.w - b.device.w);
  const shrank = [];
  for (let i = 1; i < byWidth.length; i++) {
    const prev = byWidth[i - 1], cur = byWidth[i];
    if (cur.got.poster < prev.got.poster - 1) {
      shrank.push(`${prev.device.name} ${prev.got.poster}px → ${cur.device.name} ${cur.got.poster}px`);
    }
  }
  for (const s of byWidth) {
    console.log(`   ${String(s.device.w).padStart(4)}pt  ${String(s.got.poster).padStart(4)}px`);
  }
  check('every step up the range holds or grows the poster',
    shrank.length === 0, shrank.join('; '));

  // --- the desktop did not move --------------------------------------------
  //
  // The desktop grid asked for 168px posters before any of this and asks for
  // 168px now, so where the page is the same the count must be the same. The
  // page reached from the sidebar is that page: six across at 170px in a
  // 1108px column, exactly what it fitted before.
  console.log('\n  the desktop is where it was');
  const desk = seen.find((s) => s.device.name === 'desktop');
  check('six across beside the sidebar, unchanged', desk.sidebar.cols === 6,
    `got ${desk.sidebar.cols}`);
  check('at the width it always used', Math.abs(desk.sidebar.poster - 170) <= 2,
    `${desk.sidebar.poster}px`);

  // --- and the setting it replaced is gone ---------------------------------
  console.log('\n  the setting it replaced');
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  await page.addInitScript(() => {
    localStorage.setItem('portal.touch', '1');
    // What an older build would have left behind. Opening the app must clear it
    // rather than leave a key nothing reads.
    localStorage.setItem('portal.cols', '4');
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const gone = await page.evaluate(() => ({
    seg: !!document.querySelector('#colsSeg'),
    field: !!document.querySelector('#colsField'),
    stored: localStorage.getItem('portal.cols'),
    varSet: document.documentElement.style.getPropertyValue('--poster-cols'),
  }));
  console.log('   ', JSON.stringify(gone));
  check('no posters-per-row control in the device sheet', !gone.seg && !gone.field,
    JSON.stringify(gone));
  check('and an older build\'s stored choice is cleared rather than left to rot',
    gone.stored === null, String(gone.stored));
  check('nothing still sets --poster-cols', gone.varSet === '', gone.varSet);
  await page.close();

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
