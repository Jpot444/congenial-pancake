/*
 * The player, and the two things that open on top of it.
 *
 * Full-bleed picture and one line of chrome across the bottom — nothing else
 * over the frame, because the broadcast already has its own score bug and its
 * own corner logo. From there:
 *   ▼    the guide — the CATEGORY this channel belongs to, channel × time,
 *        the programme on now in brand crimson, scrolling in its own container
 *        so the page never moves under it, and a way into multi-view from
 *        inside the schedule
 *   OK   the channel bar — flip channels without leaving the picture
 *   BACK closes whichever is open, then leaves the player
 *
 * Playback is the portal's: /api/play hands back either an MPEG-TS URL for
 * mpegts.js or the Pi's own HLS window for hls.js. Both are on the page from
 * the CDN, exactly as the browser portal loads them; with neither, the <video>
 * element is given the URL and does what it can.
 */

import { el, clear, plateText, cleanName, icon } from '../ui.js';
import { focus } from '../focus.js';
import { getPlay, postHistory } from '../api.js';
import { state, loadLibrary, loadEpg, nowOn, nextOn, airProgress, favorites, pinnedIds }
  from '../state.js';
import { getGames, matchChannel } from '../scores.js';

export const fullbleed = true;

const GUIDE_ROWS = 12;
/* How many channels of a category the guide will put on screen at once. Every
   row is a channel the box may have to ask the provider about, and it allows
   one connection — so this is a window on the category, centred on what is
   being watched, rather than the whole of it. */
const GUIDE_ROWS_MAX = 24;
const GUIDE_SPAN_HOURS = 6;
const HISTORY_EVERY_MS = 30000;

/*
 * How a live channel is seated, copied from the browser portal because these
 * are the numbers that measured well against THIS provider rather than good
 * defaults in general: it publishes about 60 seconds of playlist, so joining
 * roughly half of it back leaves room to hold a cushion without the segment
 * under the playhead expiring. The chaser is parked out of reach on purpose —
 * a stream that keeps playing while running a little late has nothing wrong
 * with it. The Pi's own DVR window is longer, so a channel coming through it
 * sits further back again.
 */
const LIVE_HLS = {
  lowLatencyMode: false,
  liveSyncDuration: 32,
  liveMaxLatencyDuration: 600,
  maxBufferLength: 45,
  maxMaxBufferLength: 90,
  backBufferLength: 60,
  subtitleDisplay: false,
};
const LIVE_DVR_SEAT = 45;

/** How long a tuned channel may show nothing before the app admits it. */
const PICTURE_BY_MS = 15000;

/** How far ahead "soon" reaches on the suggestions panel, and how long after
    kickoff a game the slate still calls upcoming is worth offering. */
const SOON_MS = 3 * 3600e3;
const LATE_MS = 45 * 60e3;

let channel = null;
let from = 'live';
let overlay = null;          // null | 'guide' | 'bar' | 'suggest'
/* The slate, asked for in the background while the channel tunes. ▼ needs it
   to know whether what is on screen is a game — and a press that had to wait
   on a fetch would be a press that did nothing for a second, so a slate that
   has not arrived yet simply means ▼ opens the guide, as it always did. */
let slate = [];
let liveChannels = [];
let media = { video: null, hls: null, mpegts: null };
let channels = [];
let guideChannels = [];
let epg = new Map();
let historyTimer = null;
let edgeTimer = null;
let scrimLive = null;
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
  liveChannels = lib.items || [];
  channels = flipList(lib);
  guideChannels = guideList(lib);
  /* Started, not awaited — see the note by `slate`. */
  getGames().then((games) => { slate = games || []; }).catch(() => { slate = []; });
  /* One call for both lists — the guide's category and the bar's flip list
     overlap heavily, and asking twice would spend the one connection twice. */
  epg = await loadEpg(
    [...guideChannels, ...channels].map((c) => String(c.epgId || c.id))
  );

  paint();
  await open(app);
}

function paint() {
  const root = el('div', 'player');
  root.append(videoNode());

  if (!overlay) root.append(scrim());
  if (overlay === 'guide') root.append(guide());
  if (overlay === 'bar') root.append(channelBar());
  if (overlay === 'suggest') root.append(suggestions());

  clear(host).append(root);
}

