/**
 * Being told which channels are holding the provider's connections.
 *
 * "i have a multiview going that is streaming fine. I have another window
 *  with only redzone on it and it keeps pausing."
 *
 * The report that came with it named the fault exactly, in a line nobody had
 * had to read before:
 *
 *   playlist reset  seq 3325→3288 · 3332→3298 · 3335→3300 · 3301→2037
 *
 * A media sequence does not go backwards. Four different upstream nodes did,
 * and the reason the player was talking to four of them is that it was on the
 * DIRECT PROXY — no pinned upstream, every playlist refresh an independent
 * request the provider is free to answer from wherever it likes. hls.js
 * cannot survive that: the timeline is invalidated, the buffer with it, and
 * playback becomes stall, a seek nobody asked for, a reload, two seconds of
 * picture, stall. Which from the sofa is "it keeps pausing".
 *
 * It was on the direct proxy because `ensureLiveDvr` had failed and the
 * failure was swallowed:
 *
 *   } catch {
 *     \/* direct proxy below *\/
 *   }
 *
 * The ingest holds one connection for the life of a channel, so a multiview
 * in the other window was holding them all and there was none left for this
 * one. The box knew that and said nothing.
 *
 * Two things are checked here, and the second matters as much as the first:
 *
 *   1. A crowded failure is REFUSED, in words, naming what is open.
 *   2. A failure with a slot FREE still falls back to the direct proxy —
 *      that is the slow-feed path, it is deliberate, it is measured, and this
 *      change must not take it away.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-crowded';
const PORT = 8474;
const PANEL = 9474;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const YEAR = 365 * 86400000;

/* Two channels with names worth reading back in a sentence, and a third that
   is never asked for. 901 ingests happily; 902's ingest always dies. */
const CHANNELS = [
  { num: 1, stream_id: 901, name: 'FOX', stream_type: 'live', category_id: '1' },
  { num: 2, stream_id: 902, name: 'NFL RedZone', stream_type: 'live', category_id: '1' },
];

function panelServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/player_api.php') {
      const action = url.searchParams.get('action') || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      if (action === 'get_live_streams') return res.end(JSON.stringify(CHANNELS));
      if (action === 'get_live_categories') {
        return res.end(JSON.stringify([{ category_id: '1', category_name: 'Sports' }]));
      }
      if (action) return res.end('[]');
      /* One login, one connection. That single number is the whole premise. */
      return res.end(JSON.stringify({ user_info: {
        auth: 1, status: 'Active', is_trial: '0',
        exp_date: String(Math.floor((Date.now() + YEAR) / 1000)),
        max_connections: '1', active_cons: '0',
      } }));
    }
    /* The playlist a direct-proxy fallback would fetch. Its presence is what
       makes the fallback a real 200 rather than an error by another name. */
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n'
      + '#EXT-X-MEDIA-SEQUENCE:3325\n#EXTINF:11.0,\nseg1.ts\n');
  });
  return server;
}

/*
 * An ffmpeg that ingests 901 and refuses 902.
 *
 * Refusing is how a provider answers a request for one more stream than the
 * account has, and it is the exact shape of the failure being handled: the
 * process exits non-zero having written nothing.
 */
