/*
 * For you — films this house has not seen.
 *
 * The row called "For You" was a list of what had already been watched. That
 * is a useful row and this app has one: Continue watching. As a
 * recommendation it is the opposite of the job, which is to put up something
 * NEW that somebody here is likely to want.
 *
 * There are two ways to answer that question and this uses both, because
 * neither is enough alone.
 *
 * ── WHAT THE BOX KNOWS BY ITSELF ─────────────────────────────────────────
 * The provider's film listing carries a title, a category, a poster and a
 * rating, and no genre or cast at all — those live one call away in
 * get_vod_info, over an account that allows one connection. But people.js
 * has been quietly building a credits index out of every film anybody opens
 * and an idle-time crawl, so the box does know who is IN a great many of
 * these films.
 *
 * That is the strongest local signal there is, and it is the one a viewer
 * recognises: the reason you liked a film is very often a person in it. A
 * shared director counts for more than a shared actor, because a director is
 * a choice and a cast member can be a coincidence.
 *
 * ── WHAT OTHER PEOPLE KNOW ───────────────────────────────────────────────
 * "People who enjoyed that also enjoyed" is a fact about audiences, not
 * about a film, and no amount of local metadata can produce it. So it is
 * asked for — by title, of a service that answers that exact question — and
 * whatever comes back is matched against the library, because a
 * recommendation for a film this house cannot play is not a recommendation.
 *
 * That part is allowed to fail. It is somebody else's server, it needs no key
 * and therefore promises nothing, and a box that cannot reach it should still
 * have a good For You row. So the local signals stand on their own and the
 * co-taste is a layer on top, with its own line in the answer saying whether
 * it worked.
 *
 * ── AND WHEN THERE IS NOTHING TO GO ON ───────────────────────────────────
 * A new profile has no history and no ratings, and a recommender with no
 * signal should say so rather than dress up the alphabet as a suggestion. It
 * asks instead: pick a few films you love. Those picks are seeds, they are
 * worth as much as a thumbs-up, and they are the only part of this the
 * viewer has to do by hand.
 */

const SIMILAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How much each kind of signal is worth, relative to the others. */
const WEIGHT = {
  /* A director is a choice. Sharing one with a film you liked is the single
     most reliable thing this box can notice about two films. */
  director: 5,
  /* A cast member can be a coincidence — a character actor is in ninety
     films — so one counts, three do not count three times as much. */
  actor: 2,
  actorCap: 3,
  /* Somebody else's audience saying so. Worth a great deal when it can be
     had, which is why it is asked for at all. */
  coTaste: 6,
  /* The shelf a film sits on, weighted by how much of this profile's
     watching happened there. */
  category: 3,
  /* A genre word shared with something that was liked. Shows carry one and
     films do not, so this is the show half's answer to the credits index —
     weaker than a director, because 'Drama' is half the catalogue. */
  genre: 2,
  genreCap: 3,
  /* The provider's own rating, as a tiebreak between things that are
     otherwise equally likely. Never enough to recommend something on its
     own — that is a chart, not a recommendation. */
  rating: 1,
};

/** How strong a positive signal each kind of watching is. */
const LIKED = {
  thumbUp: 3,
  seed: 3,
  completed: 2,
  most: 1,
};

/**
 * How much has to be said before the box stops asking and starts guessing.
 *
 * One. Not a comfortable-sounding three: a single thumbs-up on a film whose
 * director made three others in this library is a perfectly good basis for a
 * row, and refusing to use it is refusing to answer a question that has an
 * answer. The honest bar is NOTHING — no history, no thumbs, no picks — and
 * there is a second gate below for the case where there is a signal and it
 * happens to lead nowhere.
 */
const ENOUGH_SEEDS = 1;

/* ------------------------------------------------------------ the titles ── */

/**
 * One spelling per film.
 *
 * A provider writes 'The Matrix (1999)', 'Matrix, The' and 'THE MATRIX 4K';
 * a recommendation service says 'The Matrix'. They have to meet somewhere,
 * and the year is dropped on purpose — a remake is a different film, but a
 * title that only differs by how the year was punctuated is not.
 */
