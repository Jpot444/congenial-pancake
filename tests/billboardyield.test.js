/**
 * The billboard: kept warm, and never in the way.
 *
 * "I would be ok with dedicating one of the streams for the autoplay
 *  permitted it isn't priority when I'm watching other things"
 *
 * Two halves, and the second is the condition the first came with.
 *
 *   WARM. With a connection to spare the box keeps the billboard's channel
 *   running all the time, so a page landing on home joins a window that is
 *   already built instead of starting the channel from cold.
 *
 *   NEVER PRIORITY. Anything somebody chose — a channel, a film, a recording —
 *   that finds every login in use drops the billboard first, whether or not a
 *   page is showing it. It does not take the slot straight back, it never
 *   pauses a download, and it never holds a deploy.
 *
 * Lifted by name, so this is the code that ships, with the box around it
 * stubbed: the decisions are what is under test, not ffmpeg.
 */
const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const SERVER = fs.readFileSync(path.join(PATHS.ROOT, 'server.js'), 'utf8');
const lift = (name) => {
  let start = SERVER.indexOf(`async function ${name}(`);
  if (start < 0) start = SERVER.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`not found: ${name}`);
  let depth = 0;
  let i = SERVER.indexOf('{', SERVER.indexOf(')', start));
  for (; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1;
    else if (SERVER[i] === '}' && --depth === 0) break;
  }
  return SERVER.slice(start, i + 1);
};
const constBlock = (name) => {
  const start = SERVER.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`not found: const ${name}`);
  let depth = 0;
  let i = SERVER.indexOf('{', start);
  for (; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1;
    else if (SERVER[i] === '}' && --depth === 0) break;
  }
  return SERVER.slice(start, i + 2);
};

/**
 * A box: `capacity` connections, `free` of them free, a history whose newest
 * live row is channel 201, and whatever sessions and downloads are given.
 */
const make = (o = {}) => new Function('o', `
  const console = { log() {} };
  const remuxSessions = new Map(o.sessions || []);
  const downloads = new Map(o.downloads || []);
  const killed = [];
  const started = [];
  const killSession = (id) => { killed.push(id); remuxSessions.delete(id); };
  const readConfig = () => ({ mode: 'xtream' });
  const hasFfmpeg = () => true;
  const readPrefs = () => ({ homeAutoplay: o.autoplay !== false });
  const redactUrl = (s) => s;
  const isOwnerProfile = (p) => p && p.name === 'Hunter';
  const readProfiles = () => ({ profiles: [{ id: 'own1', name: 'Hunter', history: [
    { kind: 'movie', id: 9, at: 300 },
    { kind: 'live', id: 201, at: 200 },
    { kind: 'live', id: 150, at: 100 },
  ] }], current: { id: 'own1' } });
  const findProfile = (d, id) => d.profiles.find((p) => p.id === id) || null;
  const currentProfileId = (d) => d.current.id;
  let free = o.free ?? 1;
  const providers = {
    capacity: () => o.capacity ?? 2,
    free: () => free,
    pick: () => (free > 0 ? { id: 'p1' } : null),
  };
  const ensureLiveDvr = async (cfg, id, low, opts) => {
    started.push({ id, low, ...opts });
    if (o.failStart) throw new Error('feed too slow');
    const s = { live: true, billboard: true, lastAccess: Date.now() };
    remuxSessions.set('live-' + id, s);
    return s;
  };
  ${constBlock('WARM')}
  const warm = { want: o.want || null, backoffUntil: o.backoffUntil || 0, starting: false };
  ${lift('billboardChannel')}
  ${lift('warmBillboard')}
  ${lift('yieldBillboards')}
  ${lift('makeRoomForViewer')}
  return { remuxSessions, killed, started, warm, warmBillboard, yieldBillboards,
    makeRoomForViewer, setFree: (n) => { free = n; } };
`)(o);

