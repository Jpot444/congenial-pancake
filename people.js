/*
 * What the box knows about people.
 *
 * Two jobs, both about names rather than titles.
 *
 * ── The credits index ────────────────────────────────────────────────────
 * "Everything in my library with this actor in it" is a question Xtream
 * cannot be asked. A category listing carries a title, a poster and an id;
 * the cast and the director live in get_vod_info, which answers about ONE
 * film per call, over an account that allows ONE connection. So the answer
 * has to be built up rather than looked up, and it is built from two
 * directions:
 *
 *   - every film anybody opens is recorded on the way past, for free
 *   - a crawler fills in the rest, one film at a time, ONLY while nothing is
 *     playing and nothing is downloading
 *
 * That makes the index honestly partial for a while, which the screen says
 * out loud rather than presenting a short answer as a complete one. A
 * ten-thousand film library takes a few idle evenings; there is no faster
 * road that does not take the connection away from whoever is watching.
 *
 * ── The portrait ─────────────────────────────────────────────────────────
 * IMDb's own suggestion endpoint — the one its search box types into — is
 * JSON, needs no key, and answers with the headshot of anybody who has a
 * page. Nobody without a page gets a picture, which is the rule asked for.
 * A name it does not know, or knows without a photograph, keeps the initials
 * the page already draws.
 *
 * Everything here is a cache of somebody else's answer, so the whole file can
 * be deleted at any time and the box will rebuild it.
 */

const fs = require('fs');
const path = require('path');

/** Bumped when the stored shape changes, so an old file is ignored not read. */
const SHAPE = 1;

/* A miss is remembered too — an actor IMDb has never heard of must not be
   asked about on every repaint — but not for ever: pages get created. */
const PORTRAIT_MISS_MS = 30 * 24 * 60 * 60 * 1000;

/* How long a film's credits are trusted. Cast lists do not change; this only
   exists so a title fetched before the provider filled its metadata in gets
   another look eventually. */
const CREDIT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const store = {
  file: '',
  /** id → { c: [cast], d: [directors], at } */
  films: new Map(),
  /** normalised name → { id, image, at } | { at, miss: true } */
  faces: new Map(),
  /** normalised name → Set(film id), rebuilt from films on load and on note. */
  byPerson: new Map(),
  dirty: false,
  log: () => {},
  /** What the crawler is doing, for the report. */
  crawl: { at: 0, id: '', ok: 0, fail: 0, running: false },
};

/* ------------------------------------------------------------- the names ── */

/**
 * One spelling per person.
 *
 * Providers write the same actor a dozen ways — trailing spaces, double
 * spaces, "Robert Downey Jr." against "Robert Downey Jr", accents present or
 * missing. The index is keyed on a folded form so all of those meet, while
 * the ORIGINAL spelling is what gets shown.
 */
function fold(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,'’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The people in one get_vod_info payload, as the provider wrote them. */
function peopleIn(info) {
  const split = (raw) => String(raw || '')
    .split(/[,/|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 80);
  return {
    cast: [...new Set(split(info?.cast ?? info?.actors))],
    directors: [...new Set(split(info?.director))],
  };
}

/* ------------------------------------------------------------- the store ── */

function index(id, entry) {
  for (const name of [...entry.c, ...entry.d]) {
    const key = fold(name);
    if (!key) continue;
    if (!store.byPerson.has(key)) store.byPerson.set(key, new Set());
    store.byPerson.get(key).add(String(id));
  }
}

function load(file, log = () => {}) {
  store.file = file;
  store.log = log;
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(body.shape) !== SHAPE) return;
    for (const [id, entry] of Object.entries(body.films || {})) {
      if (!entry || !Array.isArray(entry.c)) continue;
      store.films.set(String(id), entry);
      index(id, entry);
    }
    for (const [key, face] of Object.entries(body.faces || {})) store.faces.set(key, face);
    log(`people: ${store.films.size} films indexed, ${store.byPerson.size} names, `
      + `${store.faces.size} portraits`);
  } catch {
    /* no index yet, which is the ordinary state of a new box */
  }
}

let writeTimer = null;
function save() {
  store.dirty = true;
  clearTimeout(writeTimer);
  /* Debounced hard: the crawler touches this every few seconds and the file
     runs to a couple of megabytes on a full library. */
  writeTimer = setTimeout(() => {
    if (!store.file) return;
    const body = {
      shape: SHAPE,
      at: Date.now(),
      films: Object.fromEntries(store.films),
      faces: Object.fromEntries(store.faces),
    };
    fs.writeFile(store.file, JSON.stringify(body), { mode: 0o600 }, () => {
      store.dirty = false;
    });
  }, 15000);
  writeTimer.unref?.();
}

/**
 * Record one film's credits.
 *
 * Called for every get_vod_info the box passes through, whoever asked for it,
 * so browsing the library fills the index for nothing.
 */