/**
 * ONE video element for the whole sitting, made once and moved from paint to
 * paint.
 *
 * Every overlay on this screen — the guide, the channel bar, the bare picture —
 * is a repaint, and a repaint that built a fresh <video> would leave hls.js
 * feeding an element that is no longer on the page: chrome that looks right
 * over a picture that never arrives. Tuning itself ends in a repaint, so that
 * was every channel, every time.
 *
 * Moving the element is safe where rebuilding it is not. A media element is
 * only paused for being removed from the document if it is STILL out of it
 * when the browser next reaches a stable state, and paint() takes it out and
 * puts it back inside one task — so playback carries straight across.
 */
function videoNode() {
  if (media.video) return media.video;
  const video = el('video');
  video.setAttribute('playsinline', '');
  video.autoplay = true;
  media.video = video;
  return video;
}

/**
 * Repaint and put the cursor where the new state expects it: the top of the
 * guide, the current channel in the bar, nowhere at all with the picture bare.
 */
function repaint() {
  paint();
  if (overlay === 'guide') {
    /* Open on the channel being watched rather than at the top of the
       category: in a pack of two hundred, row one is not where you are. */
    const at = guideChannels.findIndex((c) => String(c.id) === String(channel.id));
    focus.reset(10 + Math.max(0, at), 0);
  }
  else if (overlay === 'bar') {
    focus.reset(30, Math.max(0, channels.findIndex((c) => String(c.id) === String(channel.id))));
  }
  /* The first game, not the guide button above it: the list is what ▼ was
     pressed for, and landing on the way out of it would be backwards. */
  else if (overlay === 'suggest') focus.reset(40, 0);
  else focus.reset(-1, 0);
  focus.collect();
  focus.apply();
}

/*
 * There is no score bug on this screen.
 *
 * There was: teams and the inning, over the top-left corner of the picture,
 * for the whole time the game was on. Every broadcast already carries its own
 * — networks have put one there for thirty years — so ours sat next to
 * theirs saying the same thing in a different typeface, on the one part of
 * the frame a director can be relied on to keep clear. The scores live on the
 * Live TV row, which is where you are when you are choosing what to watch;
 * once the game is on, the game is on.
 */

