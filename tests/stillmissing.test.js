/**
 * "No longer in the library" is a claim about the provider, not about the view.
 *
 * "Im still getting that title is no longer in library errors"
 *
 * The last round of this taught the lookup to fall back to the NAME, which
 * fixed the case where the provider had renumbered its catalogue under an id
 * somebody's watch history had written down. It did not fix the other one, and
 * the code said so in as many words:
 *
 *     "a title the filter hides is reported missing, which is the same answer
 *      this gave before any of it existed"
 *
 * Everything the browser searches is a FILTERED view of the catalogue: the
 * language filter, and only those category pages somebody has opened. A film
 * outside either is a film the browser has never been told about — and it was
 * being reported as one the provider had withdrawn. Those are different facts
 * with different remedies, and the second one is not true.
 *
 * The browser cannot close that by fetching more. The wide catalogue is six
 * figures of titles and pulling it into a Pi's memory to answer one press is
 * how the portal ends up restarting mid-request; that trade was made
 * deliberately and is still the right one. But the BOX can ask the provider
 * about one id — get_vod_info, get_series_info — which costs no stream slot
 * and answers exactly the question. So it does, and only when everything free
 * has already failed.
 *
 * What is checked here, against a real box and a provider that behaves like
 * the real one:
 *
 *   A TITLE THE FILTER HIDES OPENS. It is not in the library the browser was
 *   given, and it plays anyway.
 *
 *   A TITLE THE PROVIDER REALLY HAS WITHDRAWN still says so. A fallback that
 *   never gave up would make the message meaningless.
 *
 *   A BOX THAT CANNOT ASK SAYS THAT INSTEAD. "Could not be asked" and "is not
 *   carried" are the two facts this whole area exists to keep apart.
 *
 *   AND THE FREE LOOKUPS STILL COME FIRST. An ordinary press must not start
 *   waiting on the provider.
 *
 * ── AND THEN IT CAME BACK, FOR CHANNELS ──────────────────────────────────
 *
 * "I still get that title is no longer in library errors on the homescreen"
 *
 * All of the above was built for movies and series, and LIVE was left out —
 * the box was never asked about a channel at all. That is the half of the home
 * screen this house actually uses: Continue watching is mostly games, and this
 * provider renumbers its channel list and files each fixture as its own row.
 * So a renumbered id, or a channel outside the language filter, produced
 * exactly the same wrong sentence with nobody having asked anybody.
 *
 * A channel has no per-id call behind it — Xtream has get_vod_info and
 * get_series_info and no equivalent for live — so the box settles it from the
 * channel LIST, which it can afford: about 1,700 rows against six figures of
 * films, through the same builder and the same cache as any library fetch.
 *
 * ── AND THEN IT CAME BACK AGAIN, IN THE GAP BETWEEN THE TWO FIXES ────────
 *
 * "I got the exact same error on 40.7"
 *
 * Two rounds of this each went round one side of the same case and neither
 * covered it:
 *
 *   the FIRST taught the browser to fall back to the NAME — across the copy it
 *   holds, which is filtered.
 *
 *   the SECOND taught it to ask the BOX — by ID.
 *
 * A title that has been RENUMBERED and is ALSO outside the filter fails both.
 * The name never reaches anything that holds the whole catalogue, and the id
 * the box is asked about is a number that no longer exists — so `get_vod_info`
 * comes back "does not carry", which is true of the number and false of the
 * film. It is sitting there under a new one, with exactly the name the history
 * row remembers.
 *
 * So the box takes a name as well as an id and matches it against everything
 * it has ever fetched, using the same rule the browser uses out of the same
 * file — title-match.js, loaded by the page as a script and required by the
 * box as a module, because two copies of "when are these the same title" drift
 * and then disagree for reasons nobody can find.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const PATHS = require('./paths.js');
/* The shipped matcher, so the stub agrees with the box by construction rather
   than by a second implementation that can drift from it. */
const titleMatch = require('../public/title-match.js');

const BASE = 'http://127.0.0.1:8481';
/* The server half stands up its own box and its own provider, on ports of
   their own, because what it is about is the box talking to a provider — which
   the browser half necessarily stubs out. */
const BOX_PORT = 8475;
const PROVIDER_PORT = 8474;
const BOX_DIR = '/tmp/portal-stillmissing';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * What the browser is given: the English shelf, and nothing else. This is the
 * filtered view every lookup used to be answered from.
 */
