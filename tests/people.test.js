/**
 * People: who is in what, and what they look like.
 *
 * "Everything in my library with this actor in it" is a question Xtream
 * cannot be asked — a category listing carries titles and ids, and the cast
 * lives in a per-film call over an account that allows one connection. So the
 * box builds the answer up instead: every film anybody opens is recorded on
 * the way past, and a crawler fills the rest in while nothing is playing.
 *
 * Which makes the honesty of the answer the thing most worth testing. A page
 * that says "3 films" when it has read the credits of two hundred out of nine
 * thousand is not answering the question that was asked, so the count of what
 * has been read travels with every answer and is on screen underneath it.
 *
 * The portraits come from IMDb's own suggestion endpoint — the one its search
 * box types into. Nobody without a page there gets a picture, which is the
 * rule asked for; the initials the page already draws are the fallback, and
 * they stay for anybody IMDb has never heard of. IMDb itself is never called
 * here: the suite answers as it does, and what is under test is our reading.
 */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGP8//' +
  '8/AzJgYkAD5AsAAP//DkYCbYrGZ2sAAAAASUVORK5CYII=', 'base64');

const MOVIES = {
  categories: [{ id: 'c1', name: 'Films' }],
  items: [
    { kind: 'movie', id: 55, name: 'A Film', categoryId: 'c1', logo: 'http://p/a.jpg', ext: 'mp4', rating: '8.6' },
    { kind: 'movie', id: 56, name: 'Another Film', categoryId: 'c1', logo: 'http://p/b.jpg', ext: 'mp4' },
    { kind: 'movie', id: 57, name: 'A Third Film', categoryId: 'c1', logo: '', ext: 'mp4' },
  ],
  totals: { items: 3 },
};

