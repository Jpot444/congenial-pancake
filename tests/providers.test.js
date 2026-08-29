/**
 * A second login, and the panel that manages them.
 *
 * Every limit this box has comes from one fact: the provider sells a
 * connection, and one connection plays one thing. A download pauses the
 * moment somebody presses play; the credits crawler only runs when the house
 * is quiet; multi-view warns it may not hold four cells. A second login is
 * the only thing that changes any of that, so what is tested here is the
 * arithmetic of slots — not that the panel renders, but that two logins
 * really do mean two streams and that the box says no when they are gone.
 *
 * Three parts, cheapest first:
 *
 *   1. the pool itself, in process — leases, reservations, and whose URL is
 *      whose, which is the part everything else stands on
 *   2. the endpoints, against a real box and a provider panel of our own —
 *      adding a login, refusing the wrong one, and removing the last one,
 *      which is the old "disconnect provider"
 *   3. the screen, in a browser — because "when does each subscription
 *      expire" is the question the panel exists to answer, and an expiry
 *      the page does not print is not an answer
 *
 * The claim guarded most carefully: no password ever leaves the box. It is
 * typed in and never read back, and every response in part 2 is searched for
 * one.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-providers';
const PORT = 8495;
const PANEL = 9497;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const DAY = 86400000;
const SECONDS = (ms) => Math.floor(ms / 1000);

/* The two logins the provider will admit to, and what it says about each. */
const LOGINS = {
  u: {
    auth: 1, status: 'Active', is_trial: '0',
    exp_date: String(SECONDS(Date.now() + 30 * DAY)),
    max_connections: '1', active_cons: '0',
  },
  u2: {
    auth: 1, status: 'Active', is_trial: '1',
    exp_date: String(SECONDS(Date.now() + 1 * DAY)),
    max_connections: '1', active_cons: '0',
  },
};

