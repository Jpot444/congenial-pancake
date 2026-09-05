/**
 * One profile, whichever way you come in.
 *
 * "I want all my profiles across my shield, 100. address, and
 *  tv.treasurestate address synched so that no matter what device or way i
 *  click on to my service they are always the same and updated"
 *
 * The data was never the problem — all three addresses are one Raspberry Pi
 * and one profiles.json. Two other things were.
 *
 *   WHO IS WATCHING was remembered in localStorage, which sounds device-wide
 *   and is not: `http://100.68.175.115:8420` and
 *   `https://tv.treasurestatecapital.com` are different ORIGINS, and a browser
 *   keeps a separate store for each. The same television on the two addresses
 *   had two separate memories of who it was, and no way to reconcile them —
 *   browsers do not permit it. So the answer moved to the box, which all three
 *   can see.
 *
 *   NOTHING EVER RE-READ. Both front ends fetched the profile and its prefs
 *   once at startup and held them for the session. A series rated on the phone
 *   was invisible on the Shield until it was relaunched — and worse, the stale
 *   one would eventually PUT its whole out-of-date favourites list back over
 *   the fresh one, so a favourite added in one room could be silently undone
 *   from another an hour later.
 *
 * The box now carries a change counter. Every device polls one small call and
 * compares it: same number, nothing to do; different number, re-read. The
 * device that CAUSED a change is told the number its own write produced, so it
 * does not go and fetch its own change back as though it were news.
 *
 * Everything below drives the real HTTP API, because the sync is the API.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-sync';
const PORT = 8476;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: p,
      method,
      headers: payload ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { /* not json */ }
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const GET = (p) => call('GET', p);
const PUT = (p, b) => call('PUT', p, b);
const POST = (p, b) => call('POST', p, b);

const up = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { await GET('/api/health'); return true; } catch { await wait(250); }
  }
  return false;
};

/* Nothing else may be on this port — a stranger's box would answer every one
   of these calls just as happily and agree with itself throughout. */
const portFree = async () => {
  try { await GET('/api/health'); return false; } catch { return true; }
};

