/*
 * One show: the seasons it actually has, and the episodes in the one chosen.
 *
 * "The seasons it actually has" is load-bearing — the provider's series list
 * carries a season count that is often wrong, so the pills are built from the
 * episodes get_series_info really returns. A show with two seasons shows
 * SEASON 1 and SEASON 2 and nothing else.
 *
 * An episode row says where this profile is in it, from the box's own history,
 * and carries the design system's crimson edge when it is the one to resume.
 */

import { el, clear, artwork, hms, icon, cleanName } from '../ui.js';
import { getSeriesInfo, getDownloads, queueDownload } from '../api.js';
import { state, recentlyWatched, continueWatching } from '../state.js';

let show = null;
let info = null;
let seasons = [];
let season = 1;
let episodes = [];
let downloads = [];

export async function render(host, app, params) {
  if (params && params.show) {
    show = params.show;
    info = null;
    season = params.season || null;
  }
  if (!show) { app.go('series'); return; }

  if (!info) {
    try {
      info = state.seriesInfo.get(String(show.id)) || await getSeriesInfo(show.id);
      state.seriesInfo.set(String(show.id), info);
    } catch (err) {
      clear(host).append(el('div', 'empty', `That show did not load: ${err.message}`));
      return;
    }
  }
  downloads = await getDownloads().then((d) => d.items || []).catch(() => []);

  const bySeason = (info && info.episodes) || {};
  seasons = Object.keys(bySeason)
    .map(Number)
    .filter((n) => Array.isArray(bySeason[String(n)]) && bySeason[String(n)].length)
    .sort((a, b) => a - b);
  if (!seasons.length) seasons = [1];
  if (!season || !seasons.includes(Number(season))) season = seasons[0];
  episodes = bySeason[String(season)] || [];

  const root = el('div', 'show');
  root.append(left());
  root.append(right());
  clear(host).append(root);
}

function left() {
  const col = el('div', 'show-left');
  const art = artwork(el('div', 'show-art'), (info && info.info && info.info.cover) || show.logo, show.name);
  col.append(art);
  col.append(el('div', 'show-note',
    'Season download queues one episode at a time — the account allows a single connection.'));
  return col;
}

function right() {
  const col = el('div', 'show-right');

  const head = el('div');
  head.append(el('div', 'eyebrow', 'SERIES'));
  head.append(el('div', 'show-title', cleanName(show.name)));
  head.append(el('div', 'show-meta', metaLine()));
  const plot = (info && info.info && info.info.plot) || '';
  if (plot) head.append(el('div', 'show-syn', plot));
  col.append(head);

  col.append(seasonRow());
  col.append(episodeList());
  return col;
}

function metaLine() {
  const meta = (info && info.info) || {};
  const bits = [`${seasons.length} season${seasons.length === 1 ? '' : 's'}`];
  if (meta.genre) bits.push(meta.genre);
  const rating = meta.rating || show.rating;
  if (rating) bits.push(`★ ${rating}`);
  return bits.join(' · ');
}

function seasonRow() {
  const block = el('div', 'rowblock');
  const strip = el('div', 'strip');
  const inner = el('div', 'strip-inner');
  inner.style.gap = '16px';

  seasons.forEach((n, c) => {
    const pill = el('div', `season-pill${n === Number(season) ? ' on' : ''}`, `SEASON ${n}`);
    pill.dataset.r = 1;
    pill.dataset.c = c;
    pill.dataset.kind = 'season';
    pill.dataset.lift = 'pill';
    pill._season = n;
    inner.append(pill);
  });

  const dl = el('div', 'season-pill action');
  dl.dataset.r = 1;
  dl.dataset.c = seasons.length;
  dl.dataset.kind = 'seasondl';
  dl.dataset.lift = 'pill';
  dl.append(icon('download', 28), 'DOWNLOAD SEASON');
  inner.append(dl);

  strip.append(inner);
  block.append(strip);
  return block;
}

/* --------------------------------------------------------- the episodes ── */

/**
 * History for this show, keyed the way the box keys it. Both lists are
 * checked: recentlyWatched is everything, continueWatching is the part-watched
 * subset, and an episode that is in one but not the other must still show its
 * state rather than silently reading as unwatched.
 */
function historyFor(episode) {
  const key = `series:${show.id}:s${episode.season ?? season}e${episode.episode_num}`;
  return recentlyWatched().find((row) => row.key === key)
    || continueWatching().find((row) => row.key === key)
    || null;
}

function downloadFor(episode) {
  return downloads.find((job) => String(job.streamId) === String(episode.id)) || null;
}

