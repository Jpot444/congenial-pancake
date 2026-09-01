/**
 * A missing stderr pipe must not take the television down with it.
 *
 * "since that update there is an error in the PITV portal and it is not
 *  responding" — and afterwards, "whatever took the portal down had to do with
 *  the DVR".
 *
 * Here is a way that happens which owes nothing to bad luck. Every ffmpeg on
 * this box is started with `stdio: ['ignore', 'ignore', 'pipe']` and then read
 * with `proc.stderr.on('data', …)`. That line assumes the pipe exists. When
 * the box is out of file descriptors it does not: spawn still hands back a
 * child object, its `stderr` is `undefined`, and `.on` off that throws a
 * TypeError on the spot. This suite does not mock that — it reproduces it, by
 * running a helper under a low `ulimit -n` with the descriptors used up.
 *
 * Where the throw lands is what turns it from one lost channel into a dead
 * portal. The live ingest RESPAWNS ITSELF from a bare setTimeout when a feed
 * drops, and nothing upstream of a timer callback can catch anything. So:
 *
 *   feed hiccups at 2am → respawn timer fires → no descriptors → TypeError
 *   → uncaught → the process exits → everything stops.
 *
 * And a recording is what arms that loop all night. It holds the window open
 * long after the last viewer has gone to bed, which is the whole point of
 * recording — so the respawn path stays live for hours with nobody watching,
 * on precisely the nights something was booked.
 *
 * The second way is the same shape with a different cause: a stream that emits
 * 'error' with no listener throws, by Node's design, and not one of these
 * sites was listening.
 *
 * Both are tested against the real `onStderr` lifted out of server.js, so this
 * measures the shipped function rather than a description of it.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const PATHS = require('./paths.js');

const PORT = process.env.PORT || 8481;
const DIR = '/tmp/portal-nopipe';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

/* The shipped function, by text. Lifted rather than re-implemented: a copy
   here would keep passing after somebody changed the original back. */
function lift(name) {
  const src = fs.readFileSync(PATHS.SERVER, 'utf8');
  const at = src.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`server.js no longer defines ${name}()`);
  /* To the closing brace in column one — every function in that file is
     top-level, so the first `\n}` ends it. */
  const end = src.indexOf('\n}\n', at);
  return `${src.slice(at, end + 3)}\n`;
}

