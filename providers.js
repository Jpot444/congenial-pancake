/*
 * The provider's logins, and who is using which.
 *
 * This box was built around one account with one connection, and every rule in
 * it grew from that: a download pauses the moment somebody presses play, the
 * credits crawler only runs when nothing is streaming, multi-view warns you it
 * may not hold four cells. None of that was caution — a second stream on a
 * single-connection account does not queue, it fails, and takes the first one
 * down with it often enough to be worth designing around.
 *
 * A second login is a second connection. So the box holds a LIST of logins
 * now, and everything that reaches the provider takes a slot from this pool
 * first: the direct stream proxy, the live ingest, the download worker, and
 * the metadata calls. The rules above do not disappear, they relax — a
 * download pauses when the LAST slot goes, not the first.
 *
 * Two things this deliberately does not do.
 *
 * It does not mix providers. Every account must be on the same host, because
 * the library is one catalogue keyed by the provider's own stream ids: point
 * two different panels at it and half the ids would open the wrong thing, or
 * nothing. Same provider, more logins.
 *
 * And it does not pretend to know the provider's own accounting. `slots` is
 * what the panel says the account allows (`max_connections`), which is a
 * claim by the provider rather than a measurement — if it lies, streams fail
 * the way they did before, and the pool is what makes that visible rather
 * than mysterious.
 */

/* A login that has never answered is assumed to allow one connection: the
   conservative guess, and the one that was true before this file existed. */
const DEFAULT_SLOTS = 1;
/* However many the panel claims. A number this side of absurd, because a
   panel that reports 999 is describing its licence, not this house's link. */
const MAX_SLOTS = 8;

/* What the panel said about an account, and when. Refreshed by the box rather
   than on every request: expiry is a date, not a live figure. */
const REFRESH_MS = 10 * 60 * 1000;

/** id → { streams, reserved } — the box's own count of what is in use.
    `reserved` is a list of expiry times, one per reservation, NOT a count with
    a shared deadline: with a shared one, a second reservation pushes the
    deadline out and the first outlives the moment it should have died, so a
    page that asks a few times in a row can leave an account reading as full
    with nothing playing on it. */
const usage = new Map();
/** id → { at, expiresAt, status, trial, maxConnections, activeCons, error } */
const facts = new Map();

/* A reservation covers the gap between choosing an account for a stream and
   that stream actually connecting — the URL is built in one request and the
   pipe opens in the next. Short, because a reservation nobody claims must not
   hold a slot out of circulation. */
const RESERVE_MS = 20000;

function slot(id) {
  if (!usage.has(id)) usage.set(id, { streams: 0, reserved: [] });
  const held = usage.get(id);
  // Each reservation dies on its own schedule.
  if (held.reserved.length) {
    const now = Date.now();
    held.reserved = held.reserved.filter((t) => t.until > now);
  }
  return held;
}

/* --------------------------------------------------------------- accounts ── */

/**
 * The logins, however the config happens to be written.
 *
 * A box configured before any of this exists carries one account as three
 * loose fields; it is read as a list of one so nothing has to be migrated on
 * disk before it works.
 */
function accounts(cfg) {
  if (!cfg || cfg.mode !== 'xtream') return [];
  const list = Array.isArray(cfg.accounts) && cfg.accounts.length
    ? cfg.accounts
    : (cfg.host && cfg.username ? [{ host: cfg.host, username: cfg.username, password: cfg.password }] : []);
  return list
    .filter((a) => a && a.host && a.username)
    .map((a, i) => ({
      id: String(a.id || `p${i + 1}`),
      host: a.host,
      username: String(a.username),
      password: String(a.password ?? ''),
      label: String(a.label || '').trim(),
    }));
}

/** How many slots this login is believed to have. */
function slotsFor(id) {
  const known = facts.get(id);
  const said = Number(known && known.maxConnections);
  if (!Number.isFinite(said) || said < 1) return DEFAULT_SLOTS;
  return Math.min(MAX_SLOTS, Math.floor(said));
}

