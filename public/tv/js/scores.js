/*
 * THE SCORES FEED — the one thing in this app that is not real yet.
 *
 * The provider's Xtream guide carries a programme title and nothing else: no
 * score, no quarter, no clock, no possession. Every one of those is invented
 * here, as placeholder text, until a real feed exists.
 *
 * ── To make it real, this is the whole job ───────────────────────────────
 *   1. Set ENDPOINT to the feed's URL (proxy it through the Pi if it needs a
 *      key — a key in a page served to the living room is a key given away).
 *   2. Make normalize() map one row of that feed onto the Game shape below.
 * Nothing else in the app reads the feed. Screens take Games from getGames()
 * and never look at where they came from.
 *
 * ── The Game shape ───────────────────────────────────────────────────────
 *   id           string   stable per game
 *   sport        'nfl' | 'mlb'
 *   status       'live' | 'upcoming' | 'final'
 *   channelMatch string   how this game finds its channel in the real live
 *                         library — matched loosely against channel names, so
 *                         'FOX' finds 'US| FOX ᴴᴰ'. This is what makes OK on a
 *                         score card tune the actual broadcast.
 *   channelName  string   what to print when no channel matches
 *   teamMatch    string[] the two teams' short names ('Rockies', 'Nationals'),
 *                         which is how a game finds the provider's channel FOR
 *                         THAT GAME — 'MLB 01 | Rockies x Nationals' — rather
 *                         than the network carrying it
 *   redZone      boolean  the whip-around card, which gets the brand field
 *   away/home    { abbr, record, score, possession }
 *   clock        string   'Q2 · 4:22'
 *   situation    string   '3rd & 7 · GB 41'
 *   kickoff      number   epoch ms, upcoming games only
 *   note         string   free text for an upcoming card ('Kicks off in 42 min')
 *   progress     number   0–100 through the broadcast. Left null when a
 *                         channel matches: real EPG start/stop beats a guess.
 */

/*
 * The box, not the feed.
 *
 * ESPN's public scoreboard needs no key, but it is still read by the Pi
 * rather than by the television: one place understands ESPN's shape, one
 * cache serves every screen in the house, and if the feed is ever swapped for
 * one that DOES want a key, nothing here has to learn about it. The Pi
 * already emits the Game shape below, so `normalize()` has almost nothing
 * left to do.
 */
const ENDPOINT = '/api/scores';

/**
 * Every field a screen may read, with nothing missing.
 *
 * Still here, and still the only place that would change for a different
 * feed: the Pi happens to hand back this shape already, so most of it is a
 * pass-through — but a screen must never be handed a row with a field
 * missing, whatever answered.
 */
function normalize(row) {
  return {
    id: String(row.id ?? ''),
    sport: row.sport || 'nfl',
    status: row.status || 'live',
    channelMatch: row.channelMatch || '',
    channelName: row.channelName || '',
    teamMatch: Array.isArray(row.teamMatch) ? row.teamMatch.filter(Boolean) : [],
    redZone: Boolean(row.redZone),
    away: row.away || null,
    home: row.home || null,
    clock: row.clock || '',
    situation: row.situation || '',
    kickoff: Number(row.kickoff) || 0,
    note: row.note || '',
    progress: Number.isFinite(row.progress) ? row.progress : null,
    placeholder: Boolean(row.placeholder),
  };
}

/* Placeholder text. Sunday afternoon, week 12 — the shape a real slate takes,
   so the row can be laid out and lived with before the feed exists. */
