/**
 * A film in a multi-view cell has a timeline.
 *
 * "If I load a movie or series in multiplayer I can't seek into the film and I
 *  don't get a resume playing button."
 *
 * Both halves of that are the same missing idea, and it is worth naming
 * because it is not obvious from the outside. A cell knew only what its video
 * element knew — and for a converted title the element's zero is wherever
 * ffmpeg was started, not the top of the film. So:
 *
 *   THERE WAS NOTHING TO SCRUB. The bar had −10 and +10 and nothing else, and
 *   both were clamped to what the element reported as seekable, which for a
 *   conversion is only the span already written. Ten seconds past the frontier
 *   did nothing, for ever. There was no way to reach minute forty at all.
 *
 *   THERE WAS NOTHING TO RESUME TO. A cell never wrote history, so a film
 *   watched in one left no position behind — and it never read one either, so
 *   a film left half-watched in the main player started again from the top.
 *
 * The server had every piece of this already: /api/remux takes a `start`,
 * answers with the `offset` it used and the runtime it probed, and `replaces`
 * exists so one cell restarting its conversion does not cut off another's.
 * None of it needed building; a cell simply never asked.
 *
 * So what is checked here is the asking, at the wire: which parameters the box
 * is given when a cell opens a half-watched film, where the scrubber puts the
 * knob, what a click on it makes the box do, and what the cell writes back.
 * The conversion itself is stubbed — ffmpeg is not what is under test, and
 * there is none in this container anyway.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A two-hour film, left forty minutes in. */
const RUNTIME = 7200;
const LEFT_AT = 2400;

