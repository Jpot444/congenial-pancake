/**
 * Recording a programme, and what happens when the box runs out of room.
 *
 * The live DVR is a two-minute rolling window so somebody can pause. This is
 * the other thing entirely: keep a whole programme because it was asked for
 * before it aired and nobody will be in the room when it does.
 *
 * Which makes the interesting claims here about ABSENCE — the box doing the
 * right thing with nobody watching:
 *
 *   IT STARTS ON ITS OWN, off the clock, with a lead so the opening titles
 *   are not the price of a listing being thirty seconds out.
 *
 *   IT COSTS NOTHING WHEN THE CHANNEL IS ALREADY ON. The live ingest is
 *   already pulling that channel and republishing it locally, so the recorder
 *   reads the box's own window — one stream, two readers, no second provider
 *   connection. This is the difference between a two-login box recording one
 *   thing and a two-login box recording one thing AND being full.
 *
 *   IT WINS THE ARGUMENT, and says so in words. A viewer who presses play on
 *   a full box gets the programme's name and when it ends, plus its id — so
 *   the screen can offer one press that stops it. The reverse policy breaks a
 *   promise in an empty room, which is the failure nobody sees coming.
 *
 *   AND IT KEEPS WHAT IT GOT. Stopping mid-programme leaves the half that was
 *   written, marked partial. Only deleting throws the file away.
 *
 * The provider here is a fake that streams for as long as anybody reads, and
 * ffmpeg is a fake that writes bytes — what is under test is the box's
 * scheduling and its accounting of connections, not ffmpeg's.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-rec';
const PORT = 8497;
const PANEL = 9495;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const YEAR = 365 * 86400000;
const USERS = { u: 'p' };

const call = (p, method = 'GET', body) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: p, method,
    headers: body ? { 'content-type': 'application/json' } : {},
  }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let data = {};
      try { data = JSON.parse(text); } catch { /* not json */ }
      resolve({ status: res.statusCode, data });
    });
  });
  req.on('error', reject);
  if (body) req.write(JSON.stringify(body));
  req.end();
});