(async () => {
  if (!await portFree()) {
    console.log(`  something is already answering on ${PORT}. Stop it.`);
    process.exit(1);
  }

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'downloads'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u', host: '', username: '', password: '',
  }), { mode: 0o600 });
  /* Two people, because "one profile everywhere" is only interesting when
     there is more than one to be wrong about. */
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [
      { id: 'own1', name: 'Hunter', emoji: '🐂', color: '#A21F24', prefs: {}, history: [], favorites: [] },
      { id: 'own2', name: 'Kid', emoji: '🎯', color: '#2B4C7E', prefs: {}, history: [], favorites: [] },
    ],
  }));

  const box = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!await up()) throw new Error('the box did not come up');

    /* ---- 1. a box that has never been told ------------------------------ */
    /*
     * The upgrade case. profiles.json here has no `current` at all, exactly as
     * every existing box's does — nothing may crash, and nobody is claimed to
     * be watching.
     */
    console.log('\n  a box upgraded from before any of this');
    let list = (await GET('/api/profiles')).body;
    console.log('   current:', JSON.stringify(list.current), '· rev:', list.rev);
    check('answers with nobody watching rather than guessing',
      list.current === '', JSON.stringify(list.current));
    check('and carries a change counter', Number.isFinite(list.rev), JSON.stringify(list.rev));
    check('and still lists both profiles', (list.profiles || []).length === 2);

    /* ---- 2. one address picks; every address agrees --------------------- */
    /*
     * This is the whole request. The Tailscale address, the domain and the
     * Shield are three different origins to a browser and cannot read each
     * other's storage — so the answer has to come from here.
     */
    console.log('\n  the Shield picks Hunter');
    const said = (await PUT('/api/profiles/current', { id: 'own1' })).body;
    console.log('   box says:', JSON.stringify(said));
    check('the box takes the pick', said.current === 'own1', JSON.stringify(said));
    check('and hands back the counter that write produced',
      Number.isFinite(said.rev) && said.rev > list.rev, JSON.stringify(said));

    /* Whatever asks next — the phone on the domain, the laptop on the
       Tailscale address — gets the same answer. There is only one. */
    const asAgain = (await GET('/api/profiles')).body;
    check('every other way in reads the same person', asAgain.current === 'own1', asAgain.current);

    /* ---- 3. picking again is not news ----------------------------------- */
    /*
     * Every device confirms who it is on the way in. If that moved the
     * counter, four devices would keep telling each other something had
     * changed for ever.
     */
    console.log('\n  and a device confirming what it already knows');
    const echo = (await PUT('/api/profiles/current', { id: 'own1' })).body;
    check('does not move the counter', echo.rev === said.rev,
      `${said.rev} -> ${echo.rev}`);

    /* ---- 4. a change in one room reaches the others ---------------------- */
    console.log('\n  a favourite added on the phone');
    const before = (await GET('/api/profiles')).body.rev;
    const saved = (await PUT('/api/profiles/own1/prefs',
      { favorites: ['live:401'] })).body;
    const after = (await GET('/api/profiles')).body.rev;
    console.log(`   rev ${before} -> ${after}`);
    check('moves the counter, which is how the Shield finds out',
      after > before, `${before} -> ${after}`);
    check('and the writer is told the number it caused, so it does not '
      + 'chase its own change', saved.rev === after, `${saved.rev} vs ${after}`);
    const prefs = (await GET('/api/profiles/own1/prefs')).body;
    check('and the favourite is there for whoever reads next',
      (prefs.favorites || []).includes('live:401'), JSON.stringify(prefs.favorites));

    /* A rating is the other thing the request named, and it goes the same
       way — the counter is what the other rooms are watching. */
    console.log('\n  and a series rated on the laptop');
    const beforeRating = (await GET('/api/profiles')).body.rev;
    const rated = (await POST('/api/profiles/own1/rating',
      { key: 'series:88', value: 1 })).body;
    const afterRating = (await GET('/api/profiles')).body.rev;
    check('moves the counter too', afterRating > beforeRating,
      `${beforeRating} -> ${afterRating}`);
    check('and hands back its own number as well',
      rated.rev === afterRating, `${rated.rev} vs ${afterRating}`);

    /* ---- 5. switching in one room switches the house -------------------- */
    console.log('\n  the kid picks their own profile in the front room');
    await PUT('/api/profiles/current', { id: 'own2' });
    const now = (await GET('/api/profiles')).body;
    check('and every device now reads the kid', now.current === 'own2', now.current);
    check('the counter moved, so they all notice', now.rev > afterRating,
      `${afterRating} -> ${now.rev}`);

    /* ---- 6. an id that is not a profile --------------------------------- */
    console.log('\n  and the things that must not happen');
    const bogus = await PUT('/api/profiles/current', { id: 'nobody' });
    check('a profile that does not exist is refused', bogus.status === 404,
      String(bogus.status));
    check('and the current one is untouched',
      (await GET('/api/profiles')).body.current === 'own2');

    /*
     * "current" is a word, not an id. The route that looks up a profile by id
     * sits right behind this one and would happily 404 on it.
     */
    const asId = await GET('/api/profiles/current');
    check('/api/profiles/current is not mistaken for a profile named current',
      asId.status === 200 && asId.body.current === 'own2',
      `${asId.status} ${JSON.stringify(asId.body)}`);

    /* A deleted profile must not leave every device pointed at nothing. */
    console.log('\n  and the profile the box was showing gets deleted');
    const gone = await call('DELETE', '/api/profiles/own2');
    console.log('   delete answered', gone.status);
    const orphaned = (await GET('/api/profiles')).body;
    check('the box says nobody rather than naming a profile that is gone',
      orphaned.current === '', JSON.stringify(orphaned.current));

    /* ---- 7. both front ends actually use it ------------------------------ */
    /*
     * The API can be perfect and the televisions still disagree. These read
     * the shipped source: the browser portal and the Shield app must both take
     * the box's answer, tell it when they change, and poll.
     */
    console.log('\n  and both front ends are wired to it');
    const app = fs.readFileSync(PATHS.APP, 'utf8');
    check('the portal prefers the box over its own storage',
      /res\.current \|\| localStorage\.getItem\('portal\.profile'\)/.test(app),
      'app.js still reads localStorage first');
    check('the portal tells the box when somebody picks',
      /fetch\('\/api\/profiles\/current'/.test(app));
    check('and polls for what the other rooms did',
      /profiles\.watch\(\)/.test(app) && /async follow\(\)/.test(app));
    /* A profile change under a film is the one moment when being right
       instantly is worse than being right in a minute. */
    check('but never yanks the profile out from under something playing',
      /pendingHandOver/.test(app), 'handOver reloads mid-playback');
    /*
     * And it must not redraw the page under a film either.
     *
     * Playback reports its position every fifteen seconds, which moves the
     * counter like any other write — but it goes out by sendBeacon, which has
     * no reply, so this device cannot learn the number its own heartbeat
     * caused. Acting on the difference would rebuild the page under the
     * viewer four times a minute. The counter is deliberately not taken while
     * the player is up, so the difference is still there to act on afterwards.
     */
    check('and does not redraw itself while the player is up',
      /const overlay = \$\('#playerOverlay'\);[\s\S]{0,200}?overlay && !overlay\.hidden[\s\S]{0,120}?return undefined;/
        .test(app),
      'the poll acts on the counter during playback');
    /* Multi-view is four things playing, and a cell holding a film reports its
       position on the same heartbeat — so it needs the same exemption, and
       without it the page was rebuilt under the grid four times a minute. */
    check('nor while multi-view is up, which is four of them',
      /const grid = \$\('#multiview'\);[\s\S]{0,200}?grid && !grid\.hidden[\s\S]{0,60}?return undefined;/
        .test(app),
      'the poll acts on the counter under the multi-view grid');
    check('and catches up when the player closes',
      /profiles\.follow\(\)\.catch/.test(app), 'closePlayer does not catch up');

    const tv = fs.readFileSync(path.join(ROOT, 'public/tv/js/state.js'), 'utf8');
    check('the Shield prefers the box too',
      /data\.current \|\| localStorage\.getItem\(PROFILE_KEY\)/.test(tv),
      'tv/state.js still reads localStorage first');
    check('and has something to poll with', /export async function followBox/.test(tv));
    const tvApp = fs.readFileSync(path.join(ROOT, 'public/tv/js/app.js'), 'utf8');
    check('which the Shield actually calls', /followBox\(\{ playing \}\)/.test(tvApp));
    check('and stands down while something is playing',
      /state\.screen === 'player' \|\| state\.screen === 'multi'/.test(tvApp));

    console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  } finally {
    /*
     * Killed here and NOT before a process.exit inside the try — exit runs
     * immediately and skips finally, which leaves the box it started answering
     * on this port for ever. The next run of this suite then refuses to start,
     * or worse, measures the stranger.
     */
    box.kill('SIGKILL');
  }
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
