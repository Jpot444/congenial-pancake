/**
 * Live TV's head, and the controls that go with it.
 *
 * Four changes to one page, and the reasoning behind each is the same: the
 * page was spending its most valuable space on things that were not worth it.
 *
 *   THE HEAD was "LIVE TV" set at 44px over "24 pinned · 92 categories ·
 *   11,764 channels" — the name of the page you had just pressed to reach,
 *   and three counts nobody acts on. It is the scores now: the same slate the
 *   television draws, and a card is a way into the broadcast rather than a
 *   picture of it.
 *
 *   THE SORT offered two options, one of which was the provider's own order,
 *   because a channel has no year and no rating to sort on. Multi-view stands
 *   where it stood.
 *
 *   THE VIEW TOGGLE duplicated what opening a category already does. The
 *   listings button stands where it stood.
 *
 *   THE SHEET listed ninety categories and let you jump to one. Now each
 *   carries a pin, and the rows can be dragged into the order they are drawn
 *   in — which is where the pinning ought to have been all along, because the
 *   bar only shows the pinned ones and whichever few fit after them.
 *
 * The catalogue pages still sort and still switch views, and that is checked
 * here too: one bar serves both, and giving Live TV its own controls must not
 * take Movies' away.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const CHANNELS = [
  { kind: 'live', id: 700, num: 700, name: 'US| FOX ᴴᴰ', categoryId: 'c1', logo: '' },
  { kind: 'live', id: 701, num: 701, name: 'US| MLB 01 | ROCKIES X NATIONALS', categoryId: 'c4', logo: '' },
  { kind: 'live', id: 702, num: 702, name: 'US| ESPN ᴴᴰ', categoryId: 'c2', logo: '' },
  { kind: 'live', id: 703, num: 703, name: 'CA| TSN', categoryId: 'c3', logo: '' },
  /* The row that was being picked: a placeholder for a broadcast at a stated
     time, naming both teams, with nothing on it. It sits in the MLB category
     too, so only the stamped time tells it apart from a real game row. */
  { kind: 'live', id: 704, num: 704,
    name: 'US (Peacock 023) | ROCKIES at NATIONALS (2026-08-30 12:00:00)',
    categoryId: 'c4', logo: '' },

  /* College. Two regional feeds of the SAME network carrying DIFFERENT games,
     which is the case no amount of name-reading can solve — only the guide
     knows which is which. */
  { kind: 'live', id: 800, num: 800, name: 'US| ESPN ᴴᴰ', categoryId: 'c5', logo: '' },
  { kind: 'live', id: 801, num: 801, name: 'US| ESPN 2 ᴴᴰ', categoryId: 'c5', logo: '' },
  /* And the provider's own row for one game, on the football shelf. */
  { kind: 'live', id: 802, num: 802, name: 'US| NCAAF 07 | ALABAMA X GEORGIA',
    categoryId: 'c5', logo: '' },
  /* The trap: 'OHIO' is inside 'OHIO STATE', and both play the same day. */
  { kind: 'live', id: 803, num: 803, name: 'US| NCAAF 11 | OHIO STATE X MICHIGAN',
    categoryId: 'c5', logo: '' },
];
const CATS = [
  { id: 'c1', name: 'USA SPORTS' },
  { id: 'c2', name: 'USA NEWS' },
  { id: 'c3', name: 'CANADA' },
  { id: 'c4', name: 'USA MLB' },
  { id: 'c5', name: 'USA NCAAF' },
];
const LIVE = { categories: CATS, items: CHANNELS, totals: { items: CHANNELS.length } };
const FILMS = {
  categories: [{ id: 'm1', name: 'ACTION' }],
  items: [{ kind: 'movie', id: 900, name: 'A Film', categoryId: 'm1', ext: 'mp4' }],
  totals: { items: 1 },
};

/* One game with a channel of its own (both teams in the name), one carried by
   a network, and one nothing on this box has. */
