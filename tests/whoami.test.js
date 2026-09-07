/**
 * This screen opens as whoever last used THIS screen.
 *
 * "whenever i open the app it looks like i load into the last users profile.
 *  I should be loading into the last one i used"
 *
 * The sync work that came before put the answer to "who is watching" on the
 * box, because the service answers on three addresses and a browser keeps a
 * separate store per origin — the same television on two of them had two
 * memories of itself and no way to reconcile them. That much was right, and the
 * part of it that matters is untouched: one set of profiles on the Pi, one
 * history, one set of favourites, every device reading and writing the same
 * records.
 *
 * What was wrong was letting the box's answer decide what a screen OPENS as.
 * A television in the front room and a phone in a pocket are not one viewer
 * taking turns; they are two people. Whoever picked last, in any room, decided
 * for everybody — and the five-second poll then re-decided it, so a screen
 * corrected by hand went back a moment later.
 *
 * So: the device's own memory wins, and the box's answer is the fallback for a
 * screen that has never chosen. A new phone, or this service opened on an
 * address it has not been opened on before, still lands on whoever is actually
 * watching rather than on a picker — which is the good half of what the box's
 * answer was doing, kept.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HUNTER = { id: 'own1', name: 'Hunter', emoji: '🐂', color: '#A21F24' };
const KID = { id: 'own2', name: 'Kid', emoji: '🎯', color: '#2B4C7E' };

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  /* Who the BOX thinks is watching — moved by this suite to stand in for
     somebody picking a profile in another room. */
  let boxCurrent = 'own2';
  let rev = 7;
  const told = [];

  await page.route('**/api/profiles', async (r) => {
    if (r.request().method() === 'PUT') return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ profiles: [HUNTER, KID], current: boxCurrent, rev, locked: false }) });
  });
  await page.route('**/api/profiles/current', async (r) => {
    if (r.request().method() !== 'PUT') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ current: boxCurrent, rev }) });
    }
    const body = JSON.parse(r.request().postData() || '{}');
    told.push(body.id);
    boxCurrent = body.id;
    rev += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ current: boxCurrent, rev }) });
  });
  await page.route('**/api/profiles/*/prefs*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"tourDone":true,"liveTourDone":true,"reportNoticeSeen":true,"dlExplainSeen":true,"favorites":[],"pinnedCategories":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"continueWatching":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/library*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"categories":[],"items":[]}' }));
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  const whoAmI = () => page.evaluate(() => ({
    id: profiles.current?.id || '',
    name: profiles.current?.name || '',
    remembered: localStorage.getItem('portal.profile') || '',
    gate: !document.querySelector('#profileGate')?.hidden,
  }));

  /* ---- 1. a screen that has never chosen ------------------------------- */
  /*
   * The good half of what the box's answer was doing, and worth keeping: a new
   * device — or this service reached on an address it has not been opened on
   * before — lands on whoever is actually watching rather than on a picker.
   */
  console.log('\n  a screen opened for the first time');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await wait(1200);
  let me = await whoAmI();
  console.log('   ', JSON.stringify(me));
  check('follows the box, having nothing of its own to go on',
    me.id === 'own2', JSON.stringify(me));

  /* ---- 2. somebody chooses on this screen ------------------------------ */
  console.log('\n  and then somebody picks Hunter on it');
  await page.evaluate((p) => profiles.select(p), HUNTER);
  await wait(600);
  me = await whoAmI();
  console.log('   ', JSON.stringify(me), 'told the box:', JSON.stringify(told));
  check('this screen is Hunter', me.id === 'own1', JSON.stringify(me));
  check('and remembers it for itself', me.remembered === 'own1', me.remembered);
  /* Still published. The box's record is what a NEW screen will follow, and
     keeping it current is the whole reason that fallback is any good. */
  check('and the box is still told who is watching',
    told.includes('own1'), JSON.stringify(told));

  /* ---- 3. somebody else picks, in another room ------------------------- */
  /*
   * The reported failure. This used to decide what every other screen opened
   * as — and the poll re-decided it five seconds later, so correcting it by
   * hand did not stick either.
   */
  console.log('\n  meanwhile, the Kid picks their own profile on the phone');
  boxCurrent = 'own2';
  rev += 1;

  /* The poll, run directly rather than waited out. */
  await page.evaluate(() => profiles.follow());
  await wait(600);
  me = await whoAmI();
  console.log('   ', JSON.stringify(me));
  check('this screen is left alone while it is being used',
    me.id === 'own1', JSON.stringify(me));

  /* ---- 4. and it opens as itself next time ----------------------------- */
  console.log('\n  and this screen is opened again');
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1400);
  me = await whoAmI();
  console.log('   ', JSON.stringify(me), '· the box still says:', boxCurrent);
  check('it opens as Hunter, not as whoever picked last',
    me.id === 'own1', JSON.stringify(me));
  check('and does not put the picker up either', me.gate === false, JSON.stringify(me));

  /* ---- 5. a different device is still a different device --------------- */
  /*
   * The same box, a screen with its own storage — which is what a second
   * television, or the same one on the other address, actually is.
   */
  console.log('\n  a second screen in the house');
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phone = await other.newPage();
  for (const [glob, handler] of [
    ['**/api/profiles', async (r) => {
      if (r.request().method() === 'PUT') return r.continue();
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ profiles: [HUNTER, KID], current: boxCurrent, rev, locked: false }) });
    }],
    ['**/api/profiles/current', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ current: boxCurrent, rev }) })],
    ['**/api/profiles/*/prefs*', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"tourDone":true,"liveTourDone":true,"favorites":[],"pinnedCategories":[]}' })],
    ['**/api/profiles/*/taste', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"recentlyWatched":[],"continueWatching":[],"categoryAffinity":[],"ratings":{}}' })],
    ['**/api/library*', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"categories":[],"items":[]}' })],
    ['**/api/scores*', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{"games":[],"feeds":[]}' })],
    ['**/api/xtream*', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: '{}' })],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await phone.route(glob, handler);
  }
  await phone.goto(BASE, { waitUntil: 'networkidle' });
  await wait(1400);
  const them = await phone.evaluate(() => ({
    id: profiles.current?.id || '', name: profiles.current?.name || '',
  }));
  console.log('   ', JSON.stringify(them));
  check('opens as the Kid, who is who the box says is watching',
    them.id === 'own2', JSON.stringify(them));
  /* And the first screen is still Hunter, which is the point of all of it. */
  me = await whoAmI();
  check('while the first screen is still Hunter', me.id === 'own1', JSON.stringify(me));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
