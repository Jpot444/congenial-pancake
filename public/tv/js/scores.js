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
 *   onBase       {first,second,third}  baseball, as booleans — the diamond
 *   count        {balls,strikes,outs}  baseball, as numbers — the dots
 *   drive        {down,distance,text,spot,yardLine,driving,redZone}
 *                         football. `yardLine` is 0-100 measured from the
 *                         AWAY side's goal line, so the card can draw it the
 *                         way it lays the marks out; `driving` is 'left' or
 *                         'right' in those same terms.
 *   warmup       boolean  the league says the broadcast is up
 *   situation    string   '3rd & 7 · GB 41' — the same facts as a sentence,
 *                         for anywhere that cannot draw them
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
  const names = (list) => (Array.isArray(list) ? list.filter(Boolean) : []);
  return {
    id: String(row.id ?? ''),
    sport: row.sport || 'nfl',
    status: row.status || 'live',
    /* The league's own word for the state — 'Warmup', 'Halftime', 'Delayed:
       Rain'. Warmup is the one worth drawing: it is the moment the broadcast
       comes up, which is the moment tuning to the channel is worth doing. */
    detailedState: row.detailedState || '',
    warmup: Boolean(row.warmup),
    channelMatch: row.channelMatch || '',
    channelName: row.channelName || '',
    /* Three spellings of the two sides, best first. College is why: a row
       says 'ALABAMA X GEORGIA' far more often than 'CRIMSON TIDE X BULLDOGS',
       and some say neither and go with 'ALA X UGA'. */
    teamMatch: names(row.teamMatch),
    teamAlt: names(row.teamAlt),
    teamShort: names(row.teamShort),
    redZone: Boolean(row.redZone),
    away: row.away || null,
    home: row.home || null,
    clock: row.clock || '',
    /* Baseball's state as a diamond and a count, football's as a ball on a
       line. A card DRAWS these; the sentence below is what it used to print
       instead, and it is kept because a card that has neither still says
       something. */
    onBase: row.onBase || null,
    count: row.count || null,
    drive: row.drive || null,
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
/* Per feed, because `trouble` above is about the whole answer and a row is
   about one sport. Baseball answering is enough to make the slate non-empty,
   and without this the college row reads a refused ESPN as "the feed
   answered, with nothing on it" — the one sentence that rules out what
   actually happened. */
let feeds = [];

/*
 * The slate, asked for once and shared.
 *
 * "the sheild tv takes too long to load because it trys to load in sports
 *  scores so much"
 *
 * Every caller used to mean a fresh fetch, and there are four of them now: the
 * Live screen on every render, multi-view when it opens, the player on every
 * tune, and the Live screen again on every ten-second refresh. Behind that one
 * address the box asks ESPN, the MLB stats API and the NCAA scoreboard — three
 * services on the far side of the internet — so this is the slowest thing the
 * television waits on and it was being waited on over and over.
 *
 * A scoreboard is worth about half a minute of staleness. What it is not worth
 * is the app stopping to ask again because somebody pressed a channel.
 */
const SLATE_TTL_MS = 30_000;
let cached = null;
let cachedAt = 0;
let inFlight = null;

/**
 * The slate already in hand, or null.
 *
 * For a screen that is being painted again rather than opened: coming back to
 * Live TV, or the once-a-minute refresh. Those have a slate a few seconds old
 * sitting right here, and putting a "looking for what is on" placeholder up
 * before replacing it a frame later is the screen changing under somebody for
 * no reason at all.
 */
export function peekGames() {
  return cached && Date.now() - cachedAt < SLATE_TTL_MS ? cached : null;
}

/** Throw the held slate away, so the next ask really asks. */
export function forgetGames() {
  cached = null;
  cachedAt = 0;
}

export async function getGames() {
  if (cached && Date.now() - cachedAt < SLATE_TTL_MS) return cached;
  /* Two screens opening at once is one request, not two. Both get the same
     answer, which is also the only way they can agree about what is on. */
  if (inFlight) return inFlight;
  inFlight = fetchGames().then((games) => {
    cached = games;
    cachedAt = Date.now();
    inFlight = null;
    return games;
  }, (err) => {
    inFlight = null;
    throw err;
  });
  return inFlight;
}

async function fetchGames() {
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
    feeds = Array.isArray(data && data.feeds) ? data.feeds : [];
    return games;
  } catch (err) {
    live = true;
    asked = Date.now();
    trouble = err.message || 'the box could not be reached';
    feeds = [];
    return [];
  }
}

/** Whether anything on screen is invented, so the row can say so. */
export const usingPlaceholders = () => !ENDPOINT || !live;

/** What went wrong the last time the slate was asked for, if anything. */
export const slateTrouble = () => trouble;

/**
 * What went wrong for ONE sport's feed, if anything.
 *
 * The row that is empty is the row that has to explain itself, and it is
 * showing one sport. A college row with nothing in it while baseball is fine
 * has to be able to say ESPN refused rather than that college football is
 * over for the year.
 */
