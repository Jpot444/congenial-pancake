/**
 * ▼ on a game, on the television.
 *
 * "On the shield player I want the same thing but when I tap 'down' on a game
 *  i am currently watching, a list of suggested views come up."
 *
 * ▼ has always opened the guide, and on an ordinary channel that is still the
 * right answer — a schedule is what you want from a news channel. On a GAME it
 * is the wrong one: nobody presses down during the seventh inning to read the
 * baseball shelf's schedule, they press it to find out what else is on. So the
 * key does a different thing when the box can see that what is on screen is a
 * fixture the slate knows about, and says which on the hint line, and leaves
 * the guide one press away from inside the panel.
 *
 * What is checked:
 *
 *   ▼ ON A GAME OPENS THE GAMES, not the guide, listing every other fixture
 *   that is on now or soon and has a channel behind it — and never the game
 *   already on screen.
 *
 *   ▼ ON ANYTHING ELSE STILL OPENS THE GUIDE. A feature that took the guide
 *   away from the news would be a worse trade than the one it makes.
 *
 *   OK ON A ROW GIVES YOU BOTH. The ask is "suggested views", not a channel
 *   change: multi-view opens seeded with the game that was on and the game
 *   that was picked, in that order, rather than with its own idea of the best
 *   four.
 *
 *   THE GUIDE IS STILL REACHABLE from inside the panel, because a rule this
 *   confident about intent has to leave the old road open.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

/* One shelf of per-fixture rows and one news channel, which is the shape a
   Sunday night actually has on this provider. */
const LIVE = {
  categories: [{ id: 'ppv', name: 'US| MLB PPV EVENTS' }, { id: 'news', name: 'US| NEWS' }],
  items: [
    { kind: 'live', id: 701, num: 701, name: 'MLB 01 | Giants x Pirates', logo: '', categoryId: 'ppv' },
    { kind: 'live', id: 702, num: 702, name: 'MLB 02 | Blue Jays x Guardians', logo: '', categoryId: 'ppv' },
    { kind: 'live', id: 703, num: 703, name: 'MLB 03 | Cubs x Cardinals', logo: '', categoryId: 'ppv' },
    { kind: 'live', id: 704, num: 704, name: 'MLB 04 | Dodgers x Padres', logo: '', categoryId: 'ppv' },
    { kind: 'live', id: 810, num: 810, name: 'US| NEWS ONE', logo: '', categoryId: 'news' },
    { kind: 'live', id: 811, num: 811, name: 'US| NEWS TWO', logo: '', categoryId: 'news' },
  ],
  totals: { items: 6 },
};

const team = (abbr, score) => ({ abbr, score, logo: '', record: '' });
const soon = (mins) => Date.now() + mins * 60000;

const SCORES = {
  at: Date.now(),
  games: [
    { id: 'g-watching', sport: 'mlb', status: 'live', clock: 'Top 7',
      teamMatch: ['Giants', 'Pirates'], away: team('SF', 4), home: team('PIT', 2) },
    { id: 'g-live', sport: 'mlb', status: 'live', clock: 'Bot 3',
      teamMatch: ['Blue Jays', 'Guardians'], away: team('TOR', 1), home: team('CLE', 0) },
    { id: 'g-soon', sport: 'mlb', status: 'upcoming', kickoff: soon(40),
      teamMatch: ['Cubs', 'Cardinals'], away: team('CHC', null), home: team('STL', null) },
    { id: 'g-final', sport: 'mlb', status: 'final', clock: 'Final',
      teamMatch: ['Dodgers', 'Padres'], away: team('LAD', 6), home: team('SD', 3) },
    /* Nothing on this provider names these two: it must not be offered. */
    { id: 'g-uncarried', sport: 'mlb', status: 'live', clock: 'Top 1',
      teamMatch: ['Rockies', 'Nationals'], away: team('COL', 0), home: team('WSH', 0) },
  ],
  feeds: [{ sport: 'mlb', games: 5 }],
};

const PLAYLIST = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:6.000,', 'seg0.ts'].join('\n');