const LIBRARY = {
  movies: {
    categories: [{ id: 'm1', name: 'EN - WESTERNS' }],
    items: [{ kind: 'movie', id: 700, name: 'Redwood Gulch', categoryId: 'm1', ext: 'mp4', logo: '' }],
  },
  series: {
    categories: [{ id: 's1', name: 'EN - DRAMA' }],
    items: [{ kind: 'series', id: 800, name: 'The Long Winter', categoryId: 's1', logo: '' }],
  },
  /* One channel on the English shelf. The others the provider carries are
     outside the filter, which is the whole point of this fixture. */
  live: {
    categories: [{ id: 'l1', name: 'US - SPORTS' }],
    items: [{ kind: 'live', id: 500, name: 'US| ESPN', categoryId: 'l1', logo: '' }],
  },
};

/*
 * What the provider carries. The two extra ones are the point: a French film
 * and a German show, both real, both outside the filter above, both watched
 * last night and sitting in Continue watching this morning.
 */
const CARRIED = {
  movie: {
    700: { name: 'Redwood Gulch', container_extension: 'mp4' },
    701: { name: 'FR - Les Diaboliques', container_extension: 'mkv' },
  },
  series: {
    800: { name: 'The Long Winter' },
    801: { name: 'DE - Der Pass' },
  },
  /* Channels. 500 is on the shelf the browser was given; 501 is a channel the
     filter hides, and 502 is the one that was renumbered out from under a
     history row. */
  live: {
    500: { name: 'US| ESPN' },
    501: { name: 'UK| BBC ONE HD' },
    502: { name: 'US| NBC EAST' },
  },
};

const boxGet = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: BOX_PORT, path: p, timeout: 30000 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body.slice(0, 200) }; }
      resolve({ status: res.statusCode, body: parsed });
    });
  }).on('error', reject);
});

/*
 * The box's own half, against a provider that answers the way this one does.
 *
 * get_vod_info and get_series_info are the two calls that can settle a single
 * id without pulling a catalogue, and a provider that does not carry an id
 * answers them with an empty info block rather than an error — so "no name" is
 * what a withdrawal actually looks like on the wire.
 */
