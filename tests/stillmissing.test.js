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
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const PATHS = require('./paths.js');

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
  live: { categories: [], items: [] },
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
    'providers.js', 'recordings.js', 'recommend.js']) {
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
    const kind = q.get('kind') === 'series' ? 'series' : 'movie';
    const row = CARRIED[kind][q.get('id')];
    if (!row) {
      return r.fulfill({ status: 404, contentType: 'application/json',
        body: '{"error":"The provider does not carry that title."}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ from: 'provider', item: {
        kind, id: Number(q.get('id')), name: row.name,
        categoryId: '', logo: '', ext: row.container_extension || 'mp4',
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
