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
  getProfiles, getProfilePrefs, putProfilePrefs, getTaste,
  getLibrary, getEpgNow, getHealth,
} from './api.js';

export const state = {
  profile: null,
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
 * Pick up whichever profile this box was last used with — the same key the
 * browser portal writes, so the TV opens on the same person the house was
 * already using rather than asking again from the sofa.
 */
export async function loadProfile() {
  const data = await getProfiles();
  const list = data.profiles || [];
  if (!list.length) throw new Error('This box has no profiles yet. Make one in the browser portal first.');
  const wanted = localStorage.getItem(PROFILE_KEY);
  state.profile = list.find((p) => p.id === wanted) || list[0];
  localStorage.setItem(PROFILE_KEY, state.profile.id);
  state.prefs = await getProfilePrefs(state.profile.id).catch(() => null);
  return state.profile;
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

export async function loadLibrary(tab) {
  if (state.library[tab]) return state.library[tab];
  try {
    const data = await getLibrary(tab);
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
