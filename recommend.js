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

/** The year in a title, when it carries one. */
function yearOf(name) {
  const found = /\b(19|20)\d{2}\b/.exec(String(name || ''));
  return found ? Number(found[0]) : 0;
}

/* ------------------------------------------------------------- the taste ── */

/**
 * What this profile has said it likes, strongest first.
 *
 * Three kinds of saying so, and they are not equal: a thumb is a sentence, a
 * film watched to the end is a strong hint, and a film half watched is a
 * weak one. A thumb DOWN is not a weak like — it is the one signal here that
 * subtracts, and anything sharing its credits is pushed down rather than up.
 */
function tasteOf(profile, seeds) {
  const ratings = profile.ratings || {};
  const history = profile.history || [];

  const liked = new Map();
  const disliked = new Set();
  const seen = new Set();

  const add = (key, id, name, weight) => {
    if (!id) return;
    const held = liked.get(String(id));
    if (held) held.weight = Math.max(held.weight, weight);
    else liked.set(String(id), { id: String(id), name: name || '', weight });
  };

  for (const row of history) {
    if (row.kind !== 'movie') continue;
    seen.add(String(row.id));
    const thumb = ratings[row.key] || 0;
    if (thumb < 0) {
      disliked.add(String(row.id));
      continue;
    }
    if (thumb > 0) {
      add(row.key, row.id, row.name, LIKED.thumbUp);
      continue;
    }
    if (row.completed) {
      add(row.key, row.id, row.name, LIKED.completed);
      continue;
    }
    const ratio = row.duration ? (row.position || 0) / row.duration : 0;
    if (ratio > 0.4) add(row.key, row.id, row.name, LIKED.most);
  }

  /* The films somebody picked by hand when asked. Worth a thumbs-up, because
     that is exactly what the question asked for — and NOT added to `seen`,
     since picking a favourite is not watching it here. */
  for (const seed of seeds || []) {
    add(`movie:${seed.id}`, seed.id, seed.name, LIKED.seed);
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
const SIMILAR_URLS = [
  (title) => 'https://tastedive.com/api/similar?type=movie&limit=20&q='
    + encodeURIComponent(title),
  (title) => 'https://tastedive.com/api/similar?type=movies&limit=20&q='
    + encodeURIComponent(title),
];

/** The titles out of a similarity answer, whichever spelling it uses. */
function similarTitles(body) {
  const block = body?.Similar || body?.similar || {};
  const rows = block.Results || block.results || [];
  return rows
    .map((row) => String(row?.Name || row?.name || '').trim())
    .filter(Boolean);
}

/**
 * Ask about one title, remembering the answer and the failure alike.
 *
 * A failure is cached too, for a shorter time. Without that, a service that
 * is simply not reachable from this box is asked again for every seed on
 * every visit, for ever.
 */
async function alsoEnjoyed(title, cache, fetchJson, log) {
  const key = foldTitle(title);
  if (!key) return { titles: [], source: '', error: '' };
  const held = cache.get(key);
  if (held && Date.now() - held.at < (held.error ? 60 * 60 * 1000 : SIMILAR_TTL_MS)) {
    return { titles: held.titles || [], source: held.source || '', error: held.error || '' };
  }

  const tried = [];
  for (const build of SIMILAR_URLS) {
    const url = build(title);
    try {
      // eslint-disable-next-line no-await-in-loop
      const body = await fetchJson(url);
      const titles = similarTitles(body);
      if (titles.length) {
        cache.set(key, { at: Date.now(), titles, source: url });
        return { titles, source: url, error: '' };
      }
      tried.push('no answer');
    } catch (err) {
      tried.push(err.message);
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
async function forYou({ profile, movies, categoryAffinity, people, seeds, cache, fetchJson, log }) {
  const taste = tasteOf(profile, seeds);
  const catalogue = movies || [];

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
     were not. A name in both is no signal at all. */
  const loved = new Map();
  const loathed = new Set();
  for (const film of taste.liked.slice(0, 12)) {
    const credits = people.creditsFor ? people.creditsFor(film.id) : null;
    if (!credits) continue;
    for (const name of credits.directors || []) {
      loved.set(`d:${name}`, Math.max(loved.get(`d:${name}`) || 0, film.weight));
    }
    for (const name of credits.cast || []) {
      loved.set(`c:${name}`, Math.max(loved.get(`c:${name}`) || 0, film.weight));
    }
  }
  for (const id of taste.disliked) {
    const credits = people.creditsFor ? people.creditsFor(id) : null;
    if (!credits) continue;
    for (const name of [...(credits.directors || []), ...(credits.cast || [])]) loathed.add(name);
  }

  /* And what other people reached for. Only the strongest few seeds are
     asked about — this is somebody else's server and a library refresh is
     not a reason to hammer it. */
  const wanted = new Map();
  const report = { asked: 0, answered: 0, source: '', error: '' };
  if (fetchJson) {
    for (const film of taste.liked.slice(0, 5)) {
      report.asked += 1;
      // eslint-disable-next-line no-await-in-loop
      const answer = await alsoEnjoyed(film.name, cache, fetchJson, log);
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
    if (row.kind !== 'movie') continue;
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

    let score = 0;
    const why = [];

    const credits = people.creditsFor ? people.creditsFor(id) : null;
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
    items: scored.slice(0, 24).map((row) => ({ ...row.film, why: row.why })),
    needs: scored.length ? '' : 'seeds',
    liked: taste.liked.length,
    picks: scored.length ? [] : worthAsking(catalogue, taste),
    similar: report,
  };
}

/**
 * Films worth putting in a picker.
 *
 * Asked when there is nothing to go on, so it cannot be personal — it has to
 * be a spread of things somebody is likely to have an opinion about. The
 * provider's own rating is the only quality signal on a listing, and a
 * poster is required: a picker is a wall of covers and a title with no cover
 * is a grey box nobody picks.
 */
function worthAsking(movies, taste, want = 40) {
  const pool = (movies || [])
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

module.exports = { forYou, foldTitle, yearOf, worthAsking, tasteOf, similarTitles };
