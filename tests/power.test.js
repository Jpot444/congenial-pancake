/**
 * "Under-voltage has occurred" is not "your supply is failing".
 *
 * "Power warning: under-voltage has occurred, throttling has occurred. An
 *  under-powered supply causes stalls and I/O errors that look exactly like a
 *  bad connection."
 *
 * That is the panel's own sentence, and the flags in it are the whole story:
 * `has occurred`, twice, and `now` not once.
 *
 * A Pi reports throttling as two sets of bits. The low nibble is what is
 * happening AT THIS MOMENT. The high bits are sticky — "this happened at some
 * point since the box booted" — and they stay set until it reboots, however
 * brief the event was and however long ago. The panel printed both through one
 * list under one heading, so a mark left by something that lasted a
 * millisecond a week ago read exactly like a supply failing while you watch.
 *
 * WHICH IS WRONG IN THE DIRECTION THAT COSTS MONEY. Restoring power after a
 * cut is precisely when a Pi records a brown-out. This box came back from one
 * two days before that report, so it will show `under-voltage has occurred`
 * for as long as it stays up with nothing whatever wrong with its supply — and
 * the panel was telling its owner to go and buy a new one on the strength of
 * an event they had already lived through.
 *
 * So: two readings, two sentences, and the difference between them is the only
 * thing a reader needs. Happening now is a thing to act on. Happened since
 * boot is a thing to date.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;
const ROOT = PATHS.ROOT;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- the decode, against the box's own function ------------------------- */
/*
 * Lifted rather than re-implemented: a second copy of the bit arithmetic
 * would agree with itself for ever and say nothing about what the box does.
 */
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const lift = (name) => {
  const at = SERVER.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} is not in server.js any more`);
  return SERVER.slice(at, SERVER.indexOf('\n}\n', at) + 2);
};
// eslint-disable-next-line no-eval
const decodeThrottled = eval(`(${lift('decodeThrottled').replace(/^function /, 'function ')})`);

(async () => {
  console.log('\n  what the bits mean');
  const healthy = decodeThrottled('throttled=0x0');
  check('nothing set is nothing wrong', healthy.ok === true && healthy.live === false,
    JSON.stringify(healthy));

  /* The reported case, exactly: under-voltage and throttling have OCCURRED,
     and neither is happening. */
  const fossil = decodeThrottled('throttled=0x50000');
  console.log('   0x50000 →', JSON.stringify({ live: fossil.live, now: fossil.now,
    since: fossil.since }));
  check('the reported flags are read as history, not as now',
    fossil.live === false, JSON.stringify(fossil));
  check('and they are still reported — this is not being swept away',
    fossil.ok === false && fossil.since.length === 2, JSON.stringify(fossil.since));
  check('naming both of them', fossil.since.join(',') === 'under-voltage,throttling',
    JSON.stringify(fossil.since));

  /* And the one that is worth acting on. */
  const live = decodeThrottled('throttled=0x50001');
  console.log('   0x50001 →', JSON.stringify({ live: live.live, now: live.now }));
  check('a brown-out happening now is live', live.live === true, JSON.stringify(live));
  check('and says which', live.now.join(',') === 'under-voltage', JSON.stringify(live.now));
  /* The sticky bits are still there underneath it — a live fault that has also
     happened before is both things at once. */
  check('without losing the history behind it', live.since.length === 2,
    JSON.stringify(live.since));

  /* The two high bits nothing used to decode at all. A box sitting at its
     temperature limit is a different fault from a marginal plug, and it read
     as an unexplained 0x80000 before. */
  const warm = decodeThrottled('throttled=0xa0000');
  console.log('   0xa0000 →', JSON.stringify(warm.since));
  check('the frequency-cap and temperature marks are decoded too',
    warm.since.join(',') === 'CPU frequency capped,the soft temperature limit',
    JSON.stringify(warm.since));

  /* ---- and what the panel says about each ------------------------------- */
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"categories":[],"items":[],"totals":{"items":0}}' }));

  /* The box's own health answer with one field replaced, so the rest of the
     payload is the shape the box really emits. */
  let power = null;
  let uptime = null;
  await page.route('**/api/health**', async (r) => {
    const res = await r.fetch();
    const body = await res.json().catch(() => null);
    if (!body) return r.fulfill({ status: 500, body: '{}' });
    if (power) body.power = power;
    if (uptime) body.uptime = uptime;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(body) });
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wait(1500);
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1400);
  }

  const noteFor = async (bits, up) => {
    power = decodeThrottled(`throttled=0x${bits}`);
    uptime = { host: up, server: up };
    await page.evaluate(() => {
      document.querySelector('#tour')?.remove();
      health.open();
    });
    await page.waitForSelector('.health-row', { timeout: 10000 });
    await wait(700);
    const text = await page.evaluate(() =>
      (document.querySelector('.health-note')?.textContent || '').replace(/\s+/g, ' ').trim());
    await page.evaluate(() => health.close());
    await wait(200);
    return text;
  };

  console.log('\n  the panel, on the reported box');
  /* Two days up, which is this box: it rebooted after the power cut. */
  const said = await noteFor('50000', 2 * 86400 + 3600);
  console.log('   ', JSON.stringify(said));
  check('it does not shout "Power warning" at a mark from the past',
    !/^Power warning/.test(said), said.slice(0, 80));
  check('it still says what happened', /under-voltage and throttling/.test(said), said);
  /* The date. "Since boot" is meaningless without knowing when boot was, and
     with it the reader can match it against the power cut they remember. */
  check('and dates it, so it can be matched against what the reader remembers',
    /2d 1h since this box booted/.test(said), said);
  check('and says plainly that nothing is throttling at this moment',
    /nothing is throttling at this moment/.test(said), said);
  /* The advice that stops somebody buying a supply they do not need — and
     tells them what the real thing would look like. */
  check('and what the real fault would look like instead',
    /right now/.test(said) && /while something is playing/.test(said), said);

  console.log('\n  and on a box that really is browning out');
  const now = await noteFor('50001', 3600);
  console.log('   ', JSON.stringify(now));
  check('this one does shout', /^Power warning/.test(now), now.slice(0, 80));
  check('saying it is happening now', /right now/.test(now), now);
  /* The sentence that makes this worth a warning at all: it is the fault that
     disguises itself as every other fault. */
  check('and why it matters, which has not changed',
    /look exactly like a bad connection/.test(now), now);

  console.log('\n  and on a healthy one');
  const quiet = await noteFor('0', 3600);
  console.log('   ', JSON.stringify(quiet));
  check('nothing is said about power at all',
    !/power|voltage|throttl/i.test(quiet), quiet.slice(0, 120));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
