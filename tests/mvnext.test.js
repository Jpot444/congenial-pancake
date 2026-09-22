/**
 * Next episode inside a cell, and multi-view from the archive.
 *
 * "i want a play next episode and resume playing from inside of multiplayer.
 *  Also add the multipleyer button when i am watching something from the
 *  archive"
 *
 * Three things asked for, and one of them was already there — which is worth
 * a suite of its own, because "already there" is a claim and this is how it
 * gets checked rather than asserted in a reply:
 *
 *   NEXT EPISODE was missing. The episode LIST was one press away — a cell's
 *   name is a button that opens it — but finding the next one in it is a hunt
 *   through a sheet laid over a picture while three other cells carry on
 *   without you. The player has offered the next episode by name for months.
 *
 *   RESUMING was already built, both halves of it: a cell reads the saved
 *   position before asking for a conversion (so a provider title is converted
 *   FROM that point rather than seeking afterwards), and it writes history on
 *   a fifteen-second timer while it plays. The keys match the player's —
 *   `series:<id>:s<season>e<episode>` — so a thing started in the player can
 *   be finished in a cell and the other way round. Checked below rather than
 *   taken on trust.
 *
 *   THE ARCHIVE BUTTON was missing, and was missing twice: the control was
 *   hidden for anything that was not a channel, AND its handler read
 *   `currentLiveItem`, which is null for a recording off the drive. Fixing
 *   only the first would have produced a button that did nothing.
 */
const { chromium } = require('./playwright.js');
const { openMultiview } = require('./mv.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNELS = [
  { kind: 'live', id: 1, name: 'US| ESPN HD', categoryId: 'c1' },
  { kind: 'live', id: 2, name: 'US| FOX SPORTS', categoryId: 'c1' },
];
const SHOW = { kind: 'series', id: 55, name: 'The Long Show', categoryId: 's1' };

/* Two seasons, and the second one starts where the first leaves off — because
   "next" across a season boundary is the case a naive list walk gets wrong.
   Season keys are deliberately '1' and '2' as strings, which is what the
   provider sends. */
