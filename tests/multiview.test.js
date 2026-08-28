/**
 * Multi-view.
 *
 * The feature exists to answer one question — what happens when this account
 * is asked for more than one live stream at once — so most of what is checked
 * here is that the answer is *visible*: which cell was refused, in words, on
 * the cell itself. A grid that failed silently would be worse than no grid.
 *
 * The provider is stubbed to behave like the real one: the first stream is
 * handed over, the rest are refused while it is running.
 */
const { chromium } = require('./playwright.js');
const { openMultiview, multiviewOffered } = require('./mv.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const SHOTS = __dirname + '/shots';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ident = (t) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220">`
  + `<rect width="400" height="220" fill="#334"/><text x="200" y="120" fill="#fff"`
  + ` font-size="34" text-anchor="middle" font-family="sans-serif">${t}</text></svg>`);

const CHANNELS = [
  { kind: 'live', id: 1, name: 'US| NFL PPV 01', logo: ident('NFL'), categoryId: 'c1' },
  { kind: 'live', id: 2, name: 'US| NBC East', logo: ident('NBC'), categoryId: 'c1' },
  { kind: 'live', id: 3, name: 'US| CBS West', logo: ident('CBS'), categoryId: 'c1' },
  { kind: 'live', id: 4, name: 'US| FOX Sports', logo: ident('FOX'), categoryId: 'c1' },
  { kind: 'live', id: 5, name: 'UK| Shopping', logo: ident('SHOP'), categoryId: 'c2' },
];
const CATEGORIES = [{ id: 'c1', name: 'Sports' }, { id: 'c2', name: 'Shopping' }];

