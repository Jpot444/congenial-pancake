/**
 * The next-episode offer.
 *
 * Driven with a real seekable clip rather than a faked clock, so the mark is
 * measured against the media element's own time — the seeks have to actually
 * land, which is the thing that quietly failed the first time this was written.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const SHOTS = __dirname + '/shots';

const fails = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Range-aware on purpose. Without Accept-Ranges Chromium reports
  // seekable = [0,0] and silently ignores every currentTime we set, which
  // leaves the "near the end" scenarios quietly measuring the first four
  // seconds of the clip instead.
  await page.route('**/api/fake-stream', (route) => {
    const range = route.request().headers().range;
    const base = { contentType: 'audio/wav' };
    if (!range) {
      return route.fulfill({ ...base, status: 200, body: CLIP,
        headers: { 'accept-ranges': 'bytes', 'content-length': String(CLIP.length) } });
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : CLIP.length - 1;
    return route.fulfill({ ...base, status: 206, body: CLIP.subarray(start, end + 1),
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${CLIP.length}`,
        'content-length': String(end - start + 1),
      } });
  });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  // Every scenario starts from a fresh page. A <video> fed a MediaStream will
  // not rewind — reassigning srcObject carries the old currentTime across —
  // and a stale clock silently makes the next scenario measure the wrong end
  // of the episode, which is exactly the kind of pass that means nothing.
  async function freshPage() {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (await page.locator('#profileGate').isVisible()) {
      await page.locator('.profile-tile').first().click();
      await page.waitForTimeout(1200);
    }
    await shrink();
    await page.evaluate(() => {
      document.querySelector('#playerOverlay').hidden = false;
      document.querySelector('#playerOverlay').classList.add('cinema');
      document.querySelector('#vodBar').hidden = false;
      window.__started = null;
    });
  }

  async function scenario(name, setup) {
    console.log(`\n${name}`);
    await freshPage();
    await setup();
  }

  /** Load the audio-only clip and land on a given second, for real. */
  const playAudioAt = (at) => page.evaluate(async (want) => {
    const v = document.querySelector('#video');
    v.srcObject = null;
    v.src = '/api/fake-stream';
    v.muted = true;
    await new Promise((done) => {
      if (v.readyState >= 1) return done();
      v.addEventListener('loadedmetadata', done, { once: true });
    });
    await v.play();
    await new Promise((done) => {
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = want;
    });
  }, at);

  const shrink = () => page.evaluate(() => {
    UP_NEXT.mark = 45;
    UP_NEXT.minRuntime = 60;
  });

  const seen = () => page.evaluate(() => ({
    shown: !document.querySelector('#upNext').hidden,
    at: document.querySelector('#video').currentTime,
  }));

  // ---------------------------------------------------------------------
  await scenario('the offer lands on the 45-second mark', async () => {
    // The clip runs 120s, so the mark falls at 75s. Watched second by second
    // rather than sampled twice — the question is where it lands, and a
    // before/after pair can only say "somewhere in between".
    await playAudioAt(66);
    await page.evaluate(() => {
      upNext.arm({ label: 'S1 · E2 — The Next One', start: () => { window.__started = 'yes'; } });
    });

    let appearedAt = null;
    for (let i = 0; i < 20 && appearedAt === null; i += 1) {
      await wait(700);
      const r = await seen();
      if (r.shown) appearedAt = r.at;
      else if (r.at > 80) break;   // sailed past the mark without appearing
    }
    const left = appearedAt === null ? null : 120 - appearedAt;
    console.log(`   appeared at ${appearedAt} (${left === null ? 'n/a' : left.toFixed(1)}s left)`);
    check('the offer appears at all', appearedAt !== null, 'never appeared');
    check('it lands on the 45-second mark, not early and not at the end',
      left !== null && left <= 45.5 && left >= 43, `${left}s left`);
    check('it names the next episode',
      (await page.locator('#upNextTitle').textContent()).includes('The Next One'));

    const box = await page.evaluate(() => {
      const c = document.querySelector('#upNext').getBoundingClientRect();
      const track = document.querySelector('#vodTrack').getBoundingClientRect();
      const play = document.querySelector('#vodPlay').getBoundingClientRect();
      return { c: { top: c.top, left: c.left, right: c.right, bottom: c.bottom },
        trackTop: track.top, playTop: play.top,
        w: window.innerWidth, h: window.innerHeight };
    });
    console.log('   layout:', JSON.stringify(box));
    check('the card is really on screen',
      box.c.bottom > 0 && box.c.right <= box.w + 1 && box.c.bottom <= box.h + 1
        && box.c.left >= -1, JSON.stringify(box));
    check('it clears the scrubber and the play button',
      box.c.bottom <= box.trackTop + 1 && box.c.bottom <= box.playTop + 1,
      JSON.stringify(box));
    check('the chrome is pinned up while it is offered',
      !(await page.evaluate(() =>
        document.querySelector('#playerOverlay').classList.contains('chrome-hidden'))));

    await page.screenshot({ path: SHOTS + '/upnext-desktop.png' });

    await page.locator('#upNextGo').click();
    check('pressing it starts the next episode',
      (await page.evaluate(() => window.__started)) === 'yes');
    check('and the card goes away', await page.locator('#upNext').isHidden());
  });

  // ---------------------------------------------------------------------
  await scenario('a short clip never gets one', async () => {
    await page.evaluate(() => { UP_NEXT.mark = 45; UP_NEXT.minRuntime = 600; });
    await playAudioAt(100);
    await page.evaluate(() => {
      upNext.arm({ label: 'S1 · E2 — The Next One', start: () => {} });
    });
    await wait(3000);
    const r = await seen();
    console.log('   ', JSON.stringify(r));
    check('a clip under the minimum runtime is left alone', !r.shown, JSON.stringify(r));
  });

  // ---------------------------------------------------------------------
  await scenario('a remux in progress is never mistaken for the end', async () => {
    await page.evaluate(() => {
      UP_NEXT.mark = 45; UP_NEXT.minRuntime = 60;
    });
    // Well inside the floor, so a runtime taken from the player would offer it
    // — but not so close that the clip ends before the check runs.
    await playAudioAt(100);
    await page.evaluate(() => {
      // Mid-remux the player's duration is only what ffmpeg has written so
      // far, which always sits just ahead of the play head.
      lastRemux = { session: 'abc' };
      film.active = true; film.runtimeKnown = false; film.duration = 0;
      upNext.arm({ label: 'S1 · E2 — The Next One', start: () => {} });
    });
    await wait(4000);
    const r = await seen();
    console.log('   ', JSON.stringify(r));
    check('a converting stream never fakes a runtime', !r.shown, JSON.stringify(r));

    // ...but the end of the file still offers it.
    await page.evaluate(() => document.querySelector('#video').dispatchEvent(new Event('ended')));
    await wait(300);
    check('the end of the episode offers it regardless',
      await page.locator('#upNext').isVisible());
  });

  // ---------------------------------------------------------------------
  console.log('\nnext downloaded episode');
  await freshPage();
  const dl = await page.evaluate(() => {
    state.downloads.items = [
      { id: 1, status: 'done', kind: 'series', seriesId: 9, season: 1, episode: 1, name: 'A' },
      { id: 2, status: 'done', kind: 'series', seriesId: 9, season: 1, episode: 2, name: 'B' },
      { id: 3, status: 'downloading', kind: 'series', seriesId: 9, season: 1, episode: 3, name: 'C' },
      { id: 4, status: 'done', kind: 'series', seriesId: 9, season: 2, episode: 1, name: 'D' },
      { id: 5, status: 'done', kind: 'series', seriesId: 8, season: 1, episode: 1, name: 'X' },
      { id: 6, status: 'done', kind: 'movie', name: 'film' },
    ];
    const by = (id) => state.downloads.items.find((j) => j.id === id);
    return {
      next: nextDownloadedEpisode(by(1))?.id ?? null,
      skipsUnfinished: nextDownloadedEpisode(by(2))?.id ?? null,
      lastOne: nextDownloadedEpisode(by(4))?.id ?? null,
      otherShow: nextDownloadedEpisode(by(5))?.id ?? null,
      movie: nextDownloadedEpisode(by(6))?.id ?? null,
    };
  });
  console.log('   ', JSON.stringify(dl));
  check('follows on to the next episode', dl.next === 2, JSON.stringify(dl));
  check('skips one still downloading and rolls into the next season',
    dl.skipsUnfinished === 4, JSON.stringify(dl));
  check('offers nothing after the last downloaded episode', dl.lastOne === null);
  check('never crosses into another show', dl.otherShow === null);
  check('a film has no next episode', dl.movie === null);

  // ---------------------------------------------------------------------
  console.log('\nphone layout');
  await freshPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    device.setPhone(true);
    upNext.arm({ label: 'S1 · E2 — An Unusually Long Episode Title That Runs On', start: () => {} });
    upNext.reveal();
  });
  await wait(400);
  const phone = await page.evaluate(() => {
    const c = document.querySelector('#upNext').getBoundingClientRect();
    const bar = document.querySelector('#vodBar').getBoundingClientRect();
    const tr = document.querySelector('.vod-transport').getBoundingClientRect();
    return { c: { left: c.left, right: c.right, top: c.top, bottom: c.bottom, h: c.height },
      barTop: bar.top, tr: { top: tr.top, bottom: tr.bottom },
      w: window.innerWidth, h: window.innerHeight,
      docW: document.documentElement.scrollWidth };
  });
  console.log('   ', JSON.stringify(phone));
  check('the card fits the phone screen',
    phone.c.left >= -1 && phone.c.right <= phone.w + 1, JSON.stringify(phone));
  check('no sideways scroll', phone.docW <= phone.w + 1, JSON.stringify(phone));
  check('it clears the transport bar', phone.c.bottom <= phone.barTop + 1, JSON.stringify(phone));
  check('it does not cover the play buttons',
    phone.c.bottom <= phone.tr.top + 1 || phone.c.top >= phone.tr.bottom - 1,
    JSON.stringify(phone));
  check('a long title does not stretch the card', phone.c.h < 90, JSON.stringify(phone));
  await page.screenshot({ path: SHOTS + '/upnext-phone.png' });


  // --- the version stamp -------------------------------------------------
  console.log('\nversion stamp');
  await page.setViewportSize({ width: 1280, height: 900 });
  await freshPage();
  await page.evaluate(() => {
    device.setPhone(false);
    document.querySelector('#playerOverlay').hidden = true;
    location.hash = '#/home';
  });
  await wait(1500);
  const stamp = await page.evaluate(() => {
    const s = document.querySelector('.home-version');
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { text: s.textContent, left: r.left, bottom: r.bottom,
      h: window.innerHeight, version: typeof VERSION === 'string' ? VERSION : null };
  });
  console.log('   desktop:', JSON.stringify(stamp));
  check('the home screen carries a version', Boolean(stamp), 'no .home-version found');
  if (stamp) {
    check('it reads as a version', /^v\d/.test(stamp.text), stamp.text);
    check('it matches the constant', stamp.text === `v${stamp.version}`, stamp.text);
    check('it sits in the bottom-left corner',
      stamp.left < 60 && stamp.bottom > stamp.h - 60, JSON.stringify(stamp));
  }
  await page.screenshot({ path: SHOTS + '/home-version.png' });

  // Everywhere else it is gone, not merely scrolled past.
  await page.evaluate(() => { location.hash = '#/movies'; });
  await wait(1500);
  const elsewhere = await page.evaluate(() => {
    const s = document.querySelector('.home-version');
    return { present: Boolean(s), rects: s ? s.getClientRects().length : 0,
      homeHidden: document.querySelector('#homeView').hidden };
  });
  console.log('   off home:', JSON.stringify(elsewhere));
  check('it is not visible anywhere but home', elsewhere.rects === 0, JSON.stringify(elsewhere));

  // Phone: must not sit under the tab bar.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { device.setPhone(true); location.hash = '#/home'; });
  await wait(1500);
  const onPhone = await page.evaluate(() => {
    const s = document.querySelector('.home-version');
    const bar = document.querySelector('#tabBar');
    if (!s) return null;
    const r = s.getBoundingClientRect();
    const b = bar && !bar.hidden ? bar.getBoundingClientRect() : null;
    return { bottom: r.bottom, left: r.left, barTop: b ? b.top : null, h: window.innerHeight };
  });
  console.log('   phone:', JSON.stringify(onPhone));
  check('on a phone it still shows', Boolean(onPhone), 'gone on phone');
  check('and clears the tab bar',
    !onPhone || onPhone.barTop === null || onPhone.bottom <= onPhone.barTop + 1,
    JSON.stringify(onPhone));
  await page.screenshot({ path: SHOTS + '/home-version-phone.png' });

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