function episodeList() {
  const list = el('div', 'episodes');
  if (!episodes.length) {
    list.append(el('div', 'empty', 'No episodes listed for this season.'));
    return list;
  }

  episodes.forEach((episode, i) => {
    const row = el('div', 'rowline rowblock');
    row.dataset.r = 2 + i;
    row.dataset.c = 0;
    row.dataset.kind = 'episode';
    row.dataset.lift = 'none';
    row._episode = episode;

    const num = `S${episode.season ?? season} E${episode.episode_num}`;
    row.append(el('span', 'ep-num', num));
    row.append(el('span', 'ep-title', episode.title || `Episode ${episode.episode_num}`));

    const job = downloadFor(episode);
    const watched = historyFor(episode);
    const state_ = el('span', 'ep-state');
    if (job && job.status === 'done') {
      state_.classList.add('done');
      state_.append(icon('check', 24), 'Downloaded');
    } else if (job && job.status === 'downloading') {
      state_.append(`Downloading · ${Math.round((job.bytes / (job.total || 1)) * 100)}%`);
    } else if (watched && watched.completed) {
      state_.classList.add('done');
      state_.append(icon('check', 24), 'Watched');
    } else if (watched && watched.position > 60) {
      const left = Math.max(0, (watched.duration || 0) - watched.position);
      state_.append(left ? `${Math.round(left / 60)} min left` : 'Part watched');
      row.classList.add('resumed');
    }
    row.append(state_);

    const runtime = episode.info && (episode.info.duration_secs || episode.info.duration);
    row.append(el('span', 'ep-run', runtime
      ? (typeof runtime === 'number' ? hms(runtime) : String(runtime))
      : ''));

    list.append(row);
  });
  return list;
}

/* -------------------------------------------------------------- remote ── */

export function activate(node, app) {
  const kind = node.dataset.kind;

  if (kind === 'season') {
    season = node._season;
    app.go('show', { show, season, focusRow: 1, focusCol: seasons.indexOf(season) });
    return;
  }

  if (kind === 'seasondl') {
    queueSeason(app);
    return;
  }

  if (kind === 'episode') {
    const episode = node._episode;
    const job = downloadFor(episode);
    /* Already on the box: play the local copy rather than opening the
       provider connection a second time for the same bytes. */
    if (job && job.status === 'done') {
      app.go('vod', {
        kind: 'download',
        id: job.id,
        title: `${show.name} · S${episode.season ?? season} E${episode.episode_num}`,
        sub: episode.title || '',
        eyebrow: 'DOWNLOADED',
        resumeKey: `series:${show.id}:s${episode.season ?? season}e${episode.episode_num}`,
        historyKind: 'series',
        seriesId: show.id,
        season: episode.season ?? season,
        episode: episode.episode_num,
        from: 'show',
      });
      return;
    }
    app.go('vod', {
      kind: 'series',
      streamId: episode.id,
      ext: episode.container_extension || 'mp4',
      title: `${show.name} · S${episode.season ?? season} E${episode.episode_num}`,
      sub: episode.title || '',
      eyebrow: 'EPISODE',
      poster: show.logo || '',
      categoryId: show.categoryId,
      resumeKey: `series:${show.id}:s${episode.season ?? season}e${episode.episode_num}`,
      historyKind: 'series',
      seriesId: show.id,
      season: episode.season ?? season,
      episode: episode.episode_num,
      from: 'show',
    });
  }
}

/**
 * Queue a whole season. The box takes one at a time by design, and refuses a
 * duplicate with 409 — which is not an error worth showing, it is an episode
 * that is already here.
 */
async function queueSeason(app) {
  const already = episodes.filter((e) => downloadFor(e)).length;
  app.tune({
    eyebrow: 'QUEUEING SEASON',
    name: `${show.name} · Season ${season}`,
    sub: 'One at a time · pauses while anyone is watching',
    badge: { text: `${episodes.length} EPISODES · ${already} ALREADY SAVED` },
    hints: [['BACK', 'Done']],
  });

  let queued = 0;
  let refused = 0;
  for (const episode of episodes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await queueDownload({
        kind: 'series',
        streamId: episode.id,
        ext: episode.container_extension || 'mp4',
        name: `${show.name} S${episode.season ?? season}E${episode.episode_num} ${episode.title || ''}`.trim(),
        poster: (info && info.info && info.info.cover) || show.logo || '',
        resumeKey: `series:${show.id}:s${episode.season ?? season}e${episode.episode_num}`,
        seriesId: show.id,
        seriesName: show.name,
        season: episode.season ?? season,
        episode: episode.episode_num,
        profileId: state.profile ? state.profile.id : '',
      });
      queued += 1;
    } catch (err) {
      if (err.status === 409) continue;   // already here, or already queued
      refused += 1;
      if (err.status === 413) {           // allowance used up — stop asking
        app.clearTune();
        app.toast(err.message);
        return;
      }
    }
  }

  app.clearTune();
  app.toast(queued
    ? `Queued ${queued} episode${queued === 1 ? '' : 's'}${refused ? `, ${refused} refused` : ''}.`
    : 'Nothing to queue — this season is already on the box.');
  app.refresh();
}

export function back(app) {
  app.go('series');
  return true;
}
