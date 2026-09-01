/**
 * Pi health fits on the screen.
 *
 * "clean up the pi health section make it square so I dont need to scroll and
 *  shorten some of the catagories like listings."
 *
 * It was 520 wide and 1500 tall in a 900-pixel window. The eight numbers
 * anybody opens it to read were the top third; below them sat a column of
 * machinery — the connection test, the bandwidth switch, six hundred pixels
 * of guide sources, the reports — every bit of which had to be scrolled past
 * to reach the Close button. A panel you open to find something out at a
 * glance should not need a scroll to find anything out.
 *
 * Two changes, and this suite is about both.
 *
 *   TWO ACROSS. The numbers are already self-contained key / value / pill
 *   rows, so they became tiles; everything under them sits in a second
 *   two-column block. Same content, half the height, and the card is now
 *   about as wide as it is tall.
 *
 *   AND THE LONG ONE IS FOLDED. Listings is the tallest thing on the card by
 *   a distance, and almost all of it is for CHANGING the answer rather than
 *   reading it. The coverage line — "did it work", the only question anybody
 *   opens it to ask — stays out; the feed pickers, the XMLTV box and the
 *   troubleshooting fold away behind a disclosure.
 *
 * The phone keeps one column, which is the right answer on a phone, and this
 * checks it still fits sideways there.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"categories":[],"items":[],"totals":{"items":0}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1200);
  }
  await page.evaluate(() => health.open());
  await page.waitForSelector('.health-row', { timeout: 10000 });
  await wait(800);

  const card = () => page.evaluate(() => {
    const el = document.querySelector('.health-card');
    const box = el.getBoundingClientRect();
    return {
      w: Math.round(box.width),
      h: Math.round(box.height),
      viewport: window.innerHeight,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      right: Math.round(box.right),
    };
  });

  /* ---- it fits ---------------------------------------------------------- */
  console.log('\n  on a laptop');
  const laptop = await card();
  console.log('   ', JSON.stringify(laptop));
  /* The whole request. Nothing about this panel needs a scroll: it is eight
     numbers and four small blocks. */
  check('the card fits the window without scrolling',
    laptop.h <= laptop.viewport, `${laptop.h} tall in ${laptop.viewport}`);
  /* "Square" — not literally, but nothing like the 1:3 column it was. */
  check('and is about as wide as it is tall, not a long ribbon',
    laptop.w / laptop.h > 0.8, `${laptop.w}×${laptop.h}`);

  /* ---- laid out two across ---------------------------------------------- */
  console.log('\n  laid out in columns');
  const cols = await page.evaluate(() => {
    const lefts = (sel) => [...document.querySelectorAll(sel)]
      .filter((e) => !e.hidden && e.getBoundingClientRect().width)
      .map((e) => Math.round(e.getBoundingClientRect().left));
    const rows = [...document.querySelectorAll('.health-row')].map((r) => ({
      key: r.querySelector('.health-key').textContent,
      top: Math.round(r.getBoundingClientRect().top),
      left: Math.round(r.getBoundingClientRect().left),
    }));
    return { rowCols: new Set(rows.map((r) => r.left)).size, rows,
      panelCols: new Set(lefts('.health-panels > *')).size };
  });
  console.log('   number columns:', cols.rowCols, '· panel columns:', cols.panelCols);
  check('the numbers sit in two columns', cols.rowCols === 2, String(cols.rowCols));
  check('and so does everything under them', cols.panelCols === 2, String(cols.panelCols));
  /* Side by side, two rows that do not share a baseline read as columns that
     have drifted. Each pair carried its own margin before this. */
  const pairs = [];
  for (let i = 0; i < cols.rows.length; i += 2) {
    if (cols.rows[i + 1]) pairs.push([cols.rows[i], cols.rows[i + 1]]);
  }
  check('and each pair shares a line',
    pairs.every(([a, b]) => a.top === b.top),
    JSON.stringify(pairs.map(([a, b]) => [a.key, a.top, b.key, b.top])));

  /* ---- the long one is folded ------------------------------------------- */
  console.log('\n  Listings');
  const listings = await page.evaluate(() => {
    const panel = document.querySelector('#guidePanel');
    const more = document.querySelector('.gsrc-more');
    return {
      panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
      folded: more ? !more.open : null,
      /* The coverage line is the answer, and stays out. */
      noteOut: Boolean(document.querySelector('#guideNote')?.getBoundingClientRect().height),
      /* The machinery is still in the document, just not unrolled.
         checkVisibility(), not a rectangle: a closed <details> is
         content-visibility:hidden in this engine, and a subtree skipped that
         way keeps the geometry it last had — so its height reads as though it
         were on the screen. */
      picksThere: Boolean(document.querySelector('#guidePicks')),
      picksShowing: document.querySelector('#guidePicks').checkVisibility(),
    };
  });
  console.log('   ', JSON.stringify(listings));
  check('the feed machinery is folded away', listings.folded === true);
  check('but the coverage line — the answer — is not', listings.noteOut === true);
  check('and the pickers are still in the page, ready to open',
    listings.picksThere === true && listings.picksShowing === false,
    JSON.stringify(listings));
  /* It was 582px. Anything near that means the fold is not doing its job. */
  check('so Listings is no longer the tallest thing on the card',
    listings.panelH !== null && listings.panelH < 220, String(listings.panelH));

  console.log('\n  and it still opens');
  await page.click('.gsrc-more > summary');
  await wait(400);
  const opened = await page.evaluate(() => ({
    open: document.querySelector('.gsrc-more').open,
    picks: document.querySelector('#guidePicks').checkVisibility(),
    field: document.querySelector('#guideExtra').checkVisibility(),
  }));
  console.log('   ', JSON.stringify(opened));
  /* Folded is not the same as gone: everything that was reachable still is,
     one press further in. */
  check('pressing it brings the whole thing back',
    opened.open === true && opened.field === true, JSON.stringify(opened));
  await page.click('.gsrc-more > summary');
  await wait(300);

  /* ---- and a phone is still a phone -------------------------------------- */
  console.log('\n  on a phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(600);
  const phone = await card();
  const phoneCols = await page.evaluate(() => new Set(
    [...document.querySelectorAll('.health-row')]
      .map((r) => Math.round(r.getBoundingClientRect().left))).size);
  console.log('   ', JSON.stringify({ ...phone, phoneCols }));
  /* Two columns of numbers on a 390px screen would be four words wide each. */
  check('it goes back to one column', phoneCols === 1, String(phoneCols));
  check('the card stays on the screen', phone.right <= phone.winW + 1,
    JSON.stringify(phone));
  check('and nothing pushes the page sideways', phone.docW <= phone.winW + 1,
    JSON.stringify(phone));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
