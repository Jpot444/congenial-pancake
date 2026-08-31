/**
 * For you — films this house has NOT seen.
 *
 * "I want the For You recommendations based on my watching and how I have
 *  rated things, I want it suggesting new things I might like... So no longer
 *  should For You in movies be things that I have watched before."
 *
 * The row was a list of what had already been watched. That is a useful row
 * and this app has one — Continue watching — but as a RECOMMENDATION it is
 * the opposite of the job. The one thing that certainly answers "what should
 * I put on" is something nobody here has put on.
 *
 * Three claims, and the third is the one the request turns on.
 *
 *   NOTHING WATCHED COMES BACK. Not the films in the history, and not the
 *   ones thumbed down — a thumb down is not a weak like, it is the one signal
 *   here that subtracts.
 *
 *   THE REASONS ARE THE ONES A VIEWER WOULD GIVE. A shared director counts
 *   for more than a shared actor, because a director is a choice and a
 *   character actor is in ninety films. The credits come from people.js,
 *   which has been building that index out of every film anybody opens.
 *
 *   AND WHAT OTHER PEOPLE REACHED FOR. "People who enjoyed that also enjoyed"
 *   is a fact about audiences that no amount of local metadata can produce,
 *   so it is asked of somebody else's server by title — and matched back
 *   against the library, because a recommendation for a film this house
 *   cannot play is not a recommendation. It is allowed to fail: the local
 *   signals stand on their own, and the answer says whether it worked.
 *
 * And when there is nothing to go on, it asks. A recommender with no signal
 * should say so rather than dressing the alphabet up as a suggestion.
 */
