/**
 * What's on — now and next, on the landing page.
 *
 * "There was a feature on the homepage that had a listings guide for a few
 * live channels and showed what was coming up next. I want to incorporate
 * that but I don't know if the IPTV service I use will support it."
 *
 * It does, and it already did: the player has been showing `get_short_epg`
 * listings since long before this. What is new is asking about six channels
 * at once, and that is a different problem from asking about one.
 *
 * This provider allows a SINGLE connection, and while ffmpeg is streaming
 * through it every metadata call comes back `{"error":""}`. Six calls fired
 * from a browser while somebody is watching a film would be six failures and
 * a connection contended for nothing. So the box answers instead: it knows
 * whether the provider is free, it caches, and it never asks while something
 * is playing.
 */
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNELS = [
  { kind: 'live', id: 501, name: 'US| NEWS ONE', categoryId: 'c1' },
  { kind: 'live', id: 502, name: 'US| SPORTS HD', categoryId: 'c1' },
  { kind: 'live', id: 503, name: 'US| NOTHING LISTED', categoryId: 'c1' },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  // The listings, as the box would return them. Anchored to now so "what is
  // on" is a question with an answer.
  const now = Math.floor(Date.now() / 1000);
  let asked = [];
  let answer = (ids) => ({
    channels: ids.map((id) => ({
      id,
      listings: id === '503' ? [] : [
        { title: `Now on ${id}`, start: now - 900, stop: now + 900 },
        { title: `Next on ${id}`, start: now + 900, stop: now + 3600 },
      ],
    })),
    busy: false,
  });
  await page.route('**/api/epg/now*', (r) => {
    const ids = String(new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    asked.push(ids);
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(answer(ids)) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  const home = (favs) => page.evaluate(async (items) => {
    location.hash = '#/home';
    await new Promise((r) => setTimeout(r, 500));
    profiles.favItems = () => items;
    renderHome();
    await new Promise((r) => setTimeout(r, 700));
    return [...document.querySelectorAll('.guide-row')].map((row) => ({
      channel: row.querySelector('.guide-channel')?.textContent || '',
      now: row.querySelector('.guide-now')?.textContent || '',
      next: row.querySelector('.guide-next')?.textContent || '',
      bar: row.querySelector('.guide-bar i')?.style.width || '',
    }));
  }, favs);

  console.log('\n  the guide on the landing page');
  const rows = await home(CHANNELS);
  console.log('   ', JSON.stringify(rows, null, 1).slice(0, 400));
  check('a row per favourited channel', rows.length === 3, String(rows.length));
  check('named by the channel', rows[0].channel === 'US| NEWS ONE', rows[0].channel);
  check('saying what is on now', /Now on 501/.test(rows[0].now), rows[0].now);
  check('and what is on after it, with a time',
    /\d{1,2}:\d{2}/.test(rows[0].next) && /Next on 501/.test(rows[0].next), rows[0].next);
  check('with how far through it is, which is the thing you want before',
    parseFloat(rows[0].bar) > 40 && parseFloat(rows[0].bar) < 60, rows[0].bar);
  console.log('       pressing — half an hour in is a different decision');

  console.log('\n  a channel the provider lists nothing for');
  check('is still a row, and still presses', rows[2].channel === 'US| NOTHING LISTED',
    rows[2].channel);
  check('with nothing invented to fill it',
    rows[2].now === '' && rows[2].next === '', JSON.stringify(rows[2]));

  console.log('\n  and only the channels, only a few of them');
  console.log('   ', JSON.stringify(asked));
  check('one request for the lot, not one per channel', asked.length === 1,
    JSON.stringify(asked));
  const many = Array.from({ length: 20 }, (_, i) => ({
    kind: 'live', id: 600 + i, name: `Channel ${i}`, categoryId: 'c1' }));
  asked = [];
  const capped = await home(many);
  check('and a wall of favourites is capped rather than asked in full',
    capped.length === 6 && asked[0].length === 6, `${capped.length} rows`);

  console.log('\n  when the provider cannot answer');
  //
  // A guide that cannot be had is not an error worth a message. Every row is
  // still a channel, and still presses.
  answer = () => { throw new Error('unused'); };
  await page.route('**/api/epg/now*', (r) =>
    r.fulfill({ status: 502, contentType: 'application/json',
      body: '{"error":"Provider is busy"}' }));
  const quiet = await home(CHANNELS);
  console.log('   ', JSON.stringify(quiet));
  check('the rows are still there', quiet.length === 3, String(quiet.length));
  check('named, and pressable', quiet[0].channel === 'US| NEWS ONE', quiet[0].channel);
  check('with no programme claimed and no error shouted',
    quiet.every((r) => r.now === '' && r.next === ''), JSON.stringify(quiet));

  console.log('\n  and no channels at all');
  const none = await home([{ kind: 'movie', id: 9, name: 'A Film' }]);
  check('no guide where there is nothing to guide', none.length === 0,
    String(none.length));

  /* ---- and the box's own side of it ------------------------------------ */
  //
  // The reason this goes through the box at all: it is the only thing that
  // knows whether the provider is free.
  console.log('\n  what the box does with it');
  const fs = require('fs');
  const SERVER = fs.readFileSync(PATHS.SERVER, 'utf8');
  check('it refuses to ask while something is playing',
    /if \(stale\.length && !providerBusy\(\)\)/.test(SERVER));
  check('it caches, so a landing page does not re-ask every visit',
    /epgCache\.set/.test(SERVER) && /EPG_TTL_MS/.test(SERVER));
  check('it caches the empty answer too, so a channel with no listings is',
    /epgCache\.set\(id, \{ at: now, channel: \{ id, listings: \[\] \} \}\)/.test(SERVER));
  console.log('       not asked about again every few seconds');
  check('it caps how many channels one request may cover',
    /EPG_MAX_CHANNELS/.test(SERVER) && /slice\(0, EPG_MAX_CHANNELS\)/.test(SERVER));
  check('and answers for every id it was asked about, listed or not',
    /for \(const id of ids\) if \(!answered\.has\(id\)\)/.test(SERVER));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