const PLACEHOLDER = [
  {
    id: 'chi-gb', status: 'live', channelMatch: 'FOX', channelName: 'US| FOX',
    away: { abbr: 'CHI', record: '4-6', score: 17, possession: true },
    home: { abbr: 'GB', record: '8-2', score: 13, possession: false },
    clock: 'Q2 · 4:22', situation: '3rd & 7 · GB 41', progress: 38, placeholder: true,
  },
  {
    id: 'redzone', status: 'live', channelMatch: 'NFL NETWORK', channelName: 'US| NFL NETWORK',
    redZone: true, clock: 'LIVE', situation: '4 inside the 20 now',
    note: '7 games in progress', progress: 46, placeholder: true,
  },
  {
    id: 'kc-buf', status: 'live', channelMatch: 'CBS', channelName: 'US| CBS',
    away: { abbr: 'KC', record: '9-1', score: 24, possession: false },
    home: { abbr: 'BUF', record: '7-3', score: 27, possession: true },
    clock: 'Q3 · 9:05', situation: '1st & 10 · KC 32', progress: 62, placeholder: true,
  },
  {
    id: 'sf-sea', status: 'live', channelMatch: 'NFL PPV 04', channelName: 'US| NFL PPV 04',
    away: { abbr: 'SF', record: '6-4', score: 7, possession: true },
    home: { abbr: 'SEA', record: '5-5', score: 10, possession: false },
    clock: 'Q1 · 2:41', situation: '2nd & 3 · SEA 45', progress: 18, placeholder: true,
  },
  {
    id: 'dal-phi', status: 'upcoming', channelMatch: 'NBC', channelName: 'US| NBC',
    away: { abbr: 'DAL', record: '7-3', score: null, possession: false },
    home: { abbr: 'PHI', record: '8-2', score: null, possession: false },
    clock: '8:20 PM', note: 'Sunday Night Football', placeholder: true,
  },
];

/**
 * The slate. Never throws and never leaves the row empty: a scores feed that
 * is down must not take the games row down with it.
 *
 * An empty row has two completely different meanings — there are no games on,
 * or nobody could be asked — and for as long as this said nothing they looked
 * identical from the sofa. Whatever went wrong is kept here so the row can
 * say which it was: a box that cannot reach the feed, a feed that answered
 * with an error, or a quiet Tuesday.
 */
let live = false;
let trouble = '';
let asked = 0;

export async function getGames() {
  if (!ENDPOINT) {
    live = false;
    trouble = '';
    return PLACEHOLDER.map(normalize);
  }
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`the box answered ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.games || data.events || []);
    const games = rows.map(normalize).filter((g) => g.id);
    /* An empty slate is an ANSWER, not a failure — it is Tuesday. Falling
     * back to the placeholder here would put invented scores on the screen
     * every day of the week nothing is played, which is worse than an empty
     * row by a distance. But an empty slate the BOX is unhappy about is a
     * different thing, and it travels back in `error`. */
    live = true;
    asked = Date.now();
    trouble = games.length ? '' : String((data && data.error) || '');
    return games;
  } catch (err) {
    live = true;
    asked = Date.now();
    trouble = err.message || 'the box could not be reached';
    return [];
  }
}

/** Whether anything on screen is invented, so the row can say so. */
export const usingPlaceholders = () => !ENDPOINT || !live;

/** What went wrong the last time the slate was asked for, if anything. */
export const slateTrouble = () => trouble;

/** When the slate was last asked for, so an empty row can prove it tried. */
export const slateAsked = () => asked;

/** Where the slate comes from, for a row that has to explain itself. */
export const slateSource = () => ENDPOINT;

/**
 * Tie a game to a channel in the real live library.
 *
 * Loose on purpose: provider names carry a country prefix and quality suffixes
 * ('US| FOX ᴴᴰ'), and a feed will say 'FOX'. Longest match wins so 'NFL NETWORK'
 * is not beaten by 'NFL'.
 */
export function matchChannel(game, channels) {
  /* The game's OWN channel first. On a baseball night this provider carries a
     row per game — 'MLB 01 | Rockies x Nationals' — and that is the broadcast
     itself rather than the network that happens to be showing it, so a channel
     naming both teams beats anything the network match could find. */
  const teams = (game.teamMatch || []).map((t) => String(t).toUpperCase().trim()).filter(Boolean);
  if (teams.length >= 2) {
    let byTeams = null;
    for (const channel of channels) {
      const name = String(channel.name || '').toUpperCase();
      if (!teams.every((team) => name.includes(team))) continue;
      if (!byTeams || name.length < String(byTeams.name).length) byTeams = channel;
    }
    if (byTeams) return byTeams;
  }

  const needle = (game.channelMatch || game.channelName || '').toUpperCase().trim();
  if (!needle) return null;
  let best = null;
  for (const channel of channels) {
    const name = String(channel.name || '').toUpperCase();
    if (!name.includes(needle)) continue;
    if (!best || name.length < String(best.name).length) best = channel;
  }
  return best;
}
