/*
 * The player, and the two things that open on top of it.
 *
 * Full-bleed picture, a broadcast score bug in the corner, and one line of
 * chrome across the bottom. From there:
 *   ▼    the guide — channel × time, the programme on now in brand crimson,
 *        scrolling in its own container so the page never moves under it
 *   OK   the channel bar — flip channels without leaving the picture
 *   BACK closes whichever is open, then leaves the player
 *
 * Playback is the portal's: /api/play hands back either an MPEG-TS URL for
 * mpegts.js or the Pi's own HLS window for hls.js. Both are on the page from
 * the CDN, exactly as the browser portal loads them; with neither, the <video>
 * element is given the URL and does what it can.
 */

import { el, clear, plateText } from '../ui.js';
import { focus } from '../focus.js';
import { getPlay, postHistory } from '../api.js';
import { state, loadLibrary, loadEpg, nowOn, nextOn, airProgress, favorites, pinnedIds }
  from '../state.js';
import { getGames, matchChannel, usingPlaceholders } from '../scores.js';

export const fullbleed = true;

const GUIDE_ROWS = 12;
const GUIDE_SPAN_HOURS = 6;
const HISTORY_EVERY_MS = 30000;

let channel = null;
let from = 'live';
let overlay = null;          // null | 'guide' | 'bar'
let media = { video: null, hls: null, mpegts: null };
let channels = [];
let epg = new Map();
let game = null;
let historyTimer = null;
let startedAt = 0;
let host = null;
let appRef = null;

/* ------------------------------------------------------------------ view ── */

export async function render(hostNode, app, params) {
  host = hostNode;
  appRef = app;
  if (params && params.channel) {
    channel = params.channel;
    from = params.from || 'live';
    overlay = params.overlay || null;
  }
  if (!channel) { app.go(from); return; }

  const lib = await loadLibrary('live');
  channels = flipList(lib);
  epg = await loadEpg(channels.map((c) => String(c.epgId || c.id)));
  game = matchGame(channel);

  paint();
  await open(app);
}

function paint() {
  const root = el('div', 'player');

  const video = el('video');
  video.setAttribute('playsinline', '');
  video.autoplay = true;
  root.append(video);
  media.video = video;

  root.append(el('div', 'player-watermark', plateText(channel.name)));

  if (game) root.append(scoreBug(game));

  if (!overlay) root.append(scrim());
  if (overlay === 'guide') root.append(guide());
  if (overlay === 'bar') root.append(channelBar());

  clear(host).append(root);
}

/**
 * Repaint and put the cursor where the new state expects it: the top of the
 * guide, the current channel in the bar, nowhere at all with the picture bare.
 */
function repaint() {
  paint();
  if (overlay === 'guide') focus.reset(10, 0);
  else if (overlay === 'bar') {
    focus.reset(30, Math.max(0, channels.findIndex((c) => String(c.id) === String(channel.id))));
  } else focus.reset(-1, 0);
  focus.collect();
  focus.apply();
}

/** The corner bug. Placeholder numbers — see js/scores.js. */
function scoreBug(g) {
  const bug = el('div', 'scorebug');
  if (g.redZone) {
    const only = el('span');
    only.append('RED ZONE');
    bug.append(only, el('span', 'rule'), clockPart(g));
    return bug;
  }
  for (const side of ['away', 'home']) {
    const team = g[side];
    if (!team) continue;
    const part = el('span');
    part.append(team.abbr, ' ');
    part.append(el('b', null, team.score === null ? '—' : team.score));
    bug.append(part, el('span', 'rule'));
  }
  bug.append(clockPart(g));
  return bug;
}

function clockPart(g) {
  const part = el('span', 'clock');
  part.textContent = (g.clock || 'LIVE').replace(' · ', ' ');
  return part;
}

