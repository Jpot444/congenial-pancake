/*
 * Live TV — the screen this app exists for.
 *
 * Three rows, in the order a Sunday actually goes:
 *   1  the games, biggest cards on the screen, one per broadcast
 *   2  channels — favourites first, then whatever the pinned categories hold
 *   3  categories, pinned first
 *
 * The game row is the only thing here that is not real. Scores, quarter and
 * clock come from js/scores.js, which is placeholder text until a feed exists;
 * the CHANNEL each card tunes, and the broadcast progress bar, are real — the
 * card matches itself to a channel in the live library and takes its progress
 * from that channel's EPG.
 */

import { el, clear, cleanName } from '../ui.js';
import { loadLibrary, loadEpg, nowOn, airProgress, favorites, pinnedIds, pinnedFirst, state }
  from '../state.js';
import { getGames, usingPlaceholders, matchChannel, slateTrouble, slateSource }
  from '../scores.js';
import { channelCard, categoryCard, allCategoriesCard, rowHead, strip, rowBlock } from './cards.js';

const CHANNELS_IN_ROW = 14;
const CATS_PER_GRID_ROW = 8;
/* Five 320px cards and four 24px gaps is 1,696 of the 1,792 the stage leaves
   between its margins — the widest a channel grid goes without reflowing. */
const CHANS_PER_GRID_ROW = 5;
/* A baseball evening is fifteen games; a football Sunday is thirteen and a
   whip-around. The row is what is ON, so it runs live first, then what is
   about to start, and finals bring up the rear. */
const GAMES_IN_ROW = 16;
const SLATE_ORDER = { live: 0, upcoming: 1, final: 2 };

let view = { games: [], channels: [], categories: [], epg: new Map(), lib: null };
/** What row 2 is showing: favourites and pins, or one chosen category. */
let channelSource = null;
let catsExpanded = false;

export async function render(host, app) {
  const lib = await loadLibrary('live');
  view.lib = lib;

  /* A chosen category is a screen of its own, not a row inside this one. It
     used to swap the contents of row 2 and leave the games above it and the
     category tiles below, so opening a category showed a strip of it and then
     a list of all the others — which is neither the category nor the list. */
  if (channelSource) return renderCategory(host);

  const [games] = await Promise.all([getGames()]);
  view.games = [...games]
    .sort((a, b) => (SLATE_ORDER[a.status] ?? 3) - (SLATE_ORDER[b.status] ?? 3)
      || (a.kickoff || 0) - (b.kickoff || 0))
    .slice(0, GAMES_IN_ROW);

  view.categories = pinnedFirst(lib.categories || [], 'live');
  view.channels = channelsForRow(lib);

  /* One EPG call for everything on screen: the channels in row 2 and whatever
     channels the game cards matched. The box answers for six unseen channels
     at a time, so the rest fill in on the next visit rather than queueing
     forty provider calls behind whatever is playing. */
  const matched = view.games.map((g) => matchChannel(g, lib.items || [])).filter(Boolean);
  const ids = [...view.channels, ...matched].map((c) => String(c.epgId || c.id));
  view.epg = await loadEpg(ids);

  const root = el('div', 'screen');
  root.append(gameRow(app));
  root.append(channelRow());
  root.append(categoryRow());
  if (state.errors.live) {
    root.append(el('div', 'empty', `The live library did not load: ${state.errors.live}`));
  }
  clear(host).append(root);
}

/* -------------------------------------------------------- one category ── */

/**
 * Everything in one category, as a grid.
 *
 * Row numbers start at 1 and go up one per line of the grid, so ▲▼ moves a
 * line at a time and the page scrolls with it — the same thing every other
 * screen does, since each line is an ordinary rowblock.
 */