/** The bottom line: what this is, what is on, and how far through it is. */
function scrim() {
  const wrap = el('div', 'player-scrim');
  const row = el('div', 'scrim-row');
  const left = el('div');
  left.style.minWidth = '0';

  const line = el('div', 'now-line');
  const liveTag = el('span', 'now-live');
  liveTag.append(el('span', 'live-dot'), 'LIVE');
  /* Repainted by the behind-live watch below, which is the only thing on this
     screen that keeps its own timer while the picture is up. */
  scrimLive = liveTag;
  line.append(liveTag, el('span', 'now-chan', cleanName(channel.name)));
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
  /* ▼ does a different thing on a game, and the line has to say which — a hint
     that names the guide and opens something else is worse than no hint. */
  for (const [key, label] of [['▲', 'Jump to live'],
    ['▼', watchingAGame() ? 'Other games' : 'Guide'], ['OK', 'Channels'],
    ['BACK', backLabel()]]) {
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

/* ----------------------------------------------------- the other games ── */

/*
 * ▼ on a game.
 *
 * Pressing down while a game is on is almost never "show me this category's
 * schedule" — it is "what else is on". So on a game it opens the other games,
 * down the right-hand side, and on anything else it opens the guide exactly as
 * before. The guide is one press away from inside the panel, because a rule
 * this confident about intent has to leave the old road open.
 *
 * OK on a row goes to multi-view with this game and that one already seated,
 * which is the thing being asked for: both at once, not a channel change.
 */

/** Is the channel on screen carrying a game the slate knows about? */
function watchingAGame() {
  return Boolean(slate.find((game) => matchChannel(game, [channel])));
}

/**
 * The games worth offering. Live first, then by how soon they start, with
 * anything that has no channel behind it left out — a row that opens nothing
 * is worse than a shorter list.
 */
function otherGames() {
  const now = Date.now();
  const out = [];
  const seen = new Set([String(channel.id)]);
  for (const game of slate) {
    if (game.status === 'final') continue;
    if (game.status !== 'live') {
      const at = Number(game.kickoff) || 0;
      if (!at || at - now > SOON_MS || now - at > LATE_MS) continue;
    }
    const chan = matchChannel(game, liveChannels);
    if (!chan || seen.has(String(chan.id))) continue;
    seen.add(String(chan.id));
    out.push({ game, channel: chan });
  }
  out.sort((a, b) => (a.game.status === 'live' ? 0 : 1) - (b.game.status === 'live' ? 0 : 1)
    || (Number(a.game.kickoff) || 0) - (Number(b.game.kickoff) || 0));
  return out;
}

function gameWhen(game) {
  if (game.redZone) return game.note || 'Whip-around';
  if (game.status === 'live') return game.clock || 'LIVE';
  const at = Number(game.kickoff) || 0;
  if (!at) return game.clock || 'Soon';
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return 'Starting now';
  if (mins < 60) return `In ${mins} min`;
  return fmt(at / 1000);
}

function teamMark(team) {
  const box = el('div', 'sg-mark');
  if (team && team.logo) {
    const badge = el('img');
    badge.src = `/img?u=${encodeURIComponent(team.logo)}`;
    badge.alt = team.abbr || '';
    /* A mark that will not load leaves the abbreviation rather than a broken
       picture: the league's server is not this box's to promise. */
    badge.addEventListener('error', () => { badge.remove(); box.classList.add('no-mark'); });
    box.append(badge);
  } else box.classList.add('no-mark');
  box.append(el('span', 'sg-abbr', team ? (team.abbr || '') : ''));
  return box;
}

function suggestions() {
  const wrap = el('div', 'suggest');

  const head = el('div', 'suggest-head');
  head.append(el('h2', null, 'OTHER GAMES'));
  head.append(el('span', 'meta', 'OK for both at once · BACK to the game'));

  /* Row 39 sits above the list, so ▲ from the first game lands on it. */
  const toGuide = el('button', 'suggest-guide ring');
  toGuide.dataset.r = 39;
  toGuide.dataset.c = 0;
  toGuide.dataset.kind = 'suggestguide';
  toGuide.dataset.lift = 'pill';
  toGuide.append(el('span', null, 'FULL GUIDE'));
  head.append(toGuide);
  wrap.append(head);

  const rows = otherGames();
  const body = el('div', 'suggest-body');
  body.dataset.scroller = 'suggest';

  if (!rows.length) {
    /* Two different empties, and they look identical from the sofa unless this
       says which: nothing else is being played, or nothing that is being
       played is on a channel this provider carries. */
    body.append(el('p', 'suggest-none',
      'Nothing else on right now that this provider carries. ▲ for the guide.'));
    wrap.append(body);
    return wrap;
  }

  rows.forEach(({ game, channel: chan }, i) => {
    const row = el('div', 'suggest-row ring');
    row.dataset.r = 40 + i;
    row.dataset.c = 0;
    row.dataset.kind = 'suggestgame';
    row.dataset.lift = 'none';
    row._channel = chan;
    if (game.status === 'live') row.classList.add('on');

    const marks = el('div', 'sg-marks');
    if (game.away || game.home) {
      marks.append(teamMark(game.away), el('span', 'sg-vs'), teamMark(game.home));
    } else {
      marks.classList.add('single');
      marks.append(teamMark({ abbr: game.channelMatch || 'LIVE', logo: '' }));
    }
    row.append(marks);

    const copy = el('div', 'sg-copy');
    copy.append(el('span', 'sg-title', game.away && game.home
      ? `${game.away.abbr} at ${game.home.abbr}`
      : (game.note || game.channelName || plateText(chan.name))));

    const line = el('div', 'sg-line');
    line.append(el('span', 'sg-when', gameWhen(game)));
    if (game.status === 'live' && game.away && game.home
        && game.away.score !== null && game.home.score !== null) {
      line.append(el('span', 'sg-score', `${game.away.score}–${game.home.score}`));
    }
    copy.append(line);
    copy.append(el('span', 'sg-chan', plateText(chan.name)));
    row.append(copy);
    body.append(row);
  });

  wrap.append(body);
  return wrap;
}

/* ----------------------------------------------------------------- guide ── */

/**
 * What the guide lists: the category the channel on screen belongs to.
 *
 * A guide is a schedule for a group of channels that belong together, and on
 * this provider that group is the category — the sports pack, the locals, the
 * movie channels. It used to list the flip list instead (this channel, then
 * favourites, then pinned categories, then whatever came next), which is a
 * good order to press CHANNEL UP through and a poor thing to read a schedule
 * off: pressing ▼ while watching a game showed the news channels somebody
 * hearted last week.
 *
 * In the provider's own order, which is channel-number order, so it reads the
 * way a guide has always read. A channel with no category at all — an event
 * row, mostly — falls back to the flip list rather than showing one row.
 */
function guideList(lib) {
  const items = lib.items || [];
  const category = String(channel.categoryId ?? '');
  if (!category) return flipList(lib);

  const inCategory = items.filter((c) => String(c.categoryId) === category);
  if (inCategory.length < 2) return flipList(lib);

  /* Capped because every row is a channel the box may have to ask the
     provider about, and it allows one connection. The channel being watched
     is always in the window, even in a category of three hundred. */
  const at = inCategory.findIndex((c) => String(c.id) === String(channel.id));
  if (inCategory.length <= GUIDE_ROWS_MAX || at < 0) return inCategory.slice(0, GUIDE_ROWS_MAX);
  const from = Math.min(
    Math.max(0, at - Math.floor(GUIDE_ROWS_MAX / 2)),
    inCategory.length - GUIDE_ROWS_MAX
  );
  return inCategory.slice(from, from + GUIDE_ROWS_MAX);
}

/** What the guide calls itself: the category, or the honest fallback. */
function guideTitle() {
  const category = (state.library.live && state.library.live.categories || [])
    .find((c) => String(c.id) === String(channel.categoryId));
  return category ? cleanName(category.name).toUpperCase() : 'GUIDE';
}

/** The channels worth putting in the flip list, in that order. */
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
  head.append(el('h2', null, guideTitle()), el('span', 'now', 'NOW'));
  head.append(el('span', 'meta', '◀ ▶ across the hours · BACK to the game'));

  /* Four of these channels at once, from the guide, without going back out to
     Live TV first. Row 9 puts it directly above the first guide row, so ▲ from
     the top of the schedule lands on it. */
  const quad = el('button', 'guide-mv ring');
  quad.dataset.r = 9;
  quad.dataset.c = 0;
  quad.dataset.kind = 'guidemulti';
  quad.dataset.lift = 'pill';
  quad.append(icon('multiview', 26), el('span', null, 'MULTI-VIEW'));

  /* The same thing ▲ does on the bare picture, as a button, because the guide
     is where you are when you notice the game is behind. */
  const live = el('button', 'guide-mv ring');
  live.dataset.r = 9;
  live.dataset.c = 1;
  live.dataset.kind = 'guidelive';
  live.dataset.lift = 'pill';
  live.append(el('span', 'live-dot'), el('span', null, 'JUMP TO LIVE'));

  head.append(quad, live);
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
  guideChannels.forEach((chan, i) => scroll.append(guideRow(chan, 10 + i, start)));
  body.append(scroll);
  wrap.append(body);
  return wrap;
}

const hourFloor = (ms) => new Date(ms).setMinutes(0, 0, 0);

function guideRow(chan, r, startMs) {
  const row = el('div', 'guide-row');
  const name = el('div', 'guide-chan');
  name.append(el('span', 'guide-num', chan.num ? String(chan.num) : '—'));
  name.append(el('span', 'guide-name', cleanName(chan.name)));
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
  clearInterval(edgeTimer);
  edgeTimer = setInterval(paintLiveTag, 2000);
}

async function attach(stream) {
  const video = videoNode();
  const url = stream.url;
  const isHls = media.format === 'm3u8' || /\.m3u8(\?|$)/i.test(url);

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      ...LIVE_HLS,
      ...(stream.dvr ? { liveSyncDuration: LIVE_DVR_SEAT } : {}),
    });
    media.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    /* A live playlist drops segments as it advances, so a fumble is ordinary
       rather than terminal: pick the load back up where the portal does, and
       only say something when neither recovery applies. */
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else stalled(`Playback failed — ${data.details}`);
    });
  } else if (!isHls && window.mpegts && window.mpegts.isSupported()) {
    const feed = window.mpegts.createPlayer(
      /* mpegts.js fetches inside a Web Worker, which has no document base URL:
         the box's own "/api/proxy?…" is a URL the worker cannot parse. */
      { type: 'mpegts', isLive: true, url: new URL(url, location.href).href },
      {
        enableWorker: true,
        // This provider delivers in lumpy 4-5s chunks and mpegts.js's chaser
        // fires above 1.5s of buffer, so left on it seeks on every lump.
        liveBufferLatencyChasing: false,
        enableStashBuffer: false,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 10,
      }
    );
    media.mpegts = feed;
    feed.attachMediaElement(video);
    feed.load();
    feed.on(window.mpegts.Events.ERROR, (type, detail) => stalled(`${type}: ${detail}`));
  } else {
    video.src = url;
  }
  watchForPicture(video);

  /* Started, not awaited. A live element's play() promise settles when frames
     actually arrive, which on a channel that is buffering is seconds away and
     on a channel that is never coming is never — and everything after this
     call is what takes the TUNING IN card down and puts the picture up. The
     watchdog above is what notices a channel that does not arrive; this only
     has to ask. */
  const start = video.play();
  if (start && start.catch) {
    start.catch(() => {
      /* A browser that will not start an unmuted stream on its own is not a
         failure to tune — start it quiet and say so. */
      video.muted = true;
      video.play().then(
        () => {
          if (appRef) appRef.toast('Started muted — this browser blocked sound until you interact.');
        },
        (err) => stalled(`the browser would not start it — ${err.message}`)
      );
    });
  }
}