/** The bottom line: what this is, what is on, and how far through it is. */
function scrim() {
  const wrap = el('div', 'player-scrim');
  const row = el('div', 'scrim-row');
  const left = el('div');
  left.style.minWidth = '0';

  const line = el('div', 'now-line');
  const liveTag = el('span', 'now-live');
  liveTag.append(el('span', 'live-dot'), 'LIVE');
  line.append(liveTag, el('span', 'now-chan', channel.name));
  line.append(el('span', 'now-tech', techLine()));
  left.append(line);

  const listing = nowOn(epg.get(String(channel.epgId || channel.id)));
  left.append(el('div', 'now-title', listing ? listing.title : programmeFallback()));

  const times = el('div', 'now-times');
  if (listing) {
    const track = el('span', 'bar');
    const fill = el('span');
    fill.style.width = `${airProgress(listing)}%`;
    track.append(fill);
    times.append(
      el('span', null, fmt(listing.start)),
      track,
      el('span', null, fmt(listing.stop))
    );
  } else {
    times.append(el('span', null, 'No listing for this channel'));
  }
  left.append(times);

  const hints = el('span', 'hintpill');
  for (const [key, label] of [['▼', 'Guide'], ['OK', 'Channels'], ['BACK', backLabel()]]) {
    const span = el('span');
    span.append(el('b', null, key), ` ${label}`);
    hints.append(span);
  }

  row.append(left, hints);
  wrap.append(row);
  return wrap;
}

/**
 * What is actually being played, named the way the portal names it: the
 * provider's MPEG-TS, the Pi's own HLS window, or whatever else /api/play
 * handed back. No bitrate — the box does not report one, and a made-up
 * number on a diagnostics line is worse than no line.
 */
function techLine() {
  const format = { ts: 'MPEG-TS', m3u8: 'HLS' }[media.format]
    || String(media.format || '').toUpperCase();
  return channel.uhd ? `${format} · UHD` : format;
}

function programmeFallback() {
  /* An event channel says what is on in its own name, which is the whole
     listing this provider gives for the PPV rows. */
  return plateText(channel.name);
}

const fmt = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function backLabel() {
  return from === 'multi' ? 'Multi-view' : 'Live TV';
}

/* ----------------------------------------------------------------- guide ── */

/** The channels worth putting in the guide and the flip list, in that order. */
function flipList(lib) {
  const items = lib.items || [];
  const byId = new Map(items.map((c) => [String(c.id), c]));
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || seen.has(String(c.id))) return;
    seen.add(String(c.id));
    out.push(c);
  };

  push(byId.get(String(channel.id)) || channel);
  for (const fav of favorites()) {
    if (fav.item && fav.item.kind === 'live') push(byId.get(String(fav.item.id)) || fav.item);
  }
  const pinned = new Set(pinnedIds('live'));
  for (const c of items) if (pinned.has(String(c.categoryId))) push(c);
  for (const c of items) {
    if (out.length >= GUIDE_ROWS) break;
    push(c);
  }
  return out.slice(0, GUIDE_ROWS);
}