function foldTitle(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\((19|20)\d{2}\)|\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(4k|uhd|hd|fhd|sd|hdr|remux|extended|unrated|directors? cut)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    /* 'Matrix, The' is a filing convention, not a title. Providers use it,
       catalogues use it, and a recommendation service never does — so the
       article comes off whichever end it was put on. */
    .replace(/ (the|a|an)$/, '')
    .replace(/^(the|a|an) /, '')
    .trim();
}

/**
 * The genre words on a listing, as a set of comparable things.
 *
 * Providers write this line every way there is — 'Crime, Drama', 'Crime &
 * Drama', 'Action/Adventure' — so it is split on all of them and lowered.
 * 'Sci-Fi' keeps its hyphen; a slash is a separator and a hyphen is a word.
 */
function genreWords(line) {
  return String(line || '')
    .toLowerCase()
    .split(/[,/|&;]+|\band\b/)
    .map((word) => word.replace(/\s+/g, ' ').trim())
    .filter((word) => word.length > 2 && word.length < 30);
}

/** The year in a title, when it carries one. */
function yearOf(name) {
  const found = /\b(19|20)\d{2}\b/.exec(String(name || ''));
  return found ? Number(found[0]) : 0;
}

/* ------------------------------------------------------------- the taste ── */

/**
 * A history row's title, with the episode marker taken back off.
 *
 * Series rows are written per episode and named for one: 'The Wire — S1E4'.
 * The thing to ask an audience about is the show.
 */
function showTitle(name) {
  return String(name || '').replace(/\s+[—-]\s+S\d+E\d+\s*$/i, '').trim();
}

/**
 * What this profile has said it likes, strongest first.
 *
 * Three kinds of saying so, and they are not equal: a thumb is a sentence,
 * something watched to the end is a strong hint, and something half watched is
 * a weak one. A thumb DOWN is not a weak like — it is the one signal here that
 * subtracts, and anything sharing its credits is pushed down rather than up.
 *
 * ── AND A SHOW IS NOT A FILM ─────────────────────────────────────────────
 * History is written per EPISODE, and a viewer never rates one: the thumb on
 * a show card is filed under `series:<show>` while the episode rows are filed
 * under `series:<show>:s1e4`. So the rows are gathered up under the show
 * before any of this is asked, and the thumb is looked for where it actually
 * lives. Finishing one episode of a thirteen-part show is also a much weaker
 * statement than finishing a film — but finishing three is a stronger one, so
 * episodes count and a show somebody has stayed with is treated as a like.
 */
