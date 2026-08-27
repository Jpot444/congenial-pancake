/**
 * What a download is, said honestly.
 *
 * The feature was described as offline viewing and that was a lie: reaching the
 * player means reaching the Pi, so a file on the Pi is exactly as unreachable as
 * the stream when the wifi is out. The tour went further and claimed it "plays
 * even when the wifi shits the bed", which is the sentence that made somebody
 * believe the wrong thing.
 *
 * What is on the Pi is a **cache** — no provider connection, no waiting, and
 * several people at once. The copy that is genuinely yours is the one **Save to
 * device** makes, and that button existed all along at the bottom of a list
 * nobody had a reason to go back to.
 *
 * It cannot skip the Pi, and the checks below stand behind that rather than
 * leaving it as an assertion: the file offered is the converted MP4, because the
 * provider sends .mkv and no phone will open one.
 */
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const APP = fs.readFileSync(PATHS.APP, 'utf8');
const HTML = fs.readFileSync(PATHS.INDEX, 'utf8');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A film mid-download, so the poll can be watched crossing into done.
const RUNNING = {
  id: 'dl1', name: 'The Long Ride Home', kind: 'movie', streamId: 901,
  ext: 'mkv', status: 'downloading', bytes: 5e8, total: 2e9, preparing: false,
};
const CONVERTING = { ...RUNNING, status: 'done', bytes: 2e9, preparing: true };
const READY = { ...RUNNING, status: 'done', bytes: 1.8e9, total: 1.8e9,
  ext: 'mp4', preparing: false };