(async () => {
  /* ═══ 1. the pool ═══════════════════════════════════════════════════════ */
  console.log('\n  one login, one stream');
  const providers = require(path.join(ROOT, 'providers.js'));

  const ONE = { mode: 'xtream', host: 'http://box', username: 'u', password: 'p' };
  check('a box configured before any of this reads as one login',
    providers.accounts(ONE).length === 1, JSON.stringify(providers.accounts(ONE)));
  check('and is assumed to allow one connection until the panel says otherwise',
    providers.capacity(ONE) === 1, String(providers.capacity(ONE)));

  const first = providers.pick(ONE);
  check('which is the one you get', first && first.username === 'u', JSON.stringify(first));
  const releaseFirst = providers.take(first.id);
  check('taking it leaves nothing to start a second stream with',
    providers.busy(ONE) === true && providers.free(ONE) === 0,
    `${providers.busy(ONE)}/${providers.free(ONE)}`);
  check('and asking again gets nothing rather than the same account twice',
    providers.pick(ONE) === null, JSON.stringify(providers.pick(ONE)));

  /* A metadata call is not a stream. Refusing one on a busy box would be a
     new failure, not a saved connection — the box asked anyway for its whole
     life before the pool existed. */
  check('a guide lookup still gets a login, busy or not',
    Boolean(providers.forMeta(ONE)), JSON.stringify(providers.forMeta(ONE)));

  releaseFirst();
  releaseFirst();   // every caller is an I/O path with more than one ending
  check('letting go gives the slot back, however many times it is let go of',
    providers.free(ONE) === 1, String(providers.free(ONE)));

  console.log('\n  two logins, two streams');
  const TWO = {
    mode: 'xtream', host: 'http://box', username: 'u', password: 'p',
    accounts: [
      { id: 'p1', host: 'http://box', username: 'u', password: 'p' },
      { id: 'p2', host: 'http://box', username: 'u2', password: 'p2', label: 'Trial' },
    ],
  };
  check('the house can run two things at once', providers.capacity(TWO) === 2,
    String(providers.capacity(TWO)));

  const a = providers.pick(TWO);
  const releaseA = providers.take(a.id);
  const b = providers.pick(TWO);
  check('the second stream goes to the OTHER login, not the busy one',
    b && b.id !== a.id, `${a && a.id} then ${b && b.id}`);
  const releaseB = providers.take(b.id);
  check('and with both taken the box is out of connections again',
    providers.busy(TWO) === true, String(providers.busy(TWO)));
  check('which is the whole point: one playing does not stop the next one',
    providers.inUse(TWO) === 2, String(providers.inUse(TWO)));
  releaseA();
  releaseB();

  /* The URL is built in one request and the pipe opens in the next. Without
     a reservation both requests pick the same free account and the second
     stream fails on a login already in use. */
  console.log('\n  the gap between choosing a login and connecting on it');
  const held = providers.pick(TWO, { reserve: true });
  const alsoHeld = providers.pick(TWO, { reserve: true });
  check('two streams starting together are sent to different logins',
    held.id !== alsoHeld.id, `${held.id} / ${alsoHeld.id}`);
  check('a reservation counts against the pool while it stands',
    providers.free(TWO) === 0, String(providers.free(TWO)));
  const releaseHeld = providers.take(held.id);
  check('and claiming it does not then count twice',
    providers.inUse(TWO) === 1 && providers.free(TWO) === 0,
    `${providers.inUse(TWO)}/${providers.free(TWO)}`);
  releaseHeld();
  providers.unreserve(alsoHeld.id);
  check('a reservation nobody claims is given up',
    providers.free(TWO) === 2, String(providers.free(TWO)));

  /* Each reservation has to die on its own schedule — and the case that
     proves it is TWO reservations on the SAME login, which is what a panel
     that allows two connections gives you. Held as a count with one shared
     deadline, the second reservation pushes the deadline out and keeps the
     first alive past its time; ask a few times in a row and the account reads
     as full with nothing playing on it, which is the "0 free and nothing on"
     the panel would then report. */
  console.log('\n  reservations expire one at a time');
  const RESERVE_MS = 20000;
  const ROOMY = {
    mode: 'xtream', host: 'http://box', username: 'r', password: 'p',
    accounts: [{ id: 'pR', host: 'http://box', username: 'r', password: 'p' }],
  };
  providers.note('pR', { max_connections: '2', status: 'Active' });
  check('one login the panel says carries two connections',
    providers.capacity(ROOMY) === 2, String(providers.capacity(ROOMY)));

  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    providers.pick(ROOMY, { reserve: true });
    clock += 15000;                              // 5s of the first one left
    providers.pick(ROOMY, { reserve: true });    // a second, on the SAME login
    check('two reservations fifteen seconds apart are both standing',
      providers.free(ROOMY) === 0, String(providers.free(ROOMY)));
    clock += 6000;                               // the first one's time is up
    check('and the older one expires on its own time, not the newer one\'s',
      providers.free(ROOMY) === 1, String(providers.free(ROOMY)));
    clock += RESERVE_MS;
    check('with nothing left holding anything once both have run out',
      providers.free(ROOMY) === 2, String(providers.free(ROOMY)));
  } finally {
    Date.now = realNow;
  }
  providers.forget('pR');

  console.log('\n  whose stream is whose');
  const urlFor = (user) => `http://box/live/${user}/pw/123.m3u8`;
  check('a URL is traced back to the login written into it',
    providers.forUrl(TWO, urlFor('u2'))?.id === 'p2',
    JSON.stringify(providers.forUrl(TWO, urlFor('u2'))));
  /* 'u' is a substring of 'u2'; the longest match has to win or every stream
     on the second login hands its slot back to the first. */
  check("and 'u' does not answer for 'u2'",
    providers.forUrl(TWO, urlFor('u'))?.id === 'p1',
    JSON.stringify(providers.forUrl(TWO, urlFor('u'))));

  console.log('\n  what the provider says about each');
  providers.note('p2', LOGINS.u2);
  const noted = providers.report(TWO).find((r) => r.id === 'p2');
  check('the expiry is the provider\'s own date, not the day it was added',
    Math.abs(noted.expiresAt - (Date.now() + DAY)) < 5000, String(noted.expiresAt));
  check('counted in days, because that is what makes anyone act on it',
    noted.daysLeft === 0 || noted.daysLeft === 1, String(noted.daysLeft));
  check('a trial says it is a trial', noted.trial === true, String(noted.trial));
  check('and no password is anywhere in the report',
    !JSON.stringify(providers.report(TWO)).includes('p2"') || !('password' in noted),
    JSON.stringify(noted));
  providers.forget('p1');
  providers.forget('p2');

  /* ═══ 2. the endpoints ══════════════════════════════════════════════════ */
  console.log('\n  a box, and a provider panel of its own');

  const panel = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const user = url.searchParams.get('username');
    const pass = url.searchParams.get('password');
    const expect = { u: 'p', u2: 'p2' }[user];
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!expect || pass !== expect) return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    return res.end(JSON.stringify({
      user_info: { username: user, ...LOGINS[user] },
      server_info: {},
    }));
  });
  await new Promise((r) => panel.listen(PANEL, '127.0.0.1', r));

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js', 'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`, username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{
      id: 'own1', name: 'Hunter', emoji: '', color: '',
      prefs: { tourDone: true, liveTourDone: true, reportNoticeSeen: true, dlExplainSeen: true },
      history: [],
    }],
  }));

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const call = (p, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: body ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(text); } catch { /* not json, keep the text */ }
        resolve({ status: res.statusCode, body: text, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  for (let i = 0; i < 40; i += 1) {
    try {
      await call('/');
      break;
    } catch {
      await wait(250);
    }
  }

  const seen = [];   // every response body, searched for a password at the end

  try {
    console.log('\n  what the box says about the login it has');
    const one = await call('/api/providers');
    seen.push(one.body);
    const only = (one.data.accounts || [])[0] || {};
    console.log('   login:', JSON.stringify(only));
    check('one login, described', one.data.accounts?.length === 1, String(one.status));
    check('with the provider\'s expiry on it, asked of the provider',
      only.expiresAt && Math.abs(only.expiresAt - (Date.now() + 30 * DAY)) < 60000,
      String(only.expiresAt));
    check('and the days that follow from it', only.daysLeft === 29 || only.daysLeft === 30,
      String(only.daysLeft));
    check('the house can run one thing at once', one.data.capacity === 1,
      String(one.data.capacity));

    console.log('\n  a login that is not from this provider');
    const elsewhere = await call('/api/providers', 'POST', {
      host: 'http://somewhere.else', username: 'x', password: 'y',
    });
    seen.push(elsewhere.body);
    check('is refused, because the library is keyed by THIS provider\'s ids',
      elsewhere.status === 400 && /same provider/i.test(elsewhere.data.error || ''),
      `${elsewhere.status} ${elsewhere.data.error}`);

    console.log('\n  a login this provider does not know');
    const wrong = await call('/api/providers', 'POST', { username: 'u2', password: 'nope' });
    seen.push(wrong.body);
    check('is checked before it is stored, not after it fails to play',
      wrong.status === 401, `${wrong.status} ${wrong.data.error}`);
    check('and nothing was written', JSON.parse(
      fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).accounts === undefined
      || JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).accounts.length === 1,
      fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));

    console.log('\n  the second subscription');
    const added = await call('/api/providers', 'POST', {
      username: 'u2', password: 'p2', label: 'Trial',
    });
    seen.push(added.body);
    check('is accepted', added.status === 200, `${added.status} ${added.data.error}`);
    check('and the house can now run two things at once', added.data.capacity === 2,
      String(added.data.capacity));
    const trial = (added.data.accounts || []).find((r) => r.username === 'u2') || {};
    check('the trial says when it runs out, which is the day after tomorrow at most',
      trial.daysLeft !== null && trial.daysLeft <= 1, JSON.stringify(trial));
    check('and says it is a trial', trial.trial === true, String(trial.trial));

    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
    check('both logins are on disk', stored.accounts?.length === 2,
      JSON.stringify(stored.accounts?.map((x) => x.username)));
    check('in the file the box keeps to itself',
      (fs.statSync(path.join(DIR, 'config.json')).mode & 0o777) === 0o600,
      (fs.statSync(path.join(DIR, 'config.json')).mode & 0o777).toString(8));

    const cfg = await call('/api/config');
    seen.push(cfg.body);
    check('and the app is told how much room it has',
      cfg.data.logins === 2 && cfg.data.capacity === 2, JSON.stringify(cfg.data));

    console.log('\n  taking one away');
    const gone = await call(`/api/providers/${stored.accounts[0].id}`, 'DELETE');
    seen.push(gone.body);
    check('leaves the other one', gone.data.accounts?.length === 1,
      JSON.stringify(gone.data.accounts?.map((x) => x.username)));
    const after = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
    /* The loose fields are what older call sites still read. Left pointing at
       a login that has been removed, the box authenticates as nobody. */
    check('and points the box at a login that still exists',
      after.username === 'u2' && after.password === 'p2', JSON.stringify(after.username));

    console.log('\n  and taking the last one away');
    const last = await call(`/api/providers/${after.accounts[0].id}`, 'DELETE');
    seen.push(last.body);
    check('is the old disconnect: the box goes back to setup',
      last.data.configured === false, JSON.stringify(last.data));
    check('with the config removed', !fs.existsSync(path.join(DIR, 'config.json')),
      String(fs.existsSync(path.join(DIR, 'config.json'))));

    console.log('\n  the one that matters');
    const leaked = seen.filter((body) => /"p2"|"password"|"p"\s*:/.test(body)
      && /password/i.test(body));
    check('no password appears in anything the box answered',
      leaked.length === 0, leaked.join(' | ').slice(0, 300));
  } finally {
    server.kill();
    panel.close();
  }

  /* ═══ 3. the screen ═════════════════════════════════════════════════════ */
  console.log('\n  the panel behind the button');
  const { chromium } = require('./playwright.js');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());

  /* The shared box in run.sh is an m3u box with no provider, which is fine:
     this part is about what the panel draws when it is handed accounts, so
     the box is asked and the answer is ours. */
  const IN_TWO_DAYS = Date.now() + 2 * DAY;
  const IN_A_YEAR = Date.now() + 365 * DAY;
  await page.route('**/api/providers**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      free: 1,
      inUse: 1,
      capacity: 2,
      accounts: [
        { id: 'p1', label: '', username: 'hunter', host: 'http://panel', slots: 1,
          streams: 1, activeCons: 1, maxConnections: 1, expiresAt: IN_A_YEAR,
          daysLeft: 365, expired: false, status: 'Active', trial: false,
          checkedAt: Date.now(), error: '' },
        { id: 'p2', label: 'Trial', username: 'hunter2', host: 'http://panel', slots: 1,
          streams: 0, activeCons: 2, maxConnections: 1, expiresAt: IN_TWO_DAYS,
          daysLeft: 2, expired: false, status: 'Active', trial: true,
          checkedAt: Date.now(), error: '' },
      ],
    }),
  }));

  await page.goto(`http://127.0.0.1:8481/`, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  const button = await page.evaluate(() => {
    const b = document.querySelector('#settingsBtn');
    return { text: b?.textContent?.trim(), danger: b?.classList.contains('btn-danger') };
  });
  check('the button says what it opens, not what it destroys',
    button.text === 'Manage providers', button.text);
  check('and is no longer dressed as the destructive one',
    button.danger === false, String(button.danger));

  await page.evaluate(() => providerPanel.open());
  await page.waitForTimeout(600);

  const shown = await page.evaluate(() => ({
    open: !document.querySelector('#providerModal').hidden,
    capacity: document.querySelector('#provCapacity')?.textContent?.trim(),
    lead: document.querySelector('#provLead')?.textContent?.trim(),
    rows: [...document.querySelectorAll('.prov-row')].map((row) => ({
      name: row.querySelector('.prov-name')?.textContent,
      expiry: row.querySelector('.prov-expiry')?.textContent,
      tone: row.querySelector('.prov-expiry')?.className,
      tags: [...row.querySelectorAll('.prov-tag')].map((t) => t.textContent),
      notes: [...row.querySelectorAll('.prov-note')].map((n) => n.textContent),
    })),
    text: document.querySelector('#providerModal').textContent,
  }));
  console.log('   rows:', JSON.stringify(shown.rows, null, 1));

  check('it opens', shown.open, String(shown.open));
  check('one row per login', shown.rows.length === 2, String(shown.rows.length));
  check('and how many things can play at once, which is what a login buys',
    /2 at once/.test(shown.capacity || ''), shown.capacity);

  const [live, trialRow] = shown.rows;
  check('a subscription with a year on it says the date and the days',
    /365 days left/.test(live.expiry || '') && /prov-ok/.test(live.tone || ''),
    `${live.expiry} ${live.tone}`);
  check('one running out this week says so in a colour that means it',
    /2 days left/.test(trialRow.expiry || '') && /prov-bad|prov-warn/.test(trialRow.tone || ''),
    `${trialRow.expiry} ${trialRow.tone}`);
  check('a trial is labelled as one', trialRow.tags.join(',') === 'Trial',
    JSON.stringify(trialRow.tags));
  check('a login named by hand is shown by that name, with the username under it',
    trialRow.name === 'Trial' && trialRow.notes.join(' ').includes('hunter2'),
    JSON.stringify([trialRow.name, trialRow.notes]));
  check('and the box says what it is using the connection for',
    /1 of 1 in use/.test(live.notes.join(' ')), JSON.stringify(live.notes));

  /* The provider claiming more open connections than this box opened is
     either somebody else on the login or a connection the panel has not let
     go of — both worth seeing, neither obvious from a stream that just fails. */
  check('a provider counting more connections than the box opened is called out',
    /Something else is on this login/.test(trialRow.notes.join(' ')),
    JSON.stringify(trialRow.notes));

  /* The form asks for one, so the word is on the screen by design. What must
     never be is a stored password read back — the rows carry no such field. */
  const rowText = await page.evaluate(() => document.querySelector('#provList').textContent);
  check('and no stored password is read back onto the screen',
    !/password/i.test(rowText), rowText.slice(0, 200));

  console.log('\n  adding one');
  await page.click('#provAddBtn');
  await page.waitForTimeout(300);
  const form = await page.evaluate(() => ({
    open: !document.querySelector('#provAddForm').hidden,
    host: document.querySelector('#provHost')?.textContent,
    type: document.querySelector('#provPass')?.type,
  }));
  check('the form asks for the other half of a login', form.open, String(form.open));
  check('on the provider already connected, which is not a choice',
    Boolean(form.host), form.host);
  check('and the password is not typed in the clear', form.type === 'password', form.type);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('escape closes the panel',
    await page.evaluate(() => document.querySelector('#providerModal').hidden), '');

  /* A playlist box has no logins at all. It still has the one thing this
     screen replaced, though: the way out. */
  console.log('\n  a box on a playlist rather than a login');
  await page.unroute('**/api/providers**');
  await page.route('**/api/providers**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: '{"accounts":[],"free":0,"capacity":0,"inUse":0}',
  }));
  await page.evaluate(() => providerPanel.open());
  await page.waitForTimeout(500);
  const playlist = await page.evaluate(() => ({
    lead: document.querySelector('#provLead')?.textContent,
    add: document.querySelector('#provAddBtn')?.hidden,
    out: Boolean(document.querySelector('[data-disconnect]')),
  }));
  console.log('   playlist:', JSON.stringify(playlist));
  check('says why there is nothing to manage', /playlist/i.test(playlist.lead || ''),
    playlist.lead);
  check('offers no second login, because there is no login to have one beside',
    playlist.add === true, String(playlist.add));
  check('and still offers the way back to setup', playlist.out, String(playlist.out));
  await page.evaluate(() => providerPanel.close());

  await browser.close();

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
