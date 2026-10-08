/**
 * The billboard gives way.
 *
 * "I am getting a second provider to replace the expired one, if you need to
 *  use one of them to make the autoplayer run faster that's ok"
 *
 * With two logins the billboard simply takes the spare one — the pool already
 * does that. What this is about is the moment there is NOT a spare: the home
 * page's muted channel holds a connection, somebody presses a different
 * channel, and the page lets go of the billboard at once — but the box only
 * notices an unwatched ingest after 45 seconds. On a one-connection account
 * that was 45 seconds of the channel somebody chose fighting the wallpaper for
 * the only login.
 *
 * Lifted by name, so this is the code that ships: dropIdleBillboards decides
 * which ingests go, and ensureLiveDvr calls it before a real tune-in into a
 * full pool.
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
const LET_GO = Number(/const BILLBOARD_LET_GO_MS = (\d+);/.exec(SERVER)[1]);

const make = () => new Function(`
  const console = { log() {} };
  const BILLBOARD_LET_GO_MS = ${LET_GO};
  const remuxSessions = new Map();
  const killed = [];
  const killSession = (id) => { killed.push(id); remuxSessions.delete(id); };
  ${lift('dropIdleBillboards')}
  return { remuxSessions, killed, dropIdleBillboards };
`)();

const ago = (ms) => Date.now() - ms;

console.log(`\n  which streams give way (let go after ${LET_GO / 1000}s unfetched)`);
const box = make();
box.remuxSessions.set('live-201', { live: true, billboard: true, lastAccess: ago(LET_GO + 2000) });
box.remuxSessions.set('live-202', { live: true, billboard: true, lastAccess: ago(1000) });
box.remuxSessions.set('live-203', { live: true, billboard: false, lastAccess: ago(60000) });
box.remuxSessions.set('vod-9', { live: false, billboard: true, lastAccess: ago(60000) });
const dropped = box.dropIdleBillboards({}, 'test');
console.log('    dropped', box.killed);
check('a billboard stream the page has let go of is dropped',
  box.killed.includes('live-201'), JSON.stringify(box.killed));
check('one the billboard is still fetching is left playing',
  !box.killed.includes('live-202'), JSON.stringify(box.killed));
/* Somebody really watching a channel is never the billboard's to give away,
   however quiet their player has been. */
check('a channel somebody is actually watching is never touched',
  !box.killed.includes('live-203'), JSON.stringify(box.killed));
check('nor anything that is not live', !box.killed.includes('vod-9'), JSON.stringify(box.killed));
check('and it says how many it let go', dropped === 1, String(dropped));

console.log('\n  where it is called from');
const ensure = lift('ensureLiveDvr');
/* Only a REAL tune-in into a FULL pool pays for it. A billboard asking does
   not evict another billboard, and a pool with room evicts nothing. */
check('a real tune-in into a full pool clears the way first',
  /if \(!billboard && !providers\.pick\(cfg\)\) dropIdleBillboards\(/.test(ensure),
  'ensureLiveDvr does not call dropIdleBillboards before picking a login');
check('and the call comes before the login is picked',
  ensure.indexOf('dropIdleBillboards(') < ensure.indexOf('providers.pick(cfg, { reserve: true })'),
  'dropIdleBillboards runs after the login was already chosen');
/* The same channel opened for real while the billboard has it: one ingest,
   shared — and from then on it belongs to the viewer. */
check('a viewer who opens the billboard’s own channel takes it over',
  /if \(!billboard\) existing\.billboard = false;/.test(ensure),
  'a reused ingest stays marked as the billboard’s');
check('the box is told which requests are the billboard',
  /billboard: query\.get\('billboard'\) === '1'/.test(SERVER), '/api/play ignores billboard=1');
const desk = fs.readFileSync(path.join(PATHS.ROOT, 'public/desktop.js'), 'utf8');
check('and the billboard says so when it asks',
  /\/api\/play\?kind=live&ext=m3u8&billboard=1&id=/.test(desk), 'desktop.js asks without billboard=1');

console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
process.exit(fails.length ? 1 : 0);
