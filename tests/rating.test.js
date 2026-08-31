/**
 * Saying you like something you are not about to watch.
 *
 * "I want a rating system where I can select like or dislike to tune my
 *  recommendations. Sometimes I have already watched a show or movie and want
 *  to use it as an example of something I like, but dont want to watch it
 *  again right now."
 *
 * There WAS a thumb, on the film page, and it did nothing whatever in this
 * case — which is the case the request is about.
 *
 * THE REASON. The taste was built out of the HISTORY, and the rating was only
 * ever consulted for rows already in it: gather what was watched, then ask
 * what the thumb on each said. A thumb on something this box has never played
 * — a show somebody watched years ago, somewhere else, and wants to hold up
 * as an example — matched no history row, so it was never read at all. The
 * press lit up, the toast said For You would lean on it, and nothing
 * happened.
 *
 * That is the whole of what "use it as an example of something I like"
 * means: a rating has to be a statement in its own right, not an annotation
 * on a watch.
 *
 * And it must not become a watch. Somebody saying "I liked this" is not
 * saying "put it on" — so the title is not added to what was seen, and it is
 * not recommended back at them either, because a row that answers "you like
 * this thing you told me you like" has answered nothing.
 */
const recommend = require('../recommend.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const SHOWS = [
  { kind: 'series', id: '10', name: 'The Wire', genre: 'Crime, Drama',
    categoryId: 'hbo', rating: '9.3', logo: 'w.jpg' },
  { kind: 'series', id: '11', name: 'The Sopranos', genre: 'Crime, Drama',
    categoryId: 'hbo', rating: '9.2', logo: 's.jpg' },
  { kind: 'series', id: '12', name: 'Bluey', genre: 'Kids, Animation',
    categoryId: 'kids', rating: '9.4', logo: 'b.jpg' },
  { kind: 'series', id: '13', name: 'Poirot', genre: 'Crime, Mystery',
    categoryId: 'itv', rating: '8.6', logo: 'p.jpg' },
];

const MOVIES = [
  { id: '1', name: 'Heat (1995)', categoryId: 'crime', rating: '8.2', logo: 'a.jpg' },
  { id: '2', name: 'The Insider', categoryId: 'crime', rating: '7.8', logo: 'b.jpg' },
  { id: '3', name: 'Paddington 2', categoryId: 'kids', rating: '8.5', logo: 'c.jpg' },
];
const CREDITS = {
  1: { directors: ['Michael Mann'], cast: ['Al Pacino'] },
  2: { directors: ['Michael Mann'], cast: ['Russell Crowe'] },
  3: { directors: ['Paul King'], cast: ['Ben Whishaw'] },
};
const people = { creditsFor: (id) => CREDITS[String(id)] || null };

