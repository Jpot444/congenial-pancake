/**
 * A new profile gets a home page with something on it.
 *
 * "when new profiles are created, after the walkthrough tour, I want it to ask
 *  a few channels, movies, shows, so that there homepage wont be blank when
 *  they first join"
 *
 * The walkthrough ended by describing a page built out of favourites and
 * half-watched things — to somebody who had neither. It pointed at a rail of
 * nothing and said "your favourite channels live here". That page was a
 * correct rendering of an empty profile, which is the least useful thing a
 * first screen can be.
 *
 * So three passes straight after the tour: channels, films, shows. A tap is an
 * ordinary favourite, which is exactly what the home page reads — no second
 * kind of state to keep in step with anything.
 *
 * TWO THINGS THIS SUITE IS REALLY ABOUT, because the sheet itself is easy:
 *
 *   WHICH CHANNELS ARE OFFERED. A provider's live list is twelve thousand
 *   rows and most of them are nobody's answer — regional feeds, numbered PPV
 *   slots, 24/7 loops. Offering the first eighteen would be offering eighteen
 *   strangers, so it asks for named networks, whole tokens only: NBC is inside
 *   CNBC, ESPN is inside ESPNU, and the scoreboard matcher already learned
 *   that one the hard way.
 *
 *   AND THAT THE FLAG SURVIVES A WRITE. `startersDone` has to pass the
 *   server's whitelist in BOTH directions or the sheet comes back every time
 *   the profile loads — the same trap `format` fell into on the recordings
 *   store, where a field the client sent was silently dropped and nothing
 *   looked wrong until a restart.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const artwork = (w, h, hue) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
  + `<rect width="${w}" height="${h}" fill="hsl(${hue},45%,28%)"/></svg>`);

/* Real network names, in the shapes a provider actually writes them — and the
   two traps beside them: CNBC, which contains NBC, and ESPNU, which contains
   ESPN. Both must lose to the plain network. */
const NETWORKS = ['ESPN', 'FOX SPORTS 1', 'NFL NETWORK', 'TNT', 'TBS', 'USA',
  'AMC', 'FX', 'HBO', 'CNN', 'FOX NEWS', 'ABC', 'CBS', 'NBC', 'BRAVO',
  'DISCOVERY', 'HISTORY', 'HGTV', 'SYFY', 'TLC'];

const LIVE = {
  categories: [{ id: 'c1', name: 'USA SPORTS' }],
  items: [
    ...NETWORKS.map((name, i) => ({
      kind: 'live', id: 100 + i, num: 100 + i, name: `US| ${name} HD`,
      logo: artwork(800, 400, i * 13), categoryId: 'c1',
    })),
    /* The near-misses. */
    { kind: 'live', id: 90, num: 90, name: 'US| CNBC HD', logo: '', categoryId: 'c1' },
    { kind: 'live', id: 91, num: 91, name: 'US| ESPNU HD', logo: '', categoryId: 'c1' },
    { kind: 'live', id: 92, num: 92, name: 'US| ESPNEWS HD', logo: '', categoryId: 'c1' },
    /* And the noise, which is most of a real list. */
    ...Array.from({ length: 40 }, (_, i) => ({
      kind: 'live', id: 300 + i, num: 300 + i,
      name: `US| PPV ${i} 24/7`, logo: '', categoryId: 'c1',
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      kind: 'live', id: 400 + i, num: 400 + i,
      name: `EVENT 12.${10 + i}.2026 SOMETHING`, logo: '', categoryId: 'c1',
    })),
  ],
};
LIVE.totals = { items: LIVE.items.length };

/* `added` descending is the only ranking a profile with no taste has, so the
   fixture numbers it deliberately: Film Number 1 is the newest. */
