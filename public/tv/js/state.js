/*
 * What the app knows, and the rules about asking the box for more of it.
 *
 * The library is fetched once per section per session and held: each call is a
 * full category + stream listing from a provider that allows one connection,
 * and a TV that re-fetched on every screen change would stutter the thing
 * being watched. Anything that must be fresh — downloads, health, EPG — is
 * asked for by the screen that shows it, and never on a timer while the player
 * is up.
 */

import {
  getProfiles, putCurrentProfile, getProfilePrefs, putProfilePrefs, getTaste,
  getLibrary, getEpgNow, getHealth,
} from './api.js';

export const state = {
  profile: null,
  /** The box's change counter, as last seen. Below any real value to start. */
  rev: -1,
  /** Per-profile favorites, pins, allowance and the owner flag. */
  prefs: null,
  /** continueWatching / recentlyWatched / categoryAffinity / ratings. */
  taste: null,
  health: null,
  library: { live: null, movies: null, series: null },
  /** id → { listings, at } */
  epg: new Map(),
  seriesInfo: new Map(),
  screen: 'live',
  /** Set when a library section failed, so a screen can say so honestly. */
  errors: {},
};

const PROFILE_KEY = 'portal.profile';
const EPG_TTL_MS = 5 * 60 * 1000;
const EPG_MAX = 40;

/* ------------------------------------------------------------- profile ── */

/**
 * Pick up whoever the BOX says is watching.
 *
 * This used to read localStorage, which sounded like the same thing and is
 * not: the service answers on the Tailscale address and on the domain, and a
 * browser treats those as two unrelated origins with two separate stores. So
 * the Shield pointed at one of them knew nothing about the phone on the other,
 * and each remembered its own person. The box holds one answer and every way
 * in reads it.
 *
 * localStorage is still consulted, but only as the fallback for a box that has
 * never been told — the upgrade case, where the device's own memory is the
 * best guess available.
 */
export async function loadProfile() {
  const data = await getProfiles();
  const list = data.profiles || [];
  if (!list.length) throw new Error('This box has no profiles yet. Make one in the browser portal first.');
  const wanted = data.current || localStorage.getItem(PROFILE_KEY);
  state.profile = list.find((p) => p.id === wanted) || list[0];
  state.rev = Number.isFinite(data.rev) ? data.rev : -1;
  localStorage.setItem(PROFILE_KEY, state.profile.id);
  /* If the box had no answer, this is now it — so the phone opened next lands
     on the same person rather than starting the disagreement over. */
  if (!data.current) putCurrentProfile(state.profile.id).catch(() => {});
  state.prefs = await getProfilePrefs(state.profile.id).catch(() => null);
  return state.profile;
}

/**
 * Keep up with the rest of the house.
 *
 * One small call, polled: it answers who the box is showing and how many times
 * anything about a profile has changed. Nothing in this app re-read anything
 * before — prefs were fetched at launch and held — so a favourite added on the
 * phone or a series rated on the laptop stayed invisible on the television
 * until somebody restarted it, and the stale copy would eventually be saved
 * back over the fresh one.
 *
 * Never while the player is up. This app's whole rule about background work is
 * that nothing competes with the thing being watched, and catching up can wait
 * for the credits.
 */
