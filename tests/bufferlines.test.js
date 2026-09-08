/**
 * Something to read while the box is buffering.
 *
 * "During the buffering screens where it says 'buffering ahead' I want that
 *  replaced with a prediction market specific joke or a real fact from my
 *  prediction market firm... The facts should update daily and I want a decent
 *  rotation so I don't see them repeated. Other accounts should also see the
 *  messages, but not dollar figures only %"
 *
 * Four claims in that, and this checks all four.
 *
 *   THE LINE LEADS. The buffering screen used to open with a sentence about
 *   why the provider is slow. It now opens with a line, and the sentence is
 *   still on the screen underneath it — replaced as the headline, not deleted.
 *
 *   THE ROTATION DOES NOT REPEAT. Not "picks at random": random deals the same
 *   line twice running about one time in forty, and that is the only repeat
 *   anybody ever notices. The deck is shuffled and dealt, every line comes up
 *   once before any comes up twice, the position survives a reload, and the
 *   seam between one deck and the next does not repeat either.
 *
 *   THE MONEY IS THE OWNER'S. Every other profile sees the same facts as
 *   percentages. This is checked against the box rather than against the page,
 *   because that is where it is enforced: a rule a browser applies is a rule
 *   anybody with the developer tools open can decline to apply.
 *
 *   AND IT IS NEVER WORSE THAN IT WAS. A box with no deck — no facts, no
 *   answer, an old build — leaves the original sentence exactly where it was.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A book with a good week in it, planted so the shaping can be read off the
   answer rather than guessed at. Written straight into the box's own file. */
const FIRM = {
  name: 'Treasure State',
  weekPnl: 5000, weekPct: 12,
  dayPnl: -240, dayPct: -1.8,
  best: { title: 'Presidential margin — landslide', pct: 34, pnl: 1800 },
  settled: { won: 17, total: 24 },
  openPositions: 9,
  biggest: { title: 'Shutdown by Nov 1', share: 31 },
  contractsWeek: 1240,
};

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

