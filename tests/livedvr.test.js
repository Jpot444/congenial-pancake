/**
 * The Pi's own live buffer.
 *
 * The provider publishes ~60 seconds of playlist per channel, and that number
 * is the root of the live jumping-around: a slow viewer drifts, the segment
 * under the playhead expires off the provider's server, and the player is
 * FORCED forward — no client setting can prevent it, because the window is the
 * provider's property.
 *
 * So the server ingests the channel once (ffmpeg, stream copy) and republishes
 * it locally with a window of about two minutes. Checked here two ways: the
 * shape of the command and the wiring (source checks), and the actual lifecycle
 * against a fake ffmpeg that writes segments the way the real one does —
 * because "the session is shared" and "a film cell must not kill the live cell"
 * are claims about running code, not about text.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const PATHS = require('./paths.js');
const path = require('path');
const http = require('http');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-dvr';
const PORT = 8482;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

(async () => {
  const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

  /* ---- the command ------------------------------------------------------ */
  console.log('\n  the ingest command');
  // The archive drive's VOD path encodes old codecs, so the no-transcode
  // claim is scoped to the live ingest command itself.
  const dvrArgs = /function liveDvrArgs[\s\S]*?\n\}/.exec(SERVER)[0];
  // Ordinarily a stream copy, and that is not a preference: a Pi encoding
  // live HD video in realtime, for ever, is not something to do by accident.
  // The ONE exception is a viewer who has explicitly said their link cannot
  // carry the full stream, where a softer picture that keeps playing beats a
  // sharp one that stops — and even that runs at ultrafast, because a channel
  // that falls behind its own feed never catches up. If the encode cannot
  // keep up at all, the readiness check below drops the tune-in to the direct
  // proxy, which is the full-size stream: degraded, not broken.
  check('a channel is copied, never encoded, unless the viewer asked for small',
    /'-c', 'copy'\]/.test(dvrArgs) && /const videoArgs = low/.test(dvrArgs));
  check('and the encoder it reaches for then is the cheapest one there is',
    /'-preset', 'ultrafast'/.test(dvrArgs), dvrArgs.slice(0, 200));
  check('old segments are deleted, so disk use is one window, not a day of TV',
    /delete_segments/.test(SERVER));
  check('a respawn continues the playlist rather than starting a new one',
    /append_list/.test(SERVER));
  check('half-written segments are never served as though they were whole',
    /temp_file/.test(SERVER));
  check('transport drops are ridden out without the process exiting',
    /'-reconnect', '1', '-reconnect_streamed', '1'/.test(SERVER));
  // The input decides startup time. A TS push feed arrives at 1x and a stream
  // copy can only cut on keyframes, so the first segments took longer than the
  // readiness timeout and every tune-in fell back to the direct path — which a
  // measured v22.7 session spent 15 silent seconds proving. The provider's own
  // playlist has ~50s of already-published video in it; ingesting THAT from
  // its oldest segment banks the whole window at link speed.
  check('the ingest reads the provider playlist, not the realtime push feed',
    /buildStreamUrl\(cfg, 'live', channelId, 'm3u8'\)/.test(SERVER)
    && !/buildStreamUrl\(cfg, 'live', channelId, 'ts'\)/.test(SERVER));
  check('and banks the published backlog rather than joining at the edge',
    /'-live_start_index', '0',\s*'-i', input/.test(SERVER));
  // Readiness doubles as a speed test: a healthy feed banks the backlog at
  // several times realtime and shows two segments in seconds; a throttled one
  // cannot, and a viewer seated in ITS shallow window rides the ingest
  // frontier, stalling every few seconds — measured, and worse than the
  // direct path. The bar is what routes slow feeds to the direct path.
  check('readiness asks for two segments fast — a speed test, not existence',
    /\.length >= 2\) return session/.test(SERVER));
  check('and gives up quickly rather than making every tune-in wait',
    Number((/startWaitMs: (\d+)/.exec(SERVER) || [])[1]) <= 6000,
    (/startWaitMs: (\d+)/.exec(SERVER) || [])[1]);
  check('and warming up does not count as idleness to the reaper',
    /session\.lastAccess = Date\.now\(\); \/\/ warming is not idleness/.test(SERVER));
  // Never a bare `-map 0`: data and DVB-subtitle streams are what kill the
  // command on some channels. Every audio track is carried on a copy, where
  // extra tracks are free; the shrunk feed takes one, because encoding the
  // rest would be spending a Pi's CPU on audio nobody selected.
  check('data and DVB-subtitle streams are dropped, which is why -map 0 dies',
    /'-map', '0:v:0', '-map', low \? '0:a:0\?' : '0:a\?'/.test(SERVER), 'the mapping moved');

  const seg = Number((/segmentSeconds: (\d+)/.exec(SERVER) || [])[1]);
  const win = Number((/windowSegments: (\d+)/.exec(SERVER) || [])[1]);
  console.log(`   window: ${win} segments of ${seg}s = ${win * seg}s`);
  check('the window is about two minutes — the stated ceiling on being behind',
    win * seg >= 90 && win * seg <= 150, String(win * seg));
  check('and segments are short, so a cushion can be fetched in fine grain',
    seg <= 6, String(seg));

  /* ---- the wiring ------------------------------------------------------- */
  console.log('\n  the wiring');
  check('the DVR is tried first and ANY failure falls back to the direct proxy',
    /try \{\s*const session = await ensureLiveDvr[\s\S]{0,220}catch \{\s*\/\* direct proxy below \*\//.test(SERVER));
  check('the channel id is checked before it becomes a directory name',
    /\/\^\[\\w-\]\+\$\/\.test\(id\)/.test(SERVER));
  check('a live playlist is never closed with ENDLIST between drop and respawn',
    /session\.exited && !session\.live/.test(SERVER));
  check('a dropped feed is respawned for an audience, not declared an ending',
    /proc\.on\('exit'[\s\S]{0,900}spawnLiveDvr\(session, input, true\)/.test(SERVER));
  check('and the respawn marks a discontinuity, since its timestamps restart',
    /resumed \? '\+discont_start' : ''/.test(SERVER));
  // Both sweeps spare live, in their two different shapes: the blanket stop
  // still says so in one line, while the one that clears the way for a new
  // conversion now spares anything being watched — a live ingest first of
  // all — instead of killing the lot. The property is what matters, not the
  // spelling; the behavioural half is exercised against a running server
  // further down, and mvstreams.test.js walks the sweep's decision itself.
  check('the blanket stop spares live sessions',
    /if \(!sess\.live\) killSession\(id\)/.test(SERVER));
  check('and so does the sweep a new conversion runs',
    /for \(const \[id, sess\] of \[\.\.\.remuxSessions\]\) \{\s*\n\s*if \(sess\.live\) continue;/.test(SERVER));
  check('live sessions are reaped faster than conversions — they hold a connection',
    /idleMs: 45000/.test(SERVER) && /s\.idleMs \|\| 5 \* 60 \* 1000/.test(SERVER));

  console.log('\n  the client side of it');
  const seat = Number((/const LIVE_DVR_SEAT = (\d+)/.exec(APP) || [])[1]);
  console.log(`   seat: ${seat}s behind`);
  check('the DVR seat is deeper than the direct one — the window can hold it',
    seat > Number((/liveSyncDuration: (\d+)/.exec(APP) || [])[1]), String(seat));
  check('but inside the two minutes behind that is the outer limit',
    seat <= 60, String(seat));
  check('and it is only taken when the server says the DVR is serving',
    /opts\.dvr \? \{ liveSyncDuration: LIVE_DVR_SEAT \}/.test(APP));
  check('multiview cells take the same seat the same way',
    /dvr \? \{ liveSyncDuration: LIVE_DVR_SEAT \}/.test(APP.slice(0, APP.indexOf('function attach'))));
  check('the start-up wait is capped so a deep window is not a screening delay',
    /Math\.min\(w \* LIVE_PREROLL, LIVE_PREROLL_CAP\)/.test(APP)
    && Number((/const LIVE_PREROLL_CAP = (\d+)/.exec(APP) || [])[1]) <= 20);

  /* ---- the lifecycle, against a fake ffmpeg ----------------------------- */
  //
  // The fake honours the two arguments that matter — the segment filename
  // pattern and the playlist path — writes two segments immediately and one
  // every 2s after, and logs every invocation so sharing can be counted.
  console.log('\n  the lifecycle');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'fakebin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
seg=""; args=("$@")
for ((i=0;i<\${#args[@]};i++)); do
  [ "\${args[i]}" = "-hls_segment_filename" ] && seg="\${args[i+1]}"
done
playlist="\${args[-1]}"
dir=$(dirname "$playlist")
echo "spawn $dir" >> "${DIR}/ffmpeg-calls.log"
n=0
emit() {
  printf 'FAKETS%.0s' {1..200} > "$(printf "$seg" "$n")"
  n=$((n+1))
  { echo '#EXTM3U'; echo '#EXT-X-VERSION:3'; echo '#EXT-X-TARGETDURATION:4';
    echo "#EXT-X-MEDIA-SEQUENCE:0";
    for ((k=0;k<n;k++)); do echo '#EXTINF:4.0,'; printf 'seg%06d.ts\\n' "$k"; done;
    echo '#EXT-X-ENDLIST';
  } > "$playlist"
}
emit; emit
while :; do sleep 2; emit; done
`, { mode: 0o755 });

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      PATH: `${path.join(DIR, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await wait(1500);

  try {
    const play = await get('/api/play?kind=live&id=7');
    const answer = JSON.parse(play.body);
    console.log('   /api/play said:', play.body);
    check('a live channel is answered with the local window, marked as such',
      answer.url === '/hls/live-7/index.m3u8' && answer.dvr === true, play.body);

    const playlist = await get('/hls/live-7/index.m3u8');
    check('and the playlist is really there, with segments in it',
      playlist.status === 200 && /seg000000\.ts/.test(playlist.body),
      `${playlist.status}: ${playlist.body.slice(0, 80)}`);
    // The fake writes ENDLIST into the file the way real ffmpeg does when it
    // exits, so this checks the serving path actively REMOVES it — refraining
    // from adding one froze a measured session at the 90-second mark of a
    // game: the viewer reclassified the stream as finished and stopped
    // polling, so the respawned ingest played to nobody.
    check('ENDLIST is stripped even when ffmpeg itself wrote one',
      !playlist.body.includes('ENDLIST'), playlist.body);

    const segment = await get('/hls/live-7/seg000000.ts');
    check('segments are served from it', segment.status === 200
      && segment.body.startsWith('FAKETS'), String(segment.status));

    const again = JSON.parse((await get('/api/play?kind=live&id=7')).body);
    const calls = fs.readFileSync(path.join(DIR, 'ffmpeg-calls.log'), 'utf8')
      .split('\n').filter((l) => l.includes('live-7')).length;
    console.log(`   ffmpeg runs for the channel so far: ${calls}`);
    check('a second viewer of the channel joins the same session',
      again.url === '/hls/live-7/index.m3u8' && calls === 1,
      JSON.stringify({ again, calls }));

    const other = JSON.parse((await get('/api/play?kind=live&id=8')).body);
    check('a different channel gets its own — multiview needs several at once',
      other.url === '/hls/live-8/index.m3u8', JSON.stringify(other));

    // The sweep that a multiview film cell runs when it gives up on a film.
    await get('/api/remux/stop');
    const survived = await get('/hls/live-7/index.m3u8');
    check('and the kill-everything sweep leaves the channels playing',
      survived.status === 200, String(survived.status));
  } finally {
    server.kill('SIGKILL');
  }
  if (fails.length && serverLog) console.log('  server log:', serverLog.slice(-600));

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
