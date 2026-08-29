/**
 * The 20GB per-profile download allowance.
 *
 * The arithmetic is lifted out of server.js by name so it tests what ships,
 * and the two gates are checked separately because they answer different
 * questions: the request gate knows only what is already used, and the runner
 * gate is the first place the new file's size exists at all. Only the second
 * one can stop a single oversized film, which is the case that matters.
 */
const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');
const SRC = PATHS.SERVER;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const source = fs.readFileSync(SRC, 'utf8');
const lift = (signature) => {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced: ${signature}`);
};

const GB = 1024 * 1024 * 1024;
const downloads = new Map();
const scope = new Function('downloads', `
  const DOWNLOAD_ALLOWANCE = 20 * 1024 * 1024 * 1024;
  const OWNER_PROFILE = 'hunter';
  ${lift('function isOwnerProfile(profile) {')}
  ${lift('function downloadLimitFor(profile) {')}
  ${lift('function downloadBytesFor(profileId, exceptId = null) {')}
  return { downloadLimitFor, downloadBytesFor };
`)(downloads);
const { downloadLimitFor, downloadBytesFor } = scope;

// --- who is capped -------------------------------------------------------
console.log('\n  who gets a limit');
check('hunter has none', downloadLimitFor({ name: 'hunter' }) === Infinity);
check('and is matched however it is typed',
  downloadLimitFor({ name: '  Hunter ' }) === Infinity,
  String(downloadLimitFor({ name: '  Hunter ' })));
check('everyone else gets 20GB', downloadLimitFor({ name: 'Ben' }) === 20 * GB,
  String(downloadLimitFor({ name: 'Ben' })));
// The scope above mirrors the constant; this pins the real one, so the two
// cannot drift apart silently.
check('and the server really says 20GB, since the archive drive freed the card',
  /DOWNLOAD_ALLOWANCE = 20 \* 1024 \* 1024 \* 1024/.test(source));
check('a profile that could not be found is capped, not exempted',
  downloadLimitFor(undefined) === 20 * GB, String(downloadLimitFor(undefined)));
check('and one calling itself hunter-ish is not let through',
  downloadLimitFor({ name: 'hunter2' }) === 20 * GB);

// --- what counts ---------------------------------------------------------
console.log('\n  what counts against it');
const job = (o) => downloads.set(o.id, o);
job({ id: 'a', profileId: 'p1', bytes: 1 * GB, total: 1 * GB, status: 'done' });
job({ id: 'b', profileId: 'p1', bytes: 0.2 * GB, total: 1.5 * GB, status: 'downloading' });
job({ id: 'c', profileId: 'p1', bytes: 0, total: 0, status: 'queued' });
job({ id: 'd', profileId: 'p2', bytes: 2 * GB, total: 2 * GB, status: 'done' });
job({ id: 'e', profileId: '', bytes: 4 * GB, total: 4 * GB, status: 'done' });

check('a finished file counts what it weighs',
  downloadBytesFor('p2') === 2 * GB, String(downloadBytesFor('p2') / GB));
check('a running one counts what it will weigh, not what has landed',
  downloadBytesFor('p1') === 2.5 * GB, `${downloadBytesFor('p1') / GB} GB`);
check('another profile\'s downloads are not charged to you',
  downloadBytesFor('p2') === 2 * GB);
check('a download from before this shipped is charged to nobody',
  downloadBytesFor('') === 4 * GB && downloadBytesFor('p1') === 2.5 * GB,
  'an unowned job leaked into a profile');
check('a profile with nothing is at zero', downloadBytesFor('p9') === 0);
check('the job being checked can exclude itself, or it blocks on its own size',
  downloadBytesFor('p1', 'b') === 1 * GB, `${downloadBytesFor('p1', 'b') / GB} GB`);

// --- the two gates -------------------------------------------------------
// Modelled exactly as the two call sites do it, so the numbers below are the
// decisions the server makes rather than a paraphrase of them.
console.log('\n  the gates');
const requestGate = (profileId, name) => {
  const limit = downloadLimitFor({ name });
  return Number.isFinite(limit) && downloadBytesFor(profileId) >= limit;
};
const runnerGate = (jobId, profileId, name, total) => {
  const limit = downloadLimitFor({ name });
  return Number.isFinite(limit)
    && downloadBytesFor(profileId, jobId) + total > limit;
};

check('the request is let through while there is room',
  requestGate('p1', 'Ben') === false);
check('and refused once the allowance is spent',
  requestGate('p2', 'Ben') === false && (() => {
    job({ id: 'f', profileId: 'p2', bytes: 18.1 * GB, total: 18.1 * GB, status: 'done' });
    return requestGate('p2', 'Ben') === true;
  })(), 'p2 at 20.1GB was still allowed to ask');
check('hunter is never refused',
  requestGate('p2', 'hunter') === false);

// The case the request gate cannot see: nothing used, one enormous film.
downloads.clear();
job({ id: 'g', profileId: 'p3', bytes: 0, total: 0, status: 'downloading' });
check('a fresh profile may ask for anything', requestGate('p3', 'Ben') === false);
check('but a single 25GB film is stopped once its size is known',
  runnerGate('g', 'p3', 'Ben', 25 * GB) === true);
check('while a 2GB one is not', runnerGate('g', 'p3', 'Ben', 2 * GB) === false);
check('and hunter gets the 5GB one', runnerGate('g', 'p3', 'hunter', 5 * GB) === false);

// Exactly on the line is allowed; a byte over is not.
check('exactly the allowance is allowed',
  runnerGate('g', 'p3', 'Ben', 20 * GB) === false);
check('one byte over is not',
  runnerGate('g', 'p3', 'Ben', 20 * GB + 1) === true);

// --- the floor under the disk itself -------------------------------------
//
// Separate from the per-profile allowance: however much anyone is allowed,
// the SD card itself keeps a hard floor of free space, checked at every gate.
console.log('\n  the floor under the disk');
const reserve = Number((/const SPACE_RESERVE = (\d+) \* 1024 \* 1024 \* 1024/.exec(source) || [])[1]);
console.log('   reserve:', reserve, 'GB');
check('at least a gigabyte always stays free on the Pi', reserve >= 1, String(reserve));
check('every download is refused up front if it would dip under the floor',
  /free < declared \+ SPACE_RESERVE/.test(source));
check('and a conversion checks before it starts',
  /diskFree\(DOWNLOAD_DIR\) < srcSize \+ SPACE_RESERVE/.test(source));
check('the downloads folder is movable to a writable drive by env, gates and all',
  /process\.env\.DOWNLOADS_ROOT \|\| path\.join\(ROOT, 'downloads'\)/.test(source));
/* The busiest directory the box has: a rolling window per live channel, four
   seconds at a time, plus every film that needs converting, whole. Left on the
   SD card it is the largest source of wear the box produces — and the archive
   conversion cache sizes itself against whatever disk this sits on, so moving
   it moves the allowance too. */
check('and so is the scratch directory the live window and conversions use',
  /process\.env\.HLS_ROOT \|\| path\.join\(ROOT, 'hls'\)/.test(source));
/* Both are set in ecosystem.config.js rather than typed on the box, and that
   file is only re-read by a restart THROUGH it — which is why the updater has
   to use startOrRestart. A plain `pm2 restart <name>` deploys the file and
   applies none of it, silently, which is exactly how DOWNLOADS_ROOT sat on
   the box doing nothing. */
const updater = fs.readFileSync(path.join(PATHS.ROOT, 'scripts/auto-update.sh'), 'utf8');
check('and a pushed change to either actually reaches the running process',
  /pm2 startOrRestart .*ecosystem\.config\.js.*--update-env/.test(updater), '');

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