(async () => {
  /* ---- 0. a book to talk about ----------------------------------------- */
  /*
   * Planted through the box's own settings route rather than by writing its
   * file from outside: the typed lines are the source that needs no key and no
   * venue, and they are the half of this that can be checked end to end here.
   */
  const planted = await fetch(`${BASE}/api/market?profileId=own1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      typed: [
        'Treasure State is up $5,000 this week on the debate book.',
        'The firm has never taken the other side of a Bobcats game.',
      ],
    }),
  });
  check('the owner can set the buffering-screen lines', planted.ok, String(planted.status));

  /* ---- 1. who may see a dollar figure ---------------------------------- */
  /*
   * The reported rule, and the one worth being strict about. A second profile
   * is made for it, because "everybody else" is not a thing that can be tested
   * with one profile on the box.
   */
  console.log('\n  the money is the owner’s');
  const made = await fetch(`${BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Guest', emoji: '🎯', color: '#2B4C7E' }),
  });
  const guest = await made.json().catch(() => ({}));
  const guestId = guest.id || '';
  check('there is a second profile to check against', Boolean(guestId), JSON.stringify(guest));

  const mine = await get('/api/market/lines?profileId=own1');
  const theirs = await get(`/api/market/lines?profileId=${guestId || 'nobody'}`);
  const dollars = (rows) => (rows.lines || []).filter((l) => /\$\s?\d/.test(l.text));
  console.log(`    owner: ${(mine.body.lines || []).length} lines,`
    + ` ${dollars(mine.body).length} with a dollar figure`);
  console.log(`    guest: ${(theirs.body.lines || []).length} lines,`
    + ` ${dollars(theirs.body).length} with a dollar figure`);
  check('the owner is told they are the owner', mine.body.owner === true);
  check('and gets the line with the money in it',
    dollars(mine.body).some((l) => /5,000/.test(l.text)), JSON.stringify(dollars(mine.body)));
  check('everybody else gets lines', (theirs.body.lines || []).length > 10,
    String((theirs.body.lines || []).length));
  check('and not one dollar figure among them',
    dollars(theirs.body).length === 0, JSON.stringify(dollars(theirs.body)));
  check('including the same jokes the owner gets',
    (theirs.body.lines || []).some((l) => l.kind === 'joke'));
  check('and the line with no money in it, which is not a secret',
    (theirs.body.lines || []).some((l) => /Bobcats/.test(l.text)));

  /* And the settings behind it — a brokerage key — are the owner's alone. */
  const settings = await get(`/api/market?profileId=${guestId || 'nobody'}`);
  check('the source settings are refused to anybody else', settings.status === 403,
    String(settings.status));

  /* ---- 2. the facts, shaped -------------------------------------------- */
  /*
   * The shaping of a real book's numbers, checked directly: this is the part
   * that has no key behind it in a test and would otherwise go unseen until
   * one is pasted in.
   */
  console.log('\n  a week of the book, in both forms');
  const market = require('../market.js');
  const facts = market.factsFrom(FIRM);
  const owner = facts.map((f) => f.money);
  const other = facts.map((f) => f.pct).filter(Boolean);
  console.log('    owner:', JSON.stringify(owner.slice(0, 3), null, 0));
  console.log('    guest:', JSON.stringify(other.slice(0, 3), null, 0));
  check('a week that made money says so', owner.some((t) => /\$5,000/.test(t)),
    JSON.stringify(owner));
  check('and says it as a percentage for everybody else',
    other.some((t) => /12%/.test(t)) && !other.some((t) => /\$/.test(t)), JSON.stringify(other));
  check('a losing day is "down 1.8%", not "down -1.8%"',
    other.some((t) => /down 1\.8%/.test(t)) && !other.some((t) => /-1\.8/.test(t)),
    JSON.stringify(other));
  check('the best call of the week is named', owner.some((t) => /landslide/i.test(t)),
    JSON.stringify(owner));
  check('every fact has a form with no money in it, or is not shared at all',
    facts.every((f) => !f.pct || !/\$/.test(f.pct)), JSON.stringify(facts.map((f) => f.pct)));

  /* ---- 3. the screen --------------------------------------------------- */
  console.log('\n  the buffering screen itself');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await wait(1200);

  const deck = await page.evaluate(() => ({
    lines: marketLines.text.size, who: marketLines.who, day: marketLines.day,
  }));
  console.log('   ', JSON.stringify(deck));
  check('the page has a deck', deck.lines > 20, JSON.stringify(deck));
  check('dealt for whoever is signed in', deck.who === 'own1', deck.who);
  check('and stamped with the day it was dealt',
    /^\d{4}-\d{2}-\d{2}$/.test(deck.day), deck.day);

  await page.evaluate(() =>
    loader.wait('Buffering ahead · the provider is feeding this one slowly', '12s of 45s'));
  await wait(300);
  const screen = await page.evaluate(() => ({
    label: document.querySelector('#loaderLabel').textContent,
    why: document.querySelector('#loaderWhy').textContent,
    whyShown: !document.querySelector('#loaderWhy').hidden,
    detail: document.querySelector('#loaderDetail').textContent,
    marked: document.querySelector('#loader').classList.contains('has-line'),
  }));
  console.log('   ', JSON.stringify(screen));
  check('the line is what the screen leads with',
    screen.label.length > 10 && !/Buffering ahead/.test(screen.label), screen.label);
  check('and the reason it is buffering is still on the screen',
    screen.whyShown && /Buffering ahead/.test(screen.why), JSON.stringify(screen));
  check('with the numbers untouched beside the bar',
    screen.detail === '12s of 45s', screen.detail);

  /* ---- 4. rotation ------------------------------------------------------ */
  console.log('\n  the rotation');
  const size = deck.lines;
  /* Dealt from the top of a deck rather than from wherever the screen above
     left the cursor — a pass that starts mid-deck crosses the seam and is a
     test of two decks, not of one. */
  await page.evaluate(() => marketLines.reshuffle());
  const dealt = await page.evaluate((n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(marketLines.next());
    return out;
  }, size * 2);
  const firstPass = dealt.slice(0, size);
  const secondPass = dealt.slice(size);
  const repeats = dealt.filter((line, i) => i > 0 && line === dealt[i - 1]).length;
  console.log(`    ${size} lines · first pass ${new Set(firstPass).size} distinct`
    + ` · second pass ${new Set(secondPass).size} distinct · ${repeats} back to back`);
  check('every line comes up before any line comes up twice',
    new Set(firstPass).size === size, `${new Set(firstPass).size} of ${size}`);
  check('and again on the next deal', new Set(secondPass).size === size,
    `${new Set(secondPass).size} of ${size}`);
  check('never the same line twice running, including across the seam',
    repeats === 0, String(repeats));

  /* Where it had got to, kept — a reload in the middle of a deck picks up
     where it left off rather than starting the same lines over. Dealt a few
     past the seam first, so "where it left off" is somewhere worth keeping
     rather than the end of a deck. */
  await page.evaluate(() => { for (let i = 0; i < 3; i += 1) marketLines.next(); });
  const before = await page.evaluate(() => ({
    at: marketLines.at, next: marketLines.order[marketLines.at] || '',
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1600);
  const after = await page.evaluate(() => ({
    at: marketLines.at, next: marketLines.order[marketLines.at] || '',
  }));
  console.log(`    at ${before.at} before the reload, ${after.at} after`);
  check('the rotation survives a reload',
    after.at === before.at && after.next === before.next && Boolean(after.next),
    JSON.stringify({ before, after }));

  /* ---- 5. tomorrow ------------------------------------------------------ */
  /*
   * "The facts should update daily."
   *
   * The box reads the book once a day. A screen left open across midnight —
   * which on a television is the ordinary case, not the exception — has to
   * notice: the deck it is holding is stamped with the day it was dealt, and
   * dealing from a deck stamped yesterday asks for a new one in the
   * background. This wait uses yesterday's line; the next one is today's.
   */
  console.log('\n  across midnight');
  const asked = [];
  await page.route('**/api/market/lines*', (r) => { asked.push(r.request().url()); r.continue(); });
  await page.evaluate(() => { marketLines.day = '2001-01-01'; });
  await page.evaluate(() => marketLines.next());
  await wait(900);
  const now = await page.evaluate(() => marketLines.day);
  console.log(`    asked again ${asked.length} time(s); deck is now stamped ${now}`);
  check('a deck dealt yesterday is replaced without anybody asking',
    asked.length >= 1, String(asked.length));
  check('and the new one is stamped today', /^\d{4}-\d{2}-\d{2}$/.test(now) && now !== '2001-01-01',
    now);
  await page.unroute('**/api/market/lines*');

  /* ---- 6. and when there is no deck ------------------------------------ */
  /*
   * A box that cannot answer, an old build, a first run. The screen has to be
   * exactly what it was before any of this existed.
   */
  console.log('\n  with nothing to read');
  await page.evaluate(() => { marketLines.text = new Map(); marketLines.order = []; });
  await page.evaluate(() => loader.wait('Buffering ahead · the provider is feeding this one slowly', ''));
  await wait(200);
  const bare = await page.evaluate(() => ({
    label: document.querySelector('#loaderLabel').textContent,
    whyShown: !document.querySelector('#loaderWhy').hidden,
    marked: document.querySelector('#loader').classList.contains('has-line'),
  }));
  console.log('   ', JSON.stringify(bare));
  check('the screen says what it always said', /Buffering ahead/.test(bare.label), bare.label);
  check('and does not leave an empty caption under it',
    bare.whyShown === false && bare.marked === false, JSON.stringify(bare));

  /* Put the box back. One box is shared by every suite, and a profile left
     behind here is a profile the next suite has to explain. */
  if (guestId) {
    await fetch(`${BASE}/api/profiles/${guestId}`, { method: 'DELETE' }).catch(() => {});
  }
  await fetch(`${BASE}/api/market?profileId=own1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ typed: [] }),
  }).catch(() => {});

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
