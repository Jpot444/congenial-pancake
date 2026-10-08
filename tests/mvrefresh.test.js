/**
 * Refreshing a cell does not throw away the box's work.
 *
 * "sometimes im pressing refresh and the series isnt playing right after"
 *
 * It would not, and the button was doing far more than it was asked to.
 *
 * `refresh` went straight to `start()`, which begins with `stop()` — and
 * `stop()` sends `/api/remux/stop`, which KILLS THE CONVERSION ON THE BOX. For
 * a channel that costs nothing: the segments are already written and a new
 * engine picks them straight up. For a film or an episode it throws away a
 * minute of ffmpeg's work and then waits out the whole prebuffer again before
 * a single frame arrives. From the sofa: you press ↻ because the picture is
 * stuck, and the picture goes away.
 *
 * And it is the wrong trade twice over, because of WHY anybody presses it. The
 * thing that is stuck is almost always the media element — a buffer that
 * stopped being appended to, an engine that gave up — while the conversion
 * behind it is perfectly healthy. The cheap repair is to throw away the
 * browser's state and leave the box alone.
 *
 * So that is tried first, and the expensive one is still there behind it. All
 * three of those are claims this suite makes:
 *
 *   a converted cell is re-attached, and the box is NOT told to stop
 *   a channel still takes the old path, because for a channel it is the cheap one
 *   and a re-attach that produces nothing falls back to the full rebuild
 */
