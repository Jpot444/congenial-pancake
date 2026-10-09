/**
 * /tv opens on its start screen, not on a blank page.
 *
 * "accessing https://tv.treasurestatecapital.com/tv/ shows a blank screen at
 *  first and then things load after a few seconds, I would rather have the
 *  start screen than a blank page at first"
 *
 * Two causes, both checked here under the conditions that produced them — a
 * slow CDN and a box that takes a moment to answer:
 *
 *   hls.js and mpegts.js were plain <script> tags in the <head>, so NOTHING
 *   was drawn until both had come from the CDN. They are deferred now.
 *
 *   And there was nothing to draw until the app had the profile and the first
 *   screen's data. The start screen is in the page itself now, with its own
 *   inline styles, and comes down once the first screen has drawn.
 */
const { chromium } = require('./playwright.js');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const LIVE = {
  categories: [{ id: 'c1', name: 'US| SPORTS' }],
  items: [1, 2, 3].map((i) => ({ kind: 'live', id: 100 + i, num: 100 + i,
    name: `US| CHANNEL ${i}`, logo: '', categoryId: 'c1' })),
  totals: { items: 3 },
};

async function stubBox(page, { cdnMs = 3000, profilesMs = 1500, profilesFail = false } = {}) {
  /* The CDN, slow — the condition that held the old page blank. */
  await page.route('**/cdn.jsdelivr.net/**', async (r) => {
    await wait(cdnMs);
    r.fulfill({ status: 200, contentType: 'application/javascript', body: '/* stand-in */' });
  });
  const json = (body, ms = 0) => async (r) => {
    if (ms) await wait(ms);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route('**/api/profiles', async (r) => {
    await wait(profilesMs);
    if (profilesFail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"The box is not reachable."}' });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"profiles":[{"id":"own1","name":"Hunter","emoji":"","color":""}],"current":"own1","rev":1}' });
  });
  await page.route('**/api/profiles/own1/prefs*', json({ tourDone: true, liveTourDone: true,
    scoreSport: 'mlb', favorites: [], pinnedCategories: [], deletedItems: [], deletedCategories: [] }));
  await page.route('**/api/profiles/*/taste', json({ recentlyWatched: [], continueWatching: [],
    categoryAffinity: [], ratings: {} }));
  await page.route('**/api/library**', json(LIVE, 500));
  await page.route('**/api/epg/now**', json({ channels: [], busy: false }));
  await page.route('**/api/scores**', json({ games: [], feeds: [] }));
}

const boot = (page) => page.evaluate(() => {
  const b = document.getElementById('boot');
  if (!b) return { present: false };
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  const img = b.querySelector('img');
  return {
    present: true,
    covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1,
    visible: cs.opacity === '1' && cs.display !== 'none',
    bg: cs.backgroundColor,
    title: b.querySelector('.boot-title')?.textContent.trim(),
    bull: Boolean(img && img.getAttribute('src') === '/bison.png'),
    say: document.getElementById('bootSay')?.textContent.trim(),
  };
});

(async () => {
  const browser = await chromium.launch();

  /* ---- the first moment ---------------------------------------------------- */
  console.log('\n  the first moment, with a slow CDN and a slow box');
  let page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await stubBox(page);
  const t0 = Date.now();
  await page.goto(`${BASE}/tv/`, { waitUntil: 'commit' });
  /* Within half a second of the page arriving — long before the CDN's three. */
  let first = { present: false };
  while (Date.now() - t0 < 1500) {
    first = await boot(page).catch(() => ({ present: false }));
    if (first.present && first.visible) break;
    await wait(50);
  }
  const shownAt = Date.now() - t0;
  console.log(`    start screen up after ${shownAt}ms:`, JSON.stringify(first));
  check('the start screen is up at once, not a blank page', first.present && first.visible
    && shownAt < 1500, `${shownAt}ms ${JSON.stringify(first)}`);
  check('covering the whole screen, on black', first.covers && first.bg === 'rgb(0, 0, 0)',
    JSON.stringify(first));
  check('with the bull and the name on it', first.bull && first.title === 'Treasureflix',
    JSON.stringify(first));

  const scripts = await page.evaluate(() => [...document.querySelectorAll('head script[src]')]
    .map((s) => ({ src: s.getAttribute('src'), defer: s.defer })));
  check('the CDN players no longer hold the page blank — they are deferred',
    scripts.length >= 2 && scripts.every((s) => s.defer), JSON.stringify(scripts));

  /* ---- and then the app ----------------------------------------------------- */
  console.log('\n  once the app is up');
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 15000 })
    .catch(() => {});
  const after = await boot(page);
  const name = await page.evaluate(() => document.querySelector('#profileName')?.textContent.trim());
  console.log('   ', JSON.stringify(after), name);
  check('the start screen has gone', after.present === false, JSON.stringify(after));
  check('and the first screen is there behind it', name === 'HUNTER', String(name));
  await page.close();

  /* ---- a box that will not answer --------------------------------------------- */
  console.log('\n  and a box that will not answer');
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await stubBox(page, { cdnMs: 0, profilesMs: 200, profilesFail: true });
  await page.goto(`${BASE}/tv/`);
  await wait(2500);
  const failed = await boot(page);
  const said = await page.evaluate(() => document.querySelector('#screen')?.textContent.trim());
  console.log('   ', JSON.stringify(failed), JSON.stringify(said));
  check('the start screen steps aside so the reason can be read', failed.present === false,
    JSON.stringify(failed));
  check('and the reason is on the screen', /not reachable/i.test(said || ''), String(said));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
