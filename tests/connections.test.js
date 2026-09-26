/**
 * How many streams this house can actually run.
 *
 * "im getting Refused: No connection free for this channel. ACC NETWORK HD is
 *  open. Close one and try again. i should be able to run multiple streams no
 *  problem."
 *
 * They could. The box was wrong about its own capacity.
 *
 * providers.slotsFor() answers with the provider's `max_connections` when it
 * knows it, and a conservative guess of ONE when it does not. The only thing
 * that ever filled that in was GET /api/providers — which is the manage-
 * providers panel in Settings and nothing else. So a box that had rebooted
 * believed every login allowed a single connection, indefinitely, until
 * somebody happened to open Settings. The Pi reboots; nobody opens Settings
 * afterwards.
 *
 * With two logins that makes the house two streams wide no matter what the
 * account allows. The third window is then "crowded" — and `crowded` is the
 * flag that decides whether a failed ingest is reported as a CONNECTION
 * problem. So a slow feed, a dead channel, anything at all going wrong on the
 * third window came back as "No connection free", naming one open channel and
 * blaming a pool that was not full. Being wrong about capacity turned every
 * other fault into a lie about connections.
 *
 * Two claims here, and the second is the one that keeps the first honest:
 *
 *   1. The box learns what the provider allows without being asked to, and
 *      runs that many streams.
 *   2. A login it genuinely cannot reach still falls back to the careful
 *      guess — the refusal must not become impossible, only correct.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-conns';
const PORT = 8476;
const PANEL = 9476;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const YEAR = 365 * 86400000;

/* Four channels that ingest, and one that never will. 905 is the dead feed:
   it is how "something else went wrong" is spelled, and the whole question is
   what the box says about it. */
const CHANNELS = [
  { num: 1, stream_id: 901, name: 'ESPN HD', stream_type: 'live', category_id: '1' },
  { num: 2, stream_id: 902, name: 'ACC NETWORK HD', stream_type: 'live', category_id: '1' },
  { num: 3, stream_id: 903, name: 'FOX SPORTS 1', stream_type: 'live', category_id: '1' },
  { num: 4, stream_id: 904, name: 'NFL NETWORK', stream_type: 'live', category_id: '1' },
  { num: 5, stream_id: 905, name: 'DEAD FEED', stream_type: 'live', category_id: '1' },
];

/** The panel says four connections — and counts how often it is asked. */
let probes = 0;
let panelUp = true;
function panelServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/player_api.php') {
      const action = url.searchParams.get('action') || '';
      if (!action) probes += 1;
      if (!panelUp) { res.writeHead(500); return res.end('down'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_streams') return res.end(JSON.stringify(CHANNELS));
      if (action === 'get_live_categories') {
        return res.end(JSON.stringify([{ category_id: '1', category_name: 'Sports' }]));
      }
      if (action) return res.end('[]');
      return res.end(JSON.stringify({ user_info: {
        auth: 1, status: 'Active', is_trial: '0',
        exp_date: String(Math.floor((Date.now() + YEAR) / 1000)),
        /* The number the whole suite turns on. The box guesses 1 when it has
           not asked; this account allows four. */
        max_connections: '4', active_cons: '0',
      } }));
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n'
      + '#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:11.0,\nseg1.ts\n');
  });
  return server;
}

function fakeFfmpeg(dir) {
  fs.mkdirSync(path.join(dir, 'fakebin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
args=("$@"); out="\${args[-1]}"
all="$*"
case "$all" in
  *"/905."*) echo "Server returned 404 Not Found" >&2; exit 1 ;;
esac
dir="$(dirname "$out")"
printf 'INIT' > "$dir/init.mp4"
printf 'SEG' > "$dir/seg000000.m4s"
printf 'SEG' > "$dir/seg000001.m4s"
printf '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-MAP:URI="init.mp4"\\n#EXTINF:4.0,\\nseg000000.m4s\\n#EXTINF:4.0,\\nseg000001.m4s\\n' > "$out"
while true; do sleep 1; done
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'fakebin', 'ffprobe'), `#!/bin/bash
echo '{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"0"}}'
exit 0
`, { mode: 0o755 });
}

