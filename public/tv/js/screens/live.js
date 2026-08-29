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
import { loadLibrary, loadEpg, nowOn, favorites, pinnedIds, pinnedFirst, state }
  from '../state.js';
import { getGames, usingPlaceholders, matchChannel, slateTrouble, feedTrouble, slateSource }
  from '../scores.js';
import { channelCard, categoryCard, allCategoriesCard, rowHead, strip, rowBlock } from './cards.js';
import { putProfilePrefs } from '../api.js';

const CHANNELS_IN_ROW = 14;
const CATS_PER_GRID_ROW = 8;
/* Five 320px cards and four 24px gaps is 1,696 of the 1,792 the stage leaves
   between its margins — the widest a channel grid goes without reflowing. */
const CHANS_PER_GRID_ROW = 5;
/* A baseball evening is fifteen games; a football Sunday is thirteen and a
   whip-around. The row is what is ON, so it runs live first, then what is
   about to start, and finals bring up the rear. */
const GAMES_IN_ROW = 16;
/* A college Saturday is sixty games, which is not a row — it is a grid, and
   the same grid the desktop draws. */
/* Ten lines of four. Ten because the grid's rows are numbered in tenths
   between the games row and the channels below it, and an eleventh would
   land on top of them. */
const GAMES_IN_GRID = 40;
const GAMES_PER_GRID_ROW = 4;
const SLATE_ORDER = { live: 0, upcoming: 1, final: 2 };

/*
 * Which sport the games row is showing.
 *
 * The same three the portal offers and the same stored setting, so a switch
 * thrown on the television is thrown on the phone too — this reads and writes
 * the profile's own `scoreSport`, not a preference of its own.
 */
const SPORTS = [
  { key: 'nfl', label: 'FOOTBALL' },
  { key: 'mlb', label: 'BASEBALL' },
  { key: 'ncaaf', label: 'COLLEGE' },
];

const scoreSport = () => {
  const held = state.prefs && state.prefs.scoreSport;
  return SPORTS.some((s) => s.key === held) ? held : 'mlb';
};

async function setScoreSport(sport, app) {
  if (!state.prefs || sport === scoreSport()) return;
  state.prefs.scoreSport = sport;
  /* Written back before the redraw so a viewer who switches and immediately
     leaves the screen does not lose it. The whole prefs record goes up, which
     is what the box expects and what the portal sends too. */
  putProfilePrefs(state.profile.id, state.prefs).catch(() => {});
  if (app && app.refresh) app.refresh();
}

/* The two balls and the cap, drawn at the weight the rest of this app's
   glyphs are drawn at. */
const SPORT_ICON = {
  nfl: 'M4.4 19.6c-1.6-4.6.3-10.6 4-14.2 3.6-3.7 9.6-5.6 14.2-4 1.6 4.6-.3 10.6-4 '
    + '14.2-3.6 3.7-9.6 5.6-14.2 4z M9 15l6-6',
  mlb: '',
  ncaaf: 'M12 4L2 9l10 5 10-5-10-5z M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5',
};

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
  const sport = scoreSport();
  view.sport = sport;
  view.games = games
    .filter((g) => (g.sport || 'nfl') === sport)
    /* A televised college game ahead of one without a network against its
       name: the box asks ESPN for FBS first, but when that address is refused
       it settles for all of Division I — a hundred and something games
       against a grid that holds forty-eight. A tie-break, not a filter. */
    .sort((a, b) => (SLATE_ORDER[a.status] ?? 3) - (SLATE_ORDER[b.status] ?? 3)
      || (sport === 'ncaaf'
        ? (b.channelMatch || b.channelName ? 1 : 0) - (a.channelMatch || a.channelName ? 1 : 0)
        : 0)
      /* A game with no announced kickoff goes to the END of the day. Zero is
         the earliest number there is and it is not an early kickoff. */
      || (a.kickoff || Number.MAX_SAFE_INTEGER) - (b.kickoff || Number.MAX_SAFE_INTEGER))
    .slice(0, sport === 'ncaaf' ? GAMES_IN_GRID : GAMES_IN_ROW);

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
  root.append(sportRow(app));
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

