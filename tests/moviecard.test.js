/**
 * A film's own page.
 *
 * It used to be a show's card with the seasons taken out — a poster, a name,
 * one line of facts and a button — and the claims here were about those four
 * things. The page is now the backdrop, the decision on top of it, and what
 * the box knows laid out underneath, so the claims are about that: the same
 * behaviours still hold (play, resume, favorite, download, back) and the new
 * facts the page puts on screen have to be the provider's own rather than
 * anything invented on the way.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const SHOTS = __dirname + '/shots';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGP8//' +
  '8/AzJgYkAD5AsAAP//DkYCbYrGZ2sAAAAASUVORK5CYII=', 'base64');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));
  await page.route('**/img?u=*', (r) => {
    const u = new URL(r.request().url()).searchParams.get('u') || '';
    if (!/^https?:\/\//.test(u)) return r.fulfill({ status: 404, body: 'Not found' });
    return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  /* What a panel that answers properly sends back. The two ffprobe blocks are
     the point of the specs strip and the `cast` string is the point of the
     rail, so both are here — a suite stubbing only the four fields the old
     card read would pass while the new page showed four dashes. */
  let vodCalls = 0;
  await page.route('**/api/xtream*', (r) => {
    const action = new URL(r.request().url()).searchParams.get('action');
    if (action === 'get_vod_info') {
      vodCalls += 1;
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: {
          releasedate: '2014', genre: 'Sci-Fi',
          plot: 'A farmer goes to space about it.',
          duration: '02:49:00', duration_secs: 10140,
          cast: 'Matthew McConaughey, Anne Hathaway, Jessica Chastain',
          director: 'Christopher Nolan',
          bitrate: 1800,
          backdrop_path: ['http://provider/backdrop.jpg'],
          video: { codec_name: 'h264', width: 1920, height: 1080,
            r_frame_rate: '24000/1001', display_aspect_ratio: '16:9' },
          audio: { codec_name: 'aac', channels: 6, channel_layout: '5.1' },
        } }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/play*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: '/api/fake-stream', format: 'file' }) }));
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/downloads*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1200);
  }

  await page.evaluate(() => {
    state.config = { ...(state.config || {}), mode: 'xtream' };
    state.library.movies = {
      categories: [{ id: 'c1', name: 'Sci-Fi' }],
      // mp4 so playback resolves through /api/play rather than the remuxer:
      // this suite is about the page, and the conversion path has suites of
      // its own. A .mkv here would need the whole remux pipeline stubbed to
      // answer one question the page does not ask.
      items: [
        { kind: 'movie', id: 55, name: 'A Film', categoryId: 'c1', rating: '8.6',
          ext: 'mp4', logo: `/img?u=${encodeURIComponent('http://provider/film.jpg')}` },
        { kind: 'movie', id: 56, name: 'Another Film', categoryId: 'c1', ext: 'mp4', logo: '' },
      ],
    };
  });

  // --- the page ------------------------------------------------------------
  console.log('\n  opening a film');
  await page.evaluate(() => { location.hash = '#/movies/55'; });
  await page.waitForSelector('.play-title', { timeout: 10000 });
  await wait(1200);

  const card = await page.evaluate(() => {
    const poster = document.querySelector('.film-poster img');
    const play = document.querySelector('.play-title').getBoundingClientRect();
    const hero = document.querySelector('.film-hero');
    return {
      title: document.querySelector('.film-title').textContent,
      meta: document.querySelector('.film-meta').textContent,
      plot: document.querySelector('.film-plot').textContent,
      plotShown: !document.querySelector('.film-plot').hidden,
      left: document.querySelector('.film-left').textContent,
      posterLoaded: Boolean(poster) && poster.naturalWidth > 0,
      posterRight: poster ? poster.getBoundingClientRect().right : 0,
      playLeft: play.left,
      hasEpisodes: Boolean(document.querySelector('.film-page .ep-list')),
      hasSeasons: Boolean(document.querySelector('.film-page .season-picker')),
      fav: document.querySelector('.show-fav')?.title,
      headShown: getComputedStyle(document.querySelector('.content-head')).display !== 'none',
      heroWidth: hero ? Math.round(hero.getBoundingClientRect().width) : 0,
      heroTop: hero ? Math.round(hero.getBoundingClientRect().top) : 0,
      backdrop: Boolean(document.querySelector('.film-art img')),
      // A bar that was never built is not a bar on the page: `?.hidden` on a
      // missing node is undefined, which negates to "showing".
      catbar: Boolean(document.querySelector('#dkCatbar:not([hidden])')),
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  });
  console.log('   ', JSON.stringify(card));
  check('the film is named', card.title.startsWith('A Film'), card.title);
  check('and carries its year beside the name', /2014/.test(card.title), card.title);
  check('the poster loaded rather than falling back to the name',
    card.posterLoaded, JSON.stringify(card));
  check('and sits left of the play button', card.posterRight <= card.playLeft + 1,
    JSON.stringify(card));
  check('the rating, runtime, date and genre are all on the meta line',
    /8\.6/.test(card.meta) && /2:49:00/.test(card.meta)
      && /2014/.test(card.meta) && /Sci-Fi/.test(card.meta), card.meta);
  check('the description is there', /farmer goes to space/.test(card.plot) && card.plotShown,
    card.plot);
  check('the runtime is shown, formatted', card.left === '2:49:00', card.left);
  check('there are no seasons on a film', !card.hasSeasons);
  check('and no episode list', !card.hasEpisodes);
  check('favorites works the same as on a show', /favorites/i.test(card.fav || ''), card.fav);
  check('the section head is off — the film\'s own title is the head of the page',
    !card.headShown, String(card.headShown));
  check('the backdrop is behind the whole page rather than inside the column',
    card.backdrop && card.heroWidth >= card.winW - 1, JSON.stringify(card));
  check('and starts directly under the header', card.heroTop <= 70, String(card.heroTop));
  check('the category bar is not over the picture', !card.catbar, String(card.catbar));
  check('nothing overflows sideways', card.docW <= card.winW + 1,
    `${card.docW} vs ${card.winW}`);
  check('the player is not open', await page.locator('#playerOverlay').isHidden());
  check('the details were asked for once', vodCalls === 1, String(vodCalls));
  await page.screenshot({ path: SHOTS + '/moviecard.png', fullPage: true });

  // --- what the provider said, said back -----------------------------------
  console.log('\n  the facts underneath');
  const facts = await page.evaluate(() => ({
    director: [...document.querySelectorAll('.film-credit-value')]
      .map((v) => v.textContent).join(' | '),
    cast: [...document.querySelectorAll('.film-person-name')].map((n) => n.textContent),
    roles: [...document.querySelectorAll('.film-person-role')].map((n) => n.textContent),
    specs: [...document.querySelectorAll('.film-spec-value')].map((n) => n.textContent),
    notes: [...document.querySelectorAll('.film-spec-note')].map((n) => n.textContent),
    boxLine: document.querySelector('.film-box-line')?.textContent,
    seen: document.querySelector('.film-seen-line')?.textContent,
    panels: [...document.querySelectorAll('.film-panel-head')].map((n) => n.textContent),
    more: [...document.querySelectorAll('.film-more-track .card-title')].map((n) => n.textContent),
    meta: document.querySelector('.film-meta')?.textContent || '',
    cert: document.querySelector('.film-cert')?.textContent || '',
    badge: document.querySelector('.film-poster-badge')?.textContent || '',
    badgeShown: !document.querySelector('.film-poster-badge')?.hidden,
  }));
  console.log('   ', JSON.stringify(facts));
  check('the director is credited', /Christopher Nolan/.test(facts.director), facts.director);
  check('the genre is a chip you can follow', /Sci-Fi/.test(facts.director), facts.director);
  check('the cast is the provider\'s, in its order',
    facts.cast[0] === 'Matthew McConaughey' && facts.cast[2] === 'Jessica Chastain',
    JSON.stringify(facts.cast));
  check('the director is on the end of the cast rail, named as one',
    facts.cast[3] === 'Christopher Nolan' && facts.roles[3] === 'Director',
    JSON.stringify(facts.roles));
  check('the video specs come off the provider\'s own probe',
    /1080p/.test(facts.specs[0]) && /H264/.test(facts.specs[0]), facts.specs[0]);
  check('with the frame rate worked out of the fraction',
    /23\.976/.test(facts.notes[0]), facts.notes[0]);
  check('the audio specs too', /AAC/.test(facts.specs[1]) && /5\.1/.test(facts.specs[1]),
    facts.specs[1]);
  check('the size is the bitrate times the runtime, as the rest of the app has it',
    /GB/.test(facts.specs[3]) && /Mbps/.test(facts.specs[3]), facts.specs[3]);
  check('the sidebar is honest that it is not on the box',
    /streams from the provider/i.test(facts.boxLine || ''), facts.boxLine);
  check('and that this profile has never opened it',
    /never opened/i.test(facts.seen || ''), facts.seen);
  check('the three sidebar panels are there',
    facts.panels.length === 3 && /Watched by Hunter/.test(facts.panels[1]),
    JSON.stringify(facts.panels));
  check('the rest of the category is offered, minus this film',
    facts.more.length === 1 && /Another Film/.test(facts.more[0]),
    JSON.stringify(facts.more));

  /* ---- nothing on this page is made up ----
   *
   * Three facts were briefly filled in from a table of likely answers when
   * the provider was silent, which is a worse failure than a gap: a page that
   * prints "R" over a film nobody rated, or "Lead" beside the first name in a
   * comma-separated string, is stating something it invented. This panel
   * carries no certificate and its film is 1080p, so all three have to be
   * either absent or the truth. */
  console.log('\n  and none of it is invented');
  check('no certificate is shown, because this panel carries none',
    facts.cert === '' && !/\b(PG-13|R|NC-17|TV-MA)\b/.test(facts.meta),
    `${facts.cert} | ${facts.meta}`);
  check('no billing is claimed against a cast member',
    !facts.roles.slice(0, 3).some((r) => /Lead|Featured|Supporting/.test(r)),
    JSON.stringify(facts.roles));
  check('an actor is labelled as what the provider said they are: cast',
    facts.roles[0] === 'Cast', facts.roles[0]);
  check('the quality badge is the height the file really is, not a guess',
    facts.badgeShown && facts.badge === '1080P', `${facts.badge} shown=${facts.badgeShown}`);

  // --- play ---------------------------------------------------------------
  console.log('\n  pressing play');
  await page.locator('.play-title').click();
  await wait(3000);
  const playing = await page.evaluate(() => ({
    open: !document.querySelector('#playerOverlay').hidden,
    title: document.querySelector('#playerTitle').textContent,
    src: document.querySelector('#video').currentSrc,
    backLabel: document.querySelector('#cinemaBackLabel').textContent,
  }));
  console.log('   ', JSON.stringify(playing));
  check('the player opens', playing.open, JSON.stringify(playing));
  check('on the right film', playing.title === 'A Film', playing.title);
  check('and is really playing', playing.src.includes('fake-stream'), playing.src);
  check('the details were not fetched a second time', vodCalls === 1, String(vodCalls));

  // --- back lands on the film's page --------------------------------------
  await page.evaluate(() => document.querySelector('#cinemaBack').click());
  await wait(1200);
  const back = await page.evaluate(() => ({
    hash: location.hash,
    cardShown: !document.querySelector('#seriesView').hidden,
    playShown: Boolean(document.querySelector('.play-title')),
    heroShown: Boolean(document.querySelector('.film-hero')),
    playerShut: document.querySelector('#playerOverlay').hidden,
  }));
  console.log('   ', JSON.stringify(back));
  check('back from the player lands on the film', back.hash === '#/movies/55', back.hash);
  check('with its page showing, backdrop and all',
    back.cardShown && back.playShown && back.heroShown, JSON.stringify(back));
  check('and the player shut', back.playerShut);

  // --- where you got to ----------------------------------------------------
  //
  // The page makes the resume choice out loud, with two buttons on it, so the
  // player's modal must not come up on top of them. That is the whole reason
  // openPlayer takes a resume mode.
  console.log('\n  a film half watched');
  await page.route('**/progress*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"found":true,"position":3600,"duration":10140,"completed":false}' }));
  const resumed = await page.evaluate(async () => {
    state.recentlyWatched = [{
      key: 'movie:55', kind: 'movie', id: 55, name: 'A Film',
      position: 3600, duration: 10140, completed: false, plays: 3,
      at: Date.UTC(2026, 7, 12),
    }];
    render();
    await new Promise((r) => setTimeout(r, 900));
    const bar = document.querySelector('.film-poster-progress i');
    return {
      play: document.querySelector('.play-title').textContent.trim(),
      restart: document.querySelector('.film-restart').textContent.trim(),
      left: document.querySelector('.film-left').textContent,
      barWidth: bar ? bar.style.width : '',
      seen: document.querySelector('.film-seen-line').textContent,
    };
  });
  console.log('   ', JSON.stringify(resumed));
  check('the button says where it will pick up', resumed.play === 'Resume 1:00:00', resumed.play);
  check('with Start over beside it', resumed.restart === 'Start over', resumed.restart);
  check('and how much is left, against the runtime',
    resumed.left === '1:49:00 left of 2:49:00', resumed.left);
  check('the poster carries the stripe', resumed.barWidth.startsWith('35.5'), resumed.barWidth);
  check('the sidebar says when, and how many times',
    /1:00:00/.test(resumed.seen) && /3 plays/.test(resumed.seen), resumed.seen);

  console.log('\n  Start over does not ask again');
  await page.locator('.film-restart').click();
  await wait(2500);
  const over = await page.evaluate(() => ({
    asked: !document.querySelector('#resumeAsk').hidden,
    open: !document.querySelector('#playerOverlay').hidden,
    at: Math.round(document.querySelector('#video').currentTime),
  }));
  console.log('   ', JSON.stringify(over));
  check('the resume modal stays down — the page already asked', !over.asked, JSON.stringify(over));
  check('and it starts from the top', over.open && over.at < 30, JSON.stringify(over));
  await page.evaluate(() => closePlayer());
  await wait(600);

  // --- the back pill -------------------------------------------------------
  await page.evaluate(() => { location.hash = '#/movies/55'; });
  await wait(900);
  const pill = await page.evaluate(() => document.querySelector('.show-back').textContent.trim());
  check('the way back names the category and its size', /Sci-Fi/.test(pill) && /2/.test(pill), pill);
  await page.evaluate(() => document.querySelector('.show-back').click());
  await wait(1000);
  const gone = await page.evaluate(() => ({
    hash: location.hash,
    hero: Boolean(document.querySelector('.film-hero')),
  }));
  check('the back link leaves the film', gone.hash === '#/movies', gone.hash);
  check('and takes the backdrop with it — it lives outside the page column',
    !gone.hero, JSON.stringify(gone));

  // --- the download button -------------------------------------------------
  console.log('\n  the download button');
  const dlBtn = await page.evaluate(async () => {
    location.hash = '#/movies/55';
    await new Promise((r) => setTimeout(r, 900));
    state.downloads = { items: [], active: null, queued: 0 };
    render();
    await new Promise((r) => setTimeout(r, 600));
    const fresh = document.querySelector('.show-dl')?.title;
    const freshBox = document.querySelector('.film-box-line')?.textContent;
    state.downloads = { items: [
      { id: 'x', kind: 'movie', streamId: '55', status: 'done', name: 'film', total: 1546188226 },
    ], active: null, queued: 0 };
    render();
    await new Promise((r) => setTimeout(r, 600));
    return {
      fresh,
      freshBox,
      saved: document.querySelector('.show-dl')?.title,
      state: document.querySelector('.film-state')?.textContent,
      box: document.querySelector('.film-box-line')?.textContent,
      besideFav: Boolean(document.querySelector('.film-actions .show-fav')
        && document.querySelector('.film-actions .show-dl')),
    };
  });
  console.log('   ', JSON.stringify(dlBtn));
  check('a film offers a download beside favorites',
    dlBtn.besideFav && /Download to the box/.test(dlBtn.fresh || ''), JSON.stringify(dlBtn));
  check('and says so when the film is already on the box',
    dlBtn.saved === 'Downloaded', JSON.stringify(dlBtn));
  check('the eyebrow says it too', dlBtn.state === 'ON THE BOX', dlBtn.state);
  check('and the sidebar turns into what to do with the copy',
    /Downloaded/.test(dlBtn.box || '') && /1\.44 GB/.test(dlBtn.box || ''), dlBtn.box);

  // --- a thumb is a real rating -------------------------------------------
  console.log('\n  rating it');
  let rated = null;
  await page.route('**/api/profiles/*/rating', (r) => {
    rated = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ratings: { [rated.key]: rated.value } }) });
  });
  await page.locator('.film-thumb.is-up').click();
  await wait(600);
  const thumb = await page.evaluate(() => ({
    on: document.querySelector('.film-thumb.is-up').classList.contains('on'),
    held: state.ratings['movie:55'],
  }));
  console.log('   ', JSON.stringify({ rated, thumb }));
  check('the thumb posts against the same key history uses',
    rated && rated.key === 'movie:55' && rated.value === 1, JSON.stringify(rated));
  check('and lights up without waiting for the box', thumb.on && thumb.held === 1,
    JSON.stringify(thumb));

  // --- a channel still tunes straight in ----------------------------------
  console.log('\n  live is untouched');
  const liveHash = await page.evaluate(async () => {
    const before = location.hash;
    openTitle({ kind: 'live', id: 9, name: 'A Channel' });
    return { before, after: location.hash };
  });
  check('a channel does not get a page of its own',
    liveHash.after === liveHash.before, JSON.stringify(liveHash));
  await page.evaluate(() => closePlayer());

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