export async function followBox({ playing = false } = {}) {
  if (!state.profile || playing) return null;
  let data;
  try {
    data = await getProfiles();
  } catch {
    return null; // the box will still be there next time
  }
  if (data.current && data.current !== state.profile.id) {
    const next = (data.profiles || []).find((p) => p.id === data.current);
    if (next) {
      localStorage.setItem(PROFILE_KEY, next.id);
      return { switched: next };
    }
  }
  if (Number.isFinite(data.rev) && data.rev !== state.rev) {
    state.rev = data.rev;
    const was = screenPrint();
    state.prefs = await getProfilePrefs(state.profile.id).catch(() => state.prefs);
    await loadTaste();
    /*
     * Only redraw if what is ON THE SCREEN actually changed.
     *
     * "It also refreshes a lot and the screen changes"
     *
     * The counter this poll watches moves on every write to the profile, and
     * the commonest write by a distance is a position report: every player in
     * the house says where it has got to every fifteen or thirty seconds. So
     * the counter is almost never still, and acting on it alone meant redrawing
     * the whole screen every ten seconds all evening — a rebuild the viewer
     * sees, for news that was somebody's playhead moving.
     *
     * What this screen is actually drawn from is a much smaller thing: which
     * channels are hearted, which categories are pinned, what has been binned,
     * what has been rated, which sport the games row is on. Comparing those
     * across the reload answers the question the counter cannot.
     */
    if (screenPrint() === was) return null;
    return { refreshed: true };
  }
  return null;
}

/**
 * A fingerprint of everything a screen in this app draws from.
 *
 * Deliberately not the whole of prefs or taste. Watch positions live in both
 * and change constantly by design; a fingerprint that included them would be
 * the counter again under another name. What is here is the settings that
 * shape a screen, plus the IDENTITY of what is in the taste lists rather than
 * how far through any of it somebody is.
 */
function screenPrint() {
  const p = state.prefs || {};
  const t = state.taste || {};
  const ids = (rows) => (rows || []).map((r) => r && (r.key || r.id)).join(',');
  return JSON.stringify([
    p.favorites || [],
    p.pinnedCategories || [],
    p.deletedItems || [],
    p.deletedCategories || [],
    p.scoreSport || '',
    Boolean(p.owner),
    t.ratings || {},
    ids(t.continueWatching),
    ids(t.recentlyWatched),
  ]);
}

export async function loadTaste() {
  if (!state.profile) return null;
  state.taste = await getTaste(state.profile.id).catch(() => null);
  return state.taste;
}

export async function refreshHealth() {
  state.health = await getHealth().catch(() => null);
  return state.health;
}

/* ------------------------------------------------------------- library ── */

/*
 * What this profile has thrown away.
 *
 * The portal hides titles and whole categories rather than deleting them —
 * the provider still carries them and will keep sending them — and it keeps
 * both lists in the profile's prefs on the box. That is the same prefs record
 * this app already loads, so honouring it is just a matter of reading it: a
 * channel binned on the phone is binned on the TV, with nothing to sync.
 */
export function isDeleted(item) {
  if (!item) return false;
  return ((state.prefs && state.prefs.deletedItems) || []).includes(favKey(item));
}

export function isDeletedCategory(id) {
  return ((state.prefs && state.prefs.deletedCategories) || []).includes(String(id));
}

export async function loadLibrary(tab) {
  if (state.library[tab]) return state.library[tab];
  try {
    const data = await getLibrary(tab);
    /* Filtered once, here, rather than screen by screen: every row, grid,
       guide and search on the TV reads this object, and a bin that only some
       of them respected would be worse than no bin at all. */
    const goneCategory = new Set(
      (data.categories || []).filter((c) => isDeletedCategory(c.id)).map((c) => String(c.id))
    );
    data.categories = (data.categories || []).filter((c) => !goneCategory.has(String(c.id)));
    data.items = (data.items || [])
      .filter((i) => !isDeleted(i) && !goneCategory.has(String(i.categoryId)));
    state.library[tab] = data;
    delete state.errors[tab];
    return data;
  } catch (err) {
    state.errors[tab] = err.message;
    state.library[tab] = { categories: [], items: [], totals: { categories: 0, items: 0 } };
    return state.library[tab];
  }
}

/* ------------------------------------------------------------------ EPG ── */

/**
 * Now/next for a set of channels, cached for five minutes.
 *
 * The box answers for at most six unseen channels per request and returns the
 * rest `known: false`, on purpose — forty provider calls fired at once is a
 * denial of service against your own single connection. So this asks for what
 * a screen needs, keeps what comes back, and lets the next visit fill the gaps.
 */