async function renderCategory(host) {
  const channels = (view.lib.items || [])
    .filter((c) => String(c.categoryId) === String(channelSource.id));
  view.channels = channels;

  /* The guide is asked about what is on screen first; the box answers for a
     few unseen channels per call by design, so the rest fill in on the way
     back rather than queueing hundreds of provider calls. */
  view.epg = await loadEpg(channels.slice(0, 40).map((c) => String(c.epgId || c.id)));

  const root = el('div', 'screen');

  const head = el('div', 'rowhead');
  const title = el('h2', null, cleanName(channelSource.name).toUpperCase());
  head.append(title);
  head.append(el('span', 'meta',
    `${channels.length} channel${channels.length === 1 ? '' : 's'} · BACK for all categories`));
  root.append(head);

  if (!channels.length) {
    root.append(el('div', 'empty', 'No channels in this category.'));
    clear(host).append(root);
    return;
  }

  for (let i = 0; i < channels.length; i += CHANS_PER_GRID_ROW) {
    const r = 1 + i / CHANS_PER_GRID_ROW;
    const cards = channels.slice(i, i + CHANS_PER_GRID_ROW).map((channel, c) => {
      const listing = nowOn(view.epg.get(String(channel.epgId || channel.id)));
      return channelCard(channel, { r, c, now: listing ? listing.title : '' });
    });
    const block = el('div', 'rowblock');
    block.append(strip(cards));
    root.append(block);
  }

  clear(host).append(root);
}

/* ------------------------------------------------------------- the games ── */

function gameRow(app) {
  const liveCount = view.games.filter((g) => g.status === 'live' && !g.redZone).length;
  const whip = view.games.filter((g) => g.redZone).length;
  const meta = usingPlaceholders()
    ? 'Scores are placeholder — no feed connected'
    : `${liveCount} game${liveCount === 1 ? '' : 's'}${whip ? ` · ${whip} whip-around` : ''}`;

  const head = rowHead('LIVE NOW', {
    label: labelForSlate(),
    meta,
    size: 'big',
  });

  /* An empty row means one of two entirely different things — nothing is on,
     or nobody could be asked — and from ten feet away they look identical.
     Say which, and name the door that was knocked on, because the next
     question after "why is it empty" is always "where does it even come
     from". */
  if (!view.games.length) {
    const why = slateTrouble();
    /* The whole address, not the path. A line that says to open '/api/scores'
       is asking somebody standing in their living room to work out what to put
       in front of it. */
    const where = `${location.origin}${slateSource()}`;
    return rowBlock(head, el('div', 'empty', why
      ? `No scores: ${why}. Type ${where} into a browser for the full report.`
      : `No games on the slate right now — the feed answered, with nothing on it. ${where} shows what it was asked.`));
  }

  const cards = view.games.map((game, i) => gameCard(game, i));
  return rowBlock(head, strip(cards, { wide: true }));
}

function labelForSlate() {
  const day = new Date().toLocaleDateString([], { weekday: 'long' });
  return day.toUpperCase();
}

function gameCard(game, c) {
  const channel = matchChannel(game, view.lib.items || []);
  const card = el('div', 'game');
  card.dataset.r = 1;
  card.dataset.c = c;
  card.dataset.kind = 'game';
  card.dataset.name = channel ? channel.name : game.channelName;
  card._game = game;
  card._channel = channel;

  if (game.redZone) card.classList.add('redzone');
  if (game.status === 'upcoming') card.classList.add('upcoming');
  card.classList.add('ring');

  card.append(gameTop(game, channel));
  card.append(game.redZone ? redZoneBody(game) : gameBody(game));
  card.append(gameFoot(game, channel));
  return card;
}

function gameTop(game, channel) {
  const top = el('div', 'game-top');
  const name = el('span', 'game-chan');
  name.append(cleanName(channel ? channel.name : game.channelName));
  if (channel && channel.uhd) name.append(el('span', 'hd', ' UHD'));
  top.append(name);

  if (game.status === 'upcoming') {
    top.append(el('span', 'game-time', game.clock || ''));
  } else if (game.status === 'final') {
    /* A game that is over is not live, and a red dot saying it is turns the
       whole row into a thing you cannot trust. */
    top.append(el('span', 'game-time', 'FINAL'));
  } else {
    const tag = el('span', 'live-tag');
    tag.append(el('span', 'live-dot'), 'LIVE');
    top.append(tag);
  }
  return top;
}

