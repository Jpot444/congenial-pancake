/**
 * Downloads belong to a profile, not to the house.
 *
 * "the downloads folder should be profile specific not a shared downloads
 *  folder"
 *
 * Every job has always recorded the profile that queued it — the 20GB
 * allowance is counted from it — but nothing ever READ that when handing the
 * list back. So Downloads was one pile: everybody saw everybody's, and every
 * per-job route took an id without asking who was holding it, which meant
 * anyone could pause, retry, delete or play anyone's.
 *
 * Three decisions shape what is checked here, and each was asked rather than
 * assumed:
 *
 *   THE OWNER CAN STILL CLEAR THE DRIVE. Strict separation has one problem on
 *   a Pi: a child's 20GB would be invisible to the person who has to free the
 *   disk. So the owner — and nobody else, here and on the box — can switch to
 *   everyone's, with whose each row is on it. Off by default.
 *
 *   ONE FILE, TWO HOLDERS. The Pi keeps one copy of each title and the
 *   allowance is per head, so two people wanting the same film must not cost
 *   the drive twice. Both hold it, both see it, both are charged, and the file
 *   goes when the last of them lets go. A flat refusal would be worse than
 *   useless now: "already downloaded" about something you cannot see is a dead
 *   end with nothing to press.
 *
 *   AND NOTHING ALREADY ON THE BOX DISAPPEARS. Downloads that predate this
 *   have one profile field and some predate PROFILES, or name one since
 *   deleted. Those fall to the owner rather than to nobody.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const PATHS = require('./paths.js');

const BOX_PORT = 8473;
const BOX_DIR = '/tmp/portal-dlprofiles';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, p, body) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = http.request({
    host: '127.0.0.1', port: BOX_PORT, path: p, method, timeout: 20000,
    headers: payload ? { 'content-type': 'application/json' } : {},
  }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
      resolve({ status: res.statusCode, body: parsed });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

/*
 * Downloads already on the box when this shipped. Written straight into the
 * index the box reads at boot, because the whole point of the first section is
 * what happens to jobs that were there BEFORE any of this existed.
 *
 *   old-hunter  queued by the owner, the ordinary case
 *   old-kid     queued by somebody else
 *   old-ghost   a profile that has since been deleted
 *   old-none    queued before jobs recorded a profile at all
 */
const EXISTING = [
  { id: 'old-hunter', name: 'Redwood Gulch', kind: 'movie', streamId: '700', ext: 'mp4',
    file: 'old-hunter.mp4', status: 'done', bytes: 1e9, total: 1e9, profileId: 'own1',
    createdAt: 4 },
  { id: 'old-kid', name: 'Custard Pie', kind: 'movie', streamId: '701', ext: 'mp4',
    file: 'old-kid.mp4', status: 'done', bytes: 2e9, total: 2e9, profileId: 'own2',
    createdAt: 3 },
  { id: 'old-ghost', name: 'Dry Season', kind: 'movie', streamId: '702', ext: 'mp4',
    file: 'old-ghost.mp4', status: 'done', bytes: 1e9, total: 1e9, profileId: 'gone99',
    createdAt: 2 },
  { id: 'old-none', name: 'The Hollow', kind: 'movie', streamId: '703', ext: 'mp4',
    file: 'old-none.mp4', status: 'done', bytes: 1e9, total: 1e9, profileId: '',
    createdAt: 1 },
];

const names = (rows) => (rows || []).map((j) => j.name).sort();

