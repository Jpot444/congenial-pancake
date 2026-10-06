/**
 * The front door, opened for a while and shut again by itself.
 *
 * "sometimes I am at a friends house and want to use it without the hassle of
 *  cloudflair login … I want to be able to turn off the cloudflair protection
 *  if I'm using it at a friends, and turn it back on again when I leave."
 *
 * The second half of that sentence is the whole design. Anybody can add a
 * bypass policy in a dashboard; what nobody does reliably is remember to take
 * it away from somebody else's sofa. So the door is opened with a DEADLINE,
 * and what is tested here is almost entirely the closing.
 *
 * AGAINST A STAND-IN CLOUDFLARE. The real one would mean a token in a test and
 * a live account whose access rules a failing suite could leave open — which
 * is the exact outcome this feature exists to prevent. The stand-in speaks the
 * same JSON envelope, including the part that catches people out: Cloudflare
 * answers a refusal with HTTP 200 and `success: false`.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const DIR = '/tmp/portal-openhouse';
const PORT = 8487;
const CF = 9487;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- a Cloudflare that is not Cloudflare -------------------------------- */
let policies = [];
let nextId = 1;
let refuse = '';
const seen = [];

function cloudflareStandIn() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${url.pathname}`);
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    /* A refusal, in Cloudflare's own shape: 200 with success false. Anything
       reading the status code alone would call this a success. */
    if (refuse) return send({ success: false, errors: [{ message: refuse }], result: null });

    if (/\/access\/apps$/.test(url.pathname)) {
      return send({ success: true, result: [
        { id: 'app-1', name: 'Treasure Theater', domain: 'tv.example.com' },
        { id: 'app-2', name: 'Something else', domain: 'other.example.com' },
      ] });
    }
    if (/\/access\/apps\/[^/]+\/policies$/.test(url.pathname)) {
      if (req.method === 'GET') return send({ success: true, result: policies });
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        return req.on('end', () => {
          const body = JSON.parse(raw || '{}');
          /* What the real one said on the first try at a real account:
             an app that already has a policy at 1 refuses a second there. */
          if (body.precedence !== undefined
            && policies.some((p) => p.precedence === body.precedence)) {
            return send({ success: false, result: null, errors: [{ code: 12130,
              message: 'access.api.error.invalid_request: policy precedences must be unique' }] });
          }
          const made = { id: `pol-${nextId += 1}`, ...body };
          policies.push(made);
          send({ success: true, result: made });
        });
      }
    }
    const one = /\/access\/apps\/[^/]+\/policies\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === 'DELETE') {
      policies = policies.filter((p) => p.id !== one[1]);
      return send({ success: true, result: { id: one[1] } });
    }
    return send({ success: false, errors: [{ message: 'no such route' }] }, 404);
  });
}

/**
 * Lay the box out on disk, without starting it. Separate from starting it
 * because two lines of the copy have to be rewritten before node ever reads
 * them — see `start` below.
 */
function lay(openUntil) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'downloads'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'cloudflare.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(ROOT, 'college-teams.json'), path.join(DIR, 'college-teams.json'));
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'm3u', playlistUrl: 'http://127.0.0.1:9/none.m3u',
    cloudflare: { token: 'cf-token-aaaaaaaaaaaaaaaaaaaa', accountId: 'acct-1', appId: 'app-1' },
    ...(openUntil === undefined ? {} : { openUntil }),
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    /* Named Hunter, because that is how the box decides who the owner is —
       and the owner is the only profile any of this answers to. The one-time
       overlays are marked seen so none of them sits over the panel. */
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '', history: [],
      /* These sit on the profile itself rather than under `prefs`. */
      tourDone: true, liveTourDone: true, startersDone: true,
      reportNoticeSeen: true, dlExplainSeen: true, scoreSport: 'mlb', prefs: {} }],
    current: 'own1',
  }));
}

function run() {
  return spawn(process.execPath, ['server.js'], {
    cwd: DIR,
    detached: true,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      DOWNLOADS_ROOT: path.join(DIR, 'store') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const call = (p, opts = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p,
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {} }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let data = {};
      try { data = JSON.parse(text); } catch { /* not json */ }
      resolve({ status: res.statusCode, text, data });
    });
  });
  req.on('error', reject);
  if (opts.body) req.write(JSON.stringify(opts.body));
  req.end();
});

const ME = 'profileId=own1';

/**
 * The app on this box, with only the parts that need a provider stubbed out.
 * The Cloudflare endpoints are NOT stubbed: the panel is driven against the
 * real ones, through the stand-in, which is the only arrangement where the
 * switch being wired up is actually a claim.
 */
async function browserPage() {
  let chromium;
  try {
    ({ chromium } = require('./playwright.js'));
  } catch {
    console.log('  (no browser available — the screen is not checked here)');
    return null;
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  const stub = (pattern, body) => page.route(pattern, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body }));
  await stub('**/api/library**', '{"categories":[],"items":[],"totals":{"items":0}}');
  await stub('**/api/epg/now**', '{"channels":[],"busy":false}');
  await stub('**/api/scores**', '{"games":[],"feeds":[]}');
  /* The box has one profile and no current one, so the app would open on the
     picker. Chosen here the way choosing one actually leaves its mark, and
     the one-time overlays are marked seen so nothing sits over the panel. */
  await page.addInitScript(() => {
    localStorage.setItem('portal.profile', 'own1');
    localStorage.setItem('portal.layout', 'desk');
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('#healthBtn:not([hidden])', { timeout: 20000 });
  return page;
}

(async () => {
  /* The module points at api.cloudflare.com and refuses to send a token
     anywhere else, which is right and makes it untestable over the wire. So
     the BASE is rewritten in the copy under test — the one line that cannot be
     exercised as shipped, and it is named here rather than hidden. */
  const cfSrc = fs.readFileSync(path.join(ROOT, 'cloudflare.js'), 'utf8');

  const cfServer = cloudflareStandIn();
  await new Promise((r) => cfServer.listen(CF, '127.0.0.1', r));

  let server = null;
  let log = '';
  const start = (openUntil) => {
    lay(openUntil);
    /* Two lines rewritten in the COPY, after it is laid out and before node
       reads it. The module points at api.cloudflare.com and `cloudflareFetch`
       in server.js refuses to send a token anywhere else — which is right, and
       makes it untestable over the wire. Both are named here rather than
       quietly weakened in the product. */
    fs.writeFileSync(path.join(DIR, 'cloudflare.js'),
      cfSrc.replace("const API = 'https://api.cloudflare.com/client/v4';",
        `const API = 'http://127.0.0.1:${CF}/client/v4';`));
    const srv = path.join(DIR, 'server.js');
    const before = fs.readFileSync(srv, 'utf8');
    const after = before
      .replace("if (u.protocol !== 'https:' || u.hostname !== 'api.cloudflare.com') {",
        'if (false) { // host guard relaxed for the stand-in')
      .replace('const req = https.request(u, {',
        'const req = (u.protocol === "https:" ? https : require("http")).request(u, {');
    /* If either rewrite silently misses, every Cloudflare check below fails
       for a reason that has nothing to do with the feature. Say so instead. */
    if (after === before) throw new Error('could not relax the host guard in the copied server.js');
    fs.writeFileSync(srv, after);
    server = run();
    server.stdout.on('data', (d) => { log += d.toString(); });
    server.stderr.on('data', (d) => { log += d.toString(); });
  };
  const stop = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } };
  const up = async () => {
    for (let i = 0; i < 80; i += 1) {
      try { await call('/api/health'); return true; } catch { await wait(250); }
    }
    return false;
  };

  try {
    policies = [];
    start();
    check('the box comes up', await up(), log.slice(-300));

    /* ---- it starts shut ------------------------------------------------- */
    console.log('\n  to begin with');
    let state = await call(`/api/openhouse?${ME}`);
    console.log('   ', JSON.stringify(state.data));
    check('the door is shut', state.data.open === false, JSON.stringify(state.data));
    check('and the box knows it is set up for this',
      state.data.configured === true, JSON.stringify(state.data));

    /* ---- and only the owner may touch it -------------------------------- */
    /*
     * The token behind this can let the whole internet at the box, so the gate
     * is not decoration. Checked before anything else is, because a feature
     * that works and is reachable by everyone is worse than one that does not.
     */
    const guest = await call('/api/openhouse?profileId=nobody');
    check('somebody who is not the owner is refused', guest.status === 403,
      `${guest.status} ${guest.text.slice(0, 80)}`);
    const guestOpen = await call('/api/openhouse?profileId=nobody', { method: 'POST', body: {} });
    check('and cannot open it either', guestOpen.status === 403, String(guestOpen.status));
    check('so nothing was added', policies.length === 0, JSON.stringify(policies));

    /* ---- opening -------------------------------------------------------- */
    console.log('\n  opening it');
    const opened = await call(`/api/openhouse?${ME}`, { method: 'POST', body: { hours: 2 } });
    console.log('   ', JSON.stringify(opened.data));
    check('it reports open', opened.data.open === true, JSON.stringify(opened.data));
    check('with a deadline about two hours out',
      Math.abs(opened.data.until - (Date.now() + 2 * 3600 * 1000)) < 60_000,
      String(opened.data.until));
    console.log('   ', JSON.stringify(policies));
    check('one policy was added to Cloudflare', policies.length === 1,
      JSON.stringify(policies));
    /* The three things that make it a bypass rather than a rule nobody hits. */
    check('it is a bypass', policies[0].decision === 'bypass', policies[0].decision);
    check('for everyone', JSON.stringify(policies[0].include) === '[{"everyone":{}}]',
      JSON.stringify(policies[0].include));
    /* Cloudflare evaluates every bypass before any allow, wherever it sits
       in the list, so position is not what makes it work. It just has to be
       a position nobody else holds. */
    check('with a precedence of its own',
      Number.isInteger(policies[0].precedence) && policies[0].precedence >= 1,
      String(policies[0].precedence));

    /* Pressing it twice must not leave two. */
    await call(`/api/openhouse?${ME}`, { method: 'POST', body: { hours: 2 } });
    check('opening it again does not add a second',
      policies.length === 1, JSON.stringify(policies));

    /* ---- and shutting it ------------------------------------------------ */
    console.log('\n  shutting it');
    const shut = await call(`/api/openhouse?${ME}`, { method: 'DELETE' });
    console.log('   ', JSON.stringify(shut.data), JSON.stringify(policies));
    check('it reports shut', shut.data.open === false, JSON.stringify(shut.data));
    /* The OFF state is the absence of the policy, not a flag saying off —
       which is the only arrangement where a half-finished write leaves the
       door shut rather than open. */
    check('and the policy is gone from Cloudflare', policies.length === 0,
      JSON.stringify(policies));
    const after = await call(`/api/openhouse?${ME}`);
    check('asking again agrees', after.data.open === false, JSON.stringify(after.data));

    /* ---- what it will not touch ----------------------------------------- */
    /*
     * Somebody else's rules. The module knows its own policy by name, so a
     * mistyped application id costs an error rather than an access list.
     */
    console.log('\n  and other people’s policies');
    /* At precedence 1, which is where the real account's login rule sat —
       and is what made the first real open fail with "policy precedences
       must be unique". */
    policies = [{ id: 'theirs', name: 'Allow Hunter', decision: 'allow', include: [],
      precedence: 1 }];
    const besides = await call(`/api/openhouse?${ME}`, { method: 'POST', body: { hours: 1 } });
    console.log('   ', besides.status, JSON.stringify(besides.data), JSON.stringify(policies));
    check('it opens beside a policy already holding position 1',
      besides.status === 200 && policies.length === 2, `${besides.status} ${besides.text}`);
    check('opening leaves the existing policy alone',
      policies.some((p) => p.id === 'theirs' && p.precedence === 1), JSON.stringify(policies));
    await call(`/api/openhouse?${ME}`, { method: 'DELETE' });
    check('and shutting removes only its own',
      policies.length === 1 && policies[0].id === 'theirs', JSON.stringify(policies));

    /* ---- a refusal is reported, not swallowed --------------------------- */
    /*
     * Cloudflare answers a refusal with HTTP 200 and `success: false`. Code
     * that read the status alone would report a door as open that is shut.
     */
    console.log('\n  when Cloudflare says no');
    refuse = 'Invalid access token';
    const denied = await call(`/api/openhouse?${ME}`, { method: 'POST', body: { hours: 1 } });
    console.log('   ', denied.status, JSON.stringify(denied.data));
    check('the box does not claim it worked', denied.status === 502,
      String(denied.status));
    check('and passes on what Cloudflare actually said',
      /Invalid access token/.test(denied.data.error || ''), denied.data.error);
    refuse = '';

    /* ---- a door that would not shut ------------------------------------- */
    /*
     * The worst failure this feature has, and the one worth a test of its
     * own: the switch is pressed on the way out of somebody's house, the
     * close fails, and the site is left open to the internet.
     *
     * Two things have to be true. The screen must not say it shut — and the
     * box must not forget, because the deadline on disk is the only thing
     * that makes the minute sweep try again.
     */
    console.log('\n  and a door that would not shut');
    policies = [];
    await call(`/api/openhouse?${ME}`, { method: 'POST', body: { hours: 2 } });
    check('(open again, to have something to fail at closing)',
      policies.length === 1, JSON.stringify(policies));
    refuse = 'Cloudflare is having a day';
    const stuck = await call(`/api/openhouse?${ME}`, { method: 'DELETE' });
    console.log('   ', stuck.status, JSON.stringify(stuck.data));
    check('the box does not claim the door shut', stuck.status === 502,
      String(stuck.status));
    check('and says it is still open', stuck.data.open === true,
      JSON.stringify(stuck.data));
    /* A deadline of 1 — the first millisecond of 1970, which has certainly
       passed. The sweep closes anything whose time is up, so this is "keep
       trying" written in the only field that survives a restart. */
    const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
    console.log('    openUntil on disk:', onDisk.openUntil);
    check('leaving a deadline in the past rather than none at all',
      onDisk.openUntil > 0 && onDisk.openUntil < Date.now(), String(onDisk.openUntil));
    refuse = '';
    const retry = await call(`/api/openhouse?${ME}`, { method: 'DELETE' });
    check('so trying again shuts it', retry.data.open === false && policies.length === 0,
      `${JSON.stringify(retry.data)} ${JSON.stringify(policies)}`);
    check('and the deadline is cleared once it really is shut',
      (JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).openUntil || 0) === 0,
      String(JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).openUntil));

    /* ---- the credentials are never handed back -------------------------- */
    console.log('\n  the token');
    const settings = await call(`/api/cloudflare?${ME}`);
    console.log('   ', JSON.stringify(settings.data));
    check('the box says whether there is one', settings.data.set === true,
      JSON.stringify(settings.data));
    check('and never what it is', !/cf-token/.test(settings.text), settings.text);
    /* The ids are not secrets and are shown, so somebody can see which
       application they pointed it at. */
    check('while naming the application it points at',
      settings.data.appId === 'app-1', settings.data.appId);

    /* ---- and the screen ------------------------------------------------- */
    /*
     * Driven through the real endpoints on this box — only the library and the
     * listings are stubbed, so that the app boots without a provider. What is
     * being claimed is the one thing this panel exists for: that somebody
     * glancing at it on the way out of a friend's house can see the site is
     * open to the internet without reading.
     */
    console.log('\n  the screen');
    policies = [];
    const page = await browserPage();
    if (page) {
      const state = () => page.evaluate(() => {
        const note = document.querySelector('#doorNote');
        return {
          hidden: document.querySelector('#doorPanel').hidden,
          words: note.textContent.trim(),
          loud: note.classList.contains('is-open'),
          left: document.querySelector('#doorLeft').textContent.trim(),
          openBtn: !document.querySelector('#doorOpen').hidden,
          shutBtn: !document.querySelector('#doorShut').hidden,
        };
      });

      await page.click('#healthBtn');
      await wait(1200);
      let now = await state();
      console.log('   ', JSON.stringify(now));
      check('the owner can see the panel', now.hidden === false, String(now.hidden));
      check('and it says the door is shut, in words',
        /shut/i.test(now.words), now.words);
      check('quietly, because that is the ordinary state', now.loud === false,
        String(now.loud));
      check('offering to open it', now.openBtn && !now.shutBtn,
        `${now.openBtn} ${now.shutBtn}`);

      /* The switch, pressed the way somebody presses it. */
      await page.selectOption('#doorHours', '2');
      await page.click('#doorOpen');
      await wait(1500);
      now = await state();
      console.log('   ', JSON.stringify(now));
      check('pressing it opens the door at Cloudflare', policies.length === 1,
        JSON.stringify(policies));
      check('and the line says OPEN', /OPEN/.test(now.words), now.words);
      /* The only loud thing in this modal. Everything else here reports; this
         is the one line that means the site is reachable by anybody. */
      check('loudly', now.loud === true, String(now.loud));
      check('with the time left on it', /^\dh \d+m left$/.test(now.left), now.left);
      check('and now offering to shut it', now.shutBtn && !now.openBtn,
        `${now.shutBtn} ${now.openBtn}`);

      await page.click('#doorShut');
      await wait(1500);
      now = await state();
      console.log('   ', JSON.stringify(now));
      check('and the switch shuts it again', policies.length === 0 && !now.loud,
        `${JSON.stringify(policies)} ${now.loud}`);

      /* A bypass added by hand in the dashboard — a state nothing here can
         have produced, so it is named rather than smoothed over. */
      policies = [{ id: 'byhand', name: 'Treasure Theater — open house',
        decision: 'bypass', include: [{ everyone: {} }] }];
      await page.evaluate(() => frontDoor.load());
      await wait(900);
      now = await state();
      console.log('   ', JSON.stringify(now));
      check('a door somebody opened by hand is called out, not smoothed over',
        /no deadline/i.test(now.words) && now.loud === true, now.words);
      policies = [];

      /* And nobody else. The server refuses them as well — this is only about
         not showing somebody a switch they cannot throw. */
      await page.evaluate(() => {
        /* `reporter` and `frontDoor` are top-level consts in app.js, which are
           lexical bindings and not properties of `window` — reached bare. */
        reporter.isOwner = () => false;
        return frontDoor.load();
      });
      await wait(500);
      check('and a guest is not shown it at all',
        (await state()).hidden === true, String((await state()).hidden));

      await page.context().browser().close();
    }

    /* ---- a door left open across a reboot ------------------------------- */
    /*
     * THE CASE THAT MATTERS MOST. The minute tick can only close the door
     * while this process is alive, and the worst moment for it to die is while
     * the door is open — a power cut at a friend's house, and the site sitting
     * open to the internet until somebody happens to notice.
     */
    console.log('\n  and a door left open when the box went down');
    stop();
    await wait(400);
    policies = [{ id: 'stale', name: 'Treasure Theater — open house',
      decision: 'bypass', include: [{ everyone: {} }] }];
    log = '';
    /* A deadline that ran out an hour ago, which is what a power cut leaves. */
    start(Date.now() - 3600 * 1000);
    check('the box comes back', await up(), log.slice(-300));
    await wait(1200);
    console.log('   ', JSON.stringify(policies));
    check('it shuts the door on the way up, without being asked',
      policies.length === 0, JSON.stringify(policies));
    check('and says so where somebody would look',
      /open house closed/.test(log), log.split('\n').filter((l) => /cloudflare/.test(l)).join(' | '));

    /* And the other half: a deadline still in the future is left alone, or
       coming back from a restart mid-evening would shut the door in your
       face. */
    console.log('\n  but one that is still within its time is left alone');
    stop();
    await wait(400);
    policies = [{ id: 'live', name: 'Treasure Theater — open house',
      decision: 'bypass', include: [{ everyone: {} }] }];
    log = '';
    start(Date.now() + 3600 * 1000);
    check('the box comes back', await up(), log.slice(-300));
    await wait(1200);
    console.log('   ', JSON.stringify(policies));
    check('the door is still open', policies.length === 1, JSON.stringify(policies));
    check('and it says how long is left',
      /open house is ON/.test(log), log.split('\n').filter((l) => /cloudflare/.test(l)).join(' | '));
  } catch (err) {
    console.log('  HARNESS ERROR', err.message);
    fails.push('harness');
  } finally {
    stop();
    cfServer.close();
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})();
