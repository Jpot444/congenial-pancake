/*
 * Everything this app asks of the box.
 *
 * The endpoints are the portal's own — no TV-specific server code exists or is
 * needed. Two rules are inherited from the portal and matter more here than
 * they do in a browser tab:
 *
 *   1. The account allows ONE provider connection. Playback owns it. Guide and
 *      library calls are cheap only because the box caches them; nothing here
 *      may poll the provider in a loop while something is playing.
 *   2. The archive is owner-only and every archive call must carry profileId,
 *      or the box answers 403 by design.
 */

/** A box that is busy is not a box that is broken; give it room. */
const TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, params, options = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ApiError(
      err.name === 'AbortError' ? 'The box did not answer in time.' : 'The box is not reachable.',
      0
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('The box sent something that is not JSON.', res.status);
  }
  if (!res.ok) throw new ApiError((data && data.error) || `The box answered ${res.status}.`, res.status);
  return data;
}

/* ------------------------------------------------------------- profiles ── */

export const getProfiles = () => api('/api/profiles');
export const getProfilePrefs = (id) => api(`/api/profiles/${id}/prefs`);
export const putProfilePrefs = (id, body) =>
  api(`/api/profiles/${id}/prefs`, null, { method: 'PUT', body });

/**
 * Everything the box has worked out about what this profile watches:
 * continueWatching, recentlyWatched, categoryAffinity, ratings, watchedKeys.
 * This is where the Movies and Series rows come from — there is no separate
 * "history" GET, and this is the endpoint the browser portal uses too.
 */
export const getTaste = (id) => api(`/api/profiles/${id}/taste`);
export const getProgress = (id, key) => api(`/api/profiles/${id}/progress`, { key });
export const postHistory = (id, body) =>
  api(`/api/profiles/${id}/history`, null, { method: 'POST', body });

/* -------------------------------------------------------------- library ── */

/** tab: 'live' | 'movies' | 'series' → { categories, items, totals } */
export const getLibrary = (tab, params) => api('/api/library', { tab, ...(params || {}) }, { timeout: 120000 });

export const getSeriesInfo = (seriesId) =>
  api('/api/xtream', { action: 'get_series_info', series_id: seriesId });

/* ------------------------------------------------------------------ EPG ── */

/**
 * Now and next for up to 40 channels. Channels the box has not got to yet come
 * back `known: false` with no listings, which is a different thing from a
 * channel that genuinely has none — the guide draws them differently.
 */
export const getEpgNow = (ids) => api('/api/epg/now', { ids: ids.join(',') });

/* ------------------------------------------------------------- playback ── */

export const getPlay = (kind, id, ext) => api('/api/play', { kind, id, ext });

/* ------------------------------------------------------------ downloads ── */

export const getDownloads = () => api('/api/downloads');
export const queueDownload = (body) => api('/api/downloads', null, { method: 'POST', body });
export const pauseDownload = (id) => api(`/api/downloads/${id}/pause`, null, { method: 'POST' });
export const retryDownload = (id) => api(`/api/downloads/${id}/retry`, null, { method: 'POST' });

/* -------------------------------------------------------------- archive ── */

export const getArchiveStatus = (profileId) => api('/api/archive/status', { profileId });
export const getArchiveRecent = (profileId, limit) =>
  api('/api/archive/recent', { profileId, limit });
export const getArchiveBrowse = (profileId, dir) => api('/api/archive/browse', { profileId, dir });
export const searchArchive = (profileId, q) => api('/api/archive/search', { profileId, q });
export const getArchivePlay = (profileId, path) => api('/api/archive/play', { profileId, path });

/* --------------------------------------------------------------- health ── */

export const getHealth = () => api('/api/health');