function tasteOf(profile, seeds, kind = 'movie', catalogue = []) {
  const ratings = profile.ratings || {};
  const history = profile.history || [];
  const shows = kind === 'series';
  /* What the library calls each id. A rating is stored as `series:10` and
     carries no title — and a title is the one thing an audience can be asked
     about, so it is looked up rather than left blank. */
  const named = new Map((catalogue || []).map((row) => [String(row.id), row.name || '']));

  const liked = new Map();
  const disliked = new Set();
  const seen = new Set();

  const add = (id, name, weight) => {
    if (!id) return;
    const held = liked.get(String(id));
    if (held) {
      held.weight = Math.max(held.weight, weight);
      if (!held.name && name) held.name = name;
    } else liked.set(String(id), { id: String(id), name: name || '', weight });
  };

  /* Gathered under the thing being recommended: one film is one row, one show
     is however many episodes were opened. */
  const held = new Map();
  for (const row of history) {
    if ((row.kind || '') !== kind) continue;
    const id = String(shows ? (row.seriesId ?? row.id) : row.id);
    if (!id || id === 'undefined') continue;
    seen.add(id);
    const at = held.get(id) || { id, name: '', finished: 0, most: 0 };
    if (!at.name) at.name = shows ? showTitle(row.name) : row.name || '';
    if (row.completed) at.finished += 1;
    else {
      const ratio = row.duration ? (row.position || 0) / row.duration : 0;
      if (ratio > 0.4) at.most += 1;
    }
    held.set(id, at);
  }

  /*
   * And every title with a thumb on it, whether or not it was ever played.
   *
   * This used to be an annotation on the history: gather what was watched,
   * then ask what the thumb on each of those said. So a thumb on something
   * this box has never played — a show somebody watched years ago somewhere
   * else and wants to hold up as an example of what they like — matched no
   * row and was never read. The press lit up and nothing happened.
   *
   * A rating is a statement in its own right. It is also NOT a watch: these
   * ids are deliberately not added to `seen`, because saying you liked
   * something is not saying you have just watched it here and it must not
   * turn into "carry on where you left off".
   *
   * `[^:]+` matters. History is keyed per episode — `series:10:s1e4` — while
   * the show's own thumb is `series:10`. Matching loosely would invent a show
   * whose id is "10:s1e4": in no catalogue, with no name, asked about by that
   * name.
   */
  const wanted = new RegExp(`^${kind}:([^:]+)$`);
  for (const key of Object.keys(ratings)) {
    if (!ratings[key]) continue;
    const found = wanted.exec(key);
    if (!found) continue;
    const id = found[1];
    if (held.has(id)) continue;
    held.set(id, { id, name: named.get(id) || '', finished: 0, most: 0 });
  }

  for (const row of held.values()) {
    // Where the viewer's thumb actually is: the card's key, not an episode's.
    const thumb = ratings[`${kind}:${row.id}`] || 0;
    if (thumb < 0) {
      disliked.add(row.id);
      continue;
    }
    if (thumb > 0) {
      add(row.id, row.name, LIKED.thumbUp);
      continue;
    }
    /* Staying with a show across several episodes says as much as a thumb.
       For a film there is only ever one, so this reads as it always did. */
    if (row.finished >= 3) add(row.id, row.name, LIKED.thumbUp);
    else if (row.finished) add(row.id, row.name, LIKED.completed);
    else if (row.most) add(row.id, row.name, LIKED.most);
  }

  /* The titles somebody picked by hand when asked. Worth a thumbs-up, because
     that is exactly what the question asked for — and NOT added to `seen`,
     since picking a favourite is not watching it here. */
  for (const seed of seeds || []) {
    add(seed.id, seed.name, LIKED.seed);
  }

  return {
    liked: [...liked.values()].sort((a, b) => b.weight - a.weight),
    disliked,
    seen,
  };
}

/* ------------------------------------------------------- what other people
 *                                                          also enjoyed ── */

/**
 * Titles an audience reached for after this one.
 *
 * Asked of somebody else's server, by title, and cached hard: what an
 * audience enjoyed alongside a film is a fact about a decade, not about this
 * afternoon, and a week-old answer is exactly as good as a fresh one.
 *
 * Every address here needs no key, which is the whole reason they are on the
 * list and also the reason none of them promises anything. The chain and the
 * reporting are the same shape the scoreboards use, for the same reason: a
 * row that is thin should be able to say whether that is because nobody was
 * asked or because nobody answered.
 */
/*
 * Where "people who liked that also liked" can be got from.
 *
 * Each source is a couple of steps at most and hands back plain titles. They
 * are asked in order and the first that answers wins, which is the same shape
 * the scoreboards use and for the same reason: these are other people's
 * servers and none of them owes this box anything.
 *
 * THE MOVIE DATABASE is first and is the only one of these that is properly
 * built for the question. Its `recommendations` list is made out of what its
 * users actually watched next — it is the audience answer, not a similarity
 * score off a genre tag — and `similar` stands behind it for a title too
 * obscure to have one. It wants a key, which is free and takes two minutes,
 * and the key lives in config.json beside the provider password: 0600, never
 * sent to a browser, never in a URL this box hands out.
 *
 * TASTE.IO is next. Its own website reads this address; there is no
 * documentation and no promise, which is exactly why it is behind the one
 * that has both.
 *
 * TASTEDIVE last, keyless and rate-limited, as the answer of last resort.
 *
 * word.studio's recommender was suggested too and is not here: it is a web
 * page wrapping a language model, with no address a box can call and nothing
 * to call it with. A page a person uses is not an interface a program has.
 */