(async () => {
  // --- the copy ------------------------------------------------------------
  console.log('\n  what it says it does');
  check('nothing calls the box copy an offline copy any more',
    !/for offline/i.test(HTML) && !/for offline/i.test(APP),
    'still says "for offline"');
  check('and the tour no longer claims it survives the wifi going down',
    !/wifi shits the bed/.test(APP), 'the tour still promises offline');
  check('the player button says where it actually puts it',
    /title="Save to the box"/.test(HTML), 'the download button label is unchanged');
  check('and the tour points at the step that does give you it offline',
    /Save\s*'?\s*\+?\s*'?\s*to device/.test(APP) || /Save to device/.test(APP),
    'the tour does not mention Save to device');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  let jobs = [RUNNING];
  await page.route('**/api/downloads', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: jobs, active: null, queued: 0 }) }));
  // The save itself, stubbed so nothing has to move gigabytes to prove it.
  await page.route('**/api/downloads/*/save', (r) =>
    r.fulfill({ status: 200, contentType: 'video/mp4',
      headers: { 'content-disposition': 'attachment; filename="The Long Ride Home.mp4"' },
      body: 'not really a film' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await page.evaluate(async () => {
    profiles.data.dlExplainSeen = false;
    await profiles.save();
  });

  // --- the explanation on the page -----------------------------------------
  console.log('\n  the two steps, on the page');
  await page.evaluate(() => { location.hash = '#/downloads'; render(); });
  await wait(700);
  const explain = await page.evaluate(() => {
    const box = document.querySelector('.dl-explain');
    return box ? { text: box.textContent.replace(/\s+/g, ' ').trim(),
      brief: box.classList.contains('is-brief') } : null;
  });
  console.log('   explainer:', JSON.stringify(explain?.text?.slice(0, 90)));
  check('Downloads explains what the two steps are', Boolean(explain), 'no explainer');
  check('saying plainly that the box copy still needs the Pi',
    /no use with the wifi down/i.test(explain.text), explain.text);
  check('and that Save to device is the one that lives on your phone',
    /Save to device/.test(explain.text), explain.text);
  check('and why it cannot go straight there — the password and the container',
    /password/.test(explain.text) && /mkv/i.test(explain.text), explain.text);
  check('it starts open, since it is the thing that was misunderstood',
    explain.brief === false, JSON.stringify(explain.brief));

  // Read once, then out of the way — and remembered.
  await page.locator('.dl-explain-x').click();
  await wait(600);
  const put = await page.evaluate(() => ({
    brief: document.querySelector('.dl-explain').classList.contains('is-brief'),
    stored: profiles.data.dlExplainSeen,
  }));
  check('it can be put away', put.brief, JSON.stringify(put));
  check('and stays away on the profile', put.stored === true, JSON.stringify(put));
  await page.evaluate(() => { location.hash = '#/live'; render(); });
  await wait(300);
  await page.evaluate(() => { location.hash = '#/downloads'; render(); });
  await wait(500);
  check('so it comes back small rather than in full next time',
    await page.evaluate(() =>
      document.querySelector('.dl-explain').classList.contains('is-brief')));

  // --- the offer, when there is something to offer -------------------------
  console.log('\n  offered when it is ready');
  // Still converting: offering now would hand over the .mkv, which is the whole
  // dead end this change is about.
  jobs = [CONVERTING];
  await page.evaluate(() => refreshDownloads({ rerender: true }));
  await wait(600);
  check('nothing is offered while the Pi is still converting it',
    await page.locator('#toast').isHidden());

  jobs = [READY];
  await page.evaluate(() => refreshDownloads({ rerender: true }));
  await wait(600);
  const offer = await page.evaluate(() => ({
    up: !document.querySelector('#toast').hidden,
    text: document.querySelector('#toast').textContent,
    action: document.querySelector('.toast-action')?.textContent || '',
  }));
  console.log('   offer:', JSON.stringify(offer));
  check('once the MP4 exists, the device copy is offered', offer.up, JSON.stringify(offer));
  check('naming the thing it finished', /Long Ride Home/.test(offer.text), offer.text);
  check('with one thing to do about it', offer.action === 'Save to device', offer.action);

  // Pressing it starts a real browser download — which is the point, and is
  // why this waits for the download event rather than for a routed request:
  // a `download` link is handled outside the page's own fetching.
  const [got] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.locator('.toast-action').click(),
  ]);
  await wait(400);
  console.log('   download:', got && JSON.stringify({
    url: new URL(got.url()).pathname, name: got.suggestedFilename() }));
  check('pressing it hands the file to the browser to save',
    Boolean(got), 'no download started');
  check('asking the box for that download',
    got && new URL(got.url()).pathname === '/api/downloads/dl1/save',
    got && got.url());
  check('and it arrives named as an mp4, which is what a phone will open',
    got && /\.mp4$/.test(got.suggestedFilename()), got && got.suggestedFilename());
  check('as a link rather than a blob, since a film will not fit in memory',
    /a\.download = /.test(APP) && !/createObjectURL/.test(APP.split('function saveToDevice')[1] || ''),
    'saveToDevice builds a blob');
  // The offer is replaced by confirmation that it started, not by silence:
  // a multi-gigabyte transfer shows nothing for minutes, and a button that
  // appears to do nothing is the complaint that put this here.
  await wait(400);
  const afterPress = await page.evaluate(() => ({
    offerUp: !document.querySelector('#toast').hidden,
    text: document.querySelector('#toast').hidden
      ? '' : document.querySelector('#toast').textContent,
    bar: !document.querySelector('#saveBar').hidden,
    barName: document.querySelector('#saveBarName').textContent,
  }));
  check('the offer stops being an offer once taken',
    !afterPress.offerUp && !/Save it to this device\?/.test(afterPress.text),
    JSON.stringify(afterPress));
  // What replaces it is a bar over the real transfer — see savedevice.test.js
  // for the counting behind it. What must never happen is silence, which is
  // what a three-gigabyte save used to give you.
  check('and a bar over the real transfer takes its place',
    afterPress.bar && /Long Ride Home/.test(afterPress.barName),
    JSON.stringify(afterPress));
  await page.evaluate(() => saveBar.stop());

  // --- it is an offer, not a nag -------------------------------------------
  console.log('\n  not a nag');
  await page.evaluate(() => {
    // Clear whatever the save just said, so what is measured is a fresh
    // OFFER rather than the confirmation of the one already taken.
    document.querySelector('#toast').hidden = true;
    return refreshDownloads({ rerender: true });
  });
  await wait(600);
  const reoffered = await page.evaluate(() => (document.querySelector('#toast').hidden
    ? '' : document.querySelector('#toast').textContent));
  check('a download already finished is not offered again on the next poll',
    !/Save it to this device\?/.test(reoffered), reoffered);

  // Nor is everything already on the box offered the moment you open the app.
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }
  await wait(1200);
  check('nor is a boxful offered all at once on the first poll of a session',
    await page.locator('#toast').isHidden());

  // --- the button is still in the list -------------------------------------
  console.log('\n  and still where it was');
  await page.evaluate(() => { location.hash = '#/downloads'; render(); });
  await wait(700);
  // A BUTTON now, not a bare link. As a plain same-window <a> this replaced
  // the whole app with the system's video viewer, which on a home-screen
  // install has no way back — see savedevice.test.js.
  const inList = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('#grid .dl-actions button, #grid .dl-actions a')]
      .find((x) => x.textContent === 'Save to device');
    if (!b) return null;
    const seen = [];
    const real = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      seen.push({ href: this.getAttribute('href'), dl: this.getAttribute('download'),
        target: this.getAttribute('target') });
    };
    b.click();
    await new Promise((r) => setTimeout(r, 200));
    HTMLAnchorElement.prototype.click = real;
    return { tag: b.tagName, href: b.getAttribute('href'), handed: seen[0] || null };
  });
  console.log('   in the list:', JSON.stringify(inList));
  check('every finished download still carries its own Save to device',
    Boolean(inList), 'the list button went missing');
  check('as a button rather than a link that would navigate the app away',
    inList.tag === 'BUTTON' && !inList.href, JSON.stringify(inList));
  check('pointed at the same file, with an id the box counts the bytes against',
    (inList.handed?.href || '').startsWith('/api/downloads/dl1/save')
    && /track=/.test(inList.handed?.href || ''), JSON.stringify(inList.handed));
  check('naming it as an mp4, which is what a phone will open',
    /\.mp4$/.test(inList.handed?.dl || ''), inList.handed?.dl);
  // In a tab this is a plain named link, which is the form that reliably
  // saves. Installed to the home screen it goes to a separate window
  // instead, so the app is never replaced — savedevice.test.js drives both.
  check('as a plain named link in a tab, which is the form that saves',
    !inList.handed?.target && /\.mp4$/.test(inList.handed?.dl || ''),
    JSON.stringify(inList.handed));
  await page.evaluate(() => saveBar.stop());

  await page.screenshot({ path: __dirname + '/shots/downloads.png' });
  // --- resume all -----------------------------------------------------------
  //
  // Paused work gets one button back to running. Paused ONLY — a failed
  // download retries itself on the box's own schedule now, and sweeping
  // those in would re-run known-broken downloads on every press.
  console.log('\n  resume all');
  const retried = [];
  await page.route('**/api/downloads/*/retry', (r) => {
    retried.push(r.request().url().match(/downloads\/([\w-]+)\/retry/)[1]);
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  jobs = [
    { id: 'p1', name: 'Paused One', kind: 'movie', streamId: 'm1', status: 'paused', bytes: 10, total: 100, ext: 'mp4' },
    { id: 'p2', name: 'Paused Two', kind: 'movie', streamId: 'm2', status: 'paused', bytes: 20, total: 100, ext: 'mp4' },
    { id: 'e1', name: 'Broken', kind: 'movie', streamId: 'm3', status: 'error', error: 'x', bytes: 0, total: 0, ext: 'mp4' },
    { id: 'd1', name: 'Done', kind: 'movie', streamId: 'm4', status: 'done', bytes: 100, total: 100, ext: 'mp4' },
  ];
  await page.evaluate(async () => {
    state.tab = 'downloads';
    openSeriesFolder = null;   // earlier sections browsed into a show
    await refreshDownloads();
    renderDownloads();
  });
  await wait(700);
  const btn = await page.evaluate(() => document.querySelector('.resume-all')?.textContent || '');
  check('the button appears when something is paused, and counts it',
    btn === 'Resume all (2)', btn);
  await page.locator('.resume-all').click();
  await wait(900);
  check('pressing it wakes every paused download', retried.sort().join(',') === 'p1,p2',
    JSON.stringify(retried));
  check('and leaves failed ones to the box\'s own schedule', !retried.includes('e1'),
    JSON.stringify(retried));

  // --- nothing to press about optimizing or retrying ------------------------
  //
  // Both buttons were asking the viewer to do the box's job. What the card
  // shows now is a report, not a request.
  console.log('\n  the two buttons that were asking you to do its job');
  jobs = [
    { id: 'u1', name: 'Still Matroska', kind: 'movie', streamId: 'm7', status: 'done',
      bytes: 100, total: 100, ext: 'mkv' },
    { id: 'u2', name: 'Converting Now', kind: 'movie', streamId: 'm8', status: 'done',
      bytes: 100, total: 100, ext: 'mkv', preparing: true },
    { id: 'f1', name: 'Failed Retryable', kind: 'movie', streamId: 'm9', status: 'error',
      error: 'Provider returned HTTP 502', tries: 1, bytes: 0, total: 0, ext: 'mp4' },
    { id: 'f2', name: 'Failed For Good', kind: 'movie', streamId: 'm10', status: 'error',
      error: 'That is 9 GB and you have 1 GB left.', permanent: true, tries: 1,
      bytes: 0, total: 0, ext: 'mp4' },
  ];
  await page.evaluate(async () => {
    state.tab = 'downloads';
    openSeriesFolder = null;
    await refreshDownloads();
    renderDownloads();
  });
  await wait(700);
  const cards = await page.evaluate(() => {
    const out = {};
    for (const card of document.querySelectorAll('#grid .card')) {
      const name = card.querySelector('.card-title')?.textContent || '';
      out[name] = {
        sub: card.querySelector('.card-sub')?.textContent || '',
        buttons: [...card.querySelectorAll('.dl-actions button, .dl-actions a')]
          .map((b) => b.textContent),
      };
    }
    return out;
  });
  console.log('   ', JSON.stringify(cards));
  check('an unoptimized download offers no button to press',
    !cards['Still Matroska']?.buttons.some((b) => /Optimi[sz]e/.test(b)),
    JSON.stringify(cards['Still Matroska']));
  check('it just says the box is getting to it',
    /Optimizing shortly/.test(cards['Still Matroska']?.sub || ''),
    cards['Still Matroska']?.sub);
  check('and one mid-conversion says so', /Optimizing for instant/.test(
    cards['Converting Now']?.sub || ''), cards['Converting Now']?.sub);
  check('a failed download offers no Retry either',
    !cards['Failed Retryable']?.buttons.some((b) => /Retry/.test(b)),
    JSON.stringify(cards['Failed Retryable']));
  check('it says it will have another go by itself',
    /trying again shortly/.test(cards['Failed Retryable']?.sub || ''),
    cards['Failed Retryable']?.sub);
  check('while one that cannot be fixed by trying says only what went wrong',
    !/trying again/.test(cards['Failed For Good']?.sub || '')
    && /GB left/.test(cards['Failed For Good']?.sub || ''),
    cards['Failed For Good']?.sub);
  check('and every one of them can still be removed',
    (await page.evaluate(() => document.querySelectorAll('#grid .dl-remove').length)) === 4);

  jobs = jobs.map((j) => (j.status === 'paused' ? { ...j, status: 'queued' } : j));
  await page.evaluate(async () => { await refreshDownloads(); renderDownloads(); });
  await wait(500);
  const gone = await page.evaluate(() => Boolean(document.querySelector('.resume-all')));
  check('with nothing paused the button does not exist', gone === false, String(gone));


  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