const { chromium } = require('./playwright.js');
const { openMultiview } = require('./mv.js');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNELS = [
  { kind: 'live', id: 700, num: 700, name: 'CBS HD', categoryId: 'c1', logo: '' },
  { kind: 'live', id: 701, num: 701, name: 'ESPN HD', categoryId: 'c1', logo: '' },
];
const EPISODE = { kind: 'series', id: 5501, name: 'The Bear — S1E2', categoryId: 'g1',
  ext: 'mkv', seriesId: 77 };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'live'
        ? { categories: [{ id: 'c1', name: 'USA' }], items: CHANNELS, totals: { items: 2 } }
        : tab === 'series'
          ? { categories: [{ id: 'g1', name: 'Shows' }], items: [EPISODE], totals: { items: 1 } }
          : { categories: [], items: [], totals: { items: 0 } }) });
  });
  await page.route('**/api/epg/now**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"channels":[],"busy":false}' }));
  await page.route('**/api/scores**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"games":[],"feeds":[]}' }));
  await page.route('**/progress**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/downloads**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"items":[],"active":null,"activeIds":[],"queued":0}' }));
  await page.route('**/api/play**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"url":"/nope.m3u8","format":"m3u8"}' }));

  /* The conversion. Each ask gets its own session id, so "was a NEW one
     started" is answerable rather than inferred. */
  let remuxes = 0;
  let stops = [];
  await page.route('**/api/remux?**', (r) => {
    remuxes += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ session: `sess-${remuxes}`, url: `/hls/sess-${remuxes}/index.m3u8`,
        offset: 0, ready: true, sourceDuration: 1800 }) });
  });
  await page.route('**/api/remux/stop**', (r) => {
    stops.push(new URL(r.request().url()).searchParams.get('id'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"stopped":true}' });
  });
  await page.route('**/api/remux/status**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"ready":true,"seconds":120}' }));
  /* The playlist the cell attaches to. Never produces a picture in this
     browser, which is exactly the condition the fallback is for — so the
     fallback half of the suite needs no special arrangement, and the
     re-attach half asserts what was ASKED rather than what played. */
  await page.route('**/hls/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' }));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wait(1500);
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await page.evaluate(() => {
    document.querySelector('#tour')?.remove();
    state.config.mode = 'xtream';
    profiles.data.startersDone = true;
    location.hash = '#/live';
    render();
  });
  await wait(900);
  await openMultiview(page);
  await wait(600);

  /* ---- a converted cell ------------------------------------------------- */
  console.log('\n  an episode in a cell');
  await page.evaluate((ep) => multiview.start(0, ep), EPISODE);
  await wait(1800);
  const started = await page.evaluate(() => ({
    remux: multiview.cells[0].remux,
    src: multiview.cells[0].src,
    vod: multiview.cells[0].vod,
  }));
  console.log('   ', JSON.stringify(started), 'conversions:', remuxes, 'stops:', stops);
  check('the box made a conversion for it', remuxes === 1, String(remuxes));
  check('and the cell knows which one', started.remux === 'sess-1', started.remux);
  /* The address, kept — without it there is nothing to put the cell back on
     and the only repair available is the expensive one. */
  check('and where it was attached, so it can be put back there',
    started.src === '/hls/sess-1/index.m3u8', String(started.src));

  console.log('\n  pressing refresh on it');
  stops = [];
  await page.evaluate(() => { multiview.cells[0].video.currentTime = 42; });
  /* Pressed and read in ONE evaluate. The note is what the cell says while it
     is working, and the stubbed playlist has no segments in it, so the engine
     gives up milliseconds later and replaces the message — which is the
     fallback doing its job, not the message being wrong. */
  const saidWhile = await page.evaluate(() => {
    multiview.refresh(0);
    return multiview.cells[0].note.textContent;
  });
  await wait(1200);
  const after = await page.evaluate(() => ({
    remux: multiview.cells[0].remux,
    src: multiview.cells[0].src,
    note: '',
    item: multiview.cells[0].item?.name,
  }));
  console.log('   ', JSON.stringify(after), 'conversions:', remuxes, 'stops:', stops);
  /* THE FAULT. One line in stop(), and it was the whole of the complaint. */
  check('the box is NOT told to throw the conversion away',
    stops.length === 0, JSON.stringify(stops));
  check('and it is not asked to make a second one',
    remuxes === 1, String(remuxes));
  check('the cell is still on the same conversion',
    after.remux === 'sess-1' && after.src === '/hls/sess-1/index.m3u8',
    JSON.stringify(after));
  check('and it is still the same episode', after.item === EPISODE.name, String(after.item));
  check('it says what it is doing', /Reconnect/i.test(saidWhile), saidWhile);

  /* ---- and when the cheap repair does not take -------------------------- */
  /*
   * The re-attach above never produces a picture — the stubbed playlist has no
   * segments in it — which is precisely the case the fallback exists for. So
   * the expensive rebuild must still happen, a few seconds later, and that
   * delay is the price of not paying a whole re-conversion every time the
   * cheap repair would have done.
   */
  console.log('\n  and when re-attaching produces nothing');
  await wait(6500);
  const fell = await page.evaluate(() => ({
    remux: multiview.cells[0].remux,
    item: multiview.cells[0].item?.name,
  }));
  console.log('   ', JSON.stringify(fell), 'conversions:', remuxes, 'stops:', stops);
  check('the cell is rebuilt the slow way after all',
    remuxes === 2, `${remuxes} conversions`);
  check('clearing the old conversion away as it goes',
    stops.includes('sess-1'), JSON.stringify(stops));
  check('and it is still the same episode in the cell',
    fell.item === EPISODE.name, String(fell.item));

  /* ---- a channel is not a conversion ------------------------------------ */
  /*
   * For a channel the old path IS the cheap one: the segments are already
   * written and nothing on the box is thrown away by starting again. It must
   * not be sent down the re-attach route, where a failed cheap repair would
   * cost it six seconds for nothing.
   */
  console.log('\n  and a channel still restarts outright');
  await page.evaluate((ch) => multiview.start(1, ch), CHANNELS[0]);
  await wait(1200);
  const before = remuxes;
  stops = [];
  const chanSaid = await page.evaluate(() => {
    multiview.refresh(1);
    return multiview.cells[1].note.textContent;
  });
  await wait(900);
  const chan = await page.evaluate(() => ({
    item: multiview.cells[1].item?.name,
  }));
  console.log('   ', JSON.stringify({ ...chan, said: chanSaid }));
  check('it goes straight back to asking for the stream',
    /Asking for the stream/i.test(chanSaid), chanSaid);
  check('and it is the same channel', chan.item === 'CBS HD', String(chan.item));
  check('with no conversion involved either way', remuxes === before, String(remuxes));

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
