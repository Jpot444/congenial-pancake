/**
 * A film or episode has to keep going, the same as a live channel.
 *
 *   "sometimes im getting pauses in series or movies im streaming and need to
 *    press the refresh button"
 *
 * liveKeepsGoing only ever ran for live channels, so a film that froze sat
 * there until somebody pressed Reload. filmKeepsGoing is that rule for films:
 * step over a gap, refetch, and reload from the same spot, with no endless
 * reload loop when the provider is really down.
 *
 * Driven through the shipped function with a stand-in media element, as
 * livewedge does. Each evaluate turns `film.active` off again before it
 * returns, so the real once-a-second watchdog has nothing to act on between
 * cases.
 */
const { chromium } = require('./playwright.js');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;

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

  await page.evaluate(() => {
    // Lexical bindings are assigned by bare name; see livewedge for why.
    engine = { startLoad(at) { window.__ran.loads.push(at); } };
    engineKind = 'hls.js';
    window.reloadStream = () => { window.__ran.reloads += 1; };
    window.toast = (m) => { window.__ran.toasts.push(m); };
    window.__fresh = () => { window.__ran = { loads: [], reloads: 0, toasts: [] }; };
    window.__video = (over) => ({
      paused: false,
      ended: false,
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
    window.__stuck = (at, seconds, tries = 0) =>
      ({ at, since: Date.now() - seconds * 1000, tries });
  });

  const run = (script) => page.evaluate(script);

  console.log('\n  a frozen film is picked up again without a press');
  const frozen = await run(() => {
    window.__fresh();
    film.active = true;
    const v = window.__video({ currentTime: 600, buffered: window.__ranges([[590, 600]]) });
    const state = window.__stuck(600, 21);
    filmKeepsGoing(v, state);
    const first = { loads: [...window.__ran.loads], reloads: window.__ran.reloads };
    state.since = Date.now() - 21_000;
    filmKeepsGoing(v, state);
    film.active = false;
    return { first, loads: window.__ran.loads, reloads: window.__ran.reloads,
      toasts: window.__ran.toasts };
  });
  console.log('   ', JSON.stringify(frozen));
  check('it asks the engine to refetch from where it stands first',
    frozen.first.loads.length === 1 && frozen.first.loads[0] === 600
      && frozen.first.reloads === 0, JSON.stringify(frozen.first));
  check('and reloads, which is the button the viewer was pressing',
    frozen.reloads === 1 && frozen.toasts.length === 1, JSON.stringify(frozen));

  console.log('\n  a film stranded in a gap steps over it');
  const gap = await run(() => {
    window.__fresh();
    film.active = true;
    const v = window.__video({ currentTime: 100, buffered: window.__ranges([[80, 99], [130, 160]]) });
    filmKeepsGoing(v, window.__stuck(100, 21));
    film.active = false;
    return { at: v.currentTime, loads: window.__ran.loads.length, reloads: window.__ran.reloads };
  });
  console.log('   ', JSON.stringify(gap));
  check('it is moved into the video that is held',
    gap.at > 130 && gap.at < 131 && gap.loads === 0 && gap.reloads === 0, JSON.stringify(gap));

  console.log('\n  but a short wait is left alone');
  const brief = await run(() => {
    window.__fresh();
    film.active = true;
    const v = window.__video({ currentTime: 600 });
    const state = window.__stuck(600, 12);
    filmKeepsGoing(v, state);
    film.active = false;
    return { tries: state.tries, loads: window.__ran.loads.length, reloads: window.__ran.reloads };
  });
  check('twelve seconds of buffering is not called a freeze',
    brief.tries === 0 && brief.loads === 0 && brief.reloads === 0, JSON.stringify(brief));

  console.log('\n  and a pause, an ending or a live channel is never touched');
  const left = await run(() => {
    const out = {};
    for (const [name, over, active] of [
      ['paused', { paused: true }, true],
      ['ended', { ended: true }, true],
      ['live', {}, false],
    ]) {
      window.__fresh();
      film.active = active;
      const state = window.__stuck(600, 600);
      filmKeepsGoing(window.__video({ currentTime: 600, ...over }), state);
      out[name] = { tries: state.tries, loads: window.__ran.loads.length,
        reloads: window.__ran.reloads };
    }
    film.active = false;
    return out;
  });
  console.log('   ', JSON.stringify(left));
  for (const [name, r] of Object.entries(left)) {
    check(`${name}: nothing fetched or reloaded`,
      r.tries === 0 && r.loads === 0 && r.reloads === 0, JSON.stringify(r));
  }

  console.log('\n  and a provider that is really down is not reloaded for ever');
  const down = await run(() => {
    window.__fresh();
    film.active = true;
    const v = window.__video({ currentTime: 600 });
    const state = window.__stuck(600, 21);
    for (let i = 0; i < 12; i += 1) {
      state.since = Date.now() - 21_000;
      filmKeepsGoing(v, state);
    }
    film.active = false;
    return { reloads: window.__ran.reloads, loads: window.__ran.loads.length };
  });
  console.log('   ', JSON.stringify(down));
  check('it gives up after a few reloads',
    down.reloads === 3 && down.loads === 1, JSON.stringify(down));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
