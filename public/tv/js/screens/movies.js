/*
 * Movies — a spotlight that follows focus, over the portal's own named rows.
 *
 * Continue watching and For You are not invented here: the box already keeps
 * per-profile history and works out category affinity, and /taste hands both
 * over in one call. New releases sorts on the provider's `added` timestamp,
 * which is what it is for.
 *
 * The spotlight's synopsis is fetched lazily, and only for a title the viewer
 * has settled on — this provider allows one connection, and firing a metadata
 * call for every card the D-pad passes over would be a poor way to spend it.
 */

import { el, clear, cleanName } from '../ui.js';
import { api } from '../api.js';
import { loadLibrary, loadTaste, continueWatching, affinity, state } from '../state.js';
import { posterCard, rowHead, strip, rowBlock } from './cards.js';

const ROW_MAX = 24;
const SYNOPSIS_DELAY_MS = 700;

let items = [];
let rows = [];
let spot = {};
const plots = new Map();
let plotTimer = null;

export async function render(host, app) {
  const lib = await loadLibrary('movies');
  if (!state.taste) await loadTaste();
  items = lib.items || [];

  const root = el('div', 'screen');
  root.append(spotlight(lib));

  rows = [];
  addRow(root, 'CONTINUE WATCHING', 'Picks up where you stopped', resumeRow());
  addRow(root, 'FOR YOU', 'From what this profile has watched', forYouRow());
  addRow(root, 'NEW RELEASES', `${items.length.toLocaleString()} titles · newest first`, newestRow());
  addRow(root, 'TOP RATED', 'Highest rated in the library', topRatedRow());

  if (state.errors.movies) {
    root.append(el('div', 'empty', `The movie library did not load: ${state.errors.movies}`));
  } else if (!items.length) {
    root.append(el('div', 'empty', 'No movies in this library.'));
  }

  clear(host).append(root);
}

function spotlight(lib) {
  const node = el('div', 'spotlight');
  node.append(el('div', 'eyebrow',
    `MOVIES · ${(lib.totals ? lib.totals.items : items.length).toLocaleString()} TITLES`));
  spot.title = el('div', 'spot-title', '');
  spot.meta = el('div', 'spot-meta', '');
  spot.syn = el('div', 'spot-syn', '');
  node.append(spot.title, spot.meta, spot.syn);
  return node;
}

function addRow(root, title, meta, list) {
  if (!list.length) return;
  const r = rows.length + 1;
  rows.push(list);
  const cards = list.map((entry, c) => posterCard(entry.item, {
    r,
    c,
    sub: entry.sub,
    subClass: entry.subClass,
    progress: entry.progress,
    kind: 'movie',
  }));
  root.append(rowBlock(rowHead(title, { meta }), strip(cards)));
}

/* ---------------------------------------------------------------- rows ── */

/** History rows carry their own name and poster, so they render with no library lookup. */
function resumeRow() {
  const byId = new Map(items.map((m) => [String(m.id), m]));
  return continueWatching()
    .filter((row) => row.kind === 'movie')
    .slice(0, ROW_MAX)
    .map((row) => {
      const item = byId.get(String(row.id)) || {
        kind: 'movie', id: row.id, name: row.name, logo: row.poster, ext: 'mp4',
      };
      const left = Math.max(0, (row.duration || 0) - (row.position || 0));
      return {
        item,
        resumeKey: row.key,
        sub: left ? `${Math.round(left / 60)} min left` : 'Resume',
        subClass: 'left',
        progress: row.duration ? (row.position / row.duration) * 100 : 0,
      };
    });
}

/** The categories this profile actually watches, best rated first within them. */
function forYouRow() {
  const liked = affinity('movie').slice(0, 6).map((a) => String(a.categoryId));
  if (!liked.length) return [];
  const seen = new Set();
  const out = [];
  for (const categoryId of liked) {
    const inCategory = items
      .filter((m) => String(m.categoryId) === categoryId)
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
      .slice(0, 6);
    for (const item of inCategory) {
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      out.push({ item, sub: item.rating ? `★ ${item.rating}` : '' });
    }
  }
  return out.slice(0, ROW_MAX);
}

function newestRow() {
  return [...items]
    .sort((a, b) => Number(b.added || 0) - Number(a.added || 0))
    .slice(0, ROW_MAX)
    .map((item) => ({ item, sub: item.rating ? `★ ${item.rating}` : '' }));
}

function topRatedRow() {
  return [...items]
    .filter((m) => Number(m.rating) > 0)
    .sort((a, b) => Number(b.rating) - Number(a.rating))
    .slice(0, ROW_MAX)
    .map((item) => ({ item, sub: `★ ${item.rating}`, subClass: 'rated' }));
}

/* -------------------------------------------------------------- remote ── */

export function onFocus(node) {
  const item = node && node._item;
  if (!item || !spot.title) return;
  spot.title.textContent = cleanName(item.name);
  spot.meta.textContent = metaLine(item);
  spot.syn.textContent = plots.get(String(item.id)) || '';
  loadPlotSoon(item);
}

function metaLine(item) {
  const bits = [];
  if (item.rating) bits.push(`★ ${item.rating}`);
  if (item.tag) bits.push(item.tag);
  const category = (state.library.movies.categories || [])
    .find((c) => String(c.id) === String(item.categoryId));
  if (category) bits.push(category.name);
  return bits.join(' · ');
}

/** Only once the viewer has stopped moving, and only once per title. */
function loadPlotSoon(item) {
  clearTimeout(plotTimer);
  if (plots.has(String(item.id))) return;
  plotTimer = setTimeout(async () => {
    try {
      const data = await api('/api/xtream', { action: 'get_vod_info', vod_id: item.id });
      const info = data && data.info ? data.info : null;
      const plot = (info && info.plot) || '';
      plots.set(String(item.id), plot);
      if (spot.title && spot.title.textContent === cleanName(item.name)) {
        spot.syn.textContent = plot;
        if (info && (info.releaseDate || info.genre)) {
          spot.meta.textContent = [info.releaseDate, info.genre, item.rating ? `★ ${item.rating}` : '']
            .filter(Boolean).join(' · ');
        }
      }
    } catch {
      plots.set(String(item.id), '');
    }
  }, SYNOPSIS_DELAY_MS);
}

export function activate(node, app) {
  const item = node && node._item;
  if (!item) return;
  const row = rows[Number(node.dataset.r) - 1] || [];
  const entry = row.find((e) => e.item === item);
  app.go('vod', {
    kind: 'movie',
    streamId: item.id,
    ext: item.ext || 'mp4',
    title: item.name,
    sub: metaLine(item),
    eyebrow: 'MOVIE',
    poster: item.logo || '',
    categoryId: item.categoryId,
    resumeKey: (entry && entry.resumeKey) || `movie:${item.id}`,
    historyKind: 'movie',
    from: 'movies',
  });
}