async function serverSide() {
  console.log('\n  the box asking the provider about one id');
  const asked = [];
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || '';
    asked.push(action);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (action === 'get_vod_info') {
      const id = url.searchParams.get('vod_id');
      if (id === '701') {
        return res.end(JSON.stringify({
          info: { movie_image: 'http://art/701.jpg', rating: '7.8' },
          movie_data: { stream_id: 701, name: 'FR - Les Diaboliques',
            container_extension: 'mkv', category_id: '77' },
        }));
      }
      /* Withdrawn: the shape a provider really answers with. */
      return res.end(JSON.stringify({ info: [], movie_data: [] }));
    }
    /* The catalogue, so the box has a knownCatalogue to match a NAME against.
       9901 is the renumbered one: the same film the history row calls Trading
       Places, filed under a number that row has never seen. */
    if (action === 'get_vod_categories') {
      return res.end(JSON.stringify([{ category_id: 'm1', category_name: 'EN - WESTERNS' }]));
    }
    if (action === 'get_vod_streams') {
      return res.end(JSON.stringify([
        { stream_id: 700, name: 'Redwood Gulch', category_id: 'm1',
          container_extension: 'mp4', stream_icon: '' },
        { stream_id: 9901, name: 'Trading Places', category_id: 'm1',
          container_extension: 'mkv', stream_icon: '' },
        /* Two of these, so the ambiguity guard has something to refuse. */
        { stream_id: 9910, name: 'The Office US', category_id: 'm1',
          container_extension: 'mp4', stream_icon: '' },
        { stream_id: 9911, name: 'The Office UK', category_id: 'm1',
          container_extension: 'mp4', stream_icon: '' },
      ]));
    }
    /* The channel list, which is how a live id gets settled: there is no
       get_live_info to ask. Returned whole, the way the provider does. */
    if (action === 'get_live_categories') {
      return res.end(JSON.stringify([
        { category_id: 'l1', category_name: 'US - SPORTS' },
        { category_id: 'l2', category_name: 'UK - ENTERTAINMENT' },
      ]));
    }
    if (action === 'get_live_streams') {
      return res.end(JSON.stringify(Object.entries(CARRIED.live).map(([id, row]) => ({
        stream_id: Number(id),
        name: row.name,
        category_id: id === '501' ? 'l2' : 'l1',
        stream_icon: '',
      }))));
    }
    if (action === 'get_series_info') {
      const id = url.searchParams.get('series_id');
      if (id === '801') {
        return res.end(JSON.stringify({
          info: { name: 'DE - Der Pass', cover: 'http://art/801.jpg', genre: 'Crime' },
          episodes: {},
        }));
      }
      return res.end(JSON.stringify({ info: {}, episodes: {} }));
    }
    return res.end('[]');
  });
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));

  fs.rmSync(BOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BOX_DIR, 'downloads'), { recursive: true });
  fs.cpSync(path.join(PATHS.ROOT, 'public'), path.join(BOX_DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js', 'market.js']) {
    fs.copyFileSync(path.join(PATHS.ROOT, f), path.join(BOX_DIR, f));
  }
  fs.copyFileSync(path.join(PATHS.ROOT, 'college-teams.json'),
    path.join(BOX_DIR, 'college-teams.json'));
  fs.writeFileSync(path.join(BOX_DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PROVIDER_PORT}`,
    username: 'u', password: 'p', preferredFormat: 'ts',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(BOX_DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', prefs: { tourDone: true }, history: [] }],
  }));

  const box = spawn('node', ['server.js'], {
    cwd: BOX_DIR,
    env: { ...process.env, PORT: String(BOX_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      try { await boxGet('/api/health'); up = true; } catch { await wait(250); }
    }
    if (!up) throw new Error('the box did not come up');

    const film = await boxGet('/api/title?kind=movie&id=701');
    console.log('   a film outside the filter:', JSON.stringify(film.body).slice(0, 150));
    check('the box resolves it against the provider',
      film.status === 200 && film.body.item && String(film.body.item.id) === '701',
      JSON.stringify(film.body).slice(0, 200));
    /* Shaped like every other library item, because everything downstream —
       the player, the card, the resume key — reads that shape and nothing
       should have to know this one arrived by a different road. */
    check('shaped like a library item',
      film.body.item?.kind === 'movie' && film.body.item?.ext === 'mkv'
        && typeof film.body.item?.name === 'string',
      JSON.stringify(film.body.item));
    /* The provider's prefix comes off here as it does everywhere else. */
    check('with the filing prefix taken off the name',
      film.body.item?.name === 'Les Diaboliques', film.body.item?.name);
    /* Artwork goes through the box's image proxy, the same as the catalogue's
       does — a provider URL handed straight to the page is a request this box
       cannot vouch for. */
    check('and its artwork through the box rather than direct',
      /^\/img\?u=/.test(film.body.item?.logo || ''), film.body.item?.logo);

    const show = await boxGet('/api/title?kind=series&id=801');
    check('a show resolves too',
      show.status === 200 && show.body.item?.name === 'Der Pass',
      JSON.stringify(show.body).slice(0, 200));

    /*
     * A channel, which is the half that was missing.
     *
     * 501 is outside the language filter the browser was given, so every free
     * lookup on that side fails — and the box can still settle it, because the
     * list it fetches for this is deliberately unfiltered. Answering from an
     * identically filtered list would only agree with the browser.
     */
    const channel = await boxGet('/api/title?kind=live&id=501');
    console.log('   a channel outside the filter:', JSON.stringify(channel.body).slice(0, 150));
    check('the box resolves a live id as well as a title',
      channel.status === 200 && String(channel.body.item?.id) === '501',
      JSON.stringify(channel.body).slice(0, 200));
    check('shaped like a library item, so the player needs to know nothing new',
      channel.body.item?.kind === 'live' && typeof channel.body.item?.name === 'string',
      JSON.stringify(channel.body.item));

    /* And a second miss costs nothing: the list it went and got is the same
       cache an ordinary library fetch fills, so the provider is asked once. */
    const askedBefore = asked.filter((a) => a === 'get_live_streams').length;
    const again = await boxGet('/api/title?kind=live&id=502');
    const askedAfter = asked.filter((a) => a === 'get_live_streams').length;
    check('and the next one is answered without asking the provider again',
      again.status === 200 && askedAfter === askedBefore,
      `${askedBefore} → ${askedAfter}`);

    /*
     * And one that really is gone — the COMMON case on a home screen, where
     * half of Continue watching is games that finished last night. The list
     * this box holds is fresh and has already been searched, so re-reading it
     * could only give the same answer: a provider with one connection must not
     * be asked for the whole channel list on every one of those presses.
     */
    const listedBefore = asked.filter((a) => a === 'get_live_streams').length;
    const noChannel = await boxGet('/api/title?kind=live&id=9999');
    const listedAfter = asked.filter((a) => a === 'get_live_streams').length;
    check('a channel that really is gone is a 404, like a title',
      noChannel.status === 404 && /does not carry/i.test(noChannel.body.error || ''),
      `${noChannel.status} ${JSON.stringify(noChannel.body)}`);
    check('and answering that costs the provider nothing while the list is fresh',
      listedAfter === listedBefore, `${listedBefore} → ${listedAfter}`);

    /*
     * The gap between the two earlier fixes: a RENUMBERED title.
     *
     * 4321 is what the watch history wrote down months ago and the provider
     * has since renumbered it to 9901. Asking about 4321 cannot succeed —
     * get_vod_info answers "does not carry" about a number that is genuinely
     * gone — and that was being read out as the film having been withdrawn.
     * The name outlives the number.
     */
    await boxGet('/api/library?tab=movies');   // so the box has a catalogue at all
    const byIdAlone = await boxGet('/api/title?kind=movie&id=4321');
    check('asking by a renumbered id alone still fails, as it must',
      byIdAlone.status === 404, `${byIdAlone.status}`);

    const byTheName = await boxGet('/api/title?kind=movie&id=4321&name=Trading%20Places');
    console.log('   renumbered, found by name:', JSON.stringify(byTheName.body).slice(0, 140));
    check('but the name finds it under its new number',
      byTheName.status === 200 && String(byTheName.body.item?.id) === '9901',
      JSON.stringify(byTheName.body).slice(0, 200));
    check('and says that is how it was found',
      byTheName.body.from === 'name', String(byTheName.body.from));

    /* The guard that keeps this honest. Quietly starting the wrong programme
       is worse than saying it could not be found. */
    const ambiguous = await boxGet('/api/title?kind=movie&id=4322&name=The%20Office');
    check('an ambiguous name is refused rather than guessed at',
      ambiguous.status === 404, `${ambiguous.status} ${JSON.stringify(ambiguous.body)}`);

    const withdrawn = await boxGet('/api/title?kind=movie&id=999');
    console.log('   one that is withdrawn:', JSON.stringify(withdrawn.body));
    /* An empty info block is how this provider says "no such id". Reading that
       as an answer rather than as an error is what lets the browser tell a
       withdrawal from a box that could not ask. */
    check('and one the provider does not carry is a 404, not an error',
      withdrawn.status === 404 && /does not carry/i.test(withdrawn.body.error || ''),
      `${withdrawn.status} ${JSON.stringify(withdrawn.body)}`);

    console.log('   provider was asked:', JSON.stringify(asked));
  } finally {
    box.kill('SIGKILL');
    try { provider.close(); } catch { /* already shut */ }
  }
}

(async () => {
  await serverSide();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/library*', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(LIBRARY[tab] || { categories: [], items: [] }) });
  });
  await page.route('**/api/scores*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":[],"feeds":[]}' }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  /* The box's per-title lookup, behaving as the real one does: what the
     provider carries, or an honest 404. `mode` decides whether it can be
     asked at all. */
  let asks = 0;
  let boxMode = 'ok';
  await page.route('**/api/title*', (r) => {
    asks += 1;
    const q = new URL(r.request().url()).searchParams;
    if (boxMode === 'refused') {
      return r.fulfill({ status: 502, contentType: 'application/json',
        body: '{"error":"The provider answered 502"}' });
    }
    const asKind = q.get('kind');
    const kind = asKind === 'series' ? 'series' : asKind === 'live' ? 'live' : 'movie';
    let row = CARRIED[kind][q.get('id')];
    /* By name when the id finds nothing — a renumbered title, which is what
       the box itself now does against everything it holds. Matched with the
       shipped rule rather than a second copy of it. */
    let renumberedTo = null;
    if (!row && q.get('name')) {
      const rows = Object.entries(CARRIED[kind])
        .map(([id, r]) => ({ id, name: r.name, ...r }));
      const hit = titleMatch.byName(rows, q.get('name'));
      if (hit) { row = hit; renumberedTo = hit.id; }
    }
    if (!row) {
      return r.fulfill({ status: 404, contentType: 'application/json',
        body: '{"error":"The provider does not carry that title."}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ from: renumberedTo ? 'name' : 'provider', item: {
        kind, id: Number(renumberedTo || q.get('id')), name: row.name,
        categoryId: '', logo: '',
        ...(kind === 'live' ? {} : { ext: row.container_extension || 'mp4' }),
      } }) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1500);
  }
  await page.evaluate((lib) => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    Object.assign(state.library, lib);
  }, LIBRARY);

  const find = (tab, id, name = '') => page.evaluate(
    async ({ t, i, n }) => {
      try {
        const out = await findTitle(t, i, n);
        return { item: out ? { id: out.id, name: out.name } : null };
      } catch (err) {
        return { threw: err.message };
      }
    }, { t: tab, i: id, n: name });

  /* ---- 1. the free lookups still answer, and cost nothing --------------- */
  /*
   * The provider must not be asked about a title the browser already has. An
   * ordinary press is the common case and it has to stay free.
   */
  console.log('\n  a title that is right there');
  asks = 0;
  const here = await find('movies', 700);
  console.log('   ', JSON.stringify(here), `asks=${asks}`);
  check('is found', here.item && here.item.id === 700, JSON.stringify(here));
  check('without asking the box about it', asks === 0, String(asks));

  /* ---- 2. a title the filter hides ------------------------------------- */
  /*
   * The reported failure. Not in the library this browser was handed, because
   * the language filter never included it — and carried by the provider all
   * along.
   */
  console.log('\n  a film outside the language filter');
  asks = 0;
  const hidden = await find('movies', 701, 'Les Diaboliques');
  console.log('   ', JSON.stringify(hidden), `asks=${asks}`);
  check('the box is asked once everything free has failed', asks === 1, String(asks));
  check('and the film is found', hidden.item && hidden.item.id === 701,
    JSON.stringify(hidden));
  check('with the name the provider files it under',
    /Diaboliques/.test(hidden.item?.name || ''), JSON.stringify(hidden.item));

  console.log('\n  a show outside it');
  asks = 0;
  const show = await find('series', 801, 'Der Pass');
  console.log('   ', JSON.stringify(show), `asks=${asks}`);
  check('the show is found too', show.item && show.item.id === 801, JSON.stringify(show));

  /* ---- 3. a title that really is gone ---------------------------------- */
  /*
   * The message has to keep meaning something. A lookup that never gave up
   * would turn every genuine withdrawal into a silent failure somewhere
   * further down.
   */
  console.log('\n  a film the provider really has withdrawn');
  asks = 0;
  const gone = await find('movies', 999, 'Something Withdrawn');
  console.log('   ', JSON.stringify(gone), `asks=${asks}`);
  check('the box is asked', asks === 1, String(asks));
  check('and the answer is still that it is not there',
    gone.item === null, JSON.stringify(gone));
  check('reported as an absence rather than as a failure',
    !gone.threw, JSON.stringify(gone));

  /* ---- 3b. the home screen, which is where this was reported ----------- */
  /*
   * "I still get that title is no longer in library errors on the homescreen"
   *
   * Driven through playFromHistory rather than findTitle, because the sentence
   * the viewer reads is chosen there and the row it starts from is a history
   * row, not a library item. A channel is the case that was missing outright.
   */
  console.log('\n  a channel on the home screen');
  await page.evaluate(() => { state.config = { ...(state.config || {}), mode: 'xtream' }; });

  /** What a press on a home-screen card says, and whether it opened anything. */
  const press = (row) => page.evaluate(async (r) => {
    const said = [];
    const real = window.toast;
    window.toast = (m) => { said.push(String(m)); };
    let opened = null;
    const realOpen = window.openPlayer;
    window.openPlayer = async (item) => { opened = { id: item.id, kind: item.kind }; };
    try { await playFromHistory(r); } catch (err) { said.push(`THREW ${err.message}`); }
    window.toast = real;
    window.openPlayer = realOpen;
    return { said, opened };
  }, row);

  asks = 0;
  const renumbered = await press({
    key: 'live:502', kind: 'live', id: 502, name: 'US| NBC EAST', poster: '',
  });
  console.log('   ', JSON.stringify(renumbered), `asks=${asks}`);
  check('the box is asked about a channel, which it never used to be',
    asks === 1, String(asks));
  check('and the channel opens instead of being called missing',
    renumbered.opened && String(renumbered.opened.id) === '502',
    JSON.stringify(renumbered));
  check('with nothing said about a library', !renumbered.said.length,
    JSON.stringify(renumbered.said));

  /* And one that really has gone. The message a viewer gets for a channel is
     not the message for a film: this provider files each fixture as its own
     row and takes it down when the game ends, so "no longer in the library"
     is a sentence about the wrong thing. */
  console.log('\n  a game channel that has come down');
  const ended = await press({
    key: 'live:7777', kind: 'live', id: 7777,
    name: 'US| NCAAF 07 | ALABAMA X GEORGIA', poster: '',
  });
  console.log('   ', JSON.stringify(ended.said));
  check('nothing is opened', !ended.opened, JSON.stringify(ended));
  check('and it is not called a library problem',
    !/no longer in the library/i.test(ended.said.join(' ')), JSON.stringify(ended.said));
  check('it says the channel is gone from the provider',
    /not in the provider/i.test(ended.said.join(' ')), JSON.stringify(ended.said));
  check('and why, which for a fixture row is that the event ended',
    /event ends/i.test(ended.said.join(' ')), JSON.stringify(ended.said));

  /* ---- 3c. renumbered AND out of sight, which is the gap --------------- */
  /*
   * "I got the exact same error on 40.7"
   *
   * The case neither earlier round covered. 702 is a number the provider has
   * moved on from, and the film is not in the filtered library this browser
   * holds — so the client's own name fallback has nothing to search and the
   * box's id lookup is asking about a number that is genuinely gone. Only a
   * NAME, matched against everything the box holds, can answer it.
   */
  console.log('\n  a film the provider renumbered, on a shelf this profile filters out');
  CARRIED.movie[9901] = { name: 'Trading Places', container_extension: 'mkv' };
  asks = 0;
  const renum = await press({
    key: 'movie:702', kind: 'movie', id: 702, name: 'Trading Places', poster: '',
  });
  console.log('   ', JSON.stringify(renum), `asks=${asks}`);
  check('the film opens under the number it has now',
    renum.opened && String(renum.opened.id) === '9901', JSON.stringify(renum));
  check('with nothing said about a library', !renum.said.length, JSON.stringify(renum.said));

  /* And the guard. Two programmes that could be meant is a question this
     cannot answer, and answering it anyway starts the wrong one. */
  console.log('\n  and a name that could mean two different programmes');
  CARRIED.series[9920] = { name: 'The Office US' };
  CARRIED.series[9921] = { name: 'The Office UK' };
  const guessy = await press({
    key: 'series:9000', kind: 'series', id: 9000, seriesId: 9000,
    seriesName: 'The Office', name: 'The Office S01E01', season: 1, episode: 1, poster: '',
  });
  console.log('   ', JSON.stringify(guessy.said));
  check('nothing is opened on a guess', !guessy.opened, JSON.stringify(guessy));
  check('and it says so rather than starting the wrong one',
    /no longer in the library/i.test(guessy.said.join(' ')), JSON.stringify(guessy.said));

  /* ---- 4. a box that cannot ask ---------------------------------------- */
  /*
   * "Could not be asked" and "is not carried" are the two facts this area
   * exists to keep apart — telling somebody their programme is gone on the
   * strength of a failed request is the thing that started all of this.
   */
  console.log('\n  when the box cannot ask');
  boxMode = 'refused';
  const refused = await find('movies', 702, 'Unknown Film');
  console.log('   ', JSON.stringify(refused));
  check('the lookup fails loudly rather than reporting a withdrawal',
    Boolean(refused.threw), JSON.stringify(refused));
  boxMode = 'ok';

  /* ---- 5. and an M3U box is not asked at all --------------------------- */
  /*
   * There is no per-title endpoint behind a flat playlist, so asking would be
   * a request that can only fail — and a failure here reads as "could not be
   * asked", which would turn every genuine miss on an M3U box into an error.
   */
  console.log('\n  on a box with no provider to ask');
  await page.evaluate(() => { state.config = { ...(state.config || {}), mode: 'm3u' }; });
  asks = 0;
  const flat = await find('movies', 703, 'Nothing Here');
  console.log('   ', JSON.stringify(flat), `asks=${asks}`);
  check('nothing is asked', asks === 0, String(asks));
  check('and the miss is an ordinary miss', flat.item === null && !flat.threw,
    JSON.stringify(flat));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
