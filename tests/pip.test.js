/**
 * Picture in picture: one button, two APIs.
 *
 * Desktop Chrome speaks the standard (requestPictureInPicture); everything on
 * iOS speaks presentation modes (webkitSetPresentationMode) — Chrome-on-iPhone
 * included, since every iOS browser is WebKit. The checks here stub each
 * dialect in turn and press the real button, because "the right call is made
 * on the right platform" is exactly the kind of claim that reads fine in the
 * source of both branches while one of them is dead.
 */
const fs = require('fs');
const { chromium, devices } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHANNEL = { kind: 'live', id: 1, logo: '', categoryId: 'c1', name: 'A Channel' };
const FILM = { kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mp4', categoryId: 'm1' };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ ...devices['iPhone 13 Pro'] });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/api/play*', (r) => {
    if (new URL(r.request().url()).pathname !== '/api/play') return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'm3u8' }) });
  });
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  /* ---- the desktop dialect ---------------------------------------------- */
  //
  // Stub the standard API on the element and press the button. What matters
  // is which call the button makes and what the pressed state follows.
  console.log('\n  the standard API (desktop Chrome)');
  const desktop = await page.evaluate(async (ch) => {
    const video = document.querySelector('#video');
    const calls = [];
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    video.requestPictureInPicture = async () => {
      calls.push('request');
      Object.defineProperty(document, 'pictureInPictureElement', {
        value: video, configurable: true });
      video.dispatchEvent(new Event('enterpictureinpicture'));
    };
    document.exitPictureInPicture = async () => {
      calls.push('exit');
      Object.defineProperty(document, 'pictureInPictureElement', {
        value: null, configurable: true });
      video.dispatchEvent(new Event('leavepictureinpicture'));
    };

    state.library.live = { categories: [{ id: 'c1', name: 'TV' }], items: [ch] };
    state.downloads = { items: [], active: null, queued: 0 };
    openPlayer(ch);
    await new Promise((r) => setTimeout(r, 1200));

    const out = { shown: !document.querySelector('#pipBtn').hidden, calls: [...calls] };
    document.querySelector('#pipBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    out.afterOpen = { calls: [...calls],
      lit: document.querySelector('#pipBtn').classList.contains('is-on') };
    document.querySelector('#pipBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    out.afterClose = { calls: [...calls],
      lit: document.querySelector('#pipBtn').classList.contains('is-on') };
    return out;
  }, CHANNEL);
  console.log('   ', JSON.stringify(desktop));
  check('the button shows when the API exists', desktop.shown, JSON.stringify(desktop));
  check('pressing it asks for the floating window',
    desktop.afterOpen.calls.join(',') === 'request', JSON.stringify(desktop.afterOpen));
  check('and the button lights while the picture floats', desktop.afterOpen.lit);
  check('pressing again closes it', desktop.afterClose.calls.join(',') === 'request,exit',
    JSON.stringify(desktop.afterClose));
  check('and the light goes out', !desktop.afterClose.lit);

  // Closing the player takes the floating window with it.
  const closedDown = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    const calls = [];
    document.exitPictureInPicture = async () => {
      calls.push('exit');
      Object.defineProperty(document, 'pictureInPictureElement', {
        value: null, configurable: true });
    };
    await video.requestPictureInPicture();
    closePlayer();
    await new Promise((r) => setTimeout(r, 300));
    return calls;
  });
  check('closing the player closes the floating window too',
    closedDown.includes('exit'), JSON.stringify(closedDown));

  /* ---- the iOS dialect --------------------------------------------------- */
  //
  // Wipe the standard API, provide only WebKit presentation modes — the shape
  // of every browser on an iPhone — and press the same button.
  console.log('\n  the WebKit dialect (everything on iOS)');
  const ios = await page.evaluate(async (film) => {
    const video = document.querySelector('#video');
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      value: false, configurable: true });
    Object.defineProperty(document, 'pictureInPictureElement', {
      value: null, configurable: true });
    delete video.requestPictureInPicture;
    const calls = [];
    video.webkitSupportsPresentationMode = (mode) => mode === 'picture-in-picture';
    video.webkitPresentationMode = 'inline';
    video.webkitSetPresentationMode = (mode) => {
      calls.push(mode);
      video.webkitPresentationMode = mode;
      video.dispatchEvent(new Event('webkitpresentationmodechanged'));
    };

    closePlayer();
    state.library.movies = { categories: [{ id: 'm1', name: 'Films' }], items: [film] };
    openPlayer(film);
    await new Promise((r) => setTimeout(r, 1200));

    const out = { shown: !document.querySelector('#pipBtn').hidden };
    document.querySelector('#pipBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    out.afterOpen = { calls: [...calls],
      lit: document.querySelector('#pipBtn').classList.contains('is-on') };
    document.querySelector('#pipBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    out.afterClose = { calls: [...calls] };
    return out;
  }, FILM);
  console.log('   ', JSON.stringify(ios));
  check('the button shows on the WebKit dialect too', ios.shown, JSON.stringify(ios));
  check('pressing it sets the picture-in-picture presentation mode',
    ios.afterOpen.calls.join(',') === 'picture-in-picture', JSON.stringify(ios.afterOpen));
  check('the lit state follows the WebKit event', ios.afterOpen.lit);
  check('and pressing again returns the picture inline',
    ios.afterClose.calls.join(',') === 'picture-in-picture,inline',
    JSON.stringify(ios.afterClose));

  /* ---- the measured iPad -------------------------------------------------- */
  //
  // An iPad advertises BOTH dialects, then refuses the standard one with "the
  // video element does not support the Picture-in-Picture mode". On Apple
  // hardware Apple's dialect goes first, and either is the other's fallback —
  // so this exact device gets its floating window with no error toast.
  console.log('\n  the device that advertises both and refuses one');
  const ipad = await page.evaluate(async (ch) => {
    const video = document.querySelector('#video');
    const calls = [];
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      value: true, configurable: true });
    video.requestPictureInPicture = async () => {
      calls.push('standard');
      throw new Error('The video element does not support the Picture-in-Picture mode.');
    };
    video.webkitSupportsPresentationMode = (m) => m === 'picture-in-picture';
    video.webkitPresentationMode = 'inline';
    video.webkitSetPresentationMode = (mode) => {
      calls.push(`webkit:${mode}`);
      video.webkitPresentationMode = mode;
      video.dispatchEvent(new Event('webkitpresentationmodechanged'));
    };
    closePlayer();
    openPlayer(ch);
    await new Promise((r) => setTimeout(r, 1000));
    document.querySelector('#toast').hidden = true;
    document.querySelector('#pipBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    return { calls,
      lit: document.querySelector('#pipBtn').classList.contains('is-on'),
      toast: document.querySelector('#toast').hidden
        ? '' : document.querySelector('#toast').textContent };
  }, CHANNEL);
  console.log('   ', JSON.stringify(ipad));
  check('on Apple hardware Apple\'s dialect goes first',
    ipad.calls[0] === 'webkit:picture-in-picture', JSON.stringify(ipad.calls));
  check('the window opens and the button lights', ipad.lit, JSON.stringify(ipad));
  check('and no error is shown, because nothing failed', ipad.toast === '', ipad.toast);

  /* ---- no dialect at all -------------------------------------------------- */
  console.log('\n  a browser with neither');
  const neither = await page.evaluate(async (ch) => {
    const video = document.querySelector('#video');
    delete video.webkitSetPresentationMode;
    delete video.webkitSupportsPresentationMode;
    // The iPad scenario above re-installed the standard API; a browser with
    // neither has that gone too.
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      value: false, configurable: true });
    delete video.requestPictureInPicture;
    closePlayer();
    openPlayer(ch);
    await new Promise((r) => setTimeout(r, 1000));
    return { shown: !document.querySelector('#pipBtn').hidden };
  }, CHANNEL);
  check('the button does not exist rather than existing broken',
    neither.shown === false, JSON.stringify(neither));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