function guide() {
  const wrap = el('div', 'guide');

  const head = el('div', 'guide-head');
  head.append(el('h2', null, 'GUIDE'), el('span', 'now', 'NOW'));
  head.append(el('span', 'meta', '◀ ▶ across the hours · BACK to the game'));
  wrap.append(head);

  const start = hourFloor(Date.now());
  const times = el('div', 'guide-times');
  times.append(el('span', 'spacer'));
  const cols = el('div', 'cols');
  for (let h = 0; h < GUIDE_SPAN_HOURS; h += 2) {
    const span = el('span', null, new Date(start + h * 3600000)
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    span.style.flex = '1';
    cols.append(span);
  }
  times.append(cols);
  wrap.append(times);

  const body = el('div', 'guide-body');
  const scroll = el('div', 'guide-scroll');
  scroll.dataset.scroller = 'guide';
  channels.forEach((chan, i) => scroll.append(guideRow(chan, 10 + i, start)));
  body.append(scroll);
  wrap.append(body);
  return wrap;
}

const hourFloor = (ms) => new Date(ms).setMinutes(0, 0, 0);

function guideRow(chan, r, startMs) {
  const row = el('div', 'guide-row');
  const name = el('div', 'guide-chan');
  name.append(el('span', 'guide-num', chan.num ? String(chan.num) : '—'));
  name.append(el('span', 'guide-name', chan.name));
  row.append(name);

  const listings = epg.get(String(chan.epgId || chan.id)) || [];
  const endMs = startMs + GUIDE_SPAN_HOURS * 3600000;
  const window = listings
    .filter((l) => l.stop * 1000 > startMs && l.start * 1000 < endMs)
    .sort((a, b) => a.start - b.start)
    .slice(0, 4);

  if (!window.length) {
    /* No listing is a fact about the channel, and one the viewer can still act
       on — it is a tunable cell, not a gap. */
    const cell = el('div', 'guide-cell');
    cell.style.flex = String(GUIDE_SPAN_HOURS * 60);
    cell.dataset.r = r;
    cell.dataset.c = 0;
    cell.dataset.kind = 'guidecell';
    cell.dataset.lift = 'none';
    cell._channel = chan;
    cell.append(el('span', 'guide-cell-title', plateText(chan.name)));
    cell.append(el('span', 'guide-cell-time', 'No listing — OK to tune anyway'));
    if (String(chan.id) === String(channel.id)) cell.classList.add('on');
    row.append(cell);
    return row;
  }

  const now = Date.now() / 1000;
  window.forEach((listing, c) => {
    const cell = el('div', 'guide-cell');
    /* Width is the part of the programme INSIDE the window, not its whole
       length: a game that started an hour before the window opens would
       otherwise push the rest of the row past the hour it belongs under, and
       the column headings would stop meaning anything. */
    const from = Math.max(listing.start * 1000, startMs);
    const to = Math.min(listing.stop * 1000, endMs);
    const minutes = Math.max(12, (to - from) / 60000);
    cell.style.flex = String(minutes);
    cell.dataset.r = r;
    cell.dataset.c = c;
    cell.dataset.kind = 'guidecell';
    cell.dataset.lift = 'none';
    cell._channel = chan;
    if (listing.start <= now && listing.stop > now) cell.classList.add('on');
    cell.append(el('span', 'guide-cell-title', listing.title || 'Programme'));
    cell.append(el('span', 'guide-cell-time', `${fmt(listing.start)} – ${fmt(listing.stop)}`));
    row.append(cell);
  });
  return row;
}

/* ----------------------------------------------------------- channel bar ── */

function channelBar() {
  const wrap = el('div', 'chanbar');
  const head = el('div', 'chanbar-head');
  head.append(el('h2', null, 'CHANNELS'));
  head.append(el('span', 'meta', 'Flip without leaving the picture'));
  wrap.append(head);

  const strip = el('div', 'strip');
  const inner = el('div', 'strip-inner');
  channels.forEach((chan, c) => {
    const card = el('div', 'bar-card');
    card.dataset.r = 30;
    card.dataset.c = c;
    card.dataset.kind = 'barchan';
    card.dataset.lift = 'tile';
    card._channel = chan;

    const art = el('div', 'bar-art ring');
    if (String(chan.id) === String(channel.id)) art.classList.add('on');
    const top = el('div', 'bar-top');
    top.append(el('span', 'bar-name', plateText(chan.name)));
    const listing = nowOn(epg.get(String(chan.epgId || chan.id)));
    const next = nextOn(epg.get(String(chan.epgId || chan.id)));
    const tag = el('span', 'bar-tag', listing ? 'LIVE' : (next ? fmt(next.start) : 'LIVE'));
    if (!listing && next) tag.classList.add('soon');
    top.append(tag);
    art.append(top);
    art.append(el('span', 'bar-now', listing ? listing.title : plateText(chan.name)));
    card.append(art);
    inner.append(card);
  });
  strip.append(inner);
  wrap.append(strip);
  return wrap;
}

/* -------------------------------------------------------------- playback ── */

async function open(app) {
  teardownMedia();
  app.tune({
    eyebrow: 'TUNING IN',
    name: plateText(channel.name),
    sub: nowTitle(),
    badge: { text: 'LIVE', dot: true },
    hints: [['▼', 'Guide'], ['OK', 'Channel bar'], ['BACK', backLabel()]],
  });

  let stream;
  try {
    stream = await getPlay('live', channel.id);
  } catch (err) {
    app.tuneError(plateText(channel.name), err.message);
    return;
  }

  media.format = stream.format === 'm3u8' ? 'm3u8' : (stream.format || 'ts');
  try {
    await attach(stream);
  } catch (err) {
    app.tuneError(plateText(channel.name), err.message);
    return;
  }

  app.clearTune();
  repaint();
  startedAt = Date.now();
  beginHistory();
}

async function attach(stream) {
  const video = media.video;
  if (!video) return;
  const url = stream.url;
  const isHls = media.format === 'm3u8' || /\.m3u8(\?|$)/i.test(url);

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ lowLatencyMode: false, backBufferLength: 90 });
    media.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (!isHls && window.mpegts && window.mpegts.isSupported()) {
    const feed = window.mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url },
      { enableStashBuffer: true, liveBufferLatencyChasing: true }
    );
    media.mpegts = feed;
    feed.attachMediaElement(video);
    feed.load();
  } else {
    video.src = url;
  }

  try {
    await video.play();
  } catch {
    /* A browser that will not start an unmuted stream on its own is not a
       failure to tune — start it quiet and say so. */
    video.muted = true;
    try {
      await video.play();
      if (appRef) appRef.toast('Started muted — this browser blocked sound until you interact.');
    } catch (err) {
      throw new Error(`The stream would not start: ${err.message}`);
    }
  }
}