function box() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));
  fakeFfmpeg(DIR);
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`,
    username: 'u', password: 'p', preferredFormat: 'm3u8',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  /* Its own process group: the fake ffmpeg holds its connection with a sleep
     loop the way a real ingest does, and SIGKILL on the box does not reach a
     grandchild. */
  return spawn('node', ['server.js'], {
    cwd: DIR,
    detached: true,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      PATH: `${path.join(DIR, 'fakebin')}:${process.env.PATH}`,
      DOWNLOADS_ROOT: path.join(DIR, 'store') },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const call = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' },
    (res) => {
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

const play = (id) => call(`/api/play?kind=live&id=${id}&ext=m3u8`);

(async () => {
  const panel = panelServer();
  await new Promise((r) => panel.listen(PANEL, '127.0.0.1', r));
  let server = box();

  try {
    for (let i = 0; i < 60; i += 1) {
      try { await call('/api/health'); break; } catch { await wait(250); }
    }
    const lib = await call('/api/library?tab=live&all=1');
    check('the box has the channel list, so it can use names',
      (lib.data.items || []).length === 5, JSON.stringify(lib.data).slice(0, 140));

    /* ---- 1. it knows how big the house is, without being asked ---------- */
    /*
     * Nothing here opens Settings. That is the entire point: the old box only
     * ever learned this from the manage-providers panel, so a restart left it
     * believing one connection per login.
     */
    console.log('\n  what the box thinks it can run, having never been to Settings');
    check('it asked the provider at boot rather than guessing',
      probes >= 1, `${probes} probes`);

    /* ---- 2. the regression this fix could most easily cause ------------- */
    /*
     * Checked FIRST, while nothing is holding anything, because a live ingest
     * has no stop button — it is shared between viewers and reaps itself when
     * nobody fetches — so this is the only moment the house is empty.
     *
     * A dead feed with a connection FREE is not a crowding problem, and the
     * direct proxy is the deliberate, measured answer for it. Widening the
     * pool must not turn that path off; it must only stop the box reporting
     * it as a connection problem when it is not one.
     */
    console.log('\n  a dead feed with room to spare still goes direct');
    const lonely = await play(905);
    console.log('   ', lonely.status, JSON.stringify(lonely.data).slice(0, 160));
    check('it is not refused', lonely.status === 200,
      `${lonely.status} ${lonely.data.error || ''}`);
    check('and it is the direct path, exactly as before',
      lonely.data.dvr !== true, JSON.stringify(lonely.data).slice(0, 160));

    /* ---- 3. THE REPORT ---------------------------------------------- */
    /*
     * "Refused: No connection free for this channel. ACC NETWORK HD is open.
     *  Close one and try again. i should be able to run multiple streams."
     *
     * One channel open, and a second that fails for a reason of its own. On a
     * four-connection account that is three slots free and a dead feed — so
     * the answer is the direct path and a fault about the feed, never a
     * sentence about connections naming the one channel that is open.
     *
     * This is the assertion that fails on the old box, and it fails with the
     * reported sentence almost word for word: capacity was believed to be one
     * per login, ACC NETWORK HD held it, and every other fault inherited the
     * blame.
     */
    console.log('\n  one channel open, and a second that fails for its own reasons');
    const held = await play(902);                       // ACC NETWORK HD, ingests
    check('the first one is playing', held.status === 200 && held.data.dvr === true,
      JSON.stringify(held.data).slice(0, 120));
    const second = await play(905);                     // the dead feed
    console.log('   ', second.status, JSON.stringify(second.data).slice(0, 160));
    check('the second is not blamed on connections that are not in use',
      !/No connection free/.test(second.data.error || ''),
      `${second.status} ${second.data.error || ''}`);
    check('it is served the way a dead feed always was', second.status === 200,
      `${second.status} ${second.data.error || ''}`);

    /* ---- 3b. four streams, because the account allows four -------------- */
    /*
     * Started TOGETHER, the way the multiview builder starts them since
     * "one press start watching I want all streams already going". Four
     * simultaneous picks is also what shakes out the reservation accounting:
     * each start reserves a slot and then claims it, and a claim that took
     * somebody else's reservation would show up as a refusal here.
     */
    console.log('\n  and four windows at once, on an account that allows four');
    const four = await Promise.all([901, 902, 903, 904].map(play));
    console.log('   ', JSON.stringify(four.map((r) => ({ s: r.status, e: r.data.error }))));
    check('all four are handed a stream', four.every((r) => r.status === 200),
      JSON.stringify(four.map((r) => `${r.status} ${r.data.error || ''}`)));
    check('and each is its own ingest off the box, not the direct proxy',
      four.every((r) => r.data.dvr === true && /^\/hls\//.test(r.data.url || '')),
      JSON.stringify(four.map((r) => r.data.url)));

    /* ---- 4. and a fault on top of that is named for what it is ---------- */
    /*
     * THE REPORT. With four open the pool really is full, so this fifth one
     * is genuinely crowded — and a refusal naming what is open is right.
     *
     * What was wrong before is that this sentence arrived on the SECOND
     * window, not the fifth.
     */
    console.log('\n  a fifth, with the house genuinely full');
    const fifth = await play(905);
    console.log('   ', fifth.status, JSON.stringify(fifth.data).slice(0, 200));
    check('it is refused, and the refusal names what is open',
      fifth.status === 503 && /No connection free/.test(fifth.data.error || '')
      && /ESPN HD|ACC NETWORK HD/.test(fifth.data.error || ''),
      JSON.stringify(fifth.data).slice(0, 200));
    check('and it says how big the house is, in the provider\'s own number',
      fifth.data.capacity === 4, String(fifth.data.capacity));

  } catch (err) {
    console.log('  HARNESS ERROR', err.message);
    fails.push('harness');
  } finally {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    panel.close();
  }

  /* ---- 5. a provider that cannot be reached keeps the careful guess ----- */
  /*
   * The fix is "find out" — so what happens when finding out is impossible
   * matters. It must fall back to the conservative one-per-login, not to
   * optimism: a box that assumed plenty on an unreachable panel would open
   * four connections on a single-connection account, which is the failure
   * this pool exists to prevent.
   *
   * Checked against providers.js directly. Standing a second box up for it
   * would be a minute of waiting to observe one number.
   */
  console.log('\n  and a login the box cannot reach keeps the careful guess');
  const providers = require(path.join(ROOT, 'providers.js'));
  const cfg = { mode: 'xtream',
    accounts: [{ id: 'q1', host: 'http://x', username: 'u', password: '' }] };
  check('an account nobody has asked about counts as one connection',
    providers.capacity(cfg) === 1, String(providers.capacity(cfg)));
  check('and says so, so a caller can go and find out',
    providers.anyGuessed(cfg) === true, String(providers.anyGuessed(cfg)));
  providers.note('q1', { max_connections: '4', auth: 1 });
  check('once asked, it is the provider\'s number',
    providers.capacity(cfg) === 4 && providers.anyGuessed(cfg) === false,
    `${providers.capacity(cfg)} / ${providers.anyGuessed(cfg)}`);
  /* A hiccup is not the provider saying the account shrank. Clearing the
     number here would drop the house back to one connection on a dropped
     packet, which is the original bug wearing a network error. */
  providers.noteError('q1', 'connect ETIMEDOUT');
  check('and a failed refresh does not shrink the house back to the guess',
    providers.capacity(cfg) === 4, String(providers.capacity(cfg)));

  /* ---- 6. one start does not cancel another's reservation -------------- */
  /*
   * A reservation covers the gap between choosing a login and opening the
   * pipe. take() used to drop the OLDEST reservation on the login whoever
   * called it — so a download, or an ingest that found the pool full and
   * started anyway, cancelled the reservation a different start was relying
   * on. Two starts at once could each cancel the other's, which is precisely
   * what four cells starting together does.
   */
  console.log('\n  and one start does not cancel another\'s reservation');
  providers.forget('q1');
  providers.note('q1', { max_connections: '4', auth: 1 });
  const mine = providers.pick(cfg, { reserve: true });
  const freeWithMine = providers.free(cfg);
  providers.take('q1');                       // something else, with no reservation
  check('an unrelated take does not consume the reservation',
    providers.free(cfg) === freeWithMine - 1,
    `${freeWithMine} -> ${providers.free(cfg)}`);
  providers.claim('q1', mine.ticket);         // and now the reservation is claimed
  check('and claiming it afterwards costs one slot, not two',
    providers.free(cfg) === freeWithMine - 1,
    `${freeWithMine} -> ${providers.free(cfg)}`);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
