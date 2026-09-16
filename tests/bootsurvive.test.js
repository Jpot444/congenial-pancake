/**
 * Whether the box would come back on its own after a reboot.
 *
 * "it is back up. Make sure this never happens again"
 *
 * What happened: the Pi rebooted and pm2 came back with an EMPTY process
 * list. Not a crash — `pm2 list` printed headers and no rows — so the portal
 * was never restarted, and neither was iptv-updater, which meant nothing was
 * pulling main either. The box was absent until somebody noticed.
 *
 * pm2 restores a list only when a list was SAVED and a boot service exists to
 * replay it. Miss either and everything reads perfectly healthy right up until
 * the next reboot, which is the worst shape a fault can take: no symptom until
 * total absence.
 *
 * Nothing already in the box could have caught it. The updater that repairs a
 * bad deploy is itself a pm2 app, so when the list is gone the repair
 * mechanism is gone with it. The only place this can be noticed is BEFORE the
 * reboot, which is what the health panel now does.
 *
 * Driven through the shipped bootSurvival() against a stand-in pm2 home,
 * because what is under test is the reading of those two facts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PATHS = require('./paths.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const SERVER = fs.readFileSync(path.join(PATHS.ROOT, 'server.js'), 'utf8');

const lift = (name) => {
  const start = SERVER.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`not found: ${name}`);
  let depth = 0;
  let i = SERVER.indexOf('{', SERVER.indexOf(')', start));
  for (; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1;
    else if (SERVER[i] === '}' && --depth === 0) break;
  }
  return SERVER.slice(start, i + 1);
};

/* A pm2 home and a systemd directory under the suite's control. `wants` is
   passed in rather than read from /etc, so this tests the decision without
   needing a machine that actually has pm2 installed at boot. */
const make = (dir, wants) => new Function('fs', 'path', 'PM2_HOME', 'WANTS', `
  ${lift('bootSurvival').replace(
    "const wants = '/etc/systemd/system/multi-user.target.wants';",
    'const wants = WANTS;'
  )}
  return bootSurvival;
`)(fs, path, dir, wants);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootsurvive-'));
const pm2home = path.join(tmp, 'pm2');
const wants = path.join(tmp, 'wants');
fs.mkdirSync(pm2home, { recursive: true });
fs.mkdirSync(wants, { recursive: true });

const saveDump = (names) => fs.writeFileSync(path.join(pm2home, 'dump.pm2'),
  JSON.stringify(names.map((name) => ({ name }))));

(async () => {
  const survival = make(pm2home, wants);

  /* ---- the state the Pi was actually found in -------------------------- */
  /*
   * No dump and no boot service. This is what "pm2 list printed no rows"
   * looks like from inside, and it read as perfectly healthy on every other
   * measure the box takes.
   */
  console.log('\n  a box that would come back empty');
  let now = survival();
  console.log('   ', JSON.stringify(now));
  check('it says no, rather than saying nothing',
    now.ok === false, JSON.stringify(now.ok));
  check('and names the saving as missing',
    now.missing.some((m) => /pm2 save/.test(m)), JSON.stringify(now.missing));
  check('and the boot service as missing',
    now.missing.some((m) => /boot service/.test(m)), JSON.stringify(now.missing));

  /* ---- saved, but with no service to replay it ------------------------- */
  /*
   * The trap worth having a name for. `pm2 save` on its own feels like the
   * fix — the list is on disk, and `pm2 resurrect` restores it by hand — but
   * nothing runs resurrect at boot, so the reboot is exactly as bad.
   */
  console.log('\n  and a saved list with nothing to replay it is not enough');
  saveDump(['iptv-portal', 'iptv-updater']);
  now = survival();
  console.log('   ', JSON.stringify(now.missing));
  check('still no', now.ok === false, JSON.stringify(now.ok));
  check('with the saving no longer the complaint',
    !now.missing.some((m) => /pm2 save/.test(m)), JSON.stringify(now.missing));
  check('and the boot service named as the one thing left',
    now.missing.length === 1 && /boot service/.test(now.missing[0]),
    JSON.stringify(now.missing));

  /* ---- a service with a list that predates the updater ----------------- */
  /*
   * The half-fix that would have left this failure in place while reporting
   * success: a portal that comes back and an updater that does not, so the
   * box is up but has silently stopped taking deploys. That is how a fault
   * hides for a week.
   */
  console.log('\n  and a list missing the updater is called out by name');
  fs.writeFileSync(path.join(wants, 'pm2-hunter.service'), '');
  saveDump(['iptv-portal']);
  now = survival();
  console.log('   ', JSON.stringify(now.missing));
  check('not treated as good enough',
    now.ok === false, JSON.stringify(now.ok));
  check('and it says WHICH app is missing, not just that something is',
    now.missing.some((m) => /iptv-updater/.test(m)), JSON.stringify(now.missing));

  /* ---- both halves present --------------------------------------------- */
  console.log('\n  and a box that really would come back says so');
  saveDump(['iptv-portal', 'iptv-updater']);
  now = survival();
  console.log('   ', JSON.stringify(now));
  check('it passes', now.ok === true, JSON.stringify(now));
  check('with nothing left to complain about',
    now.missing.length === 0, JSON.stringify(now.missing));
  check('and it says what it is relying on, so the claim can be checked',
    now.saved.includes('iptv-portal') && now.saved.includes('iptv-updater')
    && now.service === true, JSON.stringify(now));

  /* ---- a disabled unit is not an enabled one --------------------------- */
  /*
   * `pm2 startup` installs a unit AND enables it, and enabling is the symlink
   * under multi-user.target.wants. A unit file sitting in /etc/systemd/system
   * disabled would restore nothing, so the symlink is what is tested — the
   * one that is true if and only if systemd will actually run it.
   */
  console.log('\n  and an installed-but-disabled service does not count');
  fs.unlinkSync(path.join(wants, 'pm2-hunter.service'));
  now = survival();
  check('a unit nobody enabled reads as no service at all',
    now.ok === false && now.service === false, JSON.stringify(now));

  /* ---- an unreadable pm2 home is not a false all-clear ----------------- */
  /*
   * The failure direction that matters. This runs as the portal's user and
   * reads another process's files; if that ever stops being readable the
   * answer must be "I cannot tell", never a cheerful yes.
   */
  console.log('\n  and a pm2 home it cannot read never reads as fine');
  const blind = make(path.join(tmp, 'nothing-here'), wants);
  now = blind();
  check('no dump means no, not yes',
    now.ok === false && now.saved === null, JSON.stringify(now));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