/* ------------------------------------------------------------ the switch ── */
/*
 * Which slate the row is showing, as three chips above it.
 *
 * Above the games in the D-pad's own ordering, so ▲ from the first card
 * reaches it — the switch is not something anybody needs on the way to
 * watching, so it stays out of the path until it is wanted.
 */
function sportRow(app) {
  const row = el('div', 'sportrow');
  SPORTS.forEach((sport, c) => {
    const chip = el('div', `sportchip ring${sport.key === view.sport ? ' on' : ''}`);
    /* Between the nav and the games. The engine steps through its rows by
       their sorted order rather than by arithmetic, so a half sits where it
       reads: ▲ from the first game lands here, ▲ again reaches the nav. */
    chip.dataset.r = 0.5;
    chip.dataset.c = c;
    chip.dataset.kind = 'sport';
    chip.dataset.sport = sport.key;
    chip.append(sportGlyph(sport.key), el('span', null, sport.label));
    chip.addEventListener('click', () => setScoreSport(sport.key, app));
    row.append(chip);
  });
  return row;
}

/** The two balls and the cap, at the weight the rest of the glyphs use. */
function sportGlyph(key) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'sportglyph');
  const paths = {
    nfl: ['M4.4 19.6c-1.6-4.6.3-10.6 4-14.2 3.6-3.7 9.6-5.6 14.2-4 1.6 4.6-.3 10.6-4 '
      + '14.2-3.6 3.7-9.6 5.6-14.2 4z', 'M9 15l6-6'],
    mlb: ['M12 3a9 9 0 100 18 9 9 0 000-18z',
      'M6.2 5.5C8.4 7.6 9.6 10.4 9.6 12s-1.2 4.4-3.4 6.5',
      'M17.8 5.5c-2.2 2.1-3.4 4.9-3.4 6.5s1.2 4.4 3.4 6.5'],
    ncaaf: ['M12 4L2 9l10 5 10-5-10-5z', 'M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5'],
  }[key] || [];
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
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
    /* This row's own sport first: the slate as a whole can be perfectly
       healthy while the one league this row shows was refused. */
    const why = feedTrouble(view.sport) || slateTrouble();
    /* The whole address, not the path. A line that says to open '/api/scores'
       is asking somebody standing in their living room to work out what to put
       in front of it. */
    const where = `${location.origin}${slateSource()}`;
    return rowBlock(head, el('div', 'empty', why
      ? `No scores: ${why}. Type ${where}/probe into a browser to see what every address replied.`
      : `No games on the slate right now — the feed answered, with nothing on it. ${where} shows what it was asked.`));
  }

  /* A college Saturday is sixty games. A row you scroll along is right for a
     dozen and useless for sixty — on a television, where scrolling costs a
     press each, it is worse still. So college wraps into a grid, one focus
     row per line, the same way a category does. */
  if (view.sport === 'ncaaf') {
    const grid = el('div');
    for (let i = 0; i < view.games.length; i += GAMES_PER_GRID_ROW) {
      /* Tenths, so ten lines of games still sit between the games row and the
         channels at 2 — the engine orders its rows by value, so this reads
         as "still the games row" and never collides with what is below. */
      const line = view.games.slice(i, i + GAMES_PER_GRID_ROW)
        .map((game, c) => gameCard(game, c, 1 + (i / GAMES_PER_GRID_ROW) * 0.1));
      grid.append(strip(line, { wide: true }));
    }
    return rowBlock(head, grid);
  }

  const cards = view.games.map((game, i) => gameCard(game, i));
  return rowBlock(head, strip(cards, { wide: true }));
}

function labelForSlate() {
  const day = new Date().toLocaleDateString([], { weekday: 'long' });
  return day.toUpperCase();
}

function gameCard(game, c, r = 1) {
  const channel = matchChannel(game, view.lib.items || []);
  const card = el('div', `game is-${game.sport || 'mlb'}`);
  card.dataset.r = r;
  card.dataset.c = c;
  card.dataset.kind = 'game';
  card.dataset.name = channel ? channel.name : game.channelName;
  card._game = game;
  card._channel = channel;

  if (game.redZone) card.classList.add('redzone');
  if (game.status === 'upcoming') card.classList.add('upcoming');
  card.classList.add('ring');

  card.append(gameTop(game, channel));
  if (game.redZone) {
    card.append(redZoneBody(game));
    card.append(gameFoot(game));
    return card;
  }
  card.append(scoreLine(game));
  /* One shape per sport, and the state of the game is what decides which:
     baseball's is a diamond and a count, football's is a ball on a line. A
     game that has not started has neither and says who is pitching, or what
     each side's season looks like, instead. */
  if (game.status === 'upcoming') card.append(pregameFoot(game, channel));
  else if (game.sport === 'nfl' || game.sport === 'ncaaf') card.append(fieldFoot(game));
  else if (game.status === 'live') card.append(diamondFoot(game));
  else card.append(el('div', 'game-under', el('span', 'game-spot',
    channel ? cleanName(channel.name) : 'No channel matched')));
  return card;
}

