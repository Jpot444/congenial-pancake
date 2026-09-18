/**
 * A film or an episode starts itself.
 *
 * "A lot of times next episode and then when it loads, it says connecting to
 *  stream, but it won't play until I press play. I'd like to play
 *  automatically."
 *
 * The hls.js branch of attach() never called play(). LIVE did — waitForCushion
 * holds the picture back until there is a buffer and then starts it — and a
 * film or an episode was left to the `autoplay` attribute on the element,
 * which is not reliable for a source hls.js attaches: there is no `src` to
 * begin loading, only a MediaSource handed over after the fact, and whether
 * the element decides to start itself depends on timing nothing here controls.
 *
 * When it did not, the status stayed on "Connecting to stream…", which is how
 * a picture that needs one press looks exactly like one that is still loading.
 * Two faults in one: it did not start, and it did not say so.
 *
 * DRIVEN THROUGH A STAND-IN Hls, on purpose. play() is stubbed and counted, so
 * what is under test is the wiring — does this branch ask for playback, and
 * when — rather than whether a decoder in a headless browser happens to feel
 * like starting. It also means the result cannot be faked by the launch flag:
 * upnext.test.js runs with --autoplay-policy=no-user-gesture-required, which
 * would have hidden this bug completely.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* Deliberately NOT --autoplay-policy=no-user-gesture-required. Nothing here
     depends on the real policy, and running without it keeps the suite honest
     about what it is measuring. */
  const browser = await chromium.launch();
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

  /*
   * The stand-in. Enough of hls.js's surface for attach() to wire itself up,
   * plus a handle to fire MANIFEST_PARSED when the suite decides to.
   */
  await page.evaluate(() => {
    window.__fake = { plays: 0, rejectPlay: false, handlers: {}, made: 0, loaded: null };

    class FakeHls {
      constructor() {
        window.__fake.made += 1;
        /* A new engine replaces the old one, the way destroy()-then-new does
           for real. Left accumulating, every attach added another
           MANIFEST_PARSED listener and firing the event called all of them —
           so the counts climbed 1, 2, 3 and the suite measured its own fake
           rather than the code. */
        window.__fake.handlers = {};
      }
      loadSource(url) { window.__fake.loaded = url; }
      attachMedia() {}
      on(event, fn) { (window.__fake.handlers[event] ||= []).push(fn); }
      destroy() {}
      startLoad() {}
      recoverMediaError() {}
    }
    FakeHls.isSupported = () => true;
    FakeHls.Events = {
      MANIFEST_PARSED: 'hlsManifestParsed',
      LEVEL_UPDATED: 'hlsLevelUpdated',
      ERROR: 'hlsError',
    };
    FakeHls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    window.Hls = FakeHls;

    /* play() counted rather than performed: there is no real media behind any
       of this, and whether a decoder starts is not the claim. */
    const video = document.querySelector('#video');
    video.play = () => {
      window.__fake.plays += 1;
      return window.__fake.rejectPlay
        ? Promise.reject(new DOMException('blocked', 'NotAllowedError'))
        : Promise.resolve();
    };
    window.__fire = (event) => {
      for (const fn of window.__fake.handlers[event] || []) fn(event, {});
    };
    /* The element status() actually writes to. */
    window.__statusText = () => {
      const node = document.querySelector('#videoStatus');
      return node && !node.hidden ? node.textContent : '';
    };
  });

  /* ---- an episode, which is what the report is about -------------------- */
  /*
   * currentLiveItem null is what makes attach() treat this as a film or an
   * episode rather than a channel — the same switch the real path flips.
   */
  console.log('\n  a film or an episode, attached the way an episode is');
  let seen = await page.evaluate(async () => {
    currentLiveItem = null;
    window.__fake.plays = 0;
    attach('/hls/sess-1/index.m3u8', 'm3u8');
    const before = { plays: window.__fake.plays, status: window.__statusText() };
    /* Nothing to play until the manifest is in, so the ask waits for it. */
    window.__fire('hlsManifestParsed');
    await new Promise((r) => setTimeout(r, 50));
    return { before, after: window.__fake.plays, status: window.__statusText() };
  });
  console.log('   ', JSON.stringify(seen));
  check('it is handed to the engine and not played before there is a manifest',
    seen.before.plays === 0, JSON.stringify(seen.before));
  check('and then it starts itself, with nothing pressed',
    seen.after === 1, String(seen.after));
  /* The other half of the report: the status said "Connecting to stream…" and
     stayed there. Cleared once it is really going. */
  check('and stops saying it is still connecting',
    !/connecting/i.test(seen.status), JSON.stringify(seen.status));

  /* ---- and again, because "next episode" is the second one -------------- */
  /*
   * The shape of the report is "a lot of times NEXT episode". The first thing
   * played in a page's life is the easy case; the interesting one is the same
   * element being handed a second source after a teardown.
   */
  console.log('\n  and the next one after it, on the same element');
  seen = await page.evaluate(async () => {
    currentLiveItem = null;
    window.__fake.plays = 0;
    attach('/hls/sess-2/index.m3u8', 'm3u8');
    window.__fire('hlsManifestParsed');
    await new Promise((r) => setTimeout(r, 50));
    return { plays: window.__fake.plays, loaded: window.__fake.loaded,
      status: window.__statusText() };
  });
  console.log('   ', JSON.stringify(seen));
  check('the second one starts itself too', seen.plays === 1, String(seen.plays));
  check('and it is the new source that was loaded',
    /sess-2/.test(seen.loaded || ''), String(seen.loaded));

  /* ---- a resume is not dragged back to the start ------------------------ */
  console.log('\n  and a resume still starts where it was asked to');
  seen = await page.evaluate(async () => {
    currentLiveItem = null;
    window.__fake.plays = 0;
    attach('/hls/sess-3/index.m3u8', 'm3u8', { seekTo: 620 });
    window.__fire('hlsManifestParsed');
    await new Promise((r) => setTimeout(r, 50));
    return { plays: window.__fake.plays };
  });
  check('it starts itself from a resume point as well', seen.plays === 1, String(seen.plays));

  /* ---- a refusal is said out loud -------------------------------------- */
  /*
   * The failure that produced the report. If the browser genuinely will not
   * start it, the screen has to say so — leaving "Connecting to stream…" up
   * makes a picture that needs one press look like one still loading, which
   * is the worst of both.
   */
  console.log('\n  and a browser that refuses is not left looking like a slow link');
  seen = await page.evaluate(async () => {
    currentLiveItem = null;
    window.__fake.plays = 0;
    window.__fake.rejectPlay = true;
    attach('/hls/sess-4/index.m3u8', 'm3u8');
    window.__fire('hlsManifestParsed');
    await new Promise((r) => setTimeout(r, 80));
    window.__fake.rejectPlay = false;
    return { plays: window.__fake.plays, status: window.__statusText() };
  });
  console.log('   ', JSON.stringify(seen));
  check('it did try', seen.plays === 1, String(seen.plays));
  check('and says to press play rather than that it is connecting',
    /press play/i.test(seen.status), JSON.stringify(seen.status));

  /* ---- live is left to the code that already owns it -------------------- */
  /*
   * waitForCushion holds a channel back on purpose until there is a buffer
   * and starts it itself. A second play() from here would be two things
   * arguing over one picture, and the one that loses is the buffer.
   */
  console.log('\n  but a channel is still left to the cushion that holds it back');
  seen = await page.evaluate(async () => {
    currentLiveItem = { kind: 'live', id: 9, name: 'A Channel' };
    window.__fake.plays = 0;
    attach('/hls/live-9/index.m3u8', 'm3u8');
    window.__fire('hlsManifestParsed');
    await new Promise((r) => setTimeout(r, 80));
    const out = { plays: window.__fake.plays };
    currentLiveItem = null;
    return out;
  });
  console.log('   ', JSON.stringify(seen));
  check('nothing here starts a channel behind the cushion’s back',
    seen.plays === 0, String(seen.plays));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