const LIBRARY = {
  movies: {
    categories: [{ id: 'm1', name: 'EN - FILMS' }],
    items: [{ kind: 'movie', id: 901, name: 'Redwood Gulch', logo: '', ext: 'mkv', categoryId: 'm1' }],
  },
  series: {
    categories: [{ id: 's1', name: 'EN - DRAMA' }],
    items: [{ kind: 'series', id: 77, name: 'The Long Winter', logo: '', categoryId: 's1' }],
  },
  live: {
    categories: [{ id: 'c1', name: 'US| SPORTS' }],
    items: [{ kind: 'live', id: 1, name: 'US| MLB NETWORK', logo: '', categoryId: 'c1' }],
  },
};
const EPISODES = {
  1: [
    { id: 101, episode_num: 1, title: 'Pilot', container_extension: 'mkv' },
    { id: 102, episode_num: 2, title: 'Second', container_extension: 'mkv' },
  ],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  /* hls.js off the CDN is a network this may not have and a version that can
     change under the suite. A stand-in takes its place: it reports a growing
     seekable range, which is exactly what a conversion looks like to the
     element, and that is the only thing any of this reads. */
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.addInitScript(() => {
    window.__engine = { sources: [], destroyed: 0 };
    /* How much of the conversion has been written, in seconds from ITS start.
       The suite moves this to model ffmpeg getting further along. */
    window.__converted = 90;
    class StandInHls {
      static isSupported() { return true; }
      constructor() { this.alive = true; }
      loadSource(url) {
        window.__engine.sources.push(url);
        const video = this.video;
        if (video) StandInHls.seat(video);
      }
      attachMedia(video) {
        this.video = video;
        StandInHls.seat(video);
        /* A fresh attach starts at the head of the new playlist. The real
           engine is given `startPosition: 0` for a conversion and seeks there
           itself; without this the fake carries the old position across a
           restart, which is a thing that cannot happen. */
        video.__t = 0;
        video.src = URL.createObjectURL(new MediaSource());
      }
      static seat(video) {
        if (video.__seated) return;
        video.__seated = true;
        video.__t = 0;
        Object.defineProperty(video, 'currentTime', {
          configurable: true,
          get() { return video.__t; },
          set(v) { video.__t = Math.max(0, v); video.dispatchEvent(new Event('timeupdate')); },
        });
        Object.defineProperty(video, 'seekable', {
          configurable: true,
          get: () => ({ length: 1, start: () => 0, end: () => window.__converted }),
        });
        Object.defineProperty(video, 'duration', { configurable: true, get: () => Infinity });
      }
      on() {}
      startLoad() {}
      recoverMediaError() {}
      destroy() { window.__engine.destroyed += 1; }
    }
    StandInHls.Events = { ERROR: 'hlsError' };
    StandInHls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    window.Hls = StandInHls;
  });

  await page.route('**/api/library*', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(LIBRARY[tab] || { categories: [], items: [] }) });
  });
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"continueWatching":[],"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_series_info') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {}, episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  /* The watch history, as the box would answer it: this film was left forty
     minutes into two hours. */
  const progressAsked = [];
  await page.route('**/api/profiles/*/progress*', (r) => {
    const key = new URL(r.request().url()).searchParams.get('key');
    progressAsked.push(key);
    const found = key === 'movie:901' || key === 'series:77:s1e2';
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(found
        ? { found: true, position: LEFT_AT, duration: RUNTIME, completed: false }
        : { found: false }) });
  });

  /* Every conversion the box is asked for, and what it answers: a session that
     starts exactly where it was told to and knows how long the film is. */
  const remuxes = [];
  await page.route('**/api/remux*', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/remux/status') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"seconds":90,"complete":false,"target":45,"failed":false,"error":""}' });
    }
    if (url.pathname === '/api/remux/stop') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"stopped":true}' });
    }
    const start = Math.floor(Number(url.searchParams.get('start') || 0));
    remuxes.push({
      kind: url.searchParams.get('kind'),
      id: url.searchParams.get('id'),
      start,
      replaces: url.searchParams.get('replaces') || '',
    });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        url: `/hls/sess-${remuxes.length}/index.m3u8`,
        format: 'm3u8',
        session: `sess-${remuxes.length}`,
        prebuffer: 45,
        offset: start,
        sourceDuration: RUNTIME,
        subs: [],
      }) });
  });

  /* What a cell writes back. sendBeacon, the same as the main player. */
  const written = [];
  await page.route('**/api/profiles/*/history', async (r) => {
    try { written.push(JSON.parse(r.request().postData() || '{}')); } catch { /* not ours */ }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await page.evaluate((lib) => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    Object.assign(state.library, lib);
  }, LIBRARY);

  const film = LIBRARY.movies.items[0];

  /* ---- 1. it starts where it was left ----------------------------------- */
  console.log('\n  opening a film that was left forty minutes in');
  await page.evaluate((item) => {
    multiview.open();
    multiview.start(0, item);
  }, film);
  await wait(2500);

  console.log('   asked the history for:', JSON.stringify(progressAsked));
  check('the cell asks the history where this title was left',
    progressAsked.includes('movie:901'), JSON.stringify(progressAsked));
  console.log('   conversions:', JSON.stringify(remuxes));
  /* This is the whole of "no resume button": the conversion is started AT the
     mark rather than at the top, so there is nothing to press afterwards. */
  check('and starts the conversion there rather than at the top',
    remuxes.length === 1 && remuxes[0].start === LEFT_AT, JSON.stringify(remuxes));

  const seated = await page.evaluate(() => ({
    offset: multiview.cells[0].offset,
    duration: multiview.cells[0].duration,
    key: multiview.cells[0].resumeKey,
    position: Math.round(multiview.cellPosition(multiview.cells[0])),
  }));
  console.log('   cell:', JSON.stringify(seated));
  check('the cell knows where in the film its conversion begins',
    seated.offset === LEFT_AT, JSON.stringify(seated));
  check('and how long the film is', seated.duration === RUNTIME, JSON.stringify(seated));
  /* Position is offset + currentTime, not currentTime. Reading the element
     alone would say the film is at zero, which is what the old resume points
     would have been written as. */
  check('so its position is a point in the film, not in the conversion',
    seated.position === LEFT_AT, JSON.stringify(seated));

  /* ---- 2. there is a scrubber, and it is laid out against the film ------- */
  console.log('\n  the scrubber');
  const bar = await page.evaluate(() => {
    const cell = document.querySelectorAll('.mv-cell')[0];
    const track = cell.querySelector('.mv-track');
    return {
      shown: track && !track.hidden,
      elapsed: cell.querySelector('.mv-track-time')?.textContent || '',
      total: cell.querySelectorAll('.mv-track-time')[1]?.textContent || '',
      played: cell.querySelector('.mv-track-played')?.style.width || '',
      readyLeft: cell.querySelector('.mv-track-ready')?.style.left || '',
      railWidth: Math.round(cell.querySelector('.mv-track-rail').getBoundingClientRect().width),
    };
  });
  console.log('   ', JSON.stringify(bar));
  check('a film in a cell has one', bar.shown === true, JSON.stringify(bar));
  check('reading the position in the film', bar.elapsed === '40:00', bar.elapsed);
  check('against the film\'s own runtime', bar.total === '2:00:00', bar.total);
  check('with the knob a third of the way along',
    Math.abs(parseFloat(bar.played) - (LEFT_AT / RUNTIME) * 100) < 1, bar.played);
  /* The converted span starts where the conversion started, not at the top —
     that difference is what makes a jump backwards cost a restart. */
  check('and the converted band drawn from where the conversion begins',
    Math.abs(parseFloat(bar.readyLeft) - (LEFT_AT / RUNTIME) * 100) < 1, bar.readyLeft);

  /* ---- 3. a jump inside what is converted is free ------------------------ */
  console.log('\n  jumping inside what is already converted');
  const before = remuxes.length;
  await page.evaluate((to) => multiview.seekCell(0, to), LEFT_AT + 30);
  await wait(900);
  const near = await page.evaluate(() => ({
    position: Math.round(multiview.cellPosition(multiview.cells[0])),
    conversions: null,
  }));
  console.log('   ', JSON.stringify({ position: near.position, remuxes: remuxes.length }));
  check('it moves', near.position === LEFT_AT + 30, String(near.position));
  /* Converted already: no reason to spend a provider connection and forty
     seconds of ffmpeg to arrive somewhere the browser can already reach. */
  check('without asking the box for anything', remuxes.length === before,
    `${before} → ${remuxes.length}`);

  /* ---- 4. a jump outside it restarts the conversion at the mark ---------- */
  console.log('\n  jumping somewhere not converted');
  await page.evaluate(() => multiview.seekCell(0, 5400));
  await wait(2500);
  const jumped = remuxes[remuxes.length - 1];
  console.log('   ', JSON.stringify(jumped));
  check('the box is asked to convert from there', jumped && jumped.start === 5400,
    JSON.stringify(jumped));
  /* Named, not unqualified. `replaces` is why the other three cells keep their
     pictures through this — the server used to clear every conversion on the
     box and cut them off. */
  check('naming the conversion it supersedes, so other cells are left alone',
    jumped && jumped.replaces === 'sess-1', JSON.stringify(jumped));
  check('and the outgoing engine is taken down rather than left feeding the element',
    await page.evaluate(() => window.__engine.destroyed) >= 1);
  const after = await page.evaluate(() => ({
    offset: multiview.cells[0].offset,
    position: Math.round(multiview.cellPosition(multiview.cells[0])),
  }));
  console.log('   ', JSON.stringify(after));
  check('the cell now counts from the new mark', after.offset === 5400, JSON.stringify(after));
  check('and reads as being there', after.position === 5400, JSON.stringify(after));

  /* ---- 5. and it leaves a resume point behind --------------------------- */
  /*
   * The other half of the report. A cell never wrote history at all, so a film
   * watched only in multi-view left nothing to come back to — the resume above
   * would have had nothing to read on the second night.
   */
  console.log('\n  what it writes back');
  await page.evaluate(() => multiview.stop(0));
  await wait(600);
  const rows = written.filter((w) => w.key === 'movie:901');
  console.log('   ', JSON.stringify(rows.map((w) => ({ key: w.key, position: w.position, duration: w.duration }))));
  check('the cell reports where it got to', rows.length > 0, JSON.stringify(written));
  check('under the same key the main player uses',
    rows.every((w) => w.key === 'movie:901'), JSON.stringify(rows.map((w) => w.key)));
  check('as a position in the film rather than in the conversion',
    rows[rows.length - 1]?.position === 5400,
    JSON.stringify(rows[rows.length - 1]));
  check('with the runtime, so it can be shown as a part of the whole',
    rows[rows.length - 1]?.duration === RUNTIME, JSON.stringify(rows[rows.length - 1]));

  /* ---- 6. a channel has none of this ------------------------------------ */
  /*
   * A channel is a window on now: there is no timeline to scrub and no
   * position worth writing down. Four cells all reporting watch time at once
   * would tell the suggestions layer this profile watched four things
   * simultaneously, which is not what happened.
   */
  console.log('\n  and a channel is left alone');
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/hls/live/index.m3u8","format":"m3u8"}' }));
  written.length = 0;
  await page.evaluate((chan) => multiview.start(0, chan), LIBRARY.live.items[0]);
  await wait(1600);
  const chan = await page.evaluate(() => ({
    track: document.querySelectorAll('.mv-cell')[0].querySelector('.mv-track').hidden,
    key: multiview.cells[0].resumeKey,
  }));
  console.log('   ', JSON.stringify(chan));
  check('no scrubber on a channel', chan.track === true, JSON.stringify(chan));
  check('and nothing written down for it',
    written.filter((w) => w.kind === 'live').length === 0, JSON.stringify(written));

  /* ---- 7. an episode is remembered as an episode ------------------------- */
  console.log('\n  an episode');
  progressAsked.length = 0;
  remuxes.length = 0;
  await page.evaluate((show) => {
    multiview.start(0, show, { kind: 'series', id: 102, ext: 'mkv',
      label: 'The Long Winter — S1E2', season: '1', episode: 2 });
  }, LIBRARY.series.items[0]);
  await wait(2500);
  console.log('   asked:', JSON.stringify(progressAsked), 'converted:', JSON.stringify(remuxes));
  /* The show's id and the episode's numbers, which is how the main player
     spells it. The stream id alone would make the same episode two different
     titles depending on which player opened it. */
  check('the episode is looked up the way the main player spells it',
    progressAsked.includes('series:77:s1e2'), JSON.stringify(progressAsked));
  check('and it resumes too',
    remuxes.length === 1 && remuxes[0].start === LEFT_AT, JSON.stringify(remuxes));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
