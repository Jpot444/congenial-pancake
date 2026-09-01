/**
 * Downloading seasons, not downloading twice, and the archive drive's space
 * on the health panel.
 *
 * The dedupe is checked at both ends on purpose: the server refuses a
 * duplicate (the guarantee) and the client says so before asking (the
 * manners). Only one of those showing up in a test means the other is dead
 * code waiting to disagree.
 */
const fs = require('fs');
const http = require('http');
const { chromium, devices } = require('./playwright.js');
const PATHS = require('./paths.js');

const BASE = 'http://127.0.0.1:8481';
const APP_ROOT = PATHS.ROOT;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body) => new Promise((resolve, reject) => {
  const req = http.request(`${BASE}${p}`, { method: 'POST',
    headers: { 'content-type': 'application/json' } }, (res) => {
    let out = '';
    res.on('data', (d) => { out += d; });
    res.on('end', () => resolve({ status: res.statusCode, body: out }));
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});
const del = (p) => new Promise((resolve, reject) => {
  const req = http.request(`${BASE}${p}`, { method: 'DELETE' }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end();
});

const SHOW = {
  kind: 'series', id: 555, name: 'A Show', logo: '', categoryId: 's1',
};
const EPISODES = {
  seasons: [{ season_number: 1 }],
  episodes: { 1: [
    { id: 9001, episode_num: 1, season: 1, title: 'One', container_extension: 'mp4' },
    { id: 9002, episode_num: 2, season: 1, title: 'Two', container_extension: 'mp4' },
    { id: 9003, episode_num: 3, season: 1, title: 'Three', container_extension: 'mp4' },
  ] },
};

(async () => {
  /* ---- the server refuses a second copy --------------------------------- */
  console.log('\n  the server end of never-twice');
  // The source is the test server itself, so the job can actually finish —
  // against the fake provider it fails instantly, and a FAILED job must not
  // block a retry, which is itself worth pinning below.
  const SRC = `${BASE}/app.js`;
  const first = await post('/api/downloads', {
    name: 'Dup Test Film', kind: 'movie', streamId: 'dupe-77', ext: 'mp4',
    sourceUrl: SRC, profileId: 'p1',
  });
  const firstJob = JSON.parse(first.body);
  check('the first request is accepted', first.status === 200, first.body);
  await wait(1200); // a file this small lands immediately

  const second = await post('/api/downloads', {
    name: 'Dup Test Film', kind: 'movie', streamId: 'dupe-77', ext: 'mp4',
    sourceUrl: SRC, profileId: 'p1',
  });
  check('the second is refused, and says why in words',
    second.status === 409 && /[Aa]lready/.test(second.body), `${second.status}: ${second.body}`);

  const otherKind = await post('/api/downloads', {
    name: 'Same Id Other Kind', kind: 'series', streamId: 'dupe-77', ext: 'mp4',
    sourceUrl: SRC, profileId: 'p1',
  });
  check('the same id under a different kind is a different title',
    otherKind.status === 200, `${otherKind.status}: ${otherKind.body}`);

  // A failed attempt does not stand in the way of trying again.
  const doomed = await post('/api/downloads', {
    name: 'Doomed', kind: 'movie', streamId: 'doom-1', ext: 'mp4',
    sourceUrl: `http://127.0.0.1:9497/nowhere.mp4`, profileId: 'p1',
  });
  await wait(1500); // let it fail
  const retry = await post('/api/downloads', {
    name: 'Doomed', kind: 'movie', streamId: 'doom-1', ext: 'mp4',
    sourceUrl: `http://127.0.0.1:9497/nowhere.mp4`, profileId: 'p1',
  });
  check('a failed attempt does not block asking again',
    retry.status === 200, `${retry.status}: ${retry.body}`);

  // Clean up what this test queued.
  for (const r of [first, otherKind, doomed, retry]) {
    try { await del(`/api/downloads/${JSON.parse(r.body).id}`); } catch { /* gone */ }
  }

  /* ---- the client: card button, marks, and the guard -------------------- */
  console.log('\n  the series card');
  const browser = await chromium.launch();
  const page = await browser.newPage({ ...devices['iPhone 13 Pro'] });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  // The client refreshes its download list from the server at every step, so
  // seeding page state alone gets wiped mid-test. Stub the API instead: the
  // fixture IS the server as far as this page knows, and POSTs are counted.
  const posted = [];
  await page.route('**/api/downloads', (r) => {
    if (r.request().method() === 'POST') {
      posted.push(JSON.parse(r.request().postData()));
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: `t${posted.length}`, status: 'queued' }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [
        { id: 'da', kind: 'series', streamId: '9001', status: 'done', name: 'ep1' },
        { id: 'db', kind: 'series', streamId: '9002', status: 'queued', name: 'ep2' },
      ], active: null, queued: 1, freeBytes: 50 * 1024 ** 3 }) });
  });
  await page.route('**/api/xtream*', (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get('action') === 'get_series_info') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(EPISODES) });
    }
    return r.continue();
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate(async (show) => {
    state.library.series = { categories: [{ id: 's1', name: 'Shows' }], items: [show] };
    await refreshDownloads();   // pulls the stub: one saved, one queued
    location.hash = '#/series/555';
  }, SHOW);
  await wait(1500);

  const card = await page.evaluate(() => ({
    seasonBtn: Boolean(document.querySelector('.season-dl')),
    seasonBtnSays: document.querySelector('.season-dl')?.textContent.trim() || '',
    marks: [...document.querySelectorAll('.ep-dl')].map((b) =>
      (b.classList.contains('is-saved') ? 'saved'
        : b.classList.contains('is-queued') ? 'queued' : 'plain')),
    titles: [...document.querySelectorAll('.ep-dl')].map((b) => b.title),
  }));
  console.log('   the card:', JSON.stringify(card));
  check('the season download button is on the card', card.seasonBtn
    && /Download season/.test(card.seasonBtnSays), card.seasonBtnSays);
  check('a saved episode is marked saved', card.marks[0] === 'saved',
    JSON.stringify(card.marks));
  check('one on its way is marked so', card.marks[1] === 'queued',
    JSON.stringify(card.marks));
  check('and a fresh one still offers the arrow', card.marks[2] === 'plain'
    && /Download/.test(card.titles[2]), JSON.stringify(card));

  // Pressing download on the saved episode explains instead of re-queueing.
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
  await page.locator('.ep-dl').first().click();
  await wait(600);
  const afterSaved = await page.evaluate(() => ({
    toast: document.querySelector('#toast').hidden
      ? '' : document.querySelector('#toast').textContent,
  }));
  check('pressing a saved episode explains rather than queueing again',
    posted.length === 0 && /[Aa]lready/.test(afterSaved.toast),
    JSON.stringify({ posted: posted.length, ...afterSaved }));

  // The season button asks first, skips the two covered, queues the one left.
  console.log('\n  the whole season');
  let asked = '';
  page.on('dialog', (d) => { asked = d.message(); d.accept(); });
  await page.locator('.season-dl').click();
  await wait(1500);
  const seasonOut = await page.evaluate(() => ({
    toast: document.querySelector('#toast').hidden
      ? '' : document.querySelector('#toast').textContent,
  }));
  console.log('   it asked:', JSON.stringify(asked));
  console.log('   then said:', JSON.stringify(seasonOut.toast));
  check('it asks before committing the box to a season',
    /1 episode/.test(asked) && /Season 1/.test(asked), asked);
  check('and says the two already covered are being skipped',
    /2 already downloaded/.test(asked), asked);
  check('then queues exactly the one that was missing',
    /Queued 1 episode/.test(seasonOut.toast)
    && posted.length === 1 && String(posted[0].streamId) === '9002' === false
    && String(posted[0].streamId) === '9003', JSON.stringify({ toast: seasonOut.toast, posted }));

  /* ---- the health panel ------------------------------------------------- */
  console.log('\n  the health panel');
  const health = await page.evaluate(async () => {
    const res = await fetch('/api/health');
    return res.json();
  });
  check('the payload carries the archive drive', 'archive' in health,
    JSON.stringify(Object.keys(health)));
  const painted = await page.evaluate((data) => {
    const html = health.render(data);
    return { html };
  }, { ...health, archive: { mounted: true, free: 500 * 1024 ** 3, total: 2000 * 1024 ** 3 } });
  /* Labelled 'Archive', not 'Archive drive': the key column on that panel is
     96px, and two words wrapped onto two lines and made the row taller than
     every other one. The word that carries the meaning is the first. */
  check('a mounted drive paints its free space',
    /health-key">Archive</.test(painted.html) && /500\.0 GB free/.test(painted.html)
    && /1500\.0 GB used of 2000\.0 GB/.test(painted.html),
    painted.html.slice(painted.html.indexOf('Archive'), painted.html.indexOf('Archive') + 200));
  const unplugged = await page.evaluate((data) => health.render(data),
    { ...health, archive: { mounted: false, free: null, total: null } });
  check('an unplugged one says so instead of showing stale numbers',
    /Not plugged in/.test(unplugged) && /Unplugged/.test(unplugged));
  const absent = await page.evaluate((data) => health.render(data),
    { ...health, archive: null });
  check('and a box with no archive at all shows no row for it',
    !/health-key">Archive</.test(absent));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
