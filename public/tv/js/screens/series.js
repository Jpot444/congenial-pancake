/*
 * Series — the same shape as Movies, pointed at shows.
 *
 * A card here opens the show's own page rather than playing something: a
 * series is a place, not a title, and on a remote the season picker has to be
 * a screen you arrive at rather than a menu you hover.
 */

import { el, clear, cleanName } from '../ui.js';
import { loadLibrary, loadTaste, continueWatching, affinity, state } from '../state.js';
import { posterCard, rowHead, strip, rowBlock } from './cards.js';

const ROW_MAX = 24;

let items = [];
let rows = [];
let spot = {};

export async function render(host, app) {
  const lib = await loadLibrary('series');
  if (!state.taste) await loadTaste();
  items = lib.items || [];

  const root = el('div', 'screen');
  root.append(spotlight(lib));

  rows = [];
  addRow(root, 'KEEP WATCHING', 'Next episode is queued', keepWatchingRow());
  addRow(root, 'FOR YOU', 'From what this profile has watched', forYouRow());
  addRow(root, 'RECENTLY UPDATED', 'New episodes first', newestRow());
  addRow(root, 'ALL SHOWS', `A–Z · ${items.length.toLocaleString()}`, allRow());

  if (state.errors.series) {
    root.append(el('div', 'empty', `The series library did not load: ${state.errors.series}`));
  } else if (!items.length) {
    root.append(el('div', 'empty', 'No series in this library.'));
  }

  clear(host).append(root);
}

function spotlight(lib) {
  const node = el('div', 'spotlight');
  node.append(el('div', 'eyebrow',
    `SERIES · ${(lib.totals ? lib.totals.items : items.length).toLocaleString()} SHOWS`));
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
    r, c, sub: entry.sub, subClass: entry.subClass, progress: entry.progress, kind: 'show',
  }));
  root.append(rowBlock(rowHead(title, { meta }), strip(cards)));
}

/* ---------------------------------------------------------------- rows ── */

/**
 * A part-watched episode names its show through the history row's seriesId, so
 * the card can open the show page at the right place rather than at season 1.
 */
function keepWatchingRow() {
  const byId = new Map(items.map((s) => [String(s.id), s]));
  const seenShows = new Set();
  const out = [];
  for (const row of continueWatching()) {
    if (row.kind !== 'series') continue;
    const showId = String(row.seriesId ?? row.id ?? '');
    if (!showId || seenShows.has(showId)) continue;
    seenShows.add(showId);
    const item = byId.get(showId) || { kind: 'series', id: showId, name: row.name, logo: row.poster };
    const left = Math.max(0, (row.duration || 0) - (row.position || 0));
    out.push({
      item,
      season: row.season,
      episode: row.episode,
      sub: row.season
        ? `S${row.season} E${row.episode}${left ? ` · ${Math.round(left / 60)} min left` : ''}`
        : 'Resume',
      subClass: 'left',
      progress: row.duration ? (row.position / row.duration) * 100 : 0,
    });
    if (out.length >= ROW_MAX) break;
  }
  return out;
}

function forYouRow() {
  const liked = affinity('series').slice(0, 6).map((a) => String(a.categoryId));
  if (!liked.length) return [];
  const seen = new Set();
  const out = [];
  for (const categoryId of liked) {
    const inCategory = items
      .filter((s) => String(s.categoryId) === categoryId)
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
      .slice(0, 6);
    for (const item of inCategory) {
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      out.push({ item, sub: item.genre || (item.rating ? `★ ${item.rating}` : '') });
    }
  }
  return out.slice(0, ROW_MAX);
}

function newestRow() {
  return [...items]
    .sort((a, b) => Number(b.added || 0) - Number(a.added || 0))
    .slice(0, ROW_MAX)
    .map((item) => ({ item, sub: item.rating ? `★ ${item.rating}` : (item.genre || '') }));
}

function allRow() {
  return [...items]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, ROW_MAX)
    .map((item) => ({ item, sub: item.genre || (item.rating ? `★ ${item.rating}` : '') }));
}

/* -------------------------------------------------------------- remote ── */

export function onFocus(node) {
  const item = node && node._item;
  if (!item || !spot.title) return;
  spot.title.textContent = cleanName(item.name);
  const bits = [];
  if (item.rating) bits.push(`★ ${item.rating}`);
  if (item.genre) bits.push(item.genre);
  const category = (state.library.series.categories || [])
    .find((c) => String(c.id) === String(item.categoryId));
  if (category) bits.push(category.name);
  spot.meta.textContent = bits.join(' · ');
  spot.syn.textContent = '';
}

export function activate(node, app) {
  const item = node && node._item;
  if (!item) return;
  const row = rows[Number(node.dataset.r) - 1] || [];
  const entry = row.find((e) => e.item === item);
  app.go('show', { show: item, season: entry && entry.season ? entry.season : null });
}
