/*
 * Multi-view — up to four games at once, audio following focus.
 *
 * A warning that belongs on the screen and not only in a commit message: the
 * provider account allows ONE connection. Four cells is four streams, and a
 * provider that refuses the second one will leave three cells dark — so each
 * cell reports its own failure rather than the screen pretending to work. On
 * this setup it is the Pi's own HLS window that makes the difference; a box
 * without ffmpeg will not hold four.
 *
 * ▲▼◀▶ moves the audio, OK takes that cell full screen, BACK returns.
 */

import { el, clear, plateText, toast } from '../ui.js';
import { focus } from '../focus.js';
import { getPlay } from '../api.js';
import { loadLibrary, loadEpg, nowOn, favorites, pinnedIds } from '../state.js';
import { getGames, matchChannel } from '../scores.js';

export const fullbleed = true;

const CELLS = 4;

let cells = [];
let slate = [];
let epg = new Map();

export async function render(host, app) {
  const lib = await loadLibrary('live');
  slate = await getGames();

  const picked = preset(lib);
  epg = await loadEpg(picked.map((c) => String(c.epgId || c.id)));
  cells = picked.map((channel) => ({ channel, video: null, hls: null, mpegts: null, error: '' }));

  const root = el('div', 'multi');
  const quad = el('div', 'quad');
  cells.forEach((cell, i) => quad.append(cellNode(cell, i)));
  root.append(quad);

  const bar = el('div', 'multi-bar');
  const left = el('div', 'left');
  left.append(el('h2', null, 'MULTI-VIEW'));
  left.append(el('span', 'meta', `${cells.length} games · audio follows focus`));

  const hints = el('span', 'hintpill');
  for (const [key, label] of [['▲▼◀▶', 'Audio'], ['OK', 'Full screen'], ['BACK', 'Live TV']]) {
    const span = el('span');
    span.append(el('b', null, key), ` ${label}`);
    hints.append(span);
  }

  /* Row 22 is under the bottom pair, so ▼ from either of them lands on it.
     Four cells drift apart on their own — each is a separate stream with its
     own stalls — and this puts all four back on the edge together. */
  const live = el('button', 'multi-live ring');
  live.dataset.r = 22;
  live.dataset.c = 0;
  live.dataset.kind = 'multilive';
  live.dataset.lift = 'pill';
  live.append(el('span', 'live-dot'), el('span', null, 'JUMP ALL TO LIVE'));

  const right = el('div', 'right');
  right.append(live, hints);
  bar.append(left, right);
  root.append(bar);

  clear(host).append(root);

  focus.reset(20, 0);
  cells.forEach((cell, i) => start(cell, i));
}

/**
 * Which four. The games that matched a channel come first — this screen exists
 * for Sunday — then hearted channels, then pinned categories.
 */
function preset(lib) {
  const items = lib.items || [];
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || seen.has(String(c.id)) || out.length >= CELLS) return;
    seen.add(String(c.id));
    out.push(c);
  };

  for (const game of slate) {
    if (game.status !== 'live') continue;
    push(matchChannel(game, items));
  }
  for (const fav of favorites()) if (fav.item && fav.item.kind === 'live') push(fav.item);
  const pinned = new Set(pinnedIds('live'));
  for (const c of items) if (pinned.has(String(c.categoryId))) push(c);
  for (const c of items) push(c);
  return out;
}

function cellNode(cell, i) {
  const node = el('div', 'quad-cell');
  /* Two rows of two, so the D-pad matches what the eye sees: down from the
     top-left cell lands on the one below it, not the one beside it. */
  node.dataset.r = 20 + Math.floor(i / 2);
  node.dataset.c = i % 2;
  node.dataset.kind = 'quad';
  node.dataset.lift = 'none';
  node._cell = cell;
  cell.node = node;

  const video = el('video');
  video.setAttribute('playsinline', '');
  video.autoplay = true;
  video.muted = i !== 0;
  cell.video = video;
  node.append(video);


  const game = slate.find((g) => matchChannel(g, [cell.channel]));
  const badge = el('div', 'quad-badge');
  badge.append(el('span', null, game ? scoreText(game) : plateText(cell.channel.name)));
  const clock = el('span', `clock${i === 0 ? ' on' : ''}`);
  clock.textContent = game ? (game.clock || 'LIVE').replace(' · ', ' ') : 'LIVE';
  badge.append(clock);
  node.append(badge);

  const foot = el('div', 'quad-foot');
  foot.append(el('span', 'name', plateText(cell.channel.name)));
  const listing = nowOn(epg.get(String(cell.channel.epgId || cell.channel.id)));
  const what = el('span', 'quad-game', listing ? listing.title : (game ? gameText(game) : ''));
  foot.append(what);
  const aud = el('span', `aud${i === 0 ? ' on' : ''}`, i === 0 ? 'AUDIO' : 'MUTED');
  foot.append(aud);
  cell.audLabel = aud;
  cell.whatLabel = what;
  node.append(foot);
  return node;
}

