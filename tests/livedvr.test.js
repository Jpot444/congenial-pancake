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
  check('the PICTURE is copied, never encoded, unless the viewer asked for small',
    /'-c:v', 'copy'\]/.test(dvrArgs) && /const videoArgs = low/.test(dvrArgs));
  /* The sound is the exception, and deliberately so. `codec_name` is `aac` for
     both AAC-LC and HE-AAC, and a decoder that takes an HE-AAC core alone
     plays it an octave down and at half speed — deep, dragging voices over
     normal video. Re-encoding to plain stereo AAC-LC at a fixed rate is a
     couple of percent of one core and removes the question. */
  check('but the SOUND is always re-encoded, so HE-AAC cannot reach a decoder',
    /'-c:a', 'aac', '-profile:a', 'aac_low'/.test(dvrArgs)
      && /'-ar', '48000'/.test(dvrArgs), dvrArgs.slice(0, 200));
  /* The other half of the same fault: a TS segment reaches hls.js as a stream
     it must demux and rebuild itself, reconstructing AAC timing from ADTS
     headers — and wrong spacing is heard as a pitch shift. On films, pinning
     the encoder was not enough on its own; fMP4 was what fixed it. */
  check('and segments are fMP4, so nobody has to rebuild the audio timing',
    /'-hls_segment_type', 'fmp4'/.test(dvrArgs)
      && /seg%06d\.m4s/.test(dvrArgs), dvrArgs.slice(-400));
  check('and the encoder it reaches for then is the cheapest one there is',
    /'-preset', 'ultrafast'/.test(dvrArgs), dvrArgs.slice(0, 200));
  check('old segments are deleted, so disk use is one window, not a day of TV',
    /delete_segments/.test(SERVER));
  check('a respawn continues the playlist rather than starting a new one',
    /append_list/.test(SERVER));
  /* Both ends of this are the same report, six weeks apart.
   *
   * A RESPAWN must take the live edge: the backlog is content the viewer has
   * already watched, and republishing it on the end of the window snaps the
   * picture back about a minute.
   *
   * A COLD start must be BOUNDED. It used to be '0' — the oldest segment the
   * provider publishes — on the belief that they keep about fifty seconds. A
   * news channel on the same account keeps ten minutes, and '0' on that
   * playlist opens the tune-in ten minutes in the past. The index has to be
   * counted back from their edge, so the depth is ours whatever they keep. */
  check('a respawn joins at the live edge, taking no backlog at all',
    /'-live_start_index', resumed \? '-1' :/.test(dvrArgs), dvrArgs.slice(0, 400));
  check('and a cold start is bounded, counted back from their edge not forward from the start',
    /'-live_start_index', resumed \? '-1' : `-\$\{COLD_START_SEGMENTS\}`/.test(dvrArgs)
    && /const COLD_START_SEGMENTS = (\d+);/.test(SERVER)
    && Number(/const COLD_START_SEGMENTS = (\d+);/.exec(SERVER)[1]) <= 20,
    dvrArgs.slice(0, 400));
  check('half-written segments are never served as though they were whole',
    /temp_file/.test(SERVER));
  check('transport drops are ridden out without the process exiting',
    /'-reconnect', '1', '-reconnect_streamed', '1'/.test(SERVER));
  /* The one that was missing, and its absence was the "it jumped forward"
     report. The three above cover a socket that BREAKS; this covers one that
     ENDS POLITELY, which is what the provider does when the ingest catches up
     to the live edge and asks for a segment that does not exist yet. ffmpeg
     read that as the stream being over and exited CLEANLY — code 0, twice in
     ninety seconds in the capture that found it — and every exit leaves a
     hole the viewer skips over, because the resume takes the live edge and
     never ingests what was published while it was down.

     The film path had carried this flag for months. The live path had three
     of the four. */
  check('and so is a live edge that has not published the next segment yet',
    /'-reconnect_at_eof', '1'/.test(dvrArgs)
    && /'-m3u8_hold_counters'/.test(dvrArgs), dvrArgs.slice(0, 600));
  // The input decides startup time. A TS push feed arrives at 1x and a stream
  // copy can only cut on keyframes, so the first segments took longer than the
  // readiness timeout and every tune-in fell back to the direct path — which a
  // measured v22.7 session spent 15 silent seconds proving. The provider's own
  // playlist is already published, so reading a bounded run of it banks the
  // window at link speed rather than trickling in at 1x.
  // Written against the ext rather than the login the URL is built from: with
  // a pool of accounts that argument is whichever one had a free slot, and
  // the claim here is about which FEED is ingested, not whose it is.
  check('the ingest reads the provider playlist, not the realtime push feed',
    /buildStreamUrl\([^)]+, 'live', channelId, 'm3u8'\)/.test(SERVER)
    && !/buildStreamUrl\([^)]+, 'live', channelId, 'ts'\)/.test(SERVER));
  check('and a new ingest refuses rather than opening ffmpeg on an uncounted login',
    /if \(!account\) throw new Error\('No free provider connection for live ingest'\)/.test(SERVER));
  check('and banks a published run of it rather than trickling in from the edge',
    /'-live_start_index', resumed \? '-1' : `-\$\{COLD_START_SEGMENTS\}`,\s*'-i', input/
      .test(SERVER));
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
  // command on some channels. One audio track rather than all of them, now
  // that the audio is encoded rather than copied — nothing in either player
  // picks between muxed live tracks, so the rest would be encoded for nobody.
  check('data and DVB-subtitle streams are dropped, which is why -map 0 dies',
    /'-map', '0:v:0', '-map', '0:a:0\?'/.test(SERVER), 'the mapping moved');

  /* The detector itself, on two playlists: one rolling forward the way a
     healthy window does, and one that starts over — which is a player's cue
     to treat the stream as new and join it at the beginning, and is exactly
     what the viewer sees as "it went back to where I was". */
  console.log('\n  noticing a window that started over');
  const lift = (name) => {
    const start = SERVER.indexOf(`function ${name}(`);
    let depth = 0;
    /* From the BODY's brace, not the first one after the name: a default
       parameter value like `detail = {}` is a brace inside the signature, and
       counting from there closes the function before it has begun. */
    let i = SERVER.indexOf('{', SERVER.indexOf(')', start));
    for (; i < SERVER.length; i += 1) {
      if (SERVER[i] === '{') depth += 1;
      else if (SERVER[i] === '}' && --depth === 0) break;
    }
    return SERVER.slice(start, i + 1);
  };
  // eslint-disable-next-line no-new-func
  const watch = new Function(
    `${lift('liveNote')}\n${lift('segNumber')}\n${lift('watchLivePlaylist')}\n`
    + 'const LIVE_NOTES = 60; return watchLivePlaylist;'
  )();
  const playlist = (sequence, from, count) => ['#EXTM3U', '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${sequence}`,
    '#EXT-X-MAP:URI="init.mp4"',
    ...Array.from({ length: count }, (_, k) => `#EXTINF:4.0,\nseg${String(from + k).padStart(6, '0')}.m4s`),
  ].join('\n');

  const box = {};
  watch(box, playlist(0, 0, 3));
  watch(box, playlist(1, 1, 3));
  check('an ordinary roll is recorded as one',
    box.notes.map((n) => n.event).join(',') === 'window-open,window-rolled',
    JSON.stringify(box.notes.map((n) => n.event)));
  watch(box, playlist(0, 0, 3));
  check('and a window that starts over is called what it is',
    box.notes[box.notes.length - 1].event === 'window-restarted',
    JSON.stringify(box.notes.map((n) => n.event)));
  check('with what it was and what it became, so the jump is measurable',
    box.notes[box.notes.length - 1].was.first === 1
      && box.notes[box.notes.length - 1].now.first === 0,
    JSON.stringify(box.notes[box.notes.length - 1]));

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
  const playHandler = SERVER.slice(SERVER.indexOf("pathname === '/api/play'"));
  check('and a successful DVR tune does not first reserve a proxy slot it will never use',
    playHandler.indexOf('ensureLiveDvr') < playHandler.indexOf("pick(cfg, { reserve: true })"),
    'reserve still sits above the DVR attempt');
  check('the channel id is checked before it becomes a directory name',
    /\/\^\[\\w-\]\+\$\/\.test\(id\)/.test(SERVER));
  check('a live playlist is never closed with ENDLIST between drop and respawn',
    /session\.exited && !session\.live/.test(SERVER));
  /* The span is generous because it is measuring "inside the exit handler",
     and the handler has grown a paragraph explaining what it keeps in the
     black box. A tighter bound was measuring comment length. */
  check('a dropped feed is respawned for an audience, not declared an ending',
    /proc\.on\('exit'[\s\S]{0,1600}spawnLiveDvr\(session, input, true\)/.test(SERVER));
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
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js', 'recordings.js', 'recommend.js']) {
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
  printf 'FAKESEG%.0s' {1..200} > "$(printf "$seg" "$n")"
  n=$((n+1))
  { echo '#EXTM3U'; echo '#EXT-X-VERSION:7'; echo '#EXT-X-TARGETDURATION:4';
    echo "#EXT-X-MEDIA-SEQUENCE:0";
    echo '#EXT-X-MAP:URI="init.mp4"';
    for ((k=0;k<n;k++)); do echo '#EXTINF:4.0,'; printf 'seg%06d.m4s\\n' "$k"; done;
    echo '#EXT-X-ENDLIST';
  } > "$playlist"
}
printf 'FAKEINIT%.0s' {1..40} > "$dir/init.mp4"
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

    const pool = JSON.parse((await get('/api/providers')).body);
    console.log('   pool after DVR tune-in:', JSON.stringify({
      inUse: pool.inUse, free: pool.free, streams: (pool.accounts || []).map((a) => a.streams),
    }));
    check('the ingest is counted as using a connection, not left as a dangling reservation',
      pool.inUse >= 1, JSON.stringify({ inUse: pool.inUse, free: pool.free }));

    const playlist = await get('/hls/live-7/index.m3u8');
    check('and the playlist is really there, with segments in it',
      playlist.status === 200 && /seg000000\.m4s/.test(playlist.body),
      `${playlist.status}: ${playlist.body.slice(0, 80)}`);
    // The fake writes ENDLIST into the file the way real ffmpeg does when it
    // exits, so this checks the serving path actively REMOVES it — refraining
    // from adding one froze a measured session at the 90-second mark of a
    // game: the viewer reclassified the stream as finished and stopped
    // polling, so the respawned ingest played to nobody.
    check('ENDLIST is stripped even when ffmpeg itself wrote one',
      !playlist.body.includes('ENDLIST'), playlist.body);

    const segment = await get('/hls/live-7/seg000000.m4s');
    check('segments are served from it', segment.status === 200
      && segment.body.startsWith('FAKESEG'), String(segment.status));
    const init = await get('/hls/live-7/init.mp4');
    check('and so is the init segment every fMP4 window needs',
      init.status === 200 && init.body.startsWith('FAKEINIT'), String(init.status));

    /* The black box. "It jumped back to where I started watching" is a report
       about a moment that has already gone, so each live session keeps its
       last few dozen notable moments and the box will say what they were. */
    const report = JSON.parse((await get('/api/live/report')).body);
    const mine = (report.sessions || []).find((row) => row.id === 'live-7') || {};
    const events = (mine.notes || []).map((n) => n.event);
    console.log('   notes:', JSON.stringify(events));
    check('the channel keeps a record of what its window has done',
      events.includes('ingest-started') && events.includes('window-open'),
      JSON.stringify(events));
    check('with the window it is currently publishing',
      mine.window && Number.isFinite(mine.window.first), JSON.stringify(mine.window));

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