/**
 * How a TMDB credential is presented, which depends on which one it is.
 *
 * That service issues two, and they are not interchangeable. The v4 READ
 * TOKEN is a JWT — three dot-separated parts, a couple of hundred characters
 * — and belongs in an Authorization header. The v3 API KEY is thirty-two hex
 * characters and goes in the query string.
 *
 * Told apart by shape rather than by asking, because somebody pasting a
 * credential should not also have to know which of the two it was.
 *
 * The header is the better half of the pair and is preferred wherever it
 * fits: a secret in a URL is a secret in every log, proxy and error message
 * that URL ever passes through, and this box's own redaction only ever
 * catches the ones it knows to look for.
 */
function tmdbAuth(key) {
  const said = String(key || '').trim();
  if (!said) return null;
  if (/^ey[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(said)) {
    return { headers: { authorization: `Bearer ${said}` }, query: '' };
  }
  return { headers: {}, query: `api_key=${encodeURIComponent(said)}` };
}

/** The titles out of a TasteDive answer, whichever spelling it uses. */
function similarTitles(body) {
  const block = body?.Similar || body?.similar || {};
  const rows = block.Results || block.results || [];
  return rows
    .map((row) => String(row?.Name || row?.name || '').trim())
    .filter(Boolean);
}

const SOURCES = [
  {
    name: 'themoviedb',
    needsKey: true,
    /* Two steps: find the film, then ask what its audience went on to watch.
       Both answers are cached under the film's title, so a seed costs this
       pair once a week rather than once a page. */
    async titles(title, { fetchJson, key, kind }) {
      const auth = tmdbAuth(key);
      if (!auth) return [];
      // That service keeps films and shows in separate halves, under
      // different words, and answers about neither if asked the wrong way.
      const half = kind === 'series' ? 'tv' : 'movie';
      const at = (path, extra) => `https://api.themoviedb.org/3/${path}`
        + (auth.query || extra ? `?${[auth.query, extra].filter(Boolean).join('&')}` : '');

      const found = await fetchJson(
        at(`search/${half}`, `include_adult=false&query=${encodeURIComponent(title)}`),
        auth.headers);
      const first = (found?.results || [])[0];
      if (!first || !first.id) return [];
      const out = [];
      for (const list of ['recommendations', 'similar']) {
        // eslint-disable-next-line no-await-in-loop
        const near = await fetchJson(at(`${half}/${first.id}/${list}`), auth.headers);
        for (const row of near?.results || []) {
          /* A film is `title` and a show is `name`. Same field, different
             word, and reading only one of them is how the whole show half
             comes back empty. */
          const named = String(row?.title || row?.name
            || row?.original_title || row?.original_name || '').trim();
          if (named) out.push(named);
        }
        // The audience answer on its own is enough when there is one.
        if (out.length >= 10) break;
      }
      return out;
    },
  },
  {
    name: 'taste.io',
    async titles(title, { fetchJson, kind }) {
      const type = kind === 'series' ? 'tv' : 'movie';
      const found = await fetchJson(`https://www.taste.io/api/items?type=${type}&limit=1`
        + `&q=${encodeURIComponent(title)}`);
      const first = (found?.items || found?.data || [])[0];
      const slug = first?.slug || first?.id;
      if (!slug) return [];
      const near = await fetchJson(
        `https://www.taste.io/api/items/${encodeURIComponent(slug)}/related?type=${type}`);
      return (near?.items || near?.data || [])
        .map((row) => String(row?.name || row?.title || '').trim())
        .filter(Boolean);
    },
  },
  {
    name: 'tastedive',
    async titles(title, { fetchJson, kind }) {
      const type = kind === 'series' ? 'show' : 'movie';
      const body = await fetchJson(`https://tastedive.com/api/similar?type=${type}&limit=20`
        + `&q=${encodeURIComponent(title)}`);
      return similarTitles(body);
    },
  },
];

/**
 * Ask about one title, remembering the answer and the failure alike.
 *
 * A failure is cached too, for a shorter time. Without that, a service that
 * is simply not reachable from this box is asked again for every seed on
 * every visit, for ever.
 */
async function alsoEnjoyed(title, cache, fetchJson, log, tmdbKey, kind) {
  // Keyed by kind as well: a film and a show can share a title exactly.
  const key = `${kind || 'movie'}:${foldTitle(title)}`;
  if (!foldTitle(title)) return { titles: [], source: '', error: '' };
  const held = cache.get(key);
  if (held && Date.now() - held.at < (held.error ? 60 * 60 * 1000 : SIMILAR_TTL_MS)) {
    return { titles: held.titles || [], source: held.source || '', error: held.error || '' };
  }

  const tried = [];
  for (const source of SOURCES) {
    /* A source that wants a key and has not got one is not a failure — it is
       a door nobody has been given a key to, and saying "HTTP 401" about it
       would send somebody looking for a fault instead of for a key. */
    if (source.needsKey && !tmdbKey) {
      tried.push(`${source.name}: no key`);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const titles = await source.titles(title, { fetchJson, key: tmdbKey, kind });
      if (titles.length) {
        cache.set(key, { at: Date.now(), titles, source: source.name });
        return { titles, source: source.name, error: '' };
      }
      tried.push(`${source.name}: no answer`);
    } catch (err) {
      tried.push(`${source.name}: ${err.message}`);
    }
  }
  const error = [...new Set(tried)].join(' · ');
  cache.set(key, { at: Date.now(), titles: [], error });
  if (log) log(`recommend: nobody answered about "${title}" — ${error}`);
  return { titles: [], source: '', error };
}

/* --------------------------------------------------------- the reckoning ── */

/**
 * Films worth putting in front of somebody, and why.
 *
 * `people` is people.js — asked for the credits of the films that were
 * liked, and for which other films share them. `fetchJson` is how the box
 * talks to the internet; passing it in keeps this file testable and keeps it
 * from knowing anything about HTTP.
 */
async function forYou({ profile, movies, catalogue: given, kind = 'movie',
  categoryAffinity, people, seeds, notInterested, cache,
  fetchJson, log, tmdbKey }) {
  const catalogue = given || movies || [];
  /* The catalogue goes in so a rating can be turned into a title: a thumb is
     stored as `series:10` and what an audience is asked about is a name. */
  const taste = tasteOf(profile, seeds, kind, catalogue);
  /* Titles somebody binned off this row. Not deleted, not hidden anywhere
     else — just answered. "Not that one" is a perfectly clear thing to say
     about a suggestion and it should not cost you the title. */
  const refused = new Set([...(notInterested || [])].map(String));

  /* Not enough said yet to guess with. Ask, rather than dressing the
     alphabet up as a suggestion. */
  if (taste.liked.length < ENOUGH_SEEDS) {
    return {
      items: [],
      needs: 'seeds',
      liked: taste.liked.length,
      picks: worthAsking(catalogue, taste),
      similar: { asked: 0, answered: 0 },
    };
  }

  /* The people in the films that were liked, and the ones in the films that
     were not. A name in both is no signal at all.
     Films only: people.js is built out of get_vod_info, which the provider
     answers for films and not for shows, so asking it about a series id gets
     nothing back and — worse — could get somebody else's film back. */
  const loved = new Map();
  const loathed = new Set();
  const creditsFor = (id) => (kind === 'movie' && people && people.creditsFor
    ? people.creditsFor(id) : null);
  for (const film of taste.liked.slice(0, 12)) {
    const credits = creditsFor(film.id);
    if (!credits) continue;
    for (const name of credits.directors || []) {
      loved.set(`d:${name}`, Math.max(loved.get(`d:${name}`) || 0, film.weight));
    }
    for (const name of credits.cast || []) {
      loved.set(`c:${name}`, Math.max(loved.get(`c:${name}`) || 0, film.weight));
    }
  }
  for (const id of taste.disliked) {
    const credits = creditsFor(id);
    if (!credits) continue;
    for (const name of [...(credits.directors || []), ...(credits.cast || [])]) loathed.add(name);
  }
  /* And a name in both columns is no signal, which this said and did not do:
     it subtracted for the loathed side regardless. An actor who is in one
     film somebody loved and one they hated tells you nothing about a third,
     and counting them against it is worse than ignoring them. */
  for (const name of [...loathed]) {
    if (loved.has(`d:${name}`) || loved.has(`c:${name}`)) {
      loved.delete(`d:${name}`);
      loved.delete(`c:${name}`);
      loathed.delete(name);
    }
  }

  /* And the show half's local signal, which is the one thing the series
     listing carries that the film listing does not: a genre line. Read off
     the shows that were liked, and off the ones that were not — a word in
     both columns says nothing, exactly as a name in both does. */
  const genreLoved = new Map();
  const genreLoathed = new Set();
  if (kind === 'series') {
    const byId = new Map(catalogue.map((row) => [String(row.id), row]));
    for (const show of taste.liked.slice(0, 12)) {
      for (const word of genreWords(byId.get(String(show.id))?.genre)) {
        genreLoved.set(word, Math.max(genreLoved.get(word) || 0, show.weight));
      }
    }
    for (const id of taste.disliked) {
      for (const word of genreWords(byId.get(String(id))?.genre)) genreLoathed.add(word);
    }
    /* A word in BOTH columns says nothing, and has to stop counting in both
       directions — not merely stop counting as a like. Somebody who likes The
       Wire and dislikes Poirot has not told you anything about crime; they
       have told you something about drama and mystery. Dropping 'crime' from
       the loved side while still subtracting for it left the two cancelling
       out, and a crime drama — the one thing the pair actually points at —
       scored zero and fell off the row. */
    for (const word of [...genreLoathed]) {
      if (genreLoved.has(word)) { genreLoved.delete(word); genreLoathed.delete(word); }
    }
  }

  /* And what other people reached for. Only the strongest few seeds are
     asked about — this is somebody else's server and a library refresh is
     not a reason to hammer it. */
  const wanted = new Map();
  const report = { asked: 0, answered: 0, source: '', error: '' };
  if (fetchJson) {
    /* Only the ones this box can name. A rating whose title has left the
       library is still a perfectly good exclusion, but it is not a question
       anybody can be asked — and letting it take one of the five slots would
       cost a seed that could have been asked properly. */
    for (const film of taste.liked.filter((f) => f.name).slice(0, 5)) {
      report.asked += 1;
      // eslint-disable-next-line no-await-in-loop
      const answer = await alsoEnjoyed(film.name, cache, fetchJson, log, tmdbKey, kind);
      if (answer.source) {
        report.answered += 1;
        report.source = report.source || answer.source;
      } else if (answer.error) {
        report.error = report.error || answer.error;
      }
      for (const title of answer.titles) {
        const key = foldTitle(title);
        if (!key) continue;
        const held = wanted.get(key) || { count: 0, because: film.name };
        held.count += 1;
        wanted.set(key, held);
      }
    }
  }

  const affinity = new Map();
  let topAffinity = 0;
  for (const row of categoryAffinity || []) {
    if (row.kind !== kind) continue;
    affinity.set(String(row.categoryId), row.score);
    topAffinity = Math.max(topAffinity, row.score);
  }

  /* Everything this profile has already told the box about. Watched, thumbed
     either way, or picked out by hand — a film somebody named as a favourite
     being recommended back to them is the same failure as recommending what
     they watched last night, wearing a different hat. */
  const known = new Set([...taste.seen, ...taste.disliked, ...taste.liked.map((f) => f.id)]);

  const scored = [];
  for (const film of catalogue) {
    const id = String(film.id);
    // Never recommend what has already been watched — that is the whole
    // complaint this replaces — nor what was thumbed down or picked.
    if (known.has(id)) continue;
    // Nor what was binned off this row. Still in the library, still on every
    // other shelf, still searchable: just not offered here again.
    if (refused.has(id)) continue;

    let score = 0;
    const why = [];

    const credits = creditsFor(id);
    if (credits) {
      for (const name of credits.directors || []) {
        if (loathed.has(name)) score -= WEIGHT.director;
        else if (loved.has(`d:${name}`)) {
          score += WEIGHT.director * (loved.get(`d:${name}`) / LIKED.thumbUp);
          if (why.length < 2) why.push(`Directed by ${name}`);
        }
      }
      let hits = 0;
      for (const name of credits.cast || []) {
        if (loathed.has(name)) score -= WEIGHT.actor;
        else if (loved.has(`c:${name}`) && hits < WEIGHT.actorCap) {
          hits += 1;
          score += WEIGHT.actor * (loved.get(`c:${name}`) / LIKED.thumbUp);
          if (why.length < 2) why.push(`With ${name}`);
        }
      }
    }

    /* Gated on the kind, not on there being something loved: a profile whose
       only statement so far is a thumb DOWN has an empty loved column and a
       full loathed one, and that is precisely when the penalty matters. */
    if (kind === 'series') {
      let hits = 0;
      const shared = [];
      for (const word of genreWords(film.genre)) {
        if (genreLoathed.has(word)) score -= WEIGHT.genre;
        else if (genreLoved.has(word) && hits < WEIGHT.genreCap) {
          hits += 1;
          score += WEIGHT.genre * (genreLoved.get(word) / LIKED.thumbUp);
          shared.push(word);
        }
      }
      /* Named, because 'Because you watch crime dramas' is a reason somebody
         can agree or disagree with, and a bare score is not. */
      if (shared.length && why.length < 2) why.push(`More ${shared.slice(0, 2).join(' and ')}`);
    }

    const co = wanted.get(foldTitle(film.name));
    if (co) {
      score += WEIGHT.coTaste * Math.min(2, co.count);
      why.unshift(`People who liked ${co.because} also liked this`);
    }

    if (topAffinity > 0 && affinity.has(String(film.categoryId))) {
      score += WEIGHT.category * (affinity.get(String(film.categoryId)) / topAffinity);
    }

    if (score <= 0) continue;

    const rated = Number(film.rating) || 0;
    if (rated) score += WEIGHT.rating * (rated / 10);

    scored.push({ film, score, why: why.slice(0, 2) });
  }

  scored.sort((a, b) => b.score - a.score
    || (Number(b.film.rating) || 0) - (Number(a.film.rating) || 0)
    || (b.film.added || 0) - (a.film.added || 0));

  return {
    /* One recommendation per FILM, not per copy. The catalogue holds the same
       film three and four times over — a 4K one, a Dutch one — and every copy
       scores alike, so a row of twenty-four could be eight films wearing three
       faces each. The screen groups them into one card too; this is so the
       twenty-four are twenty-four different suggestions before it gets
       there. */
    items: oncePerTitle(scored).slice(0, 24).map((row) => ({ ...row.film, why: row.why })),
    needs: scored.length ? '' : 'seeds',
    liked: taste.liked.length,
    picks: scored.length ? [] : worthAsking(catalogue, taste),
    similar: report,
  };
}

/**
 * Films like this one, for the page about it.
 *
 * The card used to end with "More in Action", which is a shelf rather than a
 * recommendation: it answers "what else did the provider file here", and the
 * provider files by whatever its categories happen to be. Somebody who has
 * just read about a film is asking a better question than that.
 *
 * Same three signals as the row, in the same order and for the same reasons —
 * what an audience reached for next, then the people who made it, then the
 * shelf. The shelf stays as the last of them rather than being thrown away:
 * it is a weak answer and it is never nothing, so a film nobody has indexed
 * and nobody has heard of still ends up with a row under it.
 *
 * Nothing is excluded for having been watched. This is not "what to watch
 * next", it is "what is this like" — and a film you have seen is a perfectly
 * good answer to that, often the most useful one on the row.
 */
async function similarTo({ film, movies, people, cache, fetchJson, tmdbKey, log, want = 24 }) {
  const self = String(film?.id ?? '');
  const report = { asked: 0, answered: 0, source: '', error: '' };
  if (!film) return { items: [], similar: report };

  const wanted = new Map();
  if (fetchJson && film.name) {
    report.asked = 1;
    const answer = await alsoEnjoyed(film.name, cache, fetchJson, log, tmdbKey);
    if (answer.source) {
      report.answered = 1;
      report.source = answer.source;
    } else {
      report.error = answer.error;
    }
    /* In the order the service gave them: a recommendation list is ranked,
       and throwing that away to re-sort by a local score would be discarding
       the one thing the service knows better than this box does. */
    answer.titles.forEach((title, at) => {
      const key = foldTitle(title);
      if (key && !wanted.has(key)) wanted.set(key, at);
    });
  }

  const credits = people.creditsFor ? people.creditsFor(self) : null;
  const directors = new Set(credits?.directors || []);
  const cast = new Set(credits?.cast || []);

  const scored = [];
  for (const other of movies || []) {
    const id = String(other.id);
    if (id === self) continue;

    let score = 0;
    const why = [];

    const at = wanted.get(foldTitle(other.name));
    if (at !== undefined) {
      // Ranked: first on the service's list is worth more than twentieth.
      score += WEIGHT.coTaste * 2 + Math.max(0, 20 - at) / 10;
      why.push('People who liked this also liked it');
    }

    const theirs = people.creditsFor ? people.creditsFor(id) : null;
    if (theirs) {
      const sharedDirector = (theirs.directors || []).find((name) => directors.has(name));
      if (sharedDirector) {
        score += WEIGHT.director;
        why.push(`Also by ${sharedDirector}`);
      }
      const shared = (theirs.cast || []).filter((name) => cast.has(name)).slice(0, 2);
      if (shared.length) {
        score += WEIGHT.actor * shared.length;
        why.push(`With ${shared.join(' and ')}`);
      }
    }

    if (String(other.categoryId) === String(film.categoryId)) {
      score += 0.5;
      if (!why.length) why.push('On the same shelf');
    }

    if (score <= 0) continue;
    score += WEIGHT.rating * ((Number(other.rating) || 0) / 10);
    scored.push({ film: other, score, why: why.slice(0, 1) });
  }

  scored.sort((a, b) => b.score - a.score
    || (Number(b.film.rating) || 0) - (Number(a.film.rating) || 0));

  return {
    // Once per film here too: 'Others enjoyed' offering the same title three
    // times is a shorter row pretending to be a longer one.
    items: oncePerTitle(scored).slice(0, want).map((row) => ({ ...row.film, why: row.why })),
    similar: report,
  };
}

/**
 * One row per title, keeping the best-scoring copy of each.
 *
 * The list is already in the order that matters, so the first of any title to
 * come past is the one to keep.
 */
function oncePerTitle(scored) {
  const seen = new Set();
  const out = [];
  for (const row of scored) {
    const key = foldTitle(row.film.name);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Titles worth putting in a picker — films or shows, whichever was asked for.
 *
 * Asked when there is nothing to go on, so it cannot be personal — it has to
 * be a spread of things somebody is likely to have an opinion about. The
 * provider's own rating is the only quality signal on a listing, and a
 * poster is required: a picker is a wall of covers and a title with no cover
 * is a grey box nobody picks.
 */
function worthAsking(catalogue, taste, want = 40) {
  const pool = (catalogue || [])
    .filter((film) => film.logo && !taste.seen.has(String(film.id)))
    .filter((film) => (Number(film.rating) || 0) >= 6)
    .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0));

  /* Spread across categories rather than forty films off one shelf, which is
     what a straight sort by rating gives — and a picker showing forty horror
     films teaches the box that this house likes horror. */
  const perCategory = new Map();
  const out = [];
  for (const film of pool) {
    const key = String(film.categoryId);
    const had = perCategory.get(key) || 0;
    if (had >= 3) continue;
    perCategory.set(key, had + 1);
    out.push(film);
    if (out.length >= want) break;
  }
  return out;
}

module.exports = {
  forYou, similarTo, foldTitle, genreWords, showTitle, yearOf, worthAsking,
  tasteOf, similarTitles, tmdbAuth, SOURCES,
};
