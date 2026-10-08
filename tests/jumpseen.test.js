/**
 * A jump back is written down, and the report says so.
 *
 * "there was an issue where the playback jumped back a few seconds. I dont
 *  think it is picked up by the playback issue detection."
 *
 * It was not, and the report said why without meaning to. Two lines, one
 * under the other:
 *
 *   events          waiting 0, stalled 0, error 0, ratechange 0, seeked 1
 *   playhead moves  none — the media clock only went forwards
 *
 * Those cannot both be true about a playhead that moved. The reason they were
 * is that moves are INFERRED by differencing samples a second apart, while a
 * seek is an instantaneous event between two of them. Seek back three seconds
 * and keep playing, and the next row reads `-3 + elapsed` — so any jump the
 * tick outruns nets out forward and is never written down. The counter saw it
 * because a counter cannot miss; the detector missed it because it was
 * differencing the wrong thing.
 *
 * `seeking` fires before the jump and `seeked` after it, so the pair is the
 * exact distance with no sampling in the middle of it.
 *
 * DRIVEN THROUGH THE REAL ELEMENT. The seek is performed on a real <video>
 * with a real source, so what is under test is the wiring to the events the
 * browser actually fires — a stubbed currentTime would prove only that the
 * arithmetic works.
 */
const { chromium } = require('./playwright.js');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1300);
  }

  /* Something with a timeline long enough to jump about in. Generated in the
     page so the suite carries no media file. */
  await page.evaluate(async () => {
    const video = document.querySelector('#video');
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d');
    let n = 0;
    const draw = () => { ctx.fillStyle = `hsl(${(n += 7) % 360} 70% 40%)`; ctx.fillRect(0, 0, 160, 90); };
    draw();
    const stream = canvas.captureStream(25);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    rec.ondataavailable = (e) => chunks.push(e.data);
    const paint = setInterval(draw, 40);
    rec.start();
    await new Promise((r) => setTimeout(r, 5000));
    rec.stop();
    clearInterval(paint);
    await new Promise((r) => { rec.onstop = r; });
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    video.muted = true;
    await new Promise((r) => {
      if (video.readyState >= 1) return r();
      video.addEventListener('loadedmetadata', r, { once: true });
    });
  });
  await wait(600);

  const ready = await page.evaluate(() => {
    const v = document.querySelector('#video');
    return { readyState: v.readyState, duration: v.duration };
  });
  console.log('   ', JSON.stringify(ready));
  check('there is something with a timeline to jump about in',
    ready.readyState >= 1 && ready.duration > 1, JSON.stringify(ready));

  /* ---- a jump the one-second tick would have outrun ---------------------- */
  /*
   * The case from the report. Seek backwards and carry on playing: by the
   * next tick the playhead is already past where it started, so the sampler's
   * arithmetic reads forward motion and says the clock only went forwards.
   */
  console.log('\n  a jump back that the sampler would have netted out');
  const seen = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    playback.moves = [];
    playback.history = [];
    /* A row to jump FROM, so noteMove has the buffer and readyState of the
       moment — the same row the sampler would have used. */
    playback.record();
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    /* Read immediately before assigning, which is the only moment the true
       origin is readable: assigning currentTime moves the official position
       before `seeking` fires. */
    const from = video.currentTime;
    video.currentTime = Math.max(0, from - 1.4);
    await new Promise((r) => {
      video.addEventListener('seeked', r, { once: true });
      setTimeout(r, 1500);
    });
    await new Promise((r) => setTimeout(r, 120));
    return {
      from,
      /* Where it LANDED, which is not where it was sent: a seek snaps to a
         keyframe, and near the start of a short clip it also clamps at zero.
         The claim under test is that the report's number matches the move the
         element really made — not the one that was requested. */
      landed: video.currentTime,
      moves: playback.moves.map((m) => ({
        kind: m.kind, moved: Number(m.moved.toFixed(2)),
        fromT: Number(m.from.toFixed(2)), to: Number(m.to.toFixed(2)),
        seeked: m.seeked, why: m.why,
      })),
    };
  });
  console.log('   ', JSON.stringify(seen));
  check('the jump is written down at all', seen.moves.length === 1,
    JSON.stringify(seen.moves));
  check('as a jump BACK', seen.moves[0] && seen.moves[0].kind === 'back',
    seen.moves[0] && seen.moves[0].kind);
  /* Measured across the event, so the distance is the one the element really
     moved rather than whatever a one-second tick had left of it. Compared
     against the element's own before and after, with room for the origin
     being one `timeupdate` stale. */
  const reallyMoved = seen.landed - seen.from;
  console.log(`    element moved ${reallyMoved.toFixed(2)}s, report says `
    + `${seen.moves[0] ? seen.moves[0].moved : '—'}s`);
  check('with the distance it actually moved, not what a tick had left of it',
    seen.moves[0] && Math.abs(seen.moves[0].moved - reallyMoved) < 0.35,
    `${seen.moves[0] && seen.moves[0].moved} vs ${reallyMoved.toFixed(2)}`);
  /* And it is a real jump, not a rounding artefact — the whole point is that
     something a person would notice got written down. */
  check('and it is a jump worth reporting, not a nudge',
    Math.abs(reallyMoved) > 0.5, reallyMoved.toFixed(2));
  check('and where it went from and to',
    seen.moves[0] && seen.moves[0].fromT > seen.moves[0].to,
    JSON.stringify(seen.moves[0]));
  check('and that a seek was behind it', seen.moves[0] && seen.moves[0].seeked === true,
    seen.moves[0] && String(seen.moves[0].seeked));

  /* ---- written down once, not twice ------------------------------------- */
  /*
   * The sampler still runs, and would have its own opinion about the same
   * jump a second later. Two lines for one event is a report that cannot be
   * counted.
   */
  console.log('\n  and only once, though the sampler also has an opinion');
  const after = await page.evaluate(async () => {
    /* Two ticks, which is where the sampler's own arithmetic would land. */
    playback.record();
    await new Promise((r) => setTimeout(r, 1100));
    playback.record();
    return playback.moves.length;
  });
  console.log('    moves now:', after);
  check('still one', after === 1, String(after));

  /* ---- a nudge is not a jump ------------------------------------------- */
  /*
   * The engine moves the playhead by hundredths routinely — settling onto a
   * fragment boundary, stepping over a frame. Writing those down would bury
   * the one that matters under a hundred that do not.
   */
  console.log('\n  and a nudge of a few hundredths is not reported as a jump');
  const nudged = await page.evaluate(async () => {
    playback.moves = [];
    const video = document.querySelector('#video');
    video.currentTime = video.currentTime + 0.08;
    await new Promise((r) => {
      video.addEventListener('seeked', r, { once: true });
      setTimeout(r, 1200);
    });
    await new Promise((r) => setTimeout(r, 120));
    return playback.moves.length;
  });
  check('nothing written down', nudged === 0, String(nudged));

  /* ---- and it says so on the report ------------------------------------ */
  /*
   * "I dont think it is picked up by the playback issue detection" is about
   * the REPORT, so the last check is the text a person would have read.
   */
  console.log('\n  and the report says it happened rather than "none"');
  const lines = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    playback.moves = [];
    playback.history = [];
    playback.record();
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    video.currentTime = Math.max(0, video.currentTime - 1.2);
    await new Promise((r) => {
      video.addEventListener('seeked', r, { once: true });
      setTimeout(r, 1500);
    });
    await new Promise((r) => setTimeout(r, 120));
    return playback.moveLines().join('\n');
  });
  console.log(lines.split('\n').slice(0, 4).map((l) => `    ${l}`).join('\n'));
  check('it no longer claims the clock only went forwards',
    !/playhead moves {2}none/.test(lines), lines.split('\n')[0]);
  check('it names the jump, its size and its direction',
    /playhead moves/.test(lines) && /BACK/.test(lines) && /1\.\d/.test(lines), lines);
  check('and shows the seconds around it, which is what tells a correction '
    + 'from a stream falling over', />>> the jump <<</.test(lines), lines);

  /* ---- and what the box was doing when it happened --------------------- */
  /*
   * "I'm convinced that the jumping back issue has something to do with the
   *  way it builds in time to avoid buffering"
   *
   * Everything above this is the player, and three reports in a row have come
   * back clean on every line of it while the picture still jumped. The
   * mechanism that builds time is the box's ingest: it reads the provider ten
   * segments behind their edge on a COLD start so the window opens deep enough
   * for the player's 45-second seat, and on a feed drop it respawns with
   * `append_list` and `discont_start` — a new timeline laid under somebody
   * already watching. The box writes every one of those down and the report
   * never asked.
   *
   * Said either way round, which is the point: a jump with no restart behind
   * it rules the ingest out, and that is worth as much as confirming it.
   */
  console.log('\n  and what the box was doing when it jumped');
  let asked = null;
  await page.route('**/api/live/report**', (r) => {
    asked = new URL(r.request().url()).searchParams.get('id');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        sessions: [{
          id: 'live-700', alive: true, restarts: 2, pace: { rate: 1.002, windows: 9 },
          notes: [
            { at: Date.now() - 6000, event: 'ingest-exited', code: 0, ago: '6s' },
            { at: Date.now() - 4000, event: 'ingest-resumed',
              from: 'provider live edge', ago: '4s' },
            /* Older than the window this looks at — a session's notes run back
               to the start of it and a list of everything is a list nobody
               reads. */
            { at: Date.now() - 400000, event: 'ingest-started', ago: '400s' },
          ],
        }],
        direct: null, now: Date.now(),
      }) });
  });

  const withBox = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    playback.moves = [];
    playback.history = [];
    /* The report is only fetched for a LIVE channel, because a film has no
       ingest behind it to have restarted.
     *
     * Assigned BARE. `currentLiveItem` is a top-level `let` in app.js, which
     * is a lexical global: reachable by name from here and NOT a property of
     * `window`, so `window.currentLiveItem = …` quietly makes a second
     * variable that nothing reads. */
    currentLiveItem = { kind: 'live', id: 700, name: 'CBS HD' };
    playback.record();
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    video.currentTime = Math.max(0, video.currentTime - 1.2);
    await new Promise((r) => {
      video.addEventListener('seeked', r, { once: true });
      setTimeout(r, 1500);
    });
    /* Filled in late on purpose — this runs off a timeupdate and a fetch in
       that path is the last thing a stuttering stream needs. */
    await new Promise((r) => setTimeout(r, 900));
    return { box: playback.moves[0] && playback.moves[0].box,
      lines: playback.moveLines().join('\n') };
  });
  console.log('    asked the box about:', asked);
  console.log('   ', JSON.stringify(withBox.box));
  check('the box is asked what its ingest had been doing',
    asked === '700', String(asked));
  check('and the answer is kept with the jump', Boolean(withBox.box),
    JSON.stringify(withBox.box));
  check('with the restart count, which is the number the hypothesis is about',
    withBox.box && withBox.box.restarts === 2, JSON.stringify(withBox.box));
  /* Bounded to the seconds around the jump. */
  check('and only the notes from around the jump, not the whole session',
    withBox.box && withBox.box.notes.length === 2,
    JSON.stringify(withBox.box && withBox.box.notes.map((n) => n.ago)));

  console.log(withBox.lines.split('\n').filter((l) => /box|ingest/.test(l))
    .map((l) => `    ${l}`).join('\n'));
  check('the report names the other end of it',
    /what the box was doing/.test(withBox.lines), withBox.lines.slice(-400));
  check('and says in the ingest\u2019s own words what it did',
    /ingest-resumed/.test(withBox.lines) && /provider live edge/.test(withBox.lines),
    withBox.lines.slice(-400));

  /* And the other answer. A channel served straight through the proxy has no
     ingest of ours at all, so there is nothing to have restarted — which
     rules the mechanism out for that jump rather than leaving it open. */
  console.log('\n  and a channel with no ingest behind it says so');
  await page.unroute('**/api/live/report**');
  await page.route('**/api/live/report**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"sessions":[],"direct":null,"now":0}' }));
  const direct = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    playback.moves = [];
    playback.history = [];
    playback.record();
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    video.currentTime = Math.max(0, video.currentTime - 1.2);
    await new Promise((r) => {
      video.addEventListener('seeked', r, { once: true });
      setTimeout(r, 1500);
    });
    await new Promise((r) => setTimeout(r, 900));
    return playback.moveLines().join('\n');
  });
  check('it says there was no ingest of ours to restart',
    /no ingest of ours to restart/.test(direct), direct.slice(-300));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
