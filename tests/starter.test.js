/**
 * The optional profile password, and the starter live pins.
 *
 * Both are about a first visit, so both are driven through the real gate and
 * the real Live TV render rather than by calling the helpers. The pin seeding
 * in particular is worth driving end to end: it turns provider *names* into
 * provider *ids*, and the names arrive dressed in unicode quality tags that no
 * plain string compare survives.
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

// The provider's real shape: superscript quality tags, a pipe, and a few
// categories that are not on the starter list at all.
const CATS = [
  { category_id: '9', category_name: 'US| RELIGIOUS ᴴᴰ' },
  { category_id: '20', category_name: 'US| NFL PPV' },
  { category_id: '566', category_name: 'US| NBC ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ' },
  { category_id: '228', category_name: 'US| CBS ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ' },
  { category_id: '12', category_name: 'US| UFC PPV' },
  { category_id: '71', category_name: 'US| PPV EVENT ⁽ᴮᴷ⁾' },
  { category_id: '51', category_name: 'US| PPV EVENT' },
  { category_id: '7', category_name: 'UK| SHOPPING' },
];
const STREAMS = CATS.flatMap((c, i) => [
  { stream_id: 1000 + i, name: `${c.category_name} channel`, category_id: c.category_id,
    stream_icon: '', stream_type: 'live' },
]);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  // --- a server whose lock we control ------------------------------------
  let locked = false;
  let prefs = null;
  const saved = [];
  let createBody = null;
  let deleteBody = null;
  let lockBody = null;

  const fresh = () => ({
    favorites: [], pinnedCategories: [], pinOrder: {},
    deletedItems: [], deletedCategories: [],
    tourDone: true, liveTourDone: false, livePinsSeeded: false,
    downloadLimit: 3221225472, downloadUsed: 0,
  });
  prefs = fresh();

  await page.route('**/api/profiles', async (r) => {
    if (r.request().method() === 'POST') {
      createBody = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 'p-new', name: 'Ben', emoji: '🎬', color: '#A21F24' }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ locked, profiles: [
        { id: 'p1', name: 'Hunter', emoji: '🐂', color: '#A21F24' },
      ] }) });
  });
  await page.route('**/api/profiles/*/prefs', async (r) => {
    if (r.request().method() === 'PUT') {
      const body = JSON.parse(r.request().postData() || '{}');
      saved.push(body);
      prefs = { ...prefs, ...body };
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(prefs) });
  });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/profiles/*', async (r) => {
    if (r.request().method() === 'DELETE') {
      deleteBody = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"removed":true}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // Registered after the catch-all above on purpose: Playwright tries routes
  // most-recent first, so /api/profiles/* would otherwise answer /lock.
  await page.route('**/api/profiles/lock', async (r) => {
    lockBody = JSON.parse(r.request().postData() || '{}');
    if (lockBody.password !== 'Little9') {
      return r.fulfill({ status: 401, contentType: 'application/json',
        body: '{"error":"That password is not correct."}' });
    }
    locked = lockBody.locked === true;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ locked }) });
  });
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_live_categories') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(CATS) });
    }
    if (action === 'get_live_streams') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(STREAMS) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#profileGate:not([hidden])', { timeout: 15000 });

  // --- adding a profile asks for nothing when the lock is off -------------
  console.log('\n  with the lock off (the default)');
  await page.locator('.profile-add').click();
  await wait(300);
  check('no password field on the add form',
    await page.locator('#passwordField').isHidden());
  await page.locator('#profileForm input[name="name"]').fill('Ben');
  await page.locator('#profileSubmit').click();
  await wait(600);
  check('the profile is created', createBody !== null, 'no POST was made');
  check('and no password is sent',
    createBody && createBody.password === undefined, JSON.stringify(createBody));

  // Deleting: one confirm, no prompt.
  let asked = { confirm: 0, prompt: 0 };
  page.on('dialog', async (d) => {
    asked[d.type() === 'prompt' ? 'prompt' : 'confirm'] += 1;
    await (d.type() === 'prompt' ? d.accept('Little9') : d.accept());
  });
  await page.locator('#manageBtn').click();
  await wait(200);
  await page.locator('.profile-tile').first().click();
  await wait(300);
  await page.locator('#profileDelete').click();
  await wait(700);
  check('deleting asks once, and not for a password',
    asked.confirm === 1 && asked.prompt === 0, JSON.stringify(asked));
  check('and sends none', deleteBody && !deleteBody.password, JSON.stringify(deleteBody));

  // --- turning the lock on -------------------------------------------------
  console.log('\n  turning the lock on');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#profileGate:not([hidden])', { timeout: 15000 });
  await page.locator('#manageBtn').click();
  await wait(200);
  check('the switch is only shown while managing',
    await page.locator('#lockBtn').isVisible());
  check('and says which way it is set',
    /lock is off/i.test(await page.locator('#lockBtn').textContent()),
    await page.locator('#lockBtn').textContent());

  asked = { confirm: 0, prompt: 0 };
  await page.locator('#lockBtn').click();
  await wait(700);
  check('turning it on asks for the password too',
    asked.prompt === 1, JSON.stringify(asked));
  check('the server was told to lock', lockBody && lockBody.locked === true,
    JSON.stringify(lockBody));
  check('and the label follows',
    /lock is on/i.test(await page.locator('#lockBtn').textContent()),
    await page.locator('#lockBtn').textContent());

  // With it on, the password comes back.
  createBody = null;
  await page.locator('#manageBtn').click();   // leave manage mode
  await wait(200);
  await page.locator('.profile-add').click();
  await wait(300);
  check('the password field is back on the add form',
    await page.locator('#passwordField').isVisible());
  await page.locator('#profileForm input[name="name"]').fill('Ben');
  await page.locator('#profileForm input[name="password"]').fill('Little9');
  await page.locator('#profileSubmit').click();
  await wait(600);
  check('and is sent', createBody && createBody.password === 'Little9',
    JSON.stringify(createBody));
  locked = false;

  // --- the starter pins ----------------------------------------------------
  console.log('\n  a new profile\'s first look at Live TV');
  prefs = fresh();
  saved.length = 0;
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#profileGate:not([hidden])', { timeout: 15000 });
  await page.locator('.profile-tile').first().click();
  await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
  await wait(800);
  check('nothing explains Live TV before you go there',
    await page.locator('#tour').isHidden());

  // The library is injected rather than fetched: how it is loaded is another
  // suite's business, and the seeding only cares what the categories are.
  await page.evaluate((cats) => {
    state.library.live = {
      categories: cats.map((c) => ({ id: c.category_id, name: c.category_name })),
      items: cats.map((c, i) => ({
        kind: 'live', id: 2000 + i, name: `${c.category_name} channel`,
        logo: '', categoryId: c.category_id,
      })),
    };
    location.hash = '#/live';
  }, CATS);
  // Where the categories are drawn depends on the layout. The desktop portal
  // makes the pins the chip bar at the top of the page; the phone keeps the
  // grid of category tiles. What is under test is the seeding — which
  // categories get pinned, in which order — and that is the same either way,
  // so the suite reads whichever of the two this layout put on screen.
  await page.waitForSelector('#dkChips .catchip, #grid .cat-card', { timeout: 15000 });
  await wait(900);

  const grid = await page.evaluate(() => {
    const desk = document.documentElement.classList.contains('desk');
    const all = desk ? '#dkChips .catchip' : '#grid .cat-card';
    const set = desk ? '#dkChips .catchip.pinned' : '#grid .cat-card.is-pinned';
    // A chip carries its count in a <b> the tile has no equivalent of, and
    // the count is not part of the name.
    const label = (node) => (desk
      ? [...node.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')
      : node.querySelector('.card-title')?.textContent || '').trim();
    return {
      where: desk ? 'chips' : 'tiles',
      order: [...document.querySelectorAll(all)].map(label),
      pinned: [...document.querySelectorAll(set)].map(label),
      keys: profiles.data.pinnedCategories,
    };
  });
  console.log('   pinned:', grid.where, JSON.stringify(grid.pinned));

  // Six of the eight fixture categories are on the starter list.
  check('the starter categories are pinned',
    grid.pinned.length === 6, `${grid.pinned.length} pinned`);
  // The tags are stripped for DISPLAY now, so the label is the short form —
  // while the matching that decided to pin these still ran on the provider's
  // full name. Both halves are worth pinning down: the name on screen is
  // clean, and the category it stands for is the tagged one.
  check('including the ones wearing quality tags',
    grid.pinned.includes('US| NBC') && grid.pinned.includes('US| CBS'),
    JSON.stringify(grid.pinned));
  check('and the tag is gone from the label, not from the category',
    grid.pinned.every((n) => !/[\u1D2C-\u1D6B\u2070-\u209F]/.test(n)),
    JSON.stringify(grid.pinned));
  check('and the two PPV EVENT rows are told apart',
    grid.keys.includes('live:71') && grid.keys.includes('live:51'),
    JSON.stringify(grid.keys));
  check('categories not on the list are left alone',
    !grid.pinned.some((n) => /RELIGIOUS|SHOPPING/.test(n)), JSON.stringify(grid.pinned));
  check('they lead the list',
    grid.order.slice(0, 6).every((n) => grid.pinned.includes(n)),
    JSON.stringify(grid.order.slice(0, 7)));
  check('in the order they were listed, not the provider\'s',
    grid.keys.slice(0, 3).join() === 'live:20,live:566,live:228',
    JSON.stringify(grid.keys.slice(0, 5)));
  check('and it is written down as seeded',
    saved.some((s) => s.livePinsSeeded === true), 'no save carried the flag');

  // --- the note ------------------------------------------------------------
  const note = await page.evaluate(() => {
    if (document.querySelector('#tour').hidden) return null;
    const hole = document.querySelector('#tourHole').getBoundingClientRect();
    const tiles = [...document.querySelectorAll(
      document.documentElement.classList.contains('desk')
        ? '#dkChips .catchip.pinned'
        : '#grid .cat-card.is-pinned'
    )].map((t) => t.getBoundingClientRect());
    const card = document.querySelector('#tourCard').getBoundingClientRect();
    return {
      body: document.querySelector('#tourBody').textContent,
      steps: tour.steps.length,
      nextLabel: document.querySelector('#tourNext').textContent,
      // The hole has to reach the first tile and at least one more, or it is
      // not describing a row.
      coversFirst: hole.left <= tiles[0].left + 1 && hole.top <= tiles[0].top + 1
        && hole.right >= tiles[0].right - 1,
      spansSeveral: hole.right >= tiles[Math.min(2, tiles.length - 1)].right - 1,
      holeSane: hole.height < window.innerHeight * 0.7,
      cardOnScreen: card.left >= 0 && card.top >= 0
        && card.right <= window.innerWidth && card.bottom <= window.innerHeight,
    };
  });
  console.log('   note:', JSON.stringify(note));
  check('the Live TV note comes up', note !== null, 'no note appeared');
  if (note) {
    check('it is a single step', note.steps === 1, String(note.steps));
    check('so the button is not "Next"', note.nextLabel === 'Got it', note.nextLabel);
    check('it explains pinning', /pin/i.test(note.body), note.body);
    check('the highlight starts at the first pinned tile', note.coversFirst);
    check('and boxes the row rather than one tile', note.spansSeveral);
    check('without swallowing the page', note.holeSane);
    check('the card is on screen', note.cardOnScreen);
  }
  await page.screenshot({ path: SHOTS + '/live-note.png' });

  await page.locator('#tourNext').click();
  await wait(600);
  check('dismissing it writes it down',
    saved.some((s) => s.liveTourDone === true), 'liveTourDone never saved');

  // --- second visit is quiet ------------------------------------------------
  console.log('\n  coming back');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // The last profile is remembered, so this lands straight in the app.
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
  }
  await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
  await page.evaluate((cats) => {
    state.library.live = {
      categories: cats.map((c) => ({ id: c.category_id, name: c.category_name })),
      items: cats.map((c, i) => ({
        kind: 'live', id: 2000 + i, name: `${c.category_name} channel`,
        logo: '', categoryId: c.category_id,
      })),
    };
    location.hash = '#/live';
  }, CATS);
  await page.waitForSelector('#dkChips .catchip, #grid .cat-card', { timeout: 15000 });
  await wait(1200);
  check('the note does not come back', await page.locator('#tour').isHidden());

  const again = await page.evaluate(() => profiles.data.pinnedCategories.length);
  check('and the pins are still there', again === 6, String(again));

  // Unpinning one must stick — the seed must not run again and undo it.
  await page.evaluate(() => { profiles.togglePin('live', '20'); render(); });
  await wait(400);
  await page.evaluate(() => { location.hash = '#/movies'; });
  await wait(400);
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(900);
  const afterUnpin = await page.evaluate(() => profiles.data.pinnedCategories);
  check('unpinning a starter pin sticks',
    !afterUnpin.includes('live:20'), JSON.stringify(afterUnpin));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