(async () => {
  /* ---- a show rated, and never played here ----------------------------- */
  /*
   * The exact shape of the request: no history at all. Not a partial watch,
   * not a finished episode — nothing. Only a thumb.
   */
  console.log('\n  a show marked as liked, with nothing watched on this box');
  const answer = await recommend.forYou({
    profile: { ratings: { 'series:10': 1 }, history: [] },
    kind: 'series',
    catalogue: SHOWS,
    categoryAffinity: [],
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  const ids = answer.items.map((i) => i.id);
  console.log('   recommended:', JSON.stringify(answer.items.map((i) => [i.name, i.why])));
  /* Without this the row has nothing to go on and asks for seeds — which is
     the box telling somebody who has just told it what they like that it does
     not know what they like. */
  check('the thumb is enough on its own to build a row',
    answer.needs === '' && ids.length > 0,
    JSON.stringify({ needs: answer.needs, items: ids }));
  check('and it recommends what shares its genres',
    ids.includes('11') && ids.includes('13'), JSON.stringify(ids));
  check('but not something unrelated', !ids.includes('12'), JSON.stringify(ids));
  /* "You like this thing you told me you like" has answered nothing. */
  check('and never the show that was rated', !ids.includes('10'), JSON.stringify(ids));

  console.log('\n  and liking it is not watching it');
  const taste = recommend.tasteOf(
    { ratings: { 'series:10': 1 }, history: [] }, [], 'series', SHOWS);
  console.log('   ', JSON.stringify({
    liked: taste.liked, seen: [...taste.seen], disliked: [...taste.disliked] }));
  check('it counts as a like', taste.liked.some((r) => r.id === '10'),
    JSON.stringify(taste.liked));
  /* The other half of the sentence — "but dont want to watch it again right
     now". Nothing about a thumb says anybody played anything. */
  check('and is not recorded as seen', !taste.seen.has('10'), [...taste.seen].join());
  /* The name has to come from somewhere: a rating is stored as `series:10`
     and carries no title, and the title is what an audience is asked about. */
  check('and the box knows what it is called, so it can ask about it',
    taste.liked.find((r) => r.id === '10')?.name === 'The Wire',
    JSON.stringify(taste.liked));

  console.log('\n  and the service is asked about it by name');
  const asked = [];
  await recommend.forYou({
    profile: { ratings: { 'series:10': 1 }, history: [] },
    kind: 'series',
    catalogue: SHOWS,
    categoryAffinity: [],
    people,
    seeds: [],
    cache: new Map(),
    tmdbKey: '00000000000000000000000000000000',
    fetchJson: async (url) => { asked.push(url); return { results: [] }; },
  });
  console.log('   asked:', JSON.stringify(asked.map((u) => u.split('?')[0])));
  check('the co-taste layer gets a title rather than an id',
    asked.some((u) => /query=The%20Wire/.test(u)), JSON.stringify(asked[0] || ''));

  /* ---- a dislike, likewise ---------------------------------------------- */
  console.log('\n  and a show marked as not for me');
  const down = await recommend.forYou({
    profile: { ratings: { 'series:10': 1, 'series:13': -1 }, history: [] },
    kind: 'series',
    catalogue: SHOWS,
    categoryAffinity: [],
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  const downIds = down.items.map((i) => i.id);
  console.log('   recommended:', JSON.stringify(downIds));
  /* A thumb down is the one signal that subtracts, and it has to work from a
     standing start too — otherwise the only way to say "not this" is to watch
     the thing first. */
  check('the disliked show is not offered', !downIds.includes('13'), JSON.stringify(downIds));
  check('while what was liked still drives the row',
    downIds.includes('11'), JSON.stringify(downIds));

  /* ---- and an episode key is not a show ---------------------------------- */
  /*
   * History is written per episode and keyed `series:10:s1e4`. The show's own
   * thumb is `series:10`. Reading the ratings map without minding the
   * difference would invent a show whose id is "10:s1e4" — a title that is in
   * no catalogue, has no name, and would be asked about by that name.
   */
  console.log('\n  and an episode key is not a show');
  const episodes = recommend.tasteOf({
    ratings: { 'series:10:s1e4': 1, 'series:11': 1 },
    history: [],
  }, [], 'series', SHOWS);
  console.log('   ', JSON.stringify(episodes.liked));
  check('only the show-level thumb becomes a title',
    episodes.liked.length === 1 && episodes.liked[0].id === '11',
    JSON.stringify(episodes.liked));

  /* ---- and the other tab is not disturbed -------------------------------- */
  console.log('\n  and a film rating is a film rating');
  const films = await recommend.forYou({
    profile: { ratings: { 'movie:1': 1, 'series:12': 1 }, history: [] },
    kind: 'movie',
    catalogue: MOVIES,
    categoryAffinity: [],
    people,
    seeds: [],
    cache: new Map(),
    fetchJson: null,
  });
  const filmIds = films.items.map((i) => i.id);
  console.log('   recommended:', JSON.stringify(films.items.map((i) => [i.name, i.why])));
  /* The two halves share one ratings map and the same id space. Reading the
     wrong prefix is how a show somebody liked recommends a film. */
  check('a thumb on a film builds the film row',
    filmIds.includes('2'), JSON.stringify(filmIds));
  check('and the show thumb sitting beside it is left alone',
    !filmIds.includes('12'), JSON.stringify(filmIds));

  /* ---- and watching still counts for what it always did ------------------ */
  console.log('\n  and watching still says what it always said');
  const watched = recommend.tasteOf({
    ratings: {},
    history: [1, 2, 3].map((n) => ({
      kind: 'series', id: '10', seriesId: '10', key: `series:10:s1e${n}`,
      name: `The Wire — S1E${n}`, completed: true, duration: 3600, position: 3600,
    })),
  }, [], 'series', SHOWS);
  console.log('   ', JSON.stringify({ liked: watched.liked, seen: [...watched.seen] }));
  check('three finished episodes are still a like',
    watched.liked.some((r) => r.id === '10'), JSON.stringify(watched.liked));
  check('and watching IS recorded as seen', watched.seen.has('10'),
    [...watched.seen].join());

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
