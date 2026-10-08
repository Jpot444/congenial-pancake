/**
 * The Guest.
 *
 * "Next to manage profiles button should be a guest log in button that opens
 *  up a new profile without walkthrough, loaded with the standard favorites.
 *  Make that guest profile the same thing tv.treasurestatecapital.com/tv goes
 *  to at first."
 *
 * Four claims, each checked the way somebody would notice it failing:
 *
 *   ONE guest. Pressing the button twice must not make two, or an evening of
 *   friends fills the twelve seats.
 *   NO walkthrough. No tour, no starter sheet, nothing between the button and
 *   something to watch.
 *   THE STANDARD FAVOURITES, matched on whole words — NBC, not CNBC — and no
 *   pay-per-view events, which will not exist on Tuesday.
 *   /tv OPENS AS GUEST on a screen that has never chosen, and as whoever was
 *   chosen on one that has.
 *
 * Its own box, so it can start with a channel list already cached and the
 * profile lock switched ON — the Guest must not need the password.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');
const { chromium } = require('./playwright.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-guest';
const PORT = 8488;
const BASE = `http://127.0.0.1:${PORT}`;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* The live list as the provider sends it, with the traps in it: CNBC holds
   NBC, ESPNU holds ESPN, a regional is longer than the plain feed, and a
   pay-per-view event names a network it is not. */
const NAMES = [
  'US| CNBC', 'US| NBC', 'US| ESPN', 'US| ESPNU', 'US| ESPN DEPORTES',
  'US| FOX SPORTS 1', 'US| CNN', 'US| HBO', 'US| ESPN PPV 1',
  'US| TNT', 'US| AMC', 'US| SHOPPING CHANNEL',
];
const ITEMS = NAMES.map((name, i) => ({
  kind: 'live', id: 300 + i, num: 300 + i, name, logo: '', categoryId: 'c1',
}));
/* LIBRARY_SHAPE, read from the source rather than copied, so a bump to it
   does not quietly turn this into a test of an empty cache. */
const SHAPE = /const LIBRARY_SHAPE = (\d+);/.exec(
  fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))[1];

function lay() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'downloads'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'cloudflare.js', 'college-teams.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'library-cache.json'), JSON.stringify({
    [`v${SHAPE}:live:`]: { at: Date.now(), payload: {
      categories: [{ id: 'c1', name: 'US| ENTERTAINMENT' }], items: ITEMS,
      totals: { items: ITEMS.length } } },
  }));
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '🦬', color: '', history: [],
      tourDone: true, liveTourDone: true, startersDone: true, reportNoticeSeen: true,
      dlExplainSeen: true, livePinsSeeded: true, favorites: [] }],
    /* Locked: adding a profile of your own needs the password. The Guest is
       not a profile of your own, and must not. */
    profileLock: true,
  }));
}

const call = (p, opts = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p,
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {} }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let data = {};
      try { data = JSON.parse(text); } catch { /* not json */ }
      resolve({ status: res.statusCode, text, data });
    });
  });
  req.on('error', reject);
  if (opts.body) req.write(JSON.stringify(opts.body));
  req.end();
});