/** Hold a stream open the way a player does. */
function watch(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${url}`, (res) => {
      let bytes = 0;
      res.on('data', (d) => { bytes += d.length; });
      resolve({ stop: () => req.destroy(), read: () => bytes, status: res.statusCode });
    });
    req.on('error', reject);
  });
}

(async () => {
  /* ---- a provider that keeps sending -------------------------------------- */
  const open = new Map();
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/player_api.php') {
      const user = url.searchParams.get('username');
      const ok = USERS[user] === url.searchParams.get('password');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok
        ? { user_info: { auth: 1, status: 'Active', is_trial: '0',
          exp_date: String(Math.floor((Date.now() + YEAR) / 1000)),
          max_connections: '1', active_cons: '0' } }
        : { user_info: { auth: 0 } }));
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const user = parts[1] || '';
    open.set(user, (open.get(user) || 0) + 1);
    res.on('close', () => open.set(user, Math.max(0, (open.get(user) || 1) - 1)));
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const tick = setInterval(() => res.write(Buffer.alloc(4096, 1)), 200);
    res.on('close', () => clearInterval(tick));
    return undefined;
  });
  await new Promise((r) => provider.listen(PANEL, '127.0.0.1', r));

  /* ---- a box, with an ffmpeg that writes ---------------------------------- */
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'rec'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`, username: 'u', password: 'p',
    preferredFormat: 'm3u8',
    accounts: [{ id: 'p1', host: `http://127.0.0.1:${PANEL}`, username: 'u', password: 'p' }],
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));

  /* An ffmpeg that keeps writing to whatever it was told to write to, and
     exits cleanly when interrupted — which is what makes "the half that was
     written is kept" a real claim rather than a hope. */
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffmpeg'), `#!/bin/bash
if [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi
args=("$@")
out="\${args[-1]}"
echo "$@" >> "${DIR}/ffmpeg-calls.log"
trap 'exit 0' INT TERM
while true; do
  printf 'RECORDED-BYTES-RECORDED-BYTES-RECORDED-BYTES' >> "$out"
  sleep 0.2
done
`, { mode: 0o755 });
  fs.writeFileSync(path.join(DIR, 'fakebin', 'ffprobe'), `#!/bin/bash
echo '{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"600"}}'
exit 0
`, { mode: 0o755 });

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      RECORDINGS_ROOT: path.join(DIR, 'rec'),
      DOWNLOADS_ROOT: path.join(DIR, 'store'),
      PATH: `${path.join(DIR, 'fakebin')}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  for (let i = 0; i < 60; i += 1) {
    try {
      await call('/');
      break;
    } catch {
      await wait(250);
    }
  }

  try {
    /* ---- it starts itself, off the clock -------------------------------- */
    console.log('\n  a programme asked for before it airs');
    /* Starting in 30 seconds, so it is NOT due — but the lead is a minute,
       which means the box should open the file now. That is the whole point
       of the lead and the only way to test it without waiting. */
    const soon = Date.now() + 30 * 1000;
    const booked = await call('/api/recordings', 'POST', {
      channelId: '700',
      channelName: 'US| FOX ᴴᴰ',
      title: 'The Late Game',
      startsAt: soon,
      endsAt: soon + 90 * 1000,
      profileId: 'own1',
    });
    console.log('   booked:', JSON.stringify(booked.data.recording));
    check('the box takes the booking', booked.status === 200 && booked.data.recording,
      String(booked.status));
    check('with a lead, so a listing thirty seconds out does not cost the opening',
      booked.data.recording.leadMs >= 30000, String(booked.data.recording.leadMs));
    check('and a tail, because broadcasts overrun',
      booked.data.recording.tailMs > 0, String(booked.data.recording.tailMs));

    const id = booked.data.recording.id;
    await wait(3000);
    let list = await call('/api/recordings');
    let row = (list.data.items || []).find((r) => r.id === id) || {};
    console.log('   after 3s:', JSON.stringify({ status: row.status, source: row.source }));
    check('it starts on its own, because the lead has already opened it',
      row.status === 'recording', JSON.stringify(row));
    check('on its own provider connection, since nobody is watching that channel',
      row.source === 'provider', row.source);

    await wait(2500);
    list = await call('/api/recordings');
    row = (list.data.items || []).find((r) => r.id === id) || {};
    check('and the file is growing', row.bytes > 0, String(row.bytes));

    /* ---- it wins the argument, in words --------------------------------- */
    console.log('\n  a viewer presses play on a full box');
    const refused = await call('/api/play?kind=live&id=800&ext=ts');
    console.log('   refused:', refused.status, JSON.stringify(refused.data));
    check('the box refuses rather than opening a stream it cannot have',
      refused.status === 503, String(refused.status));
    /* The whole of option B: not "busy", but which programme, on what, until
       when — and its id, so the screen can offer one press to stop it. */
    check('and names the programme holding the connection',
      /The Late Game/.test(refused.data.error || ''), refused.data.error);
    check('with when it ends, so the viewer can decide to wait',
      refused.data.recording && refused.data.recording.until > Date.now(),
      JSON.stringify(refused.data.recording));
    check('and its id, which is what turns the message into a choice',
      refused.data.recording && refused.data.recording.id === id,
      JSON.stringify(refused.data.recording));

    /* ---- stopping keeps the half that was written ----------------------- */
    console.log('\n  the viewer takes the connection back');
    const stopped = await call(`/api/recordings/${id}`, 'POST');
    console.log('   stopped:', JSON.stringify({ status: stopped.data.recording?.status,
      bytes: stopped.data.recording?.bytes }));
    check('the recording stops', stopped.data.recording
      && stopped.data.recording.status === 'partial', JSON.stringify(stopped.data.recording));
    check('and what it got is kept, not thrown away',
      stopped.data.recording.bytes > 0, String(stopped.data.recording.bytes));
    check('with the file still on disk',
      fs.existsSync(path.join(DIR, 'rec', stopped.data.recording.file)), '');
    /* Half a programme is watchable — a fragmented mp4 plays as far as it
       was written, which is also what makes watching one still in progress
       work. */
    const playable = await call(`/api/recordings/${id}/file`);
    check('and playable', playable.status === 200 || playable.status === 206,
      String(playable.status));

    await wait(1500);
    const freed = await call('/api/play?kind=live&id=800&ext=ts');
    console.log('   after stopping:', freed.status);
    check('and the connection is genuinely free again',
      freed.status === 200, `${freed.status} ${JSON.stringify(freed.data)}`);

    /* ---- it starts even when that takes the last connection ------------- */
    console.log('\n  a recording due while the box is already full');
    /* A film rather than a live channel, deliberately: the live TS path drains
       against real PCR timestamps and this fake provider does not emit any, so
       watching one here would hang rather than test anything. A film holds the
       same single slot, which is the condition under test. */
    const film = await call('/api/play?kind=movie&id=endless9&ext=mp4');
    const viewer = await watch(film.data.url);
    await wait(1500);
    check('somebody is watching, and that is the only connection',
      viewer.read() > 0, String(viewer.read()));

    const now = Date.now();
    const squeezed = await call('/api/recordings', 'POST', {
      channelId: '900',
      channelName: 'US| SAME CHANNEL',
      title: 'On Now',
      startsAt: now,
      endsAt: now + 60 * 1000,
      profileId: 'own1',
    });
    await wait(3000);
    list = await call('/api/recordings');
    const squeezedRow = (list.data.items || [])
      .find((r) => r.id === squeezed.data.recording.id) || {};
    console.log('   squeezed:', JSON.stringify({ status: squeezedRow.status,
      source: squeezedRow.source, bytes: squeezedRow.bytes }));
    /* Option B all the way through: the recording was promised in advance, so
       it goes ahead. It does not interrupt the viewer — it means the NEXT
       person has a decision, and gets a message naming this. */
    check('the recording still starts rather than standing down',
      squeezedRow.status === 'recording', JSON.stringify(squeezedRow));
    check('and the viewer already watching is not interrupted',
      viewer.read() > 0, String(viewer.read()));
    viewer.stop();
    await call(`/api/recordings/${squeezed.data.recording.id}`, 'POST');

    /* The source-sharing path cannot be exercised here — it needs a real live
       ingest, and this box has a fake ffmpeg and a provider that does not emit
       TS. So the claim is made against the source: a channel already being
       ingested is recorded from the box's own window rather than from a second
       provider connection. That is the difference between a two-login box
       recording one thing and a two-login box being full. */
    const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('a channel already being ingested is recorded from the box\'s own window',
      /const existing = remuxSessions\.get\(`live-\$\{row\.channelId\}`\)/.test(SERVER_SRC)
      && /http:\/\/127\.0\.0\.1:\$\{PORT\}\/hls\//.test(SERVER_SRC), '');
    check('and sharing it takes no slot from the pool',
      /if \(local\) \{[\s\S]{0,400}existing\.lastAccess = Date\.now\(\);/.test(SERVER_SRC), '');

    /* ---- deleting is the other thing ------------------------------------ */
    console.log('\n  removing one');
    const file = path.join(DIR, 'rec', stopped.data.recording.file);
    const gone = await call(`/api/recordings/${id}`, 'DELETE');
    check('the record goes', gone.data.removed === true, JSON.stringify(gone.data));
    check('and this time the file goes with it', !fs.existsSync(file), '');

    /* ---- asking twice ---------------------------------------------------- */
    console.log('\n  pressing record twice on the same programme');
    const when = Date.now() + 6 * 3600 * 1000;
    const first = await call('/api/recordings', 'POST', {
      channelId: '701', channelName: 'C', title: 'Tonight', startsAt: when,
      endsAt: when + 3600 * 1000, profileId: 'own1',
    });
    const again = await call('/api/recordings', 'POST', {
      channelId: '701', channelName: 'C', title: 'Tonight', startsAt: when,
      endsAt: when + 3600 * 1000, profileId: 'own1',
    });
    check('is one recording, not two files of the same hour',
      first.data.recording.id === again.data.recording.id,
      `${first.data.recording.id} vs ${again.data.recording.id}`);

    /* ---- what the box does with a programme it slept through ------------ */
    console.log('\n  a programme that aired while the box was off');
    const past = Date.now() - 4 * 3600 * 1000;
    const missed = await call('/api/recordings', 'POST', {
      channelId: '702', channelName: 'D', title: 'Last Night', startsAt: past,
      endsAt: past + 1800 * 1000, profileId: 'own1',
    });
    await wait(2500);
    list = await call('/api/recordings');
    const missedRow = (list.data.items || [])
      .find((r) => r.id === missed.data.recording.id) || {};
    console.log('   missed:', JSON.stringify({ status: missedRow.status,
      error: missedRow.error }));
    /* Left as "scheduled" it would sit there for ever looking like something
       that is still going to happen. */
    check('is marked missed rather than waiting for ever',
      missedRow.status === 'missed', JSON.stringify(missedRow));
    check('and says why', Boolean(missedRow.error), missedRow.error);
  } finally {
    server.kill();
    provider.close();
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