// Films and shows, so a cell can be asked for something that is a conversion
// rather than a channel.
const LIBRARY = {
  movies: {
    categories: [{ id: 'm1', name: 'Films' }],
    items: [
      { kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mkv', categoryId: 'm1' },
      { kind: 'movie', id: 902, name: 'Another Film', logo: '', ext: 'mkv', categoryId: 'm1' },
    ],
  },
  series: {
    categories: [{ id: 's1', name: 'Shows' }],
    items: [{ kind: 'series', id: 77, name: 'A Show', logo: '', categoryId: 's1' }],
  },
};
const EPISODES = {
  1: [
    { id: 101, episode_num: 1, title: 'Pilot', container_extension: 'mkv' },
    { id: 102, episode_num: 2, title: 'Second', container_extension: 'mkv' },
  ],
  2: [{ id: 201, episode_num: 1, title: 'Season Two', container_extension: 'mkv' }],
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  // The one-connection provider, modelled honestly: whoever asks first gets
  // it, everyone else is turned away until it is given back.
  let connectionHeld = false;
  let playCalls = 0;
  let refuseOthers = true;
  // HLS mode: every channel is served, because none of them holds a
  // connection open. This is what the real provider turned out to do.
  let hlsForAll = false;
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/api/play*', (r) => {
    // The glob also catches /api/playlist, which is the M3U library load.
    // Answering that with a stream payload took the connection before
    // multi-view ever asked for one.
    if (new URL(r.request().url()).pathname !== '/api/play') return r.continue();
    playCalls += 1;
    if (hlsForAll) {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ url: '/api/fake-stream', format: 'm3u8' }) });
    }
    if (refuseOthers && connectionHeld) {
      return r.fulfill({ status: 503, contentType: 'application/json',
        body: '{"error":"All connections for this account are in use."}' });
    }
    connectionHeld = true;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) });
  });
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_series_info') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {}, episodes: EPISODES }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // The conversion, stubbed to bank instantly. What is under test is the cell
  // waiting on it and letting go of it, not ffmpeg.
  let remuxes = 0;
  await page.route('**/api/remux*', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/remux/status') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"seconds":45,"complete":true,"target":45,"failed":false,"error":""}' });
    }
    if (path === '/api/remux/stop') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"stopped":true}' });
    }
    remuxes += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ session: `sess-${remuxes}`, url: '/api/fake-stream', prebuffer: 45 }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  const seedLive = async () => {
    await page.evaluate((chans) => {
      state.library.live = { categories: chans.cats, items: chans.items };
      render();
    }, { items: CHANNELS, cats: CATEGORIES });
  };
  await page.evaluate(() => { location.hash = '#/live'; });
  await wait(600);
  await seedLive();

  // --- on for everyone ------------------------------------------------------
  //
  // It lived behind a beta switch while the question it was built to answer
  // was still open. It answered it, so the switch went — and a feature that is
  // shipped has to be reachable without one.
  console.log('\n  on for everyone');
  /* Asked of whichever control the page is showing. On Live TV the desktop
     layer draws it in the category bar and hides the original, so a check
     pinned to one of the two is testing where the button lives rather than
     whether the feature is offered. */
  check('Live TV has a multi-view button, with nothing to turn on first',
    await multiviewOffered(page));
  check('and no beta switch left anywhere',
    (await page.locator('.health-beta').count()) === 0);
  check('nor a beta object for anything to hang off',
    (await page.evaluate(() => typeof beta)) === 'undefined');

  await page.evaluate(() => { location.hash = '#/movies'; render(); });
  await wait(400);
  check('the button does not follow you to Movies, where it would mean nothing',
    (await multiviewOffered(page)) === false);
  await page.evaluate(() => { location.hash = '#/live'; render(); });
  await wait(800);
  // Leaving Live TV and coming back reloads the tab from the server, which
  // throws the stub away. Put it back before the picker is asked for it.
  await seedLive();

  // --- the grid ------------------------------------------------------------
  console.log('\n  four cells');
  await openMultiview(page);
  await wait(500);
  check('the grid opens', await page.locator('#multiview').isVisible());
  const cells = await page.locator('#mvGrid .mv-cell').count();
  check('with four cells', cells === 4, String(cells));
  check('all of them empty', (await page.locator('.mv-empty:visible').count()) === 4);
  check('and none of them wearing an empty status strip',
    (await page.locator('.mv-status:visible').count()) === 0);

  const layout = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.mv-cell')].map((c) => c.getBoundingClientRect());
    return {
      rows: new Set(boxes.map((b) => Math.round(b.top))).size,
      cols: new Set(boxes.map((b) => Math.round(b.left))).size,
      onScreen: boxes.every((b) => b.right <= window.innerWidth + 1
        && b.bottom <= window.innerHeight + 1 && b.width > 100 && b.height > 100),
    };
  });
  console.log('   layout:', JSON.stringify(layout));
  check('laid out two by two', layout.rows === 2 && layout.cols === 2, JSON.stringify(layout));
  check('and all four fit the screen', layout.onScreen, JSON.stringify(layout));

  // --- the first channel plays --------------------------------------------
  console.log('\n  the first channel');
  await page.locator('.mv-empty:visible').first().click();
  await wait(400);
  check('the picker opens', await page.locator('#mvPicker').isVisible());

  // Categories first, as cards — the same tile the Live TV page uses, from the
  // same function, because "looks like Live TV" is a claim a copy cannot keep.
  const cats = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#mvResults .cat-card')]
      .map((c) => c.querySelector('.card-title').textContent),
    subs: [...document.querySelectorAll('#mvResults .cat-card .card-sub')]
      .map((c) => c.textContent),
    withArt: document.querySelectorAll('#mvResults .cat-card .card-art img').length,
    // The library grid's own classes, so the tiles size themselves the same.
    gridClass: document.querySelector('#mvResults').className,
    // No bin: hiding a category from inside here would re-render the page
    // underneath the sheet, which is not what pressing it there means.
    bins: document.querySelectorAll('#mvResults .card-bin').length,
    channelsShowing: document.querySelectorAll('#mvResults .card:not(.cat-card)').length,
  }));
  console.log('   categories:', JSON.stringify(cats));
  check('it opens on categories, not channels',
    cats.cards.length === 2 && /Sports/.test(cats.cards[0]), JSON.stringify(cats.cards));
  check('as cards with artwork, the way Live TV shows them',
    cats.withArt === 2, `${cats.withArt} with art`);
  check('laid out on the library grid itself',
    /\bis-cats\b/.test(cats.gridClass), cats.gridClass);
  check('each saying how many are in it', /4 channels/.test(cats.subs[0]), cats.subs[0]);
  check('with no bin to re-render the page behind the sheet', cats.bins === 0,
    `${cats.bins} bins`);
  check('and no channels listed yet', cats.channelsShowing === 0,
    String(cats.channelsShowing));

  await page.locator('#mvResults .cat-card').first().click();
  await wait(400);
  const inside = await page.evaluate(() => ({
    tiles: document.querySelectorAll('#mvResults .card:not(.cat-card)').length,
    gridClass: document.querySelector('#mvResults').className,
    title: document.querySelector('#mvPickerTitle').textContent,
    back: document.querySelector('#mvPickerBackLabel').textContent,
  }));
  console.log('   inside:', JSON.stringify(inside));
  check('opening one shows its channels as tiles', inside.tiles === 4,
    String(inside.tiles));
  check('on the live grid, which sizes them for idents rather than posters',
    /\bis-live\b/.test(inside.gridClass), inside.gridClass);
  check('the header says where you are', inside.title === 'Sports', inside.title);
  check('and the way out goes up a level, not all the way out',
    inside.back === 'Back', inside.back);

  await page.locator('#mvPickerBack').click();
  await wait(400);
  check('which returns to the categories',
    (await page.locator('#mvResults .cat-card').count()) === 2);

  // Typing cuts across every category, not just the one you are inside.
  await page.locator('#mvSearch').fill('NBC');
  await wait(400);
  const hits = await page.locator('#mvResults .card:not(.cat-card)').count();
  check('search narrows across all categories', hits === 1, `${hits} results`);
  await page.locator('#mvResults .card:not(.cat-card)').first().click();
  await wait(2500);

  const first = await page.evaluate(() => {
    const cell = multiview.cells[0];
    return {
      name: cell.name.textContent,
      playing: !cell.video.paused && cell.video.currentTime > 0,
      muted: cell.video.muted,
      noteShown: !cell.note.hidden,
      note: cell.note.textContent,
      emptyGone: cell.empty.hidden,
      note: cell.note.textContent,
    };
  });
  console.log('  ', JSON.stringify(first));
  check('it is the channel that was picked', first.name === 'US| NBC East', first.name);
  check('and it is really playing', first.playing, JSON.stringify(first));
  check('the "add" prompt is gone from that cell', first.emptyGone);
  check('it starts silent — four channels talking at once is not a feature',
    first.muted);
  check('and says nothing once it is running', !first.noteShown, JSON.stringify(first));

  // --- the second is refused, and says so ---------------------------------
  console.log('\n  the second channel, with the connection already taken');
  await page.locator('.mv-empty:visible').first().click();
  await wait(300);
  await page.locator('#mvSearch').fill('CBS');
  await wait(300);
  await page.locator('#mvResults .card:not(.cat-card)').first().click();
  await wait(2500);

  const second = await page.evaluate(() => {
    const cell = multiview.cells[1];
    return {
      name: cell.name.textContent,
      note: cell.note.hidden ? '' : cell.note.textContent,
      stillPlaying: !multiview.cells[0].video.paused,
      // The running tally that used to live here was a readout for the
      // experiment, and the experiment is over.
      header: document.querySelector('#mvNote'),
    };
  });
  console.log('  ', JSON.stringify(second));
  check('the refusal is shown on the cell itself', second.note.length > 0, JSON.stringify(second));
  check('in the provider\'s own words rather than a stack trace',
    /connections for this account are in use/i.test(second.note), second.note);
  check('the cell still names what was asked for', second.name === 'US| CBS West', second.name);
  check('and no tally in the header — the cell says it, which is where it happened',
    second.header === null, JSON.stringify(second.header));
  check('and the one that has the connection keeps playing', second.stillPlaying);
  await page.screenshot({ path: SHOTS + '/multiview.png' });

  // --- one cell at a time may make a noise --------------------------------
  console.log('\n  sound');
  refuseOthers = false;   // let a second one through, to test the audio rule
  await page.evaluate(() => multiview.start(2, { kind: 'live', id: 4, name: 'US| FOX Sports' }));
  await wait(2000);
  await page.evaluate(() => multiview.listen(0));
  await wait(300);
  let sound = await page.evaluate(() => multiview.cells.map((c) => c.video.muted));
  check('unmuting one leaves the rest silent',
    sound[0] === false && sound.slice(1).every(Boolean), JSON.stringify(sound));
  await page.evaluate(() => multiview.listen(2));
  await wait(300);
  sound = await page.evaluate(() => multiview.cells.map((c) => c.video.muted));
  check('and the sound moves rather than stacking',
    sound[2] === false && sound[0] === true, JSON.stringify(sound));
  await page.evaluate(() => multiview.listen(2));
  await wait(300);
  sound = await page.evaluate(() => multiview.cells.map((c) => c.video.muted));
  check('pressing it again goes back to silence', sound.every(Boolean), JSON.stringify(sound));

  // --- four HLS channels at once ------------------------------------------
  //
  // Which is what the real box does. HLS fetches a segment at a time and holds
  // no connection open, so the account's one-connection limit never applies —
  // the opposite of what this feature was built expecting.
  console.log('\n  four at once, the way HLS behaves');
  hlsForAll = true;
  await page.evaluate(() => multiview.stopAll());
  await wait(400);
  for (let i = 0; i < 4; i += 1) {
    await page.evaluate(
      ([n, chan]) => multiview.start(n, chan),
      [i, { kind: 'live', id: i + 1, name: `Channel ${i + 1}` }],
    );
  }
  await wait(3000);
  const four = await page.evaluate(() => ({
    running: multiview.cells.filter((c) => c.ok).length,
    tags: multiview.cells.map((c) => c.tag.textContent),
    hints: multiview.cells.map((c) => c.tag.title),
    notes: multiview.cells.filter((c) => !c.note.hidden).map((c) => c.note.textContent),
  }));
  console.log('  ', JSON.stringify(four));
  check('all four run when nothing holds a connection',
    four.running === 4, JSON.stringify(four));
  check('and each cell says how it is being delivered',
    four.tags.every((t) => t === 'M3U8'), JSON.stringify(four.tags));
  check('with no cell left complaining', four.notes.length === 0, JSON.stringify(four.notes));
  check('and the tag explains why four of these are fine',
    four.hints.every((h) => /holds no connection open/.test(h)), JSON.stringify(four.hints));
  await page.screenshot({ path: SHOTS + '/multiview-four.png' });

  // MPEG-TS is the case where the limit does bite. The header used to say so;
  // now the cell holding one does, which is the cell it is about.
  await page.evaluate(() => {
    multiview.cells.forEach((c) => { c.format = 'ts'; });
    multiview.paint();
  });
  const tsHint = await page.evaluate(() => multiview.cells[0].tag.title);
  check('an MPEG-TS cell says it is the one that contends',
    /MPEG-TS/.test(tsHint) && /will fight/.test(tsHint), tsHint);
  check('and is flagged on the cell', (await page.locator('.mv-tag.is-held').count()) === 4);
  await page.evaluate(() => multiview.stopAll());
  await wait(300);
  hlsForAll = false;

  // --- transport: pause, play, and ten seconds either way -----------------
  console.log('\n  the transport');
  hlsForAll = true;
  await page.evaluate(() => multiview.stopAll());
  await page.evaluate(() => multiview.start(0, { kind: 'live', id: 1, name: 'Channel 1' }));
  await wait(2500);

  const beforePause = await page.evaluate(() => ({
    paused: multiview.cells[0].video.paused,
    label: multiview.cells[0].play.textContent,
  }));
  check('a playing cell offers pause', !beforePause.paused && beforePause.label === '❚❚',
    JSON.stringify(beforePause));

  await page.evaluate(() => multiview.toggle(0));
  await wait(400);
  const paused = await page.evaluate(() => ({
    paused: multiview.cells[0].video.paused,
    label: multiview.cells[0].play.textContent,
    others: multiview.cells.slice(1).filter((c) => c.item && !c.video.paused).length,
  }));
  check('pressing it pauses that cell', paused.paused, JSON.stringify(paused));
  check('and the button turns into play', paused.label === '▶', paused.label);

  await page.evaluate(() => multiview.toggle(0));
  await wait(600);
  check('pressing it again resumes',
    (await page.evaluate(() => multiview.cells[0].video.paused)) === false);

  // Skipping is clamped to what the element says is seekable. Live is not a
  // film: back is limited to what is still buffered and forward stops at the
  // edge, so what is checked is that it lands somewhere legal.
  const skipped = await page.evaluate(async () => {
    const v = multiview.cells[0].video;
    const at = v.currentTime;
    multiview.skip(0, -10);
    const back = v.currentTime;
    multiview.skip(0, 10);
    const fwd = v.currentTime;
    const legal = (t) => v.seekable.length
      && t >= v.seekable.start(0) - 0.01
      && t <= v.seekable.end(v.seekable.length - 1) + 0.01;
    return { at, back, fwd, legalBack: legal(back), legalFwd: legal(fwd) };
  });
  console.log('   skip:', JSON.stringify(skipped));
  check('back ten lands inside what is seekable', skipped.legalBack, JSON.stringify(skipped));
  check('forward ten does too', skipped.legalFwd, JSON.stringify(skipped));
  check('and it actually moved rather than doing nothing',
    skipped.back !== skipped.at || skipped.fwd !== skipped.back, JSON.stringify(skipped));

  // A cell with nothing in it has nothing to skip; pressing must not throw.
  await page.evaluate(() => { multiview.skip(3, -10); multiview.toggle(3); });
  check('an empty cell ignores the transport rather than throwing',
    (await page.evaluate(() => multiview.cells[3].item)) === null);

  // --- refreshing one cell -------------------------------------------------
  //
  // The recovery a cell did not have. A failed cell does not retry by itself,
  // so until now the only way back was stopping it and finding the channel in
  // the picker again.
  console.log('\n  the refresh button');
  hlsForAll = true;
  await page.evaluate(() => multiview.stopAll());
  await page.evaluate(() => {
    [0, 1].forEach((i) => multiview.start(i, { kind: 'live', id: i + 1, name: `Channel ${i + 1}` }));
  });
  await wait(2500);

  const buttons = await page.evaluate(() => ({
    onFilled: [...document.querySelectorAll('.mv-cell')]
      .filter((c) => !c.hidden && !c.querySelector('.mv-bar').hidden)
      .every((c) => Boolean(c.querySelector('.mv-again'))),
    hiddenOnEmpty: [...document.querySelectorAll('.mv-cell')]
      .filter((c) => !c.hidden && c.querySelector('.mv-bar').hidden).length,
    atBottom: (() => {
      const cell = document.querySelector('.mv-cell:not([hidden])');
      const bar = cell.querySelector('.mv-bar').getBoundingClientRect();
      const box = cell.getBoundingClientRect();
      return Math.abs(bar.bottom - box.bottom) < 2;
    })(),
  }));
  console.log('  ', JSON.stringify(buttons));
  check('every running cell has one', buttons.onFilled, JSON.stringify(buttons));
  check('at the bottom of its cell, with the rest of that cell\'s controls',
    buttons.atBottom, JSON.stringify(buttons));
  check('and an empty cell has no bar to put it on',
    buttons.hiddenOnEmpty === 2, String(buttons.hiddenOnEmpty));

  const askedBefore = playCalls;
  await page.evaluate(() => multiview.cells[0].box.querySelector('.mv-again').click());
  await wait(2500);
  const refreshed = await page.evaluate(() => ({
    asked: null,
    name: multiview.cells[0].name.textContent,
    playing: multiview.cells[0].ok,
    otherStillPlaying: multiview.cells[1].ok,
    otherName: multiview.cells[1].name.textContent,
  }));
  console.log('  ', JSON.stringify({ ...refreshed, calls: playCalls - askedBefore }));
  check('pressing it asks the provider again',
    playCalls - askedBefore === 1, `${playCalls - askedBefore} calls`);
  check('the cell keeps the channel it was on',
    refreshed.name === 'Channel 1', refreshed.name);
  check('and comes back playing', refreshed.playing, JSON.stringify(refreshed));
  check('the cell beside it is untouched',
    refreshed.otherStillPlaying && refreshed.otherName === 'Channel 2',
    JSON.stringify(refreshed));

  // What it is really for: a cell that was turned away.
  console.log('\n  refreshing a cell that was refused');
  hlsForAll = false;
  refuseOthers = true;
  connectionHeld = true;      // the provider is busy when this one asks
  await page.evaluate(() => multiview.start(2, { kind: 'live', id: 3, name: 'Channel 3' }));
  await wait(2500);
  const refused = await page.evaluate(() => ({
    note: multiview.cells[2].note.hidden ? '' : multiview.cells[2].note.textContent,
    hasButton: Boolean(multiview.cells[2].box.querySelector('.mv-again')),
    barUp: !multiview.cells[2].bar.hidden,
  }));
  console.log('  ', JSON.stringify(refused));
  check('a refused cell still says so', /in use/.test(refused.note), refused.note);
  check('and still offers the button, which is where it is most wanted',
    refused.hasButton && refused.barUp, JSON.stringify(refused));

  connectionHeld = false;     // whatever had it has let go
  await page.evaluate(() => multiview.cells[2].box.querySelector('.mv-again').click());
  await wait(2500);
  const recovered = await page.evaluate(() => ({
    playing: multiview.cells[2].ok,
    note: multiview.cells[2].note.hidden ? '' : multiview.cells[2].note.textContent,
  }));
  console.log('  ', JSON.stringify(recovered));
  check('and once the connection is free it comes good',
    recovered.playing && recovered.note === '', JSON.stringify(recovered));

  // Sound is a property of the cell, not of the stream inside it.
  hlsForAll = true;
  await page.evaluate(() => multiview.listen(0));
  await wait(300);
  await page.evaluate(() => multiview.cells[0].box.querySelector('.mv-again').click());
  await wait(2500);
  const sounded = await page.evaluate(() => multiview.cells.map((c) => c.video.muted));
  check('a cell you were listening to is still the one you hear afterwards',
    sounded[0] === false && sounded.slice(1).every(Boolean), JSON.stringify(sounded));

  await page.evaluate(() => multiview.stopAll());
  await wait(300);

  // --- a film or an episode in a cell ---------------------------------------
  //
  // Different from a channel in the one way that matters: it is a CONVERSION.
  // ffmpeg on the box, one continuous read from the provider, and the server
  // runs exactly one at a time — startRemux kills whatever was running before
  // it spawns. So the rule under test is that a second one takes the first
  // one's place deliberately rather than by surprise.
  console.log('\n  a film in one of the boxes');
  hlsForAll = true;
  await page.evaluate(() => multiview.stopAll());
  await page.evaluate((lib) => {
    state.library.movies = lib.movies;
    state.library.series = lib.series;
    state.seriesCache = {};
    state.downloads = { items: [], active: null, queued: 0 };
  }, LIBRARY);
  await page.evaluate(() => multiview.pick(0));
  await wait(400);

  const sources = await page.evaluate(() =>
    [...document.querySelectorAll('#mvSourceSeg button')].map((b) => b.dataset.source));
  // Three libraries, two shortcuts, and the drive — which is owner-only, so
  // it is in the markup for everybody and shown to one profile.
  // searchall.test.js drives the drive itself.
  check('the picker offers the three libraries, the two shortcuts and the drive',
    sources.join() === 'live,movies,series,favorites,recent,archive',
    JSON.stringify(sources));

  await page.evaluate(() => multiview.setSource('movies'));
  await wait(400);
  const films = await page.evaluate(() => ({
    cats: [...document.querySelectorAll('#mvResults .cat-card .card-title')]
      .map((c) => c.textContent),
    on: document.querySelector('#mvSourceSeg button.is-on')?.dataset.source,
  }));
  check('switching to Movies shows film categories',
    films.cats.length === 1 && films.cats[0] === 'Films', JSON.stringify(films));
  check('and the switch says which one you are on', films.on === 'movies', String(films.on));

  await page.locator('#mvResults .cat-card').first().click();
  await wait(400);
  await page.locator('#mvResults .card:not(.cat-card)').first().click();
  await wait(4000);

  const film = await page.evaluate(() => ({
    name: multiview.cells[0].name.textContent,
    vod: multiview.cells[0].vod,
    remux: Boolean(multiview.cells[0].remux),
    playing: multiview.cells[0].ok,
    note: multiview.cells[0].note.hidden ? '' : multiview.cells[0].note.textContent,
  }));
  console.log('  ', JSON.stringify(film));
  check('a film plays in the cell', film.playing, JSON.stringify(film));
  check('named on its bar', film.name === 'A Film', film.name);
  check('marked as a conversion rather than a channel', film.vod, JSON.stringify(film));
  check('holding a conversion session', film.remux, JSON.stringify(film));
  check('and saying nothing once it is running', film.note === '', film.note);
  await page.screenshot({ path: SHOTS + '/multiview-film.png' });

  // Channels alongside it are untouched — they are not conversions.
  await page.evaluate(() =>
    multiview.start(1, { kind: 'live', id: 2, name: 'US| NBC East' }));
  await wait(2500);
  const both = await page.evaluate(() => ({
    filmStill: multiview.cells[0].ok && multiview.cells[0].vod,
    chan: multiview.cells[1].ok,
  }));
  check('a channel can sit beside it', both.chan && both.filmStill, JSON.stringify(both));

  // A SECOND conversion cannot. The server runs one, so the first has to go —
  // and the point is that it is said out loud rather than found out.
  const displaced = await page.evaluate(async () => {
    const said = [];
    const realToast = window.toast;
    window.toast = (m) => { said.push(m); };
    await multiview.start(2, { kind: 'movie', id: 902, name: 'Another Film', ext: 'mkv' });
    window.toast = realToast;
    return {
      said,
      first: multiview.cells[0].item,
      third: multiview.cells[2].name.textContent,
      conversions: multiview.cells.filter((c) => c.vod).length,
    };
  });
  await wait(3000);
  console.log('  ', JSON.stringify(displaced));
  check('a second film takes the first one\'s place', displaced.conversions === 1,
    JSON.stringify(displaced));
  check('the first is stopped rather than left running unseen',
    displaced.first === null, JSON.stringify(displaced));
  check('and it says so instead of leaving you to work it out',
    displaced.said.some((m) => /one film or episode at a time/i.test(m)),
    JSON.stringify(displaced.said));

  // Stopping it has to let the box stop converting, not just blank the cell.
  const releases = await page.evaluate(async () => {
    const hits = [];
    const realFetch = window.fetch;
    window.fetch = (u, ...rest) => { hits.push(String(u)); return realFetch(u, ...rest); };
    multiview.stop(2);
    window.fetch = realFetch;
    return hits;
  });
  check('stopping a film stops the conversion on the box',
    releases.some((u) => /\/api\/remux\/stop/.test(u)), JSON.stringify(releases));

  // --- an episode ----------------------------------------------------------
  console.log('\n  an episode in a box');
  await page.evaluate(() => multiview.stopAll());
  await page.evaluate(() => multiview.pick(0));
  await wait(300);
  await page.evaluate(() => multiview.setSource('series'));
  await wait(400);
  await page.locator('#mvResults .cat-card').first().click();
  await wait(400);
  await page.locator('#mvResults .card:not(.cat-card)').first().click();
  await wait(1200);
  const eps = await page.evaluate(() => ({
    title: document.querySelector('#mvPickerTitle').textContent,
    sub: document.querySelector('#mvPickerSub').textContent,
    tiles: [...document.querySelectorAll('#mvResults .card .card-art .fallback')]
      .map((f) => f.textContent),
  }));
  console.log('  ', JSON.stringify(eps));
  check('a show opens its episodes rather than trying to play the show',
    eps.tiles.length === 3, JSON.stringify(eps.tiles));
  check('labelled by season and episode',
    eps.tiles[0] === 'S1 E1' && eps.tiles[2] === 'S2 E1', JSON.stringify(eps.tiles));
  check('with the show named above them', eps.title === 'A Show', eps.title);
  check('and how many there are', /3 episodes/.test(eps.sub), eps.sub);

  await page.locator('#mvResults .card').nth(1).click();
  await wait(4000);
  const ep = await page.evaluate(() => ({
    name: multiview.cells[0].name.textContent,
    playing: multiview.cells[0].ok,
    vod: multiview.cells[0].vod,
  }));
  console.log('  ', JSON.stringify(ep));
  check('the episode plays', ep.playing && ep.vod, JSON.stringify(ep));
  check('and the bar names the episode, not just the show',
    ep.name === 'A Show — S1E2', ep.name);

  // Back steps up a level at a time rather than dropping you out.
  await page.evaluate(() => multiview.pick(1));
  await wait(300);
  await page.evaluate(() => multiview.setSource('series'));
  await wait(300);
  await page.locator('#mvResults .cat-card').first().click();
  await wait(300);
  await page.locator('#mvResults .card:not(.cat-card)').first().click();
  await wait(1200);
  await page.locator('#mvPickerBack').click();
  await wait(400);
  const up1 = await page.evaluate(() => document.querySelector('#mvPickerTitle').textContent);
  await page.locator('#mvPickerBack').click();
  await wait(400);
  const up2 = await page.evaluate(() => ({
    cats: document.querySelectorAll('#mvResults .cat-card').length,
    open: !document.querySelector('#mvPicker').hidden,
  }));
  await page.locator('#mvPickerBack').click();
  await wait(400);
  const out = await page.evaluate(() => document.querySelector('#mvPicker').hidden);
  check('back from an episode list returns to the shows', up1 === 'Shows', up1);
  check('back again returns to the categories', up2.cats === 1 && up2.open,
    JSON.stringify(up2));
  check('and only then does it leave the picker', out);

  await page.evaluate(() => multiview.stopAll());
  await wait(400);
  hlsForAll = false;

  // --- moving cells around -------------------------------------------------
  //
  // The picture must not so much as blink: swapping is done by exchanging the
  // boxes in the DOM, not by handing one cell's channel to another, which
  // would mean tearing an engine down and asking the provider for something
  // already on screen.
  console.log('\n  reorganising the grid');
  hlsForAll = true;
  await page.evaluate(() => multiview.stopAll());
  await page.evaluate(() => {
    [0, 1, 2].forEach((i) =>
      multiview.start(i, { kind: 'live', id: i + 1, name: `Channel ${i + 1}` }));
  });
  await wait(2500);

  const grips = await page.evaluate(() =>
    [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden)
      .filter((c) => !c.querySelector('.mv-bar').hidden)
      .every((c) => Boolean(c.querySelector('.mv-grip'))));
  check('every running cell has a handle to move it by', grips);

  const wasOrder = await page.evaluate(() => ({
    order: multiview.cells.map((c) => c.name.textContent),
    dom: [...document.querySelectorAll('#mvGrid .mv-cell')]
      .map((c) => c.querySelector('.mv-name').textContent),
    t0: multiview.cells[0].video.currentTime,
    t2: multiview.cells[2].video.currentTime,
  }));

  // Dragged for real, by the pointer, from one grip onto another cell.
  const gripBox = await page.evaluate(() => {
    const r = multiview.cells[0].box.querySelector('.mv-grip').getBoundingClientRect();
    const t = multiview.cells[2].box.getBoundingClientRect();
    return { gx: r.x + r.width / 2, gy: r.y + r.height / 2,
      tx: t.x + t.width / 2, ty: t.y + t.height / 2 };
  });
  await page.mouse.move(gripBox.gx, gripBox.gy);
  await page.mouse.down();
  await page.mouse.move(gripBox.gx + 20, gripBox.gy + 20, { steps: 4 });
  const midDrag = await page.evaluate(() => ({
    dragging: document.querySelectorAll('.mv-cell.is-dragging').length,
    target: document.querySelectorAll('.mv-cell.is-target').length,
  }));
  await page.mouse.move(gripBox.tx, gripBox.ty, { steps: 8 });
  const overTarget = await page.evaluate(() =>
    multiview.cells[2].box.classList.contains('is-target'));
  await page.mouse.up();
  await wait(600);

  const after = await page.evaluate(() => ({
    order: multiview.cells.map((c) => c.name.textContent),
    dom: [...document.querySelectorAll('#mvGrid .mv-cell')]
      .map((c) => c.querySelector('.mv-name').textContent),
    t0: multiview.cells[0].video.currentTime,
    t2: multiview.cells[2].video.currentTime,
    marks: document.querySelectorAll('.mv-cell.is-dragging, .mv-cell.is-target').length,
    playing: multiview.cells.filter((c) => c.ok).length,
  }));
  console.log('   before:', JSON.stringify(wasOrder.dom));
  console.log('   after: ', JSON.stringify(after.dom));
  check('the one being dragged is marked', midDrag.dragging === 1, JSON.stringify(midDrag));
  check('and so is the cell it is over', overTarget);
  check('letting go swaps them', after.order[0] === wasOrder.order[2]
    && after.order[2] === wasOrder.order[0], JSON.stringify(after.order));
  check('the DOM order follows, so the grid really redraws them swapped',
    after.dom.join() === after.order.join(), JSON.stringify(after.dom));
  check('both are still playing — nothing was torn down to move it',
    after.playing === 3, JSON.stringify(after));
  check('and the picture never restarted',
    after.t2 >= wasOrder.t0 && after.t0 >= wasOrder.t2,
    `${wasOrder.t0}/${wasOrder.t2} → ${after.t0}/${after.t2}`);
  check('the drag marks are cleaned up after', after.marks === 0, String(after.marks));

  // The controls have to act on where a cell IS, not where it was built.
  await page.evaluate(() => multiview.cells[0].box.querySelector('.mv-drop').click());
  await wait(500);
  const pressed = await page.evaluate(() => ({
    first: multiview.cells[0].item,
    third: multiview.cells[2].name.textContent,
  }));
  check('a button presses the cell it is on, not the slot it was born in',
    pressed.first === null && pressed.third === 'Channel 1', JSON.stringify(pressed));

  // A tap on the handle must not be read as a nudge.
  await page.evaluate(() => {
    multiview.start(0, { kind: 'live', id: 9, name: 'Channel 9' });
  });
  await wait(2000);
  const tapOrder = await page.evaluate(() => multiview.cells.map((c) => c.name.textContent));
  const gb = await page.evaluate(() => {
    const g = multiview.cells[0].box.querySelector('.mv-grip').getBoundingClientRect();
    return { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  });
  await page.mouse.click(gb.x, gb.y);
  await wait(400);
  check('a tap on the handle moves nothing',
    (await page.evaluate(() => multiview.cells.map((c) => c.name.textContent))).join()
      === tapOrder.join(), 'the order changed on a plain tap');

  await page.evaluate(() => multiview.stopAll());
  await wait(300);

  // --- two, three or four -------------------------------------------------
  console.log('\n  choosing how many');
  for (const want of [2, 3, 4]) {
    await page.evaluate((n) => multiview.setCount(n), want);
    await wait(400);
    const shape = await page.evaluate(() => {
      const shown = [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden);
      const boxes = shown.map((c) => c.getBoundingClientRect());
      const grid = document.querySelector('#mvGrid').getBoundingClientRect();
      // Every pixel of the grid covered: no cell may leave a gap beside it.
      const area = boxes.reduce((sum, b) => sum + b.width * b.height, 0);
      return {
        shown: shown.length,
        filled: area / (grid.width * grid.height),
        onScreen: boxes.every((b) => b.right <= window.innerWidth + 1
          && b.bottom <= window.innerHeight + 1 && b.width > 80 && b.height > 80),
      };
    });
    console.log(`   ${want}:`, JSON.stringify(shape));
    check(`${want} streams shows exactly ${want} cells`, shape.shown === want,
      JSON.stringify(shape));
    check(`  and leaves no blank space`, shape.filled > 0.92, JSON.stringify(shape));
    check(`  with every cell on screen`, shape.onScreen, JSON.stringify(shape));
  }

  // Dropping the count must let go of the streams it drops, not hide them.
  await page.evaluate(() => {
    [1, 2, 3].forEach((i) => multiview.start(i, { kind: 'live', id: i + 1, name: `Channel ${i + 1}` }));
  });
  await wait(2500);
  await page.evaluate(() => multiview.setCount(2));
  await wait(600);
  const dropped = await page.evaluate(() => ({
    stillHeld: multiview.cells.slice(2).filter((c) => c.item || c.engine
      || c.video.getAttribute('src')).length,
    shown: [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden).length,
  }));
  check('dropping to two lets the other two go rather than hiding them',
    dropped.stillHeld === 0 && dropped.shown === 2, JSON.stringify(dropped));
  check('and the choice is remembered',
    (await page.evaluate(() => localStorage.getItem('portal.mvCount'))) === '2');
  await page.evaluate(() => multiview.setCount(4));
  await wait(300);

  // --- chrome that gets out of the way ------------------------------------
  console.log('\n  the bars');
  // A cell has to be running: this is about chrome sitting over a picture, and
  // an empty cell keeps its prompt rather than a bar.
  await page.evaluate(() => {
    if (!multiview.cells[0].item) {
      multiview.start(0, { kind: 'live', id: 1, name: 'Channel 1' });
    }
  });
  await wait(2000);
  await page.evaluate(() => multiview.wake());
  check('the bar is up right after moving',
    await page.locator('.mv-cell:not([hidden]) .mv-bar').first().isVisible());
  await wait(3600);
  const faded = await page.evaluate(() => {
    const bar = document.querySelector('.mv-cell:not([hidden]) .mv-bar');
    return {
      idle: document.querySelector('#multiview').classList.contains('is-idle'),
      opacity: getComputedStyle(bar).opacity,
      topOpacity: getComputedStyle(document.querySelector('.mv-top')).opacity,
    };
  });
  console.log('   idle:', JSON.stringify(faded));
  check('it fades out on its own', faded.idle && faded.opacity === '0', JSON.stringify(faded));
  check('and the top bar with it', faded.topOpacity === '0', faded.topOpacity);

  await page.mouse.move(400, 400);
  await wait(400);
  const woken = await page.evaluate(() => ({
    idle: document.querySelector('#multiview').classList.contains('is-idle'),
    opacity: getComputedStyle(document.querySelector('.mv-cell:not([hidden]) .mv-bar')).opacity,
  }));
  check('moving the mouse brings it back',
    !woken.idle && woken.opacity === '1', JSON.stringify(woken));

  // A menu over the top must not be dismissed by the fade timer.
  await page.evaluate(() => { multiview.pick(3); multiview.wake(); });
  await wait(3600);
  check('it stays up while the picker is open',
    (await page.evaluate(() =>
      document.querySelector('#multiview').classList.contains('is-idle'))) === false);
  await page.locator('#mvPickerBack').click();
  await wait(300);

  // --- one stream, full screen --------------------------------------------
  console.log('\n  full screen');
  await page.evaluate(() => {
    for (let i = 0; i < 4; i += 1) {
      if (!multiview.cells[i].item) {
        multiview.start(i, { kind: 'live', id: i + 1, name: `Channel ${i + 1}` });
      }
    }
  });
  await wait(2500);
  await page.evaluate(() => multiview.expand(0));
  await wait(600);
  const solo = await page.evaluate(() => {
    const shown = [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden);
    const box = shown[0]?.getBoundingClientRect();
    const grid = document.querySelector('#mvGrid').getBoundingClientRect();
    return {
      solo: multiview.solo,
      shown: shown.length,
      name: multiview.cells[0].name.textContent,
      fills: box ? (box.width * box.height) / (grid.width * grid.height) : 0,
      othersStopped: multiview.cells.slice(1).filter((c) => c.item).length,
    };
  });
  console.log('  ', JSON.stringify(solo));
  check('only the chosen stream is shown', solo.shown === 1 && solo.solo === 0,
    JSON.stringify(solo));
  check('and it fills the screen', solo.fills > 0.92, JSON.stringify(solo));
  check('the others keep running rather than being torn down',
    solo.othersStopped === 3, JSON.stringify(solo));
  await page.screenshot({ path: SHOTS + '/multiview-solo.png' });

  await page.evaluate(() => multiview.unexpand());
  await wait(600);
  const backOut = await page.evaluate(() => ({
    solo: multiview.solo,
    shown: [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden).length,
    mvUp: !document.querySelector('#multiview').hidden,
    running: multiview.cells.filter((c) => c.item).length,
  }));
  console.log('  ', JSON.stringify(backOut));
  check('backing out returns to the grid rather than closing multi-view',
    backOut.mvUp && backOut.shown === 4 && backOut.solo === -1, JSON.stringify(backOut));
  check('with everything still running', backOut.running === 4, JSON.stringify(backOut));

  // Escape shrinks first and only leaves on the second press.
  await page.evaluate(() => multiview.expand(1));
  await wait(400);
  await page.keyboard.press('Escape');
  await wait(500);
  check('Escape shrinks a blown-up cell instead of closing the screen',
    (await page.evaluate(() => multiview.solo)) === -1
      && (await page.locator('#multiview').isVisible()));

  // Stopping the cell that is blown up cannot leave an empty full screen.
  await page.evaluate(() => multiview.expand(0));
  await wait(400);
  await page.evaluate(() => multiview.stop(0));
  await wait(400);
  check('stopping the blown-up cell drops back to the grid',
    (await page.evaluate(() => multiview.solo)) === -1
      && (await page.evaluate(() =>
        [...document.querySelectorAll('.mv-cell')].filter((c) => !c.hidden).length)) === 4);
  hlsForAll = false;
  await page.evaluate(() => multiview.stopAll());
  await wait(300);

  // --- letting go of the connection ---------------------------------------
  console.log('\n  stopping');
  await page.evaluate(() => multiview.stop(0));
  await wait(500);
  const stopped = await page.evaluate(() => {
    const cell = multiview.cells[0];
    return {
      empty: !cell.empty.hidden,
      engine: cell.engine,
      src: cell.video.getAttribute('src'),
      item: cell.item,
    };
  });
  check('the cell goes back to empty', stopped.empty, JSON.stringify(stopped));
  check('and lets go of the stream rather than holding the connection',
    !stopped.src && stopped.engine === null && stopped.item === null,
    JSON.stringify(stopped));

  const before = playCalls;
  await page.mouse.move(600, 400);   // the chrome hides itself; wake it first
  await wait(300);
  await page.locator('#mvStopAll').click();
  await wait(600);
  const cleared = await page.evaluate(() => ({
    playing: multiview.cells.filter((c) => c.item).length,
    empties: [...document.querySelectorAll('.mv-empty')].filter((e) => !e.hidden).length,
  }));
  check('Stop all clears the board', cleared.playing === 0 && cleared.empties === 4,
    JSON.stringify(cleared));
  check('and does not ask the provider for anything on the way out',
    playCalls === before, `${playCalls - before} calls`);

  // --- leaving --------------------------------------------------------------
  console.log('\n  leaving it');
  await page.evaluate(() => multiview.start(0, { kind: 'live', id: 1, name: 'US| NFL PPV 01' }));
  await wait(2000);
  await page.mouse.move(600, 400);
  await wait(300);
  await page.locator('#mvClose').click();
  await wait(600);
  const closed = await page.evaluate(() => ({
    up: !document.querySelector('#multiview').hidden,
    running: multiview.cells.filter((c) => c.item).length,
    scroll: document.body.style.overflow,
  }));
  check('closing hides it', !closed.up);
  check('and does not leave a stream running behind it',
    closed.running === 0, JSON.stringify(closed));
  check('the page scrolls again', closed.scroll === '', `"${closed.scroll}"`);

  // --- straight from the player --------------------------------------------
  //
  // The point is not having to find the channel again in there: whatever is on
  // screen comes with you.
  console.log('\n  from the live player into multi-view');
  await page.evaluate(() => multiview.close());
  await wait(400);
  hlsForAll = true;
  await seedLive();
  await page.evaluate((chan) => openPlayer(chan), CHANNELS[1]);
  await wait(2500);

  const inPlayer = await page.evaluate(() => ({
    playerUp: !document.querySelector('#playerOverlay').hidden,
    btnShown: !document.querySelector('#cinemaMultiview').hidden,
    // The top-right corner of the player, with the other controls — which in
    // cinema mode is where they all sit.
    topRight: (() => {
      const b = document.querySelector('#cinemaMultiview').getBoundingClientRect();
      return b.top < window.innerHeight * 0.2
        && window.innerWidth - b.right < 120;
    })(),
    withTheOthers: Boolean(
      document.querySelector('#cinemaMultiview').closest('.player-bar-actions')),
    fourPanes: document.querySelectorAll('#cinemaMultiview svg rect').length,
  }));
  console.log('  ', JSON.stringify(inPlayer));
  check('the button is there while a channel is playing', inPlayer.btnShown,
    JSON.stringify(inPlayer));
  check('in the top-right corner', inPlayer.topRight, JSON.stringify(inPlayer));
  check('alongside the player\'s other controls rather than off on its own',
    inPlayer.withTheOthers, JSON.stringify(inPlayer));
  check('and it is drawn as four screens', inPlayer.fourPanes === 4,
    `${inPlayer.fourPanes} panes`);

  await page.evaluate(() => document.querySelector('#cinemaMultiview').click());
  await wait(3000);
  const carried = await page.evaluate(() => ({
    playerGone: document.querySelector('#playerOverlay').hidden,
    mvUp: !document.querySelector('#multiview').hidden,
    first: multiview.cells[0].name.textContent,
    playing: multiview.cells[0].ok,
  }));
  console.log('  ', JSON.stringify(carried));
  check('pressing it leaves the player', carried.playerGone, JSON.stringify(carried));
  check('and opens multi-view', carried.mvUp);
  check('with the channel you were watching already in it',
    carried.first === 'US| NBC East', carried.first);
  check('and playing', carried.playing, JSON.stringify(carried));

  // Coming in a second time must fill the next free cell, not replace the first.
  await page.evaluate(() => multiview.close());
  await wait(400);
  await page.evaluate((chan) => openPlayer(chan), CHANNELS[2]);
  await wait(2500);
  await page.evaluate(() => document.querySelector('#cinemaMultiview').click());
  await wait(3000);
  await page.evaluate(() => multiview.close());
  await wait(300);

  // A film has no business offering it — multi-view is four LIVE channels.
  await page.evaluate(() => {
    openPlayer({ kind: 'movie', id: 900, name: 'A Film', logo: '' });
  });
  await wait(1500);
  check('a film does not offer it',
    await page.locator('#cinemaMultiview').isHidden());
  await page.evaluate(() => closePlayer());
  await wait(400);

  // --- closing it ----------------------------------------------------------
  //
  // There is no switch to turn off any more, so the thing to check is that the
  // ordinary way out still lets go of everything it was holding.
  console.log('\n  closing it');
  await page.evaluate(() => multiview.open());
  await wait(400);
  await page.evaluate(() => multiview.start(0, { kind: 'live', id: 1, name: 'US| NFL PPV 01' }));
  await wait(1500);
  await page.evaluate(() => multiview.close());
  await wait(600);
  const shut = await page.evaluate(() => ({
    up: !document.querySelector('#multiview').hidden,
    running: multiview.cells.filter((c) => c.item).length,
  }));
  console.log('  ', JSON.stringify(shut));
  check('the grid goes away', !shut.up, JSON.stringify(shut));
  check('and does not leave a stream running behind it',
    shut.running === 0, JSON.stringify(shut));
  check('while the way back in stays on Live TV', await multiviewOffered(page));

  // And it is still there after a reload, because it is not a preference.
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => { location.hash = '#/live'; render(); });
  await wait(800);
  check('and after a reload, with nothing stored to remember',
    await multiviewOffered(page));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
