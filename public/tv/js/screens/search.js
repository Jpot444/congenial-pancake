/*
 * Search — a D-pad keyboard, and results that narrow as you type.
 *
 * Everything searched here is already in hand: the three library sections the
 * box has cached, plus the archive index, which is a local file and costs no
 * provider connection. Nothing is asked of the provider per keystroke.
 */

import { el, clear, hms, gb, cleanName } from '../ui.js';
import { focus } from '../focus.js';
import { searchArchive } from '../api.js';
import { state, loadLibrary, isOwner } from '../state.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const PER_ROW = 9;
const MAX_RESULTS = 12;
const MIN_QUERY = 2;

let query = '';
let results = [];
let archiveHits = [];
let hostNode = null;
let appRef = null;

export async function render(host, app) {
  hostNode = host;
  appRef = app;

  await Promise.all([loadLibrary('live'), loadLibrary('movies'), loadLibrary('series')]);
  await runSearch();
  paint();
}

function paint() {
  const root = el('div', 'search');
  root.append(left());
  root.append(right());
  clear(hostNode).append(root);
}

/* ------------------------------------------------------------- keyboard ── */

function left() {
  const col = el('div', 'search-left');

  const head = el('div');
  head.append(el('div', 'eyebrow', 'SEARCH · EVERY STATION AND TITLE'));
  const field = el('div', 'search-field');
  const glass = el('span');
  glass.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
    + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/>'
    + '<path d="M20 20l-3.5-3.5"/></svg>';
  glass.style.display = 'inline-flex';
  glass.style.color = 'var(--muted)';
  field.append(glass, el('span', 'query', query), el('span', 'caret'));
  head.append(field);
  col.append(head);

  const keys = el('div', 'keys');
  LETTERS.forEach((value, i) => {
    const key = el('div', 'key', value);
    key.dataset.r = 1 + Math.floor(i / PER_ROW);
    key.dataset.c = i % PER_ROW;
    key.dataset.kind = 'key';
    key.dataset.lift = 'none';
    key._value = value;
    keys.append(key);
  });
  col.append(keys);

  const row = el('div', 'key-row');
  const space = el('div', 'key wide', 'SPACE');
  space.dataset.r = 5; space.dataset.c = 0; space.dataset.kind = 'key'; space.dataset.lift = 'none';
  space._value = ' ';
  const del = el('div', 'key fixed', 'DELETE');
  del.dataset.r = 5; del.dataset.c = 1; del.dataset.kind = 'del'; del.dataset.lift = 'none';
  const wipe = el('div', 'key fixed', 'CLEAR');
  wipe.dataset.r = 5; wipe.dataset.c = 2; wipe.dataset.kind = 'clear'; wipe.dataset.lift = 'none';
  row.append(space, del, wipe);
  col.append(row);

  col.append(el('div', 'search-hint', 'Hold the mic button on the remote to say it instead.'));
  return col;
}

/* -------------------------------------------------------------- results ── */

function right() {
  const col = el('div', 'search-right');
  const head = el('div', 'results-head');
  head.append(el('h2', null, 'RESULTS'));
  head.append(el('span', 'meta', query.trim().length < MIN_QUERY
    ? `Type ${MIN_QUERY} letters`
    : `${results.length}${results.length === MAX_RESULTS ? '+' : ''} for “${query.trim()}”`));
  col.append(head);

  const list = el('div', 'results');
  if (!results.length) {
    list.append(el('div', 'empty', query.trim().length < MIN_QUERY
      ? 'Channels, films, shows and the archive drive — all at once.'
      : 'Nothing matched.'));
  }
  results.forEach((hit, i) => {
    const row = el('div', 'result rowblock');
    row.dataset.r = 6 + i;
    row.dataset.c = 0;
    row.dataset.kind = 'result';
    row.dataset.lift = 'none';
    row._hit = hit;

    const art = el('span', 'result-art');
    if (hit.item && hit.item.logo) {
      const image = new Image();
      image.loading = 'lazy';
      image.alt = '';
      image.src = `/img?u=${encodeURIComponent(hit.item.logo)}`;
      art.append(image);
    }
    row.append(art);

    const mid = el('div', 'result-mid');
    mid.append(el('span', 'result-name', cleanName(hit.name)));
    mid.append(el('span', 'result-meta', hit.meta));
    row.append(mid);
    row.append(el('span', 'result-kind', hit.kind));
    list.append(row);
  });
  col.append(list);
  return col;
}