const SCORES = {
  games: [
    { id: 'col-was', sport: 'mlb', status: 'live', channelMatch: 'MLB NETWORK',
      channelName: 'MLB Network', teamMatch: ['Rockies', 'Nationals'],
      detailedState: 'In Progress', warmup: false,
      away: { abbr: 'COL', teamId: 115, logo: 'https://www.mlbstatic.com/team-logos/115.svg',
        record: '60-70', score: 6, possession: true },
      home: { abbr: 'WSH', teamId: 120, logo: 'https://www.mlbstatic.com/team-logos/120.svg',
        record: '58-72', score: 1, possession: false },
      clock: 'Top 9th', inningState: 'Top', inning: '9th',
      onBase: { first: true, second: false, third: true },
      count: { balls: 2, strikes: 1, outs: 1 },
      situation: '1 out · 1st & 3rd · 2-1', progress: 40 },
    { id: 'bos-oak', sport: 'mlb', status: 'upcoming', channelMatch: 'FOX',
      channelName: 'FOX', teamMatch: ['Red Sox', 'Athletics'],
      detailedState: 'Warmup', warmup: true,
      away: { abbr: 'BOS', teamId: 111, logo: 'https://www.mlbstatic.com/team-logos/111.svg',
        record: '70-60', score: null,
        pitcher: { name: 'Jorge De La Rosa', last: 'De La Rosa', wins: 2, losses: 2, era: '2.84' } },
      home: { abbr: 'OAK', teamId: 133, logo: 'https://www.mlbstatic.com/team-logos/133.svg',
        record: '65-65', score: null,
        pitcher: { name: 'Jesse Chavez', last: 'Chavez', wins: 6, losses: 4, era: '2.93' } },
      clock: '4:05 PM', kickoff: Date.now() + 20 * 60000 },
    { id: 'nyy-bos', sport: 'mlb', status: 'final', channelMatch: 'YES NETWORK',
      channelName: 'YES Network', teamMatch: ['Yankees', 'Red Sox'],
      detailedState: 'Final', warmup: false,
      away: { abbr: 'NYY', teamId: 147, logo: '', record: '75-55', score: 2 },
      home: { abbr: 'BOS2', teamId: 111, logo: '', record: '68-62', score: 7 },
      clock: 'Final' },

    /* Football. The away side drives right, toward the home end zone, and the
       ball is on the HOME team's 41 — which is 59 yards from the left end,
       not 41. Getting that round the wrong way is the whole risk in drawing a
       field rather than printing a sentence. */
    { id: 'chi-gb', sport: 'nfl', status: 'live', channelMatch: 'FOX',
      channelName: 'FOX', teamMatch: ['Bears', 'Packers'],
      detailedState: 'In Progress',
      away: { abbr: 'CHI', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/chi.png',
        record: '4-6', score: 17, possession: true },
      home: { abbr: 'GB', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/gb.png',
        record: '8-2', score: 13, possession: false },
      clock: 'Q2 · 4:22',
      drive: { down: 3, distance: 7, text: '3rd & 7', spot: 'GB 41',
        yardLine: 59, driving: 'right', redZone: false },
      situation: '3rd & 7 · GB 41' },
    { id: 'dal-phi', sport: 'nfl', status: 'upcoming', channelMatch: 'NBC',
      channelName: 'NBC', teamMatch: ['Cowboys', 'Eagles'],
      detailedState: 'Scheduled',
      away: { abbr: 'DAL', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/dal.png',
        record: '7-3', score: null },
      home: { abbr: 'PHI', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/phi.png',
        record: '8-2', score: null },
      clock: '8:20 PM', kickoff: Date.now() + 45 * 60000 },

    /* College football. Four games, each testing a different way of finding
       the channel — and one that must find nothing. */
    { id: 'ala-uga', sport: 'ncaaf', status: 'live', channelMatch: 'CBS',
      channelName: 'CBS', teamMatch: ['Alabama', 'Georgia'],
      teamAlt: ['Crimson Tide', 'Bulldogs'], teamShort: ['ALA', 'UGA'],
      detailedState: 'In Progress',
      away: { abbr: 'ALA', logo: 'https://a.espncdn.com/i/teamlogos/ncaa/500/333.png',
        record: '9-1', score: 21, possession: false },
      home: { abbr: 'UGA', logo: 'https://a.espncdn.com/i/teamlogos/ncaa/500/61.png',
        record: '10-0', score: 24, possession: true },
      clock: 'Q3 · 7:15',
      drive: { down: 1, distance: 10, text: '1st & 10', spot: 'ALA 30',
        yardLine: 30, driving: 'left', redZone: false } },
    /* On ESPN in this market. Both this and the next game say a network the
       box carries; only the guide can say which feed is which. */
    { id: 'osu-mich', sport: 'ncaaf', status: 'live', channelMatch: 'ESPN',
      channelName: 'ESPN', teamMatch: ['Ohio State', 'Michigan'],
      teamAlt: ['Buckeyes', 'Wolverines'], teamShort: ['OSU', 'MICH'],
      detailedState: 'In Progress',
      away: { abbr: 'OSU', logo: '', record: '10-0', score: 14, possession: true },
      home: { abbr: 'MICH', logo: '', record: '9-1', score: 10, possession: false },
      clock: 'Q2 · 1:02',
      drive: { down: 3, distance: 4, text: '3rd & 4', spot: 'MICH 22',
        yardLine: 78, driving: 'right', redZone: false } },
    /* The trap game: 'Ohio' is a substring of 'Ohio State', and both are on. */
    { id: 'ohio-kent', sport: 'ncaaf', status: 'live', channelMatch: 'ESPN',
      channelName: 'ESPN', teamMatch: ['Ohio', 'Kent State'],
      teamAlt: ['Bobcats', 'Golden Flashes'], teamShort: ['OHIO', 'KENT'],
      detailedState: 'In Progress',
      away: { abbr: 'OHIO', logo: '', record: '6-4', score: 7, possession: false },
      home: { abbr: 'KENT', logo: '', record: '3-7', score: 3, possession: true },
      clock: 'Q1 · 9:30' },
    /* Streaming only. Not a channel this box can open, and a card that
       pretends otherwise is worse than one that says so. */
    { id: 'utah-asu', sport: 'ncaaf', status: 'upcoming', channelMatch: 'ESPN+',
      channelName: 'ESPN+', teamMatch: ['Utah', 'Arizona State'],
      teamAlt: ['Utes', 'Sun Devils'], teamShort: ['UTAH', 'ASU'],
      detailedState: 'Scheduled',
      away: { abbr: 'UTAH', logo: '', record: '7-3', score: null },
      home: { abbr: 'ASU', logo: '', record: '5-5', score: null },
      clock: '10:30 PM', kickoff: Date.now() + 90 * 60000 },
  ],
};

