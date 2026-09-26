/**
 * The walkthrough, and the download allowance.
 *
 * The tour's whole job is pointing at the right thing, so the checks are about
 * geometry — is the hole actually over the element named, is the card actually
 * beside it and on screen — rather than about the words.
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

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  let saved = null;
  await page.route('**/api/profiles/*/prefs', async (r) => {
    if (r.request().method() === 'PUT') {
      saved = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ favorites: [], pinnedCategories: [], pinOrder: {},
        deletedItems: [], deletedCategories: [],
        tourDone: false, downloadLimit: 3221225472, downloadUsed: 0 }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
  }
  await page.waitForSelector('#tour:not([hidden])', { timeout: 15000 });
  await wait(400);

  console.log('\n  the tour runs for a profile that has not seen it');
  const total = await page.evaluate(() => tour.steps.length);
  check('it has steps to show', total >= 5, String(total));

  // Walk every step and check the hole really covers what the step names.
  const seen = [];
  for (let i = 0; i < total; i += 1) {
    const step = await page.evaluate(() => {
      const s = tour.steps[tour.at];
      const t = s.node.getBoundingClientRect();
      const hole = document.querySelector('#tourHole').getBoundingClientRect();
      const card = document.querySelector('#tourCard').getBoundingClientRect();
      return {
        target: s.target.split(',')[0],
        title: document.querySelector('#tourTitle').textContent,
        body: document.querySelector('#tourBody').textContent,
        left: document.querySelector('#tourLeft').textContent,
        nextLabel: document.querySelector('#tourNext').textContent,
        covers: hole.left <= t.left + 1 && hole.right >= t.right - 1
          && hole.top <= t.top + 1 && hole.bottom >= t.bottom - 1,
        holeSane: hole.width < window.innerWidth && hole.height < window.innerHeight,
        cardOnScreen: card.left >= 0 && card.top >= 0
          && card.right <= window.innerWidth && card.bottom <= window.innerHeight,
        overlapsHole: !(card.right < hole.left || card.left > hole.right
          || card.bottom < hole.top || card.top > hole.bottom),
      };
    });
    seen.push(step);
    if (i === 0) await page.screenshot({ path: SHOTS + '/tour.png' });
    if (i < total - 1) await page.locator('#tourNext').click();
    await wait(300);
  }

  console.log('   steps:', seen.map((s) => s.target).join(' → '));
  check('every step highlights the thing it names',
    seen.every((s) => s.covers), seen.filter((s) => !s.covers).map((s) => s.target).join(', '));
  check('the highlight is a hole, not the whole screen',
    seen.every((s) => s.holeSane), 'a hole covered the viewport');
  check('every card stays on screen',
    seen.every((s) => s.cardOnScreen),
    seen.filter((s) => !s.cardOnScreen).map((s) => s.target).join(', '));
  check('and beside the highlight rather than on top of it',
    seen.every((s) => !s.overlapsHole),
    seen.filter((s) => s.overlapsHole).map((s) => s.target).join(', '));
  check('every step says something', seen.every((s) => s.body.length > 40));
  check('the count runs down',
    seen[0].left.startsWith(String(total - 1)) && seen[total - 1].left === 'last one',
    `${seen[0].left} … ${seen[total - 1].left}`);
  check('the last button is not "Next"', seen[total - 1].nextLabel === 'Got it',
    seen[total - 1].nextLabel);
  check('the allowance is spelled out where downloads are explained',
    seen.some((s) => /3GB/.test(s.body)),
    seen.map((s) => s.body).find((b) => /GB/.test(b)) || 'no GB anywhere');

  // Finishing writes it down.
  await page.locator('#tourNext').click();
  await wait(1400);
  check('finishing closes it', await page.locator('#tour').isHidden());
  check('and remembers, so it does not come back',
    saved && saved.tourDone === true, JSON.stringify(saved));

  /* And hands over to the picks.
   *
   * "when new profiles are created, after the walkthrough tour, I want it to
   *  ask a few channels, movies, shows."
   *
   * The tour ended by describing a home page made of favourites and
   * half-watched things to somebody who had neither, so what it closes onto
   * matters as much as what it says. Checked here rather than only in
   * firstpicks.test.js because this is the suite that owns the end of the
   * tour, and it is also what made this suite fail when the handover was
   * added: every click after this point was landing on a sheet that had
   * opened over the page. */
  check('and hands over to the picks rather than to an empty page',
    await page.locator('#starter').isVisible(),
    'no starter sheet after the last step');
  await page.locator('#starterSkip').click();
  await wait(700);
  check('which can be skipped straight back out of',
    await page.locator('#starter').isHidden());

  // --- the X gets you out at any point ------------------------------------
  console.log('\n  the X');
  saved = null;
  await page.evaluate(() => {
    profiles.data.tourDone = false;
    /* Already answered a moment ago, and this half of the suite is about the
       tour's own exit rather than about what follows it. */
    profiles.data.startersDone = true;
    tour.start();
  });
  await wait(300);
  await page.locator('#tourNext').click();
  await wait(200);
  await page.locator('#tourSkip').click();
  await wait(600);
  check('the X ends it early', await page.locator('#tour').isHidden());
  check('and still counts as done', saved && saved.tourDone === true, JSON.stringify(saved));

  // --- a profile that has been here before is left alone -------------------
  console.log('\n  an established profile');
  await page.unroute('**/api/profiles/*/prefs');
  await page.route('**/api/profiles/*/prefs', (r) => {
    if (r.request().method() === 'PUT') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ favorites: [], pinnedCategories: [], pinOrder: {},
        deletedItems: [], deletedCategories: [],
        tourDone: true, downloadLimit: null, downloadUsed: 0 }) });
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
  }
  await wait(2500);
  check('no tour for a profile that has already been round',
    await page.locator('#tour').isHidden());

  // --- the phone walks its own controls ------------------------------------
  console.log('\n  on a phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    device.set('phone');
    profiles.data.tourDone = false;
    tour.start();
  });
  await wait(500);
  // One step at a time, with a pause between: the hole slides to its next
  // position over a quarter of a second, so measuring straight after painting
  // catches it halfway there.
  const phoneSteps = await page.evaluate(() => tour.steps.length);
  const phone = [];
  for (let i = 0; i < phoneSteps; i += 1) {
    await page.evaluate((n) => { tour.at = n; tour.paint(); }, i);
    await wait(350);
    phone.push(await page.evaluate(() => {
      const t = tour.steps[tour.at].node.getBoundingClientRect();
      const hole = document.querySelector('#tourHole').getBoundingClientRect();
      const card = document.querySelector('#tourCard').getBoundingClientRect();
      const node = tour.steps[tour.at].node;
      return {
        // The element the step actually landed on, not the selector it asked
        // for: the point of the phone run is that it picks the tab bar copy.
        target: `${node.closest('nav, header')?.className || node.tagName}`
          + ` ${node.id || node.getAttribute('href') || node.className}`,
        covers: hole.left <= t.left + 1 && hole.right >= t.right - 1
          && hole.top <= t.top + 1 && hole.bottom >= t.bottom - 1,
        onScreen: card.left >= 0 && card.top >= 0
          && card.right <= window.innerWidth + 1 && card.bottom <= window.innerHeight + 1,
      };
    }));
  }
  console.log('   ', phone.map((p) => p.target).join(' → '));
  check('the phone gets steps of its own', phone.length >= 4, String(phone.length));
  check('pointing at controls it actually has',
    phone.every((p) => p.covers), phone.filter((p) => !p.covers).map((p) => p.target).join(', '));
  check('with the card on screen',
    phone.every((p) => p.onScreen), phone.filter((p) => !p.onScreen).map((p) => p.target).join(', '));
  await page.screenshot({ path: SHOTS + '/tour-phone.png' });

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