function fakeFfmpeg(dir) {
  fs.mkdirSync(path.join(dir, 'fakebin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
args=("$@"); out="\${args[-1]}"
all="$*"
case "$all" in
  *"/902."*) echo "Server returned 403 Forbidden" >&2; exit 1 ;;
esac
dir="$(dirname "$out")"
printf 'INIT' > "$dir/init.mp4"
printf 'SEG' > "$dir/seg000000.m4s"
printf 'SEG' > "$dir/seg000001.m4s"
printf '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-MAP:URI="init.mp4"\\n#EXTINF:4.0,\\nseg000000.m4s\\n#EXTINF:4.0,\\nseg000001.m4s\\n' > "$out"
# Hold the connection the way a real ingest does, until it is killed.
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
    'providers.js', 'recordings.js', 'recommend.js', 'market.js']) {
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
  /*
   * Its own process group, so the whole tree can be taken down together.
   *
   * The fake ffmpeg below holds its connection with a sleep loop, the way a
   * real ingest holds one — and SIGKILL on the box does not reach a
   * grandchild. Eleven of them were found still running long after this suite
   * had finished, holding ports and slowing every sweep after it. Killing the
   * GROUP is what actually ends them.
   */
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

(async () => {
  const panel = panelServer();
  await new Promise((r) => panel.listen(PANEL, '127.0.0.1', r));
  const server = box();

  try {
    for (let i = 0; i < 60; i += 1) {
      try { await call('/api/health'); break; } catch { await wait(250); }
    }

    /* The catalogue, so the box knows FOX is called FOX. Without this the
       refusal can only say "channel 901", which is true and much less use. */
    const lib = await call('/api/library?tab=live&all=1');
    check('the box has the channel list, so it can use names',
      (lib.data.items || []).length === 2, JSON.stringify(lib.data).slice(0, 140));

    /* ---- 1. a feed that fails with a slot free still goes direct -------- */
    /*
     * Checked FIRST, while nothing is holding anything, because it is the
     * regression this change could most easily have caused.
     *
     * A slow or dead feed with a connection going spare is not a crowding
     * problem, and the direct path is the right answer for it — chosen
     * deliberately, and measured. Refusing it too would turn one fixed fault
     * into a new one.
     */
    console.log('\n  a feed that fails with a connection free still goes direct');
    const alone = await call('/api/play?kind=live&id=902&ext=m3u8');
    console.log('   ', alone.status, JSON.stringify(alone.data).slice(0, 140));
    check('it is not refused, because nothing is holding anything',
      alone.status === 200, `${alone.status} ${alone.data.error || ''}`);
    check('and it is the direct proxy, exactly as before',
      /^\/stream\?u=/.test(alone.data.url || ''), alone.data.url);

    /* The reservation pick() took for that attempt lapses on its own; give it
       the moment it needs so the next section is about the ingest, not about
       a lease that has not expired yet. */
    await wait(1200);

    /* ---- 2. one channel takes the one connection ----------------------- */
    console.log('\n  the connection goes to the first channel');
    const first = await call('/api/play?kind=live&id=901&ext=m3u8');
    console.log('   ', JSON.stringify(first.data).slice(0, 120));
    check('it opens, and through the box rather than the provider',
      first.status === 200 && first.data.dvr === true
      && /^\/hls\//.test(first.data.url || ''), JSON.stringify(first.data));

    /* ---- 3. and the second is told why it cannot have one -------------- */
    /*
     * This is the whole change. Before it, this call returned 200 and a
     * /proxy URL, and the player went off to discover the provider's
     * backwards sequence numbers on its own.
     */
    console.log('\n  and the second window is told what is holding it');
    const second = await call('/api/play?kind=live&id=902&ext=m3u8');
    console.log('   ', second.status, JSON.stringify(second.data).slice(0, 200));
    check('it is refused rather than handed a stream that cannot work',
      second.status === 503, `${second.status}`);
    check('and it does not quietly hand over the direct proxy',
      !second.data.url, JSON.stringify(second.data).slice(0, 160));
    check('it says there is no connection free',
      /no connection free/i.test(second.data.error || ''), second.data.error);
    check('and names the channel that is holding it, by name',
      /FOX/.test(second.data.error || ''), second.data.error);
    check('and says what to do about it',
      /close one/i.test(second.data.error || ''), second.data.error);
    check('with the holders handed back as facts, not just as a sentence',
      Array.isArray(second.data.holders)
      && second.data.holders.some((h) => h.kind === 'live' && h.what === 'FOX'),
      JSON.stringify(second.data.holders));
    check('and the crowding said plainly, so a page can tell it apart',
      second.data.crowded === true, JSON.stringify(second.data.crowded));

  } finally {
    /* The group, not the process: see the note by box(). A negative pid is
       the group, and the fallback covers a box that died on its own and took
       its group id with it. */
    try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
    panel.close();
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