const scoreText = (game) => (game.redZone
  ? 'RED ZONE'
  : `${game.away ? `${game.away.abbr} ${game.away.score}` : ''} · ${game.home ? `${game.home.abbr} ${game.home.score}` : ''}`);

const gameText = (game) => (game.redZone
  ? 'Red Zone whip-around'
  : `${game.away ? game.away.abbr : ''} at ${game.home ? game.home.abbr : ''}`);

async function start(cell, i) {
  try {
    const stream = await getPlay('live', cell.channel.id);
    const isHls = stream.format === 'm3u8' || /\.m3u8(\?|$)/i.test(stream.url);
    if (isHls && window.Hls && window.Hls.isSupported()) {
      cell.hls = new window.Hls({
        lowLatencyMode: false,
        liveSyncDuration: stream.dvr ? 45 : 32,
        liveMaxLatencyDuration: 600,
        backBufferLength: 30,
      });
      cell.hls.loadSource(stream.url);
      cell.hls.attachMedia(cell.video);
      /* Four cells share one link, so a starved fragment here is routine.
         Pick the load back up, and only name it when it is something else. */
      cell.hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) cell.hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) cell.hls.recoverMediaError();
        else fault(cell, data.details);
      });
    } else if (!isHls && window.mpegts && window.mpegts.isSupported()) {
      cell.mpegts = window.mpegts.createPlayer(
        /* Absolute: mpegts.js fetches inside a worker, which cannot parse the
           box's own "/api/proxy?…" against a base URL it does not have. */
        { type: 'mpegts', isLive: true, url: new URL(stream.url, location.href).href },
        { enableWorker: true, liveBufferLatencyChasing: false, enableStashBuffer: false }
      );
      cell.mpegts.attachMediaElement(cell.video);
      cell.mpegts.load();
      cell.mpegts.on(window.mpegts.Events.ERROR, (type, detail) => fault(cell, `${type}: ${detail}`));
    } else {
      cell.video.src = stream.url;
    }
    await cell.video.play().catch(() => {
      cell.video.muted = true;
      return cell.video.play();
    });
  } catch (err) {
    fault(cell, err.message);
  }
}

/** A cell reports its own trouble in its own foot — the others carry on. */
function fault(cell, detail) {
  cell.error = detail;
  if (cell.whatLabel) cell.whatLabel.textContent = `Did not open — ${detail}`;
}

/** Audio follows focus: exactly one cell is heard, and it says which. */
export function onFocus(node) {
  const active = node && node._cell;
  /* The bar's own button is not a cell. Focusing it must not mute the game
     that is currently being heard. */
  if (!active) return;
  for (const cell of cells) {
    const on = cell === active;
    if (cell.video) cell.video.muted = !on;
    if (cell.audLabel) {
      cell.audLabel.textContent = on ? 'AUDIO' : 'MUTED';
      cell.audLabel.classList.toggle('on', on);
    }
    const clock = cell.node && cell.node.querySelector('.quad-badge .clock');
    if (clock) clock.classList.toggle('on', on);
  }
}

export function activate(node, app) {
  if (node.dataset.kind === 'multilive') {
    jumpAllToLive();
    return;
  }
  const cell = node._cell;
  if (!cell) return;
  app.go('player', { channel: cell.channel, from: 'multi' });
}

/**
 * Every cell back to its own live edge.
 *
 * Each one is its own window with its own delay, so this is four independent
 * seeks rather than one — and the count that comes back is the honest one:
 * cells that were already live are not claimed as fixed.
 */
function jumpAllToLive() {
  let moved = 0;
  for (const cell of cells) {
    const video = cell.video;
    if (!video) continue;
    const ranges = video.seekable && video.seekable.length ? video.seekable : video.buffered;
    if (!ranges || !ranges.length) continue;
    const edge = ranges.end(ranges.length - 1);
    if (!Number.isFinite(edge)) continue;
    if (edge - video.currentTime > 4) moved += 1;
    video.currentTime = cell.hls && Number.isFinite(cell.hls.liveSyncPosition)
      ? cell.hls.liveSyncPosition
      : Math.max(0, edge - 1);
    video.play().catch(() => {});
  }
  toast(moved
    ? `${moved} of ${cells.length} were behind — all back to live.`
    : 'All four were already live.');
}

export function leave() {
  for (const cell of cells) {
    if (cell.hls) { try { cell.hls.destroy(); } catch { /* already gone */ } }
    if (cell.mpegts) { try { cell.mpegts.destroy(); } catch { /* already gone */ } }
    if (cell.video) {
      try { cell.video.pause(); cell.video.removeAttribute('src'); cell.video.load(); }
      catch { /* already gone */ }
    }
  }
  cells = [];
}
