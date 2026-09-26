/**
 * The remedy on a health row can be read.
 *
 * "still getting this error … nothing starts pm2 at boot (no `pm2 startup`
 *  service, no @reboot entry) — this can be fixed from here"
 *
 * It could be. The endpoint worked, the crontab write worked, the read-back
 * worked, and a suite covered all three. What nobody had looked at was the
 * button.
 *
 * `.health-act` was a class invented in the markup and never given a single
 * rule. `.btn` beside it sets a shape — height, padding, a pill radius — and
 * no background, no colour and no font, so the browser's own button defaults
 * came through underneath: a blank white lozenge with the words "Fix it now"
 * somewhere inside it and invisible. Worse, it was the fourth child of a
 * three-column grid, so it fell into the next implicit row under the KEY
 * column, 84 pixels wide and detached from the sentence it answers. Measured
 * on the shipped build at both widths, it was 84–96px of white nothing that
 * read as a rendering fault.
 *
 * Which is the whole reason the box kept reporting a fault it had been able
 * to fix for a fortnight: the fix was on the screen the entire time and there
 * was nothing there to press.
 *
 * So this suite is about LEGIBILITY, not about the endpoint — bootfix.test.js
 * owns that. It asks the three questions the eye asks: can the label be seen
 * against the button, does the label fit inside it, and is it next to the
 * thing it is offering to fix.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A box that would not come back, and can fix that itself. The real one under
   this suite may be either, and neither answer is the subject here. */