(async () => {
  /* ---- a box with a history ------------------------------------------- */
  fs.rmSync(BOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BOX_DIR, 'downloads'), { recursive: true });
  fs.cpSync(path.join(PATHS.ROOT, 'public'), path.join(BOX_DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'market.js']) {
    fs.copyFileSync(path.join(PATHS.ROOT, f), path.join(BOX_DIR, f));
  }
  fs.copyFileSync(path.join(PATHS.ROOT, 'college-teams.json'),
    path.join(BOX_DIR, 'college-teams.json'));
  fs.writeFileSync(path.join(BOX_DIR, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u', host: '', username: '', password: '',
  }), { mode: 0o600 });
  /* Hunter is the owner — the box decides that by name, not by a flag anybody
     can edit from the profile screen. */
  fs.writeFileSync(path.join(BOX_DIR, 'profiles.json'), JSON.stringify({
    profiles: [
      { id: 'own1', name: 'Hunter', prefs: { tourDone: true }, history: [] },
      { id: 'own2', name: 'Kid', prefs: { tourDone: true }, history: [] },
    ],
  }));
  fs.writeFileSync(path.join(BOX_DIR, 'downloads', 'index.json'),
    JSON.stringify(EXISTING));
  /* Named after the job id, which is how the box names them — jobPaths builds
     `<id>.<ext>` and a finished job's `file` holds that. A fixture that made
     up its own names would have the delete looking in the right place and
     finding nothing. */
  for (const job of EXISTING) {
    fs.writeFileSync(path.join(BOX_DIR, 'downloads', job.file), 'x');
  }

  const box = spawn('node', ['server.js'], {
    cwd: BOX_DIR,
    env: { ...process.env, PORT: String(BOX_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      try { await call('GET', '/api/health'); up = true; } catch { await wait(250); }
    }
    if (!up) throw new Error('the box did not come up');

    /* ---- 1. what was already there ------------------------------------ */
    console.log('\n  the downloads that were already on the box');
    const mine = await call('GET', '/api/downloads?profileId=own1');
    const theirs = await call('GET', '/api/downloads?profileId=own2');
    console.log('    Hunter:', JSON.stringify(names(mine.body.items)));
    console.log('    Kid:   ', JSON.stringify(names(theirs.body.items)));
    check('the owner keeps the one they queued',
      names(mine.body.items).includes('Redwood Gulch'), JSON.stringify(names(mine.body.items)));
    check('and the other profile keeps theirs',
      names(theirs.body.items).join() === 'Custard Pie', JSON.stringify(names(theirs.body.items)));
    /* The strays. A job whose profile no longer exists, and one from before
       jobs had a profile at all, would otherwise be in nobody's list — on the
       drive, taking up room, invisible to everyone. */
    check('a job from a deleted profile falls to the owner',
      names(mine.body.items).includes('Dry Season'), JSON.stringify(names(mine.body.items)));
    check('and so does one from before jobs recorded a profile',
      names(mine.body.items).includes('The Hollow'), JSON.stringify(names(mine.body.items)));
    check('so nothing on the drive is in nobody’s list',
      names(mine.body.items).length + names(theirs.body.items).length === EXISTING.length,
      `${names(mine.body.items).length} + ${names(theirs.body.items).length}`);

    /* ---- 2. the list is not the whole box ----------------------------- */
    console.log('\n  and what each profile is NOT shown');
    check('the owner is not shown the other profile’s',
      !names(mine.body.items).includes('Custard Pie'), JSON.stringify(names(mine.body.items)));
    check('and they are not shown the owner’s',
      !names(theirs.body.items).includes('Redwood Gulch'), JSON.stringify(names(theirs.body.items)));
    /* A caller that has not said who it is used to get everything. */
    const anon = await call('GET', '/api/downloads');
    check('a request that does not say who it is gets nothing, not everything',
      (anon.body.items || []).length === 0, JSON.stringify(names(anon.body.items)));

    /* ---- 3. the owner clearing the drive ------------------------------ */
    /*
     * The one exception, and the reason for it: somebody has to be able to
     * free a disk a child has filled.
     */
    console.log('\n  the owner looking at the whole drive');
    const all = await call('GET', '/api/downloads?profileId=own1&all=1');
    console.log('    all:', JSON.stringify(names(all.body.items)));
    check('the owner can see every profile’s',
      names(all.body.items).length === EXISTING.length, JSON.stringify(names(all.body.items)));
    check('and is told the switch exists', all.body.canSeeAll === true,
      JSON.stringify(all.body.canSeeAll));
    /* Whose, on the rows that are not theirs — so it reads as somebody else's
       rather than as more of your own. */
    const notMine = (all.body.items || []).find((j) => j.id === 'old-kid');
    check('with whose each of the others is', notMine && notMine.whose === 'Kid',
      JSON.stringify(notMine && notMine.whose));
    check('and nothing of their own dressed up as somebody else’s',
      !(all.body.items || []).find((j) => j.id === 'old-hunter').whose,
      'the owner’s own row was labelled');

    const nope = await call('GET', '/api/downloads?profileId=own2&all=1');
    check('and nobody else can ask for that view',
      names(nope.body.items).join() === 'Custard Pie', JSON.stringify(names(nope.body.items)));
    check('nor is anybody else told it exists', nope.body.canSeeAll === false,
      JSON.stringify(nope.body.canSeeAll));

    /* ---- 4. a list you cannot act on is decoration --------------------- */
    /*
     * Filtering the list and leaving the routes open would be a rule that only
     * holds while nobody looks — the ids are in anybody's list.
     */
    console.log('\n  and the routes behind it');
    const steal = await call('DELETE', '/api/downloads/old-hunter?profileId=own2');
    check('somebody else cannot delete the owner’s download', steal.status === 404,
      `${steal.status}`);
    const grab = await call('POST', '/api/downloads/old-hunter/pause?profileId=own2');
    check('nor pause it', grab.status === 404, `${grab.status}`);
    const still = await call('GET', '/api/downloads?profileId=own1');
    check('and it is still there afterwards',
      names(still.body.items).includes('Redwood Gulch'), JSON.stringify(names(still.body.items)));

    /* ---- 5. two profiles, one film ------------------------------------ */
    /*
     * The Pi holds one copy and the allowance is per head. Asking for
     * something somebody else already has gives you a claim on the same file,
     * not a second copy and not a refusal you cannot act on.
     */
    console.log('\n  and when two people want the same film');
    const shared = await call('POST', '/api/downloads', {
      name: 'Redwood Gulch', kind: 'movie', streamId: '700', ext: 'mp4',
      profileId: 'own2',
    });
    console.log('    asked as the Kid:', shared.status, JSON.stringify(shared.body.shared));
    check('the second profile is given it rather than refused',
      shared.status === 200 && shared.body.shared === true,
      `${shared.status} ${JSON.stringify(shared.body).slice(0, 120)}`);
    check('and it is the same job, not a second download',
      shared.body.id === 'old-hunter', shared.body.id);

    const kidNow = await call('GET', '/api/downloads?profileId=own2');
    check('it is in their Downloads now',
      names(kidNow.body.items).includes('Redwood Gulch'), JSON.stringify(names(kidNow.body.items)));
    const ownerNow = await call('GET', '/api/downloads?profileId=own1');
    check('and still in the owner’s',
      names(ownerNow.body.items).includes('Redwood Gulch'),
      JSON.stringify(names(ownerNow.body.items)));

    /* ---- 6. letting go is not deleting -------------------------------- */
    /*
     * One file, two holders. Somebody clearing it out of their own Downloads
     * is saying they are done with it, not that the other person is.
     */
    console.log('\n  and when one of them lets go');
    const released = await call('DELETE', '/api/downloads/old-hunter?profileId=own2');
    console.log('    the Kid removes it:', JSON.stringify(released.body));
    check('the claim goes', released.status === 200 && released.body.removed === true,
      JSON.stringify(released.body));
    check('but the file stays, because somebody still holds it',
      released.body.keptFile === true, JSON.stringify(released.body));
    check('and it says who', /Hunter/.test(released.body.stillHeldBy || ''),
      String(released.body.stillHeldBy));
    check('the file is still on the drive',
      fs.existsSync(path.join(BOX_DIR, 'downloads', 'old-hunter.mp4')), 'the file was deleted');

    const gone = await call('DELETE', '/api/downloads/old-hunter?profileId=own1');
    check('and the last holder letting go takes the file with it',
      gone.status === 200 && !gone.body.keptFile, JSON.stringify(gone.body));
    await wait(200);
    check('which is gone from the drive',
      !fs.existsSync(path.join(BOX_DIR, 'downloads', 'old-hunter.mp4')), 'the file is still there');

    /* ---- 7. and it survives a restart --------------------------------- */
    /*
     * The owner list is written to the index like everything else. A box that
     * forgot it would re-run the migration on the next boot and hand every
     * shared title back to whoever asked first.
     */
    console.log('\n  after a restart');
    const before = await call('GET', '/api/downloads?profileId=own2');
    box.kill('SIGKILL');
    await wait(400);
    const again = spawn('node', ['server.js'], {
      cwd: BOX_DIR,
      env: { ...process.env, PORT: String(BOX_PORT), HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      let back = false;
      for (let i = 0; i < 40 && !back; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        try { await call('GET', '/api/health'); back = true; } catch { await wait(250); }
      }
      const after = await call('GET', '/api/downloads?profileId=own2');
      console.log('    Kid before:', JSON.stringify(names(before.body.items)),
        '→ after:', JSON.stringify(names(after.body.items)));
      check('the split is remembered',
        names(after.body.items).join() === names(before.body.items).join(),
        JSON.stringify(names(after.body.items)));
    } finally {
      again.kill('SIGKILL');
    }
  } finally {
    box.kill('SIGKILL');
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