/* What the box says is on those channels right now. This is the only thing
   that can tell ESPN-carrying-one-game from ESPN-carrying-another. */
const NOW = Math.floor(Date.now() / 1000);
const EPG = {
  channels: [
    { id: '800', known: true,
      listings: [{ start: NOW - 600, stop: NOW + 3600, title: 'Ohio State at Michigan' }] },
    { id: '801', known: true,
      listings: [{ start: NOW - 600, stop: NOW + 3600, title: 'Ohio at Kent State' }] },
  ],
};

const PREFS = {
  favorites: [],
  pinnedCategories: ['live:c1'],
  deletedItems: [], deletedCategories: [], owner: true,
  tourDone: true, liveTourDone: true, reportNoticeSeen: true, dlExplainSeen: true,
};

async function open(browser, { scores = SCORES, status = 200 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) => {
    // The box takes `tab`, not `kind` — a route that reads the wrong one
    // answers every page with the film list and quietly makes the channel
    // matching below look broken.
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'live' ? LIVE : FILMS) });
  });
  await page.route('**/api/profiles/*/prefs', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREFS) })
    : r.continue()));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.addInitScript(() => { window.__epgSeen = []; });
  await page.route('**/api/epg/**', (r) => {
    const url = r.request().url();
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EPG) })
      .then(() => page.evaluate((u) => window.__epgSeen.push(u), url).catch(() => {}));
  });
  /* The league's marks come through the box's image proxy, which cannot reach
     mlbstatic.com from a test machine — and a mark that does not load is
     removed on purpose, so without this every card would be exercising the
     fallback instead of the badge. */
  /* Deliberately an SVG with NO width or height on the root, only a viewBox —
     which is how several of the league's own marks are authored, and the
     reason they hung out of the cards. A well-behaved stub sizes itself
     politely and proves nothing. */
  await page.route('**/img?u=**', (r) => r.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150">'
      + '<rect width="300" height="150" fill="#456"/></svg>',
  }));
  page.__scoreCalls = 0;
  await page.route('**/api/scores**', (r) => {
    page.__scoreCalls += 1;
    return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(scores) });
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => { state.config.mode = 'xtream'; location.hash = '#/live'; });
  await page.waitForTimeout(2200);
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const page = await open(browser);

  /* ---- the head is the slate ------------------------------------------- */
  console.log('\n  what is on, where the page title was');
  const head = await page.evaluate(() => ({
    band: Boolean(document.querySelector('#dkScores')),
    titleShown: !document.querySelector('#contentTitle')?.parentElement?.hidden,
    title: document.querySelector('.sc-title')?.textContent,
    meta: document.querySelector('.sc-meta')?.textContent,
    cards: [...document.querySelectorAll('.sc-card')].map((c) => ({
      cls: c.className,
      chan: c.querySelector('.sc-tune')?.title || '',
      dead: c.querySelector('.sc-tune').disabled,
      score: c.querySelector('.sc-score')?.textContent ?? null,
      half: c.querySelector('.sc-half, .sc-final')?.textContent ?? null,
      time: c.querySelector('.sc-time')?.textContent ?? null,
      warmup: c.querySelector('.sc-warmup')?.textContent ?? null,
      marks: [...c.querySelectorAll('.sc-mark img')].map((i) => i.getAttribute('src')),
      fallbacks: [...c.querySelectorAll('.sc-mark.no-mark .sc-fallback')].map((f) => f.textContent),
      bases: ['second', 'third', 'first'].map((b) => {
        const n = c.querySelector(`.sc-diamond .b-${b}`);
        return n ? `${b}:${n.classList.contains('on') ? 'on' : 'off'}` : '';
      }).filter(Boolean),
      count: [...c.querySelectorAll('.sc-countrow')].map((r) =>
        `${r.querySelector('b').textContent}${[...r.querySelectorAll('i.on')].length}`
        + `/${r.querySelectorAll('i').length}`).join(','),
      pitchers: [...c.querySelectorAll('.sc-pitcher')].map((p) => p.textContent.trim()),
    })),
  }));
  console.log('   head:', JSON.stringify(head, null, 1));

  check('the scores stand in the head', head.band, String(head.band));
  check('and the words they replaced are gone, not merely covered',
    head.titleShown === false, String(head.titleShown));
  check('the row says what it is', head.title === 'Live now', head.title);
  check('and how much of it is actually on', /1 game on now/.test(head.meta || ''), head.meta);
  /* Three baseball games on the stub slate and two football ones. One band,
     one sport — a row carrying both would be a dozen baseball games with the
     football lost in the middle of them. */
  check('a card per game of the chosen sport, and nothing from the other',
    head.cards.length === 3, String(head.cards.length));

  /* The claim that makes the row a way in rather than a picture: a provider
     that carries a channel per game gets THAT game's channel, not the
     network's. */
  const [first, soon, over] = head.cards;
  check('a live game leads the row', first.cls.includes('is-live'), first.cls);
  check('with the score between the two marks', first.score === '6 - 1', first.score);
  check('and the half-inning under it', first.half === 'Top 9th', first.half);
  check('the clubs are their own marks, not their initials',
    first.marks.length === 2 && first.marks.every((m) => /team-logos%2F/.test(m)),
    JSON.stringify(first.marks));
  check('the diamond is lit where the runners are',
    first.bases.join(',') === 'second:off,third:on,first:on', JSON.stringify(first.bases));
  check('and the count is the count', first.count === 'B2/4,S1/3,O1/3', first.count);
  check('a game with a channel is pressable',
    first.dead === false, String(first.dead));

  /* Measured, not asserted about the stylesheet: a mark that does not fit is
     the thing being prevented, and only the layout knows whether it fits. */
  const fit = await page.evaluate(() => {
    const card = document.querySelector('.sc-card');
    const box = card.getBoundingClientRect();
    return [...card.querySelectorAll('.sc-mark')].map((mark) => {
      const slot = mark.getBoundingClientRect();
      const img = mark.querySelector('img').getBoundingClientRect();
      return {
        slot: [Math.round(slot.width), Math.round(slot.height)],
        img: [Math.round(img.width), Math.round(img.height)],
        insideSlot: img.width <= slot.width + 1 && img.height <= slot.height + 1,
        insideCard: img.top >= box.top - 1 && img.bottom <= box.bottom + 1,
      };
    });
  });
  console.log('   marks:', JSON.stringify(fit));
  check('a mark stays inside the box it was given',
    fit.every((m) => m.insideSlot), JSON.stringify(fit));
  check('and inside the card, whatever the file says about its own size',
    fit.every((m) => m.insideCard), JSON.stringify(fit));

  /* The provider carries rows like "US (Peacock 023) | Marlins at Nationals
     (2026-08-30 12:00:00)": a placeholder for a broadcast at a stated time,
     naming both teams, with nothing playing on it. It is the best match by
     name, which is exactly why it kept being chosen — and opening it gives a
     channel that is not on. */
  check('a dated event row is never what a card opens, however well it matches',
    !/Peacock/i.test(first.chan || ''), first.chan);
  check('the provider\'s own game row is',
    first.chan === 'Watch on US| MLB 01 | ROCKIES X NATIONALS', first.chan);

  check('a game about to start shows the time, not a score',
    soon.time === '4:05 PM' && soon.score === null, JSON.stringify([soon.time, soon.score]));
  /* The club and the pitcher are separate elements set apart by the layout,
     so textContent runs them together — the words are what is being checked,
     not the gap between them. */
  check('the two probables, with their record and ERA',
    soon.pitchers.join(' | ') === 'BOSDe La Rosa (2-2, 2.84) | OAKChavez (6-4, 2.93)',
    JSON.stringify(soon.pitchers));
  /* The moment the broadcast comes up is the moment tuning to it is worth
     doing, and the league says so in its own status. */
  check('and WARMUP is drawn the moment the league says the broadcast is on',
    soon.warmup === 'Warmup' && soon.cls.includes('is-warmup'),
    JSON.stringify([soon.warmup, soon.cls]));

  check('a game that has finished says so rather than showing a live dot',
    over.cls.includes('is-final') && over.half === 'Final', JSON.stringify([over.cls, over.half]));
  /* A mark the league did not give us must leave the abbreviation showing
     rather than a hole where a badge should be. */
  check('a club with no mark keeps its initials',
    over.fallbacks.join(',') === 'NYY,BOS2', JSON.stringify(over.fallbacks));

  /* ---- starring a game ------------------------------------------------- */
  console.log('\n  starring one puts it at the front');
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('.sc-card')].map((c) => c.dataset.game));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.sc-card')]
      .find((c) => c.dataset.game === 'nyy-bos');
    card.querySelector('.sc-star').click();
  });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    order: [...document.querySelectorAll('.sc-card')].map((c) => c.dataset.game),
    lit: [...document.querySelectorAll('.sc-card.is-pinned')].map((c) => c.dataset.game),
    stored: (profiles.data.pinnedGames || []).map((p) => p.id),
  }));
  console.log('   before:', JSON.stringify(before), '\n   after: ', JSON.stringify(after));
  /* A finished game sat last; starred, it leads — which is the whole point of
     starring one. */
  check('the starred game leads the row', after.order[0] === 'nyy-bos',
    JSON.stringify(after.order));
  check('and wears the ribbon', after.lit.join(',') === 'nyy-bos', JSON.stringify(after.lit));
  check('with the star kept on the box, not just on the card',
    after.stored.join(',') === 'nyy-bos', JSON.stringify(after.stored));

  console.log('\n  and starring it again takes it back out');
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.sc-card')]
      .find((c) => c.dataset.game === 'nyy-bos');
    card.querySelector('.sc-star').click();
  });
  await page.waitForTimeout(700);
  const undone = await page.evaluate(() => ({
    order: [...document.querySelectorAll('.sc-card')].map((c) => c.dataset.game),
    stored: (profiles.data.pinnedGames || []).map((p) => p.id),
  }));
  check('the row goes back to what was on first',
    undone.order.join(',') === before.join(','), JSON.stringify(undone.order));
  check('and nothing is left starred', undone.stored.length === 0, JSON.stringify(undone.stored));

  /* The star is a control sitting on top of a card that is itself a button:
     pressing it must not also tune the game underneath it. */
  check('and starring never tuned the game underneath',
    await page.evaluate(() => Boolean(document.querySelector('#playerOverlay')?.hidden)), '');

  console.log('\n  pressing one tunes it');
  await page.evaluate(() => document.querySelector('.sc-tune:not(:disabled)').click());
  await page.waitForTimeout(900);
  const tuned = await page.evaluate(() => ({
    open: !document.querySelector('#playerOverlay')?.hidden,
    name: document.querySelector('#playerTitle')?.textContent || '',
  }));
  console.log('   tuned:', JSON.stringify(tuned));
  check('the card opens the broadcast it named', tuned.open === true, JSON.stringify(tuned));
  await page.evaluate(() => closePlayer());
  await page.waitForTimeout(600);

  /* ---- the other sport ------------------------------------------------- */
  console.log('\n  the switch, and the football slate behind it');
  const seg = await page.evaluate(() => ({
    there: Boolean(document.querySelector('#dkSportSeg')),
    on: document.querySelector('#dkSportSeg button.on')?.dataset.sport,
    options: [...document.querySelectorAll('#dkSportSeg button')].map((b) => b.dataset.sport),
    /* Beside the listings, which is where it was asked for. */
    after: document.querySelector('#dkSportSeg')?.previousElementSibling?.id,
  }));
  console.log('   switch:', JSON.stringify(seg));
  check('there is a switch with all three on it',
    seg.there && seg.options.join(',') === 'nfl,mlb,ncaaf', JSON.stringify(seg));
  check('it stands next to the listings', seg.after === 'dkListingsBtn', seg.after);
  check('and says which one is showing', seg.on === 'mlb', seg.on);

  await page.evaluate(() => document.querySelector('#dkSportSeg [data-sport="nfl"]').click());
  await page.waitForTimeout(1200);

  const nfl = await page.evaluate(() => ({
    on: document.querySelector('#dkSportSeg button.on')?.dataset.sport,
    stored: profiles.data.scoreSport,
    cards: [...document.querySelectorAll('.sc-card')].map((c) => ({
      cls: c.className,
      score: c.querySelector('.sc-score')?.textContent ?? null,
      time: c.querySelector('.sc-time')?.textContent ?? null,
      field: Boolean(c.querySelector('.sc-field')),
      diamond: Boolean(c.querySelector('.sc-diamond')),
      down: c.querySelector('.sc-drive b')?.textContent ?? null,
      spot: c.querySelector('.sc-drive span')?.textContent ?? null,
      ballLeft: c.querySelector('.sc-field .ball')?.style.left ?? null,
      going: [...(c.querySelector('.sc-field .ball')?.classList ?? [])]
        .find((k) => k.startsWith('go-')) ?? null,
      records: [...c.querySelectorAll('.sc-pitcher')].map((p) => p.textContent.trim()),
    })),
  }));
  console.log('   football:', JSON.stringify(nfl, null, 1));

  check('the switch moves the band to the other sport',
    nfl.on === 'nfl' && nfl.cards.length === 2, JSON.stringify([nfl.on, nfl.cards.length]));
  check('and the choice is kept on the profile, not in this browser',
    nfl.stored === 'nfl', String(nfl.stored));

  const [playing, kicking] = nfl.cards;
  check('a football game gets a field, not a diamond',
    playing.field === true && playing.diamond === false, JSON.stringify(playing));
  check('with the down and the spot on it',
    playing.down === '3rd & 7' && playing.spot === 'GB 41',
    JSON.stringify([playing.down, playing.spot]));
  /* The ball is on the HOME side's 41. The home end zone is the RIGHT one, so
     that is 59 yards from the left end — not 41. A field drawn from the wrong
     end is worse than the sentence it replaced. */
  check('the ball sits on the right side of the field for whose 41 it is',
    playing.ballLeft === '59%', playing.ballLeft);
  check('and points at the end zone the offence is driving for',
    playing.going === 'go-right', playing.going);

  check('a football game about to start shows its kickoff time',
    kicking.time === '8:20 PM' && kicking.score === null,
    JSON.stringify([kicking.time, kicking.score]));
  /* Football has no probable starters, so the strip that carries the pitchers
     in baseball carries the thing a football card would say instead. */
  check('and the two records where baseball puts its pitchers',
    kicking.records.join(' | ') === 'DAL7-3 | PHI8-2', JSON.stringify(kicking.records));

  await page.evaluate(() => document.querySelector('#dkSportSeg [data-sport="mlb"]').click());
  await page.waitForTimeout(1200);
  check('and switching back brings the baseball slate with it',
    await page.evaluate(() => document.querySelectorAll('.sc-card').length) === 3, '');

  /* ---- college, and the routing that is the whole difficulty ----------- */
  console.log('\n  a college Saturday');
  await page.evaluate(() => document.querySelector('#dkSportSeg [data-sport="ncaaf"]').click());
  await page.waitForTimeout(1600);

  const college = await page.evaluate(() => ({
    on: document.querySelector('#dkSportSeg button.on')?.dataset.sport,
    grid: document.querySelector('.sc-strip')?.classList.contains('is-grid'),
    columns: getComputedStyle(document.querySelector('.sc-strip'))
      .gridTemplateColumns.split(' ').length,
    cards: [...document.querySelectorAll('.sc-card')].map((c) => ({
      game: c.dataset.game,
      chan: c.querySelector('.sc-tune')?.title || '',
      dead: c.querySelector('.sc-tune').disabled,
      field: Boolean(c.querySelector('.sc-field')),
      down: c.querySelector('.sc-drive b')?.textContent ?? null,
    })),
  }));
  console.log('   college:', JSON.stringify(college, null, 1));

  check('the cap shows the college slate', college.on === 'ncaaf' && college.cards.length === 4,
    JSON.stringify([college.on, college.cards.length]));
  /* Sixty games on a Saturday. A row you scroll along is right for a dozen
     and useless for sixty. */
  check('laid out as a grid rather than a row you drag through',
    college.grid === true && college.columns > 1,
    JSON.stringify([college.grid, college.columns]));
  check('and a college game gets the same field as a pro one',
    college.cards[0].field === true, JSON.stringify(college.cards[0]));

  const by = Object.fromEntries(college.cards.map((c) => [c.game, c]));

  /* The pass that only college needs. Two feeds of the same network carrying
     different games: the names are identical bar a digit, and only the guide
     knows which is which. */
  check('two regional feeds of one network are told apart by what is ON them',
    by['osu-mich'].chan === 'Watch on US| ESPN ᴴᴰ'
    && by['ohio-kent'].chan === 'Watch on US| ESPN 2 ᴴᴰ',
    JSON.stringify([by['osu-mich'].chan, by['ohio-kent'].chan]));
  /* 'OHIO' is inside 'OHIO STATE'. Without whole-word matching the Ohio game
     would claim the Ohio State row and both cards would open the same game. */
  check('and Ohio does not claim the Ohio State broadcast',
    by['ohio-kent'].chan !== by['osu-mich'].chan
    && !/OHIO STATE/.test(by['ohio-kent'].chan),
    JSON.stringify([by['ohio-kent'].chan, by['osu-mich'].chan]));

  check('a game the provider carries a row for opens that row',
    by['ala-uga'].chan === 'Watch on US| NCAAF 07 | ALABAMA X GEORGIA',
    by['ala-uga'].chan);

  /* ESPN+ is not a channel this box can open. A card that offers it anyway is
     a button that lies. */
  check('a streaming-only game offers nothing rather than the wrong thing',
    by['utah-asu'].dead === true && /No channel/.test(by['utah-asu'].chan),
    JSON.stringify(by['utah-asu']));

  const asked = await page.evaluate(() => window.__epgSeen || []);
  console.log('   guide asked:', JSON.stringify(asked));

  /* ---- the controls ---------------------------------------------------- */
  console.log('\n  the bar carries Live TV\'s own two controls');
  const bar = await page.evaluate(() => {
    /* Occupying space on the page, which is the question — a control inside
       a hidden bar still computes its own display. */
    const seen = (sel) => {
      const n = document.querySelector(sel);
      return Boolean(n) && n.getClientRects().length > 0;
    };
    return {
      all: seen('#dkAllBtn'),
      sort: seen('#dkCatbar .dk-sel'),
      view: seen('#dkViewSeg'),
      mv: seen('#dkMvBtn'),
      listings: seen('#dkListingsBtn'),
      listingsText: document.querySelector('#dkListingsBtn span')?.textContent,
      oldMv: seen('#multiviewBtn'),
      oldListings: seen('#listingsBtn'),
    };
  });
  console.log('   bar:', JSON.stringify(bar));
  check('the sort is gone, because a channel has nothing to sort by',
    bar.sort === false, String(bar.sort));
  check('and so is the rows/grid toggle', bar.view === false, String(bar.view));
  check('multi-view stands where the sort stood', bar.mv === true, String(bar.mv));
  check('the listings stand where the toggle stood',
    bar.listings === true && bar.listingsText === 'Listings',
    JSON.stringify([bar.listings, bar.listingsText]));
  check('and neither is shown twice on the page',
    bar.oldMv === false && bar.oldListings === false, JSON.stringify([bar.oldMv, bar.oldListings]));

  console.log('\n  and they press the real thing');
  await page.evaluate(() => document.querySelector('#dkListingsBtn').click());
  await page.waitForTimeout(1000);
  const listed = await page.evaluate(() => ({
    on: state.listings,
    label: document.querySelector('#dkListingsBtn span')?.textContent,
  }));
  console.log('   listings:', JSON.stringify(listed));
  check('the borrowed button turns the listings on', listed.on === true, String(listed.on));
  check('and says how to turn them off again', listed.label === 'Channels', listed.label);
  await page.evaluate(() => document.querySelector('#dkListingsBtn').click());
  await page.waitForTimeout(1000);

  await page.evaluate(() => document.querySelector('#dkMvBtn').click());
  await page.waitForTimeout(900);
  const mv = await page.evaluate(() => !document.querySelector('#multiview')?.hidden);
  check('and the other one opens multi-view', mv === true, String(mv));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  /* ---- the sheet ------------------------------------------------------- */
  console.log('\n  every category, with a pin on it');
  await page.evaluate(() => document.querySelector('#dkAllBtn').click());
  await page.waitForTimeout(700);
  const sheet = await page.evaluate(() => ({
    open: document.querySelector('#dkSheet')?.classList.contains('open'),
    rows: [...document.querySelectorAll('#dkCatList .cat-row')].map((r) => ({
      name: r.querySelector('.cat-row-name')?.textContent,
      pin: Boolean(r.querySelector('.row-pin')),
      pinned: r.classList.contains('pinned'),
    })),
    lead: document.querySelector('#dkSheetLead')?.textContent,
  }));
  console.log('   sheet:', JSON.stringify(sheet));
  check('the sheet opens', sheet.open === true, String(sheet.open));
  check('every row carries a pin, not only the pinned ones',
    sheet.rows.length === 5 && sheet.rows.every((r) => r.pin), JSON.stringify(sheet.rows));
  check('the one already pinned leads and is marked',
    sheet.rows[0].name === 'USA SPORTS' && sheet.rows[0].pinned === true,
    JSON.stringify(sheet.rows[0]));
  check('and the lead says they can be arranged', /drag/i.test(sheet.lead || ''), sheet.lead);

  console.log('\n  pinning one from the sheet');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#dkCatList .cat-row')]
      .find((r) => r.dataset.catId === 'c3');
    row.querySelector('.row-pin').click();
  });
  await page.waitForTimeout(900);
  const pinnedNow = await page.evaluate(() => ({
    stored: profiles.data.pinnedCategories,
    chips: [...document.querySelectorAll('#dkChips .catchip.pinned')].map((c) => c.dataset.catId),
  }));
  console.log('   pinned:', JSON.stringify(pinnedNow));
  check('the pin sticks on the box, not just on the row',
    pinnedNow.stored.includes('live:c3'), JSON.stringify(pinnedNow.stored));
  check('and the bar above picks it up', pinnedNow.chips.includes('c3'),
    JSON.stringify(pinnedNow.chips));
  /* The pin has to claim its own click: a pin that also opened the category
     would close the sheet under the hand that was arranging it. */
  check('and pinning did not open the category underneath it',
    await page.evaluate(() => document.querySelector('#dkSheet').classList.contains('open')), '');

  console.log('\n  dragging one into place');
  const grip = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#dkCatList .cat-row')];
    const from = rows.find((r) => r.dataset.catId === 'c3').getBoundingClientRect();
    const to = rows.find((r) => r.dataset.catId === 'c1').getBoundingClientRect();
    return {
      from: { x: from.left + from.width / 2, y: from.top + from.height / 2 },
      to: { x: to.left + 8, y: to.top + to.height / 2 },
    };
  });
  await page.mouse.move(grip.from.x, grip.from.y);
  await page.mouse.down();
  await page.mouse.move(grip.from.x - 30, grip.from.y, { steps: 5 });
  await page.mouse.move(grip.to.x, grip.to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);

  const dragged = await page.evaluate(() => ({
    order: profiles.pinOrder('live'),
    chips: [...document.querySelectorAll('#dkChips .catchip.pinned')].map((c) => c.dataset.catId),
  }));
  console.log('   dragged:', JSON.stringify(dragged));
  check('the row lands where it was dropped, and the order is stored',
    dragged.order.join(',') === 'c3,c1', JSON.stringify(dragged.order));
  check('which is the order the bar draws them in',
    dragged.chips.join(',') === 'c3,c1', JSON.stringify(dragged.chips));

  await page.evaluate(() => window.__ttDesktop.closeSheet());
  await page.waitForTimeout(500);

  /* ---- the catalogue pages keep theirs --------------------------------- */
  console.log('\n  and Movies still sorts and still switches view');
  await page.evaluate(() => { location.hash = '#/movies'; });
  await page.waitForTimeout(2000);
  const movies = await page.evaluate(() => {
    /* Occupying space on the page, which is the question — a control inside
       a hidden bar still computes its own display. */
    const seen = (sel) => {
      const n = document.querySelector(sel);
      return Boolean(n) && n.getClientRects().length > 0;
    };
    return {
      sort: seen('#dkCatbar .dk-sel'),
      view: seen('#dkViewSeg'),
      mv: seen('#dkMvBtn'),
      listings: seen('#dkListingsBtn'),
      title: document.querySelector('#contentTitle')?.textContent,
      titleShown: !document.querySelector('#contentTitle')?.parentElement?.hidden,
      band: Boolean(document.querySelector('#dkScores')),
    };
  });
  console.log('   movies:', JSON.stringify(movies));
  check('the sort is back where it belongs', movies.sort === true, String(movies.sort));
  check('and so is the view toggle', movies.view === true, String(movies.view));
  check('Live TV\'s two are not on a page that has no channels',
    movies.mv === false && movies.listings === false, JSON.stringify([movies.mv, movies.listings]));
  check('the page title comes back, rather than the last page\'s head sticking',
    movies.titleShown === true && /movies/i.test(movies.title || ''),
    JSON.stringify([movies.titleShown, movies.title]));
  check('and the scores go with the page they belong to', movies.band === false, String(movies.band));
  await page.close();

  /* ---- an empty slate says which kind of empty it is ------------------- */
  console.log('\n  a slate with nothing on it');
  const quiet = await open(browser, { scores: { games: [] } });
  const quietRow = await quiet.evaluate(() => document.querySelector('.sc-empty')?.textContent || '');
  console.log('   quiet:', quietRow);
  check('says the feed answered, rather than leaving a blank band',
    /feed answered/.test(quietRow), quietRow);
  await quiet.close();

  console.log('\n  a slate nobody could be asked for');
  const broken = await open(browser, { scores: { error: 'HTTP 403 · HTTP 403' }, status: 200 });
  const brokenRow = await broken.evaluate(() => document.querySelector('.sc-empty')?.textContent || '');
  console.log('   broken:', brokenRow);
  check('says what went wrong', /403/.test(brokenRow), brokenRow);
  /* The whole address, not the path: a line telling somebody to open
     '/api/scores' asks them to work out what to put in front of it. */
  check('and names the door to knock on, in full',
    /http:\/\/127\.0\.0\.1:8481\/api\/scores/.test(brokenRow), brokenRow);
  await broken.close();

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
