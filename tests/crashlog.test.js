/**
 * When the portal dies, it says what it was doing.
 *
 * "since that update there is an error in the PITV portal and it is not
 *  responding" — and the honest answer afterwards was that I did not know.
 *
 * That was not modesty, it was the truth, and the reason is here: this
 * process had NO uncaughtException handler and NO unhandledRejection handler.
 * A throw on any callback — an ffmpeg exit, a timer, a socket that errored
 * after the response went out — took the whole box down and left nothing
 * behind but whatever pm2 happened to catch on stderr, which nobody can reach
 * from the sofa. A crash with no evidence is a crash that can only be guessed
 * at, and I guessed, and then reverted a change I could not prove was at
 * fault.
 *
 * The two faults are not the same and are not treated the same.
 *
 *   AN UNCAUGHT EXCEPTION leaves the process somewhere nobody reasoned about
 *   — half a response written, a Map half updated — so carrying on from there
 *   is how a crash turns into corruption. Written down, then exit, and pm2
 *   restarts it. That is what happened before; the difference is the stack
 *   trace.
 *
 *   AN UNHANDLED REJECTION is a promise nobody awaited, which on this box is
 *   usually somebody else's server failing in a path that forgot a catch.
 *   Node's default turns that into an uncaught exception — so a score feed
 *   refusing a connection could take down playback in the next room. Written
 *   down, and the box keeps going.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-crash';
const PORT = 8473;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

const up = async (port) => {
  for (let i = 0; i < 40; i += 1) {
    try { await get(port, '/api/health'); return true; } catch { await wait(250); }
  }
  return false;
};

/*
 * Nothing else may be on this port.
 *
 * Written after this suite passed while measuring the WRONG PROCESS: a
 * leftover box from an earlier experiment held the port, the one this test
 * spawned died of EADDRINUSE, and every assertion below read the stranger's
 * crash log and agreed with itself. A suite that cannot tell whose answer it
 * is reading is worse than no suite, so it refuses to start instead.
 */
const portFree = async (port) => {
  try {
    await get(port, '/api/health');
    return false;
  } catch {
    return true;
  }
};

(async () => {
  for (const port of [PORT, PORT + 1, PORT + 2]) {
    // eslint-disable-next-line no-await-in-loop
    if (!await portFree(port)) {
      console.log(`  something is already answering on ${port}. `
        + 'Stop it — this suite cannot tell its crash log from its own.');
      process.exit(1);
    }
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
    mode: 'xtream', host: 'http://provider.example', username: 'u', password: 'p',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', prefs: { tourDone: true }, history: [] }],
  }));

  /* Two faults on timers, which is the shape that used to kill it silently:
     neither is inside a request, so no try/catch anywhere covers them. */
  const faulted = path.join(DIR, 'server.js');
  fs.appendFileSync(faulted,
    "\nsetTimeout(() => { Promise.reject(new Error('stray rejection here')); }, 800);\n"
    + "setTimeout(() => { throw new Error('callback fault here'); }, 2400);\n");

  console.log('\n  a box that hits both kinds of fault');
  const box = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  box.stdout.on('data', (d) => { out += d; });
  box.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => box.on('exit', (code) => r(code)));

  if (!await up(PORT)) {
    console.log('  the box did not come up\n', out.slice(-600));
    process.exit(1);
  }

  /* The rejection lands first. The box must still be answering after it — a
     promise nobody awaited is not a reason to stop showing television. */
  await wait(1600);
  let alive = true;
  try { await get(PORT, '/api/health'); } catch { alive = false; }
  check('a stray rejection does not take the portal down', alive === true);

  /* Then the uncaught one, which does stop it — on purpose. */
  const code = await Promise.race([exited, wait(8000).then(() => 'still running')]);
  console.log('   exit code:', JSON.stringify(code));
  check('an uncaught exception exits, so pm2 restarts it cleanly',
    code === 1, JSON.stringify(code));

  const log = fs.readFileSync(path.join(DIR, 'crash.log'), 'utf8');
  console.log('   crash.log:\n' + log.split('\n').slice(0, 6).map((l) => `     ${l}`).join('\n'));
  check('both are written down', /unhandledRejection/.test(log) && /uncaughtException/.test(log),
    log.slice(0, 200));
  /* A stack, not just a message: the line and the file are the whole point. */
  check('with a stack trace, not just a sentence',
    /at [\w.]+ \(/.test(log) || /at Timeout/.test(log), log.slice(0, 300));
  check('and the fault that stopped it is named',
    /callback fault here/.test(log), log.slice(0, 300));

  /* ---- and it is readable without a terminal ---------------------------- */
  /*
   * pm2 logs are on the box behind ssh. The person who needs this is sitting
   * in front of the television, so it comes back with the health payload the
   * panel already polls.
   */
  console.log('\n  and readable from the health panel');
  const again = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT + 1), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!await up(PORT + 1)) throw new Error('restart did not come up');
    check('and the box answering is the one this suite started',
      again.exitCode === null, `exited ${again.exitCode}`);
    const health = JSON.parse((await get(PORT + 1, '/api/health')).body);
    console.log('   reported:', JSON.stringify((health.crashes || [])
      .map((c) => `${c.kind}: ${c.detail.split('\n')[0]}`)));
    check('the restarted box reports what killed the last one',
      (health.crashes || []).length >= 2, JSON.stringify((health.crashes || []).length));
    /* Newest first: the thing that just happened is the thing being asked
       about. */
    check('newest first', health.crashes[0].kind === 'uncaughtException',
      health.crashes[0].kind);
    check('each one carries when, what, and the trace',
      health.crashes.every((c) => c.at && c.kind && c.detail),
      JSON.stringify(health.crashes[0]));
  } finally {
    again.kill('SIGKILL');
  }

  /* ---- and a clean box says nothing ------------------------------------- */
  console.log('\n  and a box that has not crashed');
  fs.rmSync(path.join(DIR, 'crash.log'), { force: true });
  const clean = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT + 2), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!await up(PORT + 2)) throw new Error('clean box did not come up');
    const health = JSON.parse((await get(PORT + 2, '/api/health')).body);
    /* An empty panel raises questions of its own, so nothing is reported and
       the panel stays hidden. */
    check('reports no crashes at all', (health.crashes || []).length === 0,
      JSON.stringify(health.crashes));
  } finally {
    clean.kill('SIGKILL');
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
