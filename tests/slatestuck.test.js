/**
 * "Reading the slate…" is a loading state, and a loading state has to end.
 *
 * "the live score feature isn't loading in games now... Now the mlb section
 *  says Reading the slate..."
 *
 * That sentence is the band's FIRST paint — the one before the box has
 * answered. It is supposed to last a moment. Two things let it last for ever:
 *
 *   THE ASK HAD NO DEADLINE. `fetch` has no timeout of its own, so a box that
 *   takes a minute and a half — which this one can, because each sport walks
 *   a chain of addresses serially and every one of them is allowed
 *   twenty-five seconds to time out — leaves the band on its first paint the
 *   whole time, saying nothing about what is happening. And because the ask
 *   is only started when none is outstanding, nothing tries again either.
 *
 *   AND THE GUIDE SAT IN FRONT OF THE REPAINT. The scores landed, then the
 *   chain went off to ask the EPG what is on those channels, and only after
 *   THAT did anything get drawn. A guide lookup that hangs held up a
 *   scoreboard that had already arrived — the answer was in the page and the
 *   page was still showing the word "Reading".
 *
 * So: the scores paint the moment they land, before the guide is asked at
 * all; and an ask still outstanding after a few seconds says so, out loud,
 * with the address that explains what the box is stuck on.
 *
 * NOT by aborting the fetch. A box that needs ninety seconds is slow, not
 * broken, and cancelling at fifteen would turn "slow" into "never".
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
  categories: [{ id: 'c1', name: 'USA SPORTS' }],
  items: [
    { kind: 'live', id: 700, num: 700, name: 'US| ESPN', categoryId: 'c1' },
    { kind: 'live', id: 701, num: 701, name: 'US| MLB NETWORK', categoryId: 'c1' },
  ],
  totals: { items: 2 },
};

/* A side is `abbr`, `score`, `record` — what a scoreboard has room for. */
const GAME = {
  id: 'mlb-1', sport: 'mlb', status: 'live', clock: 'Top 4th',
  home: { abbr: 'SEA', score: 3, record: '70-64' },
  away: { abbr: 'HOU', score: 1, record: '72-62' },
  kickoff: Math.floor(Date.now() / 1000) - 600,
};
const COLLEGE = {
  id: 'ncaaf-1', sport: 'ncaaf', status: 'live', clock: 'Q2 4:11',
  channelName: 'NBC', channelMatch: 'NBC',
  home: { abbr: 'UNC', score: 14 }, away: { abbr: 'TCU', score: 10 },
  kickoff: Math.floor(Date.now() / 1000) - 900,
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'live'
        ? LIVE : { categories: [], items: [], totals: { items: 0 } }) });
  });

  /* The box, being slow — which is what it is when an upstream is wedged and
     the chain is waiting out a twenty-five second timeout per address. It
     answers eventually. It is not broken. */
  let releaseScores;
  const scoresHeld = new Promise((r) => { releaseScores = r; });
  let scoreAsks = 0;
  await page.route('**/api/scores', async (r) => {
    scoreAsks += 1;
    if (scoreAsks === 1) await scoresHeld;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ games: [GAME, COLLEGE], at: Date.now(), feeds: [] }) });
  });

  /* And the guide, wedged for the whole run. It must not be able to hold up a
     scoreboard that has already arrived. */
  let guideAsks = 0;
  await page.route('**/api/epg/now**', async (r) => {
    guideAsks += 1;
    await new Promise(() => {}); // never
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
  }
  await wait(1800);
  await page.evaluate(() => {
    state.config.mode = 'xtream';
    location.hash = '#/live';
    state.category = null;
    render();
  });
  // Attached, not visible: the band lives in a head the page may have
  // collapsed, and what is being tested is what it SAYS.
  await page.waitForSelector('#dkScores', { state: 'attached', timeout: 10000 });

  const band = () => page.evaluate(() =>
    (document.querySelector('#dkScores')?.textContent || '').replace(/\s+/g, ' ').trim());

  console.log('\n  while the box is still thinking');
  const first = await band();
  console.log('   at once:', JSON.stringify(first.slice(0, 90)));
  check('it says it is reading the slate', /reading the slate/i.test(first), first.slice(0, 90));

  /* Long enough that somebody looking at it has decided it is broken. */
  await wait(9000);
  const later = await band();
  console.log('   nine seconds on:', JSON.stringify(later.slice(0, 200)));
  /* The bug, exactly: the same four words, for ever, with nothing said about
     why and no way to tell a slow box from a dead one. */
  check('and does not still say only that a few seconds later',
    !/^live now reading the slate/i.test(later.replace(/\s+/g, ' ').trim()),
    later.slice(0, 200));
  check('but says the box is taking its time', /still|taking|slow|waiting/i.test(later),
    later.slice(0, 200));
  /* The one address that answers "what is it stuck on", which is the whole
     reason it exists. */
  check('and where to look to find out why', /\/api\/scores/.test(later), later.slice(0, 200));

  console.log('\n  and when the box finally answers');
  releaseScores();
  await wait(1200);
  const done = await band();
  console.log('   after:', JSON.stringify(done.slice(0, 120)));
  check('the game is drawn', /SEA|HOU/.test(done), done.slice(0, 160));
  check('and the loading words are gone', !/reading the slate/i.test(done), done.slice(0, 160));

  /*
   * NOT COVERED HERE, deliberately: the guide sitting in front of the
   * repaint. `askGuide` only asks anything for COLLEGE, and reaching it needs
   * a second ask — which the band will not make for a minute. A sixty-second
   * suite to cover it would be worse than saying plainly that it is not
   * covered. The ordering is fixed in desktop.js on its own merits: the
   * scores are drawn the moment they land, and the guide is asked after,
   * where it can only ever improve a band that is already right.
   */

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
