/**
 * "encoder : Lavc61.19.101 aac" is not an error.
 *
 * "I've been getting this error sometimes — Couldn't start episode: ffmpeg
 *  failed: encoder : Lavc61.19.101 aac"
 *
 * That line is ffmpeg naming the AAC encoder it is about to use, printed under
 * the audio stream of the OUTPUT header. It reached a viewer because the
 * failure path took the LAST line of stderr and showed it, and the last line is
 * the right place to look only when ffmpeg has actually said something about
 * what went wrong. Stopped mid-run, it has not: what stands at the bottom of
 * the log is the header it had got as far as printing.
 *
 * And it was stopped mid-run, which is the other half of this. A conversion is
 * killed by the next one to start if nothing has fetched from it for
 * twenty-five seconds — except that a conversion cannot BE fetched from until
 * startRemux has handed back its session id, and that wait runs to tens of
 * seconds against this provider. So a conversion still being born looked
 * exactly like one somebody had walked away from, and the next thing anybody
 * pressed killed it. Which is the "sometimes": press an episode, it fails,
 * press it again, it plays.
 *
 * Three claims, all measured against a real box with a real spawn:
 *
 *   A STOPPED CONVERSION IS NOT A BROKEN ONE. Killed, it says it was stopped,
 *   and it tries again rather than putting a codec version on the screen.
 *
 *   A CONVERSION STILL STARTING IS NOT SWEPT. The next start leaves it alone
 *   until it has been handed to whoever asked for it.
 *
 *   WHEN FFMPEG REALLY FAILS, THE REAL LINE IS SHOWN — not whichever banner
 *   happened to be printed last.
 *
 * There is no ffmpeg in this container, which is the usual reason these paths
 * go untested. So one is put on PATH: a script that behaves the way ffmpeg
 * behaves — prints the same header, writes segments at a pace, and can be told
 * to fail with a real error line or to sit there long enough to be killed.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-remuxstop';
const BIN = path.join(DIR, 'bin');
const PORT = 8477;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 90000 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body.slice(0, 200) }; }
      resolve({ status: res.statusCode, body: parsed });
    });
  }).on('error', reject);
});

/*
 * The header ffmpeg prints, ending exactly where the report says it ended.
 *
 * Not invented: this is the shape of an ffmpeg 7 output header, and the last
 * line of it is the one that was on the viewer's screen.
 */
const HEADER = [
  'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers',
  '  built with gcc 14 (Debian 14.2.0-8)',
  '  configuration: --prefix=/usr --enable-gpl',
  '  libavutil      59. 39.100 / 59. 39.100',
  '  libavcodec     61. 19.101 / 61. 19.101',
  'Input #0, mpegts, from \'source\':',
  '  Duration: 00:42:11.30, start: 1.400000, bitrate: 3110 kb/s',
  '  Stream #0:0[0x100]: Video: h264 (High), yuv420p, 1920x1080',
  '  Stream #0:1[0x101]: Audio: ac3, 48000 Hz, 5.1',
  'Stream mapping:',
  '  Stream #0:0 -> #0:0 (copy)',
  '  Stream #0:1 -> #0:1 (ac3 -> aac)',
  'Output #0, hls, to \'index.m3u8\':',
  '  Metadata:',
  '    encoder         : Lavf61.7.100',
  '  Stream #0:0: Video: h264, yuv420p, 1920x1080',
  '  Stream #0:1: Audio: aac, 48000 Hz, stereo',
  '      Metadata:',
  '        encoder         : Lavc61.19.101 aac',
].join('\n');

/*
 * An ffmpeg that does what ffmpeg does.
 *
 * Reads its own instructions out of the environment: how long to dawdle before
 * writing segments, and whether to fall over with a real complaint. Ignores
 * SIGTERM so that being stopped means being SIGKILLed, which is what the box
 * actually does and what produces the null exit code at the heart of this.
 */
const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
if (process.argv.includes('-version')) { console.log('ffmpeg version 7.1.1'); process.exit(0); }
process.stderr.write(${JSON.stringify(HEADER)} + '\\n');

/* Where the box told it to write. */
const out = process.argv[process.argv.length - 1];
const dir = path.dirname(out);

const fail = process.env.FAKE_FAIL || '';
const slow = Number(process.env.FAKE_SLOW_MS || 0);

if (fail) {
  setTimeout(() => {
    process.stderr.write(fail + '\\n');
    /* And then another header, because ffmpeg does exactly this: the
       complaint is not always the last thing it says. */
    process.stderr.write('        encoder         : Lavc61.19.101 aac\\n');
    process.exit(1);
  }, 200);
} else {
  setTimeout(() => {
    try {
      fs.writeFileSync(path.join(dir, 'seg0.ts'), 'x');
      fs.writeFileSync(path.join(dir, 'seg1.ts'), 'x');
      fs.writeFileSync(out, [
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:4.000,', 'seg0.ts', '#EXTINF:4.000,', 'seg1.ts',
      ].join('\\n'));
    } catch { /* the directory went away under it, which is a kill */ }
  }, slow);
}
/* Stay up until something stops it — a conversion is a long-running thing. */
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