/**
 * Whether that number is a GUESS rather than something the provider said.
 *
 * This matters because the guess is one, and one is the number that makes
 * everything else in the box behave as though the house is full. A login
 * nobody has asked about reads as a single-connection account, so the second
 * stream is "crowded" and any failure on it — a slow feed, a dead channel,
 * anything at all — gets reported as "no connection free", which is a
 * sentence about the pool rather than about what actually went wrong.
 *
 * Nothing used to correct it except opening the manage-providers panel by
 * hand: `note()` is called from that endpoint and nowhere else, so a box that
 * had rebooted believed every account allowed one connection until somebody
 * happened to visit Settings. A reboot is exactly when nobody does.
 *
 * So callers about to make a decision that hinges on capacity can ask whether
 * the figure is worth deciding on, and go and find out when it is not.
 */
function guessing(id) {
  const known = facts.get(id);
  return !(known && Number(known.maxConnections) >= 1);
}

/** True when any login's slot count is still the conservative guess. */
const anyGuessed = (cfg) => accounts(cfg).some((a) => guessing(a.id));

/** Free slots across every login. */
function free(cfg) {
  return accounts(cfg).reduce((sum, account) => {
    const held = slot(account.id);
    return sum + Math.max(0, slotsFor(account.id) - held.streams - held.reserved.length);
  }, 0);
}

/** True when there is nothing left to open a stream with. */
const busy = (cfg) => free(cfg) === 0;

/** Every slot, in use or not — what the house could run at once. */
function capacity(cfg) {
  return accounts(cfg).reduce((sum, a) => sum + slotsFor(a.id), 0);
}

function inUse(cfg) {
  return accounts(cfg).reduce((sum, a) => sum + slot(a.id).streams, 0);
}

/* ------------------------------------------------------------------ leases ── */

/**
 * The login to open a stream with: the one with the most room, or nothing at
 * all when every account is full. `reserve` holds the choice for a few seconds
 * so the request that builds the URL and the request that opens the pipe agree
 * about which account they meant.
 */
function pick(cfg, { reserve = false } = {}) {
  let best = null;
  let bestRoom = 0;
  for (const account of accounts(cfg)) {
    const held = slot(account.id);
    const room = slotsFor(account.id) - held.streams - held.reserved.length;
    if (room > bestRoom) {
      best = account;
      bestRoom = room;
    }
  }
  if (!best) return null;
  /* The reservation is handed back on the account object so the caller can
     give up THAT one later. Without a ticket, take() could only drop the
     oldest reservation on the login, which is somebody else's whenever two
     things start at once — see take(). */
  if (reserve) {
    const ticket = { until: Date.now() + RESERVE_MS };
    slot(best.id).reserved.push(ticket);
    return { ...best, ticket };
  }
  return best;
}

/**
 * A login for a metadata call.
 *
 * Never nothing: a guide lookup is not a stream and refusing it would be worse
 * than making it on a busy account, which is what the box did for its whole
 * life before this. A free one is preferred precisely because that is the case
 * this exists to fix — on one account, asking the panel anything while a
 * stream is running comes back empty.
 */
function forMeta(cfg) {
  return pick(cfg) || accounts(cfg)[0] || null;
}

/** Which login this URL belongs to, by the credentials written into it. */
function forUrl(cfg, url) {
  const text = String(url || '');
  let best = null;
  for (const account of accounts(cfg)) {
    const user = encodeURIComponent(account.username);
    if (text.includes(`/${user}/`) || text.includes(`username=${user}`)
      || text.includes(`/${account.username}/`) || text.includes(`username=${account.username}`)) {
      // The longest match wins, so 'user' does not answer for 'user2'.
      if (!best || account.username.length > best.username.length) best = account;
    }
  }
  return best;
}

/**
 * Take a slot. Returns a release function that can be called any number of
 * times — every caller here is an I/O path with more than one way to end.
 */
function take(id) {
  const held = slot(id);
  held.streams += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    held.streams = Math.max(0, held.streams - 1);
  };
}