const EPISODES = {
  1: [
    { id: 901, episode_num: 1, title: 'One', container_extension: 'mkv' },
    { id: 902, episode_num: 2, title: 'Two', container_extension: 'mkv' },
  ],
  2: [
    { id: 903, episode_num: 1, title: 'Three', container_extension: 'mkv' },
  ],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  /* The show's episodes, as the provider answers. Counted, because the button
     has to be right BEFORE anybody opens the sheet — a control that appears
     only after you have gone looking for it is a control for somebody who no
     longer needs it. */
  let seriesAsks = 0;
  await page.route('**/api/xtream*', (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get('action') !== 'get_series_info') return r.continue();
    seriesAsks += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ episodes: EPISODES }) });
  });

  /* Where things were left. 620 seconds into episode two is what the cell
     should be told to start from. */
  const progress = { 'series:55:s1e2': { position: 620, duration: 2400 } };
  await page.route('**/progress*', (r) => {
    const key = new URL(r.request().url()).searchParams.get('key') || '';
    const row = progress[key];
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(row ? { found: true, ...row } : { found: false }) });
  });

  /* What a cell asks for when it holds an episode, and from where. */
  const remuxAsks = [];
  await page.route('**/api/remux*', (r) => {
    const url = new URL(r.request().url());
    remuxAsks.push({ id: url.searchParams.get('id') || '',
      start: url.searchParams.get('start') || url.searchParams.get('seek') || '' });
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/nothing.m3u8', session: 'sess-1',
        sourceDuration: 2400, offset: 0, ready: 2400 }) });
  });
  /* And what an archive cell asks for. `direct` so nothing waits on a
     conversion that is not happening. */
  const archiveAsks = [];
  await page.route('**/api/archive/play*', (r) => {
    archiveAsks.push(new URL(r.request().url()).searchParams.get('path') || '');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ mode: 'direct', url: '/api/nothing.mp4', sourceDuration: 3600 }) });
  });
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/api/nothing","format":"m3u8"}' }));
  /* The history write, which is the half of resuming that does the saving. */
  const wrote = [];
  await page.route('**/history', async (r) => {
    wrote.push(r.request().postData() || '');
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(700);
  await page.evaluate((c) => {
    state.library.live = { categories: [{ id: 'c1', name: 'Sports' }], items: c };
    state.library.series = { categories: [{ id: 's1', name: 'Shows' }], items: [] };
    render();
  }, CHANNELS);
  await openMultiview(page);
  await wait(600);

  /* ---- a cell holding an episode ---------------------------------------- */
  /*
   * Put the show in a cell the way the episode sheet does, then ask the cell
   * what comes next. `armNext` fetches the episode list itself rather than
   * waiting to be asked, which is what makes the button right before anybody
   * goes looking for it.
   */
  console.log('\n  a cell playing episode two of season one');
  seriesAsks = 0;
  const armed = await page.evaluate(async (show) => {
    const cell = multiview.cells[0];
    cell.item = show;
    cell.override = { kind: 'series', id: 902, ext: 'mkv',
      label: `${show.name} — S1E2`, season: '1', episode: 2 };
    cell.vod = true;
    await multiview.armNext(0);
    return {
      hidden: cell.nextBtn.hidden,
      title: cell.nextBtn.title,
      next: cell.next && { season: cell.next.season, ep: cell.next.ep.episode_num },
    };
  }, SHOW);
  console.log('   ', JSON.stringify(armed), `— asked the provider ${seriesAsks}x`);
  check('the next-episode button is on the bar', armed.hidden === false,
    String(armed.hidden));
  check('and it names which episode, so it can be trusted before it is pressed',
    /S2E1/.test(armed.title || ''), armed.title);
  /* Across the season boundary, which is the case a naive walk gets wrong —
     and which sorting season keys as strings gets wrong differently. */
  check('crossing into the next season rather than stopping at the end of this one',
    armed.next && String(armed.next.season) === '2' && Number(armed.next.ep) === 1,
    JSON.stringify(armed.next));
  check('and it found that out for itself rather than waiting to be asked',
    seriesAsks === 1, `${seriesAsks} asks`);

  /* ---- pressing it ------------------------------------------------------ */
  /*
   * What `start` is handed is the whole claim: the same override shape the
   * episode sheet builds, so a cell advanced by this button is in exactly the
   * state it would be in had somebody picked the episode by hand.
   */
  console.log('\n  and pressing it starts that episode');
  const started = await page.evaluate(async () => {
    const seen = [];
    const real = multiview.start;
    multiview.start = (index, item, override) => {
      seen.push({ index, item: item && item.name, override });
      return Promise.resolve();
    };
    multiview.playNext(0);
    multiview.start = real;
    return seen;
  });
  console.log('   ', JSON.stringify(started));
  check('in the same cell', started.length === 1 && started[0].index === 0,
    JSON.stringify(started));
  check('as an episode of the same show',
    started[0] && started[0].item === SHOW.name
    && started[0].override.kind === 'series', JSON.stringify(started[0]));
  check('the one the button named', started[0]
    && Number(started[0].override.id) === 903
    && String(started[0].override.season) === '2'
    && Number(started[0].override.episode) === 1, JSON.stringify(started[0]?.override));
  /* The label is what the cell's name shows, and a cell whose name disagreed
     with its picture is the sort of thing nobody notices until it matters. */
  check('and labelled the way the sheet labels it',
    /S2E1/.test(started[0]?.override?.label || ''), started[0]?.override?.label);

  /* ---- and the last episode offers nothing ----------------------------- */
  /*
   * A button that is always there is a button that lies at the end of a show.
   */
  console.log('\n  but the last episode of the last season offers nothing');
  const last = await page.evaluate(async (show) => {
    const cell = multiview.cells[0];
    cell.item = show;
    cell.override = { kind: 'series', id: 903, ext: 'mkv',
      label: `${show.name} — S2E1`, season: '2', episode: 1 };
    await multiview.armNext(0);
    return { hidden: cell.nextBtn.hidden, next: cell.next };
  }, SHOW);
  check('no button', last.hidden === true && last.next === null, JSON.stringify(last));

  /* ---- nor does a channel --------------------------------------------- */
  /*
   * Three of the four cells are usually channels, and a dead control on each
   * of them is worse than no control at all.
   */
  console.log('\n  and a channel has no next episode to offer');
  const chan = await page.evaluate(async (c) => {
    const cell = multiview.cells[0];
    cell.item = c;
    cell.override = null;
    cell.vod = false;
    await multiview.armNext(0);
    return { hidden: cell.nextBtn.hidden, next: cell.next };
  }, CHANNELS[0]);
  check('no button there either', chan.hidden === true && chan.next === null,
    JSON.stringify(chan));

  /* ---- resuming, which was already built ------------------------------- */
  /*
   * Both halves, and they have to be the same key or they are two features
   * that look like one. The position is read BEFORE the conversion is asked
   * for, because a provider title is converted from a point — starting at the
   * top and seeking afterwards spends a whole restart of ffmpeg arriving
   * where it could have begun.
   */
  console.log('\n  and a cell still resumes where the title was left');
  const keys = await page.evaluate((show) => ({
    cell: mvResumeKey(show, { season: '1', episode: 2 }),
    player: resumeKeyFor(show, { episode_num: 2 }, '1'),
  }), SHOW);
  console.log('   ', JSON.stringify(keys));
  check('a cell and the player agree on what to call the position',
    keys.cell === keys.player && keys.cell === 'series:55:s1e2', JSON.stringify(keys));

  remuxAsks.length = 0;
  wrote.length = 0;
  await page.evaluate(async (show) => {
    await multiview.start(0, show, { kind: 'series', id: 902, ext: 'mkv',
      label: `${show.name} — S1E2`, season: '1', episode: 2 });
  }, SHOW);
  await wait(900);
  const resumed = await page.evaluate(() => ({
    key: multiview.cells[0].resumeKey,
    histKey: multiview.cells[0].histTarget && multiview.cells[0].histTarget.key,
    timer: Boolean(multiview.cells[0].histTimer),
  }));
  console.log('   ', JSON.stringify(resumed), JSON.stringify(remuxAsks));
  check('the cell knows which position is its', resumed.key === 'series:55:s1e2',
    resumed.key);
  /* The saving half. Without it a cell reads a resume point it never writes,
     so watching in a cell leaves nothing to come back to. */
  check('and writes history under the same key as it plays',
    resumed.histKey === 'series:55:s1e2' && resumed.timer === true,
    JSON.stringify(resumed));
  check('and it really posted one rather than only arming a timer',
    wrote.some((b) => /series:55:s1e2/.test(b)), JSON.stringify(wrote).slice(0, 200));

  /* ---- multi-view from the archive ------------------------------------- */
  /*
   * Missing twice: hidden for anything that was not a channel, and its
   * handler read `currentLiveItem`, which is null for a recording off the
   * drive. Fixing only the first gives a button that does nothing.
   */
  console.log('\n  and the button is there when watching off the drive');
  await page.evaluate(() => multiview.close && multiview.close());
  await wait(400);
  const shown = await page.evaluate(async () => {
    const item = { kind: 'movie', id: 'arc-1', name: 'A Game On The Drive',
      archivePath: 'Sports/game.mkv', localOnly: true };
    await openPlayer(item);
    await new Promise((r) => setTimeout(r, 900));
    return {
      button: !document.querySelector('#cinemaMultiview').hidden,
      currentLive: currentLiveItem,
      cinema: cinemaItem && cinemaItem.name,
    };
  });
  console.log('   ', JSON.stringify(shown));
  check('the multi-view button is offered', shown.button === true, String(shown.button));
  /* The second half. This is null for an archive item, which is what made the
     button useless even when it was shown. */
  check('and the player knows what it is showing, which currentLiveItem does not',
    shown.currentLive === null && /A Game On The Drive/.test(shown.cinema || ''),
    JSON.stringify(shown));

  archiveAsks.length = 0;
  await page.evaluate(() => document.querySelector('#cinemaMultiview').click());
  await wait(1200);
  const landed = await page.evaluate(() => ({
    open: !document.querySelector('#mvGrid').closest('.mv-wrap, #multiview')?.hidden,
    filled: multiview.cells.filter((c) => c && c.item).map((c) => c.item.name),
    paths: multiview.cells.filter((c) => c && c.item).map((c) => c.item.archivePath || ''),
  }));
  console.log('   ', JSON.stringify(landed), JSON.stringify(archiveAsks));
  check('pressing it puts the recording in a cell',
    landed.filled.some((n) => /A Game On The Drive/.test(n)), JSON.stringify(landed));
  check('and the cell asked the drive for it, so it is really playing from there',
    archiveAsks.some((p) => /game\.mkv/.test(p)), JSON.stringify(archiveAsks));

  /* ---- and still not for a provider film ------------------------------- */
  /*
   * Only one conversion runs at a time — start() says so and stops the other
   * — so a button that can only ever replace what is already playing is a
   * button that does nothing twice. The archive is the exception because a
   * direct-playing file on the drive is not a conversion.
   */
  console.log('\n  but not for a provider film, which has nothing to sit beside');
  const film = await page.evaluate(async () => {
    await openPlayer({ kind: 'movie', id: 77, name: 'A Provider Film' });
    await new Promise((r) => setTimeout(r, 700));
    return !document.querySelector('#cinemaMultiview').hidden;
  });
  check('no button', film === false, String(film));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
