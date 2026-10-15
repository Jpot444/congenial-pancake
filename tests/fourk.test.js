/**
 * A 4K row in Movies.
 *
 * "In movies add a 4K category where all the 4K US movies go"
 *
 * Driven end to end, through a stand-in provider panel, because the decision
 * is the BOX's: it is where the category names are, and both the browser and
 * the television read the answer (`us4k`) rather than each guessing.
 *
 *   4K   — by the title's own tag, or by the category it is filed in.
 *   US   — filed as US or English, by category or by the title's tags.
 *
 * And the case that would quietly lose films: a 4K category that is plainly
 * US but does not start "EN -" ("US | 4K MOVIES") used to be dropped by the
 * language filter before anything else saw it.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');
const { chromium } = require('./playwright.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-fourk';
const PORT = 8472;
const PANEL = 9472;
const BASE = `http://127.0.0.1:${PORT}`;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CATS = [
  { category_id: '1', category_name: 'EN - ACTION' },
  { category_id: '2', category_name: 'EN - NEW RELEASES' },
  { category_id: '3', category_name: 'US | 4K MOVIES' },
  { category_id: '4', category_name: 'FR - 4K FILMS' },
  { category_id: '5', category_name: 'DE - ACTION' },
];
const now = Math.floor(Date.now() / 1000);
const MOVIES = [
  { stream_id: 11, name: 'EN - Dune Part Two 4K', category_id: '1', added: now - 100 },
  { stream_id: 12, name: 'EN - Dune Part Two', category_id: '1', added: now - 100 },
  { stream_id: 13, name: 'Oppenheimer', category_id: '3', added: now - 50 },
  { stream_id: 14, name: 'Amelie 4K', category_id: '4', added: now - 10 },
  { stream_id: 15, name: 'EN - Heat', category_id: '2', added: now - 20 },
  { stream_id: 16, name: 'DE - Das Boot 4K', category_id: '5', added: now - 30 },
].map((m) => ({ ...m, stream_icon: '', container_extension: 'mkv', rating: '7' }));

(async () => {
  const panel = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_vod_categories') return res.end(JSON.stringify(CATS));
    if (action === 'get_vod_streams') return res.end(JSON.stringify(MOVIES));
    if (action) return res.end('[]');
    return res.end(JSON.stringify({ user_info: { auth: 1, status: 'Active',
      exp_date: String(now + 86400 * 30), max_connections: '2' }, server_info: {} }));
  });
  await new Promise((r) => panel.listen(PANEL, '127.0.0.1', r));

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'downloads'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'cloudflare.js', 'college-teams.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`, username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', history: [],
      tourDone: true, liveTourDone: true, startersDone: true, reportNoticeSeen: true,
      dlExplainSeen: true, livePinsSeeded: true, prefs: {} }],
    current: { id: 'own1', at: Date.now() },
  }));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: DIR, detached: true,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const stop = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } };

  let browser = null;
  try {
    for (let i = 0; i < 80; i += 1) {
      try { await fetch(`${BASE}/api/profiles`); break; } catch { await wait(250); }
    }

    /* ---- what the box decides ------------------------------------------------ */
    console.log('\n  what the box decides');
    const lib = await (await fetch(`${BASE}/api/library?tab=movies`)).json();
    const byId = new Map((lib.items || []).map((i) => [i.id, i]));
    const cats = (lib.categories || []).map((c) => c.name);
    console.log('    categories:', cats.join(' · '));
    console.log('    us4k:', (lib.items || []).map((i) => `${i.id}:${i.us4k}`).join(' '));
    check('a US 4K category that does not start "EN -" is kept, not filtered away',
      cats.includes('US | 4K MOVIES'), cats.join(', '));
    check('a foreign 4K category is still left out', !cats.includes('FR - 4K FILMS'),
      cats.join(', '));
    check('and so are foreign categories generally', !cats.includes('DE - ACTION'));
    check('a 4K-tagged film in an English category is a 4K US film', byId.get(11)?.us4k === true,
      JSON.stringify(byId.get(11)));
    check('its HD copy is not', byId.get(12)?.us4k === false, JSON.stringify(byId.get(12)));
    check('an untagged film filed in "US | 4K MOVIES" is, by its category',
      byId.get(13)?.us4k === true, JSON.stringify(byId.get(13)));
    check('an ordinary English film is not', byId.get(15)?.us4k === false);
    check('and no foreign 4K film reached the library at all', !byId.has(14) && !byId.has(16));

    /* ---- the browser --------------------------------------------------------- */
    console.log('\n  the Movies page');
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
    await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
    await page.addInitScript(() => {
      localStorage.setItem('portal.profile', 'own1');
      sessionStorage.setItem('portal.profile', 'own1');
      localStorage.setItem('portal.layout', 'desk');
    });
    await page.goto(`${BASE}/#/movies`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof buildShelves === 'function'
      && state.library.movies && state.library.movies.items.length, null, { timeout: 20000 });
    const rows = await page.evaluate(() => buildShelves('movies')
      .map((r) => ({ title: r.title, names: r.items.map((i) => i.name), uhd: r.items.map((i) => i.uhd) })));
    const fourK = rows.find((r) => r.title === '4K');
    console.log('   ', rows.map((r) => `${r.title}(${r.names.length})`).join(' · '));
    check('there is a 4K row', Boolean(fourK), rows.map((r) => r.title).join(', '));
    check('holding exactly the 4K US films, one card per title',
      fourK && fourK.names.length === 2 && fourK.names.includes('Oppenheimer')
        && fourK.names.some((n) => /Dune/.test(n)), JSON.stringify(fourK));
    check('newest first', fourK && fourK.names[0] === 'Oppenheimer', JSON.stringify(fourK?.names));
    const at = rows.findIndex((r) => r.title === '4K');
    const nr = rows.findIndex((r) => r.title === 'New Releases');
    check('right after New Releases', nr >= 0 && at === nr + 1, `${nr} / ${at}`);
    /* On the desktop the category bar IS the shelves, so the row is a chip there
       too, and opening it is a grid. */
    await page.waitForSelector('#dkChips .catchip', { timeout: 10000 }).catch(() => {});
    const chip = await page.evaluate(() => [...document.querySelectorAll('#dkChips .catchip')]
      .map((c) => c.textContent.trim()).find((t) => /^4K/.test(t)) || null);
    check('and a chip in the category bar', Boolean(chip), String(chip));

    /* ---- the television ------------------------------------------------------- */
    console.log('\n  the television');
    const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await tv.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
    await tv.addInitScript(() => localStorage.setItem('portal.profile', 'own1'));
    await tv.goto(`${BASE}/tv/`);
    await tv.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 15000 }).catch(() => {});
    /* A remote app: clicking a pill moves the focus there, and OK opens it. */
    await tv.evaluate(() => document.querySelector('#nav [data-screen="movies"]')?.click());
    await tv.keyboard.press('Enter');
    await tv.waitForFunction(() => [...document.querySelectorAll('.rowhead h2')]
      .some((h) => h.textContent.trim() === '4K'), null, { timeout: 15000 }).catch(() => {});
    const tvRows = await tv.evaluate(() => [...document.querySelectorAll('.rowhead h2')].map((h) => h.textContent.trim()));
    console.log('   ', tvRows.join(' · '));
    check('the television has the same 4K row', tvRows.includes('4K'), tvRows.join(', '));
  } catch (err) {
    console.log('  HARNESS ERROR', err.message);
    fails.push('harness');
  } finally {
    if (browser) await browser.close().catch(() => {});
    stop();
    panel.close();
  }
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})();
