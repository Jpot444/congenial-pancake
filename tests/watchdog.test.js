/**
 * Exercises the playback watchdog against a real playing media element.
 *
 * The point of the watchdog is that it reads the media clock rather than what
 * the player claims, so the test drives the media clock directly: play, slow
 * the rate down the way the reported bug does, and check the panel says which
 * of the two it is. A DOM-only test would pass against a watchdog that never
 * measured anything.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const SHOTS = __dirname + '/shots';

const fails = [];
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    fails.push(name);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // The app's own server has nothing to play; serve the clip from a URL that
  // looks like the real proxy path so nothing special-cases it. Range-aware,
  // or Chromium reports seekable = [0,0] and silently ignores every seek —
  // which would leave the seeking scenarios below testing nothing.
  await page.route('**/api/fake-stream', (route) => {
    const range = route.request().headers().range;
    if (!range) {
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP,
        headers: { 'accept-ranges': 'bytes', 'content-length': String(CLIP.length) } });
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : CLIP.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/wav',
      body: CLIP.subarray(start, end + 1),
      headers: { 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${CLIP.length}`,
        'content-length': String(end - start + 1) } });
  });

  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // --- nothing has played yet -------------------------------------------
  await page.evaluate(() => document.querySelector('#healthBtn').click());
  await wait(600);
  check('panel hidden before anything plays',
    await page.locator('#playbackPanel').isHidden());
  await page.evaluate(() => document.querySelector('#healthModal').hidden = true);

  // --- play it ----------------------------------------------------------
  await page.evaluate(async () => {
    document.querySelector('#playerOverlay').hidden = false;
    const v = document.querySelector('#video');
    v.src = '/api/fake-stream';
    v.muted = true;
    await v.play();
  });
  await wait(9000);

  const normal = await page.evaluate(() => ({
    rate: playback.measuredRate(),
    span: playback.span(),
    verdict: playback.verdict(),
    samples: playback.samples.length,
  }));
  console.log('  normal:', JSON.stringify(normal));
  check('the watchdog is sampling', normal.samples >= 7, `${normal.samples} samples`);
  check('measured rate is ~1x while playing normally',
    normal.rate > 0.85 && normal.rate < 1.15, String(normal.rate));
  check('verdict reads normal', /Normal/.test(normal.verdict), normal.verdict);

  // --- the reported bug: the media clock crawls -------------------------
  await page.evaluate(() => { document.querySelector('#video').playbackRate = 0.1; });
  await wait(12000);

  const slow = await page.evaluate(() => ({
    rate: playback.measuredRate(),
    worst: playback.worstRate,
    verdict: playback.verdict(),
  }));
  console.log('  slow:', JSON.stringify(slow));
  check('a slowdown is measured, not just reported',
    slow.rate !== null && slow.rate < 0.3, String(slow.rate));
  check('the worst reading is remembered',
    slow.worst !== null && slow.worst < 0.3, String(slow.worst));
  check('verdict blames the rate, not the network',
    /RATE is 0\.1/.test(slow.verdict), slow.verdict);

  // --- drift told apart from a fixed offset -------------------------------
  //
  // Both faults are inaudible in everything the player reports — 1x, no
  // stalls, nothing dropped — and the verdict is the only thing that
  // distinguishes them. The numbers are from a real report: aligned at the
  // head, 977ms apart 44.835s in.
  const drift = await page.evaluate(() => {
    playback.probe = {
      segment: { declared: 8.216, real: 8.361, ratio: 0.983 },
      start: { video: 0, audio: 0, sync: 0 },
      drift: { video: 44.835, audio: 43.858, gap: -0.977, firstGap: -0.02,
        rate: -0.021791, span: 44 },
      video: {}, audio: {}, input: [],
    };
    playback.probedAt = Date.now();
    return { verdict: playback.verdict(), lines: playback.serverLines().join('\n') };
  });
  console.log('   drift verdict:', drift.verdict);
  check('drift is called drift, not an offset',
    /DRIFTING/.test(drift.verdict), drift.verdict);
  check('the verdict gives the rate, not just the gap',
    /2\.2%/.test(drift.verdict), drift.verdict);
  check('and says which way it goes',
    /falling behind/.test(drift.verdict), drift.verdict);
  check('and how far apart they are by now',
    /1\.0s apart/.test(drift.verdict), drift.verdict);
  check('the report carries the rate as its own line',
    /drift rate\s+-21\.8ms per second \(-2\.18%\) measured over 44\.0s/.test(drift.lines),
    drift.lines.split('\n').find((l) => /drift rate/.test(l)) || 'no drift rate line');
  // The opening gap alongside it, because one gap on its own says nothing.
  check('and the gap it was compared against',
    /the same gap\s+-20ms in the first segment/.test(drift.lines),
    drift.lines.split('\n').find((l) => /the same gap/.test(l)) || 'no opening gap line');

  // A steady offset must still read as an offset, not get relabelled drift.
  const steady = await page.evaluate(() => {
    playback.probe = {
      segment: { declared: 6, real: 6, ratio: 1 },
      start: { video: 0, audio: 0.9, sync: 0.9 },
      drift: { video: 40, audio: 40.9, gap: 0.9, firstGap: 0.9, rate: 0, span: 34 },
      video: {}, audio: {}, input: [],
    };
    return playback.verdict();
  });
  console.log('   offset verdict:', steady);
  check('a fixed offset is still reported as an offset',
    /start 900ms apart/.test(steady) && !/DRIFTING/.test(steady), steady);
  await page.evaluate(() => { playback.probe = null; });

  // --- rebuilding itself when the audio falls behind ----------------------
  //
  // The reported fix was manual: back out of the show and start it again. This
  // is that, done by the player. The numbers are from the report that prompted
  // it — 0ms at the opening segment, 5.93s apart by 32.9s in.
  console.log('\n  rescuing a conversion whose audio fell behind');
  const rescue = await page.evaluate(async () => {
    const calls = [];
    const realReload = window.reloadStream;
    window.reloadStream = () => { calls.push(Date.now()); };
    // A conversion has to be what is playing, or there is nothing to rebuild.
    film.active = true;
    lastRemux.session = 'sess-bad';
    playback.rescued = new Set();
    playback.rescues = 0;
    playback.lastRescueAt = 0;

    const set = (drift) => { playback.probe = { drift, segment: {}, start: {} }; };
    const out = {};

    // Healthy: the gap is there but it is not opening up.
    set({ video: 40, audio: 39.9, gap: -0.1, firstGap: -0.1, rate: 0, span: 34 });
    playback.audioRescue();
    out.healthy = calls.length;

    // A rate with no real gap behind it — two close segments and a rounding
    // error. Must not tear a good stream down.
    set({ video: 40, audio: 39.98, gap: -0.02, firstGap: 0, rate: -0.02, span: 1 });
    playback.audioRescue();
    out.noisy = calls.length;

    // The real thing.
    set({ video: 32.905, audio: 26.975, gap: -5.93, firstGap: 0, rate: -0.2218, span: 26.7 });
    playback.audioRescue();
    out.rescued = calls.length;

    // The same session again must not queue a second rebuild.
    playback.audioRescue();
    out.twice = calls.length;

    // A NEW session — which is what a rebuild produces — is still refused,
    // because ninety seconds have not passed. Without this it loops.
    lastRemux.session = 'sess-new';
    playback.audioRescue();
    out.loop = calls.length;

    // Live has no conversion to rebuild.
    film.active = false;
    lastRemux.session = 'sess-live';
    playback.lastRescueAt = 0;
    playback.audioRescue();
    out.live = calls.length;

    window.reloadStream = realReload;
    film.active = false;
    lastRemux.session = '';
    playback.probe = null;
    return out;
  });
  console.log('  ', JSON.stringify(rescue));
  check('a gap that is not growing is left alone', rescue.healthy === 0, JSON.stringify(rescue));
  check('and so is a rate with no real gap behind it',
    rescue.noisy === 0, JSON.stringify(rescue));
  check('audio falling behind rebuilds the stream',
    rescue.rescued === 1, JSON.stringify(rescue));
  check('the same session is not rebuilt twice',
    rescue.twice === 1, JSON.stringify(rescue));
  check('and the new session a rebuild creates cannot start a loop',
    rescue.loop === 1, JSON.stringify(rescue));
  check('live is left out of it — there is no conversion to rebuild',
    rescue.live === 1, JSON.stringify(rescue));

  // --- the panel, live --------------------------------------------------
  await page.evaluate(() => document.querySelector('#healthBtn').click());
  await wait(800);
  check('panel visible while playing', await page.locator('#playbackPanel').isVisible());
  check('age line says live',
    /Live/.test(await page.locator('#playbackAge').textContent()));
  const report = await page.locator('#playbackReport').textContent();
  console.log('  report:\n' + report.split('\n').map((l) => '    ' + l).join('\n'));
  for (const key of ['measured rate', 'worst measured', 'playbackRate', 'readyState',
    'buffered', 'events', 'engine', 'film']) {
    check(`report carries "${key}"`, report.includes(key));
  }
  check('report is selectable text',
    await page.locator('#playbackReport').evaluate(
      (el) => getComputedStyle(el).userSelect !== 'none'));

  // The modal has to sit above the player overlay or none of this is reachable.
  const stack = await page.evaluate(() => ({
    modal: +getComputedStyle(document.querySelector('#healthModal')).zIndex,
    overlay: +getComputedStyle(document.querySelector('#playerOverlay')).zIndex,
  }));
  check('health modal stacks above the player', stack.modal > stack.overlay, JSON.stringify(stack));

  await page.screenshot({ path: SHOTS + '/live.png' });

  // Nothing may overflow the modal card sideways.
  const fit = await page.evaluate(() => {
    const card = document.querySelector('#healthModal .modal-card');
    const pre = document.querySelector('#playbackReport');
    return { cardW: card.getBoundingClientRect().width,
      preW: pre.getBoundingClientRect().width,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth };
  });
  check('report fits inside the card', fit.preW <= fit.cardW + 1, JSON.stringify(fit));
  check('no horizontal page overflow', fit.docW <= fit.winW + 1, JSON.stringify(fit));

  // --- the real flow: close the player, then go looking ------------------
  await page.evaluate(() => {
    document.querySelector('#healthModal').hidden = true;
    const v = document.querySelector('#video');
    v.pause();
    v.removeAttribute('src');
    v.load();
    document.querySelector('#playerOverlay').hidden = true;
  });
  await wait(1500);
  await page.evaluate(() => document.querySelector('#healthBtn').click());
  await wait(800);

  check('report survives the player closing',
    await page.locator('#playbackPanel').isVisible());
  const age = await page.locator('#playbackAge').textContent();
  check('age line says how stale it is', /ago/.test(age), age);
  const kept = await page.locator('#playbackReport').textContent();
  check('the kept report is the slow one, not an empty one',
    kept.includes('measured rate') && /0\.1/.test(
      await page.locator('#playbackVerdict').textContent()),
    kept.slice(0, 80));

  await page.screenshot({ path: SHOTS + '/after-close.png' });

  // --- phone layout ------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(500);
  const phoneFit = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    preRight: document.querySelector('#playbackReport').getBoundingClientRect().right,
    cardRight: document.querySelector('#healthModal .modal-card').getBoundingClientRect().right,
  }));
  check('the modal card fits the phone screen', phoneFit.cardRight <= phoneFit.winW + 1,
    JSON.stringify(phoneFit));
  check('no sideways scroll on the phone', phoneFit.docW <= phoneFit.winW + 1,
    JSON.stringify(phoneFit));
  check('report stays on screen on the phone', phoneFit.preRight <= phoneFit.winW + 1,
    JSON.stringify(phoneFit));
  await page.screenshot({ path: SHOTS + '/phone.png' });


  // --- the defect that lost the first real report -----------------------
  // Reloading the stream is the first thing anyone does about bad playback,
  // and it used to wipe the record along with the session.
  console.log('\n  surviving a reload');
  await page.evaluate(async () => {
    document.querySelector('#playerOverlay').hidden = false;
    const v = document.querySelector('#video');
    v.src = '/api/fake-stream';
    v.muted = true;
    await v.play();
    v.playbackRate = 0.1;
  });
  // Long enough that the ten-second window is fully inside the slow stretch,
  // with margin: the worst reading is only recorded once span() passes six
  // seconds, and a marginal wait made this pass or fail at random.
  await wait(16000);
  const bad = await page.evaluate(() => ({
    worst: playback.worstRate, kept: playback.worstReport.length,
  }));
  check('the bad moment was captured', bad.worst !== null && bad.worst < 0.3
    && bad.kept > 0, JSON.stringify(bad));

  // Now do what a person does: reload it. That fires loadstart.
  await page.evaluate(async () => {
    const v = document.querySelector('#video');
    v.playbackRate = 1;
    v.load();
    v.src = '/api/fake-stream';
    await v.play();
  });
  await wait(9000);
  const after = await page.evaluate(() => ({
    worst: playback.worstRate,
    now: playback.measuredRate(),
    text: playback.reportWithWorst(),
  }));
  console.log('   after reloading:', JSON.stringify({ worst: after.worst, now: after.now }));
  check('reloading does not erase the bad moment',
    after.worst !== null && after.worst < 0.3, String(after.worst));
  check('the recovered session measures normally', after.now > 0.85, String(after.now));
  check('the report keeps a worst-moment block',
    after.text.includes('worst moment of this viewing'),
    after.text.slice(-300));
  // Parsed rather than pattern-matched: 0.0999 prints as "0.100", so matching
  // on the digits after the point tests the formatter, not the reading.
  const block = after.text.split('worst moment of this viewing')[1] || '';
  const inBlock = Number(/measured rate\s+([\d.]+)x/.exec(block)?.[1]);
  check('that block holds the slow reading, not the recovered one',
    Number.isFinite(inBlock) && inBlock < 0.3, `${inBlock} — ${block.slice(0, 160)}`);

  // Starting a different title does clear it.
  await page.evaluate(() => playback.resetViewing());
  check('a new title starts from a clean sheet',
    (await page.evaluate(() => playback.worstRate)) === null);

  // --- the frame rate line ----------------------------------------------
  await page.evaluate(async () => {
    document.querySelector('#video').src = '/api/fake-stream';
    await document.querySelector('#video').play();
  });
  await wait(4000);
  const rep = await page.evaluate(() => playback.report());
  check('the report carries a frame rate line', /frame rate/.test(rep));
  check('and says what the conversion did', /conversion/.test(rep));


  // --- the case the ten-second average genuinely cannot see --------------
  // Seeking clears the sample window, and a worst reading is only recorded
  // once six seconds have rebuilt behind it. Someone whose playback has gone
  // wrong seeks again to fix it, and again — which keeps the window resetting
  // and means the headline figure never admits to anything. The timeline is
  // what covers that, because it records every second regardless.
  console.log('\n  a fault hidden by repeated seeking');
  await page.evaluate(() => playback.resetViewing());
  await page.evaluate(async () => {
    document.querySelector('#playerOverlay').hidden = false;
    const v = document.querySelector('#video');
    v.src = '/api/fake-stream';
    v.muted = true;
    v.playbackRate = 0.1;      // the fault, present from the start
    v.currentTime = 5;
    await v.play();
  });
  // Seek every four seconds, the way someone poking at bad playback does.
  for (let i = 0; i < 4; i += 1) {
    await wait(4000);
    await page.evaluate((n) => { document.querySelector('#video').currentTime = 20 + n * 10; }, i);
  }
  // Then it recovers, and only afterwards does anyone go looking — which is
  // how both of the real reports were taken. The averages fill back up with
  // good playback and say everything is fine; the timeline still remembers.
  await page.evaluate(() => { document.querySelector('#video').playbackRate = 1; });
  await wait(13000);

  const hidden = await page.evaluate(() => ({
    worst: playback.worstRate,
    spells: playback.slowSpells().map((s) => ({
      secs: Math.round((s.end.at - s.start.at) / 1000) + 1, worst: s.worst })),
    verdict: playback.verdict(),
    rows: playback.history.length,
    text: playback.report(),
  }));
  console.log('   ', JSON.stringify({ worst: hidden.worst, spells: hidden.spells,
    rows: hidden.rows }));
  console.log('   verdict:', hidden.verdict);
  check('the timeline recorded a row a second throughout', hidden.rows >= 25,
    String(hidden.rows));
  check('the averages have gone back to saying everything is fine',
    hidden.worst === null || hidden.worst > 0.9, String(hidden.worst));
  check('but the timeline catches the fault anyway',
    hidden.spells.length >= 1 && hidden.spells.some((s) => s.worst < 0.3),
    JSON.stringify(hidden.spells));
  check('and the verdict refuses to call that normal',
    /fell behind/.test(hidden.verdict), hidden.verdict);
  check('the report lists the spell', /slow spells\s+\ds from/.test(hidden.text),
    (hidden.text.match(/slow spells.*/) || [''])[0]);
  check('the report carries the timeline itself',
    hidden.text.includes('timeline  (film position'), 'no timeline block');
  check('the seeks are marked on the rows they happened',
    /seeking/.test(hidden.text), 'no seek note in the timeline');
  const seekRow = (hidden.text.match(/^\s+\+\s*\d+s.*seeking.*$/m) || [''])[0];
  console.log('   seek row:', seekRow.trim());
  check('a seek is not counted as a rate collapse',
    seekRow === '' || !/\d\.\d\dx/.test(seekRow), seekRow);
  console.log('   timeline tail:\n' +
    hidden.text.split('timeline  (film position')[1].split('\n').slice(0, 12)
      .map((l) => '  ' + l).join('\n'));


  // --- where the player put each track -----------------------------------
  // Reads hls.js internals, so it has to survive not having them: most of the
  // time there is no hls.js instance at all (a local file plays natively) and
  // the report still has to render.
  console.log('\n  track buffers');
  await page.evaluate(() => playback.resetViewing());
  await page.evaluate(async () => {
    document.querySelector('#playerOverlay').hidden = false;
    const v = document.querySelector('#video');
    v.src = '/api/fake-stream';
    v.muted = true;
    await v.play();
  });
  await wait(3000);
  check('no engine means no buffer lines, not a broken report',
    (await page.evaluate(() => playback.buffers())).length === 0
      && (await page.evaluate(() => playback.report())).includes('measured rate'));

  // A stand-in for hls.js placing the two tracks at different offsets.
  const lines = await page.evaluate(() => {
    window.__realEngine = engine;
    engine = { bufferController: { sourceBuffer: {
      video: { timestampOffset: 0, buffered: { length: 1, start: () => 0, end: () => 157 } },
      audio: { timestampOffset: -1.131, buffered: { length: 1, start: () => 0, end: () => 155.9 } },
    } } };
    const out = playback.buffers();
    const rep = playback.report();
    engine = window.__realEngine;
    return { out, rep };
  });
  console.log('   ', JSON.stringify(lines.out));
  check('both tracks are listed', lines.out.length === 2, JSON.stringify(lines.out));
  check('each carries its buffered range',
    lines.out.some((l) => l.startsWith('video: 0.00-157.00')), JSON.stringify(lines.out));
  check('and the timestampOffset that placed it',
    lines.out.some((l) => l.includes('offset -1.131')), JSON.stringify(lines.out));
  check('the report carries them', /buffers\s+video:/.test(lines.rep),
    (lines.rep.match(/buffers.*/) || [''])[0]);

  // Muxed output is a single buffer, and must not read as a missing track.
  const muxed = await page.evaluate(() => {
    window.__realEngine = engine;
    engine = { bufferController: { sourceBuffer: {
      audiovideo: { timestampOffset: 0, buffered: { length: 0 } },
    } } };
    const out = playback.buffers();
    engine = window.__realEngine;
    return out;
  });
  check('a single muxed buffer reads as one track',
    muxed.length === 1 && muxed[0].startsWith('audiovideo: empty'), JSON.stringify(muxed));


  // --- which engine produced the report ----------------------------------
  console.log('\n  browser line');
  const uaLines = await page.evaluate(() => playback.browserLines());
  console.log('   ', uaLines.join('\n    '));
  check('the report names the browser it came from',
    /Chrom|Firefox|Safari|Mozilla/.test(uaLines[0]), uaLines[0]);
  check('and what that browser can do',
    /iOS (true|false), MSE (true|false)/.test(uaLines[1]), uaLines[1]);
  check('hls.js support is reported, since it decides the whole VOD path',
    /hls\.js (true|false)/.test(uaLines[1]), uaLines[1]);
  const uaReport = await page.evaluate(() => playback.report());
  check('it lands in the report', /^browser\s+\S/m.test(uaReport),
    (uaReport.match(/browser.*/) || [''])[0]);
  check('a long user agent cannot run away with the line',
    uaLines[0].length <= 166, String(uaLines[0].length));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
