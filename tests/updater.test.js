/**
 * The thing that delivers everything else.
 *
 * The Pi has no public address, so a push does not reach it — it asks, every
 * couple of minutes, and applies what it finds. Every feature in this
 * project arrives through this one shell script, and until now nothing
 * tested it: the only evidence it worked was that things eventually showed
 * up, and the only evidence it had stopped was that they didn't.
 *
 * Run against a real git origin, a real clone, a fake pm2 that records what
 * it was told, and a fake portal that can claim to be busy on demand. What
 * is under test is the DECISION — apply, hold, or leave alone — and the
 * report it leaves behind for the health panel.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const PATHS = require('./paths.js');
const http = require('http');
const path = require('path');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-upd';
const PORT = 8489;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

(async () => {
  /* ---- a world for it to run in ---------------------------------------- */
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'origin'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'bin'), { recursive: true });

  // The origin: a real repository, published to and pulled from for real.
  const origin = path.join(DIR, 'origin');
  git(origin, 'init', '--quiet', '--bare', '-b', 'main');

  const seed = path.join(DIR, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '--quiet', '-b', 'main');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(seed, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'auto-update.sh'),
    path.join(seed, 'scripts', 'auto-update.sh'));
  fs.chmodSync(path.join(seed, 'scripts', 'auto-update.sh'), 0o755);
  fs.writeFileSync(path.join(seed, 'app.txt'), 'version one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'first');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'main');

  // The box: a clone, exactly as the Pi holds one.
  const box = path.join(DIR, 'box');
  git(DIR, 'clone', '--quiet', origin, box);
  git(box, 'config', 'user.email', 'pi@example.com');
  git(box, 'config', 'user.name', 'Pi');

  // A pm2 that only records. The real one restarts the portal; what matters
  // to this test is whether it was ASKED to.
  fs.writeFileSync(path.join(DIR, 'bin', 'pm2'), `#!/bin/bash
echo "$@" >> "${DIR}/pm2-calls.log"
exit 0
`, { mode: 0o755 });

  // A portal that answers /api/activity, and can be told to look busy — or
  // to be part way through writing a recording, which is a different kind of
  // busy with an end it can name.
  let busy = false;
  let recordingUntil = null;
  const portal = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ busy, streaming: busy && !recordingUntil, watching: false,
      downloading: false, playingLocal: false,
      recording: Boolean(recordingUntil), recordingUntil }));
  });
  await new Promise((r) => portal.listen(PORT, '127.0.0.1', r));

  const runUpdate = (env = {}) => new Promise((resolve) => {
    const proc = spawn('bash', [path.join(box, 'scripts', 'auto-update.sh')], {
      cwd: box,
      env: { ...process.env, PORT: String(PORT), PM2_APP: 'iptv-portal',
        PATH: `${path.join(DIR, 'bin')}:${process.env.PATH}`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('exit', (code) => resolve({ code, err }));
  });

  const state = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(box, '.auto-update-state.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const restarts = () => {
    try {
      return fs.readFileSync(path.join(DIR, 'pm2-calls.log'), 'utf8')
        .split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const publish = (text, message) => {
    fs.writeFileSync(path.join(seed, 'app.txt'), text);
    git(seed, 'commit', '--quiet', '-am', message);
    git(seed, 'push', '--quiet', 'origin', 'main');
  };
  const onBox = () => fs.readFileSync(path.join(box, 'app.txt'), 'utf8').trim();

  try {
    /* ---- nothing new ---------------------------------------------------- */
    console.log('\n  with nothing published');
    let out = await runUpdate();
    check('it runs cleanly', out.code === 0, out.err.slice(0, 200));
    check('nothing is restarted', restarts() === 0, `${restarts()} restarts`);
    check('and it reports the box as up to date', state()?.state === 'current',
      JSON.stringify(state()));

    /* ---- a push, on an idle box ----------------------------------------- */
    console.log('\n  a push, on an idle box');
    publish('version two\n', 'second');
    out = await runUpdate();
    check('the new version is on the box', onBox() === 'version two', onBox());
    check('the portal was restarted for it', restarts() === 1, `${restarts()} restarts`);
    const applied = state();
    console.log('   ', JSON.stringify(applied));
    check('and it reports the update as applied', applied?.state === 'applied',
      JSON.stringify(applied));
    check('naming the version that landed',
      Boolean(applied?.appliedSha) && applied.appliedSha === applied.remote,
      JSON.stringify(applied));
    check('with a timestamp the panel can age', applied.appliedAt > 0
      && Date.now() - applied.appliedAt < 60000, String(applied?.appliedAt));

    /* ---- a push while somebody is watching ------------------------------ */
    //
    // The whole reason the hold exists: a restart cuts off whatever is
    // playing. It must wait — and it must SAY it is waiting, because a
    // silent wait is indistinguishable from a broken updater, which is what
    // sent the owner looking.
    console.log('\n  a push while somebody is watching');
    busy = true;
    publish('version three\n', 'third');
    out = await runUpdate();
    check('the update is not applied mid-film', onBox() === 'version two', onBox());
    check('nothing was restarted', restarts() === 1, `${restarts()} restarts`);
    const held = state();
    console.log('   ', JSON.stringify(held));
    check('and it says a version is waiting', held?.state === 'held', JSON.stringify(held));
    check('recording when the wait started, so the panel can count it',
      held.heldSince > 0 && Date.now() - held.heldSince < 60000, String(held?.heldSince));
    check('and which version is waiting', held.remote !== held.local,
      JSON.stringify({ local: held.local, remote: held.remote }));

    // Still watching a couple of minutes later: still waiting, and the clock
    // it reports is the ORIGINAL start, not restarted on every check.
    const firstHeldSince = held.heldSince;
    await wait(1100);
    out = await runUpdate();
    check('a later check keeps waiting', state()?.state === 'held', JSON.stringify(state()));
    check('and the wait is measured from when it began, not from now',
      state().heldSince === firstHeldSince,
      `${firstHeldSince} -> ${state().heldSince}`);

    /* ---- the wait has a limit ------------------------------------------- */
    //
    // A busy signal that never clears — a tab left open on a TV — would
    // otherwise defer every deploy for ever. Held long enough, it goes
    // anyway.
    console.log('\n  the wait has a limit');
    out = await runUpdate({ HOLD_LIMIT: '0' });
    check('a long-enough wait applies the update regardless',
      onBox() === 'version three', onBox());
    check('restarting the portal to do it', restarts() === 2, `${restarts()} restarts`);
    check('and it reports it as applied', state()?.state === 'applied',
      JSON.stringify(state()));
    busy = false;

    /* ---- a recording is a different kind of busy ------------------------ */
    /*
     * Ten minutes is right for "somebody is watching": nobody can say when a
     * film ends, and a busy flag that never clears must not park deploys for
     * ever. It is fatal for a RECORDING. A restart does not interrupt a
     * recording, it destroys it — ffmpeg dies with the portal and the row
     * comes back as `partial` — and a ball game is three hours, so the very
     * mechanism meant to protect it cut off every recording this box has
     * been asked to make, ten minutes in.
     *
     * A recording is the one kind of busy that knows when it ends, so it says
     * so, and the hold lasts that long instead.
     */
    console.log('\n  a push while something is being recorded');
    publish('version three and a half\n', 'third-and-a-half');
    busy = true;
    recordingUntil = Date.now() + 40 * 60_000;
    // HOLD_LIMIT zero: an ordinary busy box would be updated on the spot.
    out = await runUpdate({ HOLD_LIMIT: '0' });
    check('the ordinary ten-minute limit does not cut a recording off',
      onBox() === 'version three', onBox());
    check('and it is still reported as waiting', state()?.state === 'held',
      JSON.stringify(state()));

    /* But not for ever, and not on the box's say-so alone: the updater keeps
       its own ceiling over whatever the portal claims. A recording wedged in
       `recording` must not park updates permanently either. */
    console.log('\n  and the ceiling over that');
    out = await runUpdate({ HOLD_LIMIT: '0', REC_HOLD_LIMIT: '0' });
    check('a recording cannot hold a deploy back indefinitely',
      onBox() === 'version three and a half', onBox());
    recordingUntil = null;
    busy = false;

    /* ---- the default limit is the one that ships ------------------------ */
    const shipped = fs.readFileSync(path.join(ROOT, 'scripts', 'auto-update.sh'), 'utf8');
    const limit = /HOLD_LIMIT="\$\{HOLD_LIMIT:-(\d+)\}"/.exec(shipped);
    const recLimit = /REC_HOLD_LIMIT="\$\{REC_HOLD_LIMIT:-(\d+)\}"/.exec(shipped);
    console.log(`\n  the shipped limits are ${limit?.[1]}s, ${recLimit?.[1]}s while recording`);
    check('an ordinary busy box waits ten minutes at most',
      Number(limit?.[1]) <= 600, limit?.[1]);
    /* Long enough for a game and its overtime, and bounded — the point of a
       ceiling is that there is one, not that it is short. */
    check('a recording buys longer, and still not for ever',
      Number(recLimit?.[1]) >= 3 * 3600 && Number(recLimit?.[1]) <= 8 * 3600,
      recLimit?.[1]);

    /* ---- local edits are not silently destroyed ------------------------- */
    console.log('\n  an edit made directly on the box');
    fs.writeFileSync(path.join(box, 'app.txt'), 'someone edited this in place\n');
    publish('version four\n', 'fourth');
    out = await runUpdate();
    check('the update still lands', onBox() === 'version four', onBox());
    const stashes = git(box, 'stash', 'list');
    check('and the edit is recoverable rather than gone',
      /auto-update backup/.test(stashes), stashes.slice(0, 120));

    /* ---- two runs at once ----------------------------------------------- */
    //
    // pm2 fires this every two minutes whether or not the last one finished.
    // Two git resets in the same working tree at the same moment is how a
    // checkout gets corrupted; the lock is what stops it.
    console.log('\n  two runs at once');
    publish('version five\n', 'fifth');
    const [a, b] = await Promise.all([runUpdate(), runUpdate()]);
    check('both exit cleanly rather than fighting',
      a.code === 0 && b.code === 0, `${a.code}/${b.code} ${a.err}${b.err}`.slice(0, 200));
    check('and the update lands exactly once', onBox() === 'version five', onBox());

    /* ---- the health panel's reading ------------------------------------- */
    //
    // The server reads this file every time the panel polls. It must survive
    // being read while it is being written, and anything unreadable must
    // read as "no report" rather than taking the panel down.
    console.log('\n  what the panel reads');
    const read = new Function('fs', 'path', 'ROOT', `
      ${/function readUpdateState\(\)[\s\S]*?\n}/.exec(
        fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))[0]}
      return readUpdateState;
    `)(fs, path, box);
    const parsed = read();
    console.log('   ', JSON.stringify(parsed));
    check('the server reads the report the updater wrote',
      parsed && parsed.state === 'applied' && parsed.at > 0, JSON.stringify(parsed));

    fs.writeFileSync(path.join(box, '.auto-update-state.json'), '{ half-written');
    check('a half-written file reads as no report, not a crash',
      read() === null, JSON.stringify(read()));
    fs.rmSync(path.join(box, '.auto-update-state.json'));
    check('and a missing one does too', read() === null, JSON.stringify(read()));

    /* ---- and what it finally says on screen ------------------------------ */
    //
    // The point of all of the above: somebody on the sofa asking "why hasn't
    // my change shown up yet" gets an answer without opening a terminal.
    console.log('\n  what it says on screen');
    const { chromium } = require('./playwright.js');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

    const panel = async (update) => page.evaluate((u) => {
      const base = {
        disk: { free: 9e9, total: 3e10, reserve: 2e9, low: false },
        network: { kind: 'wired', level: 'good' },
        provider: { streaming: false, bytesPerSec: null, needBytesPerSec: 409600 },
        cpu: { tempC: 48, load1: 0.4, cores: 4 },
        memory: { total: 4e9, used: 1e9, available: 3e9 },
        power: { ok: true, flags: [] },
        downloads: { active: null, queued: 0, stored: 3, failed: 0 },
        uptime: { host: 90000, server: 5000 },
        now: Date.now(),
      };
      const html = health.render({ ...base, update: u });
      const box = document.createElement('div');
      box.innerHTML = html;
      const rows = [...box.querySelectorAll('.health-row')];
      const mine = rows.find((r) => r.querySelector('.health-key')?.textContent === 'Updates');
      return mine ? {
        value: mine.querySelector('.health-val')?.firstChild?.textContent || '',
        sub: mine.querySelector('.health-sub')?.textContent || '',
        pill: mine.querySelector('.health-pill')?.textContent || '',
        tone: mine.querySelector('.health-pill')?.className || '',
      } : null;
    }, update);

    await page.goto('http://127.0.0.1:8481', { waitUntil: 'networkidle' });
    if (await page.locator('#profileGate').isVisible()) {
      await page.locator('.profile-tile').first().click();
      await page.waitForTimeout(1200);
    }

    const now = Date.now();
    const current = await panel({ at: now, state: 'current', local: 'abc1234',
      remote: 'abc1234', heldSince: 0, appliedAt: now - 3600e3, appliedSha: 'abc1234' });
    console.log('   up to date:', JSON.stringify(current));
    check('an up-to-date box says so', /Up to date/.test(current?.value || ''),
      JSON.stringify(current));
    check('and says which version it is on', /abc1234/.test(current?.sub || ''),
      current?.sub);

    const waiting = await panel({ at: now, state: 'held', local: 'abc1234',
      remote: 'def5678', heldSince: now - 7 * 60e3, appliedAt: now - 7200e3, appliedSha: 'abc1234' });
    console.log('   waiting:  ', JSON.stringify(waiting));
    check('a held update is announced, with how long it has waited',
      /waiting/i.test(waiting?.value || '') && /7 min/.test(waiting?.value || ''),
      JSON.stringify(waiting));
    check('and explains itself rather than reading as a fault',
      /watching/.test(waiting?.sub || '') && /warn/.test(waiting?.tone || ''),
      JSON.stringify(waiting));

    const stalled = await panel({ at: now - 40 * 60e3, state: 'current', local: 'abc1234',
      remote: 'abc1234', heldSince: 0, appliedAt: now - 7200e3, appliedSha: 'abc1234' });
    console.log('   stalled:  ', JSON.stringify(stalled));
    // The evening the updater sat stopped and nothing said so.
    check('an updater that has stopped checking in is called out',
      /not checking in/i.test(stalled?.value || '') && /bad/.test(stalled?.tone || ''),
      JSON.stringify(stalled));

    const none = await panel(null);
    check('and a box with no report at all simply omits the row', none === null,
      JSON.stringify(none));

    await browser.close();
  } finally {
    portal.close();
  }

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
