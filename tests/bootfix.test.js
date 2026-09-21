/**
 * The reboot row can be pressed.
 *
 * "theres a Survives a reboot / NO — it would stay down / pm2 has no boot
 *  service (`pm2 startup`) — run scripts/ensure-boot.sh on the Pi"
 *
 * That row had been telling the truth for weeks and could do nothing about
 * it. `pm2 startup` needs root — it does not even install the unit, it PRINTS
 * a sudo line for a person to run — so the only remedy the box could name was
 * an SSH session, for a fault whose whole nature is that it stays invisible
 * until the next reboot, which nobody schedules and nobody watches. And
 * scripts/ensure-boot.sh, run without passwordless sudo, exited 1 with a
 * paragraph and left the box exactly as un-survivable as it found it.
 *
 * A user crontab needs no privilege at all. `@reboot` fires when cron starts,
 * running as the user who owns the portal, which is the whole of what this row
 * is asking for.
 *
 * NOTHING HERE TOUCHES A REAL CRONTAB. The box under test is started with a
 * PATH holding a stand-in `crontab` that reads and writes a file in the test
 * directory, which is also what lets the suite check the two things that
 * matter most about writing to somebody's crontab: that what was already
 * there survives, and that pressing twice does not leave two entries.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-bootfix';
const PORT = 8479;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CRONTAB = path.join(DIR, 'crontab.txt');

/* A crontab that is a file. `crontab -l` prints it, `crontab -` replaces it —
   which is the real command's behaviour and the reason the endpoint has to
   read before it writes. */
function fakeBin(dir) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'crontab'), `#!/bin/bash
FILE="${CRONTAB}"
if [ "\$1" = "-l" ]; then
  [ -f "\$FILE" ] || { echo "no crontab for \$(id -un)" >&2; exit 1; }
  cat "\$FILE"; exit 0
fi
if [ "\$1" = "-" ]; then cat > "\$FILE"; exit 0; fi
exit 2
`, { mode: 0o755 });
  /* pm2 save is called after a successful install; it must not be the real
     one, and its failure must not fail the install. */
  fs.writeFileSync(path.join(dir, 'bin', 'pm2'), `#!/bin/bash
echo "fake pm2 \$*"; exit 0
`, { mode: 0o755 });
}

function box() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'boot-resurrect.sh'),
    path.join(DIR, 'scripts', 'boot-resurrect.sh'));
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'market.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));
  fakeBin(DIR);
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u', host: '', username: '', password: '',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  return spawn(process.execPath, ['server.js'], {
    cwd: DIR,
    detached: true,
    env: { ...process.env, PATH: `${path.join(DIR, 'bin')}:${process.env.PATH}`,
      PORT: String(PORT), HOST: '127.0.0.1', HOME: DIR,
      DOWNLOADS_ROOT: path.join(DIR, 'store') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const call = (p, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let data = {};
      try { data = JSON.parse(text); } catch { /* not json */ }
      resolve({ status: res.statusCode, data });
    });
  });
  req.on('error', reject);
  req.end();
});

