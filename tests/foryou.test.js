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

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