export const feedTrouble = (sport) =>
  String((feeds.find((f) => f && f.sport === sport) || {}).error || '');

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
  /* Rows like "US (Peacock 023) | Marlins at Nationals (2026-08-30 12:00:00)"
     are placeholders for a broadcast at a stated time, with nothing on them.
     They are the best possible match by name, which is exactly the problem —
     a card pointed at one opens a channel that is not playing. The stamped
     time is what identifies them. */
  const dated = /\(\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

  /* Two spellings per side, best first. A pro row says 'BEARS X PACKERS'; a
     college row is far likelier to say 'ALABAMA X GEORGIA' than 'CRIMSON TIDE
     X BULLDOGS', and some go with 'ALA X UGA'. Without this the college games
     had no by-row pass at all on the television — the restriction below was
     baseball's alone — and every one of them fell through to the network,
     which on a Saturday is eight games all saying ESPN. */
  const pairs = [game.teamMatch, game.teamAlt, game.teamShort]
    .map((pair) => (pair || []).map((t) => String(t).toUpperCase().trim()).filter(Boolean))
    .filter((pair) => pair.length >= 2);

  /*
   * A row that names a fixture is THAT fixture's row.
   *
   * The provider carries hundreds of per-event rows — 'Flo (FLSP) 279: 2025
   * UConn vs Mercyhurst - Womens - 24/10 15:00' — and until now only the
   * by-row pass ever read the two sides off them. The network pass treats
   * every row as a channel that might be showing anything, so a row naming one
   * of the two schools, or merely carrying a network word, could answer for a
   * completely different game. That row says who is playing on it; if it is
   * not this game, it is not this game's channel.
   *
   * Costs the by-row pass nothing — it already requires both names.
   */
  const fixtureSplit = /\s(?:VS|V|X|AT)\s|\s@\s/;
  const wordsOf = (text) => ` ${String(text || '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim()} `;
  const namesAFixture = (name) => {
    const hay = wordsOf(name);
    if (hay.search(fixtureSplit) < 0) return false;
    const [left, right] = hay.split(fixtureSplit);
    return Boolean(left && left.trim() && right && right.trim());
  };
  const fixtureIsOurs = (name) => {
    const hay = wordsOf(name);
    return pairs.some((pair) => pair.every((team) => hay.includes(` ${wordsOf(team).trim()} `)));
  };

  const live = channels.filter((c) => {
    const name = String(c.name || '');
    if (dated.test(name)) return false;
    if (namesAFixture(name) && !fixtureIsOurs(name)) return false;
    return true;
  });

  /* The game's OWN channel first. On a baseball night this provider carries a
     row per game — 'MLB 01 | Rockies x Nationals' — and that is the broadcast
     itself rather than the network that happens to be showing it, so a channel
     naming both teams beats anything the network match could find.

     Restricted to the shelf the sport's own rows live on, because naming both
     teams is not rare: a highlights channel does it, and so does a
     pay-per-view page.

     The word FOOTBALL is no use for that restriction — on every provider
     panel there is, a shelf called FOOTBALL is soccer — so the gridiron test
     wants an explicit NFL/NCAA/CFB/COLLEGE, or a bare FOOTBALL in an American
     context, and refuses an unmistakably soccer row whatever else it says. */
  const shelf = (name) => {
    if ((game.sport || 'mlb') === 'mlb') return /\bMLB\b|BASEBALL/.test(name);
    if (/SOCCER|FUTBOL|\bEPL\b|PREMIER LEAGUE|\bUEFA\b|LA ?LIGA|SERIE ?A|BUNDESLIGA|\bMLS\b|\bFIFA\b/
      .test(name)) return false;
    if (/\bNFL\b|NCAA|\bCFB\b|COLLEGE|AMERICAN FOOTBALL/.test(name)) return true;
    return /FOOTBALL/.test(name) && /\bUSA?\b/.test(name);
  };

  for (const teams of pairs) {
    let byTeams = null;
    for (const channel of live) {
      const name = String(channel.name || '').toUpperCase();
      if (!shelf(name)) continue;
      if (!teams.every((team) => name.includes(team))) continue;
      if (!byTeams || name.length < String(byTeams.name).length) byTeams = channel;
    }
    if (byTeams) return byTeams;
  }

  /* Then the network. Not narrowed to the sport's shelf, because a national
     broadcast is on a network channel and those are not filed under it.
     
     WHOLE WORDS, and this is not pedantry: as a substring test, NBC is inside
     CNBC — a college game on NBC matched 'US| CNBC', and the shortest-name
     tie-break then preferred it over 'NCAAF 07 | NBC'. ESPN is inside ESPNU,
     CBS inside CBSSN; every short network name has this problem.
     
     A feed also writes 'FOX / FOX ONE' in that one field, which is two
     channels and a string no provider ever puts on a row. */
  const said = (game.channelMatch || game.channelName || '').toUpperCase().trim();
  if (!said) return null;
  const networks = said.split(/\s*\/\s*/).map((n) => n.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const wordsIn = (text) => ` ${String(text || '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim()} `;

  let best = null;
  let bestRank = 9;
  for (const channel of live) {
    const hay = wordsIn(channel.name);
    if (!networks.some((network) => hay.includes(` ${wordsIn(network).trim()} `))) continue;
    /* The provider's own row for the sport beats the plain network feed: a
       college game on NBC is carried on 'US| NCAAF 07 | NBC' as well as on
       'US| NBC', and the first of those is the broadcast itself. */
    const rank = shelf(String(channel.name || '').toUpperCase()) ? 0 : 1;
    if (rank > bestRank) continue;
    if (!best || rank < bestRank
      || String(channel.name).length < String(best.name).length) {
      best = channel;
      bestRank = rank;
    }
  }
  return best;
}
