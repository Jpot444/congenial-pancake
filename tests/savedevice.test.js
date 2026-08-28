/**
 * Save to device: saying something, and not swallowing the app.
 *
 * Two reports, one function behind both.
 *
 *   * "On large downloads ... it doesn't give any response right away."
 *     Handing a browser a three-gigabyte file looks, from inside the app,
 *     exactly like a button that did nothing: the transfer is the browser's
 *     business from that moment on and there is nothing to watch.
 *   * "It creates a full page on my screen that I can't get out of. There's
 *     no X button. I have to close the app." Added to the home screen this
 *     runs standalone — no address bar, no back button — and a same-window
 *     link to a video REPLACES the app with the system's viewer. There is no
 *     way back from that except force-quitting.
 *
 *   * "It isn't saving to device at all." target=_blank clicked from script
 *     is a popup, and popups are blocked.
 *   * "Downloads to device brings up some screen that does not allow
 *     downloads, doesn't close and has the tailscail address." window.open
 *     from the home-screen app: iOS's own browser view, blank, on the raw
 *     tailnet address, with a close button that does not close.
 *
 * Four goes at the same button, each fix breaking the one before it. What
 * finally holds is that iOS is never pointed at a URL at all — the file is
 * fetched here and handed to the share sheet — so the checks below are
 * mostly about what is NOT done.
 */