(async () => {
  console.log('\n  keeping it warm');
  let box = make();
  await box.warmBillboard();
  console.log('    started', JSON.stringify(box.started));
  check('with a spare connection, the billboard channel is started and kept running',
    box.started.length === 1, JSON.stringify(box.started));
  check('the channel is the newest live one in the history',
    box.started[0]?.id === '201', JSON.stringify(box.started));
  check('as a billboard, so it gives way like one', box.started[0]?.billboard === true);
  check('given longer to start than a viewer is — nobody is waiting on it',
    box.started[0]?.waitMs >= 20000, String(box.started[0]?.waitMs));
  check('and marked warm, so the idle reaper leaves it',
    box.remuxSessions.get('live-201')?.warm === true);

  box = make({ want: { id: '777', at: Date.now() } });
  await box.warmBillboard();
  check('the channel a billboard last asked for wins over the history',
    box.started[0]?.id === '777', JSON.stringify(box.started));

  await box.warmBillboard();
  check('and it is started once, not again on every tick', box.started.length === 1,
    JSON.stringify(box.started));

  console.log('\n  only with room to spare');
  box = make({ capacity: 1 });
  await box.warmBillboard();
  check('not on a one-connection account — that would hold the only one hostage',
    box.started.length === 0, JSON.stringify(box.started));
  box = make({ free: 0 });
  await box.warmBillboard();
  check('not when every connection is in use', box.started.length === 0);
  box = make({ downloads: [['d1', { status: 'queued' }]] });
  await box.warmBillboard();
  check('not while a download is waiting for a connection', box.started.length === 0);
  box = make({ downloads: [['d2', { status: 'queued', archivePath: 'x.avi' }]] });
  await box.warmBillboard();
  check('though an archive conversion, which uses none, does not count',
    box.started.length === 1);
  box = make({ autoplay: false });
  await box.warmBillboard();
  check('not with autoplay switched off', box.started.length === 0);
  box = make({ backoffUntil: Date.now() + 60000 });
  await box.warmBillboard();
  check('not straight after giving way', box.started.length === 0);
  box = make({ failStart: true });
  await box.warmBillboard();
  check('and a channel that will not start is not hammered — it backs off',
    box.warm.backoffUntil > Date.now(), String(box.warm.backoffUntil));

  console.log('\n  a viewer who took it over, and left');
  box = make({ sessions: [['live-201', { live: true, billboard: false, warm: false,
    lastAccess: Date.now() - 20000 }]] });
  await box.warmBillboard();
  check('the running channel goes back to the billboard instead of reopening from cold',
    box.started.length === 0 && box.remuxSessions.get('live-201').billboard === true
      && box.remuxSessions.get('live-201').warm === true,
    JSON.stringify([...box.remuxSessions]));
  box = make({ sessions: [['live-201', { live: true, billboard: false, lastAccess: Date.now() }]] });
  await box.warmBillboard();
  check('but not while they are still watching it',
    box.remuxSessions.get('live-201').billboard === false);

  console.log('\n  never priority');
  box = make({ free: 0, sessions: [
    ['live-201', { live: true, billboard: true, warm: true, lastAccess: Date.now() }],
    ['live-300', { live: true, billboard: false, lastAccess: Date.now() - 600000 }],
    ['vod-9', { live: false, billboard: false, lastAccess: Date.now() - 600000 }],
  ] });
  const gave = box.makeRoomForViewer({}, 'test');
  console.log('    dropped', JSON.stringify(box.killed));
  check('somebody choosing something into a full pool drops the billboard',
    box.killed.includes('live-201'), JSON.stringify(box.killed));
  check('even while a page is showing it this very second', gave === 1, String(gave));
  check('and touches nothing anybody chose, however quiet',
    !box.killed.includes('live-300') && !box.killed.includes('vod-9'), JSON.stringify(box.killed));
  check('then holds off taking the slot back', box.warm.backoffUntil > Date.now());
  box = make({ free: 1, sessions: [['live-201', { live: true, billboard: true, lastAccess: Date.now() }]] });
  check('with a connection still free, it is left alone',
    box.makeRoomForViewer({}, 'test') === 0 && box.killed.length === 0);

  console.log('\n  where the box calls it');
  const ensure = lift('ensureLiveDvr');
  check('a channel tuned in for real makes room first',
    /if \(!billboard\) makeRoomForViewer\(/.test(ensure));
  check('a viewer opening the warm channel takes it over and joins instantly',
    /existing\.billboard = false;\s*existing\.warm = false;/.test(ensure));
  check('the billboard never pauses a download',
    /if \(!billboard\) autoPauseActiveDownload\(\)/.test(ensure));
  check('a film or a channel on the direct path makes room too',
    /if \(query\.get\('billboard'\) !== '1'\) makeRoomForViewer\(/.test(SERVER));
  check('as does a film being converted',
    /makeRoomForViewer\(cfg, `somebody opened \$\{kind\} \$\{id\}`\);\s*const chosen = providers\.pick\(cfg, \{ reserve: true \}\) \|\| cfg;/.test(SERVER));
  check('and a recording takes the billboard’s connection before anything else',
    /yieldBillboards\(cfg, `recording/.test(lift('makeRoomForRecording')));
  check('the idle reaper leaves the warm billboard alone',
    /if \(s\.warm && s\.billboard && !s\.exited\) continue;/.test(SERVER));
  check('and it never counts as activity, so it cannot hold a deploy',
    /\.some\(\(s\) => !s\.billboard && Date\.now\(\) - s\.lastAccess < 60_000\)/.test(SERVER));
  check('the box remembers which channel the billboard asked for',
    /warm\.want = \{ id: String\(id\), at: Date\.now\(\) \}/.test(SERVER));
  const desk = fs.readFileSync(path.join(PATHS.ROOT, 'public/desktop.js'), 'utf8');
  check('and the billboard says it is one when it asks',
    /\/api\/play\?kind=live&ext=m3u8&billboard=1&id=/.test(desk));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