const titles = (kind, n, hue) => Array.from({ length: n }, (_, i) => ({
  kind,
  id: (kind === 'movie' ? 500 : 800) + i,
  name: `${kind === 'movie' ? 'Film' : 'Show'} Number ${i + 1}`,
  logo: artwork(600, 900, hue + i * 9),
  categoryId: 'g1',
  added: 1000 - i,
}));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    const body = tab === 'live' ? LIVE
      : tab === 'movies'
        ? { categories: [{ id: 'g1', name: 'New' }], items: titles('movie', 30, 10),
          totals: { items: 30 } }
        : { categories: [{ id: 'g1', name: 'New' }], items: titles('series', 30, 200),
          totals: { items: 30 } };
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(body) });
  });
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"channels":[],"busy":false}' }));
  await page.route('**/api/scores**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"games":[],"feeds":[]}' }));

  /* What the box was actually told to remember. The whole second half of this
     suite is about whether the flag makes it through. */
  const written = [];
  await page.route('**/api/profiles/*/prefs', async (r) => {
    if (r.request().method() === 'PUT') {
      try { written.push(JSON.parse(r.request().postData() || '{}')); } catch { /* not ours */ }
    }
    return r.continue();
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wait(1500);
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1600);
  }

  /* A new profile, at the moment the tour ends. Driven through `tour.finish`
     rather than by calling the sheet directly, because "after the walkthrough
     tour" is the requirement and a suite that opened the sheet by hand would
     pass on a build where nothing ever opened it. */
  await page.evaluate(() => {
    state.config.mode = 'xtream';
    profiles.data.startersDone = false;
    profiles.data.favorites = [];
    document.querySelector('#tour').hidden = false;
    tour.finish();
  });
  await wait(1800);

  const read = () => page.evaluate(() => ({
    up: !document.querySelector('#starter').hidden,
    step: document.querySelector('#starterStep').textContent,
    title: document.querySelector('#starterTitle').textContent,
    button: document.querySelector('#starterNext').textContent,
    tiles: [...document.querySelectorAll('.starter-name')].map((n) => n.textContent),
    count: document.querySelector('#starterCount').textContent,
    wide: document.querySelector('#starterGrid').classList.contains('is-wide'),
    tourUp: !document.querySelector('#tour').hidden,
  }));

  /* ---- it arrives, and only after the tour ------------------------------ */
  console.log('\n  the moment the walkthrough ends');
  const first = await read();
  console.log('   ', JSON.stringify({ ...first, tiles: first.tiles.slice(0, 6) }));
  check('the sheet comes up', first.up === true, JSON.stringify(first));
  check('and not over the tour it follows', first.tourUp === false);
  check('starting with channels', first.title === 'Pick a few channels', first.title);
  check('and says how far in it is', first.step === 'Step 1 of 3', first.step);

  /* ---- which channels ---------------------------------------------------- */
  console.log('\n  what it offers');
  check('eighteen of them, not the whole provider',
    first.tiles.length === 18, String(first.tiles.length));
  /* Named networks, in the order the list names them — which is roughly the
     order somebody would think of them. */
  check('the first is a network anybody would recognise',
    first.tiles[0] === 'ESPN HD', first.tiles[0]);
  /* THE TRAP. A substring test offers CNBC for NBC and ESPNU for ESPN, and
     the shortest-name tie-break then prefers the wrong one — which is exactly
     how a USC game on NBC ended up matched to CNBC. */
  check('and nothing that merely contains one',
    !first.tiles.some((t) => /CNBC|ESPNU|ESPNEWS/.test(t)), JSON.stringify(first.tiles));
  check('NBC itself is still offered', first.tiles.includes('NBC HD'),
    JSON.stringify(first.tiles));
  /* The noise. A 24/7 loop or a dated event is a row that will not exist next
     week, and starring one is starring nothing. */
  check('no 24/7 loops and no dated events',
    !first.tiles.some((t) => /24\/7|PPV|2026/.test(t)), JSON.stringify(first.tiles));
  check('channels get the wide plate, not a poster box', first.wide === true);

  /* ---- picking ----------------------------------------------------------- */
  console.log('\n  picking three');
  await page.evaluate(() => {
    [...document.querySelectorAll('.starter-tile')].slice(0, 3).forEach((t) => t.click());
  });
  await wait(200);
  const picked = await page.evaluate(() => ({
    count: document.querySelector('#starterCount').textContent,
    marked: document.querySelectorAll('.starter-tile.is-on').length,
    /* Nothing is written until the end — eighteen taps must not be eighteen
       round trips to the box. */
    favs: (profiles.data.favorites || []).length,
  }));
  console.log('   ', JSON.stringify(picked));
  check('it says how many are picked', picked.count === '3 picked', picked.count);
  check('and marks them', picked.marked === 3, String(picked.marked));
  check('but writes nothing yet', picked.favs === 0, String(picked.favs));

  /* ---- the other two passes ---------------------------------------------- */
  console.log('\n  and on through films and shows');
  await page.click('#starterNext');
  await wait(1400);
  const films = await read();
  console.log('   ', JSON.stringify({ ...films, tiles: films.tiles.slice(0, 4) }));
  check('films are next', films.title === 'And a few films', films.title);
  check('newest first, which is the only ranking a new profile has',
    films.tiles[0] === 'Film Number 1', films.tiles[0]);
  check('they get poster boxes', films.wide === false);
  /* Carried across the step — the count is about the whole sheet, not the
     page you happen to be on. */
  check('and the three channels are still counted', films.count === '3 picked', films.count);

  await page.evaluate(() => {
    [...document.querySelectorAll('.starter-tile')].slice(0, 2).forEach((t) => t.click());
  });
  await page.click('#starterNext');
  await wait(1400);
  const shows = await read();
  console.log('   ', JSON.stringify({ ...shows, tiles: shows.tiles.slice(0, 3) }));
  check('then shows', shows.title === 'And a few shows', shows.title);
  check('and the last step offers to finish rather than to carry on',
    shows.button === 'Done', shows.button);

  await page.evaluate(() => {
    [...document.querySelectorAll('.starter-tile')].slice(0, 2).forEach((t) => t.click());
  });
  await page.click('#starterNext');
  await wait(2200);

  /* ---- the page it was all for ------------------------------------------- */
  console.log('\n  the home page afterwards');
  const after = await page.evaluate(() => ({
    up: !document.querySelector('#starter').hidden,
    favs: (profiles.data.favorites || []).map((f) => f.item.name),
    done: profiles.data.startersDone === true,
    guideRows: document.querySelectorAll('.home-guide .guide-row').length,
    favCards: document.querySelectorAll('.home-favs .card').length,
    empty: document.querySelector('#emptyState').hidden
      ? '' : document.querySelector('#emptyState').textContent,
  }));
  console.log('   ', JSON.stringify(after));
  check('the sheet closes', after.up === false);
  check('all seven picks are favourites now', after.favs.length === 7,
    JSON.stringify(after.favs));
  /* THE WHOLE REQUEST, said as what is on the screen. */
  check('the home page has the channels on it as listings',
    after.guideRows === 3, String(after.guideRows));
  check('and the films and shows as cards', after.favCards === 4, String(after.favCards));
  check('so it does not claim to be empty', after.empty === '', after.empty);

  /* ---- and it does not come back ----------------------------------------- */
  /*
   * `startersDone` has to pass the server's whitelist in both directions. A
   * field the client sends and the box quietly drops looks perfectly fine
   * until the next load, and then the sheet is back — which is the most
   * annoying possible way for this to fail.
   */
  console.log('\n  and it is remembered');
  const sent = written.some((body) => body.startersDone === true);
  check('the box was told', sent, JSON.stringify(written.map((b) => b.startersDone)));

  const id = await page.evaluate(() => profiles.current.id);
  const back = await page.evaluate(async (who) =>
    (await (await fetch(`/api/profiles/${who}/prefs`)).json()).startersDone, id);
  console.log('    read back:', JSON.stringify(back));
  check('and says so when asked again — the field is not dropped on the way in',
    back === true, JSON.stringify(back));

  /* And the sheet stays shut on the next visit. */
  await page.evaluate(() => { starter.maybeStart(); });
  await wait(500);
  check('so it does not ask a second time',
    (await page.evaluate(() => document.querySelector('#starter').hidden)) === true);

  /* ---- skipping counts as being asked ------------------------------------ */
  /*
   * Somebody who would rather go and find their own things should not be
   * handed this sheet again tomorrow — so Skip writes the flag exactly as
   * Done does. It is the same call; what would break it is a Skip wired
   * straight to `hidden = true`.
   */
  console.log('\n  and skipping it counts');
  await page.evaluate(() => {
    profiles.data.startersDone = false;
    profiles.data.favorites = [];
    starter.maybeStart();
  });
  await wait(1500);
  check('it opens again once the flag is cleared',
    (await page.evaluate(() => document.querySelector('#starter').hidden)) === false);
  await page.click('#starterSkip');
  await wait(900);
  const skipped = await page.evaluate(() => ({
    up: !document.querySelector('#starter').hidden,
    done: profiles.data.startersDone === true,
    favs: (profiles.data.favorites || []).length,
  }));
  console.log('   ', JSON.stringify(skipped));
  check('skip closes it', skipped.up === false, JSON.stringify(skipped));
  check('and still counts as having been asked', skipped.done === true,
    JSON.stringify(skipped));
  check('without starring anything nobody chose', skipped.favs === 0,
    String(skipped.favs));

  /* ---- one overlay at a time -------------------------------------------- */
  /*
   * A profile can be owed both the one-time notice and the picks — Dad,
   * signing in for the first time on a box that has been running a while. Two
   * overlays opening together means the second covers the first and the one
   * underneath is dismissed by a press nobody aimed at it. Whichever is up
   * hands over when it closes, the same chain the tour uses.
   */
  console.log('\n  when a one-time notice is owed as well');
  await page.evaluate(() => {
    profiles.data.startersDone = false;
    profiles.data.favorites = [];
    profiles.data.reportNoticeSeen = false;
    notice.maybeShow();
    starter.maybeStart();
  });
  await wait(900);
  const both = await page.evaluate(() => ({
    notice: !document.querySelector('#noticeModal').hidden,
    sheet: !document.querySelector('#starter').hidden,
  }));
  console.log('   ', JSON.stringify(both));
  check('the notice is what is on screen', both.notice === true, JSON.stringify(both));
  check('and the sheet waits its turn rather than covering it',
    both.sheet === false, JSON.stringify(both));

  await page.click('#noticeClose');
  await wait(1500);
  const handed = await page.evaluate(() => ({
    notice: !document.querySelector('#noticeModal').hidden,
    sheet: !document.querySelector('#starter').hidden,
  }));
  console.log('   ', JSON.stringify(handed));
  check('closing the notice hands over to it',
    handed.notice === false && handed.sheet === true, JSON.stringify(handed));
  await page.click('#starterSkip');
  await wait(600);

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
