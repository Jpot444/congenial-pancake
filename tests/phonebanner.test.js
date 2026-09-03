/**
 * One banner, whichever screen it is on.
 *
 * "Change banner on the phone so that it matches the black with red text I
 *  have on the desktop"
 *
 * The desktop bar has been black with the wordmark in crimson for a while. The
 * phone was still carrying the older treatment — the red field out of
 * `--header-field`, with the words dropped entirely and the bison alone on it —
 * so the same portal looked like two different products depending on what it
 * was opened on.
 *
 * The colours are the easy half. The hard half is that the phone bar has five
 * buttons and a mark in a 52pt row, and the wordmark has to live in what is
 * left. Measured on the real bar rather than reasoned about: it is 111pt wide
 * at 17px, and it is given 111 at 393pt, 101 at 375, and 86 at 360. So it fits
 * exactly on a modern phone, wants a point off on the small ones, and at 360
 * there is no size that both fits and still reads as a wordmark — there it goes
 * away again and the mark carries the bar alone.
 *
 * Which is why this suite measures widths rather than just reading colours. A
 * clipped wordmark is poor; a wordmark shoving the profile chip off the screen
 * is broken, and that is the failure this is really guarding.
 *
 * One trap, worth naming because it cost a round: the desktop's own
 * `.desk .site-header.lifted .brand-title` outranks a plain
 * `.desk body.has-tabbar .brand-title`, so the phone's size was set and
 * silently ignored, and the bar kept the desktop's 22px and clipped. The check
 * on the computed size below is what catches that coming back.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The crimson the desktop gives the wordmark. */
const CRIMSON = 'rgb(228, 38, 46)';

/* Real phones, and the two ends of what has to work. 360 is where the words
   are expected to be gone; the rest must show them whole. */
const PHONES = [
  ['small Android', 360, 800, false],
  ['iPhone SE', 375, 667, true],
  ['iPhone 15', 393, 852, true],
  ['Pro Max', 430, 932, true],
];

const openAt = async (browser, width, height) => {
  const page = await browser.newPage({
    viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await wait(800);
  return page;
};

/** Everything about the bar, read off the rendered page. */
const readBar = (page, width) => page.evaluate((w) => {
  const px = (n) => Math.round(n);
  const head = document.querySelector('#siteHeader');
  const title = document.querySelector('.brand-title');
  const sub = document.querySelector('.brand-sub');
  const cs = getComputedStyle(head);
  const range = document.createRange();
  range.selectNodeContents(title);
  const shown = getComputedStyle(title).display !== 'none'
    && title.getBoundingClientRect().width > 0;
  const actions = [...(document.querySelector('.header-actions')?.children || [])]
    .filter((n) => !n.hidden);
  return {
    phone: document.body.classList.contains('has-tabbar'),
    bg: cs.backgroundColor,
    bgImage: cs.backgroundImage,
    shadow: cs.boxShadow,
    shown,
    titleColor: getComputedStyle(title).color,
    titleSize: getComputedStyle(title).fontSize,
    font: getComputedStyle(title).fontFamily.split(',')[0].replace(/"/g, ''),
    upper: getComputedStyle(title).textTransform,
    textW: shown ? px(range.getBoundingClientRect().width) : 0,
    boxW: shown ? px(title.getBoundingClientRect().width) : 0,
    subShown: sub ? getComputedStyle(sub).display !== 'none' : false,
    // Nothing in the row may be pushed off the edge, and the page must not
    // gain a sideways scroll.
    offscreen: actions.filter((n) => n.getBoundingClientRect().right > w + 1
      || n.getBoundingClientRect().left < -1).map((n) => n.id || n.className),
    wide: document.documentElement.scrollWidth,
  };
}, width);

(async () => {
  const browser = await chromium.launch();

  /* ---- what the phone bar is now ---------------------------------------- */
  for (const [label, width, height, wantsWords] of PHONES) {
    console.log(`\n  ${label} (${width}pt)`);
    const page = await openAt(browser, width, height);
    const bar = await readBar(page, width);
    console.log('   ', JSON.stringify({
      bg: bar.bg, size: bar.titleSize, text: bar.textW, box: bar.boxW, shown: bar.shown,
    }));

    check(`${label}: this is the phone shell`, bar.phone === true);
    /* Black, and NOT the red field it used to be — which arrives as a
       background-image, since --header-field is a gradient. */
    check(`${label}: the bar is a flat dark field`,
      bar.bgImage === 'none' && /^rgba?\(1[0-9], 1[0-9], 1[0-9]/.test(bar.bg), bar.bg);
    check(`${label}: with the crimson hairline under it`,
      /162, 31, 36/.test(bar.shadow), bar.shadow.slice(0, 60));
    check(`${label}: the second line stays off`, bar.subShown === false);

    if (wantsWords) {
      check(`${label}: the wordmark is there`, bar.shown === true);
      check(`${label}: in the desktop's crimson`, bar.titleColor === CRIMSON, bar.titleColor);
      check(`${label}: in the display face, in caps`,
        bar.font === 'Bebas Neue' && bar.upper === 'uppercase',
        `${bar.font} / ${bar.upper}`);
      /* The one that actually matters. */
      check(`${label}: and it fits, rather than being cut off`,
        bar.textW <= bar.boxW + 1, `${bar.textW} in ${bar.boxW}`);
      /* The trap in the header comment: a size that loses to the desktop's
         rule reads back as 22px. */
      check(`${label}: at the phone's own size, not the desktop's`,
        parseFloat(bar.titleSize) < 20, bar.titleSize);
    } else {
      /* No size both fits and reads down here, so the mark carries it alone.
         Saying so out loud, because "the words vanished" is otherwise a bug
         report waiting to happen. */
      check(`${label}: too narrow for a wordmark, so it steps aside`,
        bar.shown === false, `${bar.textW} in ${bar.boxW}`);
    }

    check(`${label}: nothing is pushed off the edge`,
      bar.offscreen.length === 0, JSON.stringify(bar.offscreen));
    check(`${label}: and the page gains no sideways scroll`,
      bar.wide <= width, `${bar.wide} vs ${width}`);
    await page.close();
  }

  /* ---- and the desktop it is matching is untouched ------------------------ */
  /*
   * The point of the change is that the two agree. Read here rather than
   * assumed, because everything above was done in the phone's own block and a
   * selector that leaked would show up as the desktop bar changing size.
   */
  console.log('\n  and the desktop it is matching');
  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await desk.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await desk.goto(BASE, { waitUntil: 'networkidle' });
  if (await desk.locator('#profileGate').isVisible().catch(() => false)) {
    await desk.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await wait(800);
  const big = await readBar(desk, 1440);
  console.log('   ', JSON.stringify({
    phone: big.phone, bg: big.bg, color: big.titleColor, size: big.titleSize,
  }));
  check('the desktop is not in the phone shell', big.phone === false);
  check('its wordmark is the same crimson', big.titleColor === CRIMSON, big.titleColor);
  check('and it keeps its own larger size', big.titleSize === '22px', big.titleSize);
  check('and its own glass, which the phone deliberately does not copy',
    /0\.7/.test(big.bg), big.bg);
  check('the desktop still shows the second line', big.subShown === true);
  await desk.close();

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
