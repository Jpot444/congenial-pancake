/**
 * The suggestion box, and who sees which button.
 *
 * Hunter runs the box, so Hunter keeps the pulse. For everyone else the useful
 * thing in that corner is not a diagnostic they cannot act on — it is a way to
 * say something is broken. So the button is swapped, not added beside.
 *
 * A report goes to `reports.json` on the box and turns up in the Reports
 * section of Pi health. Nowhere else — no forward, nothing to configure,
 * nothing that can be unreachable.
 *
 * Free text is still redacted on the way in, and that is the check this leads
 * with. Nothing leaves the box now, but a bug report is very often a pasted
 * playback report, this provider puts the account password inside every stream
 * URL, and a report is a thing people copy out of the panel and paste
 * elsewhere. Stripping at the point of storage means no copy anywhere carries
 * a credential.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const BASE = 'http://127.0.0.1:8481';
// Where the portal under test keeps its files. This suite is unusual in
// reading them directly — a report is only really stored if it is on the
// box's disk — so it has to know the directory rather than only the URL.
// run.sh exports it; the fallback is its own default.
const LIVE = process.env.TEST_DIR
  || require('path').join(process.env.TMPDIR || '/tmp', 'portal-test');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({ hostname: '127.0.0.1', port: 8481, path: '/api/reports',
    method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload) } }, async (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
  });
  req.on('error', reject);
  req.end(payload);
});

/** Tell the box who is watching — the one place that answer now lives. */
const putCurrent = (id) => new Promise((resolve, reject) => {
  const payload = JSON.stringify({ id });
  const req = http.request({ hostname: '127.0.0.1', port: 8481, path: '/api/profiles/current',
    method: 'PUT', headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload) } }, (res) => {
    res.resume();
    res.on('end', resolve);
  });
  req.on('error', reject);
  req.end(payload);
});

const stored = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(LIVE, 'reports.json'), 'utf8')).reports;
  } catch {
    return [];
  }
};

// The real shape of the thing people paste: a playback report, with the
// provider's credentials sitting in the middle of every URL.
const LEAKY = `Audio is behind again.
source http://cf.boffworld.com/series/hunter99/s3cr3tP@ss/2109514.mkv
ffmpeg -i http://cf.boffworld.com/movie/hunter99/s3cr3tP@ss/881.mkv -c:v copy
error: 403 from http://cf.boffworld.com/live/hunter99/s3cr3tP@ss/12.ts`;

