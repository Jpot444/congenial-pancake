/*
 * Playing something that is not live: a film, an episode, a file off the
 * archive drive, or a finished download.
 *
 * The mockup stops at the loading screen for these, so this is the one screen
 * built past the design — without it nothing on Movies, Series, Archive or
 * Downloads can actually be watched. It keeps the design's language: brand
 * field and bison while it opens, one bottom scrim over the picture, and the
 * remote hints spelled out.
 *
 * OK play/pause · ◀ ▶ 10 seconds · ▲ ▼ five minutes · BACK stop.
 */

import { el, clear, hms, plateText } from '../ui.js';
import { getPlay, getArchivePlay, getProgress, postHistory } from '../api.js';
import { state } from '../state.js';

export const fullbleed = true;

const RESUME_MIN = 60;
const RESUME_MAX_RATIO = 0.95;
const HISTORY_EVERY_MS = 30000;
const CHROME_MS = 4500;

let job = null;      // { title, sub, from, resumeKey, historyRow }
let video = null;
let hls = null;
let host = null;
let appRef = null;
let historyTimer = null;
let chromeTimer = null;
let scrimNode = null;

export async function render(hostNode, app, params) {
  host = hostNode;
  appRef = app;
  if (params && params.title) job = params;
  if (!job) { app.go('movies'); return; }

  app.tune({
    eyebrow: 'STARTING PLAYBACK',
    name: job.title,
    sub: job.sub || '',
    hints: [['BACK', 'Cancel']],
  });

  let stream;
  try {
    stream = await resolve(job);
  } catch (err) {
    app.tuneError(job.title, err.message);
    return;
  }

  /* A .mkv the box has to convert opens slower than one it can hand over, and
     saying so is the difference between "slow" and "broken". */
  if (stream.transcoding || (stream.session && stream.prebuffer)) {
    app.tune({
      eyebrow: 'REMUXING ON THE PI',
      name: job.title,
      sub: `${stream.prebuffer || 45} second prebuffer · to fMP4`,
      badge: { text: 'CONVERTING', dot: true },
      hints: [['BACK', 'Cancel']],
    });
  }

  paint(stream);
  try {
    await attach(stream);
  } catch (err) {
    app.tuneError(job.title, err.message);
    return;
  }
  app.clearTune();
  await resume(stream);
  beginHistory(stream);
  showChrome();
}

async function resolve(request) {
  if (request.kind === 'archive') {
    if (!state.profile) throw new Error('No profile.');
    return getArchivePlay(state.profile.id, request.path);
  }
  if (request.kind === 'download') {
    return { url: `/api/downloads/${request.id}/file`, format: 'file' };
  }
  if (request.kind === 'series') {
    return getPlay('series', request.streamId, request.ext);
  }
  return getPlay('movie', request.streamId, request.ext);
}

function paint(stream) {
  const root = el('div', 'player');
  video = el('video');
  video.setAttribute('playsinline', '');
  video.autoplay = true;
  root.append(video);

  scrimNode = el('div', 'player-scrim');
  root.append(scrimNode);
  clear(host).append(root);
  paintScrim(stream);
}

function paintScrim(stream) {
  if (!scrimNode) return;
  clear(scrimNode);
  const row = el('div', 'scrim-row');
  const left = el('div');
  left.style.minWidth = '0';

  const line = el('div', 'now-line');
  line.append(el('span', 'now-chan', (job.eyebrow || 'NOW PLAYING').toUpperCase()));
  line.append(el('span', 'now-tech', stream && stream.format === 'm3u8' ? 'HLS · converted on the Pi' : 'Direct'));
  left.append(line, el('div', 'now-title', job.title));

  const times = el('div', 'now-times');
  const at = el('span', null, hms(video ? video.currentTime : 0));
  const track = el('span', 'bar');
  const fill = el('span');
  const duration = playDuration(stream);
  fill.style.width = duration ? `${((video ? video.currentTime : 0) / duration) * 100}%` : '0%';
  track.append(fill);
  const end = el('span', null, duration ? hms(duration) : 'Length unknown');
  times.append(at, track, end);
  left.append(times);
  scrimNode._at = at;
  scrimNode._fill = fill;
  scrimNode._duration = duration;

  const hints = el('span', 'hintpill');
  for (const [key, label] of [['OK', 'Play / pause'], ['◀ ▶', '10 sec'], ['▲ ▼', '5 min'], ['BACK', 'Stop']]) {
    const span = el('span');
    span.append(el('b', null, key), ` ${label}`);
    hints.append(span);
  }
  row.append(left, hints);
  scrimNode.append(row);
}

/** A converted file knows its real length from the index, not from the output. */
function playDuration(stream) {
  if (stream && Number.isFinite(stream.sourceDuration) && stream.sourceDuration > 0) {
    return stream.sourceDuration;
  }
  return video && Number.isFinite(video.duration) ? video.duration : 0;
}