/** The club's own mark, with its initials underneath if it will not load. */
function teamMark(team) {
  const box = el('span', 'game-mark');
  if (team && team.logo) {
    const badge = el('img');
    badge.src = `/img?u=${encodeURIComponent(team.logo)}`;
    badge.alt = team ? (team.abbr || '') : '';
    /* A mark that will not load leaves the initials showing rather than a
       broken picture — the league's server is not this box's to promise. */
    badge.addEventListener('error', () => {
      badge.remove();
      box.classList.add('no-mark');
    });
    box.append(badge);
  } else {
    box.classList.add('no-mark');
  }
  box.append(el('span', 'game-abbr', team ? (team.abbr || '') : ''));
  return box;
}

/*
 * When a game starts, said where the television is standing.
 *
 * Drawn here, from the instant, rather than taken from whatever the box
 * formatted into `clock`. The box is one machine in one timezone and the
 * screens are wherever anybody happens to be — a start time formatted on the
 * server is the SERVER's evening, which is how a slate of Eastern kickoffs
 * came to be printed as local ones. `clock` still stands in when there is no
 * instant: a game whose kickoff has not been announced has no time to say in
 * any zone.
 */
/* The zone this house keeps. Not the television's — it has no idea where it
   is and will happily insist on UTC — and not the box's, which is a setting
   nobody looks at. This household is Eastern and does not travel, so a
   kickoff means the same thing on every screen in it. */
const HOUSE_ZONE = 'America/New_York';
const startsAt = (game) => (game.kickoff
  ? new Date(game.kickoff).toLocaleTimeString('en-US',
    { timeZone: HOUSE_ZONE, hour: 'numeric', minute: '2-digit' })
  : (game.clock || 'TBA'));

/** Mark, score, mark — the line a scoreboard reads along. */
function scoreLine(game) {
  const row = el('div', 'game-line');
  const mid = el('div', 'game-mid');
  if (game.status === 'upcoming') {
    mid.append(el('div', 'game-at', '@'));
    mid.append(el('div', 'game-start', startsAt(game)));
    if (game.warmup) mid.append(el('div', 'game-warmup', 'WARMUP'));
  } else {
    const away = game.away && game.away.score;
    const home = game.home && game.home.score;
    mid.append(el('div', 'game-score',
      `${away === null || away === undefined ? '—' : away} - `
      + `${home === null || home === undefined ? '—' : home}`));
    mid.append(el('div', game.status === 'final' ? 'game-over' : 'game-half',
      game.status === 'final' ? 'FINAL' : (game.clock || '')));
  }
  row.append(teamMark(game.away), mid, teamMark(game.home));
  return row;
}

/**
 * The diamond and the count, for a game being played.
 *
 * Second at the top, third to the left, first to the right — the diamond as
 * it is seen from behind the plate, which is how every scoreboard in the
 * sport draws it.
 */
function diamondFoot(game) {
  const foot = el('div', 'game-under');
  const on = game.onBase || {};
  const diamond = el('span', 'game-diamond');
  for (const base of ['second', 'third', 'first']) {
    diamond.append(el('i', `b-${base}${on[base] ? ' on' : ''}`));
  }
  foot.append(diamond);

  const count = game.count || {};
  const dots = el('span', 'game-count');
  for (const [label, had, of] of [['B', count.balls, 4], ['S', count.strikes, 3],
    ['O', count.outs, 3]]) {
    const line = el('span', 'game-countrow');
    line.append(el('b', null, label));
    for (let i = 0; i < of; i += 1) line.append(el('i', Number(had) > i ? 'on' : null));
    dots.append(line);
  }
  foot.append(dots);
  return foot;
}

