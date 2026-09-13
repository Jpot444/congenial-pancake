/**
 * A live channel has to keep going forwards.
 *
 * Two reports, one cause:
 *
 *   "the red zone screen will just pause and never start playing unless I
 *    press restart stream"
 *   "a stream will go back in time and replay stuff it has already played"
 *
 * The playback report caught the end state exactly, and it is not a stall:
 *
 *     currentTime  0.00      buffered  20.0-30.0
 *     paused/seeking  false / true     readyState 1
 *
 * The playhead is at zero and the only video in hand starts at twenty
 * seconds. It is standing in a gap with nothing to play and nothing that will
 * ever move it. A stall ends when the next segment lands; this does not end.
 * Reload cleared it because re-resolving lands at the live edge — which is
 * why the report was "unless I press restart stream".
 *
 * Nothing was watching for it. The live loop drew the delay pill and nothing
 * else, on the deliberate principle that this code never chases latency. That
 * principle is untouched here: being a minute behind is still fine and still
 * silent. The one rule added is that the picture must not be FROZEN, and must
 * not be replaying video already shown.
 *
 * Driven through the shipped `liveKeepsGoing` with a stand-in media element,
 * because what is under test is the decision, not the decoder. The stuck
 * clock is moved by writing `since` into the state the function is handed —
 * which is the suite's own object, not a private the test is reaching into.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  /*
   * One harness for every case below. `stuckFor` writes the state's own clock
   * back, which is how a twelve-second wedge is tested without a test that
   * takes twelve seconds.
   */
  await page.evaluate(() => {
    window.__ran = { loads: 0, reloads: 0, toasts: [] };
    /*
     * Stand-ins for the three things the watchdog can reach for, and the two
     * kinds of binding app.js has.
     *
     * `engine` and `engineKind` are top-level `let` — LEXICAL bindings, which
     * are reachable by bare name but are not properties of window. Assigning
     * window.engine would make a second, unrelated variable and the watchdog
     * would go on using the real one, which is how this suite first read
     * "0 refetches" against code that was refetching. `reloadStream` and
     * `toast` are function declarations, which are window properties, so
     * those are replaced the ordinary way.
     */
    engine = { startLoad() { window.__ran.loads += 1; } };
    engineKind = 'hls.js';
    window.reloadStream = () => { window.__ran.reloads += 1; };
    window.toast = (m) => { window.__ran.toasts.push(m); };

    window.__video = (over) => ({
      paused: false,
      seeking: false,
      currentTime: 0,
      buffered: { length: 0, start() { return 0; }, end() { return 0; } },
      ...over,
    });
    window.__ranges = (pairs) => ({
      length: pairs.length,
      start: (i) => pairs[i][0],
      end: (i) => pairs[i][1],
    });
    window.__stuckFor = (state, seconds) => {
      state.since = Date.now() - seconds * 1000;
      return state;
    };
  });

  const run = (script) => page.evaluate(script);

  /* ---- 1. the wedge from the report ------------------------------------ */
  /*
   * The exact numbers that were captured: playhead at zero, twenty to thirty
   * seconds held, not paused. The cheapest correct answer is to step into the
   * video already in hand — it loses nothing and asks the network for
   * nothing.
   */
  console.log('\n  the playhead stranded in front of everything held');
  const wedge = await run(() => {
    const v = window.__video({ currentTime: 0, buffered: window.__ranges([[20, 30]]) });
    const state = window.__stuckFor({ at: 0, since: 0, tries: 0 }, 13);
    liveKeepsGoing(v, state);
    return { at: v.currentTime, loads: window.__ran.loads, reloads: window.__ran.reloads };
  });
  console.log('   ', JSON.stringify(wedge));
  check('it is moved into the video that is actually held',
    wedge.at > 20 && wedge.at < 21, String(wedge.at));
  check('without asking the network for anything first',
    wedge.loads === 0 && wedge.reloads === 0, JSON.stringify(wedge));

  /* ---- 2. and a picture that is moving is left alone -------------------- */
  console.log('\n  but a channel that is playing is never touched');
  const fine = await run(() => {
    window.__ran = { loads: 0, reloads: 0, toasts: [] };
    const v = window.__video({ currentTime: 41, buffered: window.__ranges([[20, 60]]) });
    const state = window.__stuckFor({ at: 40, since: 0, tries: 3 }, 600);
    liveKeepsGoing(v, state);
    return { at: v.currentTime, tries: state.tries,
      loads: window.__ran.loads, reloads: window.__ran.reloads };
  });
  console.log('   ', JSON.stringify(fine));
  check('the playhead is not moved',
    fine.at === 41, String(fine.at));
  check('and ten minutes of healthy playing does not count towards a wedge',
    fine.tries === 0 && fine.loads === 0 && fine.reloads === 0, JSON.stringify(fine));

  /* ---- 3. a pause is a decision ---------------------------------------- */
  /*
   * The one thing this must never do is argue with somebody who pressed
   * pause. Being stopped for ten minutes on purpose looks identical to a
   * wedge on every measure except this one.
   */
  console.log('\n  and a pause is never argued with');
  const paused = await run(() => {
    window.__ran = { loads: 0, reloads: 0, toasts: [] };
    const v = window.__video({ paused: true, currentTime: 30,
      buffered: window.__ranges([[20, 60]]) });
    const state = window.__stuckFor({ at: 30, since: 0, tries: 0 }, 600);
    liveKeepsGoing(v, state);
    return { at: v.currentTime, tries: state.tries,
      loads: window.__ran.loads, reloads: window.__ran.reloads };
  });
  console.log('   ', JSON.stringify(paused));
  check('nothing is moved, fetched or reopened',
    paused.at === 30 && paused.loads === 0 && paused.reloads === 0, JSON.stringify(paused));
  check('and the wedge clock is reset, so unpausing does not look like a fault',
    paused.tries === 0, String(paused.tries));

  /* ---- 4. going back in time ------------------------------------------- */
  /*
   * "a stream will go back in time and replay stuff it has already played" —
   * 154 seconds of it in the captured report, when the playlist was
   * renumbered underneath the playhead.
   */
  console.log('\n  video already shown is not shown again');
  const back = await run(() => {
    window.__ran = { loads: 0, reloads: 0, toasts: [] };
    const v = window.__video({ currentTime: 26.1, buffered: window.__ranges([[20, 180]]) });
    const state = { at: 180.1, since: Date.now(), tries: 0 };
    liveKeepsGoing(v, state);
    return { at: v.currentTime, reloads: window.__ran.reloads };
  });
  console.log('   ', JSON.stringify(back));
  check('the playhead is put back to the front of what is held',
    back.at > 170 && back.at <= 180, String(back.at));
  check('rather than throwing the connection away for it',
    back.reloads === 0, String(back.reloads));

  /* ---- 5. a seek that hangs -------------------------------------------- */
  /*
   * The captured wedge was `paused/seeking false / true`: stuck INSIDE a seek
   * to a position with nothing behind it. Treating "seeking" as progress
   * would have made this watchdog blind to the one state it exists for — and
   * seeking AGAIN is no answer when a seek is the thing that is stuck.
   */
  console.log('\n  and a seek that never lands is not waited on for ever');
  const hung = await run(() => {
    window.__ran = { loads: 0, reloads: 0, toasts: [] };
    const v = window.__video({ seeking: true, currentTime: 0,
      buffered: window.__ranges([[20, 30]]) });
    const state = window.__stuckFor({ at: 0, since: 0, tries: 0 }, 13);
    liveKeepsGoing(v, state);
    const first = { at: v.currentTime, loads: window.__ran.loads };
    /* Still hung after the refetch: the connection goes. */
    window.__stuckFor(state, 13);
    liveKeepsGoing(v, state);
    window.__stuckFor(state, 13);
    liveKeepsGoing(v, state);
    return { first, loads: window.__ran.loads, reloads: window.__ran.reloads,
      toasts: window.__ran.toasts };
  });
  console.log('   ', JSON.stringify(hung));
  check('it is not seeked again, because a seek is what is stuck',
    hung.first.at === 0, String(hung.first.at));
  check('the engine is asked to fetch from the edge first',
    hung.first.loads === 1, String(hung.first.loads));
  check('and if that does not clear it the channel is reopened',
    hung.reloads === 1, String(hung.reloads));
  check('saying so, rather than doing it behind the viewer’s back',
    /stopped/i.test(hung.toasts.join(' ')), JSON.stringify(hung.toasts));

  /* ---- 6. frozen inside the buffer ------------------------------------- */
  /*
   * Held video either side of the playhead and still not moving is not a gap
   * to step into — there is nowhere to step. That one goes straight to the
   * engine.
   */
  console.log('\n  frozen with video in hand either side is a refetch, not a seek');
  const frozen = await run(() => {
    window.__ran = { loads: 0, reloads: 0, toasts: [] };
    const v = window.__video({ currentTime: 40, buffered: window.__ranges([[20, 60]]) });
    const state = window.__stuckFor({ at: 40, since: 0, tries: 0 }, 13);
    liveKeepsGoing(v, state);
    return { at: v.currentTime, loads: window.__ran.loads, reloads: window.__ran.reloads };
  });
  console.log('   ', JSON.stringify(frozen));
  check('the playhead is left where it is',
    frozen.at === 40, String(frozen.at));
  check('and the engine is asked for video before anything is thrown away',
    frozen.loads === 1 && frozen.reloads === 0, JSON.stringify(frozen));

  /* ---- 7. the escalation stops ----------------------------------------- */
  /*
   * A channel that is genuinely off the air must not be reopened for ever —
   * that is a loop nobody can watch and nobody can stop.
   */
  console.log('\n  and a channel that is simply gone is not reopened for ever');
  const gone = await run(() => {
    window.__ran = { loads: 0, reloads: 0, toasts: [] };
    const v = window.__video({ currentTime: 0, buffered: window.__ranges([]) });
    const state = { at: 0, since: Date.now(), tries: 0 };
    for (let i = 0; i < 12; i += 1) {
      window.__stuckFor(state, 13);
      liveKeepsGoing(v, state);
    }
    return { loads: window.__ran.loads, reloads: window.__ran.reloads, tries: state.tries };
  });
  console.log('   ', JSON.stringify(gone));
  check('it gives up instead of reopening on a loop',
    gone.reloads <= 1, `${gone.reloads} reloads`);
  check('and stops asking the engine too',
    gone.loads <= 2, `${gone.loads} refetches`);

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
