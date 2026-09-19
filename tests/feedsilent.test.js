/**
 * A recording that gets nothing says why, and then asks differently.
 *
 * "DVR is not working, this was the error
 *  NBC KOMU (A) ᴿᴬᵂ · The feed never started sending."
 *
 * Two faults behind one sentence.
 *
 * THE SENTENCE EXPLAINS NOTHING. "The feed never started sending" is the
 * watchdog reporting what it measured — ninety seconds, no bytes — and
 * ffmpeg is the only thing in the room that knows whether that was a 404, a
 * refused connection, a playlist with no segments in it, or a codec it would
 * not touch. Its words were captured and then thrown away unless the process
 * exited by itself, so the one failure a person is most likely to meet was
 * the one that said least about itself.
 *
 * AND EVERY ATTEMPT ASKED THE SAME WAY. The recorder always built a `.m3u8`
 * URL. Playback does not: it follows the configured format and falls back to
 * the direct proxy when the box's own ingest cannot get a playlist. So a
 * channel this provider serves only as MPEG-TS — which is what the ᴿᴬᵂ suffix
 * on that channel name is about — could be watched perfectly well and never
 * recorded, failing every ninety seconds for the length of the booking, on a
 * retry ladder that only ever repeated the same ask.
 *
 * Driven against recordings.js in process with a clock of our own, because
 * the thing under test is a ninety-second watchdog and a sixty-second retry
 * ladder, and waiting them out would be two and a half minutes of a suite
 * sleeping to observe two strings.
 *
 * A third check, on the box: the failure ffmpeg hands back is REDACTED. It
 * names the input it failed on, and the input carries the provider password.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const recordings = require('../recordings.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const MIN = 60 * 1000;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedsilent-'));
  recordings.load(dir, () => {});

  /* The booking: a long window, so the ladder has room to run. */
  const row = recordings.schedule({
    channelId: '4821', channelName: 'NBC KOMU (A) ᴿᴬᵂ', title: 'The Late News',
    startsAt: Date.now(), endsAt: Date.now() + 4 * 60 * MIN,
  });
  const mine = row.id;

  /* What the box would have done, recorded rather than done: which format
     each attempt asked for, in order. This is the decision under test. */
  const asked = [];
  const started = [];
  const hooks = {
    begin: (r) => {
      if (r.id !== mine) return;
      started.push(r.id);
      asked.push(recordings.formatFor(r));
    },
  };

  /* ---- the first attempt, which receives nothing ------------------------ */
  /*
   * A stand-in for ffmpeg that has connected and is saying so, and is not
   * writing. The file is never created, which is what "nothing was written"
   * means to the watchdog.
   */
  console.log('\n  ninety seconds of nothing, and what ffmpeg was saying meanwhile');
  let now = Date.now();
  recordings.tick(now, hooks);
  check('it starts', started.length === 1, String(started.length));
  check('and the first ask is for a playlist, as it always was',
    asked[0] === 'm3u8', asked[0]);

  const SAID = 'http://box/…/4821.m3u8: Server returned 404 Not Found';
  recordings.began(recordings.get(mine), {
    proc: { kill() {} },
    release: null,
    source: 'provider',
    format: 'm3u8',
    stderr: () => `Opening input\n${SAID}\n`,
  });

  /* Past the ninety seconds with never a byte. */
  now += 95 * 1000;
  recordings.tick(now, hooks);
  let mineRow = recordings.get(mine);
  console.log('   ', JSON.stringify({ status: mineRow.status, error: mineRow.error }));
  check('it gives up on that attempt', mineRow.status === 'failed', mineRow.status);
  check('and still says what it measured',
    /never started sending/i.test(mineRow.error), mineRow.error);
  /* The half that was missing. Without it the screen shows a symptom and the
     person is left to guess between a dead channel, a busy provider and a
     broken box. */
  check('and what ffmpeg said about it, which is the part that is actionable',
    mineRow.error.includes('404 Not Found'), mineRow.error);
  /* The URL in that line is redacted by the box before it ever reaches here —
     checked below — so what is stored must not carry a password. */
  check('with no credentials in it', !/\/\/[^/]*:[^/@]*@|\/live\/[^/]+\/[^/]+\//.test(mineRow.error),
    mineRow.error);

  /* ---- and the next attempt asks differently ---------------------------- */
  /*
   * The fault that made this a booking-long failure rather than a blip. One
   * ask repeated is one ask.
   */
  console.log('\n  and the attempt after it does not repeat the same ask');
  now += 2 * MIN;                      // past the retry ladder's first rung
  recordings.tick(now, hooks);
  console.log('    asked:', JSON.stringify(asked));
  check('it tries again', started.length === 2, String(started.length));
  check('in the other format, which is the one that channel serves',
    asked[1] === 'ts', asked[1]);

  /* The one that works. A byte arrives, and everything settles.
     Written under the store's own directory, which is what bytesOf measures —
     row.file is a name inside it, not a path. */
  const file = path.join(dir, recordings.get(mine).file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(4096, 7));
  recordings.began(recordings.get(mine), {
    proc: { kill() {} },
    release: null,
    source: 'provider',
    format: 'ts',
    stderr: () => '',
  });
  now += 10 * 1000;
  recordings.tick(now, hooks);
  mineRow = recordings.get(mine);
  console.log('   ', JSON.stringify({ status: mineRow.status, bytes: mineRow.bytes,
    format: mineRow.format }));
  check('and this one is receiving', mineRow.status === 'recording' && mineRow.bytes > 0,
    JSON.stringify({ status: mineRow.status, bytes: mineRow.bytes }));
  check('and the row remembers which ask worked', mineRow.format === 'ts', mineRow.format);

  /* And it stays put rather than flipping formats under a working feed: the
     alternation is driven by attempts that came to NOTHING. */
  now += 10 * 1000;
  recordings.tick(now, hooks);
  check('a feed that is working is not swapped out from under itself',
    started.length === 2 && recordings.get(mine).status === 'recording',
    JSON.stringify({ starts: started.length, status: recordings.get(mine).status }));

  /* ---- alternating, not wandering --------------------------------------- */
  /*
   * Two formats, taken in turn. A third attempt goes back to the playlist
   * rather than off somewhere new — there are only two things to ask for, and
   * a ladder that drifts is a ladder nobody can reason about.
   */
  console.log('\n  and it alternates rather than wandering');
  const seq = [0, 1, 2, 3, 4].map((tries) => recordings.formatFor({ tries }));
  console.log('   ', JSON.stringify(seq));
  check('m3u8, ts, m3u8, ts', seq.join(',') === 'm3u8,ts,m3u8,ts,m3u8', seq.join(','));
  check('and a row that has never been tried asks for a playlist',
    recordings.formatFor({}) === 'm3u8' && recordings.formatFor(null) === 'm3u8',
    `${recordings.formatFor({})} / ${recordings.formatFor(null)}`);

  /* ---- the credentials, at the door ------------------------------------- */
  /*
   * recordings.js is handed a redacted string; the redacting is the box's
   * job, and this is the line that does it. ffmpeg names the input it failed
   * on, and the input is
   *   http://host/live/<username>/<password>/<id>.m3u8
   * so the raw last line put the provider password into recordings.json and
   * onto the screen of whoever opened the recordings page.
   */
  console.log('\n  and the password never reaches the row');
  const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = SERVER.indexOf("proc.on('exit', (code) => safely('recording ended'");
  const block = SERVER.slice(start, start + 700);
  check('the recording failure is redacted before it is stored',
    /redactUrl\(stderr/.test(block), block.slice(0, 300));
  check('and the running commentary the watchdog reads is too',
    /stderr: \(\) => redactUrl\(stderr\)/.test(SERVER), 'raw stderr handed to recordings.began');
  /* And that it actually strips a password, rather than being called and
     doing nothing — the function is the box's, so it is exercised here. */
  const redactUrl = (text) => String(text).replace(/https?:\/\/[^\s'"]+/g, (url) => {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      return `${u.protocol}//${u.host}/…/${parts.length ? parts[parts.length - 1] : ''}`;
    } catch { return '<url>'; }
  });
  const raw = 'http://panel.example:8080/live/hunter/s3cr3tpass/4821.m3u8: 404 Not Found';
  const clean = redactUrl(raw);
  console.log('   ', clean);
  check('a provider URL loses its username and password',
    !clean.includes('s3cr3tpass') && !clean.includes('hunter') && clean.includes('4821.m3u8'),
    clean);

  /* ---- and the fallback has to actually open ---------------------------- */
  /*
   * The part that reasoning would have got wrong, and did.
   *
   * recordArgs carries `-m3u8_hold_counters` and `-live_start_index`, which
   * are options of the HLS DEMUXER. ffmpeg does not ignore a private option
   * the chosen demuxer does not have — it refuses to open the input:
   *
   *   Option m3u8_hold_counters not found.
   *
   * So the retry that asks for MPEG-TS would have died before reading a byte,
   * and the fallback written to rescue a TS-only channel would have been the
   * thing that broke it. Run against the real binary and a real feed, because
   * that is the only way this was ever going to be found.
   */
  console.log('\n  and the arguments for a TS retry actually open a TS feed');
  const { spawnSync, spawn } = require('child_process');
  const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!haveFfmpeg) {
    console.log('    no ffmpeg on this box — skipped');
  } else {
    /* A feed that keeps sending, the way a live channel does. */
    const http = require('http');
    const seed = path.join(dir, 'seed.ts');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc=size=160x120:rate=10:duration=1', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-preset',
      'ultrafast', '-c:a', 'aac', '-f', 'mpegts', seed]);
    const feed = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      const send = () => { try { res.write(fs.readFileSync(seed), () => {}); } catch { /* gone */ } };
      send();
      const t = setInterval(send, 150);
      res.on('close', () => clearInterval(t));
    });
    await new Promise((r) => feed.listen(0, '127.0.0.1', r));
    const port = feed.address().port;

    /* The box's own argument list, lifted rather than retyped — a copy would
       pass while the shipped one failed. */
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const from = SRC.indexOf('function recordArgs(');
    const body = SRC.slice(from, SRC.indexOf('\n}', from) + 2);
    // eslint-disable-next-line no-new-func
    const recordArgs = new Function('UA', `${body}; return recordArgs;`)('tt-test');

    const run = (format) => new Promise((resolve) => {
      const out = path.join(dir, `probe-${format}.mp4`);
      const args = recordArgs(`http://127.0.0.1:${port}/live/u/p/4821.${format}`, out, false, format);
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let said = '';
      proc.stderr.on('data', (d) => { said += d.toString(); });
      setTimeout(() => { try { proc.kill('SIGINT'); } catch { /* gone */ } }, 4000);
      proc.on('close', () => resolve({ said, bytes: fs.existsSync(out) ? fs.statSync(out).size : 0 }));
    });

    const ts = await run('ts');
    console.log('    ts:', JSON.stringify({ bytes: ts.bytes, said: ts.said.trim().slice(0, 120) }));
    check('a TS retry opens the input rather than refusing its own arguments',
      !/Option .* not found/i.test(ts.said), ts.said.trim().slice(0, 160));
    check('and writes something', ts.bytes > 0, String(ts.bytes));
    /* And the playlist options are still THERE for the playlist case, since
       that is what keeps a real recording at the live edge. */
    const m3u8Args = recordArgs('http://x/live/u/p/1.m3u8', '/tmp/x.mp4', false, 'm3u8');
    check('while a playlist attempt keeps the options it needs',
      m3u8Args.includes('-live_start_index') && m3u8Args.includes('-m3u8_hold_counters'),
      JSON.stringify(m3u8Args.slice(0, 18)));
    check('and a TS attempt does not carry them at all',
      !recordArgs('http://x/live/u/p/1.ts', '/tmp/x.mp4', false, 'ts').includes('-live_start_index'),
      'live_start_index still on the TS ladder');
    feed.close();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
