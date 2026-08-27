/**
 * How a live channel plays, now that there is nothing to choose.
 *
 * The dropdown offered three modes — ride the edge, balanced, don't drain at
 * all — which asked the viewer to trade stalling against being behind live
 * without giving them any way to know which they were about to get. The trade
 * is real; it just has a right answer on this provider.
 *
 * The claim being checked is that the two costs are on SEPARATE dials, which
 * the dropdown implied they were not:
 *
 *   * how far behind you are  = where the playhead sits (liveSyncDurationCount)
 *   * how much cushion        = how much between there and the edge is loaded
 *                               (maxBufferLength)
 *
 * A live playlist only ever exposes up to the edge, so buffering hard cannot
 * push you further behind — it fills in the gap you are already standing in.
 * That is why one setting can be both clean and close, and it is what these
 * checks pin down: a bounded distance from the edge, a cushion much larger
 * than that distance, and no chasing.
 */
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const SERVER = fs.readFileSync(PATHS.SERVER, 'utf8');
const APP = fs.readFileSync(PATHS.APP, 'utf8');
const HTML = fs.readFileSync(PATHS.INDEX, 'utf8');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // --- the setting is gone -------------------------------------------------
  console.log('\n  nothing left to choose');
  check('no latency dropdown in the player', !/id="latencyMode"/.test(HTML));
  check('and nothing in the client still reads a stored choice',
    !/liveLatency/.test(APP), 'liveLatency still referenced in app.js');
  // Comments stripped first: this file is full of prose about latency, and the
  // first version of this check was tripped by its own explanation.
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('nor sends one to the box', !/\blatency:\s/.test(code),
    (code.match(/.*\blatency:\s.*/) || [''])[0].trim());
  check('and the server no longer keeps the preference',
    !/liveLatency/.test(SERVER), 'liveLatency still in server.js');
  check('nor branches on three modes',
    !/MODES\s*=/.test(SERVER), 'the MODES table is still there');

  // --- what an MPEG-TS channel gets ---------------------------------------
  //
  // The figures the old "balanced" mode used, which are the ones that measured
  // zero stalls and zero seeks. The other two each gave up one of the two
  // things anybody actually wants.
  console.log('\n  MPEG-TS');
  const ts = /const LIVE_TS = \{ drain: (\d+), hold: (\d+) \};/.exec(SERVER);
  check('one fixed setting, not a lookup', Boolean(ts), 'LIVE_TS not found');
  check('the opening backlog is still drained, or you start 25s behind',
    Number(ts[1]) >= 10, ts && ts[1]);
  check('and a jitter buffer is still banked, or a 5s gap stalls it',
    Number(ts[2]) >= 3, ts && ts[2]);
  check('and it is applied unconditionally now',
    /url \+= `&drain=\$\{LIVE_TS\.drain\}&hold=\$\{LIVE_TS\.hold\}`;/.test(SERVER),
    'drain/hold is still behind a condition');

  // --- what an HLS channel gets -------------------------------------------
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  console.log('\n  HLS');
  const cfg = await page.evaluate(() => ({ ...LIVE_HLS }));
  console.log('   config:', JSON.stringify(cfg));

  check('it does not pretend the provider serves low-latency HLS',
    cfg.lowLatencyMode === false, String(cfg.lowLatencyMode));

  // In SECONDS, and this is the whole of the fix for the stalls. A segment
  // count reads like a cushion and is not one: it multiplies the playlist's own
  // targetDuration and is clamped into whatever playlist exists at the moment
  // of joining. A measured session on `liveSyncDurationCount: 3` joined 2.8
  // seconds from the end of the loaded data and stalled the instant the
  // playhead caught it — twice — then played perfectly once ~10s of cushion had
  // built up on its own.
  check('the join distance is stated in seconds, not segments',
    typeof cfg.liveSyncDuration === 'number'
    && cfg.liveSyncDurationCount === undefined, JSON.stringify(cfg));
  // And far enough back to be worth having. Eighteen seconds was not: this
  // provider publishes ~11s segments, so 18 is a seat 1.6 segments from the
  // edge, and a segment is only fetchable once complete — so there was never
  // more than one to be had. A measured session started with 7.1s downloaded
  // and stalled seven seconds later, on cue.
  check('and is far enough back to hold more than one segment of this provider',
    cfg.liveSyncDuration >= 11 * 2.5, String(cfg.liveSyncDuration));
  // But this is live: a minute behind is not live any more.
  check('while still being seconds behind rather than a minute',
    cfg.liveSyncDuration <= 40, String(cfg.liveSyncDuration));

  // The cushion is free, because a live playlist stops at the edge and
  // buffering ahead can only fill the gap you are already standing in.
  // The requirement is that the buffer can hold everything between the seat
  // and the edge. It used to be written as `* 2`, which passed incidentally
  // when the seat was 18 and says nothing: a live playlist stops at the edge,
  // so the buffer can never exceed the seat distance however large this is.
  check('and everything from the playhead to the edge is held',
    cfg.maxBufferLength >= cfg.liveSyncDuration,
    JSON.stringify({ buffer: cfg.maxBufferLength, back: cfg.liveSyncDuration }));

  // And it must not chase. A player seeking on its own is the "skips to the
  // end" fault this app has already been through once.
  check('and it does not correct on ordinary jitter',
    cfg.liveMaxLatencyDuration >= cfg.liveSyncDuration * 3,
    JSON.stringify({ max: cfg.liveMaxLatencyDuration, sync: cfg.liveSyncDuration }));
  check('but the back buffer is still bounded, since live never rewinds far',
    cfg.backBufferLength > 0 && cfg.backBufferLength <= 120,
    String(cfg.backBufferLength));

  // --- the same settings in both players -----------------------------------
  //
  // Multi-view is a separate player with its own engine construction, and two
  // copies of a tuning like this drift the moment one of them is touched.
  console.log('\n  both players');
  // Both spread the shared base and both apply the same DVR-seat override on
  // top of it, so the tuning still has exactly one home.
  const shared = (APP.match(/\.\.\.LIVE_HLS, \.\.\.\((?:opts\.)?dvr \? \{ liveSyncDuration: LIVE_DVR_SEAT \}/g) || []).length;
  console.log('   places using the shared config:', shared);
  check('the main player and multi-view take the same one', shared === 2,
    String(shared));

  // --- what a report has to be able to say ---------------------------------
  //
  // A timeline can say the buffer ran out. It cannot say why, and the two
  // candidates want opposite fixes: either the link is not delivering the
  // stream faster than it plays, in which case no tuning invents bandwidth, or
  // it is and the player is sitting too close to the edge to have anything in
  // hand. Guessing between them is how this got tuned twice in the wrong
  // direction, so the numbers that separate them are in the report now.
  console.log('\n  what the report can settle');
  const lines = await page.evaluate(() => {
    engineKind = 'hls.js';
    engine = {
      bandwidthEstimate: 9_400_000,
      currentLevel: 0,
      latency: 21.4,
      targetLatency: 18,
      levels: [{ bitrate: 11_200_000, details: { live: true, targetduration: 10,
        totalduration: 30, fragments: [1, 2, 3] } }],
    };
    return playback.hlsLines();
  });
  for (const l of lines) console.log('   ', l);
  const all = lines.join('\n');
  check('it says what the link measured against what the stream needs',
    /9\.4 Mbit\/s measured, 11\.2 Mbit\/s needed/.test(all), all);
  check('and turns that into the one number that decides it — headroom',
    /0\.84x headroom/.test(all), all);
  check('it says how much playlist is even fetchable, which caps any cushion',
    /3 segments of ~10s = 30s window/.test(all), all);
  check('and whether the join distance is doing what it was told',
    /21\.4s behind the edge, asked for 18\.0s/.test(all), all);

  // It must never be the thing that breaks a report.
  const quiet = await page.evaluate(() => {
    engineKind = 'mpegts.js';
    return playback.hlsLines();
  });
  check('nothing is claimed about an engine that is not hls.js',
    quiet.length === 0, JSON.stringify(quiet));
  const bare = await page.evaluate(() => {
    engineKind = 'hls.js';
    engine = {};
    return playback.hlsLines();
  });
  check('and an engine with nothing to say produces nothing, rather than throwing',
    bare.length === 0, JSON.stringify(bare));

  // --- getting back when it has drifted ------------------------------------
  //
  // --- nothing moves the playhead --------------------------------------
  //
  // This has been wrong twice, in opposite directions. First a
  // liveMaxLatencyDuration of 60 against a 58-second window — a safety net
  // pitched past the end of the playlist, which could never fire. Then a
  // correction of our own, which fired, jumped the picture forward and
  // announced it.
  //
  // Both assumed being far behind live is a fault worth interrupting the
  // picture to fix. On a slow link it is not: seeking forward discards the
  // downloaded video that was keeping the picture up and buys a seat nearer an
  // edge the link cannot sustain, which starves again in seconds. One stall
  // becomes a stall plus a jump.
  console.log('\n  nothing chases the live edge');
  const still = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    engineKind = 'hls.js';
    currentLiveItem = { kind: 'live', id: 1, name: 'A channel' };
    // Fifty seconds behind in a 58-second window: the session that used to
    // trigger a jump, and the worst state a channel can be in short of dying.
    engine = { config: {}, currentLevel: 0, latency: 50.7,
      liveSyncPosition: 200, levels: [{ details: { totalduration: 58 } }] };
    const v = document.querySelector('#video');
    Object.defineProperty(v, 'paused', { value: false, configurable: true });
    Object.defineProperty(v, 'seeking', { value: false, configurable: true });
    v.currentTime = 160;
    document.querySelector('#toast').hidden = true;
    startLiveTracking();
    await sleep(2400);            // several ticks
    const out = { at: v.currentTime,
      said: document.querySelector('#toast').hidden
        ? '' : document.querySelector('#toast').textContent,
      pill: document.querySelector('#liveLag').textContent };
    stopLiveTracking();
    return out;
  });
  console.log('   50s behind, left alone for several ticks:', JSON.stringify(still));
  check('a playhead miles behind live is not dragged forward',
    still.at === 160, JSON.stringify(still));
  check('and nothing is announced, because nothing happened',
    still.said === '', still.said);
  // And while it sits there, the pill tells the truth about it. The old
  // measure was distance to the DOWNLOADED buffer, which reads zero exactly
  // when a starved link has drained it — so it said LIVE to a viewer 50
  // seconds behind with nothing in hand. The distance shown is to the edge.
  check('the pill shows the real delay, not the buffer state',
    /51s delay/.test(still.pill), still.pill);
  check('and does not claim LIVE from a drained buffer',
    !/LIVE/.test(still.pill), still.pill);

  // Belt and braces on the source: no seek can hide in the live tick.
  const tick = /function startLiveTracking\(\)[\s\S]*?\n\}/.exec(APP)[0];
  check('the live tick contains no assignment to currentTime',
    !/currentTime\s*=/.test(tick), tick.slice(0, 200));
  check('and the catch-up is gone from the app entirely',
    !/catchUpIfAdrift|holdLiveDistance/.test(APP));

  // hls.js's own chaser has to stay parked, or it does the same thing.
  check('hls.js\'s own latency trigger is parked out of reach',
    cfg.liveMaxLatencyDuration >= 300, String(cfg.liveMaxLatencyDuration));

  // But its stall and gap recovery is a different thing and must NOT be off:
  // it steps over a hole in the media, which is the difference between a
  // picture that continues and one frozen for good.
  check('while stall recovery is left alone, since a hole would freeze it',
    cfg.nudgeMaxRetry === undefined && cfg.maxBufferHole === undefined,
    JSON.stringify({ nudge: cfg.nudgeMaxRetry, hole: cfg.maxBufferHole }));

  // --- not starting before there is anything to play -----------------------
  //
  // The measured v22.4 session, which is what this is for:
  //
  //   +13s  first segment lands (10s of media, 13s to arrive)  play starts
  //   +20s  playhead reaches the end of it
  //   +21s  stalled
  //   +28s  second segment lands
  //
  // It started with 7.1 seconds in hand and spent it. Meanwhile 33 seconds of
  // playlist was published and not yet fetched — the material was there, the
  // head start was not.
  console.log('\n  waiting for something to play');
  const gate = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    currentLiveItem = { kind: 'live', id: 1 };
    engine = { config: {}, currentLevel: 0, latency: 20,
      levels: [{ details: { totalduration: 60 } }] };
    let ahead = 7;          // one segment, the way the report started
    let played = 0;
    let paused = 0;
    const fake = {
      currentTime: 40,
      // Autoplay is on the element, so it starts itself the instant it can.
      // The gate has to take it back, not merely decline to start it.
      paused: false,
      pause() { paused += 1; this.paused = true; },
      play() { played += 1; this.paused = false; return Promise.resolve(); },
      buffered: { length: 1, start: () => 40, end: () => 40 + ahead },
    };
    waitForCushion(fake);
    await sleep(400);
    const held = { played, note: document.querySelector('#videoStatus').textContent,
      shown: !document.querySelector('#videoStatus').hidden };
    ahead = 25;             // enough now
    await sleep(400);
    const released = { played, note: document.querySelector('#videoStatus').textContent,
      shown: !document.querySelector('#videoStatus').hidden };
    stopCushionWait();
    return { held, released, paused };
  });
  console.log('   one segment in hand:', JSON.stringify(gate.held));
  console.log('   a real cushion in hand:', JSON.stringify(gate.released));
  check('one segment is not enough to start on', gate.held.played === 0,
    JSON.stringify(gate.held));
  check('and the wait is visible rather than a blank screen', gate.held.shown
    && /buffer/i.test(gate.held.note), JSON.stringify(gate.held));
  check('it holds actively, because autoplay would start it otherwise',
    gate.paused > 0, String(gate.paused));
  check('and it starts once there is a cushion', gate.released.played === 1,
    JSON.stringify(gate.released));
  check('clearing the message when it does',
    gate.released.note === '' && gate.released.shown === false,
    JSON.stringify(gate.released));

  // A wait with no end is worse than a stall you can see the reason for.
  const capped = /const LIVE_WAIT_MAX = (\d+);/.exec(APP);
  console.log('   longest it will ever wait:', capped && capped[1]);
  check('the wait is capped, so a dead link does not spin forever',
    capped && Number(capped[1]) > 0 && Number(capped[1]) <= 30000,
    String(capped && capped[1]));
  check('and starting anyway at the cap is in the start condition',
    /Date\.now\(\) >= until/.test(APP));

  // Closing the player has to end the wait, or it holds the next stream.
  check('and a teardown ends it rather than leaving a timer behind',
    /function teardown\(\) \{[\s\S]{0,200}stopCushionWait\(\);/.test(APP));

  // hls.js's own trigger is kept out of the way: two mechanisms racing to seek
  // would be worse than one, and only ours knows the window.
  check('hls.js\'s own latency trigger is parked, not competing',
    cfg.liveMaxLatencyDuration >= 300, String(cfg.liveMaxLatencyDuration));

  // --- the readout stays ---------------------------------------------------
  //
  // Removing the setting is not removing the information. How far behind you
  // are is worth seeing, and jumping to the edge is worth being able to do on
  // purpose — what it must never be is something the player decides by itself.
  console.log('\n  what is left in the player');
  check('the LIVE pill is still there', /id="livePill"/.test(HTML));
  check('and still says how far behind you are',
    /delay`/.test(APP), 'the lag readout is gone');
  check('and pressing it still jumps to the edge',
    /#livePill'\)\.addEventListener/.test(APP), 'the jump-to-edge handler is gone');

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