function note(id, info) {
  if (!id || !info) return false;
  const { cast, directors } = peopleIn(info);
  const entry = { c: cast, d: directors, at: Date.now() };
  const had = store.films.get(String(id));
  store.films.set(String(id), entry);
  index(id, entry);
  // Only worth a write when something actually changed.
  if (!had || had.c.join('|') !== cast.join('|') || had.d.join('|') !== directors.join('|')) {
    save();
    return true;
  }
  return false;
}

/** The film ids this person is in, as strings. */
function filmsWith(name) {
  const key = fold(name);
  if (!key) return [];
  return [...(store.byPerson.get(key) || [])];
}

/** Is this person the director of that film, rather than in front of it? */
function directed(name, id) {
  const entry = store.films.get(String(id));
  if (!entry) return false;
  const key = fold(name);
  return entry.d.some((who) => fold(who) === key);
}

function known(id) {
  const entry = store.films.get(String(id));
  return Boolean(entry) && Date.now() - (entry.at || 0) < CREDIT_TTL_MS;
}

function status() {
  return {
    films: store.films.size,
    people: store.byPerson.size,
    portraits: store.faces.size,
    crawl: { ...store.crawl },
  };
}

/* ------------------------------------------------------------ the crawler ── */

/**
 * One film per tick, and only when the provider is idle.
 *
 * `busy` is the box's own single-connection gate — the same one that stops a
 * download while somebody is watching. The crawler is a metadata call rather
 * than a stream, but it is a call on the one connection, and a viewer pressing
 * play must never be behind it.
 */
async function crawl({ items, busy, fetchInfo }) {
  if (store.crawl.running) return null;
  if (typeof busy === 'function' && busy()) return null;
  if (!Array.isArray(items) || !items.length) return null;

  const next = items.find((item) => !known(item.id));
  if (!next) return null;

  store.crawl.running = true;
  try {
    const info = await fetchInfo(next.id);
    note(next.id, info || {});
    store.crawl = { ...store.crawl, at: Date.now(), id: String(next.id), ok: store.crawl.ok + 1 };
    return next.id;
  } catch {
    /* A title the provider will not answer about is recorded as having no
       credits, so the crawl moves past it instead of stopping on it for
       ever. It gets another chance when the entry ages out. */
    note(next.id, {});
    store.crawl = { ...store.crawl, at: Date.now(), id: String(next.id), fail: store.crawl.fail + 1 };
    return next.id;
  } finally {
    store.crawl.running = false;
  }
}

/* ----------------------------------------------------------- the portrait ── */

/* IMDb's suggestion service, which is what its own search box calls. Two
   forms of the same thing; the second is the newer one and answers when the
   first does not. */
const IMDB_SUGGEST = [
  (q) => `https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(q[0] || 'a')}/`
    + `${encodeURIComponent(q)}.json`,
  (q) => `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json?includeVideos=0`,
];

/**
 * IMDb serves one enormous original and resizes on demand through the name
 * itself. Asking for a 280px-wide copy rather than the full-size still is the
 * difference between a 12KB portrait and a 400KB one, twelve times a page.
 */
function sized(url) {
  return String(url || '').replace(/\._V1_.*?\.jpg$/i, '._V1_QL75_UX280_.jpg');
}

/**
 * The headshot of somebody with an IMDb page, or null.
 *
 * Strict about the match on purpose: the suggestion endpoint answers with
 * films and characters as well as people, and an actor whose name IMDb does
 * not carry must come back empty rather than wearing a stranger's face.
 */
async function portrait(name, request, readBody) {
  const key = fold(name);
  if (!key) return null;

  const held = store.faces.get(key);
  if (held && (held.image || Date.now() - (held.at || 0) < PORTRAIT_MISS_MS)) {
    return held.image ? { name, id: held.id, image: held.image } : null;
  }

  for (const build of IMDB_SUGGEST) {
    try {
      const res = await request(build(name), {
        headers: { accept: 'application/json' },
        timeout: 8000,
      });
      if ((res.statusCode || 500) >= 400) {
        res.resume();
        continue;
      }
      const body = JSON.parse((await readBody(res)).toString('utf8'));
      const match = (body.d || []).find((row) => String(row.id || '').startsWith('nm')
        && fold(row.l) === key);
      if (!match) continue;
      const image = match.i && match.i.imageUrl ? sized(match.i.imageUrl) : '';
      store.faces.set(key, { id: match.id, image, at: Date.now() });
      save();
      return image ? { name, id: match.id, image } : null;
    } catch {
      /* try the next form, then give up for now */
    }
  }

  /* Nobody answered. Remembered as a miss so a page full of unknown names
     does not ask again on every repaint — but only for a month. */
  store.faces.set(key, { at: Date.now(), miss: true });
  save();
  return null;
}

module.exports = {
  load,
  note,
  filmsWith,
  directed,
  known,
  status,
  crawl,
  portrait,
  fold,
  peopleIn,
  SHAPE,
};