function gameBody(game) {
  if (game.status === 'upcoming') {
    const body = el('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '10px';
    const matchup = el('div', 'upcoming-matchup');
    matchup.append(game.away ? game.away.abbr : '', ' ');
    matchup.append(el('span', 'at', 'at'));
    matchup.append(' ', game.home ? game.home.abbr : '');
    body.append(matchup, el('div', 'upcoming-label', game.note || ''));
    return body;
  }

  const teams = el('div', 'teams');
  for (const side of ['away', 'home']) {
    const team = game[side];
    if (!team) continue;
    const row = el('div', 'team');
    const leading = otherScore(game, side) === null || team.score >= otherScore(game, side);
    if (!leading) row.classList.add('behind');
    row.append(el('span', `poss${team.possession ? ' on' : ''}`));
    row.append(el('span', 'team-abbr', team.abbr));
    row.append(el('span', 'team-rec', team.record || ''));
    row.append(el('span', 'team-score', team.score === null ? '—' : team.score));
    teams.append(row);
  }
  return teams;
}

function otherScore(game, side) {
  const other = side === 'away' ? game.home : game.away;
  return other && Number.isFinite(other.score) ? other.score : null;
}

function redZoneBody(game) {
  const body = el('div');
  body.append(el('div', 'redzone-title', 'RED ZONE'));
  body.append(el('div', 'redzone-sub', 'EVERY TOUCHDOWN · NO ADS'));
  return body;
}

/**
 * The foot of the card: quarter and clock (placeholder), the situation line,
 * and the broadcast progress bar — which is REAL when the card found its
 * channel, because it comes from the EPG programme that is on now.
 */
function gameFoot(game, channel) {
  if (game.redZone) {
    const foot = el('div', 'redzone-foot');
    foot.append(el('span', null, game.note || ''), el('span', 'situation', game.situation || ''));
    return foot;
  }
  if (game.status === 'upcoming') {
    const foot = el('div', 'upcoming-foot');
    foot.append(el('span', 'countdown', kickoffNote(game)));
    foot.append(el('span', 'situation', channel ? 'OK to tune' : 'No channel matched'));
    return foot;
  }

  const wrap = el('div');
  const line = el('div', 'game-clockline');
  line.append(el('span', 'game-clock', game.clock || ''));
  line.append(el('span', 'situation', channel ? game.situation : 'No channel matched'));
  wrap.append(line);

  const listing = channel ? nowOn(view.epg.get(String(channel.epgId || channel.id))) : null;
  const progress = listing ? airProgress(listing) : (game.progress ?? 0);
  const track = el('div', 'bar');
  const fill = el('span');
  fill.style.width = `${progress}%`;
  track.append(fill);
  wrap.append(track);
  return wrap;
}

function kickoffNote(game) {
  /* Baseball does not kick off. One word, taken from the sport the game came
     with rather than from the one this row was first written for. */
  const start = game.sport === 'mlb' ? 'First pitch' : 'Kicks off';
  if (!game.kickoff) return game.clock ? `${start} ${game.clock}` : 'Later today';
  const mins = Math.round((game.kickoff - Date.now()) / 60000);
  if (mins <= 0) return 'Starting now';
  if (mins < 60) return `${start} in ${mins} min`;
  return `${start} at ${new Date(game.kickoff).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/* ---------------------------------------------------------- the channels ── */

/**
 * Row 2 is "the channels I actually use": hearted channels first, then the
 * contents of whatever categories are pinned, then — for a box that has never
 * been set up — simply the top of the live list, so the row is never empty.
 */
function channelsForRow(lib) {
  if (channelSource) {
    return (lib.items || []).filter((c) => String(c.categoryId) === String(channelSource.id));
  }
  const items = lib.items || [];
  const byId = new Map(items.map((c) => [String(c.id), c]));
  const out = [];
  const seen = new Set();

  for (const fav of favorites()) {
    if (!fav.item || fav.item.kind !== 'live') continue;
    const real = byId.get(String(fav.item.id)) || fav.item;
    if (seen.has(String(real.id))) continue;
    seen.add(String(real.id));
    out.push(real);
  }

  const pinned = new Set(pinnedIds('live'));
  for (const channel of items) {
    if (out.length >= CHANNELS_IN_ROW) break;
    if (!pinned.has(String(channel.categoryId))) continue;
    if (seen.has(String(channel.id))) continue;
    seen.add(String(channel.id));
    out.push(channel);
  }

  for (const channel of items) {
    if (out.length >= CHANNELS_IN_ROW) break;
    if (seen.has(String(channel.id))) continue;
    seen.add(String(channel.id));
    out.push(channel);
  }
  return out.slice(0, CHANNELS_IN_ROW);
}

function channelRow() {
  const title = channelSource ? channelSource.name.toUpperCase() : 'MY CHANNELS';
  const meta = channelSource
    ? `${view.channels.length} channels · BACK for my channels`
    : (favorites().some((f) => f.item && f.item.kind === 'live')
      ? 'Hearted from the player, then pinned categories'
      : 'Pin categories or heart a channel to fill this row');
  const head = rowHead(title, { meta });

  if (!view.channels.length) {
    return rowBlock(head, el('div', 'empty', 'No channels in this category.'));
  }
  const cards = view.channels.map((channel, c) => {
    const listing = nowOn(view.epg.get(String(channel.epgId || channel.id)));
    return channelCard(channel, { r: 2, c, now: listing ? listing.title : '' });
  });
  return rowBlock(head, strip(cards));
}

/* -------------------------------------------------------- the categories ── */

function countIn(categoryId) {
  return (view.lib.items || []).filter((c) => String(c.categoryId) === String(categoryId)).length;
}

function categoryRow() {
  const total = (view.lib.categories || []).length;
  const head = rowHead('CATEGORIES', {
    meta: catsExpanded ? `${total} total · A–Z` : `${total} total · pinned first`,
  });

  if (!catsExpanded) {
    const cards = view.categories.slice(0, 24).map((category, c) =>
      categoryCard(category, { r: 3, c, count: countIn(category.id) }));
    cards.push(allCategoriesCard({ r: 3, c: cards.length, total }));
    return rowBlock(head, strip(cards));
  }

  /* Expanded: every category as a grid, still one row per D-pad row so up and
     down move a row at a time rather than a page. */
  const grid = el('div', 'strip');
  const inner = el('div');
  inner.style.display = 'flex';
  inner.style.flexDirection = 'column';
  inner.style.gap = '24px';
  const sorted = [...(view.lib.categories || [])].sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < sorted.length; i += CATS_PER_GRID_ROW) {
    const line = el('div', 'strip-inner');
    const r = 3 + i / CATS_PER_GRID_ROW;
    sorted.slice(i, i + CATS_PER_GRID_ROW).forEach((category, c) => {
      line.append(categoryCard(category, { r, c, count: countIn(category.id) }));
    });
    inner.append(line);
  }
  grid.append(inner);
  return rowBlock(head, grid);
}

/* -------------------------------------------------------------- the remote ── */

export function activate(node, app) {
  const kind = node.dataset.kind;

  if (kind === 'game') {
    const channel = node._channel;
    if (!channel) {
      app.toast(`No channel matched “${node._game.channelName}” — check the scores feed mapping.`);
      return;
    }
    app.go('player', { channel, from: 'live' });
    return;
  }

  if (kind === 'chan') {
    app.go('player', { channel: node._item, from: 'live' });
    return;
  }

  if (kind === 'cat') {
    channelSource = node._item;
    catsExpanded = false;
    app.go('live', { focusRow: 1, focusCol: 0 });
    return;
  }

  if (kind === 'allcats') {
    catsExpanded = true;
    app.go('live', { focusRow: 3, focusCol: 0 });
  }
}

/** BACK unwinds the two in-place changes before it leaves the screen. */
export function back(app) {
  if (channelSource) {
    channelSource = null;
    app.go('live', { focusRow: 3, focusCol: 0 });
    return true;
  }
  if (catsExpanded) {
    catsExpanded = false;
    app.go('live', { focusRow: 3, focusCol: 0 });
    return true;
  }
  return false;
}