function teardownMedia() {
  if (media.hls) { try { media.hls.destroy(); } catch { /* already gone */ } }
  if (media.mpegts) {
    try { media.mpegts.destroy(); } catch { /* already gone */ }
  }
  if (media.video) {
    try { media.video.pause(); media.video.removeAttribute('src'); media.video.load(); }
    catch { /* already gone */ }
  }
  media.hls = null;
  media.mpegts = null;
}

function nowTitle() {
  const listing = nowOn(epg.get(String(channel.epgId || channel.id)));
  return listing ? listing.title : plateText(channel.name);
}

/* --------------------------------------------------------------- history ── */

/*
 * What the box learns from this: which channels this profile actually watches.
 * A live row has no duration and can never be "finished", which the box
 * enforces too — position is time spent, and that is what feeds the affinity
 * behind the Movies and Series rows.
 */
function beginHistory() {
  clearInterval(historyTimer);
  if (!state.profile) return;
  const report = () => {
    postHistory(state.profile.id, {
      key: `live:${channel.id}`,
      kind: 'live',
      id: channel.id,
      name: channel.name,
      categoryId: channel.categoryId,
      poster: channel.logo || '',
      position: Math.round((Date.now() - startedAt) / 1000),
    }).catch(() => {});
  };
  report();
  historyTimer = setInterval(report, HISTORY_EVERY_MS);
}

/* ---------------------------------------------------------------- remote ── */

export function onKey(key, { back, ok }) {
  if (back) {
    if (overlay) { overlay = null; repaint(); return true; }
    return false; // let the shell run our back()
  }
  if (ok && !overlay) {
    overlay = 'bar';
    repaint();
    return true;
  }
  if (key === 'ArrowDown' && !overlay) {
    overlay = 'guide';
    repaint();
    return true;
  }
  if (key === 'ArrowUp' && overlay === 'bar') {
    overlay = null;
    repaint();
    return true;
  }
  return false;
}

export function activate(node, app) {
  const next = node._channel;
  if (!next) return;
  if (String(next.id) === String(channel.id)) {
    overlay = null;
    repaint();
    return;
  }
  channel = next;
  overlay = null;
  game = matchGame(channel);
  open(app);
}

export function back(app) {
  app.go(from === 'multi' ? 'multi' : 'live');
  return true;
}

/** BACK on a channel that would not open leaves rather than sitting there. */
export function tuneDismissed() {
  if (appRef) appRef.go(from === 'multi' ? 'multi' : 'live');
}

export function leave() {
  clearInterval(historyTimer);
  historyTimer = null;
  teardownMedia();
  overlay = null;
}

/* --------------------------------------------------------------- scores ── */

let slate = [];
getGames().then((games) => { slate = games; });

/** Which placeholder game, if any, belongs to the channel now on screen. */
function matchGame(chan) {
  if (!usingPlaceholders() && !slate.length) return null;
  return slate.find((g) => {
    const matched = matchChannel(g, [chan]);
    return Boolean(matched);
  }) || null;
}