const DOWN = {
  saved: ['iptv-portal', 'iptv-updater'],
  service: false,
  cron: false,
  how: '',
  missing: ['nothing starts pm2 at boot (no `pm2 startup` service, no @reboot entry)'],
  fixable: true,
  ok: false,
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"categories":[],"items":[],"totals":{"items":0}}' }));

  /* The box's own answer, with one field replaced — everything else on this
     panel is real, because a hand-written health payload is a fixture that
     can drift away from the shape the box emits. */
  await page.route('**/api/health**', async (r) => {
    const res = await r.fetch();
    const body = await res.json().catch(() => null);
    if (!body) return r.fulfill({ status: 500, body: '{}' });
    body.boot = DOWN;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(body) });
  });
  let installs = 0;
  await page.route('**/api/boot/install', (r) => {
    installs += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"ok":true,"line":"@reboot /bin/bash …","saved":true}' });
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wait(1500);
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1400);
  }
  /* The walkthrough covers the page for a profile that has not been round it,
     and it is not what is being looked at. */
  await page.evaluate(() => {
    document.querySelector('#tour')?.remove();
    health.open();
  });
  await page.waitForSelector('.health-row', { timeout: 10000 });
  await wait(700);

  /** Everything about the button that decides whether a person can use it. */
  const measure = () => page.evaluate(() => {
    const act = document.querySelector('.health-act[data-act="boot"]');
    if (!act) return null;
    const css = getComputedStyle(act);
    const box = act.getBoundingClientRect();
    const row = act.closest('.health-row');
    const val = row.querySelector('.health-val');
    const vbox = val.getBoundingClientRect();

    /* Contrast, the way it is actually defined, rather than "the two colours
       are different strings" — which `white on white` would also pass if one
       of them were spelled rgb(255,255,255) and the other #fff.
     *
     * AND COMPOSITED, which is not a detail. This panel is built out of
     * translucent layers: the button's own background is a tenth of an opacity
     * of red, and taking that string at face value compares a colour against
     * itself and reports 1:1 on a button that is perfectly readable. What the
     * eye sees is every layer from the page up, flattened — so that is what is
     * measured. */
    const parse = (s) => {
      const n = (s.match(/[\d.]+/g) || []).map(Number);
      if (n.length < 3) return null;
      return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    /* Up the tree, collecting every layer, until one is opaque enough that
       nothing behind it can show through. */
    const layers = [];
    for (let node = act; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (!c || c.a === 0) continue;
      layers.push(c);
      if (c.a === 1) break;
    }
    /* Flattened from the bottom up; a page that never painted an opaque
       background is white, which is what a browser does. */
    let back = layers.length && layers[layers.length - 1].a === 1
      ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) back = over(layers.pop(), back);
    const ink = over(parse(css.color) || { r: 0, g: 0, b: 0, a: 1 }, back);

    const lum = (c) => {
      const [r, g, b] = [c.r, c.g, c.b].map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = lum(ink);
    const b = lum(back);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const say = (c) => `rgb(${[c.r, c.g, c.b].map((v) => Math.round(v)).join(', ')})`;

    return {
      text: act.textContent.trim(),
      shown: act.getClientRects().length > 0,
      w: Math.round(box.width),
      h: Math.round(box.height),
      /* Does the label fit? scrollWidth past clientWidth is text the button
         is not big enough to show. */
      overflow: act.scrollWidth - act.clientWidth,
      color: say(ink),
      back: say(back),
      ratio: Math.round(ratio * 100) / 100,
      fontSize: css.fontSize,
      /* Where it sits relative to the sentence it answers. */
      underValue: Math.abs(Math.round(box.left) - Math.round(vbox.left)) <= 2,
      below: Math.round(box.top) >= Math.round(vbox.bottom) - 2,
      inSameRow: Boolean(row) && row.contains(act),
    };
  });

  console.log('\n  on a laptop');
  const desk = await measure();
  console.log('   ', JSON.stringify(desk));
  check('the row offers a remedy at all', desk !== null, 'no .health-act rendered');
  check('and it says what it will do', desk && desk.text === 'Fix it now',
    desk && desk.text);
  check('it is on the screen', desk && desk.shown === true, JSON.stringify(desk));

  /* THE FAULT. A white pill with white words in it is, from the sofa, not a
     button. 3:1 is the floor for large text and this is not large text, so
     anything near it is still a problem — but a ratio of about 1 is the
     specific thing that was shipped. */
  check('the label can be seen against the button', desk && desk.ratio >= 3,
    desk && `contrast ${desk.ratio}:1 — ${desk.color} on ${desk.back}`);
  /* The other half of it: 84 pixels of pill with a ten-character label. */
  check('and the button is wide enough for the words',
    desk && desk.overflow <= 0, desk && `${desk.overflow}px of text does not fit`);

  /* And WHERE. It used to fall into the grid's next implicit cell, under the
     key column, reading as an artefact beside the row rather than as that
     row's answer. */
  check('it sits with the row it belongs to', desk && desk.inSameRow === true);
  check('under the sentence it answers, in the same column',
    desk && desk.underValue === true && desk.below === true,
    JSON.stringify({ underValue: desk && desk.underValue, below: desk && desk.below }));

  /* ---- and it does the thing ------------------------------------------- */
  console.log('\n  pressing it');
  await page.locator('.health-act[data-act="boot"]').click({ timeout: 5000 });
  await wait(800);
  console.log('    install calls:', installs);
  check('the box is asked to install the boot entry', installs === 1, String(installs));

  /* ---- and on a phone, which is where this is read ---------------------- */
  /*
   * The health panel is opened on a phone more often than anywhere else — it
   * is the thing you look at when the television is misbehaving — and the
   * phone layout is a different grid, so it is a separate measurement rather
   * than an assumption.
   */
  console.log('\n  and on a phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(700);
  const phone = await measure();
  console.log('   ', JSON.stringify(phone));
  check('the remedy is legible there too', phone && phone.ratio >= 3,
    phone && `contrast ${phone.ratio}:1`);
  check('the words still fit', phone && phone.overflow <= 0,
    phone && String(phone.overflow));
  /* A 34px pill is a miss on a touch screen as often as a hit. */
  check('and it is big enough to hit with a thumb', phone && phone.h >= 40,
    phone && `${phone.h}px tall`);

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