/**
 * The field, with the ball on it.
 *
 * Laid out the way the card is — the away side's end zone on the left, the
 * home side's on the right — so the arrow points at the end zone the team
 * with the ball is actually trying to reach.
 */
function fieldFoot(game) {
  const foot = el('div', 'game-under column');
  const drive = game.drive;
  if (!drive) {
    foot.append(el('span', 'game-spot', game.situation || 'Ball not spotted'));
    return foot;
  }
  const field = el('div', `game-field${drive.redZone ? ' redzone' : ''}`);
  field.append(el('i', 'ez ez-l'), el('i', 'ez ez-r'));
  for (const at of [25, 50, 75]) {
    const tick = el('i', `tick${at === 50 ? ' mid' : ''}`);
    tick.style.left = `${at}%`;
    field.append(tick);
  }
  if (Number.isFinite(drive.yardLine)) {
    const ball = el('i', `ball${drive.driving ? ` go-${drive.driving}` : ''}`);
    ball.style.left = `${Math.min(97, Math.max(3, drive.yardLine))}%`;
    field.append(ball);
  }
  foot.append(field);
  const line = el('div', 'game-drive');
  line.append(el('b', null, drive.text || ''), el('span', null, drive.spot || ''));
  foot.append(line);
  return foot;
}

/**
 * A game that has not started.
 *
 * Baseball lists the two probables with their record and ERA, which is the
 * only thing there is to say about a game with no score. Football has no
 * probables, so the same strip carries what each side's season looks like
 * going in.
 */
function pregameFoot(game, channel) {
  const foot = el('div', 'game-under column');
  const rows = el('div', 'game-starters');
  for (const side of ['away', 'home']) {
    const team = game[side];
    if (!team) continue;
    const row = el('div', 'game-starter');
    row.append(el('b', null, team.abbr || ''));
    if (game.sport === 'nfl' || game.sport === 'ncaaf') {
      row.append(el('span', null, team.record || '—'));
    } else {
      const p = team.pitcher;
      if (!p) {
        row.append(el('span', 'tba', 'TBA'));
      } else {
        const line = [];
        if (p.wins !== null && p.wins !== undefined
          && p.losses !== null && p.losses !== undefined) line.push(`${p.wins}-${p.losses}`);
        if (p.era) line.push(p.era);
        row.append(el('span', null, line.length ? `${p.last} (${line.join(', ')})` : p.last));
      }
    }
    rows.append(row);
  }
  foot.append(rows);
  foot.append(el('span', 'game-spot',
    channel ? kickoffNote(game) : 'No channel matched'));
  return foot;
}

function gameTop(game, channel) {
  const top = el('div', 'game-top');
  const name = el('span', 'game-chan');
  name.append(cleanName(channel ? channel.name : game.channelName));
  if (channel && channel.uhd) name.append(el('span', 'hd', ' UHD'));
  top.append(name);

  if (game.status === 'upcoming') {
    top.append(el('span', 'game-time', startsAt(game)));
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
/**
 * The foot of the whip-around card, which is the one card that is not a game.
 *
 * Everything else took its own shape when the scoreboard was redrawn — a
 * diamond, a field, two probables — and this is what is left: a channel with
 * no score, no clock and no possession, describing what is happening
 * everywhere else.
 */
function gameFoot(game) {
  const foot = el('div', 'redzone-foot');
  foot.append(el('span', null, game.note || ''), el('span', 'situation', game.situation || ''));
  return foot;
}

function kickoffNote(game) {
  /* Baseball does not kick off. One word, taken from the sport the game came
     with rather than from the one this row was first written for. */
  const start = game.sport === 'mlb' ? 'First pitch' : 'Kicks off';
  if (!game.kickoff) return game.clock ? `${start} ${game.clock}` : 'Later today';
  const mins = Math.round((game.kickoff - Date.now()) / 60000);
  if (mins <= 0) return 'Starting now';
  if (mins < 60) return `${start} in ${mins} min`;
  return `${start} at ${new Date(game.kickoff).toLocaleTimeString('en-US',
    { timeZone: HOUSE_ZONE, hour: 'numeric', minute: '2-digit' })}`;
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

  if (kind === 'sport') {
    setScoreSport(node.dataset.sport, app);
    return;
  }

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