(async () => {
  /* ---- the module on its own ------------------------------------------- */
  //
  // Lifted rather than reimplemented: the folding rule is what makes "Robert
  // Downey Jr." and "robert downey jr" the same person, and it is the one
  // thing here that silently ruins an index if it drifts.
  console.log('\n  the index itself');
  const people = require(path.join(PATHS.ROOT, 'people.js'));

  check('one spelling per person, however the provider punctuated it',
    people.fold('Robert Downey Jr.') === people.fold('  ROBERT   downey  jr '),
    people.fold('Robert Downey Jr.'));
  check('and accents fold into the same name',
    people.fold('Penélope Cruz') === people.fold('Penelope Cruz'), people.fold('Penélope Cruz'));

  const parsed = people.peopleIn({ cast: 'A Actor, B Actor , A Actor', director: 'D Director' });
  check('a cast string is split and de-duplicated',
    parsed.cast.join('|') === 'A Actor|B Actor', JSON.stringify(parsed.cast));
  check('and the director is read separately',
    parsed.directors.join('|') === 'D Director', JSON.stringify(parsed.directors));

  people.note(55, { cast: 'A Actor, B Actor', director: 'D Director' });
  people.note(57, { cast: 'B Actor', director: 'E Director' });
  check('a film is found by anybody in it',
    people.filmsWith('a actor').join(',') === '55'
      && people.filmsWith('B ACTOR').sort().join(',') === '55,57',
    JSON.stringify(people.filmsWith('B ACTOR')));
  check('and a director is found the same way',
    people.filmsWith('D Director').join(',') === '55', JSON.stringify(people.filmsWith('D Director')));
  check('with the two kept apart, so a page can say which they were',
    people.directed('D Director', 55) && !people.directed('A Actor', 55));
  check('a film whose credits are known is not asked about again',
    people.known(55) && !people.known(56));

  /* The crawl is one film per tick and NEVER while the provider is busy: it
     is a call on the one connection, and nobody pressing play should ever be
     queued behind the index being built. */
  console.log('\n  the crawler and the one connection');
  const asked = [];
  const fetchInfo = async (id) => { asked.push(String(id)); return { cast: 'C Actor' }; };
  const items = MOVIES.items;
  await people.crawl({ items, busy: () => true, fetchInfo });
  check('nothing is fetched while something is playing', asked.length === 0, JSON.stringify(asked));

  await people.crawl({ items, busy: () => false, fetchInfo });
  check('and when the box is idle it takes exactly one film',
    asked.length === 1 && asked[0] === '56', JSON.stringify(asked));
  check('the one it did not already know', people.known(56));
  await people.crawl({ items, busy: () => false, fetchInfo });
  check('a second pass with nothing left to read asks for nothing',
    asked.length === 1, JSON.stringify(asked));

  /* ---- the portrait ---------------------------------------------------- */
  //
  // A fake IMDb, answering the way IMDb does. The match has to be strict: the
  // suggestion endpoint returns films and characters too, and an actor whose
  // name it does not carry must come back empty rather than wearing a
  // stranger's face.
  console.log('\n  portraits, and who does not get one');
  let imdbCalls = 0;
  const fakeImdb = async (url) => {
    imdbCalls += 1;
    const query = decodeURIComponent(url).toLowerCase();
    const body = query.includes('matthew mcconaughey')
      ? { d: [
        { id: 'tt0816692', l: 'Interstellar' },
        { id: 'nm0000190', l: 'Matthew McConaughey', i: { imageUrl: 'https://m.media-amazon.com/images/M/abc._V1_FMjpg_UX1000_.jpg' } },
      ] }
      : { d: [{ id: 'nm9999999', l: 'Somebody Else', i: { imageUrl: 'https://x/y._V1_.jpg' } }] };
    return {
      statusCode: 200,
      resume() {},
      body: Buffer.from(JSON.stringify(body)),
    };
  };
  const readBody = async (res) => res.body;

  const face = await people.portrait('Matthew McConaughey', fakeImdb, readBody);
  check('somebody with a page gets their headshot', Boolean(face && face.image), JSON.stringify(face));
  check('at a sane size rather than the full-size still',
    /_V1_QL75_UX280_\.jpg$/.test(face.image), face.image);
  check('and the IMDb id comes with it', face.id === 'nm0000190', face && face.id);

  const before = imdbCalls;
  await people.portrait('matthew  mcconaughey', fakeImdb, readBody);
  check('a second ask is answered from the cache, not from IMDb',
    imdbCalls === before, `${imdbCalls} calls`);

  const nobody = await people.portrait('Nobody Atall', fakeImdb, readBody);
  check('a name IMDb answers about with somebody else gets no picture',
    nobody === null, JSON.stringify(nobody));

  const missBefore = imdbCalls;
  await people.portrait('Nobody Atall', fakeImdb, readBody);
  check('and the miss is remembered, so a page of unknowns asks once',
    imdbCalls === missBefore, `${imdbCalls} calls`);

  /* ---- on the page ----------------------------------------------------- */
  console.log('\n  the film page');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/img?u=*', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOVIES) }));
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ info: {
      releasedate: '2014', genre: 'Sci-Fi', plot: 'Space.', duration: '02:49:00',
      cast: 'Matthew McConaughey, Anne Hathaway', director: 'Christopher Nolan',
      bitrate: 1800, video: { codec_name: 'h264', height: 1080 }, audio: { codec_name: 'aac' },
    } }) }));
  // Only the first of the three has a picture, which is the point: the other
  // two have to keep their initials.
  await page.route('**/api/people/portraits*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ people: [
      { name: 'Matthew McConaughey', image: 'https://m.media-amazon.com/x._V1_QL75_UX280_.jpg', id: 'nm0000190' },
      { name: 'Anne Hathaway', image: '' },
      { name: 'Christopher Nolan', image: '' },
    ] }) }));
  await page.route('**/api/people/films*', (r) => {
    const name = new URL(r.request().url()).searchParams.get('name');
    const body = name === 'Christopher Nolan'
      ? { name, ids: ['55'], directed: ['55'], indexed: 200, total: 9000 }
      : { name, ids: ['55', '57'], directed: [], indexed: 200, total: 9000 };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }
  await page.evaluate(() => { state.config.mode = 'xtream'; location.hash = '#/movies/55'; });
  await page.waitForFunction(() => document.querySelectorAll('.film-person').length >= 3,
    null, { timeout: 10000 });
  await page.waitForTimeout(600);

  const rail = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll('.film-person')].map((t) => t.tagName),
    withPortrait: document.querySelectorAll('.film-face.has-portrait').length,
    initials: [...document.querySelectorAll('.film-face')].map((f) => f.firstChild?.textContent || ''),
    director: document.querySelector('.film-credit-value .film-chip')?.tagName,
  }));
  console.log('   ', JSON.stringify(rail));
  check('every cast tile is a button, because it goes somewhere',
    rail.tiles.length === 3 && rail.tiles.every((t) => t === 'BUTTON'), JSON.stringify(rail.tiles));
  check('the one with an IMDb page wears their portrait',
    rail.withPortrait === 1, String(rail.withPortrait));
  check('and the ones without keep their initials',
    rail.initials[1] === 'AH' && rail.initials[2] === 'CN', JSON.stringify(rail.initials));
  check('the director is a button too', rail.director === 'BUTTON', rail.director);

  /* ---- following a name ------------------------------------------------ */
  console.log('\n  following an actor');
  await page.evaluate(() => document.querySelector('.film-person').click());
  await page.waitForFunction(() => document.querySelector('.person-note')
    && !/Looking/.test(document.querySelector('.person-note').textContent), null, { timeout: 8000 });

  const view = await page.evaluate(() => ({
    hash: decodeURIComponent(location.hash),
    title: document.querySelector('#contentTitle')?.textContent,
    meta: document.querySelector('#contentMeta')?.textContent,
    note: document.querySelector('.person-note')?.textContent,
    cards: [...document.querySelectorAll('#grid .card .card-title')].map((c) => c.textContent),
  }));
  console.log('   ', JSON.stringify(view));
  check('the address says whose films these are',
    view.hash === '#/movies/by/Matthew McConaughey', view.hash);
  check('and so does the heading', view.title === 'Matthew McConaughey', view.title);
  check('the films are the ones the box said, and no others',
    view.cards.join(',') === 'A Film,A Third Film', JSON.stringify(view.cards));
  check('counted', /2 films/.test(view.meta || ''), view.meta);
  /* The whole point: 200 of 9,000 read means this is what has been found so
     far, not what exists. */
  check('and the answer says how much of the library it speaks for',
    /200 of 9,000/.test(view.note || '') && /grows/.test(view.note || ''), view.note);

  console.log('\n  following a director');
  await page.evaluate(() => { location.hash = '#/movies/55'; });
  await page.waitForFunction(() => document.querySelector('.film-credit-value .film-chip'),
    null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.film-credit-value .film-chip').click());
  await page.waitForFunction(() => document.querySelector('.person-note')
    && !/Looking/.test(document.querySelector('.person-note').textContent), null, { timeout: 8000 });

  const byDirector = await page.evaluate(() => ({
    hash: decodeURIComponent(location.hash),
    title: document.querySelector('#contentTitle')?.textContent,
    meta: document.querySelector('#contentMeta')?.textContent,
    cards: [...document.querySelectorAll('#grid .card .card-title')].map((c) => c.textContent),
  }));
  console.log('   ', JSON.stringify(byDirector));
  check('the director\'s name opens their films',
    byDirector.hash === '#/movies/by/Christopher Nolan', byDirector.hash);
  check('which is the one film of theirs the box has read',
    byDirector.cards.join(',') === 'A Film', JSON.stringify(byDirector.cards));
  check('and it says they directed it rather than appeared in it',
    /1 as director/.test(byDirector.meta || ''), byDirector.meta);

  console.log('\n  and back out');
  await page.evaluate(() => document.querySelector('.folder-back').click());
  await page.waitForTimeout(900);
  const out = await page.evaluate(() => ({
    hash: location.hash,
    cards: document.querySelectorAll('#grid .card, #rowsView .card').length,
    note: document.querySelectorAll('.person-note').length,
  }));
  check('the way back is to all movies', out.hash === '#/movies', out.hash);
  check('and the person\'s line goes with it', out.note === 0, String(out.note));

  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
