/**
 * Two things that were getting in the way rather than helping.
 *
 * "The 'This keeps stopping to buffer' pops up when I'm scrolling through
 * videos and it isn't actually buffering." Every seek raises a `waiting`, and
 * the offer counted them for the whole session — so opening four things, or
 * scrubbing four times, was indistinguishable from four buffer stalls.
 *
 * "On the continue watching page add an X to remove it from my recently
 * watched, but not that removes it from my library." A film somebody sat
 * through ten minutes of sits at the front of the house for weeks otherwise.
 */
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ROWS = [
  { key: 'movie:1', kind: 'movie', id: 1, name: 'Half Watched', poster: '',
    position: 600, duration: 7200, at: Date.now() },
  { key: 'movie:2', kind: 'movie', id: 2, name: 'Also Started', poster: '',
    position: 300, duration: 5400, at: Date.now() - 1000 },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ recentlyWatched: [], categoryAffinity: [], ratings: {} }) }));

  const deleted = [];
  let refuse = false;
  await page.route('**/api/profiles/*/history*', (r) => {
    if (r.request().method() !== 'DELETE') return r.continue();
    const key = new URL(r.request().url()).searchParams.get('key');
    if (refuse) {
      return r.fulfill({ status: 500, contentType: 'application/json',
        body: '{"error":"the drive is read-only"}' });
    }
    deleted.push(key);
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"removed":1}' });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  // Home first, THEN the rows: navigating there reloads history from the
  // profile and would wipe anything planted beforehand.
  const plant = async (rows) => {
    await page.evaluate(() => { location.hash = '#/home'; });
    await wait(700);
    await page.evaluate((r) => {
      state.recentlyWatched = r.map((row) => ({ ...row }));
      renderHome();
      document.querySelector('#toast').hidden = true;
    }, rows);
    await wait(200);
  };

  /* ---- the X ------------------------------------------------------------ */
  console.log('\n  taking something off Continue watching');
  await plant(ROWS);
  // The pointer is left wherever the profile tile was, which is over the hero
  // card — and this next check is about what happens when it is NOT.
  await page.mouse.move(5, 5);
  await wait(200);
  const before = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#homeView .home-recent .card-title')]
      .map((t) => t.textContent),
    drops: document.querySelectorAll('#homeView .home-drop').length,
    hidden: getComputedStyle(document.querySelector('#homeView .home-drop')).opacity,
  }));
  console.log('   ', JSON.stringify(before));
  check('every card on the row has one', before.drops === before.cards.length,
    JSON.stringify(before));
  check('and it waits for the pointer rather than sitting on the poster',
    before.hidden === '0', before.hidden);
  check('with the favourites below left alone',
    (await page.evaluate(() =>
      document.querySelectorAll('#homeView .home-favs .home-drop').length)) === 0);

  await page.evaluate(() => document.querySelector('#homeView .home-drop').click());
  await wait(700);
  const after = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#homeView .home-recent .card-title')]
      .map((t) => t.textContent),
    toast: document.querySelector('#toast').hidden
      ? '' : document.querySelector('#toast').textContent,
    hash: location.hash,
  }));
  console.log('   ', JSON.stringify(after));
  check('pressing it takes that one off', !after.cards.includes('Half Watched'),
    JSON.stringify(after.cards));
  check('and leaves the others', after.cards.includes('Also Started'),
    JSON.stringify(after.cards));
  check('the box is told which one to forget', deleted[0] === 'movie:1',
    JSON.stringify(deleted));
  check('it does not open the film it was sitting on', after.hash === '#/home',
    after.hash);
  check('and it says plainly that the title itself is untouched',
    /still in your library/.test(after.toast), after.toast);

  /* ---- and it is history, not the library ------------------------------- */
  //
  // The distinction the request turns on. Forgetting that something was
  // watched must not hide it — that is a different decision, and it lives
  // behind Deleted in the sidebar with its own way back.
  console.log('\n  and the title is still there');
  const src = fs.readFileSync(PATHS.APP, 'utf8');
  check('nothing about removing marks the title deleted',
    !/forgetWatched[\s\S]{0,900}?(markDeleted|isDeleted|toggleDeleted)/.test(src));
  const still = await page.evaluate(() => {
    state.library.movies = { categories: [], items: [
      { kind: 'movie', id: 1, name: 'Half Watched', categoryId: 'c1' }] };
    return { inLibrary: state.library.movies.items.some((i) => i.id === 1),
      hidden: profiles.isDeleted({ kind: 'movie', id: 1 }) };
  });
  console.log('   ', JSON.stringify(still));
  check('it is still in the library', still.inLibrary, JSON.stringify(still));
  check('and not marked hidden', still.hidden === false, JSON.stringify(still));

  /* ---- a refusal puts the card back ------------------------------------- */
  console.log('\n  when the box says no');
  refuse = true;
  await plant(ROWS);
  await page.evaluate(() => document.querySelector('#homeView .home-drop').click());
  await wait(700);
  const back = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#homeView .home-recent .card-title')]
      .map((t) => t.textContent),
    toast: document.querySelector('#toast').hidden
      ? '' : document.querySelector('#toast').textContent,
  }));
  console.log('   ', JSON.stringify(back));
  check('the card comes back rather than returning on the next reload',
    back.cards.includes('Half Watched'), JSON.stringify(back.cards));
  check('with the reason', /read-only/.test(back.toast), back.toast);
  refuse = false;

  /* ---- the buffering offer ---------------------------------------------- */
  //
  // A `waiting` while paused or seeking is not a stall. Four of those used to
  // be a verdict on somebody's wifi.
  console.log('\n  what counts as a stall');
  const offer = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    document.querySelector('#playerOverlay').hidden = false;
    document.querySelector('#toast').hidden = true;
    lowOffered = false;
    stallsAt = [];

    // Four waits raised while seeking — which is what scrolling through
    // titles and scrubbing produce, and what used to trip this.
    Object.defineProperty(video, 'seeking', { value: true, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    for (let i = 0; i < 6; i += 1) video.dispatchEvent(new Event('waiting'));
    const whileSeeking = { counted: stallsAt.length,
      toast: document.querySelector('#toast').hidden ? '' : 'shown' };

    // Four real ones, but on a link that is keeping up.
    Object.defineProperty(video, 'seeking', { value: false, configurable: true });
    playback.samples = [];
    playback.history = [];
    for (let i = 0; i < 6; i += 1) video.dispatchEvent(new Event('waiting'));
    const healthy = { counted: stallsAt.length,
      toast: document.querySelector('#toast').hidden ? '' : 'shown' };

    // And the real thing: stalls AND a clock that has fallen behind.
    const now = performance.now();
    playback.samples = [{ at: now - 10000, t: 100, f: 0 }, { at: now, t: 105, f: 0 }];
    video.dispatchEvent(new Event('waiting'));
    const struggling = { toast: document.querySelector('#toast').hidden
      ? '' : document.querySelector('#toast').textContent };

    document.querySelector('#playerOverlay').hidden = true;
    return { whileSeeking, healthy, struggling };
  });
  console.log('   ', JSON.stringify(offer));
  check('waits raised while seeking are not stalls at all',
    offer.whileSeeking.counted === 0 && offer.whileSeeking.toast === '',
    JSON.stringify(offer.whileSeeking));
  check('real waits are counted', offer.healthy.counted >= 4,
    JSON.stringify(offer.healthy));
  check('but a link that is keeping up is not accused of anything',
    offer.healthy.toast === '', JSON.stringify(offer.healthy));
  check('while stalls AND a clock behind do raise the offer',
    /keeps stopping to buffer/.test(offer.struggling.toast), offer.struggling.toast);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
