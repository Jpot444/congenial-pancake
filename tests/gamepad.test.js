/**
 * The television build, driven by a controller.
 *
 * "how can i use the player on an xbox" → "add the gamepad support and the
 *  television build to a new link that is https://tv.treasurestatecapital.com/tv"
 *
 * Two things, and the first is the one that would have wasted an evening.
 *
 * THE LINK. `/tv` already answered 200, which is worse than a 404 would have
 * been: the right HTML served at the wrong base. A browser resolves a relative
 * `css/tokens.css` against the directory of the current URL, and the directory
 * of `/tv` is `/`. Measured on the shipped build —
 *
 *   /tv                 200
 *   /css/tokens.css     404   <- what /tv then asks for
 *   /tv/css/tokens.css  200
 *
 * — so the page arrived unstyled with no script at all, which on a television
 * reads as a broken box rather than a mistyped address. One redirect fixes
 * every relative path at once.
 *
 * THE CONTROLLER. This app was written for a Shield remote, so it listens for
 * arrow keys, Enter and Escape. On an Xbox that works only in Edge's d-pad
 * mode, and Edge opens in CURSOR mode where the left stick drives a pointer
 * and the app receives nothing whatever. The Gamepad API reports the pad in
 * either mode, so it is read directly and turned into the same key names the
 * app already handles.
 *
 * DRIVEN THROUGH A SYNTHETIC PAD. There is no controller on a test box, and
 * what is under test is the mapping and the repeat behaviour — not whether
 * Chromium can talk to USB.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const LIVE = {
  categories: [{ id: 'c1', name: 'US| SPORTS' }],
  items: [1, 2, 3, 4, 5, 6].map((i) => ({
    kind: 'live', id: 100 + i, num: 100 + i, name: `US| CHANNEL ${i}`,
    logo: '', categoryId: 'c1',
  })),
  totals: { items: 6 },
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/scores**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"channels":[],"busy":false}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"continueWatching":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/profiles', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"profiles":[{"id":"own1","name":"Hunter","emoji":"","color":""}],'
        + '"current":"own1","rev":1}' }));
  await page.route('**/api/profiles/own1/prefs*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"tourDone":true,"liveTourDone":true,"scoreSport":"mlb","favorites":[],'
        + '"pinnedCategories":[],"deletedItems":[],"deletedCategories":[]}' }));

  /* ---- the link ---------------------------------------------------------- */
  /*
   * Asked of the box the way a television asks: follow the redirect and see
   * whether the page that lands can load its own stylesheet.
   */
  console.log('\n  the address somebody types');
  const bare = await page.request.get(`${BASE}/tv`, { maxRedirects: 0 });
  console.log('   /tv →', bare.status(), bare.headers().location || '');
  check('/tv is a redirect, not a page served at the wrong base',
    bare.status() === 301, String(bare.status()));
  check('and it points at the directory it meant',
    bare.headers().location === '/tv/', String(bare.headers().location));
  /* A link with a query on it must survive the bounce. */
  const query = await page.request.get(`${BASE}/tv?from=xbox`, { maxRedirects: 0 });
  check('carrying any query with it',
    query.headers().location === '/tv/?from=xbox', String(query.headers().location));
  /* And the thing the redirect exists for: the relative asset the page asks
     for next. At `/tv` the browser would have asked for `/css/tokens.css`. */
  const atRoot = await page.request.get(`${BASE}/css/tokens.css`);
  const atTv = await page.request.get(`${BASE}/tv/css/tokens.css`);
  console.log('   /css/tokens.css', atRoot.status(), '· /tv/css/tokens.css', atTv.status());
  check('which is what makes the difference — the stylesheet is only under /tv/',
    atRoot.status() === 404 && atTv.status() === 200,
    `${atRoot.status()} / ${atTv.status()}`);

  /* ---- a pad that is not there ------------------------------------------ */
  /*
   * Installed before the app boots, because watchGamepad reads it on the way
   * up. An empty list is the ordinary case — a Shield with a remote — and it
   * must cost nothing and raise nothing.
   */
  await page.addInitScript(() => {
    window.__pad = {
      connected: true,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
      index: 0,
      mapping: 'standard',
    };
    window.__padOn = false;
    navigator.getGamepads = () => (window.__padOn ? [window.__pad] : []);
  });

  await page.goto(`${BASE}/tv/`);
  await page.waitForSelector('[data-kind="chan"]', { timeout: 15000 });
  await wait(600);

  /* Read off the DOM and nothing else. The app's modules are not reachable
     from here — it is an ES module with nothing hung on `window` — and that is
     the right constraint anyway: every claim below is about what somebody
     holding the pad can see. Focus is the `.f` class; the screen is whichever
     nav pill is `.active`. */
  const where = () => page.evaluate(() => {
    const node = document.querySelector('[data-r].f');
    return node ? `${node.dataset.r},${node.dataset.c}` : null;
  });
  const screenNow = () => page.evaluate(() =>
    document.querySelector('#nav [data-screen].active')?.dataset.screen || null);
  /* Moving the cursor without the pad, to set a case up. The nav pills are
     real anchors, and a click is how a pointer reaches one. */
  const clickNav = (name) => page.evaluate((n) =>
    document.querySelector(`#nav [data-screen="${n}"]`)?.click(), name);

  /** Hold a button for a while, then let go. */
  const hold = async (index, ms) => {
    await page.evaluate((i) => {
      window.__padOn = true;
      window.__pad.buttons[i] = { pressed: true, value: 1 };
      window.dispatchEvent(new Event('gamepadconnected'));
    }, index);
    await wait(ms);
    await page.evaluate((i) => { window.__pad.buttons[i] = { pressed: false, value: 0 }; }, index);
    await wait(120);
  };

  console.log('\n  before anything is pressed');
  const start = await where();
  console.log('   focus at', start);
  check('the app is up and something has focus', start !== null, String(start));

  /* ---- one press, one move ---------------------------------------------- */
  /*
   * The first thing anybody does. A push of the d-pad moves exactly one place
   * — not two, and not none.
   */
  console.log('\n  one push of the d-pad');
  await hold(15, 90);            // right, released well inside the first repeat
  const moved = await where();
  console.log('   focus at', moved);
  check('the focus moved', moved !== start, `${start} → ${moved}`);
  const [r0, c0] = String(start).split(',').map(Number);
  const [r1, c1] = String(moved).split(',').map(Number);
  check('by exactly one place, not two', r1 === r0 && c1 === c0 + 1,
    `${start} → ${moved}`);

  /* ---- held, it walks --------------------------------------------------- */
  /*
   * A direction held down has to repeat or a long row is unusable — but it
   * must not repeat every frame, which at 60fps would cross the screen before
   * anybody let go.
   */
  console.log('\n  and held down');
  const before = (await where()).split(',').map(Number);
  await hold(15, 1000);
  const after = (await where()).split(',').map(Number);
  const steps = after[1] - before[1];
  console.log(`   walked ${steps} places in a second`);
  check('it repeats rather than stopping after one', steps >= 2, String(steps));
  /* 420ms to the first repeat and 110ms after it is about six in a second;
     per-frame would be sixty. The ceiling is what is being claimed. */
  check('at a readable speed, not once a frame', steps <= 10, String(steps));

  /* ---- the left stick --------------------------------------------------- */
  console.log('\n  the left stick');
  const stickFrom = (await where()).split(',').map(Number);
  await page.evaluate(() => { window.__pad.axes = [-1, 0]; });
  await wait(120);
  await page.evaluate(() => { window.__pad.axes = [0, 0]; });
  await wait(150);
  const stickTo = (await where()).split(',').map(Number);
  console.log(`   ${stickFrom} → ${stickTo}`);
  check('moves the focus the same way the d-pad does',
    stickTo[1] === stickFrom[1] - 1, `${stickFrom} → ${stickTo}`);

  /* A resting stick reads a little off centre on a real pad, and a drifting
     one would walk the focus on its own all evening. */
  console.log('\n  and a stick at rest');
  const restFrom = await where();
  await page.evaluate(() => { window.__pad.axes = [0.25, -0.2]; });
  await wait(700);
  await page.evaluate(() => { window.__pad.axes = [0, 0]; });
  const restTo = await where();
  check('drift does not move anything', restFrom === restTo, `${restFrom} → ${restTo}`);

  /* ---- A opens, B goes back --------------------------------------------- */
  console.log('\n  A and B');
  /* Onto the nav row, where OK changes screen — an outcome this suite can see
     without opening a stream. Clicked rather than pressed, because putting the
     cursor somewhere is the setup and not the thing under test. */
  await clickNav('movies');
  await wait(200);
  const parked = await where();
  console.log('   focus parked at', parked, '· screen', await screenNow());
  await hold(0, 90);                                  // A
  await wait(900);
  const screen = await screenNow();
  console.log('   screen is now', screen);
  check('A activates what is focused', screen === 'movies', String(screen));

  await hold(1, 90);                                  // B
  await wait(900);
  const back = await screenNow();
  console.log('   screen is now', back);
  check('B goes back', back === 'live', String(back));

  /* ---- and the double that Edge would have caused ----------------------- */
  /*
   * In Edge's d-pad mode the pad ALREADY arrives as arrow keys and Enter, and
   * the Gamepad API reports the same press at the same moment. Unguarded, one
   * push of a direction moves two cards and one push of A opens a channel
   * twice. Whichever arrives first wins; the other is dropped.
   */
  console.log('\n  and a press that arrives twice, as Edge sends it');
  await wait(200);
  const twiceFrom = (await where()).split(',').map(Number);
  await page.evaluate(() => {
    /* The keyboard copy and the pad copy, in the same tick — which is what
       Edge in d-pad mode actually produces. */
    window.__padOn = true;
    window.__pad.buttons[15] = { pressed: true, value: 1 };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await wait(200);
  await page.evaluate(() => { window.__pad.buttons[15] = { pressed: false, value: 0 }; });
  await wait(200);
  const twiceTo = (await where()).split(',').map(Number);
  console.log(`   ${twiceFrom} → ${twiceTo}`);
  check('it counts as one press, not two',
    twiceTo[1] === twiceFrom[1] + 1, `${twiceFrom} → ${twiceTo}`);

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