(async () => {
  const server = box();
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });

  try {
    for (let i = 0; i < 60; i += 1) {
      try { await call('/api/health'); break; } catch { await wait(250); }
    }

    /* ---- the row, before ---------------------------------------------- */
    /*
     * A box with no systemd unit and no crontab entry. This is the state the
     * report came from, and the new part is the last field: whether the box
     * can do anything about it itself.
     */
    console.log('\n  a box that would stay down');
    let health = await call('/api/health');
    let boot = health.data.boot || {};
    console.log('   ', JSON.stringify({ ok: boot.ok, cron: boot.cron, service: boot.service,
      fixable: boot.fixable, missing: boot.missing }));
    check('it says so', boot.ok === false, JSON.stringify(boot.missing));
    check('and names what is missing without naming only pm2 startup',
      (boot.missing || []).some((m) => /nothing starts pm2 at boot/.test(m)),
      JSON.stringify(boot.missing));
    /* The field the button hangs off. Without it the panel can only print
       advice, which is what it has been doing. */
    check('and says the box can fix it from here', boot.fixable === true,
      String(boot.fixable));

    /* ---- something already in the crontab ------------------------------ */
    /*
     * Written BEFORE the install, because `crontab -` replaces the whole file
     * and an endpoint that wrote only its own line would silently delete
     * every other job on the box. That is the worst thing this could do and
     * the reason it reads before it writes.
     */
    fs.writeFileSync(CRONTAB, '# somebody else\n30 4 * * * /home/hunter/backup.sh\n');

    /* ---- pressing it --------------------------------------------------- */
    console.log('\n  and pressing the fix');
    const done = await call('/api/boot/install', 'POST');
    console.log('   ', done.status, JSON.stringify(done.data).slice(0, 200));
    check('it reports success', done.status === 200 && done.data.ok === true,
      JSON.stringify(done.data).slice(0, 200));
    const written = fs.readFileSync(CRONTAB, 'utf8');
    console.log(written.split('\n').map((l) => `      ${l}`).join('\n'));
    check('an @reboot entry is in the crontab',
      /^@reboot .*boot-resurrect\.sh/m.test(written), written);
    check('pointed at a script that exists',
      fs.existsSync(path.join(DIR, 'scripts', 'boot-resurrect.sh')), 'script missing');
    /* The claim that matters most. */
    check('and what was already there is still there',
      /30 4 \* \* \* \/home\/hunter\/backup\.sh/.test(written)
      && /# somebody else/.test(written), written);

    /* ---- and the row agrees -------------------------------------------- */
    /*
     * The endpoint reads the crontab back before answering, so this is the
     * box's own second opinion rather than the same optimism twice. A
     * mechanism that reported success and did nothing is the fault being
     * fixed, so it must not be the shape of the fix.
     */
    console.log('\n  and the row now says it will come back');
    health = await call('/api/health');
    boot = health.data.boot || {};
    console.log('   ', JSON.stringify({ ok: boot.ok, cron: boot.cron, how: boot.how }));
    check('the crontab route is recognised as a boot mechanism', boot.cron === true,
      String(boot.cron));
    check('and says which mechanism it is, since there are now two',
      /crontab/.test(boot.how || ''), boot.how);
    /* And it is STILL not Yes, which is right and worth asserting.
     *
     * A boot entry is half the answer. pm2 resurrects a process list only if
     * one was saved, so an @reboot line pointing at an empty dump is a
     * mechanism that starts nothing — the box would come back and still be
     * down. This box has no dump.pm2, so the row correctly holds out. */
    console.log('    with nothing saved yet:', JSON.stringify(boot.missing));
    check('but a boot entry alone is not survival, and it does not claim to be',
      boot.ok === false
      && (boot.missing || []).some((m) => /pm2 save/.test(m)),
      JSON.stringify(boot.missing));

    /* Now the other half, the way `pm2 save` would leave it. */
    fs.mkdirSync(path.join(DIR, '.pm2'), { recursive: true });
    fs.writeFileSync(path.join(DIR, '.pm2', 'dump.pm2'),
      JSON.stringify([{ name: 'iptv-portal' }, { name: 'iptv-updater' }]));
    health = await call('/api/health');
    boot = health.data.boot || {};
    console.log('    with both halves:', JSON.stringify({ ok: boot.ok, how: boot.how }));
    check('with a saved list as well, the row reads Yes', boot.ok === true,
      JSON.stringify(boot.missing));
    check('and it is in the box log', /installed an @reboot entry/.test(log),
      log.split('\n').filter((l) => /boot:/.test(l)).join(' | '));

    /* ---- pressing it twice --------------------------------------------- */
    /*
     * The panel repaints every poll and a button is easy to press twice. Two
     * entries would both fire on boot, and two `pm2 resurrect` runs racing
     * each other is a worse state than the one this started in.
     */
    console.log('\n  and pressing it again changes nothing');
    const twice = await call('/api/boot/install', 'POST');
    const after = fs.readFileSync(CRONTAB, 'utf8');
    const count = (after.match(/@reboot/g) || []).length;
    console.log('   ', JSON.stringify({ already: twice.data.already, entries: count }));
    check('it says it was already in place', twice.data.already === true,
      JSON.stringify(twice.data).slice(0, 160));
    check('and there is exactly one entry', count === 1, String(count));

    /* ---- a systemd unit still counts, and still wins ------------------- */
    /*
     * The proper mechanism is unchanged and is still what `pm2 startup`
     * installs. Asking for BOTH would fail a box that is genuinely going to
     * come back — and a false NO on this row sends somebody to fix what is
     * not broken, which is worse than no row at all.
     */
    console.log('\n  and the two mechanisms are each enough on their own');
    const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const block = SERVER.slice(SERVER.indexOf('function bootSurvival('),
      SERVER.indexOf('function recentCrashes('));
    check('either one satisfies the row, not both',
      /if \(!out\.service && !out\.cron\)/.test(block), 'the row still demands the unit');
    check('and only the crontab one is offered as fixable from here',
      /out\.fixable = !out\.service && !out\.cron/.test(block), 'fixable is wrong');
  } catch (err) {
    console.log('  HARNESS ERROR', err.message);
    fails.push('harness');
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  /* ---- the script cron will actually run ------------------------------- */
  /*
   * The entry is worthless if what it points at cannot run. Cron's
   * environment is the whole difficulty — a threadbare PATH, no profile, no
   * PM2_HOME — and pm2 keyed by the wrong PM2_HOME fails in the least
   * obvious way available: it reports success and resurrects nothing.
   */
  console.log('\n  and the script it points at is one cron can run');
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'boot-resurrect.sh'), 'utf8');
  check('it is valid bash',
    require('child_process').spawnSync('bash', ['-n',
      path.join(ROOT, 'scripts', 'boot-resurrect.sh')]).status === 0, 'bash -n failed');
  check('it sets PM2_HOME rather than hoping for it',
    /export PM2_HOME=/.test(script), 'PM2_HOME not set');
  check('and builds a PATH rather than inheriting cron\'s',
    /export PATH/.test(script) && /nvm/.test(script), 'PATH not built');
  /* Checked rather than assumed, which is the rule the rest of this file was
     written under: `pm2 resurrect` exits 0 on a dump that does not contain
     the portal. */
  check('and checks the portal is really running afterwards',
    /pm2 describe iptv-portal/.test(script), 'no verification');
  check('and the updater too, or the box comes back frozen',
    /pm2 describe iptv-updater/.test(script), 'updater not checked');

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