(async () => {
  const onStderr = lift('onStderr');
  check('server.js still defines onStderr', /function onStderr/.test(onStderr));
  /* It must not simply be `proc.stderr.on(...)` with a new name. */
  check('and it checks the pipe is there before reading it',
    /if \(!pipe\) return/.test(onStderr), onStderr.slice(0, 200));
  check('and it listens for the pipe breaking',
    /\.on\('error'/.test(onStderr), onStderr.slice(0, 300));

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  /* ---- 1. no descriptors left, so no pipe ------------------------------- */
  /*
   * Run in a helper process, because the exhaustion has to be real: this
   * suite needs its own descriptors to report the answer.
   */
  const helper = path.join(DIR, 'nopipe.js');
  fs.writeFileSync(helper, `${onStderr}
const fs = require('fs');
const { spawn } = require('child_process');

/* Use them all up. */
const hogs = [];
try { for (let i = 0; i < 100000; i += 1) hogs.push(fs.openSync('/dev/null', 'r')); } catch {}
try { fs.closeSync(hogs.pop()); } catch {}   // one back, to report with

const proc = spawn('node', ['-e', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
const shape = proc.stderr ? 'a pipe' : 'nothing';

/* What the box used to do. */
let bare = 'no throw';
try { proc.stderr.on('data', () => {}); } catch (e) { bare = e.constructor.name; }

/* What the box does now. */
let guarded = 'no throw';
try { onStderr(proc, () => {}); } catch (e) { guarded = e.constructor.name; }

proc.on('error', () => {});
for (const fd of hogs) { try { fs.closeSync(fd); } catch {} }
fs.writeFileSync(process.argv[2], JSON.stringify({ shape, bare, guarded }));
`);

  const answer = path.join(DIR, 'answer.json');
  console.log('\n  a box with no file descriptors left');
  execFileSync('bash', ['-c', `ulimit -n 256; node ${JSON.stringify(helper)} ${JSON.stringify(answer)}`],
    { stdio: 'inherit' });
  const said = JSON.parse(fs.readFileSync(answer, 'utf8'));
  console.log('   spawn gave back:', said.shape, '· bare:', said.bare, '· guarded:', said.guarded);

  /* If this ever stops being true the rest of the suite is measuring nothing,
     so it is checked rather than assumed. */
  check('spawn hands back a child with no stderr at all', said.shape === 'nothing', said.shape);
  check('reading .on off it throws — which is the bug', said.bare === 'TypeError', said.bare);
  check('onStderr does not throw', said.guarded === 'no throw', said.guarded);

  /* ---- 2. a pipe that breaks -------------------------------------------- */
  console.log('\n  a pipe that errors after it is attached');
  const broke = path.join(DIR, 'broke.js');
  fs.writeFileSync(broke, `${onStderr}
const { Readable } = require('stream');
const pipe = new Readable({ read() {} });
onStderr({ stderr: pipe }, () => {});
pipe.emit('error', new Error('pipe broke'));
console.log('survived');
`);
  let survived = '';
  try {
    survived = execFileSync('node', [broke], { encoding: 'utf8' }).trim();
  } catch (err) {
    survived = `died: ${String(err.stderr || err.message).split('\n')[0]}`;
  }
  console.log('   ', survived);
  check('a stderr that errors does not throw', survived === 'survived', survived);

  /* ---- 3. the respawn timer is the one that would have killed it -------- */
  /*
   * Not a behavioural test — the throw itself is now impossible — but the
   * guard around the timer is the thing that stops the NEXT unforeseen fault
   * in there from ending the process, and it is one deletion away from being
   * gone.
   */
  console.log('\n  and the live ingest respawn is not a bare timer any more');
  const server = fs.readFileSync(PATHS.SERVER, 'utf8');
  const respawn = /setTimeout\(\(\) => safely\('live ingest respawn'/.test(server);
  check('the respawn timer catches what it runs', respawn,
    'spawnLiveDvr is called from an unguarded setTimeout again');
  check('no ffmpeg is read through a bare stderr any more',
    !/proc\.stderr\.on\('data'/.test(server.replace(/^\s*\*.*$/gm, '')),
    'a spawn site still reads proc.stderr.on directly');

  /* ---- 4. and the box can say how close it is to the wall ---------------- */
  /*
   * The fix stops the crash; it does not stop the box running out. Descriptors
   * leak slowly by nature — the count climbs over hours with the disk, memory
   * and temperature all reading fine — so the count itself is on the panel,
   * and it is the only warning that would arrive before the fault.
   */
  console.log('\n  and the panel can see it coming');
  const health = JSON.parse((await get('/api/health')).body);
  console.log('   files:', JSON.stringify(health.files));
  check('health reports how many files are open',
    health.files && Number.isFinite(health.files.open) && health.files.open > 0,
    JSON.stringify(health.files));
  check('and what the ceiling is',
    health.files && Number.isFinite(health.files.limit) && health.files.limit > health.files.open,
    JSON.stringify(health.files));
  check('a box that is nowhere near it does not cry wolf',
    health.files && health.files.low === false, JSON.stringify(health.files));

  /* The panel only draws the row when there is something to say — it has to
     fit without scrolling, and a row that always reads "fine" costs a line. */
  const app = fs.readFileSync(PATHS.APP, 'utf8');
  check('the panel shows the row only once it starts climbing',
    /files\.low \|\| files\.open > 200/.test(app), 'the Open files row is drawn unconditionally');
  check('and the header dot picks it up', /data\.files && data\.files\.low/.test(app));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