(async () => {
  /* ---- a box, with an ffmpeg of our own on its PATH --------------------- */
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'downloads'), { recursive: true });
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'ffmpeg'), FAKE_FFMPEG, { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'ffprobe'), `#!/usr/bin/env node
console.log(JSON.stringify({ streams: [], format: { duration: '2531.3' } }));
`, { mode: 0o755 });

  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'market.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));

  /* A provider that answers, so the remux has something to point ffmpeg at.
     Nothing is read from it — the fake writes its own segments. */
  const provider = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => provider.listen(8476, '127.0.0.1', r));

  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:8476', username: 'u', password: 'p',
    preferredFormat: 'ts',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', prefs: { tourDone: true }, history: [] }],
  }));

  const start = (env) => spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      PATH: `${BIN}:${process.env.PATH}`, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let box = start({ FAKE_SLOW_MS: '400' });
  const up = async () => {
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      try { await get('/api/health'); return true; } catch { await wait(250); }
    }
    return false;
  };

  try {
    if (!await up()) throw new Error('the box did not come up');

    /* ---- 1. an ordinary conversion still works --------------------------- */
    console.log('\n  a conversion that is left alone');
    const ok = await get('/api/remux?kind=series&id=101&ext=mkv');
    console.log('   ', JSON.stringify({ status: ok.status, session: ok.body.session,
      error: ok.body.error }));
    check('starts and hands back a session',
      ok.status === 200 && Boolean(ok.body.session), JSON.stringify(ok.body).slice(0, 160));

    /* ---- 2. a real failure names the real reason ------------------------ */
    /*
     * The fake prints its complaint and THEN another header line, which is
     * exactly what ffmpeg does — the error is not always the last thing said.
     * Taking the last line is how a codec version ended up on the screen.
     */
    console.log('\n  a conversion that really fails');
    box.kill('SIGKILL');
    await wait(500);
    box = start({ FAKE_FAIL: 'source: Server returned 404 Not Found' });
    if (!await up()) throw new Error('the box did not come back');

    const bad = await get('/api/remux?kind=series&id=102&ext=mkv');
    const said = String(bad.body.error || '');
    console.log('   ', JSON.stringify(said));
    check('it is reported as a failure', bad.status === 502, String(bad.status));
    check('and the line shown is the one that says what went wrong',
      /Server returned 404/.test(said), said);
    /* The whole point. This is what was on the viewer's screen. */
    check('not the encoder ffmpeg was about to use',
      !/Lavc/.test(said) && !/encoder\s*:/.test(said), said);

    /* ---- 3. stopped is not broken --------------------------------------- */
    /*
     * A process killed by a signal reports a null exit code, and null is not
     * zero — so a conversion this box stopped on purpose read as one that had
     * broken. It is a race, and the answer to a race is to run it again.
     */
    console.log('\n  a conversion that is stopped while it starts');
    box.kill('SIGKILL');
    await wait(500);
    /* Slow enough that the second request lands while the first is still
       waiting for its segments — which is the window the report lives in. */
    box = start({ FAKE_SLOW_MS: '3000' });
    if (!await up()) throw new Error('the box did not come back');

    const both = await Promise.all([
      get('/api/remux?kind=series&id=201&ext=mkv'),
      (async () => { await wait(600); return get('/api/remux?kind=series&id=202&ext=mkv'); })(),
    ]);
    for (const [i, r] of both.entries()) {
      console.log(`   #${i + 1}:`, JSON.stringify({ status: r.status,
        session: r.body.session, error: r.body.error }));
    }
    /*
     * Both are asked for while the other is starting. Neither may come back
     * with a codec version against its name — that is the reported bug — and
     * neither may be swept away for being idle when it has not had the chance
     * to be anything else.
     */
    for (const [i, r] of both.entries()) {
      const err = String(r.body.error || '');
      check(`#${i + 1} did not fail with an encoder banner`,
        !/Lavc/.test(err) && !/encoder\s*:/.test(err), err);
    }
    check('both conversions started',
      both.every((r) => r.status === 200 && r.body.session),
      JSON.stringify(both.map((r) => ({ s: r.status, e: r.body.error }))));

    /* ---- 4. and one still being born is not swept as abandoned ---------- */
    /*
     * The cause, rather than the wording.
     *
     * A conversion is killed by the next one to start when nothing has fetched
     * from it for twenty-five seconds. But nothing CAN fetch from it until
     * startRemux hands back its session id, and that waits for two segments —
     * tens of seconds against this provider on a bad night. So a conversion in
     * its first half-minute looked exactly like one somebody had walked away
     * from.
     *
     * This costs half a minute of wall clock to show, and is worth it: without
     * it the fix above is a better error message for a fault still happening.
     */
    console.log('\n  and one still starting when the next one begins');
    box.kill('SIGKILL');
    await wait(500);
    /* Longer than the twenty-five seconds that count as idle, shorter than the
       thirty the caller waits before giving up. */
    box = start({ FAKE_SLOW_MS: '27000' });
    if (!await up()) throw new Error('the box did not come back');

    const slowStart = get('/api/remux?kind=series&id=301&ext=mkv');
    /* Past the idle window, while the first is unmistakably still starting. */
    await wait(26000);
    const second = await get('/api/remux?kind=series&id=302&ext=mkv');
    const first = await slowStart;
    console.log('   the one that was starting:',
      JSON.stringify({ status: first.status, session: first.body.session,
        error: first.body.error }));
    console.log('   the one that came after :',
      JSON.stringify({ status: second.status, session: second.body.session }));
    check('the conversion that was still starting is left alone',
      first.status === 200 && Boolean(first.body.session),
      String(first.body.error || first.status));
    check('and it is not the encoder banner that says otherwise',
      !/Lavc|encoder\s*:/.test(String(first.body.error || '')),
      String(first.body.error || ''));

    console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  } finally {
    box.kill('SIGKILL');
    try { provider.close(); } catch { /* already shut */ }
  }
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