const recommend = require('../recommend.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

/* A small library with a shape worth reasoning about: two films by one
   director, a run with a shared lead, and a couple of unrelated ones. */
const MOVIES = [
  { id: '1', name: 'Heat (1995)', categoryId: 'crime', rating: '8.2', logo: 'a.jpg' },
  { id: '2', name: 'The Insider', categoryId: 'crime', rating: '7.8', logo: 'b.jpg' },
  { id: '3', name: 'Collateral', categoryId: 'crime', rating: '7.5', logo: 'c.jpg' },
  { id: '4', name: 'Ronin', categoryId: 'crime', rating: '7.3', logo: 'd.jpg' },
  { id: '5', name: 'Paddington 2', categoryId: 'kids', rating: '8.5', logo: 'e.jpg' },
  { id: '6', name: 'A Dull Thing', categoryId: 'crime', rating: '4.1', logo: 'f.jpg' },
  { id: '7', name: 'Sicario', categoryId: 'crime', rating: '7.6', logo: 'g.jpg' },
  { id: '8', name: 'Nobody Knows This', categoryId: 'misc', rating: '6.4', logo: 'h.jpg' },
];

/* people.js's index, as it would be after the crawler had been round. */
const CREDITS = {
  1: { directors: ['Michael Mann'], cast: ['Al Pacino', 'Robert De Niro'] },
  2: { directors: ['Michael Mann'], cast: ['Al Pacino', 'Russell Crowe'] },
  3: { directors: ['Michael Mann'], cast: ['Tom Cruise', 'Jamie Foxx'] },
  4: { directors: ['John Frankenheimer'], cast: ['Robert De Niro'] },
  5: { directors: ['Paul King'], cast: ['Ben Whishaw'] },
  6: { directors: ['Nobody At All'], cast: ['Nobody At All'] },
  7: { directors: ['Denis Villeneuve'], cast: ['Emily Blunt'] },
  8: { directors: ['Someone Else'], cast: ['Someone Else'] },
};
const people = { creditsFor: (id) => CREDITS[String(id)] || null };

const AFFINITY = [{ kind: 'movie', categoryId: 'crime', score: 10 }];

/** A profile that watched Heat and finished it. */
const watchedHeat = (extra = {}) => ({
  ratings: { 'movie:1': 1, ...(extra.ratings || {}) },
  history: [
    { kind: 'movie', id: '1', key: 'movie:1', name: 'Heat (1995)',
      categoryId: 'crime', completed: true, duration: 6000, position: 6000 },
    ...(extra.history || []),
  ],
});

(async () => {
  /* ---- nothing that has been watched ---------------------------------- */
  console.log('\n  the row stops being a list of what you have already seen');
  const profile = watchedHeat({
    ratings: { 'movie:1': 1, 'movie:7': -1 },
    history: [
      { kind: 'movie', id: '3', key: 'movie:3', name: 'Collateral',
        categoryId: 'crime', completed: true, duration: 6000, position: 6000 },
      { kind: 'movie', id: '7', key: 'movie:7', name: 'Sicario',
        categoryId: 'crime', completed: true, duration: 6000, position: 6000 },
    ],
  });

  const answer = await recommend.forYou({
    profile,
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  const ids = answer.items.map((i) => i.id);
  console.log('   recommended:', JSON.stringify(answer.items.map((i) => [i.id, i.name, i.why])));
  check('nothing already watched is recommended',
    !ids.includes('1') && !ids.includes('3'), JSON.stringify(ids));
  /* A thumb down is not a weak like. It is the one signal here that
     subtracts, and the film itself must never come back. */
  check('and nothing thumbed down either', !ids.includes('7'), JSON.stringify(ids));
  check('but there is something to watch', answer.items.length > 0, String(answer.items.length));

  console.log('\n  and the reasons are the ones a viewer would give');
  const insider = answer.items.find((i) => i.id === '2');
  console.log('   The Insider:', JSON.stringify(insider && insider.why));
  /* A director is a choice; a character actor is in ninety films. So the
     same-director film leads, and it says so. */
  check('a film by the director of one you liked leads the row',
    ids[0] === '2', JSON.stringify(ids));
  check('and says that is why', insider && /Michael Mann/.test(insider.why[0] || ''),
    JSON.stringify(insider && insider.why));
  const ronin = answer.items.find((i) => i.id === '4');
  check('a shared actor counts too, and names them',
    ronin && /De Niro/.test((ronin.why || []).join(' ')), JSON.stringify(ronin && ronin.why));
  check('but counts for less than a shared director',
    ids.indexOf('2') < ids.indexOf('4'), JSON.stringify(ids));
  /* A high provider rating is a tiebreak, never a reason on its own —
     otherwise the row is a chart, which every other row on the page already
     is. Paddington is the best-rated thing in this library and has nothing
     whatever to do with what was watched. */
  check('a film with nothing in common is not recommended for being well rated',
    !ids.includes('5'), JSON.stringify(ids));

  /* ---- what other people also enjoyed ---------------------------------- */
  console.log('\n  and what other people reached for after it');
  const asked = [];
  const coTaste = await recommend.forYou({
    profile,
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: async (url) => {
      asked.push(url);
      /* The shape that service answers in. 'Nobody Knows This' shares no
         director, no actor and no shelf with anything watched — an audience
         is the ONLY thing that could put it in this row. */
      return { Similar: { Results: [{ Name: 'Nobody Knows This', Type: 'movie' }] } };
    },
  });
  const coIds = coTaste.items.map((i) => i.id);
  const found = coTaste.items.find((i) => i.id === '8');
  console.log('   asked:', asked.length, 'first:', JSON.stringify(coIds.slice(0, 3)));
  console.log('   co-taste:', JSON.stringify(found && found.why));
  check('the service is asked by title, about what was liked',
    asked.length > 0 && /Heat/i.test(decodeURIComponent(asked[0])), asked[0]);
  check('a film only an audience could connect is recommended',
    coIds.includes('8'), JSON.stringify(coIds));
  check('and it leads, because that is the strongest thing anybody can say',
    coIds[0] === '8', JSON.stringify(coIds));
  check('saying which film it was that people also liked',
    found && /people who liked heat/i.test(found.why[0] || ''),
    JSON.stringify(found && found.why));
  check('and the answer reports that the asking worked',
    coTaste.similar.answered > 0, JSON.stringify(coTaste.similar));

  console.log('\n  the source that is actually built for the question');
  /*
   * The Movie Database answers what its users went on to watch — the
   * audience answer, not a similarity score off a genre tag — which is
   * exactly what was asked for. It wants a key, so it is first on the list
   * only when there is one.
   */
  const seenUrls = [];
  const seenHeaders = [];
  const tmdb = await recommend.forYou({
    profile,
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [],
    cache: new Map(),
    tmdbKey: 'a-key-that-is-long-enough',
    fetchJson: async (url, headers) => {
      seenUrls.push(url);
      seenHeaders.push(headers || {});
      if (url.includes('/search/movie')) return { results: [{ id: 949, title: 'Heat' }] };
      if (url.includes('/recommendations')) {
        return { results: [{ title: 'Nobody Knows This' }] };
      }
      return { results: [] };
    },
  });
  console.log('   asked:', JSON.stringify(seenUrls.slice(0, 2).map((u) => u.split('?')[0])));
  check('it looks the film up and then asks what that audience watched next',
    seenUrls.some((u) => u.includes('/search/movie'))
    && seenUrls.some((u) => u.includes('/949/recommendations')),
    JSON.stringify(seenUrls.map((u) => u.split('?')[0])));
  check('and what comes back leads the row',
    tmdb.items[0] && tmdb.items[0].id === '8', JSON.stringify(tmdb.items.map((i) => i.id)));
  check('the answer names which service it was',
    tmdb.similar.source === 'themoviedb', JSON.stringify(tmdb.similar));
  /* The key is a secret. It has to travel in the request to that service and
     nowhere else — not into a log line, not into what this box hands back. */
  check('and the key is not in anything the box reports',
    !JSON.stringify(tmdb).includes('a-key-that-is-long-enough'),
    'the key appears in the answer');

  /* ---- and it takes either of the two credentials ---------------------- */
  /*
   * That service issues two and they are not interchangeable: a v4 READ
   * TOKEN, which is a JWT of a couple of hundred characters and belongs in an
   * Authorization header, and a v3 API KEY of thirty-two hex characters that
   * goes in the query string. Somebody pasting one should not also have to
   * know which it was.
   */
  console.log('\n  either credential, told apart by its shape');
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ3aGF0ZXZlciJ9.c2lnbmF0dXJlLWhlcmU';
  const KEY32 = '00000000000000000000000000000000';
  const asToken = recommend.tmdbAuth(TOKEN);
  const asKey = recommend.tmdbAuth(KEY32);
  console.log('   token:', JSON.stringify(Object.keys(asToken.headers)), 'query:', asToken.query);
  console.log('   key:  ', JSON.stringify(Object.keys(asKey.headers)), 'query:', asKey.query);
  check('a read token is carried in a header', /^Bearer /.test(asToken.headers.authorization),
    JSON.stringify(asToken.headers));
  /* A secret in a URL is a secret in every log, proxy and error message that
     URL passes through. The header form never puts it there at all. */
  check('and never in the query string', asToken.query === '', asToken.query);
  check('an api key goes in the query string, where that one has to',
    asKey.query.startsWith('api_key='), asKey.query);
  check('and carries no header of its own',
    Object.keys(asKey.headers).length === 0, JSON.stringify(asKey.headers));
  check('nothing at all is nothing at all', recommend.tmdbAuth('') === null);

  /* The header has to actually reach the fetch, or the token is carried
     nowhere and the service answers 401 about a credential that is fine. */
  const tokenUrls = [];
  const tokenHeaders = [];
  await recommend.forYou({
    profile,
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [],
    cache: new Map(),
    tmdbKey: TOKEN,
    fetchJson: async (url, headers) => {
      tokenUrls.push(url);
      tokenHeaders.push(headers || {});
      return { results: [{ id: 949, title: 'Heat' }] };
    },
  });
  console.log('   asked with:', JSON.stringify(tokenHeaders[0]).slice(0, 40) + '…');
  check('the header reaches the request',
    /^Bearer ey/.test((tokenHeaders[0] || {}).authorization || ''),
    JSON.stringify(tokenHeaders[0]));
  check('and the token is in no address the box builds',
    tokenUrls.every((u) => !u.includes('ey')), JSON.stringify(tokenUrls[0]));

  console.log('\n  and without a key it says so rather than blaming the server');
  const keyless = await recommend.forYou({
    profile,
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: async () => { throw new Error('HTTP 404'); },
  });
  console.log('   keyless:', JSON.stringify(keyless.similar));
  /* A door nobody has been given a key to is not a broken door. Saying
     'HTTP 401' about it sends somebody looking for a fault instead of for a
     key. */
  check('a source with no key reads as no key, not as a failure',
    /no key/.test(keyless.similar.error || ''), JSON.stringify(keyless.similar));

  console.log('\n  a service that will not answer costs the row nothing');
  const refused = await recommend.forYou({
    profile,
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: async () => { throw new Error('HTTP 403'); },
  });
  console.log('   refused:', JSON.stringify(refused.similar));
  /* It is somebody else's server, it needs no key and therefore promises
     nothing. The local signals have to stand on their own. */
  check('the recommendations still arrive',
    refused.items.length > 0 && refused.items[0].id === '2',
    JSON.stringify(refused.items.map((i) => i.id)));
  check('and the answer says the asking did not work',
    /403/.test(refused.similar.error || ''), JSON.stringify(refused.similar));

  console.log('\n  and it is only asked once about the same film');
  const cache = new Map();
  const hits = [];
  const twice = { profile, movies: MOVIES, categoryAffinity: AFFINITY, people, seeds: [], cache,
    fetchJson: async (url) => { hits.push(url); return { Similar: { Results: [] } }; } };
  await recommend.forYou(twice);
  const first = hits.length;
  await recommend.forYou(twice);
  console.log('   asks:', first, '->', hits.length);
  /* What an audience enjoyed alongside a film is a fact about a decade, not
     about this afternoon. Asking again on every page view would be rude to
     somebody who is answering for free. */
  check('a second look asks nobody anything', hits.length === first, String(hits.length));

  /* ---- when there is nothing to go on ---------------------------------- */
  console.log('\n  with nothing to go on, it asks rather than guesses');
  const cold = await recommend.forYou({
    profile: { ratings: {}, history: [] },
    movies: MOVIES,
    categoryAffinity: [],
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  console.log('   cold:', JSON.stringify({ needs: cold.needs, picks: cold.picks.length }));
  check('it says what it needs', cold.needs === 'seeds', cold.needs);
  check('and offers films to pick from', cold.picks.length > 0, String(cold.picks.length));
  /* A picker is a wall of covers, and a title with no cover is a grey box
     nobody picks. A badly rated film is not something anybody has an opinion
     about either. */
  check('all of which have a cover and are worth an opinion',
    cold.picks.every((f) => f.logo && Number(f.rating) >= 6),
    JSON.stringify(cold.picks.map((f) => [f.name, f.rating])));
  /* Forty films off one shelf teaches the box that this house likes that
     shelf, which is the opposite of asking. */
  const perShelf = {};
  for (const f of cold.picks) perShelf[f.categoryId] = (perShelf[f.categoryId] || 0) + 1;
  check('and they are spread across shelves rather than taken off one',
    Object.values(perShelf).every((n) => n <= 3), JSON.stringify(perShelf));

  console.log('\n  and the picks are worth as much as a thumbs-up');
  const seeded = await recommend.forYou({
    profile: { ratings: {}, history: [] },
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [{ id: '1', name: 'Heat (1995)' }, { id: '3', name: 'Collateral' },
      { id: '4', name: 'Ronin' }],
    cache: new Map(),
    fetchJson: null,
  });
  const seedIds = seeded.items.map((i) => i.id);
  console.log('   from picks:', JSON.stringify(seedIds));
  check('picking three films is enough to stop asking',
    seeded.needs === '' && seeded.items.length > 0, JSON.stringify(seeded.needs));
  check('and they drive the row the way watching would',
    seedIds.includes('2'), JSON.stringify(seedIds));
  /* Picking a favourite is not watching it here — the box has no idea
     whether this house has ever played it — so it must not be treated as
     seen. It is simply not recommended back, because it is a seed. */
  check('a picked film is not recommended back at you',
    !seedIds.includes('1'), JSON.stringify(seedIds));

  /* ---- the titles have to meet ----------------------------------------- */
  console.log('\n  and two spellings of one film are one film');
  const same = ['The Matrix (1999)', 'Matrix, The', 'THE MATRIX 4K', 'the matrix']
    .map(recommend.foldTitle);
  console.log('   folded:', JSON.stringify(same));
  /* A provider writes a title four ways and a recommendation service writes
     it a fifth. They have to meet somewhere or the co-taste layer matches
     nothing at all. */
  check('a provider\'s spelling and a service\'s meet',
    new Set(same.slice(0, 1).concat(same[2], same[3])).size === 1, JSON.stringify(same));
  check('but a remake is still a different film',
    recommend.foldTitle('Dune') !== recommend.foldTitle('Dune Part Two'));

  /* ---- and the page about one film ------------------------------------- */
  /*
   * "Inside of the movie cards, instead of 'more from X category' make it an
   *  others enjoyed section that suggests similar movies."
   *
   * A category rail answers what else the provider filed in the same place,
   * and the provider files by whatever its categories happen to be. Somebody
   * who has just read about a film is asking a better question. Same three
   * signals as the row, in the same order — an audience, then the people who
   * made it, then the shelf.
   */
  console.log('\n  and the page about one film');
  const near = await recommend.similarTo({
    film: MOVIES[0],
    movies: MOVIES,
    people,
    cache: new Map(),
    fetchJson: async () => ({ Similar: { Results: [{ Name: 'Nobody Knows This' }] } }),
  });
  const nearIds = near.items.map((i) => i.id);
  console.log('   like Heat:', JSON.stringify(near.items.map((i) => [i.name, i.why[0]])));
  check('the film itself is not in its own row',
    !nearIds.includes('1'), JSON.stringify(nearIds));
  check('what an audience reached for leads it',
    nearIds[0] === '8' && /also liked/i.test(near.items[0].why[0]),
    JSON.stringify([nearIds[0], near.items[0] && near.items[0].why]));
  const byMann = near.items.find((i) => i.id === '2');
  check('then the people who made it, named',
    byMann && /Michael Mann/.test(byMann.why[0]), JSON.stringify(byMann && byMann.why));
  /* Nothing is excluded for having been watched. This is not "what to watch
     next", it is "what is this like" — and a film you have seen is a
     perfectly good answer to that, often the most useful one on the row. */
  check('and a film already watched is still a good answer to what this is like',
    nearIds.includes('3'), JSON.stringify(nearIds));

  console.log('\n  and the shelf is the last answer rather than no answer');
  const bare = await recommend.similarTo({
    /* A film nobody has indexed and no service has heard of. The row still
       has to have something under it. */
    film: { id: '99', name: 'Unheard Of', categoryId: 'crime' },
    movies: MOVIES,
    people: { creditsFor: () => null },
    cache: new Map(),
    fetchJson: async () => { throw new Error('HTTP 403'); },
  });
  console.log('   bare:', JSON.stringify(bare.items.map((i) => [i.name, i.why[0]])));
  check('a film nothing knows about still gets a row',
    bare.items.length > 0, String(bare.items.length));
  check('off the shelf it sits on, and it says so',
    bare.items.every((i) => i.categoryId === 'crime')
    && /same shelf/i.test(bare.items[0].why[0]),
    JSON.stringify(bare.items.map((i) => [i.categoryId, i.why[0]])));
  check('and the answer says the asking did not work',
    /403/.test(bare.similar.error || ''), JSON.stringify(bare.similar));

  /* ---- and the same row for shows -------------------------------------- */
  /*
   * "I want to add the same recommendation 'for you' section to the series tab
   *  so I can be recommended new series to watch based on my ratings and
   *  viewing history."
   *
   * The same reckoning, asked of the other half of the catalogue — but the two
   * halves do not carry the same facts, and pretending they do is how a
   * generalisation quietly breaks.
   *
   *   HISTORY IS PER EPISODE, and a viewer never rates one. The thumb on a
   *   show card is filed under `series:<show>`; the episode rows are filed
   *   under `series:<show>:s1e4`. Reading `ratings[row.key]` — which is what
   *   the film half does and is right about — finds nothing at all for a show.
   *
   *   CREDITS ARE FOR FILMS. people.js is built out of get_vod_info, which the
   *   provider answers about films. Asking it about a series id gets nothing
   *   back, or worse, gets a film that happens to share the number.
   *
   *   BUT SHOWS CARRY A GENRE and films do not. So the show half has a local
   *   signal of its own, and it is the one that has to do the work when there
   *   is no credits index to lean on.
   */
  console.log('\n  and the same row for shows');
  const SHOWS = [
    { kind: 'series', id: '10', name: 'The Wire', genre: 'Crime, Drama',
      categoryId: 'hbo', rating: '9.3', logo: 'w.jpg' },
    { kind: 'series', id: '11', name: 'The Sopranos', genre: 'Crime, Drama',
      categoryId: 'hbo', rating: '9.2', logo: 's.jpg' },
    { kind: 'series', id: '12', name: 'Bluey', genre: 'Kids, Animation',
      categoryId: 'kids', rating: '9.4', logo: 'b.jpg' },
    { kind: 'series', id: '13', name: 'Nobody Knows This Show', genre: 'Talk',
      categoryId: 'misc', rating: '6.1', logo: 'n.jpg' },
  ];

  /* Four episodes of one show, the way the app actually writes them: named
     per episode, keyed per episode, pointed at the show by seriesId. */
  const watchedTheWire = {
    ratings: {},
    history: [1, 2, 3, 4].map((n) => ({
      kind: 'series', id: '10', seriesId: '10',
      key: `series:10:s1e${n}`, name: `The Wire — S1E${n}`,
      categoryId: 'hbo', completed: true, duration: 3600, position: 3600,
    })),
  };

  const shows = await recommend.forYou({
    profile: watchedTheWire,
    kind: 'series',
    catalogue: SHOWS,
    categoryAffinity: [{ kind: 'series', categoryId: 'hbo', score: 10 }],
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  const showIds = shows.items.map((i) => i.id);
  console.log('   recommended:', JSON.stringify(shows.items.map((i) => [i.name, i.why])));
  check('a show that was watched is not recommended back',
    !showIds.includes('10'), JSON.stringify(showIds));
  /* The genre line is the show half's answer to the credits index. Without it
     there is no local signal at all and the row is empty whatever anybody
     watched. */
  check('another show in the same genres is',
    showIds.includes('11'), JSON.stringify(showIds));
  const sopranos = shows.items.find((i) => i.id === '11');
  check('and it says which genres, because that is a reason you can disagree with',
    sopranos && /crime|drama/i.test((sopranos.why || []).join(' ')),
    JSON.stringify(sopranos && sopranos.why));
  /* Bluey is the best-rated thing in that list and shares nothing. A rating is
     a tiebreak, never a reason. */
  check('and an unrelated show is not, however well rated',
    !showIds.includes('12'), JSON.stringify(showIds));

  console.log('\n  a thumb on a show is filed on the show, not on an episode');
  const thumbedDown = await recommend.forYou({
    profile: {
      // Where the show card actually writes it. The episode rows are elsewhere.
      ratings: { 'series:10': -1 },
      history: watchedTheWire.history,
    },
    kind: 'series',
    catalogue: SHOWS,
    categoryAffinity: [],
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  console.log('   after a thumb down:', JSON.stringify(thumbedDown.items.map((i) => i.name)));
  /* Read from the episode key this would be no signal at all, the four
     finished episodes would still read as a like, and The Sopranos would be
     recommended off the back of a show that was actively disliked. */
  check('so a disliked show pushes its genres down rather than up',
    !thumbedDown.items.some((i) => i.id === '11'),
    JSON.stringify(thumbedDown.items.map((i) => i.id)));
  /* And that it was READ, not merely lost. With the one show in the history
     disliked there is nothing left to guess from, and the honest answer is to
     ask — which is a different state from a row that came out empty. */
  check('and with nothing else said, the row asks instead of sitting blank',
    thumbedDown.needs === 'seeds' && thumbedDown.picks.length > 0,
    JSON.stringify({ needs: thumbedDown.needs, picks: thumbedDown.picks.length }));

  /* A thumb down has to be able to push something OFF a row it would
     otherwise be on. With only the loathed column filled there is nothing
     'loved' to compare against, and reading the penalty only when there is
     would make a lone thumb down the one gesture that does nothing. */
  const mixed = await recommend.forYou({
    profile: {
      ratings: { 'series:10': -1, 'series:12': 1 },
      history: [
        ...watchedTheWire.history,
        { kind: 'series', id: '12', seriesId: '12', key: 'series:12:s1e1',
          name: 'Bluey — S1E1', completed: true, duration: 600, position: 600 },
      ],
    },
    kind: 'series',
    catalogue: [...SHOWS,
      // Kids AND crime: liked for one word, loathed for the other.
      { kind: 'series', id: '14', name: 'Awkward Crossover', genre: 'Kids, Crime',
        categoryId: 'kids', rating: '7.0', logo: 'x.jpg' }],
    categoryAffinity: [{ kind: 'series', categoryId: 'kids', score: 10 }],
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  const mixedIds = mixed.items.map((i) => i.id);
  console.log('   with a like and a dislike:',
    JSON.stringify(mixed.items.map((i) => [i.name, i.why])));
  check('a liked genre still recommends',
    mixedIds.includes('14'), JSON.stringify(mixedIds));
  /* The Sopranos is nothing but the disliked show's two genres. */
  check('and a disliked one keeps its shows off the row',
    !mixedIds.includes('11'), JSON.stringify(mixedIds));
  const crossover = mixed.items.find((i) => i.id === '14');
  check('with the reason naming the word that was liked, not the one that was not',
    crossover && /kids/i.test((crossover.why || []).join(' '))
    && !/crime/i.test((crossover.why || []).join(' ')),
    JSON.stringify(crossover && crossover.why));

  console.log('\n  and the service is asked about shows, not about films');
  const showUrls = [];
  await recommend.forYou({
    profile: watchedTheWire,
    kind: 'series',
    catalogue: SHOWS,
    categoryAffinity: [],
    people,
    seeds: [],
    cache: new Map(),
    tmdbKey: '00000000000000000000000000000000',
    fetchJson: async (url) => {
      showUrls.push(url);
      if (url.includes('/search/tv')) return { results: [{ id: 1438, name: 'The Wire' }] };
      // A show is `name` where a film is `title`. Reading only one of them is
      // how the whole show half comes back empty.
      if (url.includes('/recommendations')) return { results: [{ name: 'Nobody Knows This Show' }] };
      return { results: [] };
    },
  });
  console.log('   asked:', JSON.stringify(showUrls.map((u) => u.split('?')[0])));
  /* That service keeps films and shows in separate halves under different
     words, and answers about neither if asked the wrong way. */
  check('the tv half of the service is what gets asked',
    showUrls.some((u) => u.includes('/search/tv'))
    && !showUrls.some((u) => u.includes('/search/movie')),
    JSON.stringify(showUrls.map((u) => u.split('?')[0])));
  /* History is written per episode and named for one — 'The Wire — S1E4'. The
     thing to ask an audience about is the show. */
  check('and about the show rather than about one episode of it',
    showUrls[0] && /query=The%20Wire(&|$)/.test(showUrls[0])
    && !/S1E/i.test(showUrls[0]), showUrls[0]);

  console.log('\n  and a film and a show that share a title are two questions');
  /* Fargo is a film and Fargo is a show. One cache keyed on the title alone
     would answer the second with the first's audience. */
  const shared = new Map();
  const sharedUrls = [];
  const ask = async (kind) => recommend.forYou({
    profile: {
      ratings: {},
      history: [{ kind: kind === 'series' ? 'series' : 'movie', id: '1', seriesId: '1',
        key: 'x', name: 'Fargo', completed: true, duration: 10, position: 10 }],
    },
    kind,
    catalogue: [],
    categoryAffinity: [],
    people,
    seeds: [],
    cache: shared,
    fetchJson: async (url) => { sharedUrls.push(url); return { Similar: { Results: [] } }; },
  });
  await ask('movie');
  const afterFilm = sharedUrls.length;
  await ask('series');
  console.log('   asks:', afterFilm, '->', sharedUrls.length);
  check('asking about the show is not answered out of the film\'s cache',
    sharedUrls.length > afterFilm, String(sharedUrls.length));

  /* ---- not that one ---------------------------------------------------- */
  /*
   * "Only inside of the For You page on both tabs I want the trash can icon to
   *  remove it out of my recommendation page, but not hide it from the library
   *  like it does on other pages."
   *
   * Two different sentences wearing the same icon. The library bin means "I
   * never want to see this title"; the For You bin means "stop offering me
   * this guess". Paying for the second with the first would be a trap: this
   * row is made entirely of things nobody here has seen, so the only way to
   * find out whether you want one is to open it.
   */
  console.log('\n  and a suggestion that was answered');
  const refusedOne = await recommend.forYou({
    profile,
    movies: MOVIES,
    categoryAffinity: AFFINITY,
    people,
    seeds: [],
    notInterested: ['2'],
    cache: new Map(),
    fetchJson: null,
  });
  const leftIds = refusedOne.items.map((i) => i.id);
  console.log('   after binning The Insider:', JSON.stringify(leftIds));
  check('it stops being suggested', !leftIds.includes('2'), JSON.stringify(leftIds));
  /* And the row is still a row. Binning the one thing at the top of it must
     not empty it — the next-best answer moves up, which is the whole point of
     being able to say no to one. */
  check('and the row keeps going with the next best',
    leftIds.length > 0 && leftIds[0] === '4', JSON.stringify(leftIds));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