export async function loadEpg(ids) {
  const now = Date.now();
  const wanted = [...new Set(ids.map(String))].filter(Boolean);
  const missing = wanted.filter((id) => {
    const held = state.epg.get(id);
    return !held || now - held.at > EPG_TTL_MS;
  });
  if (missing.length) {
    try {
      const data = await getEpgNow(missing.slice(0, EPG_MAX));
      for (const channel of data.channels || []) {
        if (!channel) continue;
        // A channel the box has not reached yet is not an answer — leaving it
        // uncached is what lets the next visit ask again.
        if (channel.known === false) continue;
        state.epg.set(String(channel.id), { listings: channel.listings || [], at: now });
      }
    } catch {
      /* A guide that did not arrive is a guide that is not shown. Never fatal. */
    }
  }
  const out = new Map();
  for (const id of wanted) out.set(id, (state.epg.get(id) || {}).listings || []);
  return out;
}

/** The programme on now, from a channel's listings. */
export function nowOn(listings) {
  const now = Date.now() / 1000;
  return (listings || []).find((l) => l.start <= now && l.stop > now) || null;
}

export function nextOn(listings) {
  const now = Date.now() / 1000;
  return (listings || []).filter((l) => l.start > now).sort((a, b) => a.start - b.start)[0] || null;
}

/** How far through the programme on now we are, 0–100. */
export function airProgress(listing) {
  if (!listing || !listing.start || !listing.stop) return 0;
  const now = Date.now() / 1000;
  const span = listing.stop - listing.start;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(100, ((now - listing.start) / span) * 100));
}

/* ----------------------------------------------------------- favorites ── */

export const favKey = (item) => `${item.kind}:${item.id}`;

export function favorites() {
  return (state.prefs && state.prefs.favorites) || [];
}

export function isFav(item) {
  const key = favKey(item);
  return favorites().some((f) => f.key === key);
}

/** Hearted from anywhere, stored on the box, so every device agrees. */
export async function toggleFav(item) {
  if (!state.prefs || !state.profile) return false;
  const key = favKey(item);
  const list = state.prefs.favorites || (state.prefs.favorites = []);
  const at = list.findIndex((f) => f.key === key);
  const added = at < 0;
  if (added) list.unshift({ key, item });
  else list.splice(at, 1);
  state.prefs.favorites = list.slice(0, 500);
  await putProfilePrefs(state.profile.id, { favorites: state.prefs.favorites }).catch(() => {});
  return added;
}

/* ---------------------------------------------------------------- pins ── */

/** Pinned categories arrive as `live:<categoryId>` / `movies:…` / `series:…`. */
export function pinnedIds(tab) {
  const prefix = `${tab}:`;
  return ((state.prefs && state.prefs.pinnedCategories) || [])
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

/** Pinned first, then the rest in the order the provider files them. */
export function pinnedFirst(categories, tab) {
  const pinned = new Set(pinnedIds(tab));
  const head = categories.filter((c) => pinned.has(String(c.id)));
  const tail = categories.filter((c) => !pinned.has(String(c.id)));
  return [...head, ...tail];
}

/* -------------------------------------------------------------- resume ── */

/**
 * One identity per title whatever route it is played by, matching the portal
 * exactly — a film streamed from the provider and the same film opened from
 * Downloads share a key, so the position carries between them.
 */
export function resumeKeyFor(item, episode, season) {
  if (item.resumeKey) return item.resumeKey;
  if (episode) return `series:${item.id}:s${season}e${episode.episode_num}`;
  return `${item.kind}:${item.id}`;
}

export function continueWatching() {
  return (state.taste && state.taste.continueWatching) || [];
}

export function recentlyWatched() {
  return (state.taste && state.taste.recentlyWatched) || [];
}

/** The categories this profile actually watches, strongest first. */
export function affinity(kind) {
  return ((state.taste && state.taste.categoryAffinity) || []).filter((a) => a.kind === kind);
}

export const isOwner = () => Boolean(state.prefs && state.prefs.owner);