/* ------------------------------------------------------------- live edge ── */

/*
 * Getting back to the live edge, and knowing when you are not on it.
 *
 * A live channel here is not a stream you join at the end — it is a window.
 * The Pi republishes about two minutes of it so a stall has somewhere to
 * recover into, and a player that buffers, or that picks a channel back up
 * while the box's window is still running, can end up sitting inside that
 * window rather than at its edge: watching two minutes ago. Nothing looks
 * wrong when that happens, which is exactly why it needs saying — the tag
 * reads BEHIND with the delay on it, and ▲ takes you to the edge.
 */
const BEHIND_BY_S = 12;

/**
 * How far behind live the playhead is, in seconds. 0 when unknowable.
 *
 * Measured against the SEAT, not against the last byte the box has written.
 * This player deliberately sits about forty-five seconds back in the Pi's own
 * window — that is the cushion that stops a fumble becoming a stall — so
 * measuring from the raw edge would report the design as a fault and leave
 * the tag reading BEHIND 45s for ever, including immediately after a jump.
 * What is worth reporting is the delay ON TOP of the seat.
 */
function behindBy() {
  const video = media.video;
  if (!video) return 0;
  const ranges = video.seekable && video.seekable.length ? video.seekable : video.buffered;
  if (!ranges || !ranges.length) return 0;
  const edge = ranges.end(ranges.length - 1);
  if (!Number.isFinite(edge)) return 0;
  const seat = media.hls && Number.isFinite(media.hls.liveSyncPosition)
    ? Math.max(0, edge - media.hls.liveSyncPosition)
    : 0;
  return Math.max(0, edge - video.currentTime - seat);
}

