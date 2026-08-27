/**
 * The next-episode wiring: does playing an episode queue the right one behind
 * it, and does the button start it?
 *
 * A stubbed provider, but the real renderSeries / startEpisode / upNext path —
 * including the season boundary, which is where a next-episode feature is most
 * likely to be quietly wrong. Driven from the show's own card, which is where
 * episodes are picked now; the card's own layout and routing are covered by
 * showcard.test.js.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const EPISODES = {
  1: [
    { id: 101, episode_num: 1, title: 'Pilot', container_extension: 'mp4', info: { duration: '00:22:00' } },
    { id: 102, episode_num: 2, title: 'Second', container_extension: 'mp4', info: { duration: '00:22:00' } },
  ],
  2: [
    { id: 201, episode_num: 1, title: 'Season Two Opener', container_extension: 'mp4', info: { duration: '00:22:00' } },
  ],
};

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  // Empty history, deliberately. This suite PLAYS episodes, so a previous run
  // leaves S2E1 recorded against show 77 — and the card then opens on the
  // last-watched season, which has one episode, and the count below reads 1.
  // Passing only on the first run of the day is not passing.
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_series_info') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {}, episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  await page.evaluate(() => {
    state.library.series = {
      categories: [{ id: 'c1', name: 'Drama' }],
      items: [{ kind: 'series', id: 77, name: 'A Show', logo: '', categoryId: 'c1' }],
    };
    location.hash = '#/series/77';
  });
  // Waiting for the LIST, not the first row of it. The show card resolves
  // its title asynchronously now, so a wait that stops at one `.ep` catches
  // the render mid-flight and counts whatever happens to be there.
  await page.waitForFunction(
    () => document.querySelectorAll('.show-card .ep').length >= 2, null,
    { timeout: 10000 });
  const rows = await page.locator('.show-card .ep').count();
  check('the episode list rendered', rows === 2, `${rows} rows`);

  const label = () => page.evaluate(() => upNext.candidate?.label ?? null);

  // --- first episode queues the second ---------------------------------
  // Clicked through the DOM: once something is playing the card is behind the
  // player, which is exactly why this button needs to exist.
  const clickEp = (i) => page.evaluate(
    (n) => document.querySelectorAll('.show-card .ep')[n].click(), i);

  await clickEp(0);
  await wait(3000);
  check('playing E1 queues E2', (await label()) === 'S1 · E2 — Second', String(await label()));
  check('nothing is offered yet', await page.locator('#upNext').isHidden());

  // --- last of the season rolls into the next --------------------------
  await clickEp(1);
  await wait(3000);
  check('the last episode of a season rolls into the next season',
    (await label()) === 'S2 · E1 — Season Two Opener', String(await label()));

  // --- pressing it actually starts that episode ------------------------
  await page.evaluate(() => upNext.reveal());
  check('the card names it', (await page.locator('#upNextTitle').textContent())
    .includes('Season Two Opener'));
  await page.locator('#upNextGo').click();
  await wait(3000);

  const after = await page.evaluate(() => ({
    sub: document.querySelector('#cinemaSub').textContent,
    season: currentSeason?.season ?? null,
    playing: [...document.querySelectorAll('.show-card .ep')].findIndex((r) =>
      r.classList.contains('is-playing')),
    queued: upNext.candidate?.label ?? null,
    src: document.querySelector('#video').currentSrc,
  }));
  console.log('   after pressing:', JSON.stringify(after));
  check('it switched to the new season', after.season === '2', JSON.stringify(after));
  check('the title line follows it', /S2 · E1/.test(after.sub), after.sub);
  check('the new episode is marked as playing', after.playing === 0, JSON.stringify(after));
  check('the last episode of the last season queues nothing', after.queued === null,
    String(after.queued));
  check('and it is really playing', after.src.includes('fake-stream'), after.src);

  // --- dismissing sticks for the episode -------------------------------
  await clickEp(0);   // the S2 list has one row; re-pick it
  await wait(2500);
  await page.evaluate(() => {
    upNext.arm({ label: 'S9 · E9 — Anything', start: () => {} });
    upNext.reveal();
  });
  await page.locator('#upNextDismiss').click();
  await page.evaluate(() => upNext.reveal());
  check('dismissing it keeps it dismissed', await page.locator('#upNext').isHidden());

  // --- closing the player forgets the queue ----------------------------
  await page.evaluate(() => closePlayer());
  check('closing the player clears what was queued',
    (await page.evaluate(() => upNext.candidate)) === null);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