const fs = require('fs');
const { chromium, devices } = require('./playwright.js');
const PATHS = require('./paths.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BIG = 3.2 * 1024 ** 3;   // the kind of file that shows nothing for a while

(async () => {
  const browser = await chromium.launch();
  // An iPhone, because the trap only exists where there is no browser chrome.
  const page = await browser.newPage({ ...devices['iPhone 13 Pro'] });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  let savedPrefs = null;
  await page.route('**/api/prefs', (r) => {
    if (r.request().method() === 'PUT') {
      savedPrefs = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return r.continue();
  });

  // A slow-ish link: 2 MB answered after ~250ms is about 64 Mbit/s.
  let speedHits = 0;
  await page.route('**/api/speedtest*', async (r) => {
    speedHits += 1;
    const bytes = Number(new URL(r.request().url()).searchParams.get('bytes')) || 1024;
    await new Promise((res) => setTimeout(res, 250));
    return r.fulfill({ status: 200, contentType: 'application/octet-stream',
      body: Buffer.alloc(bytes) });
  });

  const jobs = [{
    id: 'big1', name: 'A Very Large Film', kind: 'movie', streamId: '99',
    ext: 'mp4', status: 'done', bytes: BIG, total: BIG,
  }];
  await page.route('**/api/downloads', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: jobs, active: null, queued: 0, freeBytes: 9e9 }) }));
  // The file itself is never actually fetched here; what matters is the
  // anchor that would fetch it.
  await page.route('**/api/downloads/*/save', (r) =>
    r.fulfill({ status: 200, contentType: 'video/mp4', body: 'PRETEND' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  /* ---- iOS is never pointed at the file at all -------------------------- */
  //
  // The screenshot that settled this: an icon, "Herman Cain impersonator,
  // Benjy's Twitter.mp4", "MPEG-4 movie - 226.9 MB", and "Open in VLC".
  // That is iOS's document preview, and inside a home-screen app there is no
  // chrome around it — no back, no done, no X. Whatever opens the file, that
  // is where it ends, so on iOS the file is never opened at all: it is
  // fetched here and handed to the share sheet, where Save to Files lives
  // and which closes like any other panel.
  console.log('\n  on iOS, nothing is ever navigated to');
  const shared = await page.evaluate(async () => {
    const navigations = [];
    const realClick = HTMLAnchorElement.prototype.click;
    const realOpen = window.open;
    HTMLAnchorElement.prototype.click = function () {
      navigations.push(`anchor:${this.getAttribute('href')}`);
    };
    window.open = (u) => { navigations.push(`open:${u}`); return {}; };

    // An iPad that can be handed files, which is every iOS 15 and later.
    const realCanShare = navigator.canShare;
    const realShare = navigator.share;
    let handed = null;
    navigator.canShare = () => true;
    navigator.share = async (data) => { handed = data; };

    // 40 MB of film, delivered in pieces so the bar has something to draw.
    const body = new Uint8Array(40 * 1024 * 1024);
    const realFetch = window.fetch;
    window.fetch = async () => new Response(
      new ReadableStream({
        start(c) {
          let at = 0;
          // Slowly enough that the bar can be caught in the act, which is
          // the whole claim being made about it.
          const push = () => {
            if (at >= body.length) return c.close();
            c.enqueue(body.subarray(at, at + 2 * 1024 * 1024));
            at += 2 * 1024 * 1024;
            setTimeout(push, 80);
          };
          push();
        },
      }),
      { headers: { 'content-length': String(body.length), 'content-type': 'video/mp4' } }
    );

    saveToDevice({ id: 'big1', name: 'A Very Large Film', ext: 'mp4',
      total: 40 * 1024 * 1024 });
    await new Promise((r) => setTimeout(r, 500));
    const midway = {
      note: document.querySelector('#saveBarNote').textContent,
      pct: document.querySelector('#saveBarPct').textContent,
    };

    // Let it finish fetching.
    for (let i = 0; i < 60 && !document.querySelector('#saveBarTap'); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const ready = {
      note: document.querySelector('#saveBarNote').textContent,
      button: document.querySelector('#saveBarTap')?.textContent || '',
      tag: document.querySelector('#saveBarTap')?.tagName || '',
    };

    document.querySelector('#saveBarTap')?.click();
    await new Promise((r) => setTimeout(r, 300));

    const out = {
      navigations, midway, ready,
      sharedName: handed?.files?.[0]?.name || '',
      sharedSize: handed?.files?.[0]?.size || 0,
      after: document.querySelector('#saveBarNote').textContent,
    };
    window.fetch = realFetch;
    window.open = realOpen;
    HTMLAnchorElement.prototype.click = realClick;
    navigator.canShare = realCanShare;
    navigator.share = realShare;
    saveBar.stop();
    return out;
  });
  console.log('   ', JSON.stringify(shared));

  check('NOTHING is navigated to — no link, no window, no preview page',
    shared.navigations.length === 0, JSON.stringify(shared.navigations));
  check('the file is fetched by the app itself, with a bar that moves',
    /MB\/s/.test(shared.midway.note) || /of 40 MB/.test(shared.midway.note),
    JSON.stringify(shared.midway));
  check('and when it is here, it offers to hand it over',
    shared.ready.tag === 'BUTTON' && /Save to device/.test(shared.ready.button),
    JSON.stringify(shared.ready));
  check('naming the panel the viewer is about to see',
    /Save to Files/.test(shared.ready.note), shared.ready.note);
  check('the tap hands over the actual file, not a link to it',
    shared.sharedName === 'A Very Large Film.mp4'
    && shared.sharedSize === 40 * 1024 * 1024,
    JSON.stringify({ name: shared.sharedName, size: shared.sharedSize }));
  check('and it says so afterwards', /Saved to this device/.test(shared.after),
    shared.after);

  /* ---- and no size at which it gives up and opens a browser ------------- */
  //
  // There was a cut-off here, at 900 MB, above which a file went down the
  // browser road instead. All that did was decide WHICH failure a big film
  // got: on iOS that road does not save, so a large file failed twice over.
  // A cut-off is worse than an attempt, so there is no cut-off.
  console.log('\n  a film far too big for the old cut-off');
  const enormous = await page.evaluate(async () => {
    const navigations = [];
    const realClick = HTMLAnchorElement.prototype.click;
    const realOpen = window.open;
    HTMLAnchorElement.prototype.click = function () {
      navigations.push(`anchor:${this.getAttribute('href')}`);
    };
    window.open = (u) => { navigations.push(`open:${u}`); return {}; };
    const realCanShare = navigator.canShare;
    navigator.canShare = () => true;
    const realFetch = window.fetch;
    let asked = '';
    window.fetch = async (u) => { asked = String(u); return new Promise(() => {}); };

    saveToDevice({ id: 'big1', name: 'A Very Large Film', ext: 'mp4',
      total: 4.4 * 1024 ** 3 });
    await new Promise((r) => setTimeout(r, 250));

    const out = { navigations, asked,
      note: document.querySelector('#saveBarNote').textContent };
    window.fetch = realFetch;
    window.open = realOpen;
    HTMLAnchorElement.prototype.click = realClick;
    navigator.canShare = realCanShare;
    saveBar.stop();
    return out;
  });
  console.log('   ', JSON.stringify(enormous));
  check('4.4 GB is still fetched here rather than handed to a browser',
    /\/api\/downloads\/big1\/save/.test(enormous.asked), enormous.asked);
  check('and still nothing is navigated to', enormous.navigations.length === 0,
    JSON.stringify(enormous.navigations));
  check('though it says plainly that this one is a lot to carry',
    /4\.40 GB/.test(enormous.note) && /big one/i.test(enormous.note), enormous.note);

  /* ---- and a way back from a save that goes wrong ----------------------- */
  //
  // A save stopping half way is ordinary — a phone sleeps, wifi drops in a
  // doorway — and the answer used to be a line of text saying "press save
  // again", which means finding the card again on a page that has moved on.
  // The button belongs where the bad news is.
  console.log('\n  a retry, on the bar, where the failure is');
  const retried = await page.evaluate(async () => {
    const realCanShare = navigator.canShare;
    navigator.canShare = () => true;
    const realFetch = window.fetch;
    let attempts = 0;
    const urls = [];
    window.fetch = async (u) => {
      attempts += 1;
      urls.push(String(u));
      throw new Error('the wifi went');
    };

    saveToDevice({ id: 'big1', name: 'A Very Large Film', ext: 'mp4',
      total: 40 * 1024 * 1024 });
    await new Promise((r) => setTimeout(r, 250));
    const failed = {
      note: document.querySelector('#saveBarNote').textContent,
      button: document.querySelector('#saveBarTap')?.textContent || '',
      tag: document.querySelector('#saveBarTap')?.tagName || '',
    };

    document.querySelector('#saveBarTap')?.click();
    await new Promise((r) => setTimeout(r, 250));

    const out = { failed, attempts, urls,
      stillOffered: Boolean(document.querySelector('#saveBarTap')) };
    window.fetch = realFetch;
    navigator.canShare = realCanShare;
    saveBar.stop();
    return out;
  });
  console.log('   ', JSON.stringify(retried));
  check('a failed save says what went wrong', /wifi went/.test(retried.failed.note),
    retried.failed.note);
  check('and offers a button to run it again, rather than a line of text',
    retried.failed.tag === 'BUTTON' && /Try again/.test(retried.failed.button),
    JSON.stringify(retried.failed));
  check('pressing it really goes back to the box', retried.attempts === 2,
    String(retried.attempts));
  check('with a fresh tracking id, so the bar counts this attempt rather',
    retried.urls.length === 2 && retried.urls[0] !== retried.urls[1],
    JSON.stringify(retried.urls));
  console.log('       than adding to the ruins of the last one');
  check('and it is still offered if that one fails too',
    retried.stillOffered === true, JSON.stringify(retried));

  // A transfer the browser owns gets the same treatment: the box reports it
  // closed and quiet, and the bar turns that into a button.
  const stalled = await page.evaluate(async () => {
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    saveToDevice({ id: 'big1', name: 'A Very Large Film', ext: 'mp4',
      total: 3.2 * 1024 ** 3 });
    saveBar.paint({ total: 100, sent: 40, ended: true, idleMs: 20000, done: false });
    await new Promise((r) => setTimeout(r, 100));
    const out = { note: document.querySelector('#saveBarNote').textContent,
      button: document.querySelector('#saveBarTap')?.textContent || '' };
    HTMLAnchorElement.prototype.click = realClick;
    saveBar.stop();
    return out;
  });
  console.log('   ', JSON.stringify(stalled));
  check('a browser download that gives up also gets a button, not advice',
    /Try again/.test(stalled.button) && /Stopped at/.test(stalled.note)
    && !/press save again/i.test(stalled.note), JSON.stringify(stalled));

  /* ---- does it actually save ------------------------------------------- */
  //
  // The check that was missing, and its absence let a version ship that
  // opened nothing at all: a real browser, a real press, and a real download
  // event. Everything else here is about HOW it is handed over; this is
  // whether it is handed over.
  console.log('\n  does a press really start a download');
  const [firstReal] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.evaluate(() => saveToDevice({ id: 'big1', name: 'A Very Large Film',
      ext: 'mp4', total: 3.2 * 1024 ** 3 })),
  ]);
  console.log('   ', firstReal && JSON.stringify({
    path: new URL(firstReal.url()).pathname, name: firstReal.suggestedFilename() }));
  check('a press in an ordinary tab really starts a download',
    Boolean(firstReal), 'nothing was downloaded');
  check('of the right file', firstReal
    && new URL(firstReal.url()).pathname === '/api/downloads/big1/save',
    firstReal && firstReal.url());
  check('named so it lands somewhere useful',
    firstReal && /A Very Large Film\.mp4/.test(firstReal.suggestedFilename()),
    firstReal && firstReal.suggestedFilename());
  await page.evaluate(() => saveBar.stop());

  /* ---- and how, in a tab versus installed ------------------------------- */
  //
  // Two different mechanisms, because the two situations break in opposite
  // directions and each fix broke the other one:
  //
  //   * a plain same-window link SAVES reliably, and installed to the home
  //     screen it replaces the app with the system file viewer, which has no
  //     way out;
  //   * target=_blank leaves the app standing, and clicked from script
  //     rather than by a finger it is a popup, gets blocked, and saves
  //     nothing at all — which is what shipped and what was reported.
  console.log('\n  how the file is handed over');
  const inTab = await page.evaluate(() => {
    const seen = [];
    const realClick = HTMLAnchorElement.prototype.click;
    const realOpen = window.open;
    HTMLAnchorElement.prototype.click = function () {
      seen.push({ kind: 'anchor', href: this.getAttribute('href'),
        download: this.getAttribute('download'), target: this.getAttribute('target') });
    };
    window.open = (u) => { seen.push({ kind: 'window.open', href: u }); return {}; };
    saveToDevice({ id: 'big1', name: 'A Very Large Film', ext: 'mp4',
      total: 3.2 * 1024 ** 3 });
    HTMLAnchorElement.prototype.click = realClick;
    window.open = realOpen;
    saveBar.stop();
    return seen;
  });
  console.log('   in a tab:   ', JSON.stringify(inTab));
  check('in an ordinary tab it is a plain link, which is the one that saves',
    inTab[0]?.kind === 'anchor' && !inTab[0]?.target, JSON.stringify(inTab[0]));
  check('asked for by its save address',
    (inTab[0]?.href || '').startsWith('/api/downloads/big1/save'), inTab[0]?.href);
  check('carrying an id the box can count the bytes against — which is the',
    /[?&]track=sv[a-z0-9]+/.test(inTab[0]?.href || ''), inTab[0]?.href);
  console.log('       only way a page can watch a download the browser owns');
  check('and named, so it lands somewhere sensible',
    inTab[0]?.download === 'A Very Large Film.mp4', inTab[0]?.download);

  /* ---- window.open is gone, and must stay gone -------------------------- */
  //
  // The fourth report, and the reason this section is a pin rather than a
  // test: "Now downloads to device brings up some screen that does not allow
  // downloads, doesn't close and has the tailscail address." That screen is
  // window.open() from a home-screen app — iOS answers it with a little
  // browser view on the raw tailnet address, showing nothing, with a close
  // button that does not close. It is strictly worse than the preview page
  // it was meant to replace: nothing is saved AND the app is buried.
  //
  // So: installed on iOS, with no way to be handed a file, the app opens
  // NOTHING and says so.
  console.log('\n  installed on iOS, with no share sheet on offer');
  const installed = await page.evaluate(async () => {
    const seen = [];
    const realOpen = window.open;
    const realMatch = window.matchMedia;
    window.matchMedia = (q) => (/standalone/.test(q)
      ? { matches: true, addEventListener() {}, removeEventListener() {} }
      : realMatch.call(window, q));
    window.open = (u, t) => { seen.push({ kind: 'window.open', href: u, target: t });
      return {}; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      seen.push({ kind: 'anchor', href: this.getAttribute('href'),
        target: this.getAttribute('target') });
    };
    // No file sharing on this pretend device — the only case that reaches
    // here at all — and the reason is the one the household actually hits:
    // the app was added from the plain-http tailnet address, so the browser
    // withholds the share sheet.
    const realCanShare = navigator.canShare;
    navigator.canShare = undefined;
    const realSecure = window.isSecureContext;
    Object.defineProperty(window, 'isSecureContext',
      { value: false, configurable: true });

    saveToDevice({ id: 'big1', name: 'A Very Large Film', ext: 'mp4',
      total: 3.2 * 1024 ** 3 });
    await new Promise((r) => setTimeout(r, 300));

    const offered = {
      shown: !document.querySelector('#saveBar').hidden,
      note: document.querySelector('#saveBarNote').textContent,
      button: document.querySelector('#saveBarTap')?.textContent || '',
      tag: document.querySelector('#saveBarTap')?.tagName || '',
    };

    // And taking it up really does save, with a word about the page iOS
    // leaves behind afterwards.
    document.querySelector('#saveBarTap')?.click();
    await new Promise((r) => setTimeout(r, 200));
    const anyway = { seen: seen.slice(),
      note: document.querySelector('#saveBarNote').textContent };

    HTMLAnchorElement.prototype.click = realClick;
    window.open = realOpen;
    window.matchMedia = realMatch;
    navigator.canShare = realCanShare;
    Object.defineProperty(window, 'isSecureContext',
      { value: realSecure, configurable: true });
    saveBar.stop();
    return { seen, offered, anyway };
  });
  console.log('   installed:  ', JSON.stringify(installed));
  check('window.open is never called — that is the blank browser page with',
    !installed.seen.some((s) => s.kind === 'window.open'),
    JSON.stringify(installed.seen));
  console.log('       the tailnet address on it and a close button that does not close');
  check('nothing happens on its own, so the app is never buried unasked',
    installed.offered.shown === true, JSON.stringify(installed.offered));
  check('it blames the address rather than the iPad, because the address is',
    /secure address/i.test(installed.offered.note)
    && !/version of iOS/i.test(installed.offered.note), installed.offered.note);
  console.log('       what is actually wrong — same device, same app, http:// in front');
  check('and names the one-off fix: add it again from the https address',
    /https:\/\//.test(installed.offered.note) && /home screen/i.test(installed.offered.note),
    installed.offered.note);
  check('while still offering the save, because it does work',
    installed.offered.tag === 'BUTTON' && /Save anyway/.test(installed.offered.button),
    JSON.stringify(installed.offered));
  check('and taking it up really starts the transfer',
    /\/api\/downloads\/big1\/save\?track=/.test(installed.anyway.seen[0]?.href || ''),
    JSON.stringify(installed.anyway.seen));
  check('with no target on it, so no second browser window is born',
    !installed.anyway.seen[0]?.target, JSON.stringify(installed.anyway.seen[0]));
  check('and a word about the file page iOS leaves over the app, and how',
    /file page/i.test(installed.anyway.note) && /reopen the app/i.test(installed.anyway.note),
    installed.anyway.note);
  console.log('       to get back from it — before it happens, not after');

  // The fallback link, wherever it is offered from, must not carry a target
  // either — a new context is the thing that produced the dead page, and a
  // finger tapping it does not make it any less dead.
  const fallback = await page.evaluate(async () => {
    saveBar.offerTap('/api/downloads/big1/save?track=x', 'A Very Large Film.mp4',
      'The browser did not start it.');
    const tap = document.querySelector('#saveBarTap');
    const out = { tag: tap?.tagName || '', target: tap?.getAttribute('target') || '',
      download: tap?.getAttribute('download') || '',
      href: tap?.getAttribute('href') || '' };
    saveBar.stop();
    return out;
  });
  console.log('   fallback:   ', JSON.stringify(fallback));
  check('the hand-it-to-a-finger link is a plain download link',
    fallback.tag === 'A' && fallback.download === 'A Very Large Film.mp4',
    JSON.stringify(fallback));
  check('with no target, because a new window is the thing that broke',
    fallback.target === '', fallback.target);

  /* ---- and it says something immediately -------------------------------- */
  //
  // Something has to happen the instant it is pressed: a multi-gigabyte
  // transfer is silent for minutes, and silence reads as a broken button.
  console.log('\n  what happens when pressed');
  const opened = await page.evaluate(async () => {
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    saveToDevice({ id: 'big1', name: 'A Very Large Film', ext: 'mp4',
      total: 3.2 * 1024 ** 3 });
    await new Promise((r) => setTimeout(r, 200));
    HTMLAnchorElement.prototype.click = realClick;
    return {
      shown: !document.querySelector('#saveBar').hidden,
      name: document.querySelector('#saveBarName').textContent,
      note: document.querySelector('#saveBarNote').textContent,
    };
  });
  console.log('   ', JSON.stringify(opened));
  check('a bar is up at once, rather than nothing at all', opened.shown,
    JSON.stringify(opened));
  check('naming what is being saved', /A Very Large Film/.test(opened.name), opened.name);
  check('and how big it is, before a single byte has moved',
    /3\.20 GB/.test(opened.note), opened.note);
  await page.evaluate(() => saveBar.stop());

  /* ---- the button on the card ------------------------------------------ */
  //
  // The card's own control was a bare <a>, which is the version of this that
  // actually swallowed the app.
  console.log('\n  the button on the download card');
  await page.evaluate(async () => {
    state.tab = 'downloads';
    openSeriesFolder = null;
    await refreshDownloads();
    renderDownloads();
  });
  await wait(800);
  const card = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#grid .dl-actions button, #grid .dl-actions a')]
      .find((b) => /Save to device/.test(b.textContent));
    return el ? { tag: el.tagName, href: el.getAttribute('href') } : null;
  });
  console.log('   ', JSON.stringify(card));
  check('the card offers it', Boolean(card), 'no Save to device on a finished download');
  check('as a button, not a bare link that would navigate the app away',
    card?.tag === 'BUTTON' && !card?.href, JSON.stringify(card));

  const fromCard = await page.evaluate(async () => {
    const seen = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      seen.push(this.getAttribute('href'));
    };
    document.querySelector('#toast').hidden = true;
    [...document.querySelectorAll('#grid .dl-actions button')]
      .find((b) => /Save to device/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 300));
    HTMLAnchorElement.prototype.click = realClick;
    return { hrefs: seen, bar: !document.querySelector('#saveBar').hidden };
  });
  console.log('   ', JSON.stringify(fromCard));
  check('pressing it goes through the same hand-over as everything else',
    /\/api\/downloads\/big1\/save\?track=/.test(fromCard.hrefs[0] || ''),
    JSON.stringify(fromCard.hrefs));
  check('and puts a bar up', fromCard.bar === true, JSON.stringify(fromCard));
  await page.evaluate(() => saveBar.stop());

  /* ---- and the same for a file straight off the drive ------------------- */
  console.log('\n  a file taken straight off the drive');
  const arch = await page.evaluate(async () => {
    const seen = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      seen.push({ target: this.getAttribute('target'),
        href: this.getAttribute('href') });
    };
    document.querySelector('#toast').hidden = true;
    saveArchiveToDevice({ path: '2019/Big_Game.mp4', title: 'Big Game',
      container: 'mp4', size: 2 * 1024 ** 3 });
    await new Promise((r) => setTimeout(r, 200));
    HTMLAnchorElement.prototype.click = realClick;
    return { seen, name: document.querySelector('#saveBarName').textContent,
      note: document.querySelector('#saveBarNote').textContent,
      shown: !document.querySelector('#saveBar').hidden };
  });
  console.log('   ', JSON.stringify(arch));
  check('it goes through the same hand-over', Boolean(arch.seen[0]?.href),
    JSON.stringify(arch.seen[0]));
  check('from the drive, with a filename and a tracking id on it',
    /archive\/file\?path=/.test(arch.seen[0]?.href || '')
    && /save=1/.test(arch.seen[0]?.href || '')
    && /track=/.test(arch.seen[0]?.href || ''),
    arch.seen[0]?.href);
  check('and it gets a bar of its own', arch.shown && /Big Game/.test(arch.name)
    && /2\.00 GB/.test(arch.note), JSON.stringify(arch));
  await page.evaluate(() => saveBar.stop());

  await browser.close();

  /* ---- and a bar over the real thing ----------------------------------- */
  //
  // "I'm not really convinced that it's downloading. I do wanna see a status
  // bar." The browser owns the transfer and will not report on it, so the
  // count comes from the end that can count: the box, as it writes the
  // response. Run here against a real server serving a real file slowly
  // enough to watch.
  console.log('\n  a bar over the real transfer');
  const { spawn } = require('child_process');
  const http = require('http');
  const path = require('path');
  const DIR = '/tmp/portal-savebar';
  const PORT = 8494;

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'store'), { recursive: true });
  fs.cpSync(PATHS.PUBLIC, path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js']) {
    fs.copyFileSync(path.join(PATHS.ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', prefs: {}, history: [] }],
  }));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: 'http://127.0.0.1:9497', username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }));
  // 6 MB, so a throttled read takes long enough to watch climb. And a much
  // larger one for the abandoned case: on loopback a small file is written
  // into the socket buffer in its entirety before a client can walk away, so
  // proving "stopped part-way" needs a file too big to swallow whole.
  fs.writeFileSync(path.join(DIR, 'store', 'big.mp4'), Buffer.alloc(6 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(DIR, 'store', 'huge.mp4'), Buffer.alloc(96 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(DIR, 'store', 'index.json'), JSON.stringify([{
    id: 'big', name: 'A Very Large Film', kind: 'movie', streamId: '99', ext: 'mp4',
    file: 'big.mp4', status: 'done', bytes: 6 * 1024 * 1024, total: 6 * 1024 * 1024,
    createdAt: Date.now(), finishedAt: Date.now(), profileId: 'own1',
  }, {
    id: 'huge', name: 'An Even Larger Film', kind: 'movie', streamId: '98', ext: 'mp4',
    file: 'huge.mp4', status: 'done', bytes: 96 * 1024 * 1024, total: 96 * 1024 * 1024,
    createdAt: Date.now(), finishedAt: Date.now(), profileId: 'own1',
  }]));

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      DOWNLOADS_ROOT: path.join(DIR, 'store') },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await wait(1500);

  const get = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

  const range = (p, from, to) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p,
      headers: { range: `bytes=${from}-${to}` } }, (res) => {
      let got = 0;
      res.on('data', (c) => { got += c.length; });
      res.on('end', () => resolve(got));
    });
  });

  try {
    // Before anything asks for it, there is nothing to report.
    const early = await get('/api/save-progress?id=sv-test');
    check('an unknown transfer is not invented', early.status === 404, String(early.status));

    /* A browser fetching a large file in pieces, which is what Safari does.
     * Pieces of one save, not several — so the count has to accumulate.
     * Ranges rather than a throttled read because over loopback the kernel
     * takes a whole file off the box's hands in milliseconds; a phone on
     * wifi does not, which is the case this bar exists for. */
    const MB = 1024 * 1024;
    await range('/api/downloads/huge/save?track=sv-test', 0, 2 * MB - 1);
    const first = JSON.parse((await get('/api/save-progress?id=sv-test')).body);
    console.log('   after 2 MB:', JSON.stringify({ sent: first.sent, total: first.total,
      done: first.done, ended: first.ended }));
    check('the box reports the bytes it has really sent',
      first.sent === 2 * MB, String(first.sent));
    check('against the whole file, so it is a real fraction',
      first.total === 96 * MB, String(first.total));
    check('with a rate, which is what the estimate is built from',
      first.bytesPerSec > 0, String(first.bytesPerSec));
    check('and it is not called finished while bytes are still owing',
      first.done === false, JSON.stringify(first));

    // Somebody who stops here — cancelled, or the wifi went — is stopped,
    // not finished, and the bar has to be able to tell those apart. But it
    // is told apart by SILENCE, not by the connection closing: a browser
    // fetching in ranges closes one and opens the next constantly.
    check('a save that stops part-way reads as stopped rather than done',
      first.ended === true && first.done === false, JSON.stringify(first));
    check('and how long it has been quiet comes with it, because a closed',
      typeof first.idleMs === 'number' && first.idleMs < 6000, String(first.idleMs));
    console.log('       connection mid-download is normal, not a failure');

    await range('/api/downloads/huge/save?track=sv-test', 2 * MB, 6 * MB - 1);
    const second = JSON.parse((await get('/api/save-progress?id=sv-test')).body);
    check('and the next piece of the same save adds to it rather than',
      second.sent === 6 * MB, `${first.sent} → ${second.sent}`);
    console.log('       starting the count again');

    // The rest of it, and the whole thing is on the device.
    const rest = await range('/api/downloads/huge/save?track=sv-test', 6 * MB, 96 * MB - 1);
    const end2 = JSON.parse((await get('/api/save-progress?id=sv-test')).body);
    console.log('   finished: ', JSON.stringify({ sent: end2.sent, done: end2.done,
      ended: end2.ended }));
    check('the whole file really goes across', rest === 90 * MB, String(rest));
    check('and the box calls it done only once nothing is owing',
      end2.done === true && end2.sent === end2.total, JSON.stringify(end2));

    // A plain, unranged save is counted too — that is the desktop shape.
    const whole = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${PORT}/api/downloads/big/save?track=sv-plain`, (res) => {
        let got = 0;
        res.on('data', (c) => { got += c.length; });
        res.on('end', () => resolve(got));
      });
    });
    await wait(200);
    const plain = JSON.parse((await get('/api/save-progress?id=sv-plain')).body);
    check('a straight download is counted the same way',
      whole === 6 * MB && plain.done === true, JSON.stringify({ whole, plain: plain.done }));
  } finally {
    server.kill('SIGKILL');
  }

  /* ---- and what that looks like on screen ------------------------------- */
  console.log('\n  the bar itself');
  const b2 = await chromium.launch();
  const p2 = await b2.newPage({ viewport: { width: 1200, height: 900 } });
  p2.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await p2.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  // A transfer that walks from nothing to done, on demand.
  let sent = 0;
  const TOTAL = 3 * 1024 ** 3;
  await p2.route('**/api/save-progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 'x', name: 'A Very Large Film', total: TOTAL, sent,
        bytesPerSec: 12 * 1048576, done: sent >= TOTAL, ended: sent >= TOTAL,
        stalled: false }) }));

  await p2.goto(BASE, { waitUntil: 'networkidle' });
  if (await p2.locator('#profileGate').isVisible()) {
    await p2.locator('.profile-tile').first().click();
    await p2.waitForTimeout(1400);
  }

  const hiddenAtRest = await p2.evaluate(() => document.querySelector('#saveBar').hidden);
  check('there is no bar when nothing is being saved', hiddenAtRest === true);

  await p2.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () {};   // do not navigate
    saveToDevice({ id: 'big', name: 'A Very Large Film', ext: 'mp4',
      total: 3 * 1024 ** 3 });
  });
  sent = 0.25 * TOTAL;
  await wait(900);
  const quarter = await p2.evaluate(() => ({
    shown: !document.querySelector('#saveBar').hidden,
    name: document.querySelector('#saveBarName').textContent,
    pct: document.querySelector('#saveBarPct').textContent,
    width: document.querySelector('#saveBarFill').style.width,
    note: document.querySelector('#saveBarNote').textContent,
  }));
  console.log('   quarter:', JSON.stringify(quarter));
  check('a bar appears the moment a save starts', quarter.shown, JSON.stringify(quarter));
  check('naming what is being saved', /A Very Large Film/.test(quarter.name), quarter.name);
  check('with a real percentage on it', quarter.pct === '25%', quarter.pct);
  check('and a bar filled to match', parseFloat(quarter.width) > 24
    && parseFloat(quarter.width) < 26, quarter.width);
  check('saying how much has gone, how fast, and how long is left',
    /of 3\.00 GB/.test(quarter.note) && /MB\/s/.test(quarter.note)
    && /left/.test(quarter.note), quarter.note);

  // Between two ranges the connection closes with bytes still owing. On a
  // phone that happens every few seconds all the way through, and calling it
  // stopped there would be a lie told over and over.
  await p2.route('**/api/save-progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 'x', name: 'A Very Large Film', total: TOTAL,
        sent: 0.5 * TOTAL, bytesPerSec: 12 * 1048576, done: false, ended: true,
        idleMs: 300, stalled: false }) }));
  await wait(900);
  const between = await p2.evaluate(() => ({
    note: document.querySelector('#saveBarNote').textContent,
    pct: document.querySelector('#saveBarPct').textContent,
  }));
  console.log('   between ranges:', JSON.stringify(between));
  check('a connection closing between pieces is not called a failure',
    !/Stopped/.test(between.note) && between.pct === '50%', JSON.stringify(between));

  // Closed AND quiet for a while is the real thing.
  await p2.route('**/api/save-progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 'x', name: 'A Very Large Film', total: TOTAL,
        sent: 0.5 * TOTAL, bytesPerSec: 12 * 1048576, done: false, ended: true,
        idleMs: 20000, stalled: false }) }));
  await wait(900);
  const reallyStopped = await p2.evaluate(() =>
    document.querySelector('#saveBarNote').textContent);
  console.log('   given up:      ', JSON.stringify(reallyStopped));
  check('but one that closed and went quiet is', /Stopped at/.test(reallyStopped),
    reallyStopped);

  await p2.evaluate(() => saveBar.stop());
  await p2.evaluate(() => {
    saveBar.watch({ id: 'x', name: 'A Very Large Film', bytes: 3 * 1024 ** 3 });
  });
  await p2.route('**/api/save-progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 'x', name: 'A Very Large Film', total: TOTAL,
        sent: TOTAL, bytesPerSec: 12 * 1048576, done: true, ended: true,
        idleMs: 100, stalled: false }) }));
  sent = TOTAL;
  await wait(900);
  const finished = await p2.evaluate(() => ({
    pct: document.querySelector('#saveBarPct').textContent,
    note: document.querySelector('#saveBarNote').textContent,
  }));
  console.log('   finished:', JSON.stringify(finished));
  check('it reaches the end and says the file is on the device',
    finished.pct === '100%' && /on this device now/.test(finished.note),
    JSON.stringify(finished));

  // And it can be put away, without pretending that cancels anything.
  await p2.evaluate(() => {
    saveBar.watch({ id: 'y', name: 'Another One', bytes: 1e9 });
  });
  await wait(300);
  await p2.locator('#saveBarClose').click();
  await wait(300);
  const closed = await p2.evaluate(() => ({
    hidden: document.querySelector('#saveBar').hidden,
    toast: document.querySelector('#toast').hidden
      ? '' : document.querySelector('#toast').textContent,
  }));
  check('it can be put away', closed.hidden === true, JSON.stringify(closed));
  check('and says plainly that hiding it does not stop the save',
    /carries on/.test(closed.toast), closed.toast);

  await p2.screenshot({ path: __dirname + '/shots/save-bar.png' });
  await b2.close();

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