/* --------------------------------------------------------- the searching ── */

async function runSearch() {
  const needle = query.trim().toLowerCase();
  results = [];
  if (needle.length < MIN_QUERY) return;

  const out = [];
  const push = (item, kind, meta) => {
    if (out.length >= MAX_RESULTS) return;
    out.push({ item, kind, name: item.name, meta });
  };

  for (const channel of (state.library.live && state.library.live.items) || []) {
    if (!channel.name.toLowerCase().includes(needle)) continue;
    push(channel, 'CHANNEL', channel.num ? `Live · channel ${channel.num}` : 'Live');
  }
  for (const movie of (state.library.movies && state.library.movies.items) || []) {
    if (!movie.name.toLowerCase().includes(needle)) continue;
    push(movie, 'MOVIE', movie.rating ? `Film · ★ ${movie.rating}` : 'Film');
  }
  for (const show of (state.library.series && state.library.series.items) || []) {
    if (!show.name.toLowerCase().includes(needle)) continue;
    push(show, 'SERIES', show.genre || 'Series');
  }

  /* The archive is a local index — searching it costs nothing upstream. */
  if (isOwner() && out.length < MAX_RESULTS) {
    try {
      const data = await searchArchive(state.profile.id, needle);
      archiveHits = data.items || [];
      for (const file of archiveHits) {
        push(
          { kind: 'archive', id: file.path, name: file.title, logo: '', path: file.path },
          'ARCHIVE',
          [file.year, file.duration ? hms(file.duration) : '', file.size ? gb(file.size) : '']
            .filter(Boolean).join(' · ')
        );
      }
    } catch {
      /* An archive that will not answer does not take the other results down. */
    }
  }

  results = out;
}

/* --------------------------------------------------------------- remote ── */

export async function activate(node, app) {
  const kind = node.dataset.kind;

  if (kind === 'key' || kind === 'del' || kind === 'clear') {
    if (kind === 'key') query = (query + node._value).slice(0, 24);
    else if (kind === 'del') query = query.slice(0, -1);
    else query = '';
    await runSearch();
    /* Repaint in place: the cursor must not jump off the key just pressed. */
    const r = Number(node.dataset.r);
    const c = Number(node.dataset.c);
    paint();
    focus.collect();
    focus.pos = { r, c };
    focus.el = null;
    focus.apply();
    return;
  }

  if (kind !== 'result') return;
  const hit = node._hit;
  const item = hit.item;

  if (hit.kind === 'CHANNEL') { app.go('player', { channel: item, from: 'search' }); return; }
  if (hit.kind === 'SERIES') { app.go('show', { show: item }); return; }
  if (hit.kind === 'ARCHIVE') {
    app.go('vod', {
      kind: 'archive',
      path: item.path,
      title: item.name,
      sub: hit.meta,
      eyebrow: 'ARCHIVE',
      resumeKey: `archive:${item.path}`,
      historyKind: 'movie',
      from: 'search',
    });
    return;
  }
  app.go('vod', {
    kind: 'movie',
    streamId: item.id,
    ext: item.ext || 'mp4',
    title: item.name,
    sub: hit.meta,
    eyebrow: 'MOVIE',
    poster: item.logo || '',
    resumeKey: `movie:${item.id}`,
    historyKind: 'movie',
    from: 'search',
  });
}