/** Put the playhead back on the live edge, whichever engine is carrying it. */
export function jumpToLive() {
  const video = media.video;
  if (!video) return;
  const behind = behindBy();

  if (media.hls && Number.isFinite(media.hls.liveSyncPosition)) {
    /* hls.js knows where its own seat is — the edge less the distance this
       player joins at — and going there rather than to the very end keeps the
       cushion that stops the next fumble becoming a stall. */
    video.currentTime = media.hls.liveSyncPosition;
  } else {
    const ranges = video.seekable && video.seekable.length ? video.seekable : video.buffered;
    if (ranges && ranges.length) video.currentTime = Math.max(0, ranges.end(ranges.length - 1) - 1);
  }
  video.play().catch(() => {});
  if (appRef) {
    appRef.toast(behind > BEHIND_BY_S
      ? `Back to live — you were ${Math.round(behind)}s behind.`
      : 'Back to live.');
  }
  paintLiveTag();
}

/** LIVE, or BEHIND with the number on it. */
function paintLiveTag() {
  if (!scrimLive || !scrimLive.isConnected) return;
  const behind = behindBy();
  const late = behind > BEHIND_BY_S;
  scrimLive.classList.toggle('behind', late);
  clear(scrimLive);
  scrimLive.append(el('span', 'live-dot'));
  scrimLive.append(late ? `BEHIND ${Math.round(behind)}s` : 'LIVE');
}