/**
 * Take a slot AND give up the reservation that was held for it.
 *
 * The distinction take() no longer makes on its own, because it used to make
 * it wrongly: it shifted the oldest reservation on the login whoever called
 * it, so a download — or an ingest that found the pool full and went ahead
 * anyway — cancelled a reservation a different start was relying on, at
 * exactly the moment it was needed. Four multiview cells starting together
 * could each cancel another's.
 *
 * Two kinds of caller claim a reservation, and they can say so differently:
 *
 * - With a `ticket`, from pick({reserve:true}) in the same breath. Exact, and
 *   the right thing wherever the choosing and the taking are in one function.
 * - Without one, from the stream proxy: /api/play reserves a login and builds
 *   a URL, and the pipe opens in a LATER request that can only know the
 *   account from the credentials in that URL. There is no object to carry, so
 *   the oldest reservation on that login is the one being claimed — which is
 *   what take() always did, and what it has to keep doing HERE.
 *
 * A caller that never reserved calls take() and touches nothing.
 */
function claim(id, ticket = null) {
  const held = slot(id);
  const at = ticket ? held.reserved.indexOf(ticket) : 0;
  if (at >= 0 && held.reserved.length) held.reserved.splice(at, 1);
  return take(id);
}

/** Give up a reservation nobody is going to claim. */
function unreserve(id, ticket = null) {
  const held = slot(id);
  if (!ticket) return held.reserved.shift();
  const at = held.reserved.indexOf(ticket);
  if (at >= 0) held.reserved.splice(at, 1);
  return undefined;
}

/* ------------------------------------------------------------ what they are ── */

/**
 * Record what the panel said about a login — expiry, status, how many
 * connections it allows and how many it thinks are open. Kept as the
 * provider's own words rather than the box's opinion of them.
 */
function note(id, userInfo, error = '') {
  const info = userInfo || {};
  const seconds = Number(info.exp_date);
  facts.set(id, {
    at: Date.now(),
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    status: String(info.status || '').trim(),
    trial: String(info.is_trial ?? '') === '1',
    maxConnections: Number(info.max_connections) || null,
    activeCons: Number(info.active_cons) || 0,
    created: Number(info.created_at) ? Number(info.created_at) * 1000 : null,
    error: error || '',
  });
}

/**
 * A login that could not be reached, without forgetting what it last said.
 *
 * note(id, null, message) is the right record for "the provider answered and
 * rejected this login" — the account really is unusable and its numbers mean
 * nothing. It is the wrong record for "the box could not get a reply", which
 * is a network hiccup: clearing maxConnections there drops the account back
 * to the one-connection guess, and the guess is what makes the box refuse
 * streams the account allows. So the numbers stand and only the error moves.
 */
function noteError(id, message) {
  const known = facts.get(id);
  if (!known) return note(id, null, message);
  facts.set(id, { ...known, error: message || '', at: Date.now() });
  return undefined;
}

const stale = (id) => {
  const known = facts.get(id);
  return !known || Date.now() - known.at > REFRESH_MS;
};

/** Everything the manage-providers panel shows, with no password in it. */
function report(cfg) {
  return accounts(cfg).map((account) => {
    const known = facts.get(account.id) || {};
    const held = slot(account.id);
    const days = known.expiresAt
      ? Math.floor((known.expiresAt - Date.now()) / 86400000)
      : null;
    return {
      id: account.id,
      label: account.label,
      username: account.username,
      host: account.host,
      slots: slotsFor(account.id),
      streams: held.streams,
      /* The provider's own count, which is the interesting one when it
         disagrees with ours: a stream this box does not know about is
         somebody else using the login, or a connection the panel has not let
         go of yet. */
      activeCons: known.activeCons ?? null,
      maxConnections: known.maxConnections ?? null,
      expiresAt: known.expiresAt ?? null,
      daysLeft: days,
      expired: known.expiresAt ? known.expiresAt < Date.now() : false,
      status: known.status || '',
      trial: Boolean(known.trial),
      checkedAt: known.at || 0,
      error: known.error || '',
    };
  });
}

function forget(id) {
  usage.delete(id);
  facts.delete(id);
}

module.exports = {
  accounts,
  pick,
  forMeta,
  forUrl,
  take,
  claim,
  unreserve,
  free,
  busy,
  capacity,
  inUse,
  slotsFor,
  guessing,
  anyGuessed,
  note,
  noteError,
  stale,
  report,
  forget,
  DEFAULT_SLOTS,
  MAX_SLOTS,
};