const tuneTo = async (page, num) => {
  await page.evaluate((n) => {
    const node = [...document.querySelectorAll('[data-kind="chan"]')]
      .find((x) => (x.textContent || '').includes(n));
    if (node) node.click();
  }, num);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2200);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  /* The CDN is cut and a stand-in put in its place: nothing here is about
     decoding, and a version that changes under the suite is not a test. */
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.addInitScript(() => {
    class StandInHls {
      static isSupported() { return true; }
      loadSource() {}
      attachMedia(video) { video.src = URL.createObjectURL(new MediaSource()); }
      on() {}
      startLoad() {}
      recoverMediaError() {}
      destroy() {}
    }
    StandInHls.Events = { ERROR: 'hlsError' };
    StandInHls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    window.Hls = StandInHls;
  });

  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' }));
  await page.route('**/api/scores**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SCORES) }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/play**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/hls/live/index.m3u8","format":"m3u8","dvr":true}' }));
  await page.route('**/hls/**/index.m3u8', (r) =>
    r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: PLAYLIST }));

  await page.goto(`${BASE}/tv/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  /* ---- 1. ▼ on a game ---------------------------------------------------- */
  console.log('\n  watching a game, pressing down');
  await tuneTo(page, 'Giants x Pirates');

  const hint = await page.evaluate(() =>
    document.querySelector('.player-scrim .hintpill')?.textContent || '');
  console.log('   hints:', JSON.stringify(hint.replace(/\s+/g, ' ').trim()));
  /* The line has to say what the key does. A hint that names the guide and
     opens something else is worse than no hint at all. */
  check('the hint line says ▼ is the other games', /Other games/.test(hint), hint);

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);

  const panel = await page.evaluate(() => {
    const node = document.querySelector('.suggest');
    if (!node) return { open: false, guide: Boolean(document.querySelector('.guide')) };
    const r = node.getBoundingClientRect();
    return {
      open: true,
      guide: Boolean(document.querySelector('.guide')),
      /* From the RIGHT, and not across the whole screen: the picture is the
         reason the panel exists. */
      right: Math.round(window.innerWidth - r.right),
      widthShare: r.width / window.innerWidth,
      rows: [...document.querySelectorAll('.suggest-row')].map((n) => ({
        title: n.querySelector('.sg-title')?.textContent || '',
        when: n.querySelector('.sg-when')?.textContent || '',
        score: n.querySelector('.sg-score')?.textContent || '',
        chan: n.querySelector('.sg-chan')?.textContent || '',
        live: n.classList.contains('on'),
        focused: n.classList.contains('f'),
      })),
      guideButton: Boolean(document.querySelector('.suggest-guide')),
    };
  });
  for (const row of panel.rows || []) console.log(`    ${JSON.stringify(row)}`);

  check('▼ opens the other games', panel.open === true, JSON.stringify(panel));
  check('rather than the guide', panel.guide === false, JSON.stringify(panel));
  check('down the right-hand side, beside the picture rather than over it',
    panel.right === 0 && panel.widthShare < 0.55,
    JSON.stringify({ right: panel.right, share: panel.widthShare }));

  const titles = (panel.rows || []).map((r) => r.title);
  check('the game being watched is not offered back',
    !titles.some((t) => /SF|PIT/.test(t)), JSON.stringify(titles));
  check('the other live game is', titles.includes('TOR at CLE'), JSON.stringify(titles));
  check('and the one starting soon', titles.includes('CHC at STL'), JSON.stringify(titles));
  check('a game that is over is not', !titles.some((t) => /LAD|SD/.test(t)),
    JSON.stringify(titles));
  /* A row that opens nothing is the black screen this portal has spent a
     fortnight removing, dressed up as a recommendation. */
  check('nor one this provider does not carry', !titles.some((t) => /COL|WSH/.test(t)),
    JSON.stringify(titles));
  check('the live game is first', titles[0] === 'TOR at CLE', JSON.stringify(titles));
  check('with its score on it', panel.rows[0]?.score === '1–0', JSON.stringify(panel.rows[0]));
  check('and each row names the channel it opens',
    (panel.rows || []).every((r) => /MLB 0\d/.test(r.chan)),
    JSON.stringify((panel.rows || []).map((r) => r.chan)));
  /* The cursor lands on the list, not on the way out of it. */
  check('the cursor starts on the first game', panel.rows[0]?.focused === true,
    JSON.stringify(panel.rows.map((r) => r.focused)));
  check('and the full guide is still one press away', panel.guideButton === true);

  /* ---- 2. OK gives you both ---------------------------------------------- */
  console.log('\n  taking one');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);

  const quad = await page.evaluate(() => ({
    multi: Boolean(document.querySelector('.multi')),
    cells: [...document.querySelectorAll('.quad-foot .name')].map((n) => n.textContent),
  }));
  console.log('   cells:', JSON.stringify(quad.cells));
  check('it opens multi-view', quad.multi === true, JSON.stringify(quad));
  /* Seeded, and in the order asked for. The screen's own idea of the best four
     is a good default and a bad answer to an explicit choice. */
  check('with the game that was on in the first cell',
    /Giants/.test(quad.cells[0] || ''), JSON.stringify(quad.cells));
  check('and the one that was picked in the second',
    /Blue Jays/.test(quad.cells[1] || ''), JSON.stringify(quad.cells));

  /* ---- 3. an ordinary channel still gets the guide ------------------------ */
  console.log('\n  and on a channel that is not a game');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await tuneTo(page, 'NEWS ONE');

  const newsHint = await page.evaluate(() =>
    document.querySelector('.player-scrim .hintpill')?.textContent || '');
  check('the hint line goes back to saying Guide',
    /Guide/.test(newsHint) && !/Other games/.test(newsHint), newsHint.replace(/\s+/g, ' '));

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  const news = await page.evaluate(() => ({
    guide: Boolean(document.querySelector('.guide')),
    suggest: Boolean(document.querySelector('.suggest')),
    head: document.querySelector('.guide-head h2')?.textContent || '',
  }));
  console.log('   ', JSON.stringify(news));
  check('▼ still opens the guide', news.guide === true && news.suggest === false,
    JSON.stringify(news));
  check('on the category the channel is in', news.head === 'US| NEWS', news.head);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