/**
 * Say so, once, when a channel is not coming.
 *
 * Neither engine throws at the point of attachment — an HLS playlist that
 * 404s, a TS feed the provider refuses because the one connection is already
 * spent, a codec the box will not decode all fail later and silently, leaving
 * chrome over a black rectangle for as long as the viewer is willing to sit
 * there. The screen is never taken away for this: a channel that recovers on
 * its own has recovered, and the toast is gone by then anyway.
 */
function stalled(detail) {
  if (media.said) return;
  media.said = true;
  if (appRef) appRef.toast(`${plateText(channel.name)} is not coming through — ${detail}`);
}

/** No picture within the watchdog is a fact worth reporting too. */
function watchForPicture(video) {
  clearTimeout(media.watchdog);
  const started = () => {
    clearTimeout(media.watchdog);
    media.said = false;
  };
  video.addEventListener('playing', started, { once: true });
  media.watchdog = setTimeout(() => {
    if (video.readyState < 3) {
      stalled('no picture yet. OK for another channel, BACK to leave.');
    }
  }, PICTURE_BY_MS);
}

function teardownMedia() {
  clearTimeout(media.watchdog);
  media.watchdog = null;
  media.said = false;
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
    /* On a game, the other games; on anything else, the guide. See the note
       above suggestions(). */
    overlay = watchingAGame() ? 'suggest' : 'guide';
    repaint();
    return true;
  }
  /* ▼ again out of the suggestions is the guide — the panel replaced it on
     this press, so the second press has to be able to get back to it. */
  if (key === 'ArrowDown' && overlay === 'suggest') {
    overlay = 'guide';
    repaint();
    return true;
  }
  /* Nothing above the bare picture to move to, so ▲ is the one key on this
     screen with nothing to do — and getting back to the edge is the thing
     most worth a single press. */
  if (key === 'ArrowUp' && !overlay) {
    jumpToLive();
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
  /* Four at once, straight from the schedule. The shell calls leave() on the
     way out, which is what stops this channel before multi-view opens its
     own — the provider allows one connection and would refuse the rest. */
  if (node.dataset.kind === 'guidemulti') {
    overlay = null;
    app.go('multi');
    return;
  }

  /* Both at once. The shell calls leave() on the way out, which stops this
     channel before multi-view opens its own — the provider allows one
     connection and would refuse the rest. The two are handed over as a seed
     so multi-view opens on the pair that was asked for rather than on its own
     idea of the four best. */
  if (node.dataset.kind === 'suggestgame') {
    const pick = node._channel;
    overlay = null;
    app.go('multi', { seed: pick ? [channel, pick] : [channel] });
    return;
  }

  if (node.dataset.kind === 'suggestguide') {
    overlay = 'guide';
    repaint();
    return;
  }

  if (node.dataset.kind === 'guidelive') {
    jumpToLive();
    overlay = null;
    repaint();
    return;
  }

  const next = node._channel;
  if (!next) return;
  if (String(next.id) === String(channel.id)) {
    overlay = null;
    repaint();
    return;
  }
  channel = next;
  overlay = null;
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
  clearInterval(edgeTimer);
  edgeTimer = null;
  scrimLive = null;
  teardownMedia();
  overlay = null;
}