async function attach(stream) {
  const isHls = stream.format === 'm3u8' || /\.m3u8(\?|$)/i.test(stream.url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ backBufferLength: 90 });
    hls.loadSource(stream.url);
    hls.attachMedia(video);
  } else {
    video.src = stream.url;
  }
  video.addEventListener('timeupdate', tick);
  try {
    await video.play();
  } catch {
    video.muted = true;
    try {
      await video.play();
      if (appRef) appRef.toast('Started muted — this browser blocked sound until you interact.');
    } catch (err) {
      throw new Error(`It would not start: ${err.message}`);
    }
  }
}

/**
 * Pick up where this profile stopped. No dialog: on a remote, a question
 * between pressing OK and seeing a picture is a question nobody wants — it
 * resumes and says so, and ▲ from the start is how you go back to the top.
 */
async function resume(stream) {
  if (!job.resumeKey || !state.profile) return;
  const row = await getProgress(state.profile.id, job.resumeKey).catch(() => null);
  if (!row || !row.found || row.completed) return;
  if (row.position < RESUME_MIN) return;
  if (row.duration && row.position / row.duration > RESUME_MAX_RATIO) return;
  const seekTo = row.position;
  const apply = () => {
    try { video.currentTime = seekTo; } catch { /* not seekable yet */ }
    if (appRef) appRef.toast(`Resumed from ${hms(seekTo)}. ▲ to go back to the start.`);
  };
  if (video.readyState >= 1) apply();
  else video.addEventListener('loadedmetadata', apply, { once: true });
}

function tick() {
  if (!scrimNode || scrimNode.hidden) return;
  const duration = scrimNode._duration || playDuration(null);
  if (scrimNode._at) scrimNode._at.textContent = hms(video.currentTime);
  if (scrimNode._fill && duration) {
    scrimNode._fill.style.width = `${Math.min(100, (video.currentTime / duration) * 100)}%`;
  }
}

function beginHistory() {
  clearInterval(historyTimer);
  if (!state.profile || !job.resumeKey) return;
  const report = () => {
    const duration = Number.isFinite(video.duration) ? Math.floor(video.duration) : 0;
    postHistory(state.profile.id, {
      key: job.resumeKey,
      kind: job.historyKind || 'movie',
      id: job.streamId || job.id || '',
      name: job.title,
      categoryId: job.categoryId || '',
      poster: job.poster || '',
      seriesId: job.seriesId || undefined,
      season: job.season || undefined,
      episode: job.episode || undefined,
      position: Math.floor(video.currentTime || 0),
      duration,
      completed: duration > 0 && video.currentTime / duration > RESUME_MAX_RATIO,
    }).catch(() => {});
  };
  report();
  historyTimer = setInterval(report, HISTORY_EVERY_MS);
}

/** Chrome comes up on any press and goes away on its own. */
function showChrome() {
  if (!scrimNode) return;
  scrimNode.hidden = false;
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => { if (scrimNode) scrimNode.hidden = true; }, CHROME_MS);
}

export function onKey(key, { back, ok }) {
  if (back) return false;
  showChrome();
  if (ok) {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    return true;
  }
  const seek = { ArrowLeft: -10, ArrowRight: 10, ArrowUp: -300, ArrowDown: 300 }[key];
  if (seek) {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const next = Math.max(0, video.currentTime + seek);
    video.currentTime = duration ? Math.min(next, duration - 1) : next;
    tick();
    return true;
  }
  return false;
}

export function back(app) {
  app.go(job.from || 'movies');
  return true;
}

export function tuneDismissed() {
  if (appRef) appRef.go(job && job.from ? job.from : 'movies');
}

export function leave() {
  clearInterval(historyTimer);
  clearTimeout(chromeTimer);
  historyTimer = null;
  if (video) {
    /* One last position before the element goes: stopping five minutes in and
       finding it forgotten is the whole failure this prevents. */
    if (state.profile && job && job.resumeKey && video.currentTime > 5) {
      const duration = Number.isFinite(video.duration) ? Math.floor(video.duration) : 0;
      postHistory(state.profile.id, {
        key: job.resumeKey,
        kind: job.historyKind || 'movie',
        id: job.streamId || job.id || '',
        name: job.title,
        position: Math.floor(video.currentTime),
        duration,
        completed: duration > 0 && video.currentTime / duration > RESUME_MAX_RATIO,
      }).catch(() => {});
    }
    video.removeEventListener('timeupdate', tick);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* gone */ }
  }
  if (hls) { try { hls.destroy(); } catch { /* gone */ } hls = null; }
  video = null;
  scrimNode = null;
}
