/**
 * A seek must not describe the incoming stream while the outgoing one plays.
 *
 * Spotted in a real report: the film position jumped fifteen seconds forward
 * in one tick with the measured rate still at 1.00x, several seconds before
 * the new stream attached. The offset had been applied the moment the remux
 * request came back, while the old stream carried on through the buffering
 * wait — so the scrubber lied, and anything saving a position in that window
 * saved the wrong one.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP,
      headers: { 'accept-ranges': 'bytes', 'content-length': String(CLIP.length) } }));
  await page.route('**/api/remux?*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'm3u8', session: 'new',
        prebuffer: 8, offset: 1310, sourceDuration: 1642 }) }));

  // Buffers slowly, so there is a real window in which the old stream plays on.
  let polls = 0;
  await page.route('**/api/remux/status*', (r) => {
    polls += 1;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ seconds: polls * 3, complete: false, target: 8, failed: false }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  // A film already playing, 1296s in.
  await page.evaluate(async () => {
    document.querySelector('#playerOverlay').hidden = false;
    document.querySelector('#playerOverlay').classList.add('cinema');
    film.active = true; film.runtimeKnown = true; film.duration = 1642;
    film.offset = 1296; film.ready = 40; film.seeking = false;
    film.item = { kind: 'movie', id: 42 }; film.override = null;
    film.audioDelay = 0; film.serverDelay = 0;
    lastRemux = { session: 'old' };
    const v = document.querySelector('#video');
    v.src = '/api/fake-stream';
    v.muted = true;
    await v.play().catch(() => {});
  });
  await wait(2500);

  const before = await page.evaluate(() => filmPosition());
  console.log('   playing at', before.toFixed(1));
  check('the old stream is playing where it should be',
    before > 1296 && before < 1305, String(before));

  // Seek forward, and watch the reported position while it buffers.
  await page.evaluate(() => { window.__seek = seekFilm(1400, { force: true }); });

  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    await wait(400);
    samples.push(await page.evaluate(() => ({
      pos: filmPosition(),
      offset: film.offset,
      ready: film.ready,
      seeking: film.seeking,
      paused: document.querySelector('#video').paused,
    })));
    if (!samples[samples.length - 1].seeking) break;
  }
  const during = samples.filter((x) => x.seeking);
  console.log('   during the wait:',
    during.map((x) => `${x.pos.toFixed(1)} (offset ${x.offset}, ready ${x.ready})`).join(', '));
  check('there was a real buffering window to observe', during.length >= 2,
    `${during.length} samples`);
  // Asserted on the offset itself, not on the position being "roughly right".
  // A position threshold let the old ordering through: the stub's seek only
  // moved the offset fourteen seconds, which sailed under a loose bound.
  check('the outgoing session keeps its offset until the new one attaches',
    during.every((x) => x.offset === 1296),
    during.map((x) => x.offset).join(', '));
  check('and its ready count is not overwritten by the incoming one',
    during.every((x) => x.ready === 40), during.map((x) => x.ready).join(', '));
  // The scene you just left must not carry on talking behind the loader.
  check('the outgoing stream is stopped, not left playing behind the loader',
    during.every((x) => x.paused), during.map((x) => x.paused).join(', '));

  await page.evaluate(() => window.__seek);
  await wait(1200);
  const after = await page.evaluate(() => ({
    pos: filmPosition(), offset: film.offset,
    paused: document.querySelector('#video').paused,
  }));
  console.log('   after attaching:', JSON.stringify(after));
  check('the new offset lands once the new stream is attached',
    after.offset === 1310, String(after.offset));
  check('and the position reads from it', after.pos >= 1310 && after.pos < 1320,
    String(after.pos));
  check('the new stream is playing, not left stopped', !after.paused);

  // --- a failed jump puts things back --------------------------------------
  console.log('\n  a jump that fails');
  await page.unroute('**/api/remux?*');
  await page.route('**/api/remux?*', (r) =>
    r.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'provider said no' }) }));
  const before2 = await page.evaluate(() => filmPosition());
  await page.evaluate(() => seekFilm(200, { force: true }));
  await wait(1500);
  const failed = await page.evaluate(() => ({
    paused: document.querySelector('#video').paused,
    pos: filmPosition(),
    seeking: film.seeking,
  }));
  console.log('   ', JSON.stringify(failed));
  check('a failed jump leaves the film playing rather than silently stopped',
    !failed.paused, JSON.stringify(failed));
  check('and where it already was', Math.abs(failed.pos - before2) < 4,
    `${before2.toFixed(1)} -> ${failed.pos.toFixed(1)}`);
  check('and not stuck mid-seek', failed.seeking === false);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