(async () => {
  lay();
  let log = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: DIR, detached: true,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const stop = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } };

  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      try { await call('/api/profiles'); up = true; } catch { await wait(250); }
    }
    check('the box comes up', up, log.slice(-300));

    /* ---- the box makes one ------------------------------------------------ */
    console.log('\n  asking for the Guest');
    const first = await call('/api/profiles/guest', { method: 'POST' });
    console.log('   ', first.status, JSON.stringify(first.data));
    check('it is made, with the profile lock on and no password',
      first.status === 200 && first.data.created === true, `${first.status} ${first.text}`);
    check('and called Guest', first.data.name === 'Guest', first.data.name);

    const again = await call('/api/profiles/guest', { method: 'POST' });
    check('asking again hands back the same one, not a second',
      again.data.id === first.data.id && again.data.created === false, JSON.stringify(again.data));
    const list = (await call('/api/profiles')).data.profiles || [];
    check('so the box holds two profiles, not three',
      list.length === 2, list.map((p) => p.name).join(', '));

    /* ---- without the walkthrough ----------------------------------------- */
    const prefs = (await call(`/api/profiles/${first.data.id}/prefs`)).data;
    check('no tour', prefs.tourDone === true, String(prefs.tourDone));
    check('no Live TV note', prefs.liveTourDone === true, String(prefs.liveTourDone));
    check('no "pick a few things" sheet', prefs.startersDone === true, String(prefs.startersDone));
    check('and not the owner', prefs.owner === false, String(prefs.owner));

    /* ---- loaded with the standard favourites ----------------------------- */
    console.log('\n  the favourites it starts with');
    const names = (prefs.favorites || []).map((f) => f.item && f.item.name);
    console.log('   ', names.join(' · '));
    check('the networks are there', ['US| ESPN', 'US| NBC', 'US| CNN', 'US| HBO']
      .every((n) => names.includes(n)), names.join(', '));
    /* The traps. */
    check('NBC, not CNBC', !names.includes('US| CNBC'), names.join(', '));
    check('the plain ESPN, not ESPNU or the Spanish feed',
      !names.includes('US| ESPNU') && !names.includes('US| ESPN DEPORTES'), names.join(', '));
    check('no pay-per-view events', !names.some((n) => /PPV/.test(n)), names.join(', '));
    check('nothing that is not a network', !names.includes('US| SHOPPING CHANNEL'),
      names.join(', '));
    check('stored the way the browser stores a star — key and item',
      (prefs.favorites || []).every((f) => /^live:\d+$/.test(f.key) && f.item && f.item.kind === 'live'),
      JSON.stringify((prefs.favorites || [])[0]));

    /* A guest who unstars something keeps it unstarred. Seeding is once. */
    const fewer = (prefs.favorites || []).filter((f) => f.item.name !== 'US| HBO');
    await call(`/api/profiles/${first.data.id}/prefs`, { method: 'PUT', body: { favorites: fewer } });
    await call('/api/profiles/guest', { method: 'POST' });
    const after = (await call(`/api/profiles/${first.data.id}/prefs`)).data;
    check('and a channel the guest unstarred is not put back',
      !(after.favorites || []).some((f) => f.item.name === 'US| HBO'),
      (after.favorites || []).map((f) => f.item.name).join(', '));

    /* ---- the button ------------------------------------------------------ */
    console.log('\n  the button on the profile screen');
    browser = await chromium.launch();
    const stub = async (page) => {
      await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
      await page.route('**/api/scores**', (r) => r.fulfill({ status: 200,
        contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
      await page.route('**/api/epg/now**', (r) => r.fulfill({ status: 200,
        contentType: 'application/json', body: '{"channels":[],"busy":false}' }));
    };
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
    await stub(page);
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#profileGate:not([hidden])', { timeout: 15000 });
    await wait(2800);   // past the arrival animation
    const beside = await page.evaluate(() => {
      const m = document.querySelector('#manageBtn').getBoundingClientRect();
      const g = document.querySelector('#guestBtn').getBoundingClientRect();
      return { visible: g.width > 0 && !document.querySelector('#guestBtn').hidden,
        sameRow: Math.abs(m.top - g.top) < 4, rightOf: g.left > m.right,
        text: document.querySelector('#guestBtn').textContent.trim() };
    });
    console.log('   ', JSON.stringify(beside));
    check('there is a Guest button', beside.visible && beside.text === 'Guest',
      JSON.stringify(beside));
    check('next to Manage profiles', beside.sameRow && beside.rightOf, JSON.stringify(beside));

    await page.click('#guestBtn');
    await wait(2500);
    const inside = await page.evaluate(() => ({
      gate: document.querySelector('#profileGate').hidden,
      chip: document.querySelector('#chipName')?.textContent.trim(),
      tour: document.querySelector('#tour').hidden,
      starter: document.querySelector('#starter').hidden,
      remembered: localStorage.getItem('portal.profile'),
    }));
    console.log('   ', JSON.stringify(inside));
    check('pressing it goes straight in', inside.gate === true, JSON.stringify(inside));
    check('as Guest', inside.chip === 'Guest', String(inside.chip));
    check('with no tour over the page', inside.tour === true, String(inside.tour));
    check('and no starter sheet either', inside.starter === true, String(inside.starter));
    check('the device remembers the Guest like any other pick',
      inside.remembered === first.data.id, String(inside.remembered));
    await page.close();

    /* ---- /tv ------------------------------------------------------------- */
    console.log('\n  /tv');
    const tvName = async (setup) => {
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const tv = await ctx.newPage();
      tv.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
      await stub(tv);
      if (setup) await tv.addInitScript(setup);
      await tv.goto(`${BASE}/tv/`);
      await tv.waitForFunction(() => {
        const n = document.querySelector('#profileName');
        return n && n.textContent.trim() && n.textContent.trim() !== '—';
      }, null, { timeout: 15000 });
      const name = await tv.evaluate(() => document.querySelector('#profileName').textContent.trim());
      await ctx.close();
      return name;
    };
    /* The box's `current` is Guest by now, from the button above — so to tell
       "fell back to current" from "opened as Guest", it is put back to Hunter. */
    await call('/api/profiles/current', { method: 'PUT', body: { id: 'own1' } });
    const fresh = await tvName(null);
    console.log('    a screen that has never chosen opens as', fresh);
    check('a screen that has never chosen opens as the Guest', fresh === 'GUEST', fresh);
    check('without making the Guest who the house is watching',
      (await call('/api/profiles')).data.current === 'own1',
      String((await call('/api/profiles')).data.current));
    const chosen = await tvName(() => localStorage.setItem('portal.profile', 'own1'));
    console.log('    a screen where Hunter was chosen opens as', chosen);
    check('one where somebody was chosen opens as them', chosen === 'HUNTER', chosen);
    const gone = await tvName(() => localStorage.setItem('portal.profile', 'p-deleted'));
    check('and one remembering a profile that no longer exists opens as Guest',
      gone === 'GUEST', gone);
  } catch (err) {
    console.log('  HARNESS ERROR', err.message);
    fails.push('harness');
  } finally {
    if (browser) await browser.close().catch(() => {});
    stop();
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})();