(async () => {
  const profiles = JSON.parse(fs.readFileSync(path.join(LIVE, 'profiles.json'), 'utf8'));
  const hunter = profiles.profiles.find((p) => p.name.toLowerCase() === 'hunter');

  // A second profile, because "everyone who is not Hunter" cannot be checked
  // with only Hunter on the box.
  let guest = profiles.profiles.find((p) => p.name === 'Dad');
  if (!guest) {
    guest = { id: 'p-test-guest', name: 'Dad', emoji: '🍿', color: '#6FA8DC',
      favorites: [], pinnedCategories: [], history: [] };
    profiles.profiles.push(guest);
    fs.writeFileSync(path.join(LIVE, 'profiles.json'), JSON.stringify(profiles, null, 2));
  }
  // Both have been here a while: tour done, notice not yet seen.
  for (const p of profiles.profiles) { p.tourDone = true; p.reportNoticeSeen = false; }
  fs.writeFileSync(path.join(LIVE, 'profiles.json'), JSON.stringify(profiles, null, 2));

  fs.rmSync(path.join(LIVE, 'reports.json'), { force: true });

  // --- credentials never leave the house -----------------------------------
  console.log('\n  what a report is allowed to carry');
  const sent = await post({ profileId: guest.id, kind: 'bug', message: LEAKY,
    context: LEAKY, contact: 'dad@example.com', version: '20.7', page: '#/movies' });
  check('the box takes it', sent.status === 200 && sent.body.ok, JSON.stringify(sent));

  const saved = stored()[0];
  const blob = JSON.stringify(saved);
  console.log('   stored title:', JSON.stringify(saved.title));
  check('the account password is not in what was stored',
    !blob.includes('s3cr3tP@ss'), blob.slice(0, 300));
  check('nor the account name', !blob.includes('hunter99'), blob.slice(0, 300));
  check('the host and the file survive, which is what makes it readable',
    saved.message.includes('cf.boffworld.com') && saved.message.includes('2109514.mkv'),
    saved.message);
  check('and it kept who sent it', saved.profile === 'Dad', saved.profile);
  check('and how to reach them', saved.contact === 'dad@example.com', saved.contact);
  check('the first line becomes the title', saved.title.startsWith('Audio is behind'),
    saved.title);

  check('and nothing pretends it went anywhere else',
    saved.github === undefined, JSON.stringify(saved.github));

  // --- rejected when empty -------------------------------------------------
  const empty = await post({ profileId: guest.id, kind: 'idea', message: '   ' });
  check('an empty report is refused rather than filed', empty.status === 400,
    JSON.stringify(empty));

  // --- only the owner can read them ----------------------------------------
  console.log('\n  who can read them');
  const asGuest = await fetch(`${BASE}/api/reports?profileId=${guest.id}`);
  const asOwner = await fetch(`${BASE}/api/reports?profileId=${hunter.id}`);
  check('another profile is turned away', asGuest.status === 403, String(asGuest.status));
  check('the owner is not', asOwner.status === 200, String(asOwner.status));
  const list = await asOwner.json();
  check('and gets what was sent', list.reports.length === 1, String(list.reports.length));

  // --- the two buttons -----------------------------------------------------
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));

  const signIn = async (who) => {
    /*
     * Told to the box, not clicked through the picker.
     *
     * Who is watching lives on the box now — one answer for the whole house,
     * because the service answers on three addresses and a browser keeps a
     * separate store per origin, so no amount of clearing localStorage here
     * would settle it. Setting it and loading the page is both the shortest
     * way in and a truer test of the thing: the box says who, and the page
     * opens as them.
     *
     * Clicking the tile is no longer usable for this anyway. The page now
     * boots straight into whoever the box names, and this suite has turned the
     * one-time notice back on for EVERY profile a few lines up — so the picker
     * arrives behind a modal that swallows the click, and dismissing it would
     * spend the very notice the checks below are waiting to see.
     */
    await putCurrent(who.id);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
  };

  console.log('\n  the corner button');
  await signIn(guest);
  const asDad = await page.evaluate(() => ({
    health: !document.querySelector('#healthBtn').hidden,
    report: !document.querySelector('#reportBtn').hidden,
    owner: profiles.data.owner,
  }));
  console.log('   Dad:', JSON.stringify(asDad));
  check('somebody who is not Hunter gets the report button', asDad.report,
    JSON.stringify(asDad));
  check('and not the pulse — swapped, not added beside it', asDad.health === false,
    JSON.stringify(asDad));

  // --- the one-time explanation -------------------------------------------
  console.log('\n  the explanation');
  const shown = await page.evaluate(() => ({
    up: !document.querySelector('#noticeModal').hidden,
    title: document.querySelector('#noticeTitle').textContent,
    body: document.querySelector('#noticeBody').textContent,
  }));
  console.log('   notice:', JSON.stringify(shown.title));
  check('an account that was already here is told the button changed', shown.up,
    JSON.stringify(shown));
  check('and told what it does now', /report button/i.test(shown.body), shown.body);
  await page.locator('#noticeClose').click();
  await page.waitForTimeout(600);
  check('it is written down so it does not come back',
    (await page.evaluate(() => profiles.data.reportNoticeSeen)) === true);

  await signIn(guest);
  const again = await page.evaluate(() => !document.querySelector('#noticeModal').hidden);
  check('and it does not, on the next sign-in', again === false);

  // --- sending one --------------------------------------------------------
  console.log('\n  sending one');
  await page.locator('#reportBtn').click();
  await page.waitForTimeout(400);
  const form = await page.evaluate(() => ({
    up: !document.querySelector('#reportModal').hidden,
    title: document.querySelector('#reportTitle').textContent,
    kinds: [...document.querySelectorAll('#reportKind button')].map((b) => b.textContent.trim()),
  }));
  console.log('   form:', JSON.stringify(form));
  check('the form opens', form.up, JSON.stringify(form));
  check('offering both a problem and an idea',
    form.kinds.length === 2, JSON.stringify(form.kinds));

  await page.locator('#reportKind button[data-kind="idea"]').click();
  await page.waitForTimeout(200);
  check('picking an idea changes what it is asking for',
    /suggest/i.test(await page.locator('#reportTitle').textContent()),
    await page.locator('#reportTitle').textContent());

  await page.locator('#reportMessage').fill('Let me sort favourites by hand');
  await page.locator('#reportSubmit').click();
  await page.waitForTimeout(1200);
  const after = stored();
  console.log('   newest:', JSON.stringify(after[0].message));
  check('it closes once sent',
    (await page.evaluate(() => document.querySelector('#reportModal').hidden)) === true);
  check('and the box has it',
    after[0].message === 'Let me sort favourites by hand', after[0].message);
  check('filed as an idea rather than a bug', after[0].kind === 'idea', after[0].kind);
  check('against the profile that sent it', after[0].profile === 'Dad', after[0].profile);

  // Nothing sends with an empty box.
  await page.locator('#reportBtn').click();
  await page.waitForTimeout(300);
  await page.locator('#reportSubmit').click();
  await page.waitForTimeout(500);
  const refused = await page.evaluate(() => ({
    up: !document.querySelector('#reportModal').hidden,
    err: document.querySelector('#reportError').hidden
      ? '' : document.querySelector('#reportError').textContent,
  }));
  check('an empty one says so instead of closing',
    refused.up && refused.err.length > 0, JSON.stringify(refused));
  check('and nothing extra reached the box', stored().length === after.length,
    `${after.length} → ${stored().length}`);
  await page.locator('#reportCancel').click();

  // --- Hunter's side -------------------------------------------------------
  console.log('\n  Hunter');
  await signIn(hunter);
  const asHunter = await page.evaluate(() => ({
    health: !document.querySelector('#healthBtn').hidden,
    report: !document.querySelector('#reportBtn').hidden,
    owner: profiles.data.owner,
    notice: !document.querySelector('#noticeModal').hidden,
  }));
  console.log('   Hunter:', JSON.stringify(asHunter));
  check('Hunter keeps the pulse', asHunter.health && !asHunter.report,
    JSON.stringify(asHunter));
  check('and the server is the one that says so', asHunter.owner === true);
  check('and is told people can now write to him', asHunter.notice);
  await page.locator('#noticeClose').click();
  await page.waitForTimeout(400);

  await page.locator('#healthBtn').click();
  await page.waitForTimeout(1500);
  const panel = await page.evaluate(() => ({
    up: !document.querySelector('#reportsPanel').hidden,
    count: document.querySelector('#reportsCount').textContent,
    rows: [...document.querySelectorAll('.report')].map((r) => ({
      who: r.querySelector('.report-who').textContent,
      tag: r.querySelector('.report-tag').textContent,
      body: r.querySelector('.report-body').textContent.slice(0, 40),
    })),
    hasSend: Boolean(document.querySelector('#reportsSend')),
  }));
  console.log('   panel:', JSON.stringify(panel, null, 1));
  check('Pi health has a Reports section', panel.up, JSON.stringify(panel));
  check('with everything that was sent in it',
    panel.rows.length === stored().length, `${panel.rows.length} vs ${stored().length}`);
  check('each one saying who and which kind',
    panel.rows.every((r) => r.who && r.tag), JSON.stringify(panel.rows));
  check('newest first, so the thing just sent is at the top',
    panel.rows[0].body.startsWith(stored()[0].message.slice(0, 20)),
    JSON.stringify({ panel: panel.rows[0].body, stored: stored()[0].message.slice(0, 40) }));
  check('and Hunter can send one too — he is not the only one who finds bugs',
    panel.hasSend);

  // The leaked-credential report is on this screen; it must be clean here too.
  const onScreen = await page.evaluate(() =>
    document.querySelector('#reportsList').textContent);
  check('no credential is on the screen either',
    !onScreen.includes('s3cr3tP@ss') && !onScreen.includes('hunter99'),
    onScreen.slice(0, 200));

  await page.screenshot({ path: __dirname + '/shots/reports.png' });
  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
