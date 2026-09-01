#!/usr/bin/env node
'use strict';

/**
 * IPTV Portal — local server.
 *
 * Does three jobs the browser can't do on its own:
 *   1. Serves the static front end in public/.
 *   2. Proxies the Xtream Codes / M3U API (providers never send CORS headers).
 *   3. Proxies the media itself, rewriting HLS playlists so every segment
 *      comes back through us with the right Range headers.
 *
 * No npm dependencies. `node server.js` and you're on the air.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 8420;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/*
 * The box's version, read out of the file that shows it.
 *
 * The number belongs to the portal and always has — it is stamped into its
 * own footer. But the TV app is a second front end against the same box and
 * has no way to know what it is talking to, which is the first question of
 * every report about it. Read once at boot rather than kept in a second
 * place, because a copy that is not on screen is always the one that is out
 * of date. Blank if it cannot be read: an empty stamp is honest, a stale one
 * is not.
 */
const VERSION = (() => {
  try {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    return (/^const VERSION = '([^']+)'/m.exec(src) || [])[1] || '';
  } catch {
    return '';
  }
})();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PREFS_PATH = path.join(ROOT, 'prefs.json');
const PROFILES_PATH = path.join(ROOT, 'profiles.json');
/* Feedback and bug reports. Kept out of version control and 0600 like the
   other state: a report can carry whatever somebody chose to type into it,
   including how to reach them. */
const REPORTS_PATH = path.join(ROOT, 'reports.json');
/* Who is in what, and what they look like. A cache of other people's answers
   — the provider's credits and IMDb's portraits — so it is disposable, but it
   takes a long time to build and is worth keeping across restarts. */
const PEOPLE_PATH = path.join(ROOT, 'people.json');
/*
 * Where conversions and the live window are written.
 *
 * This is the busiest directory on the box by a distance: every live channel
 * publishes a rolling two-minute window into it, four seconds at a time, for
 * as long as anybody is watching, and every film that needs converting writes
 * its whole self here. On the SD card that is the single largest source of
 * wear the box produces — a card has a finite number of writes and this spends
 * them faster than everything else combined.
 *
 * Overridable for the same reason DOWNLOADS_ROOT is: the drive has a writable
 * partition now (docs/archive-drive.md). Everything downstream follows —
 * `serveRemux` reads each session's own directory, and the archive cache
 * measures free space HERE rather than assuming the card, so moving this moves
 * the allowance with it.
 */
const HLS_DIR = process.env.HLS_ROOT || path.join(ROOT, 'hls');
/* Kept programmes. Whole files rather than a rolling window, so this wants the
   drive for the same reason downloads do. */
const RECORDINGS_DIR = process.env.RECORDINGS_ROOT || path.join(ROOT, 'recordings');
/* A conversion fetched from this recently has somebody watching it, so it is
   never cleared away to make room for a new one. Comfortably longer than a
   segment, short enough that an abandoned encode stops wasting the Pi. */
const SESSION_ACTIVE_MS = 25_000;
/** Containers a browser will open directly. Anything else needs remuxing. */
const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'mov']);
// Where downloads land. Overridable so a future writable partition on the
// external drive can take them (docs/archive-drive.md, "Using the drive for
// downloads") — set DOWNLOADS_ROOT in ecosystem.config.js and restart; every
// gate, the allowance, and the health panel follow it automatically, because
// they all measure this directory rather than assuming the SD card.
const DOWNLOAD_DIR = process.env.DOWNLOADS_ROOT || path.join(ROOT, 'downloads');
const DOWNLOAD_INDEX = path.join(DOWNLOAD_DIR, 'index.json');

/* The external archive drive. ARCHIVE_ROOT is where it mounts — different on
 * the Mac it was scanned from than on the Pi it plays from — while the index
 * itself is path-relative and therefore the same file in both places. */
const archive = require('./local-library');
const guide = require('./epg-guide');
const people = require('./people');
const providers = require('./providers');
const recordings = require('./recordings');
const recommend = require('./recommend');
const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || '/mnt/archive';
const ARCHIVE_INDEX = path.join(ROOT, 'library-index.ndjson');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------ state files

 * Profiles, prefs and the download index are the only things here that can't
 * be rebuilt from the provider. They were being written straight over the top
 * of themselves, so a restart or power cut mid-write truncated the file — and
 * the readers then treated an unparseable file as "empty" and cheerfully
 * overwrote it on the next save. That is how a profile, its watch history and
 * a whole download list disappear at once.
 *
 * Writes now land in a temp file and are renamed into place, which is atomic
 * on a single filesystem: the file is either the old contents or the new one,
 * never a half-written mix. Reads that fail to parse set the damaged file
 * aside instead of pretending it was empty.
 */

function writeJsonAtomic(file, value, opts = {}) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, opts.pretty === false ? 0 : 2), opts.mode ? { mode: opts.mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (err) {
    // A full disk is the expected failure here. The temp file must go, or the
    // scratch copies pile up and consume the very space that is short. The
    // real file is untouched — that is the whole point of writing aside first.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    // Never throw: this is called from stream handlers and timers where an
    // exception would take the process down mid-download.
    console.error(`  could not save ${path.basename(file)}: ${err.message}`);
    return false;
  }
  if (opts.mode) {
    try {
      fs.chmodSync(file, opts.mode);
    } catch {
      /* best effort */
    }
  }
  return true;
}

/* ---- free space ----

 * Downloads were queued with no regard for whether the card could hold them,
 * so a ten-episode season simply ran the Pi out of space. Everything that
 * writes then breaks at once, including the JSON state files.
 */

// The floor under the Pi's own storage: this much stays free, always. Every
// download is refused up front if it would dip under it, a running conversion
// checks it before starting, and incoming work is parked when the disk
// reaches it — the SD card can never be crowded to the brim by this app.
const SPACE_RESERVE = 2 * 1024 * 1024 * 1024;

function diskFree(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dir);
      return st.bavail * st.bsize;
    }
  } catch {
    /* fall through */
  }
  try {
    const out = require('child_process').execFileSync('df', ['-k', dir], { encoding: 'utf8' });
    const cols = out.trim().split('\n').pop().split(/\s+/);
    const avail = Number(cols[3]);
    if (Number.isFinite(avail)) return avail * 1024;
  } catch {
    /* no df either */
  }
  return Number.POSITIVE_INFINITY; // unknown: don't block the user
}

function isNoSpace(err) {
  return err && (err.code === 'ENOSPC' || /ENOSPC|no space left/i.test(err.message || ''));
}

function gb(bytes) {
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/**
 * Read JSON state. On corruption the file is preserved under a .corrupt-<ts>
 * name and null is returned, so the caller starts fresh without the damaged
 * original being destroyed by the next write.
 */
function readJsonState(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // genuinely absent — nothing to protect
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const kept = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, kept);
    } catch {
      /* best effort */
    }
    console.error(
      `\n  ${label} was unreadable (${err.message}).\n` +
        `  The damaged file is kept at ${path.basename(kept)} — starting empty.\n`
    );
    return null;
  }
}

/* ------------------------------------------------------------------ config */

function readConfig() {
  try {
    return readJsonState(CONFIG_PATH, 'config.json');
  } catch {
    return null;
  }
}

function writeConfig(cfg) {
  const ok = writeJsonAtomic(CONFIG_PATH, cfg, { mode: 0o600 });
  // `mode` only applies when the file is created; re-assert it on overwrite.
  // Skip when the write failed — chmod on a missing file throws, and a full
  // disk during first-time setup used to take the request down with it.
  if (ok) {
    try {
      fs.chmodSync(CONFIG_PATH, 0o600);
    } catch {
      /* best effort */
    }
  }
  return ok;
}

/**
 * This provider carries 57k live channels, 178k movies and 46k series across
 * every language it sells. Shipping all of that to a phone is what makes the
 * library take forever to appear. These patterns keep the English/US sections.
 *
 * The naming convention differs per section, which is why there are three:
 *   live    "US| PRIME ᴿᴬᵂ"        → pipe after the country code
 *   movies  "EN - ACTION"          → dash after the language code
 *   series  "ENGLISH SERIES"       → no code at all
 *
 * Anchoring at the start matters — it keeps "ENGLISH SERIES" while dropping
 * "SOMALIA ENGLISH SERIES", "HEBREW EN SERIES" and "INDIA EN DUBBED".
 */
const DEFAULT_FILTERS = {
  live: '^US\\|',
  movies: '^EN\\s*-',
  // English series plus the platform categories (NETFLIX SERIES, HBO MAX…).
  // Anchoring start still excludes the country-prefixed foreign versions
  // ("GERMANY NETFLIX", "FRANCE NETFLIX"). No \b after the alternation — a
  // word boundary can never sit between "+" and a space, which silently
  // dropped every DISNEY+ and APPLE+ category.
  series: '^(ENGLISH\\b|NETFLIX|HBO MAX|DISNEY\\+|APPLE\\+|AMAZON)',
};

/** Pre-platform default; stored prefs equal to it are upgraded, not honored. */
const LEGACY_SERIES_FILTER = '^ENGLISH\\b';

/**
 * Preferences live on the server, not in localStorage, so pinned categories
 * and favorites follow you between the laptop, the iPad and the phone.
 */
function readPrefsRaw() {
  try {
    const parsed = readJsonState(PREFS_PATH, 'prefs.json');
    if (!parsed) return null;
    return {
      pinnedCategories: Array.isArray(parsed.pinnedCategories) ? parsed.pinnedCategories : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      captionTrack: typeof parsed.captionTrack === 'string' ? parsed.captionTrack : '',
      lowBandwidth: parsed.lowBandwidth === true,
      prebufferSeconds: Number(parsed.prebufferSeconds) || DEFAULT_PREBUFFER,
      filtersEnabled: parsed.filtersEnabled !== false,
      filters: { ...DEFAULT_FILTERS, ...(parsed.filters || {}) },
    };
  } catch {
    return null;
  }
}

function readPrefs() {
  const parsed = readPrefsRaw();
  if (parsed) {
    // The Pi's stored prefs carry the old series filter; if the user never
    // customized it, upgrade to the platform-inclusive default.
    if (parsed.filters.series === LEGACY_SERIES_FILTER) {
      parsed.filters.series = DEFAULT_FILTERS.series;
    }
    return parsed;
  }
  return {
    pinnedCategories: [],
    favorites: [],
    captionTrack: '',
    lowBandwidth: false,
    prebufferSeconds: DEFAULT_PREBUFFER,
    filtersEnabled: true,
    filters: { ...DEFAULT_FILTERS },
  };
}

function writePrefs(prefs) {
  writeJsonAtomic(PREFS_PATH, prefs);
}

/* ---------------------------------------------------------------- profiles

 * Netflix-style personas: each one carries its own favorites, pinned
 * categories, watch history and ratings. They are NOT security boundaries —
 * switching between existing ones is open, exactly like a TV app. The server
 * has no auth of its own, so the network it sits on is the real perimeter.
 *
 * Creating and deleting used to demand a password always. It is now optional
 * and off by default: `profileLock` says whether the gate is engaged, and the
 * password itself stays stored either way so turning the lock back on does not
 * mean picking a new one. Since the lock was never a security boundary — the
 * network is — asking for a password on a box only close friends can reach was
 * friction spent for nothing.
 *
 * Toggling the lock needs the password in BOTH directions. Off→on without it
 * would let anyone lock everyone else out of a control they could not undo.
 */

const PROFILE_SEED_PASSWORD = 'Little9';
const HISTORY_LIMIT = 600;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, auth) {
  if (!auth || typeof password !== 'string' || !password) return false;
  const candidate = crypto.scryptSync(password, auth.salt, 64);
  const stored = Buffer.from(auth.hash, 'hex');
  // Constant-time compare so a wrong guess doesn't leak how wrong it was.
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function readProfiles() {
  let data;
  try {
    data = readJsonState(PROFILES_PATH, 'profiles.json') || {};
  } catch {
    data = {};
  }
  if (!Array.isArray(data.profiles)) data.profiles = [];
  // Seed the gate on first run rather than storing the password in the clear.
  if (!data.auth) data.auth = hashPassword(PROFILE_SEED_PASSWORD);
  // Off unless someone deliberately turned it on — including on the boxes that
  // already had a password, where it was never a choice anyone made.
  if (typeof data.profileLock !== 'boolean') data.profileLock = false;
  return data;
}

/**
 * How much this profile may keep on the box, in bytes, or Infinity.
 *
 * Named rather than flagged: this is a house of a few people who all know each
 * other, the box belongs to Hunter, and a `limitless: true` field on a profile
 * anyone can edit from the profile screen would be a limit in name only.
 */
// 20GB since the archive drive arrived: films that used to live on the SD
// card's little free slice live on the drive now, so the card's space is
// downloads' to spend.
const DOWNLOAD_ALLOWANCE = 20 * 1024 * 1024 * 1024;

/**
 * Whose box this is.
 *
 * By name, for the same reason the allowance is: this is a house of a few
 * people who all know each other, and a `owner: true` field on a profile
 * anyone can edit from the profile screen would be ownership in name only.
 */
const OWNER_PROFILE = 'hunter';

function isOwnerProfile(profile) {
  return String(profile?.name || '').trim().toLowerCase() === OWNER_PROFILE;
}

function downloadLimitFor(profile) {
  return isOwnerProfile(profile) ? Infinity : DOWNLOAD_ALLOWANCE;
}

/**
 * Bytes this profile is holding: what has landed, plus what its queued and
 * running jobs are expected to weigh. Counting only finished files would let
 * someone queue a hundred at once and sail past the allowance before the first
 * of them completed.
 */
function downloadBytesFor(profileId, exceptId = null) {
  let total = 0;
  for (const job of downloads.values()) {
    if (job.profileId !== profileId || job.id === exceptId) continue;
    total += Math.max(Number(job.bytes) || 0, Number(job.total) || 0);
  }
  return total;
}

/** The profile a job is charged to, or undefined for one made before this. */
function ownerOf(profileId) {
  if (!profileId) return undefined;
  return readProfiles().profiles.find((p) => p.id === profileId);
}

function writeProfiles(data) {
  writeJsonAtomic(PROFILES_PATH, data, { mode: 0o600 });
  try {
    fs.chmodSync(PROFILES_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

/* --------------------------------------------------------------- reports ---
 *
 * Everyone who is not Hunter gets a suggestion box where the Pi health button
 * would be. What they send lands in `reports.json` on the box, which is what
 * the Reports section of Pi health reads. That is the whole of it: no forward,
 * nowhere else for it to go, nothing that can be unreachable.
 *
 * Free text is still redacted on the way in. Nothing leaves the box now, but a
 * bug report is very often a pasted playback report and this provider puts the
 * account password inside every stream URL — and a report is a thing people
 * copy out of the panel and paste elsewhere. Stripping it at the point of
 * storage means there is no copy anywhere that carries a credential.
 */

const MAX_REPORTS = 300;
const REPORT_LIMITS = { message: 4000, contact: 200, context: 8000, page: 120 };

function readReports() {
  try {
    const data = readJsonState(REPORTS_PATH, 'reports.json');
    return Array.isArray(data?.reports) ? data.reports : [];
  } catch {
    return [];
  }
}

function writeReports(reports) {
  writeJsonAtomic(REPORTS_PATH, { reports: reports.slice(0, MAX_REPORTS) }, { mode: 0o600 });
  try {
    fs.chmodSync(REPORTS_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

/** Public shape — never leaks the auth block or the full history blob. */
function publicProfile(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    emoji: p.emoji,
    createdAt: p.createdAt,
    stats: {
      favorites: (p.favorites || []).length,
      watched: (p.history || []).length,
      rated: Object.keys(p.ratings || {}).length,
    },
  };
}

function findProfile(data, id) {
  return data.profiles.find((p) => p.id === id) || null;
}

function blankProfile(name, color, emoji) {
  return {
    id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    color,
    emoji,
    createdAt: Date.now(),
    favorites: [],
    pinnedCategories: [],
    ratings: {},
    history: [],
  };
}

/**
 * Fold the raw history into the signals a recommender actually wants, so the
 * personalization layer doesn't have to re-derive them on every request.
 */
function tasteProfile(profile) {
  const history = profile.history || [];
  const ratings = profile.ratings || {};

  const byCategory = new Map();
  for (const row of history) {
    if (!row.categoryId) continue;
    const key = `${row.kind}:${row.categoryId}`;
    const entry = byCategory.get(key) || {
      kind: row.kind,
      categoryId: row.categoryId,
      categoryName: row.categoryName || '',
      plays: 0,
      secondsWatched: 0,
      completions: 0,
      score: 0,
    };
    entry.plays += 1;
    entry.secondsWatched += Math.max(0, row.position || 0);
    if (row.completed) entry.completions += 1;

    // Finishing something is a far stronger signal than opening it, and an
    // explicit thumb outweighs both. Live has no duration to measure against,
    // so time spent stands in — half an hour on a channel counts as a full
    // watch. Without this, live viewing would contribute no signal at all.
    const watched = Math.max(0, row.position || 0);
    const ratio = row.duration
      ? Math.min(1, watched / row.duration)
      : Math.min(1, watched / 1800);
    entry.score += ratio + (row.completed ? 1 : 0) + (ratings[row.key] || 0) * 2;
    byCategory.set(key, entry);
  }

  const categoryAffinity = [...byCategory.values()].sort((a, b) => b.score - a.score);

  const continueWatching = history
    .filter((r) => {
      if (r.completed || !r.duration || !r.position) return false;
      const ratio = r.position / r.duration;
      return r.position > 60 && ratio < 0.95;
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);

  return {
    profileId: profile.id,
    categoryAffinity,
    ratings,
    continueWatching,
    recentlyWatched: [...history].sort((a, b) => b.at - a.at).slice(0, 60),
    watchedKeys: history.map((r) => r.key),
    totals: {
      titles: history.length,
      secondsWatched: history.reduce((n, r) => n + Math.max(0, r.position || 0), 0),
      completions: history.filter((r) => r.completed).length,
    },
  };
}

/* ---- crude throttle so the gate isn't trivially brute-forceable ---- */
const passwordAttempts = new Map();

function throttleKey(req) {
  return req.socket.remoteAddress || 'unknown';
}

function attemptAllowed(req) {
  const record = passwordAttempts.get(throttleKey(req));
  if (!record) return true;
  if (Date.now() > record.until) {
    passwordAttempts.delete(throttleKey(req));
    return true;
  }
  return record.fails < 5;
}

function noteAttempt(req, ok) {
  const key = throttleKey(req);
  if (ok) return passwordAttempts.delete(key);
  const record = passwordAttempts.get(key) || { fails: 0, until: 0 };
  record.fails += 1;
  record.until = Date.now() + 60000;
  passwordAttempts.set(key, record);
}

/**
 * An M3U playlist URL is usually the credentials, written as a query string:
 * `/get.php?username=…&password=…`. GET /api/config is unauthenticated, and
 * the settings panel prints whatever this returns — so the password has to
 * come off before the URL leaves the box. Host and the rest of the path stay,
 * so the screen can still say which playlist is connected.
 */
function publicPlaylistUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(user(name)?|pass(word)?|pwd|token|auth)$/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return '';
  }
}

/** Strip the password before anything goes over the wire to the browser. */
function publicConfig(cfg) {
  if (!cfg) return { configured: false };
  return {
    configured: true,
    mode: cfg.mode,
    host: cfg.host || '',
    username: cfg.username || '',
    playlistUrl: publicPlaylistUrl(cfg.playlistUrl || ''),
    epgUrl: cfg.epgUrl || '',
    epgUrls: guideSources(cfg),
    useProviderGuide: cfg.useProviderGuide !== false,
    preferredFormat: cfg.preferredFormat || 'm3u8',
    /* How many streams the house can run at once, which is a fact the screen
       needs and a password is not. */
    logins: providers.accounts(cfg).length,
    capacity: providers.capacity(cfg),
  };
}

/**
 * The outside guide feeds, as a list.
 *
 * `epgUrl` was a single optional field nobody ever filled in. It is still
 * read, so a box that had one keeps it, but the setting is a list now —
 * coverage comes from stacking a country guide against a sports one against
 * a locals one, and one box was never going to be enough.
 */
function guideSources(cfg) {
  const raw = Array.isArray(cfg?.epgUrls) ? cfg.epgUrls : [];
  const list = raw
    .map((u) => String(u || '').trim())
    // Self-healing, for a config poisoned before the settings screen stopped
    // handing back redacted URLs. `https://host/…/epg_ripper_US1.xml.gz` can
    // never resolve, so keeping it only means a feed that fails every six
    // hours forever. Dropped rather than repaired: the middle of the path is
    // genuinely gone, and the tick box puts it back in one click.
    .filter((u) => u && !u.includes('…'));
  const legacy = String(cfg?.epgUrl || '').trim();
  if (legacy && !legacy.includes('…') && !list.includes(legacy)) list.unshift(legacy);
  // Deduplicated here as well as on the way in: one feed listed twice is one
  // feed downloaded and scanned twice for exactly the same listings.
  return [...new Set(list)].slice(0, 12);
}

/* ----------------------------------------------------------------- fetching */

/** Minimal fetch built on node's http/https, with redirect following. */
function request(target, opts = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch (err) {
      return reject(new Error(`Bad URL: ${target}`));
    }
    if (!/^https?:$/.test(u.protocol)) {
      return reject(new Error('Only http and https URLs can be fetched.'));
    }
    if (opts.allowUrl) {
      const denied = opts.allowUrl(u.toString());
      if (denied) return reject(new Error(denied));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: opts.method || 'GET',
        headers: { 'user-agent': UA, ...(opts.headers || {}) },
        timeout: opts.timeout || 25000,
      },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && redirectsLeft > 0) {
          res.resume();
          let next;
          try {
            next = new URL(loc, u).toString();
          } catch {
            return reject(new Error('Bad redirect URL'));
          }
          if (opts.allowUrl) {
            const denied = opts.allowUrl(next);
            if (denied) return reject(new Error(denied));
          } else {
            // A public URL must not hop onto this network — the classic SSRF
            // of an open redirect onto link-local metadata or a neighbour.
            const fromPrivate = privateAddress(u.toString());
            const toPrivate = privateAddress(next);
            if (!fromPrivate && toPrivate) {
              return reject(new Error(toPrivate));
            }
          }
          return resolve(request(next, opts, redirectsLeft - 1));
        }
        res.finalUrl = u.toString();
        resolve(res);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
    req.end();
  });
}

function readBody(res, limit = 0) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (limit && size > limit) {
        res.destroy();
        reject(new Error('Response too large'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function collectRequestBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------- xtream urls */

function normalizeHost(host) {
  let h = String(host || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  return h;
}

function xtreamApiUrl(cfg, params) {
  const u = new URL(normalizeHost(cfg.host) + '/player_api.php');
  u.searchParams.set('username', cfg.username);
  u.searchParams.set('password', cfg.password);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.toString();
}

function buildStreamUrl(cfg, kind, streamId, ext) {
  const base = normalizeHost(cfg.host);
  const u = encodeURIComponent(cfg.username);
  const p = encodeURIComponent(cfg.password);
  if (kind === 'live') {
    const e = ext || cfg.preferredFormat || 'm3u8';
    return `${base}/live/${u}/${p}/${streamId}.${e}`;
  }
  if (kind === 'movie') return `${base}/movie/${u}/${p}/${streamId}.${ext || 'mp4'}`;
  if (kind === 'series') return `${base}/series/${u}/${p}/${streamId}.${ext || 'mp4'}`;
  throw new Error(`Unknown stream kind: ${kind}`);
}

/* ---------------------------------------------------------------- downloads

 * Pulls a movie or episode to local disk so it can be copied onto a device and
 * watched offline. Jobs run strictly one at a time: the provider account only
 * permits a single concurrent connection, so a parallel queue would just
 * produce a pile of failures.
 */

/** id → job record. Mirrored to downloads/index.json after every change. */
const downloads = new Map();
const queue = [];
let activeJob = null;
let activeRequest = null;
/* The pool slot the running download is holding, if it is a provider one. An
   archive conversion reads the drive and holds nothing. */
let releaseJobSlot = null;

function ensureDownloadDir() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function persistDownloads() {
  ensureDownloadDir();
  const rows = [...downloads.values()].map((job) => ({ ...job, _stream: undefined }));
  writeJsonAtomic(DOWNLOAD_INDEX, rows);
}

function loadDownloads() {
  ensureDownloadDir();
  let rows = [];
  try {
    rows = readJsonState(DOWNLOAD_INDEX, 'downloads/index.json') || [];
  } catch {
    return;
  }
  for (const row of rows) {
    // Anything mid-flight when the server stopped is resumable, not running.
    if (row.status === 'downloading' || row.status === 'queued') row.status = 'paused';
    downloads.set(row.id, row);
  }
}

/* ---- browser-ready conversion of finished downloads ----

 * A downloaded .mkv used to be played through an on-the-fly HLS session, and
 * every slider click outside the converted window spawned a fresh one. That
 * live-ish path caused a string of playback bugs (live-edge chasing, late
 * audio after seeks, spec-invalid target durations).
 *
 * So: once a download finishes, convert it in place to a plain .mp4 — video
 * copied bit-for-bit, audio to stereo AAC, moov up front. From then on the
 * browser plays the file natively: real duration, instant Range seeks, no
 * sessions at all. The .mkv is replaced on success only.
 */

let prepareChain = Promise.resolve();

function queuePrepare(job) {
  prepareChain = prepareChain.then(() => prepareForBrowser(job)).catch(() => {});
}

async function prepareForBrowser(job) {
  if (!job || job.status !== 'done') return;
  if (NATIVE_CONTAINERS.has(String(job.ext || '').toLowerCase())) return;
  if (!hasFfmpeg()) return;

  const src = path.join(DOWNLOAD_DIR, job.file || `${job.id}.${job.ext}`);
  if (!fs.existsSync(src)) return;
  const tmp = path.join(DOWNLOAD_DIR, `${job.id}.browser.tmp.mp4`);
  const out = path.join(DOWNLOAD_DIR, `${job.id}.mp4`);

  // The conversion writes a second full copy before the original is removed,
  // so it needs the file's own size free. Without this check ffmpeg runs for
  // twenty minutes and dies on the last write with the disk full.
  let srcSize = 0;
  try {
    srcSize = fs.statSync(src).size;
  } catch {
    return;
  }
  if (diskFree(DOWNLOAD_DIR) < srcSize + SPACE_RESERVE) {
    job.prepareError = `Not enough space to convert (needs ${gb(srcSize)} free)`;
    job.preparing = false;
    persistDownloads();
    return;
  }

  job.preparing = true;
  job.prepareError = '';
  persistDownloads();

  // Container choice needs the codec: HEVC in mp4 must carry the hvc1 tag.
  const probed = await probeSource(src);
  const args = [
    '-v', 'error', '-y',
    '-i', src,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
  ];
  if (/hevc|h265/.test(probed.codec || '')) args.push('-tag:v', 'hvc1');
  args.push(
    // Same fixed profile and rate as the streaming remux, for the same reason.
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-ar', '48000', '-b:a', '160k',
    // moov at the front so seeking works the moment playback starts.
    '-movflags', '+faststart',
    tmp
  );

  const ok = await new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err = (err + d).slice(-800)));
    proc.on('close', (code) => {
      if (code !== 0) job.prepareError = err.split('\n').filter(Boolean).pop() || `exit ${code}`;
      resolve(code === 0);
    });
    proc.on('error', (e) => {
      job.prepareError = e.message;
      resolve(false);
    });
  });

  if (ok) {
    // Replace, don't duplicate — a companion copy would double disk use on
    // the Pi. The original is only removed after the new file is in place.
    fs.renameSync(tmp, out);
    try {
      if (src !== out) fs.unlinkSync(src);
    } catch {
      /* best effort */
    }
    job.ext = 'mp4';
    job.file = path.basename(out);
    job.total = fs.statSync(out).size;
    // Done, and never to be attempted again — the backoff that got it here
    // starts fresh if this file ever somehow needs converting once more.
    job.prepareTries = 0;
    job.prepareError = '';
  } else {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing written */
    }
  }

  job.preparing = false;
  persistDownloads();
}

/* ---- keeping downloads right without anybody pressing anything ----
 *
 * There were two buttons here — Optimize and Retry — and both asked the
 * viewer to do the box's job. Optimizing is not a choice anybody would ever
 * decline: a download left in its original container plays through an
 * on-the-fly conversion, which is the exact slowness downloads exist to
 * avoid. And a download that failed because the provider hiccuped wants
 * trying again, not a button.
 *
 * So the box tends to both itself, on a backoff, and the buttons are gone.
 * Nothing here gives up on optimizing: the usual reason it fails is a full
 * disk, which stops being true the moment something is deleted, and an
 * attempt costs nothing when the file is already fine.
 */
const PREPARE_BACKOFF = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const RETRY_BACKOFF = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000];
/** A download that has failed this many times is left alone until asked. */
const MAX_DOWNLOAD_TRIES = 8;

const backoffFor = (steps, tries) => steps[Math.min(tries, steps.length - 1)];

function tendDownloads() {
  let changed = false;
  for (const job of downloads.values()) {
    // Always optimize. Anything finished but still in its original
    // container gets converted, now or on the next pass.
    if (job.status === 'done') {
      if (job.preparing || !hasFfmpeg()) continue;
      if (NATIVE_CONTAINERS.has(String(job.ext || '').toLowerCase())) continue;
      const waited = Date.now() - (job.prepareAt || 0);
      if (waited < backoffFor(PREPARE_BACKOFF, job.prepareTries || 0)) continue;
      job.prepareAt = Date.now();
      job.prepareTries = (job.prepareTries || 0) + 1;
      changed = true;
      queuePrepare(job);
      continue;
    }

    // A failed download tries again by itself. Not one that failed for a
    // reason trying again cannot fix — an allowance is spent until somebody
    // deletes something, and hammering the provider over it helps nobody.
    if (job.status === 'error' && !job.permanent) {
      const tries = job.tries || 0;
      if (tries >= MAX_DOWNLOAD_TRIES) continue;
      if (Date.now() - (job.failedAt || 0) < backoffFor(RETRY_BACKOFF, tries)) continue;
      job.status = 'queued';
      job.error = '';
      changed = true;
      queue.push(job.id);
    }
  }
  if (changed) {
    persistDownloads();
    processQueue();
  }
}

setInterval(tendDownloads, 60_000).unref();
// Sooner than the first tick after a restart: a box that came back up with
// an unoptimized download should not sit on it for a minute first.
setTimeout(tendDownloads, 10_000).unref();

/**
 * Media files are named by job id, so if the index is lost the files are still
 * there — just invisible. Re-register anything on disk the index doesn't know
 * about, rather than leaving gigabytes stranded. Titles can't be recovered
 * (they only ever lived in the index), so those are marked as recovered.
 */
/**
 * Remove scratch files no live job owns. A conversion killed by a restart or
 * a deploy leaves a .browser.tmp.mp4 of nearly the source's size sitting there
 * forever, and a failed state save can leave a .tmp-<pid>. Both are pure waste
 * and both were found taking up room on a disk that had none.
 */
function sweepScratch() {
  let freed = 0;
  for (const dir of [DOWNLOAD_DIR, ROOT]) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/\.browser\.tmp\.mp4$|\.tmp-\d+$/.test(file)) continue;
      const full = path.join(dir, file);
      try {
        freed += fs.statSync(full).size;
        fs.unlinkSync(full);
      } catch {
        /* best effort */
      }
    }
  }
  if (freed) console.log(`  cleared ${gb(freed)} of leftover scratch files`);
  return freed;
}

function reportDiskSpace() {
  const free = diskFree(DOWNLOAD_DIR);
  if (!Number.isFinite(free)) return;
  const line = `  disk: ${gb(free)} free`;
  if (free < SPACE_RESERVE) console.error(`${line}  <-- too low, downloads will refuse to start`);
  else console.log(line);
}

/* ------------------------------------------------------------------ health

 * A read-only snapshot of the box. Everything here is something that has
 * actually gone wrong at least once: the card filled and took the state files
 * with it, the provider crawled, and a Pi on a weak supply throttles itself
 * in a way that looks exactly like a bad network.
 */

/** Run a command for a snapshot value. Never throws, never blocks. */
function runBrief(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve('');
    }
    let out = '';
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      done('');
    }, timeout);
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => done(''));
    proc.on('close', () => done(out));
  });
}

function readProc(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Pi SoC temperature in °C, or null off a Pi. */
function cpuTemp() {
  const raw = readProc('/sys/class/thermal/thermal_zone0/temp').trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1000 ? n / 1000 : n; // millidegrees on Linux, degrees elsewhere
}

/**
 * Wireless signal from /proc/net/wireless — no subprocess, no permissions.
 * Level is dBm: closer to zero is stronger. Roughly, -60 and up is solid,
 * past -72 you start losing packets and streaming suffers.
 */
function wireless() {
  const text = readProc('/proc/net/wireless');
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([\w.]+):\s+\S+\s+([-\d.]+)\s+([-\d.]+)/.exec(line);
    if (!m) continue;
    const [, iface, quality, level] = m;
    const dbm = Number(level);
    if (!Number.isFinite(dbm) || dbm === 0) continue;
    return {
      kind: 'wifi',
      iface,
      dbm,
      quality: Number(quality) || null,
      level: dbm >= -60 ? 'good' : dbm >= -72 ? 'fair' : 'poor',
    };
  }
  return null;
}

function memory() {
  const text = readProc('/proc/meminfo');
  const pick = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = pick('MemTotal') ?? os.totalmem();
  const available = pick('MemAvailable') ?? os.freemem();
  return { total, available, used: total - available };
}

/**
 * Pi throttling flags. Under-voltage is the one that matters — a marginal
 * power supply produces stalls and I/O errors that read like a bad network.
 */
function decodeThrottled(text) {
  const m = /throttled=0x([0-9a-f]+)/i.exec(text || '');
  if (!m) return null;
  const bits = parseInt(m[1], 16);
  const flags = [];
  if (bits & 0x1) flags.push('under-voltage now');
  if (bits & 0x2) flags.push('CPU frequency capped');
  if (bits & 0x4) flags.push('throttled now');
  if (bits & 0x8) flags.push('at soft temperature limit');
  if (bits & 0x10000) flags.push('under-voltage has occurred');
  if (bits & 0x40000) flags.push('throttling has occurred');
  return { bits, flags, ok: bits === 0 };
}

async function readHealth() {
  const free = diskFree(DOWNLOAD_DIR);
  let diskTotal = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(DOWNLOAD_DIR);
      diskTotal = st.blocks * st.bsize;
    }
  } catch {
    /* unknown */
  }

  const [throttleRaw, linkRaw] = await Promise.all([
    runBrief('vcgencmd', ['get_throttled']),
    runBrief('sh', ['-c', 'iw dev $(iw dev | awk "/Interface/ {print \\$2; exit}") link 2>/dev/null']),
  ]);

  const net = wireless();
  if (net) {
    const bitrate = /tx bitrate:\s*([\d.]+)\s*MBit\/s/i.exec(linkRaw);
    if (bitrate) net.bitrateMbps = Number(bitrate[1]);
    const ssid = /SSID:\s*(.+)/.exec(linkRaw);
    if (ssid) net.ssid = ssid[1].trim();
  }

  const jobs = [...downloads.values()];
  const rate = currentThroughput();

  // The archive drive's space, when the feature is in use at all. Read live
  // rather than cached: the panel polls every four seconds and "is the drive
  // still there" is half of what this row is for.
  let archiveDisk = null;
  {
    const st = archive.status();
    if (st.indexed || st.mounted) {
      if (!st.mounted) {
        archiveDisk = { mounted: false, free: null, total: null };
      } else {
        let total = null;
        try {
          const f = fs.statfsSync(ARCHIVE_ROOT);
          total = f.blocks * f.bsize;
        } catch {
          /* mounted but unreadable — show what we can */
        }
        const archFree = diskFree(ARCHIVE_ROOT);
        archiveDisk = {
          mounted: true,
          free: Number.isFinite(archFree) ? archFree : null,
          total,
        };
      }
    }
  }

  return {
    disk: {
      free: Number.isFinite(free) ? free : null,
      total: diskTotal,
      reserve: SPACE_RESERVE,
      low: Number.isFinite(free) && free < SPACE_RESERVE,
    },
    archive: archiveDisk,
    network: net || { kind: 'wired', level: 'good' },
    provider: {
      streaming: providerStreams > 0,
      // Measured off real traffic; null when nothing is pulling right now.
      bytesPerSec: rate,
      // Roughly what a 1080p stream needs. Below this, expect buffering.
      needBytesPerSec: 400 * 1024,
    },
    cpu: {
      tempC: cpuTemp(),
      load1: os.loadavg()[0],
      cores: os.cpus().length || 1,
    },
    memory: memory(),
    power: decodeThrottled(throttleRaw),
    downloads: {
      active: activeJob ? { name: activeJob.name, bytes: activeJob.bytes, total: activeJob.total } : null,
      queued: queue.length,
      stored: jobs.filter((j) => j.status === 'done').length,
      failed: jobs.filter((j) => j.status === 'error').length,
    },
    uptime: { host: os.uptime(), server: process.uptime() },
    update: readUpdateState(),
    // What is actually running. The browser portal knows its own version
    // because it IS the version; the TV app is a separate front end against
    // the same box, and "which build am I looking at" is the first question
    // of every report about it.
    version: VERSION,
    now: Date.now(),
  };
}

/**
 * What the auto-updater last did, if it is running at all.
 *
 * Written by scripts/auto-update.sh every couple of minutes. Read rather
 * than computed here on purpose: answering "is there a newer commit?" from
 * inside the server would mean spawning git and talking to GitHub on every
 * health poll, and the updater already knows.
 *
 * A missing or stale file is itself the answer — the panel says the updater
 * has stopped checking, which is a thing that has happened and was
 * invisible for a whole evening.
 */
function readUpdateState() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, '.auto-update-state.json'), 'utf8'));
    return {
      at: Number(raw.at) || 0,
      state: String(raw.state || ''),
      local: String(raw.local || ''),
      remote: String(raw.remote || ''),
      heldSince: Number(raw.heldSince) || 0,
      appliedAt: Number(raw.appliedAt) || 0,
      appliedSha: String(raw.appliedSha || ''),
    };
  } catch {
    return null;
  }
}

function recoverOrphanedDownloads() {
  let files;
  try {
    files = fs.readdirSync(DOWNLOAD_DIR);
  } catch {
    return 0;
  }

  const known = new Set([...downloads.values()].map((j) => j.id));
  let found = 0;

  for (const file of files) {
    const m = /^([\w-]+)\.(mp4|m4v|mov|mkv|avi|ts)$/i.exec(file);
    if (!m) continue;
    const [, id, ext] = m;
    if (known.has(id)) continue;

    let size = 0;
    try {
      size = fs.statSync(path.join(DOWNLOAD_DIR, file)).size;
    } catch {
      continue;
    }
    if (size < 1024 * 1024) continue; // ignore stubs and scratch

    downloads.set(id, {
      id,
      name: `Recovered download (${(size / 1073741824).toFixed(2)} GB)`,
      kind: 'movie',
      streamId: '',
      sourceUrl: '',
      ext: ext.toLowerCase(),
      poster: '',
      resumeKey: '',
      seriesId: '',
      seriesName: '',
      season: 0,
      episode: 0,
      bytes: size,
      total: size,
      status: 'done',
      file,
      recovered: true,
      error: '',
      createdAt: Date.now(),
      finishedAt: Date.now(),
    });
    found += 1;
  }

  if (found) {
    persistDownloads();
    console.log(`  recovered ${found} download(s) found on disk but missing from the index`);
  }
  return found;
}

function safeName(name) {
  return String(name || 'download')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'download';
}

function jobPaths(job) {
  return {
    part: path.join(DOWNLOAD_DIR, `${job.id}.part`),
    final: path.join(DOWNLOAD_DIR, `${job.id}.${job.ext || 'mp4'}`),
  };
}

function partSize(job) {
  try {
    return fs.statSync(jobPaths(job).part).size;
  } catch {
    return 0;
  }
}

/** Resolve the provider URL for a job at download time, not enqueue time. */
function jobSourceUrl(job) {
  if (job.sourceUrl) return job.sourceUrl;
  const cfg = readConfig();
  if (!cfg || cfg.mode !== 'xtream') throw new Error('Provider is not configured');
  /* Whichever login has room. A download is the lowest-priority thing that
     touches the provider — it yields to anybody pressing play — so it takes
     the account nobody else is on, and only starts at all when the queue
     below has found a free slot for it. */
  const account = providers.pick(cfg) || cfg;
  return buildStreamUrl(account, job.kind === 'series' ? 'series' : 'movie', job.streamId, job.ext);
}

/**
 * Save an archive title to the box, in something a phone will actually play.
 *
 * The drive holds 5,853 files and most of them are .avi and .mkv, which no
 * phone opens — so "save this to my device" cannot just hand over the bytes
 * on the drive for those. It converts, once, into the downloads folder, and
 * from there the ordinary Save to device button puts a plain .mp4 in Files
 * or the camera roll.
 *
 * Straight from the drive to the finished file: no copy first, so it needs
 * room for one output rather than two, and one pass rather than a fetch and
 * then a conversion. The drive is mounted read-only and is only ever read
 * here — nothing about this writes to it.
 *
 * A conversion cannot resume from the middle the way a download resumes from
 * a byte offset, so pausing one and starting it again starts it again. It is
 * a local file, which is the one case where that costs only time.
 */
async function runArchiveJob(job) {
  if (!hasFfmpeg()) throw new Error('ffmpeg is not installed, so this cannot be converted.');
  if (!archive.mounted()) throw new Error('The archive drive is not plugged in.');
  const abs = archive.resolve(job.archivePath);
  if (!abs || !fs.existsSync(abs)) {
    throw new Error('That file is not on the drive any more.');
  }
  const entry = archive.entry(job.archivePath) || {};

  let srcSize = 0;
  try {
    srcSize = fs.statSync(abs).size;
  } catch {
    /* the size is an estimate; carry on without one */
  }

  // The same two guards a provider download gets, for the same reasons: an
  // allowance is per profile, and the card must not be filled to the brim.
  // Checked against the SOURCE size, which for a conversion is an upper
  // bound worth trusting — the output is usually smaller.
  if (srcSize > 0) {
    const allowance = downloadLimitFor(ownerOf(job.profileId));
    const used = downloadBytesFor(job.profileId, job.id);
    if (Number.isFinite(allowance) && used + srcSize > allowance) {
      const full = new Error(
        `${job.name || 'That'} is ${gb(srcSize)} and you have `
        + `${gb(Math.max(0, allowance - used))} of your ${gb(allowance)} left. `
        + 'Delete something from Downloads to make room.'
      );
      full.permanent = true;
      throw full;
    }
    const free = diskFree(DOWNLOAD_DIR);
    if (free < srcSize + SPACE_RESERVE) {
      const err = new Error(`Not enough disk space — needs ${gb(srcSize)}, only ${gb(free)} free`);
      err.code = 'ENOSPC';
      throw err;
    }
  }

  const out = path.join(DOWNLOAD_DIR, `${job.id}.mp4`);
  try {
    fs.unlinkSync(out);   // whatever a stopped attempt left behind
  } catch {
    /* nothing there */
  }

  job.status = 'downloading';
  job.error = '';
  job.bytes = 0;
  job.total = srcSize;
  persistDownloads();

  // Copy the picture when the phone can already decode it, encode when it
  // cannot — the same decision playback makes, for the same reason: a third
  // of this drive is MPEG-4 ASP, which copies through to a black rectangle.
  const codec = String(entry.vcodec || (await probeSource(abs)).codec || '').toLowerCase();
  const args = ['-v', 'error', '-nostats', '-hide_banner', '-y',
    // Its own position, machine-readable, on stdout — the only honest
    // measure of how far through a conversion is.
    '-progress', 'pipe:1',
    '-i', abs, '-map', '0:v:0', '-map', '0:a:0?'];
  if (['h264', 'hevc', 'h265'].includes(codec)) {
    args.push('-c:v', 'copy');
    if (codec !== 'h264') args.push('-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  }
  args.push(
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-ar', '48000', '-b:a', '160k',
    // moov at the front, so the file is seekable the moment it opens.
    '-movflags', '+faststart',
    out
  );

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Pause, cancel and the auto-pause when a stream starts all reach a
  // running download by destroying `activeRequest`. Wearing the same shape
  // means every one of those paths works here without knowing what this is.
  activeRequest = { destroy: () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } } };

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

  /* How far through it is, in the only unit that means anything here.
   *
   * A download has a content length, so bytes-of-bytes is a real fraction.
   * A conversion has no such number: the output of an old .avi is usually a
   * fraction of the source, so measuring the growing file against the
   * source's size shows a bar that creeps to a third and then jumps to
   * done — which reads as stuck. ffmpeg will report its own position through
   * `-progress`, and the index already knows the runtime, so the honest
   * fraction is minutes converted out of minutes total. */
  job.convertDuration = Number(entry.duration) || 0;
  job.convertSeconds = 0;
  let tail = '';
  proc.stdout.on('data', (d) => {
    tail = (tail + d).slice(-4000);
    let m;
    const re = /out_time_us=(\d+)/g;
    while ((m = re.exec(tail))) job.convertSeconds = Number(m[1]) / 1e6;
  });

  const ticker = setInterval(() => {
    try {
      job.bytes = fs.statSync(out).size;
    } catch {
      /* not written yet */
    }
    persistDownloads();
  }, 1500);
  ticker.unref?.();

  const code = await new Promise((resolve) => {
    proc.on('exit', resolve);
    proc.on('error', () => resolve(-1));
  });
  clearInterval(ticker);
  activeRequest = null;

  // Stopped on purpose: the half-written file is no use to anybody, and
  // unlike a partial download it cannot be continued.
  if (job.status === 'cancelled' || job.status === 'paused') {
    try {
      fs.unlinkSync(out);
    } catch {
      /* already gone */
    }
    return;
  }

  if (code !== 0) {
    try {
      fs.unlinkSync(out);
    } catch {
      /* already gone */
    }
    throw new Error(stderr.split('\n').filter(Boolean).pop() || `ffmpeg exited ${code}`);
  }

  job.file = path.basename(out);
  job.ext = 'mp4';
  job.status = 'done';
  try {
    job.bytes = fs.statSync(out).size;
  } catch {
    /* keep the last tick's figure */
  }
  job.total = job.bytes;
  job.finishedAt = Date.now();
  job.tries = 0;
  job.permanent = false;
  persistDownloads();
  // No queuePrepare: this came out as mp4 by construction.
}

async function runJob(job) {
  // A title off the archive drive has no provider URL behind it — it is
  // converted from the file itself.
  if (job.archivePath) return runArchiveJob(job);

  const { part, final } = jobPaths(job);
  const start = partSize(job);

  job.status = 'downloading';
  job.error = '';
  job.bytes = start;
  persistDownloads();

  const headers = {};
  if (start > 0) headers.range = `bytes=${start}-`;

  /* The URL carries the login the pool chose; the slot is taken here, where
     the socket actually opens, and given back in the queue's finally block
     however the job ends. Without this a download would be invisible to the
     pool and a second stream could be started on a login already carrying
     one. */
  const source = jobSourceUrl(job);
  const holding = providers.forUrl(readConfig(), source);
  releaseJobSlot = holding ? providers.take(holding.id) : null;
  const upstream = await request(source, { headers, timeout: 60000 });
  activeRequest = upstream;

  const code = upstream.statusCode || 0;
  if (code >= 400) {
    upstream.resume();
    throw new Error(`Provider returned HTTP ${code}`);
  }

  // If we asked to resume but got a fresh 200, the server ignored the Range
  // request and is sending from byte zero — throw the partial file away.
  const resuming = code === 206 && start > 0;
  if (start > 0 && !resuming) {
    try {
      fs.unlinkSync(part);
    } catch {
      /* nothing to remove */
    }
    job.bytes = 0;
  }

  const declared = Number(upstream.headers['content-length'] || 0);
  job.total = resuming ? job.bytes + declared : declared;
  persistDownloads();

  // The allowance is checked again here, because this is the first moment the
  // file's size is known. The check at the request only knows what is already
  // used, so without this one a profile sitting at zero could take a single
  // 5GB film and be over the line before anything could object.
  if (job.total > 0) {
    const allowance = downloadLimitFor(ownerOf(job.profileId));
    const used = downloadBytesFor(job.profileId, job.id);
    if (Number.isFinite(allowance) && used + job.total > allowance) {
      upstream.destroy();
      try {
        fs.unlinkSync(part);   // it is never going to be resumed
      } catch {
        /* nothing partial to remove */
      }
      job.bytes = 0;
      const full = new Error(
        `${job.name || 'That'} is ${gb(job.total)} and you have `
        + `${gb(Math.max(0, allowance - used))} of your ${gb(allowance)} left. `
        + 'Delete something from Downloads to make room.'
      );
      full.permanent = true;   // trying again changes nothing; deleting does
      throw full;
    }
  }

  // Now that the real size is known, check the card can actually take it.
  // Refusing up front beats filling the disk and breaking every other write.
  if (declared > 0) {
    const free = diskFree(DOWNLOAD_DIR);
    if (free < declared + SPACE_RESERVE) {
      upstream.destroy();
      const err = new Error(
        `Not enough disk space — needs ${gb(declared)}, only ${gb(free)} free`
      );
      err.code = 'ENOSPC';
      throw err;
    }
  }

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });
    let lastPersist = Date.now();

    upstream.on('data', (chunk) => {
      job.bytes += chunk.length;
      meterBytes(chunk.length);
      // Throttle index writes; the byte counter changes thousands of times.
      if (Date.now() - lastPersist > 1500) {
        lastPersist = Date.now();
        persistDownloads();
      }
    });

    upstream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);

    // Pausing or cancelling destroys the socket. That fires 'close' on the
    // readable but never 'finish' on the writable, so without this the promise
    // would hang forever and wedge the queue behind a job that already stopped.
    upstream.on('close', () => {
      if (job.status === 'paused' || job.status === 'cancelled') out.end();
    });

    upstream.pipe(out);
  });

  // A pause or cancel tears down the socket mid-transfer; the partial file is
  // intact and must not be promoted to a finished download.
  if (job.status === 'cancelled' || job.status === 'paused') return;

  fs.renameSync(part, final);
  job.status = 'done';
  job.file = path.basename(final);
  job.total = job.bytes;
  job.finishedAt = Date.now();
  // It got here in the end, so whatever went wrong before is history.
  job.tries = 0;
  job.permanent = false;
  persistDownloads();
  queuePrepare(job); // make it browser-native before it's ever played
}

/* ---- playback vs downloads: playback always wins the one connection ----

 * The account allows a single concurrent connection, so a download running
 * while something streams degrades both. Watching takes priority: starting
 * any provider-sourced stream pauses the active download on the spot, the
 * queue holds while anything is streaming, and paused work resumes on its own
 * once the connection has been quiet for a few seconds.
 */

let providerStreams = 0;          // live /stream connections currently piping
let lastProviderActiveAt = 0;     // last moment anything at all was streaming
let lastSlotsFullAt = 0;          // last moment there was no room to start one
const RESUME_GRACE_MS = 8000;     // idle time required before downloads resume

/**
 * Last time a file on disk was served to a player. A finished download touches
 * neither the provider nor a remux session, so without this it looks exactly
 * like an idle box — and /api/activity would wave the auto-updater through
 * while somebody was halfway through a film.
 *
 * A timestamp rather than an in-flight count on purpose: Safari plays video as
 * a long series of short range requests, so a counter sits at zero between
 * them and reads idle at the wrong moment.
 */
let localPlaybackAt = 0;

/** One incompressible block, reused for every /api/speedtest response. */
const SPEEDTEST_CHUNK = crypto.randomBytes(64 * 1024);

/* ---- provider throughput meter ----
 *
 * The one number that actually predicts whether a stream will play smoothly.
 * Both paths that pull from the provider — streaming and downloading — feed
 * the same counter, so the health panel reports real measured bytes rather
 * than a link rate that says nothing about the upstream service.
 */

const meter = { bytes: 0, since: Date.now(), rate: 0, at: 0 };

function meterBytes(n) {
  meter.bytes += n;
  const elapsed = Date.now() - meter.since;
  if (elapsed >= 2000) {
    meter.rate = (meter.bytes / elapsed) * 1000; // bytes per second
    meter.at = Date.now();
    meter.bytes = 0;
    meter.since = Date.now();
  }
}

/** Rate is only meaningful while something is actually pulling. */
function currentThroughput() {
  if (!meter.at || Date.now() - meter.at > 15000) return null;
  return meter.rate;
}

/**
 * Is there any room left on the provider?
 *
 * This used to be "is anything streaming", because one account meant one
 * stream and the two questions had one answer. With a pool it is a question
 * about SLOTS: a box with two logins and one film playing is busy in the old
 * sense and not busy in the sense that matters, which is whether the next
 * thing can start.
 *
 * TWO timestamps come out of this, and the difference between them is the
 * whole reason a second login was worth buying.
 *
 * `lastProviderActiveAt` marks the last moment ANYTHING was streaming. The
 * auto-updater reads it, and rightly: restarting the box under somebody
 * watching a film is rude however many logins paid for it.
 *
 * `lastSlotsFullAt` marks the last moment there was NO ROOM. That is the one
 * the download queue waits on. Stamping the queue's grace period off "anything
 * streaming" is what made a second login do nothing: the timestamp is
 * refreshed on every check while a film plays, so the window never opens and
 * the download sits at "Waiting for the connection" for the length of the
 * film — with a whole free login next to it. On a single-account box the two
 * timestamps move together and nothing changes.
 */
function providerBusy() {
  // A finished remux (ffmpeg exited) plays from disk and holds nothing.
  const remuxing = [...remuxSessions.values()].some((s) => s.fromProvider && !s.exited);
  if (providerStreams > 0 || remuxing) lastProviderActiveAt = Date.now();
  const cfg = readConfig();
  const accounts = providers.accounts(cfg);
  // No pool to ask (M3U mode, or a box configured before this existed with a
  // single loose account): the old question, unchanged.
  const busy = accounts.length
    ? providers.busy(cfg)
    : (providerStreams > 0 || remuxing);
  if (busy) lastSlotsFullAt = Date.now();
  return busy;
}

/**
 * Called the moment a stream starts; puts the running download on ice — but
 * only when that stream took the last slot. Two logins means a download and a
 * film can run side by side, and pausing one for the other out of habit would
 * throw away the connection that was paid for.
 */
function autoPauseActiveDownload() {
  if (!providerBusy()) return;
  const job = activeJob;
  if (!job || job.status !== 'downloading') return;
  // This exists to hand the provider's one connection back to playback. A
  // conversion off the archive drive is not holding it, so pausing that one
  // buys nothing and costs the viewer their progress.
  if (job.archivePath) return;
  job.status = 'paused';
  job.autoPaused = true; // resumes by itself, unlike a manual pause
  if (activeRequest) {
    try {
      activeRequest.destroy();
    } catch {
      /* already torn down */
    }
  }
  persistDownloads();
}

/** Bring auto-paused work back once a login has stayed free. */
setInterval(() => {
  // providerBusy() stamps lastSlotsFullAt, so it has to run first.
  if (providerBusy()) return;
  if (Date.now() - lastSlotsFullAt < RESUME_GRACE_MS) return;
  let resumed = false;
  for (const job of downloads.values()) {
    if (job.autoPaused && job.status === 'paused') {
      job.autoPaused = false;
      job.status = 'queued';
      queue.push(job.id);
      resumed = true;
    }
  }
  if (resumed) {
    persistDownloads();
    processQueue();
  }
}, 5000).unref();

/**
 * Park everything still waiting when the disk fills. Paused (not autoPaused)
 * so the idle-provider timer leaves them alone — they need space, not a retry.
 * They stay in the index and resume with the normal button once room is freed.
 */
function drainQueueForSpace(reason) {
  let stalled = 0;
  while (queue.length) {
    const job = downloads.get(queue.shift());
    if (!job || job.status === 'cancelled') continue;
    job.status = 'paused';
    job.autoPaused = false;
    job.error = reason;
    stalled += 1;
  }
  if (stalled) persistDownloads();
  return stalled;
}

let queuePumping = false;

async function processQueue() {
  if (queuePumping) return;
  queuePumping = true;
  try {
    while (queue.length) {
      // Hold while anything streams, plus a grace window so channel-flipping
      // doesn't bounce the download up and down between every change.
      //
      // Except for the archive drive. That queue waits on the provider's
      // single connection, and a title being converted off a local disk does
      // not use it — so a viewer who asked for one while watching something
      // saw it sit at "Waiting for the connection", with no connection to
      // wait for and no sign of progress. Those are pulled out of the queue
      // and run regardless; everything else still waits its turn.
      let id;
      /* The rule that used to be "wait until nothing is streaming" is now
         "wait until a login has room". With one account those are the same
         sentence; with two, a download runs happily beside somebody watching
         a film, which is the whole point of the second login. The grace
         period stays: a slot released a moment ago is often about to be
         taken again by the same viewer changing their mind — which is why it
         waits on the last moment the box was FULL, not on the last moment
         anything was playing. Those are the same instant on one account and
         very different ones on two. */
      if (providerBusy() || Date.now() - lastSlotsFullAt < RESUME_GRACE_MS) {
        const at = queue.findIndex((qid) => downloads.get(qid)?.archivePath);
        if (at < 0) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        id = queue.splice(at, 1)[0];
      } else {
        id = queue.shift();
      }
      const job = downloads.get(id);
      if (!job || job.status === 'cancelled' || job.status === 'paused') continue;

      activeJob = job;
      try {
        await runJob(job);
      } catch (err) {
        // A deliberate pause/cancel aborts the socket too — don't report those
        // as failures. Partial data stays on disk so a retry resumes.
        if (job.status !== 'cancelled' && job.status !== 'paused') {
          job.status = 'error';
          job.error = err.message;
          // What the automatic retry needs to know: when this happened, how
          // many times it has now happened, and whether trying again could
          // ever help. An allowance that is spent stays spent until somebody
          // deletes something, so that one is left alone.
          job.failedAt = Date.now();
          job.tries = (job.tries || 0) + 1;
          job.permanent = Boolean(err.permanent);
          persistDownloads();
        }
        // A full disk fails every remaining job identically, and each one
        // leaves its own half-written .part behind — which is exactly how
        // several GB of unusable fragments accumulated. Stop the whole queue
        // on the first one and say so, rather than grinding through the rest.
        if (isNoSpace(err)) {
          const stalled = drainQueueForSpace(err.message);
          console.error(`\n  Disk full — download queue stopped (${stalled} waiting).\n`);
          break;
        }
      } finally {
        activeJob = null;
        activeRequest = null;
        if (releaseJobSlot) {
          releaseJobSlot();
          releaseJobSlot = null;
        }
      }
    }
  } finally {
    queuePumping = false;
  }
}

function enqueue(job) {
  downloads.set(job.id, job);
  job.status = 'queued';
  persistDownloads();
  queue.push(job.id);
  processQueue();
  return job;
}

function cancelJob(job, { removeFile }) {
  const wasActive = activeJob && activeJob.id === job.id;
  job.status = 'cancelled';

  if (wasActive && activeRequest) {
    try {
      activeRequest.destroy();
    } catch {
      /* already torn down */
    }
  }

  const { part, final } = jobPaths(job);
  if (removeFile) {
    for (const f of [part, final]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* not present */
      }
    }
    downloads.delete(job.id);
  }
  persistDownloads();
}

/* ---- watching a file leave the box ----
 *
 * Once a file is handed to the browser as a download, the page cannot see it
 * any more: the transfer belongs to the browser, and nothing in JavaScript is
 * allowed to ask how it is going. Which left a viewer pressing Save to
 * device on a three-gigabyte film and getting a message, then nothing, for
 * several minutes — with no way to tell a slow transfer from a dead one.
 *
 * But the box is the one SENDING it, and it can count. The page asks for the
 * file with a tracking id on the URL, the bytes written to that response are
 * counted here, and the page polls for the number. That is a real progress
 * bar over the real transfer, with nothing buffered in memory and no service
 * worker — both of which were the other ways to do this, and neither of
 * which survives being served over plain http on the tailnet.
 */
const saveTransfers = new Map();
const SAVE_KEEP_MS = 10 * 60 * 1000;

function trackSave(id, { name, total }) {
  if (!id) return null;
  const existing = saveTransfers.get(id);
  // A browser may fetch a file in several range requests; they are all the
  // same save as far as anybody watching is concerned.
  const t = existing || {
    id, name, total, sent: 0, startedAt: Date.now(), endedAt: 0, at: Date.now(),
  };
  t.name = name || t.name;
  t.total = total || t.total;
  t.endedAt = 0;
  t.at = Date.now();
  saveTransfers.set(id, t);
  return t;
}

setInterval(() => {
  for (const [id, t] of saveTransfers) {
    if (Date.now() - t.at > SAVE_KEEP_MS) saveTransfers.delete(id);
  }
}, 60_000).unref();

/** Serve a completed download from disk, with Range support for seeking. */
function serveLocalFile(req, res, filePath, { attachmentName, track = '' } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return send(res, 404, 'File not found');
  }

  const type = MIME[path.extname(filePath)] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes' };

  if (attachmentName) {
    const ascii = attachmentName.replace(/[^\w.\- ]/g, '_');
    headers['content-disposition'] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachmentName)}`;
  }

  const progress = track
    ? trackSave(track, { name: attachmentName || path.basename(filePath), total: stat.size })
    : null;

  /** Count what actually reaches the wire, and say when it stops. */
  const pipeCounting = (stream) => {
    if (progress) {
      stream.on('data', (chunk) => {
        progress.sent = Math.min(progress.total, progress.sent + chunk.length);
        progress.at = Date.now();
        // Playing or saving, the box is in use either way — a restart in the
        // middle of a transfer would cut the file in half.
        localPlaybackAt = Date.now();
      });
      const finish = () => {
        if (!progress.endedAt) progress.endedAt = Date.now();
      };
      res.on('close', finish);
      res.on('finish', finish);
    }
    stream.pipe(res);
  };

  const range = req.headers.range;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || '');

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['content-length'] = end - start + 1;
    res.writeHead(206, headers);
    // A ranged save starts wherever it starts; count from there so a resumed
    // or chunked transfer still reads as a fraction of the whole file.
    if (progress && start > progress.sent) progress.sent = start;
    return pipeCounting(fs.createReadStream(filePath, { start, end }));
  }

  headers['content-length'] = stat.size;
  res.writeHead(200, headers);
  pipeCounting(fs.createReadStream(filePath));
}

/* ------------------------------------------------------------- remuxing ---

 * Series and movies come out of the provider as Matroska (.mkv). The codecs
 * inside are almost always H.264 + AAC — already fine for Safari — but no
 * browser will open the container, which is the "file type is not supported"
 * error on iOS.
 *
 * So we remux on the fly into HLS: video copied bit-for-bit, audio downmixed to
 * stereo AAC for maximum device compatibility. No video re-encoding, so it runs
 * roughly 80x realtime and is comfortable on a Raspberry Pi.
 */

let ffmpegAvailable = null;

function hasFfmpeg() {
  if (ffmpegAvailable === null) {
    const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    ffmpegAvailable = !probe.error && probe.status === 0;
  }
  return ffmpegAvailable;
}

/** sessionId → { dir, proc, lastAccess, fromProvider } */
const remuxSessions = new Map();

/**
 * How many seconds of video to bank before playback starts. ffmpeg can only
 * produce as fast as the provider serves, so starting the moment the first
 * segment lands means the player keeps catching up to the encoder and stalling
 * every few seconds. Banking a cushion up front trades a wait for smooth play.
 */
/**
 * Measured on this provider: VOD arrives at ~0.58 MB/s against a title needing
 * 0.40 MB/s — about 1.45x realtime — and the socket is dropped roughly every
 * 25 seconds. Each drop is dead air while ffmpeg reconnects.
 *
 * 45s of cushion could not absorb those gaps, which is why playback stalled
 * repeatedly. At ~1.45x this takes about two minutes of wall time to bank, and
 * once playing the lead keeps growing. Tunable via prefs.prebufferSeconds.
 */
const DEFAULT_PREBUFFER = 150;

/** Sum the EXTINF durations already written to a session's playlist. */
function remuxReadySeconds(session) {
  try {
    const text = fs.readFileSync(path.join(session.dir, 'index.m3u8'), 'utf8');
    let total = 0;
    for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) total += Number(m[1]) || 0;
    return { seconds: total, complete: text.includes('#EXT-X-ENDLIST') };
  } catch {
    return { seconds: 0, complete: false };
  }
}

/**
 * Inspect what a remux session has actually written.
 *
 * The browser can only report on the timeline it was handed. If the conversion
 * itself produced a stream whose timestamps disagree with its contents, every
 * client-side number reads as perfectly healthy — the media clock advances at
 * 1x, no frames drop, nothing stalls — while what you watch and hear is wrong.
 * Nothing in a browser can see past that, so the check has to happen here.
 *
 * The decisive comparison is the playlist's declared running time against the
 * running time the segments really contain. They should agree. A large ratio
 * between them is a conversion writing a timeline it cannot honour.
 *
 * Reads only files already on disk, so it costs no provider connection and is
 * safe to run while a film is playing.
 */
/**
 * Strip the credentials out of a provider URL.
 *
 * These reports get copied out of the health panel and pasted into a chat, and
 * the provider embeds the account in the path — `/series/<user>/<pass>/id.mkv`.
 * ffmpeg prints the URL it opened, so without this the report hands out the
 * subscription to anyone it is shown to. Host and filename are enough to tell
 * what was playing.
 */
function redactUrl(text) {
  return String(text).replace(/https?:\/\/[^\s'"]+/g, (url) => {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const tail = parts.length ? parts[parts.length - 1] : '';
      return `${u.protocol}//${u.host}/…/${tail}`;
    } catch {
      return '<url>';
    }
  });
}

function probeOutput(session) {
  // Probed per segment, deliberately, rather than by handing ffprobe the
  // playlist. Asked about an HLS playlist ffprobe reports the duration the
  // playlist *claims* — it adds up the EXTINF lines — so the two sides of the
  // comparison would come from the same source and the check could never fail.
  // A segment file is the content itself, timestamps and all.
  let segments = [];
  let declaredTotal = 0;
  try {
    const text = fs.readFileSync(path.join(session.dir, 'index.m3u8'), 'utf8');
    let pending = 0;
    for (const line of text.split('\n')) {
      const inf = /^#EXTINF:([\d.]+)/.exec(line.trim());
      if (inf) {
        pending = Number(inf[1]) || 0;
        declaredTotal += pending;
        continue;
      }
      const name = line.trim();
      if (name && !name.startsWith('#')) segments.push({ name, declared: pending });
    }
  } catch (err) {
    return Promise.resolve({ error: `couldn't read the playlist — ${err.message}` });
  }
  if (!segments.length) return Promise.resolve({ error: 'nothing written yet' });

  /* How many bits a second of this actually is, and how fast it is being
   * made. Both are cheap, and between them they answer the question the
   * report could not: a viewer running at 0.7x with the box idling at 3x
   * realtime is not waiting on the box, they are waiting on the wire — and
   * no amount of staring at drift figures says so.
   *
   * Measured over the tail rather than the whole session: a film that opens
   * on a title card and ends in a chase averages the two together, and it
   * is the part being watched now that has to fit down the connection. The
   * newest segment is skipped because it is very likely half-written. */
  let bitrate = 0;
  try {
    const tail = segments.slice(Math.max(0, segments.length - 41), segments.length - 1);
    let bytes = 0;
    let seconds = 0;
    for (const seg of tail) {
      bytes += fs.statSync(path.join(session.dir, seg.name)).size;
      seconds += seg.declared;
    }
    if (seconds > 0) bitrate = (bytes * 8) / seconds;
  } catch {
    bitrate = 0;      // a segment swept out from under us; not worth failing on
  }

  const elapsed = session.startedAt ? (Date.now() - session.startedAt) / 1000 : 0;
  const speed = elapsed > 2 ? declaredTotal / elapsed : 0;

  // Three segments answer three questions. The first carries the start of
  // each stream, which is where an audio/video offset introduced by seeking
  // shows up. A recent one says whether the timeline still matches its
  // contents. The newest of all is very likely still being written, so it is
  // skipped. The MIDDLE one exists only to check the drift is a straight
  // line — see the two half-rates below, which is what stops a measurement
  // artefact from being corrected as though it were a fault.
  const first = segments[0];
  const recent = segments[segments.length - (segments.length > 1 ? 2 : 1)];
  const middleAt = Math.floor((segments.length - (segments.length > 1 ? 2 : 1)) / 2);
  const middle = segments[middleAt];

  /**
   * ffprobe one segment. A fragmented-MP4 segment carries no headers of its
   * own, so on its own it is unreadable — stitching the init segment in front
   * of it makes a valid file.
   */
  const probeSegment = (name, tag) => new Promise((resolve) => {
    let target = path.join(session.dir, name);
    let temp = '';
    const init = path.join(session.dir, 'init.mp4');
    if (target.endsWith('.m4s') && fs.existsSync(init)) {
      try {
        temp = path.join(session.dir, `probe-${tag}.mp4`);
        fs.writeFileSync(temp, Buffer.concat([fs.readFileSync(init), fs.readFileSync(target)]));
        target = temp;
      } catch {
        temp = '';   // fall through and probe the bare segment; it may still parse
      }
    }
    const dropTemp = () => {
      // Synchronous on purpose: this file sits in the directory the segments
      // are served from, and an asynchronous unlink leaves it there for an
      // unbounded window after the probe has already reported.
      if (!temp) return;
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* best effort */
      }
    };

    const proc = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries',
        'stream=codec_type,codec_name,profile,avg_frame_rate,r_frame_rate,time_base,' +
          'sample_rate,channels,start_time,duration',
        '-show_entries', 'format=duration,start_time',
        '-of', 'json',
        target,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 25000);
    timer.unref?.();
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => {
      clearTimeout(timer);
      dropTemp();
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    proc.on('error', () => {
      clearTimeout(timer);
      dropTemp();
      resolve(null);
    });
  });

  const streamOf = (parsed, kind) =>
    (parsed?.streams || []).find((st) => st.codec_type === kind) || {};

  return Promise.all([
    probeSegment(recent.name, 'recent'),
    first.name === recent.name ? null : probeSegment(first.name, 'first'),
    middle && middle.name !== first.name && middle.name !== recent.name
      ? probeSegment(middle.name, 'middle') : null,
  ]).then(([now, opening, midway]) => {
    if (!now) return { error: 'ffprobe returned nothing readable' };
    const video = streamOf(now, 'video');
    const audio = streamOf(now, 'audio');

    // The subtraction is the whole point. A fragment's timeline does not start
    // at zero — it starts at its own base decode time — so ffprobe's duration
    // for one is the moment it ENDS, not how long it lasts. Taking it at face
    // value made a healthy six-second segment read as three minutes of content
    // and reported every conversion as broken.
    const spanOf = (parsed) => {
      const dur = Number(parsed?.format?.duration);
      const from = Number(parsed?.format?.start_time) || 0;
      if (!Number.isFinite(dur)) return 0;
      return dur > from ? dur - from : dur;
    };
    const real = spanOf(now);

    // Audio and video should begin together. Input seeking lands video on the
    // keyframe before the mark while the audio starts at the mark itself, and
    // the gap between them is heard as lip-sync drift.
    const head = opening || now;
    const vStart = Number(streamOf(head, 'video').start_time);
    const aStart = Number(streamOf(head, 'audio').start_time);
    const sync = Number.isFinite(vStart) && Number.isFinite(aStart) ? aStart - vStart : null;

    // How far apart the two tracks END, inside one segment.
    //
    // Note what this is and is not. It is a property of that segment: the
    // muxer cuts on a video keyframe and the audio frames do not land on the
    // same instant, so some gap here is normal and constant. It is NOT, on
    // its own, drift.
    const endOf = (st) => {
      const from = Number(st.start_time);
      const len = Number(st.duration);
      return Number.isFinite(from) && Number.isFinite(len) ? from + len : null;
    };
    const gapOf = (parsed) => {
      const v = endOf(streamOf(parsed, 'video'));
      const a = endOf(streamOf(parsed, 'audio'));
      return { vEnd: v, aEnd: a, gap: v !== null && a !== null ? a - v : null };
    };
    const late = gapOf(now);
    const early = opening ? gapOf(opening) : null;
    const vEnd = late.vEnd;
    const aEnd = late.aEnd;
    const drift = late.gap;

    // Drift is the gap CHANGING, so it takes two measurements.
    //
    // This used to be one segment's gap divided by how long the session had
    // been running, which assumed the gap had grown from zero without ever
    // checking — and so reported a constant per-segment ragged edge as a
    // runaway rate that got worse the longer you watched. It is now the
    // difference between the opening segment's gap and a recent one's, over
    // the time between them. A short span is refused rather than divided by:
    // two nearby segments turn a few milliseconds of noise into a percentage.
    let driftRate = null;
    let driftSpan = null;
    if (early && early.gap !== null && late.gap !== null
        && Number.isFinite(early.vEnd) && Number.isFinite(late.vEnd)) {
      const span = late.vEnd - early.vEnd;
      // Six seconds is one segment apart, which is the soonest two distinct
      // measurements exist — and the sooner a rate is available, the sooner a
      // conversion whose audio has gone wrong can be rebuilt instead of
      // watched. Anything shorter is two readings of the same moment.
      if (span >= 6) {
        driftSpan = span;
        driftRate = (late.gap - early.gap) / span;
      }
    }

    /* Is that rate a straight line, or two points with a story drawn through
     * them?
     *
     * Two points always define a rate — that is the whole problem with them.
     * A genuine mastering drift is LINEAR: the same slope in the first half of
     * the session as in the second. A measurement artefact is not, and neither
     * is a per-segment ragged edge that happens to differ at the ends.
     *
     * This exists because two unrelated titles reported large drift within a
     * day of each other — a 2008 home rip at 3.24%, which the viewer could
     * hear, and a commercial release with six language tracks at 6.86%, which
     * would put its audio two minutes early by the end and be unusable on
     * every player ever made, not just this one. One of those is a fault and
     * one is a reading. A third point tells them apart, and nothing corrects
     * anything until it has. */
    let halfEarly = null;
    let halfLate = null;
    let driftLinear = null;
    const mid = midway ? gapOf(midway) : null;
    if (driftRate !== null && mid && mid.gap !== null && Number.isFinite(mid.vEnd)) {
      const spanA = mid.vEnd - early.vEnd;
      const spanB = late.vEnd - mid.vEnd;
      if (spanA >= 4 && spanB >= 4) {
        halfEarly = (mid.gap - early.gap) / spanA;
        halfLate = (late.gap - mid.gap) / spanB;
        // Agreement to within a quarter of the rate itself, plus a floor so
        // two tiny halves are not judged on rounding noise.
        const tolerance = Math.max(Math.abs(driftRate) * 0.25, 0.002);
        driftLinear = Math.abs(halfLate - halfEarly) <= tolerance;
      }
    }

    return {
      declaredTotal,
      bitrate,
      speed,
      segment: {
        declared: recent.declared,
        real,
        // 1.0 is honest. Far from it is a conversion writing a timeline that
        // does not match the content it put in the segment.
        ratio: real && recent.declared ? recent.declared / real : 0,
      },
      start: { video: vStart, audio: aStart, sync, segment: head === now ? recent.name : first.name },
      drift: {
        video: vEnd,
        audio: aEnd,
        gap: drift,
        firstGap: early ? early.gap : null,
        rate: driftRate,
        span: driftSpan,
        // The corroboration. `linear` null means it could not be judged —
        // too few segments yet — which is not the same as judged and failed,
        // and neither of them is a licence to change anybody's audio.
        halfEarly,
        halfLate,
        linear: driftLinear,
      },
      video: {
        codec: video.codec_name || '',
        fps: video.avg_frame_rate || '',
        rawFps: video.r_frame_rate || '',
        timeBase: video.time_base || '',
      },
      audio: {
        codec: audio.codec_name || '',
        // HE-AAC here would mean half the sample rate is hiding behind SBR,
        // and a decoder that misses it plays an octave down.
        profile: audio.profile || '',
        sampleRate: Number(audio.sample_rate) || 0,
        channels: Number(audio.channels) || 0,
        timeBase: audio.time_base || '',
      },
    };
  });
}

function killSession(id) {
  const session = remuxSessions.get(id);
  if (!session) return;
  // The login this session was holding goes back in the pool with it.
  if (session.releaseSlot) {
    session.releaseSlot();
    session.releaseSlot = null;
  }
  try {
    session.proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    // A FINISHED archive conversion is a cache, not debris. Converting the
    // whole episode from the top is what keeps these old rips in sync, and
    // the first deep resume pays for it in minutes of waiting — so a
    // completed conversion is kept on disk, and the next resume of that
    // episode joins it instantly instead of paying again. Anything
    // unfinished (or not an archive title) is swept as before.
    const finished = id.startsWith('arc-')
      && fs.readFileSync(path.join(session.dir, 'index.m3u8'), 'utf8')
        .includes('#EXT-X-ENDLIST');
    if (!finished) fs.rmSync(session.dir, { recursive: true, force: true });
  } catch {
    try {
      fs.rmSync(session.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  remuxSessions.delete(id);
}

/**
 * Keep the finished-conversion cache within its allowance.
 *
 * Whole-episode conversions are worth keeping (that is what makes a second
 * resume instant) but not worth unbounded disk: oldest-touched episodes go
 * first once the cache passes its cap — OR once the card's free space falls
 * under what the caller says it needs, whichever bites first. The cap alone
 * is not enough on this Pi: the default allowance is close to the whole free
 * card, and a cache that "fits its cap" while the disk hits zero takes the
 * portal down with it. The free-space floor outranks the cap, always.
 * Directories a live session still owns are never touched, and an unfinished
 * directory with no session behind it is a crash leftover — unusable,
 * because its frontier will never advance — so it is removed on sight.
 */
const ARCHIVE_CACHE_BYTES =
  Math.max(0, Number(process.env.ARCHIVE_CACHE_GB || 10)) * 1024 ** 3;

function pruneArchiveCache(needFreeBytes = 0) {
  let names = [];
  try {
    names = fs.readdirSync(HLS_DIR);
  } catch {
    return;
  }
  const kept = [];
  for (const name of names) {
    if (!name.startsWith('arc-') || remuxSessions.has(name)) continue;
    const dir = path.join(HLS_DIR, name);
    try {
      const playlist = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
      if (!playlist.includes('#EXT-X-ENDLIST')) throw new Error('unfinished');
      let bytes = 0;
      for (const f of fs.readdirSync(dir)) {
        bytes += fs.statSync(path.join(dir, f)).size;
      }
      kept.push({ dir, mtime: fs.statSync(dir).mtimeMs, bytes });
    } catch {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  kept.sort((a, b) => a.mtime - b.mtime);
  let total = kept.reduce((sum, e) => sum + e.bytes, 0);
  const overCap = () => total > ARCHIVE_CACHE_BYTES;
  const underFloor = () => {
    if (!needFreeBytes) return false;
    const free = diskFree(HLS_DIR);
    return Number.isFinite(free) && free < needFreeBytes;
  };
  while (kept.length && (overCap() || underFloor())) {
    const oldest = kept.shift();
    try {
      fs.rmSync(oldest.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    total -= oldest.bytes;
  }
}

/**
 * Ask ffprobe about the source. Returns the video codec (which decides TS vs
 * fMP4 packaging) and the container's own duration — a reliable fallback when
 * the provider's metadata is unavailable, which it often is while streaming.
 */
/**
 * Subtitle codecs that are TEXT, and can therefore become WebVTT.
 *
 * The rest of what a Matroska file carries — PGS from a Blu-ray, VobSub from a
 * DVD — are pictures of words, not words. Converting one to WebVTT is OCR, not
 * a remux, and asking ffmpeg for it fails rather than doing something clever.
 * They are left out of the list a viewer is offered, because a caption track
 * that cannot be turned on is worse than one that is not mentioned.
 */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'eia_608', 'subviewer',
]);

function probeSource(input) {
  // Keep this cheap. Matroska carries codec and duration in the header, so a
  // small window is enough — and it matters: a heavy probe holds the
  // provider's single connection long enough to stall the remux behind it.
  //
  // Every stream is listed rather than just v:0. The extra streams cost nothing
  // — the expense is the bytes pulled off the network to fill the probe window,
  // and those are read either way — and they are what says whether the title
  // has subtitles worth offering.
  //
  // Async on purpose. spawnSync here blocked the whole event loop for the
  // probe's duration — every live stream and download on the server froze
  // while a film was being inspected.
  return new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-user_agent', UA,
        '-analyzeduration', '1000000',
        '-probesize', '600000',
        '-show_entries', 'stream=index,codec_name,codec_type:stream_tags=language,title',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1',
        input,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
    timer.unref?.();
    proc.stdout.on('data', (d) => (out += d));

    const finish = () => {
      clearTimeout(timer);
      resolve(parseProbe(out));
    };

    proc.on('close', finish);
    proc.on('error', finish);
  });
}

/**
 * Read ffprobe's flat key=value output into the codec, the duration, and the
 * subtitle tracks.
 *
 * Streams arrive as runs of keys with nothing marking where one ends and the
 * next begins except `index` coming round again, so a record is flushed when
 * the next index appears and once more at the end.
 */
function parseProbe(out) {
  let codec = '';
  let duration = 0;
  const streams = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.type) streams.push(cur);
    cur = null;
  };

  for (const raw of out.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = /^index=(\d+)$/.exec(line))) {
      flush();
      cur = { index: Number(m[1]), type: '', codec: '', lang: '', title: '' };
    } else if ((m = /^codec_name=(.+)$/.exec(line))) {
      if (cur) cur.codec = m[1].toLowerCase();
    } else if ((m = /^codec_type=(.+)$/.exec(line))) {
      if (cur) cur.type = m[1].toLowerCase();
    } else if ((m = /^TAG:language=(.+)$/i.exec(line))) {
      if (cur) cur.lang = m[1].toLowerCase();
    } else if ((m = /^TAG:title=(.*)$/i.exec(line))) {
      if (cur) cur.title = m[1];
    } else if ((m = /^duration=([\d.]+)$/.exec(line))) {
      duration = Math.floor(Number(m[1]) || 0);
    }
  }
  flush();

  const video = streams.find((s) => s.type === 'video');
  if (video) codec = video.codec;

  // Numbered within their own type, because that is how `-map 0:s:N` counts.
  const subs = streams
    .filter((s) => s.type === 'subtitle')
    .map((s, i) => ({ at: i, codec: s.codec, lang: s.lang, title: s.title }))
    .filter((s) => TEXT_SUBTITLE_CODECS.has(s.codec));

  return { codec, duration, subs };
}

/**
 * The audio filter chain.
 *
 * `async` is the number of samples per second aresample may add or drop to pull
 * audio back onto its own timestamps. It was set to 1 — one sample a second,
 * about 0.002% — which reads like "on" and is in practice off: any real drift
 * outruns it immediately. 1000 is the usual working figure, roughly 2%, enough
 * to correct a source whose audio and video disagree without being audible.
 *
 * `first_pts=0` pads the head so the track starts at zero rather than wherever
 * the seek left it.
 *
 * `delayMs` is the manual override, because none of this can fix a source whose
 * own audio and video were mastered apart. Positive delays the audio with
 * silence; negative trims the front off so it plays earlier.
 */
function audioFilter(delayMs = 0, padSeconds = 0, tempo = 0, clock = 'container') {
  /* The content clock, for the archive drive's old rips.
   *
   * Every earlier attempt at their lip-sync trusted SOMETHING the file
   * claimed: the seek index (wrong), the measured drift (an artefact), and
   * finally — after the seek was made sequential — the audio track's own
   * timestamps, which aresample's async chases. A sequential resume still
   * came back with the sound ahead of the picture, and its probe showed the
   * audio stream extending 2.2s further than the video within 26s of output:
   * the container's audio timeline and its audio content disagree, and
   * chasing the timeline packs the content in wrong.
   *
   * So for these files nothing the container says about audio is used at
   * all. Decode the samples, resample to 48k, and REBUILD every timestamp
   * from the running sample count — asetpts=N/SR/TB, the one clock that
   * cannot lie, because it is the content itself. Contiguous audio (and a
   * 2007 TV capture is one continuous recording) then lands exactly where
   * playing the file from the start would put it, at any cut point. Video is
   * a copy on an exact 30000/1001 grid and keeps its own stamps; the output
   * -ss then cuts both clocks at the same instant.
   *
   * No async, no first_pts, no delay and no pad in this mode: each of those
   * exists to reconcile audio with container claims this mode is refusing to
   * hear. */
  if (clock === 'content') {
    return 'aresample=48000,asetpts=N/SR/TB';
  }
  // first_pts is where the track is told to begin, in samples at the output
  // rate. Zero means "start at the head of what I was given". A negative value
  // says the track really begins that far EARLIER, so pad the difference with
  // silence — which is how the audio is made to start alongside a video that
  // began at a keyframe before the seek mark.
  const pad = Math.round(Math.max(0, Math.min(30, Number(padSeconds) || 0)) * 48000);
  // async=1 is a MODE, not a rate: it turns on filling and trimming — silence
  // inserted, samples dropped — and leaves the tempo alone. Anything above 1
  // additionally licenses stretching and squeezing by that many samples per
  // second, and a remux must never do that SILENTLY. See the README.
  const chain = [
    `aresample=async=1:min_hard_comp=0.100:first_pts=${pad ? -pad : 0}`,
  ];
  // No tempo arm. One was added when a measured "drift rate" looked real, and
  // removed when two reports of the same file proved that number to be a
  // constant gap divided by a growing span — see realign. A remux does not
  // change tempo, and nothing here is allowed to on evidence that thin.
  void tempo;
  const ms = Math.max(-5000, Math.min(5000, Math.round(Number(delayMs) || 0)));
  if (ms > 0) chain.push(`adelay=${ms}:all=1`);
  else if (ms < 0) chain.push(`atrim=start=${(-ms / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
  return chain.join(',');
}

/* ---- low bandwidth ----
 *
 * What "optimizing" a download never did, and could never do: make it
 * SMALLER. Converting a .mkv to .mp4 fixes the container and changes the
 * bitrate not at all, so a 1080p title at six megabits is still six megabits
 * crossing the Wi-Fi, and on a weak link it stalls exactly as much
 * afterwards as before. The only cure for a link that cannot carry the
 * stream is to send fewer bits.
 *
 * 480 lines at CRF 26 with a hard ceiling under a megabit, plus 96k of
 * audio, lands around 1 Mbit/s — comfortably inside what a bad corner of a
 * house still carries, and perfectly watchable on a phone or a tablet. The
 * cost is the Pi doing real encoding work, which veryfast makes affordable,
 * and a picture that is visibly softer on a big television. That is the
 * trade, and it is the viewer's to make, which is why it is a switch rather
 * than something clever done behind their back.
 */
const LOW_HEIGHT = 480;
const LOW_CRF = '26';
const LOW_MAXRATE = '900k';
const LOW_BUFSIZE = '1800k';
const LOW_AUDIO = '96k';

function ffmpegArgs(input, outDir, videoCodec, startSeconds = 0, audioDelayMs = 0,
  audioPadSeconds = 0, subs = [], audioTempo = 0, seekMode = 'input', low = false) {
  const args = [];
  if (/^https?:/i.test(input)) {
    // This provider paces VOD at barely above realtime and drops the socket
    // every ~25s. Measured: 0.58 MB/s sustained on a title needing 0.40 MB/s.
    // Every drop is dead air in the conversion, so reconnect hard and fast.
    args.push(
      '-user_agent', UA,
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_on_http_error', '4xx,5xx',
      '-reconnect_delay_max', '2',
      // Don't sit on a stalled socket for minutes — fail fast and reconnect.
      '-rw_timeout', '15000000'
    );
  }

  // Low bandwidth always comes out as H.264, whatever went in — so the HEVC
  // packaging below must not claim otherwise.
  const isHevc = !low && /hevc|h265/.test(videoCodec || '');

  // -ss ahead of -i is the fast seek: ffmpeg jumps in with Range requests
  // rather than decoding from the top. With -c copy it lands on the nearest
  // preceding keyframe, so the real start can be a second or two early.
  //
  // -noaccurate_seek is what keeps the two streams together across that.
  //
  // Accurate seeking discards everything between the keyframe and the mark —
  // but a copied video stream cannot be cut mid-GOP, so only the audio gets
  // trimmed. Video then begins at the keyframe and audio at the mark, and
  // `-avoid_negative_ts make_zero` slides both down by the same amount, so the
  // output opens with the video already running and the audio arriving a
  // fraction of a second later. Measured on this provider: 1184ms. The file is
  // arguably correct — that video really has no audio yet — but a browser
  // handed a track that starts late plays it against the wrong picture, which
  // is heard as lip-sync drift for the whole session rather than a moment of
  // silence at the top.
  //
  // Turning accurate seeking off keeps the audio between the keyframe and the
  // mark instead of discarding it, so both streams start at the keyframe and
  // land aligned. The cost is that playback begins up to one GOP before the
  // spot you asked for, which puts the scrubber out by about a second. That is
  // the better error of the two: an early start is barely noticeable, and
  // audio against the wrong picture is unwatchable.
  // Two ways to reach the middle of a file, and which one is safe depends on
  // whose file it is.
  //
  // 'input' — the -ss before -i — asks the DEMUXER to jump there, which
  // means trusting the file's own seek index to land both streams at the
  // same moment. Our own conversions and the provider's masters have sane
  // indexes, and over HTTP jumping is the only affordable move.
  //
  // 'demux' reads the file from the top in one sequential pass and discards
  // everything before the mark (the -ss after -i). Both tracks travel the
  // same pipe and are cut at the same instant, so there is nothing for a
  // broken index to disagree about. This is for the archive drive: a 2008
  // rip resumed mid-file came back seconds out of lip-sync every time, at
  // an offset that was constant for a given resume point — the shape of a
  // bad audio seek table (mp3-in-mp4, a combination that never had a good
  // one), not of a drifting file, since playing the same file from the
  // start held sync for its whole runtime. Sequential reading never asks
  // the table anything. It costs reading the skipped span at demux speed,
  // which for these small local files is seconds, and it buys resume being
  // exactly as in-sync as pressing play — because it IS pressing play, with
  // the first act thrown away.
  if (startSeconds > 0 && seekMode !== 'demux') {
    args.push('-ss', String(startSeconds), '-noaccurate_seek');
  }

  args.push(
    '-i', input,
    // Rebase timestamps so a seeked session still starts its playlist at zero.
    '-avoid_negative_ts', 'make_zero',
    '-map', '0:v:0',
    '-map', '0:a:0?'
  );
  // The sequential cut. Video is a copy, so its discarded span is demuxed
  // and dropped without decoding; audio decodes as it winds, which is what
  // the wait on a deep resume is spent on.
  if (startSeconds > 0 && seekMode === 'demux') {
    args.push('-ss', String(startSeconds));
  }

  /* Copying the video is always preferable — it costs nothing and preserves
   * the source exactly. But a third of the archive drive is MPEG-4 ASP
   * (DivX/XviD in .avi), plus MPEG-2 and WMV, and no browser decodes any of
   * those. Copying them produces a stream that plays as a black rectangle,
   * so those are encoded.
   *
   * veryfast/CRF 23 is what makes this viable on a Pi rather than a
   * theoretical nicety: measured at 4.7x realtime on the Pi 4 against this
   * drive's mostly-SD material. Provider streams are always H.264/HEVC and
   * never take this branch. */
  // The codecs the pipeline can pass through untouched. H.264 plays
  // everywhere; HEVC is carried by the fMP4 branch below. Everything else on
  // the archive drive — MPEG-4 ASP, MPEG-2, WMV — no browser decodes.
  const PASSTHROUGH_VIDEO = new Set(['h264', 'hevc', 'h265']);
  const needsVideoEncode = videoCodec && !PASSTHROUGH_VIDEO.has(videoCodec);
  if (low) {
    // Nothing is copied here, however good the source codec is: copying is
    // exactly what keeps the stream too big to cross the link.
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', LOW_CRF,
      // A ceiling as well as a quality target, because CRF alone lets a busy
      // scene spike to several megabits — which is the moment it stalls.
      '-maxrate', LOW_MAXRATE,
      '-bufsize', LOW_BUFSIZE,
      '-pix_fmt', 'yuv420p',
      // Down to 480 lines, aspect kept, dimensions even (H.264 requires it),
      // and never upscaled — material already smaller is left as it is.
      '-vf', `scale=-2:'min(${LOW_HEIGHT},ih)'`,
      // A keyframe on every segment boundary, so segments stay independent
      // and seeking lands where it was asked to.
      '-force_key_frames', 'expr:gte(t,n_forced*6)',
      '-sc_threshold', '0'
    );
  } else if (needsVideoEncode) {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      // yuv420p is the only pixel format iOS reliably decodes, and some of
      // this material is old enough to be odd.
      '-pix_fmt', 'yuv420p',
      // A keyframe every couple of seconds, aligned so segments start on an
      // IDR and seeking lands where it should.
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0'
    );
  } else {
    args.push('-c:v', 'copy');
  }

  // Audio is always re-encoded, never copied.
  //
  // Copying stereo AAC straight through looked like free headroom, and for
  // most of the catalogue it was. But `codec_name` is `aac` for both AAC-LC
  // and HE-AAC, and an HE-AAC stream carries only half its sample rate in the
  // core, with SBR restoring the top. A decoder that takes the core alone
  // plays it an octave down and at half speed — a deep, dragging voice over
  // completely normal video, which is exactly what came back from the box.
  // Nothing in the provider's metadata distinguishes the two profiles, and
  // probing the source for it would spend the single provider connection that
  // playback itself needs.
  //
  // Re-encoding to plain stereo AAC-LC at a fixed rate removes the question:
  // every browser decodes the result identically. It costs a few percent of
  // one core against a video copy already running many times faster than
  // playback, and it is what the download optimizer has always done.
  args.push(
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-ac', '2',
    '-ar', '48000',
    '-b:a', low ? LOW_AUDIO : '160k',
    '-af', audioFilter(audioDelayMs, audioPadSeconds, audioTempo,
      seekMode === 'demux' ? 'content' : 'container')
  );

  // Fragmented MP4 for everything, not just HEVC.
  //
  // HEVC has to be fMP4 — Apple's HLS spec carries it no other way, and inside
  // MPEG-TS it will not play on iOS at all. H.264 was left as TS because it
  // works, and for the video it does.
  //
  // The audio is the reason it no longer is. An MPEG-TS segment reaches hls.js
  // as a transport stream it has to demux and rebuild into MP4 for the browser
  // itself, reconstructing every AAC frame's timing from ADTS headers as it
  // goes. Get that timing wrong and the samples are laid down at the wrong
  // spacing, which is heard as a pitch shift while the video, whose frames
  // carry their own timestamps, stays perfectly in time. That is the shape of
  // the fault reported here, and it survived pinning the encoder to AAC-LC at
  // a fixed rate — so the file is right and something after it is not.
  //
  // fMP4 segments carry explicit sample counts and durations in their own
  // headers and are handed to the browser essentially untouched, which takes
  // that reconstruction out of the path entirely. It also leaves one packaging
  // format instead of two.
  if (isHevc) args.push('-tag:v', 'hvc1');
  args.push(
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(outDir, 'seg%05d.m4s')
  );

  args.push(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    path.join(outDir, 'index.m3u8')
  );

  // Subtitles ride the SAME ffmpeg run, as extra outputs off the one input.
  //
  // That is the whole reason this is shaped the way it is. A second process
  // would mean a second read of the source, and on a provider that allows one
  // connection the second read is the one that fails — or worse, takes the
  // connection off the picture. One input, several outputs, one connection.
  //
  // Only text subtitles are ever mapped, and only ones a probe has actually
  // seen. An output with no streams in it is fatal to the whole command, so
  // `-map 0:s:0?` on a file with no subtitles would take the video down with
  // it; nothing is added unless something is known to be there.
  subs.forEach((sub, i) => {
    args.push('-map', `0:s:${sub.at}`, '-c:s', 'webvtt', path.join(outDir, `sub${i}.vtt`));
  });

  return args;
}

/**
 * What each title's subtitle streams turned out to be, keyed by `kind:id:ext`
 * rather than by the stream URL — the URL carries the account password, and a
 * cache keyed on it would both leak it into memory dumps and miss every entry
 * the moment the password is rotated.
 *
 * In memory only. A restart re-probes each title once, which is a second on the
 * first play and nothing after that; a file on disk to avoid it would be a new
 * thing to keep, invalidate and leave lying around.
 */
const subtitleLayouts = new Map();

/**
 * What a title is made of — codec, duration and subtitle tracks — probed at
 * most once per title.
 *
 * The probe costs one short read of the source. Where that read is free — a
 * file already on disk, or a title looked at before — this costs nothing at
 * all. Where it is not, it is the same probe `startRemux` has always run when
 * the provider withheld the video codec, and it happens before the conversion
 * spawns rather than beside it, so it never competes with playback for the
 * single connection.
 */
async function probeTitle(input, key) {
  if (key && subtitleLayouts.has(key)) return subtitleLayouts.get(key);
  if (!hasFfmpeg()) return { codec: '', duration: 0, subs: [] };
  let probed = { codec: '', duration: 0, subs: [] };
  try {
    probed = await probeSource(input);
  } catch {
    // Never fail a film over what could not be learned about it.
  }
  if (key) subtitleLayouts.set(key, probed);
  return probed;
}

/** How a subtitle track is named in the menu. */
function subtitleLabel(sub) {
  const name = LANGUAGE_NAMES[sub.lang] || (sub.lang ? sub.lang.toUpperCase() : '');
  // The file's own title wins when it has one — "English (SDH)", "Forced" and
  // "Signs & Songs" are distinctions a language code cannot carry.
  if (sub.title && name) return `${name} — ${sub.title}`;
  return sub.title || name || 'Subtitles';
}

/**
 * Enough of ISO 639 to name what this library actually carries. Anything else
 * shows its code, which is worse than a name and much better than nothing.
 */
const LANGUAGE_NAMES = {
  eng: 'English', en: 'English',
  spa: 'Spanish', es: 'Spanish', esp: 'Spanish',
  fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German',
  ita: 'Italian', it: 'Italian',
  por: 'Portuguese', pt: 'Portuguese',
  dut: 'Dutch', nld: 'Dutch', nl: 'Dutch',
  rus: 'Russian', ru: 'Russian',
  pol: 'Polish', pl: 'Polish',
  ara: 'Arabic', ar: 'Arabic',
  chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
  jpn: 'Japanese', ja: 'Japanese',
  kor: 'Korean', ko: 'Korean',
  hin: 'Hindi', hi: 'Hindi',
  swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish',
  tur: 'Turkish', gre: 'Greek', ell: 'Greek', heb: 'Hebrew',
  ron: 'Romanian', rum: 'Romanian', hun: 'Hungarian', ces: 'Czech', cze: 'Czech',
};

/**
 * Spawn a remux and resolve once the playlist has real segments in it. Only one
 * provider-backed session runs at a time — the account allows a single
 * connection, so a second would just fail.
 */
async function startRemux(input, opts) {
  const { fromProvider, videoCodec, startSeconds = 0, audioDelayMs = 0,
    audioPadSeconds = 0, audioTempo = 0, seekMode = 'input', aligned = false,
    subs = [], noSubs = false, sourceDuration = 0, id: wantId = '',
    replaces = '', low = false } = opts;
  if (!hasFfmpeg()) throw new Error('ffmpeg is not installed on this machine');

  // Clear the way for this conversion — without cutting off anybody else's.
  //
  // This used to kill EVERY conversion on the box, on the reasoning that
  // there is one viewer, so anything else running must be abandoned. In
  // multiview that reasoning is simply false: the second converted title
  // killed the first, whose cell then played on out of its buffer for a
  // couple of minutes and died with a fragment it could no longer load.
  // Same for a seek, which is why the caller names the session it is
  // replacing rather than the server guessing.
  //
  // So: the named session goes, and so does anything nobody has fetched
  // from lately — an abandoned local-file remux really would keep ffmpeg
  // grinding through a whole film. A session someone is actively watching
  // is left alone, and live ingests reap themselves in 45 seconds.
  for (const [id, sess] of [...remuxSessions]) {
    if (sess.live) continue;
    if (id === replaces) { killSession(id); continue; }
    if (Date.now() - sess.lastAccess < SESSION_ACTIVE_MS) continue;
    killSession(id);
  }

  if (fromProvider) {
    // The remux is about to occupy a provider slot; playback wins.
    lastProviderActiveAt = Date.now();
  }

  // The container choice depends on the video codec, so we must know it before
  // spawning. The provider usually tells us; fall back to probing. The same
  // probe hands back the source duration, which the scrubber uses when the
  // provider's own metadata is unavailable.
  const probed = videoCodec
    ? { codec: videoCodec, duration: sourceDuration }
    : await probeSource(input);
  const codec = probed.codec;

  fs.mkdirSync(HLS_DIR, { recursive: true });
  // A caller may name the session. Archive playback does: one session per
  // file, keyed by the file, so a resume finds the conversion already running
  // instead of starting a rival.
  const id = wantId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(HLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  // `-v info` rather than `error`, for one reason: ffmpeg prints what it found
  // in the source before it starts work — codec, sample rate, channel layout,
  // profile — and that is the only description of the provider's audio we can
  // get without spending the single connection playback needs on a second
  // probe. `-nostats` keeps the per-frame progress spew out of it.
  const wanted = noSubs ? [] : subs;
  const args = ['-v', 'info', '-nostats', '-hide_banner', '-y',
    ...ffmpegArgs(input, dir, codec, startSeconds, audioDelayMs, audioPadSeconds, wanted,
      audioTempo, seekMode, low)];

  /* The connection this conversion is about to pull down, taken from the pool
     rather than assumed. Everything between here and the session below is
     synchronous, so the lease and the session that owns it cannot be
     separated by a failure — and the pause decision is made with the slot
     already counted, which is what makes it "did this take the LAST one"
     rather than "is anything playing". */
  const account = fromProvider ? providers.forUrl(readConfig(), input) : null;
  const releaseSlot = account ? providers.take(account.id) : null;
  if (fromProvider) autoPauseActiveDownload();

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  let stderrHead = '';
  proc.stderr.on('data', (d) => {
    const text = d.toString();
    // Head and tail both: the header describes the input, the tail carries
    // whatever went wrong. Keeping only one loses the half that matters.
    if (stderrHead.length < 6000) stderrHead += text;
    stderr = (stderr + text).slice(-2000);
  });

  const session = {
    id,
    dir,
    proc,
    lastAccess: Date.now(),
    // When ffmpeg started, so the report can say how fast the conversion is
    // running against the clock. A stream copy runs at several times
    // realtime; anything re-encoded on this box does not, and telling those
    // two apart is the difference between "the wire cannot carry it" and
    // "the box cannot make it".
    startedAt: Date.now(),
    fromProvider,
    // Handed back by killSession, and by ffmpeg's own exit below.
    releaseSlot,
    // Where this session sits in the film. The client adds it back so the
    // scrubber reads in real running time rather than session time.
    offset: startSeconds,
    sourceDuration: probed.duration || 0,
    // A seek should feel responsive, so bank less than on a cold open — but
    // not 8s: at this provider's pacing that drains before the first drop.
    prebuffer: startSeconds > 0 ? 45 : readPrefs().prebufferSeconds || DEFAULT_PREBUFFER,
    stderr: () => stderr,
    stderrHead: () => stderrHead,
    // The command as it was actually run. Two rounds of this have been spent
    // unable to tell whether a fix was deployed yet; the flags themselves
    // settle it.
    args: redactUrl(args.join(' ')),
    // What the viewer can be offered, and where each one is being written.
    // `sub0.vtt` is filled progressively as the conversion runs, so a track
    // fetched early is short and grows — which is fine for WebVTT and is why
    // the client re-fetches rather than trusting the first read.
    subs: wanted.map((sub, i) => ({
      at: sub.at,
      lang: sub.lang || '',
      title: sub.title || '',
      codec: sub.codec || '',
      file: `sub${i}.vtt`,
    })),
  };
  remuxSessions.set(id, session);

  proc.on('exit', (code) => {
    session.exited = true;
    session.exitCode = code;
    /* The provider connection ends with ffmpeg, not with the session. What
       outlives it is a directory being served off this box's own disk, and
       holding a login open for that would keep a slot spoken for through a
       whole film that has already finished converting. */
    if (session.releaseSlot) {
      session.releaseSlot();
      session.releaseSlot = null;
    }
  });

  const playlist = path.join(dir, 'index.m3u8');
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    if (fs.existsSync(playlist)) {
      const text = fs.readFileSync(playlist, 'utf8');
      // Wait for a couple of segments so playback doesn't start and stall.
      if ((text.match(/\.(ts|m4s)/g) || []).length >= 2) {
        return aligned ? session : realign(session, input, opts);
      }
    }
    if (session.exited && session.exitCode !== 0) {
      const detail = stderr.split('\n').filter(Boolean).pop() || `exit ${session.exitCode}`;
      killSession(id);
      // Captions are a bonus; the picture is not. If subtitle outputs were
      // attached and the command died, drop them and run the command that has
      // always worked rather than handing back a film that will not play. A
      // source whose subtitle stream ffmpeg cannot write must not be a source
      // you cannot watch.
      if (wanted.length) {
        return startRemux(input, { ...opts, noSubs: true });
      }
      throw new Error(`ffmpeg failed: ${detail}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  killSession(id);
  if (wanted.length) return startRemux(input, { ...opts, noSubs: true });
  throw new Error('Remux timed out starting up');
}

/**
 * Start over once, with the audio padded to meet the video.
 *
 * Seeking with `-c:v copy` cannot land on the mark: the video begins at the
 * keyframe at or before it while the audio begins wherever the container's
 * next audio packet falls, and on this provider's files the two are anywhere
 * from nothing to three seconds apart, varying with where you seek. Nothing
 * knows that distance before the conversion runs — but two segments in, it can
 * simply be measured, and a second pass told to pad exactly that much silence
 * onto the front of the audio.
 *
 * Done here rather than left to the player because a file whose tracks start
 * apart is at the mercy of whatever the player decides to do about it, and the
 * measurements say this one decides wrong.
 *
 * Costs the few seconds it takes to write two segments, once per seek, and
 * only when there is a gap worth closing. Never recurses: the second pass is
 * marked aligned whatever it measures, so a source this cannot fix wastes one
 * restart rather than looping.
 */
async function realign(session, input, opts) {
  let gap = null;
  let rate = null;
  let linear = null;
  try {
    const probe = await probeOutput(session);
    gap = probe?.start?.sync ?? null;
    rate = probe?.drift?.rate ?? null;
    linear = probe?.drift?.linear ?? null;
  } catch {
    return session;   // measuring is a bonus; never fail the session over it
  }

  // Two distinct faults, measured apart and corrected apart. An OFFSET —
  // tracks parallel but shifted — is repaired with silence up front. A DRIFT
  // RATE — tracks pulling apart steadily — cannot be: the audio agrees with
  // its own timestamps, it is the video's timeline it argues with, so no
  // amount of filling or trimming converges. The repair is atempo at exactly
  // the measured factor: an archive rip drifting -32.4ms/s means audio spans
  // 3.2% less timeline than video, so it is played 3.2% slower,
  // pitch-preserved, and the ends meet. Rates beyond 10% mean the measurement
  // is wrong, not the audio, and are left alone.
  //
  // THE TEMPO CORRECTION IS GONE, and the reason is worth keeping. It was
  // driven by `drift.rate`, and two reports of the same file at the same
  // resume point settled what that number really is:
  //
  //     02:13   gap 9.030s over 279.0s  ->  "32.4ms/s"
  //     02:49   gap 9.031s over 299.4s  ->  "30.2ms/s"
  //
  // The GAP is identical to the millisecond; only the span grew, so the
  // "rate" shrank to match. It is a constant divided by a growing number —
  // the very artefact this file's own comments warned about, in a new
  // disguise. The halves said so outright once they existed: -53.8ms/s and
  // then flat 0.0. And the arithmetic finishes it — a 9.03s gap was reported
  // INSIDE a segment holding 2.475s of content, 3.6x the segment's whole
  // length, which is impossible. `endOf(audio)` and `endOf(video)` are not
  // measuring the same thing across an fMP4 fragment, so their difference was
  // never a drift rate and nothing may be corrected from it.
  //
  // What the constant probably is: 9.031 / 2135 = 0.42%, the two tracks'
  // timescales disagreeing, so seeking to "2135s" lands them 9s apart in
  // CONTENT while both still start at timestamp 0 — which is exactly why the
  // report reads "offset 0ms" while the viewer hears otherwise. A start
  // offset we can see is corrected below; one hidden inside the seek is not
  // visible to any measurement taken after it, and is handled by the manual
  // control instead.
  const wantPad = Number.isFinite(gap) && gap > 0.1;
  if (!wantPad) return session;

  killSession(session.id);
  return startRemux(input, { ...opts, audioPadSeconds: gap, aligned: true });
}

/** Reap sessions nothing has fetched from in a while. */
setInterval(() => {
  for (const [id, s] of remuxSessions) {
    // An archive conversion runs to the END even with nobody watching: the
    // finished output is the cache that makes the next resume instant, and
    // abandoning it half-done would throw that work away. It reads a local
    // file and holds no provider connection, so letting it finish costs
    // only CPU — and the moment any other title needs the encoder, the
    // sweep in startRemux takes it anyway.
    if (id.startsWith('arc-') && !s.exited) continue;
    // Live ingests hold a provider connection open, so they go sooner.
    const idle = s.idleMs || 5 * 60 * 1000;
    if (Date.now() - s.lastAccess > idle) killSession(id);
  }
}, 15000).unref();

for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const id of [...remuxSessions.keys()]) killSession(id);
    if (signal !== 'exit') process.exit(0);
  });
}

/* --------------------------------------------------------------- live DVR ---

 * The provider publishes about 60 seconds of playlist per channel, and that
 * number is the root of every live failure mode this app has been through: a
 * viewer on a slow link stalls, falls behind, and within a minute the segment
 * under the playhead expires off the provider's server — at which point the
 * player is FORCED forward, which is the jumping-around that no client setting
 * can prevent. The window is the provider's property, not ours.
 *
 * So make our own. One ffmpeg per channel reads the provider's TS feed —
 * stream copy, no transcoding, so it costs the Pi almost nothing — and
 * republishes it as local HLS with short segments and a window of about two
 * minutes. What that buys, in order of importance:
 *
 *   - Nothing expires under the viewer inside two minutes of drift, so the
 *     forced jump is gone from every link that is not two whole minutes slow.
 *     Two minutes is also the ceiling on how far behind anyone can be.
 *   - The provider's bursty delivery (measured: 31s dumped in the first 6s,
 *     then lumpy 4-5s chunks) is absorbed by the Pi's disk instead of the
 *     viewer's buffer. The dump is not swallowed as the TS proxy does — it is
 *     BANKED: it becomes the first half-minute of window, so a viewer can join
 *     with a real cushion the moment the channel opens.
 *   - Segments are ~4 seconds instead of the provider's 11, so the client can
 *     fetch in fine grain and hold a cushion that a coarse playlist could
 *     never hand it.
 *   - Everybody watching a channel shares ONE provider connection, where every
 *     multiview cell used to cost its own.
 *
 * What it does not buy: bandwidth between the Pi and the viewer. A tunnel that
 * delivers 1.4 Mbit/s still delivers 1.4 Mbit/s. But the cushion this makes
 * possible is what a slow link needs most.
 *
 * Sessions live in `remuxSessions` so the existing serving, reaping and
 * provider-busy logic all apply, marked `live: true` where the rules differ:
 * a live playlist must never be closed with ENDLIST while the ingest can
 * restart, and a live ingest must survive the kill-everything sweeps that VOD
 * conversions run (a multiview film cell must not silence the live cell next
 * to it). If the feed drops — this provider's does — ffmpeg is respawned into
 * the same directory with `append_list`, so the playlist carries straight on
 * and the viewer sees a hiccup, not an ending.
 */
/*
 * How far behind the provider's live edge a cold start begins, in THEIR
 * segments.
 *
 * Counted back from the edge rather than forward from the start of their
 * playlist, because the length of that playlist is theirs to decide and
 * varies by channel on one account — fifty seconds on some, ten minutes on a
 * news channel. Ten of their segments is roughly 40-100 seconds depending on
 * how they cut, which covers the player's 45-second seat with something in
 * hand, and cannot put the picture minutes into the past however much they
 * keep.
 */
const COLD_START_SEGMENTS = 10;

const LIVE_DVR = {
  // Requested cut length. Stream copy can only cut on keyframes, so real
  // segments land on the channel's GOP length — usually 2-6s on this provider.
  segmentSeconds: 4,
  // How many of them to keep published. Together with the above this is the
  // window: ~2 minutes, which is both the drift ceiling and the furthest
  // behind live anybody can end up.
  windowSegments: 30,
  // How long a tune-in may wait for the buffer before being handed the plain
  // direct stream instead. Short on purpose: on a healthy feed the first
  // segment lands well inside it, and on a starved one the buffer would open
  // shallow anyway — and a viewer seated in a 4-second window rides the
  // ingest frontier, stalling every few seconds, which a measured session
  // showed to be worse than the direct path it replaced.
  startWaitMs: 5000,
  // Live is reaped faster than the 5-minute VOD default: an ingest holds a
  // provider connection open, and hls.js re-fetches the playlist every few
  // seconds, so 45 quiet seconds means nobody is watching.
  idleMs: 45000,
  // A drop is only worth reconnecting for an audience. After this long with
  // no fetches, an exit is an ending.
  restartWindowMs: 30000,
};

function liveDvrArgs(input, dir, resumed = false, low = false) {
  // Shrinking a live channel is the same trade as shrinking a film, with one
  // extra condition: the encode has to keep up with the broadcast, for ever.
  // ultrafast rather than veryfast for exactly that — a channel that falls
  // behind its own feed never catches up, and a slightly softer picture is a
  // far better outcome than a growing delay.
  const videoArgs = low
    ? [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', LOW_CRF,
      '-maxrate', LOW_MAXRATE, '-bufsize', LOW_BUFSIZE, '-pix_fmt', 'yuv420p',
      '-vf', `scale=-2:'min(${LOW_HEIGHT},ih)'`,
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    ]
    : ['-c:v', 'copy'];

  // Audio is re-encoded here too, and for the same reason it is on a film.
  //
  // `codec_name` is `aac` for both AAC-LC and HE-AAC, and an HE-AAC stream
  // carries only half its sample rate in the core with SBR restoring the top.
  // A decoder that takes the core alone plays it an octave down and at half
  // speed — deep, dragging voices over completely normal video. That is the
  // fault this box has already seen once on films, and a live channel copied
  // straight through is the same gamble on every channel the provider sends.
  //
  // Plain stereo AAC-LC at a fixed rate removes the question. On a Pi it is a
  // couple of percent of one core beside a video copy that costs nothing.
  const audioArgs = [
    '-c:a', 'aac', '-profile:a', 'aac_low',
    '-ac', '2', '-ar', '48000', '-b:a', low ? LOW_AUDIO : '160k',
  ];
  return [
    '-v', 'info', '-nostats', '-hide_banner', '-y',
    /* The feed drops; these ride out the transport-level ones without ffmpeg
     * exiting at all. A full exit is handled by the respawn in spawnLiveDvr.
     *
     * `reconnect_at_eof` is the one that was missing, and its absence is the
     * whole of the "it jumped forward" report. The other two cover a socket
     * that BREAKS. This covers a socket that ENDS POLITELY — which is what
     * happens when the ingest catches up to the provider's live edge and asks
     * for a segment that does not exist yet. ffmpeg read that as the stream
     * being over and exited with code 0, cleanly, every twenty seconds or so;
     * the black box caught it doing exactly that twice in ninety seconds.
     *
     * Every one of those exits costs the viewer a hole. The resume takes the
     * provider's live edge, so whatever was published while ffmpeg was down —
     * plus whatever sat between its last segment and the edge — is never
     * ingested at all. The player, seated forty-five seconds back, eventually
     * reaches that hole and skips it. That is the jump.
     *
     * Bounding the cold start is what exposed this: with minutes of backlog
     * to chew through the ingest never sat at the edge waiting, so it never
     * hit the EOF that ends it. */
    '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1', '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '5',
    /* And the same fact one layer up: a live playlist that has not gained a
       segment yet is not a playlist that has ended. The default gives up far
       too readily for a provider whose refresh is lumpy. */
    '-m3u8_hold_counters', '120',
    /* Where in the provider's playlist to start reading — counted BACK from
     * their live edge, never forward from the start of it.
     *
     * This was `0` on a cold start: the oldest segment they publish. The
     * reasoning was that the provider keeps about fifty seconds of already-
     * published video, so taking all of it opens the Pi's window deep and at
     * link speed rather than growing it from nothing at 1x.
     *
     * Fifty seconds was a measurement of two or three channels, and it was
     * read as a fact about the provider. It is not. A news channel on this
     * same account publishes something closer to TEN MINUTES, and `0` on that
     * playlist starts the ingest ten minutes in the past — so a tune-in opens
     * on content from ten minutes ago, and ffmpeg then races forward through
     * the backlog while the viewer sits watching an hour-old bulletin in a
     * window sliding out from under them. That is the "it is replaying what I
     * already watched" report, and it is not the respawn: the black box shows
     * restarts 0 and a single ingest-started note.
     *
     * A NEGATIVE index is counted from the end, so the depth is OURS rather
     * than whatever the provider happens to keep. Deep enough that the player
     * can take its 45-second seat the moment the window opens, and bounded, so
     * a provider with a long DVR cannot start us in the past.
     *
     * RESPAWN (-1, their newest segment): a feed drop respawns ffmpeg into the
     * same window, and pulling ANY backlog again republishes video the viewer
     * has already watched as brand-new segments on the end of the playlist —
     * so a resume takes the edge and nothing behind it. The previous two
     * minutes are still on disk, so nobody loses their cushion, and
     * `discont_start` below tells the player the timeline is a new one. */
    '-live_start_index', resumed ? '-1' : `-${COLD_START_SEGMENTS}`,
    '-i', input,
    // First video stream and FIRST audio stream; data and DVB subtitle streams
    // are dropped — they are why a bare -map 0 dies on some channels. One
    // audio stream rather than all of them because only the first was ever
    // reachable: nothing in either player picks between muxed live tracks, so
    // the rest were being carried, and are now being encoded, for nobody.
    '-map', '0:v:0', '-map', '0:a:0?',
    ...videoArgs,
    ...audioArgs,
    '-f', 'hls',
    '-hls_time', String(LIVE_DVR.segmentSeconds),
    '-hls_list_size', String(LIVE_DVR.windowSegments),
    // delete_segments keeps disk use at one window; append_list lets a respawn
    // continue the same playlist; temp_file stops a half-written segment being
    // served as though it were whole. A respawned run marks its first segment
    // as a discontinuity, because its timestamps restart wherever the
    // provider's backlog now begins — unmarked, the player maps them onto the
    // old timeline and the picture jumps.
    '-hls_flags', `delete_segments+append_list+temp_file${resumed ? '+discont_start' : ''}`,
    // Fragmented MP4 rather than MPEG-TS, which is the OTHER half of the same
    // fault. A TS segment reaches hls.js as a transport stream it must demux
    // and rebuild into MP4 itself, reconstructing every AAC frame's timing
    // from ADTS headers as it goes; get that spacing wrong and the samples are
    // laid down at the wrong rate — heard as a pitch shift while the video,
    // whose frames carry their own timestamps, stays perfectly in time. On
    // films that was the half that actually fixed it: pinning the encoder to
    // AAC-LC was not enough on its own. fMP4 segments carry explicit sample
    // counts in their own headers and are handed over essentially untouched.
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, 'seg%06d.m4s'),
    path.join(dir, 'index.m3u8'),
  ];
}

/* ============================================================= recordings ==
 *
 * Keeping a programme, whole, because somebody asked for it before it aired.
 *
 * The video comes from one of two places and which one decides whether this
 * costs a provider connection at all — see the head of recordings.js. When
 * the channel is already being ingested for somebody watching, the recorder
 * reads the box's OWN published window: a second reader of one stream, no
 * second connection, and its fetching keeps the ingest alive after the viewer
 * has gone. Otherwise it takes a slot from the pool and holds it.
 */

/** ffmpeg's arguments for keeping a programme, whichever source it came from. */
function recordArgs(input, out, local) {
  return [
    '-v', 'error', '-nostats', '-hide_banner', '-y',
    ...(local ? [] : [
      '-user_agent', UA,
      '-reconnect', '1', '-reconnect_streamed', '1',
      '-reconnect_at_eof', '1', '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      '-m3u8_hold_counters', '120',
      /* From the live edge. A recording that opens a minute before the
         listing does not want the provider's backlog on top of that — the
         lead is the padding, not an accident of how deep their playlist is. */
      '-live_start_index', '-1',
    ]),
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    /* Copied, not encoded. A Pi cannot encode HD video in realtime for three
       hours, and a recording that falls behind its own feed never catches up.
       The audio is re-encoded for the same reason live is: HE-AAC reaching a
       decoder as bare AAC plays an octave low, and a recording nobody watches
       for a week is the worst place to discover that. */
    '-c:v', 'copy',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-ar', '48000', '-b:a', '160k',
    /* Written so the file plays even if the process never gets to finish it:
       a power cut two hours in should cost the last few seconds, not the
       whole programme. */
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    out,
  ];
}

/**
 * Open the file and start writing to it.
 *
 * The choice of source is the whole of the connection story. A live session
 * already running for this channel means the box is ALREADY pulling it, so
 * the recorder reads the local playlist and inherits that ingest — it costs
 * nothing, and because the reaper watches lastAccess, the recorder's own
 * fetching is what keeps the window alive once the viewer leaves.
 */
function beginRecording(row) {
  if (!hasFfmpeg()) {
    recordings.noteFailure(row, 'ffmpeg is not installed on this box.');
    return;
  }
  const cfg = readConfig();
  if (!cfg || cfg.mode !== 'xtream') {
    recordings.noteFailure(row, 'No provider is connected.');
    return;
  }

  const out = path.join(recordings.dir(), row.file);
  try {
    fs.mkdirSync(recordings.dir(), { recursive: true });
  } catch (err) {
    recordings.noteFailure(row, `Could not write to the recordings folder: ${err.message}`);
    return;
  }

  /* Enough room for the programme at a generous bitrate, plus the floor the
     rest of the box keeps. Refusing now with a reason beats filling the disk
     at two in the morning. */
  const minutes = Math.max(1, (recordings.closesAt(row) - recordings.opensAt(row)) / 60000);
  const need = minutes * 60 * 1024 * 1024 * (6 / 8);
  const free = diskFree(recordings.dir());
  if (Number.isFinite(free) && free < need + SPACE_RESERVE) {
    recordings.noteFailure(row,
      `Not enough room — this needs about ${Math.round(need / 1024 ** 3)} GB.`);
    return;
  }

  const existing = remuxSessions.get(`live-${row.channelId}`);
  const local = Boolean(existing && !existing.exited);
  let release = null;
  let input;

  if (local) {
    /* The box's own window, on the loopback. Nothing leaves the machine and
       no slot is taken: this ingest is already paid for. */
    input = `http://127.0.0.1:${PORT}/hls/${existing.id}/index.m3u8`;
    existing.lastAccess = Date.now();
  } else {
    const account = providers.pick(cfg);
    /* No free slot and nothing already ingesting this channel. The recording
       still goes ahead on whichever login is least busy — it was asked for in
       advance, and a provider that refuses is a better answer than a box that
       refused on its behalf. */
    const chosen = account || providers.accounts(cfg)[0] || cfg;
    input = buildStreamUrl(chosen, 'live', row.channelId, 'm3u8');
    if (chosen && chosen.id) release = providers.take(chosen.id);
  }

  const proc = spawn('ffmpeg', recordArgs(input, out, local),
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1000); });
  proc.on('exit', (code) => {
    const row2 = recordings.get(row.id);
    if (row2 && code && !row2.error) row2.error = stderr.split('\n').filter(Boolean).pop() || '';
    recordings.ended(row.id, code);
  });
  proc.on('error', (err) => {
    if (release) release();
    recordings.noteFailure(row, err.message);
  });

  recordings.began(row, { proc, release, source: local ? 'box window' : 'provider' });
  console.log(`  recording: ${row.title} on ${row.channelName || row.channelId} `
    + `(${local ? 'sharing the live window' : 'own connection'})`);
}

/*
 * A live channel's own black box.
 *
 * "It jumped back to where I started watching" is a report about a moment
 * that has already passed, on a stream nobody was recording, and the two
 * things that would settle it — what the playlist said before and after, and
 * whether ffmpeg restarted underneath it — are both gone by the time anybody
 * describes it. So each session keeps its last few dozen notable moments: a
 * spawn, an exit, and every time the published window moved in a way a player
 * would notice. Cheap enough to leave on (nothing is written unless something
 * changed) and readable at /api/live/report.
 */
const LIVE_NOTES = 60;

function liveNote(session, event, detail = {}) {
  if (!session.notes) session.notes = [];
  session.notes.push({ at: Date.now(), event, ...detail });
  if (session.notes.length > LIVE_NOTES) session.notes.splice(0, session.notes.length - LIVE_NOTES);
}

/** The number in seg000123.m4s, which is what says whether a window rolled
    forward normally or was started over underneath somebody. */
function segNumber(name) {
  const hit = /(\d+)\.(m4s|ts)$/.exec(String(name || ''));
  return hit ? Number(hit[1]) : null;
}

/**
 * Watch one served playlist go past, and write down anything a player would
 * react to: the window rolling on, and — the fault this exists for — the
 * media sequence or the first segment going BACKWARDS, which is a player's
 * cue to treat the whole thing as a new stream and join it at the beginning.
 */
function watchLivePlaylist(session, text) {
  const segments = [...text.matchAll(/^([^#\s].*\.(?:m4s|ts))\s*$/gm)].map((m) => m[1]);
  if (!segments.length) return;
  const sequence = Number((/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text) || [])[1] ?? -1);
  const first = segNumber(segments[0]);
  const last = segNumber(segments[segments.length - 1]);
  const seen = session.window || {};

  const moved = seen.first !== first || seen.last !== last || seen.sequence !== sequence;
  if (!moved) return;

  const wentBack = (Number.isFinite(seen.first) && Number.isFinite(first) && first < seen.first)
    || (seen.sequence >= 0 && sequence >= 0 && sequence < seen.sequence);
  session.window = { first, last, sequence, count: segments.length };
  if (wentBack) {
    liveNote(session, 'window-restarted', {
      was: { first: seen.first, last: seen.last, sequence: seen.sequence },
      now: { first, last, sequence },
    });
  } else if (!Number.isFinite(seen.first)) {
    liveNote(session, 'window-open', { first, last, sequence, count: segments.length });
  } else if (seen.first !== first) {
    // The window rolling is ordinary; noted sparsely so the log covers
    // minutes rather than the last twenty seconds.
    liveNote(session, 'window-rolled', { first, last, sequence, count: segments.length });
  }
}

/** Start (or restart) the ingest for a live session. */
function spawnLiveDvr(session, input, resumed = false) {
  // The session remembers whether it is the small one, so a respawn after a
  // dropped feed comes back the same size it went away.
  const args = liveDvrArgs(input, session.dir, resumed, Boolean(session.low));
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  liveNote(session, resumed ? 'ingest-resumed' : 'ingest-started', {
    // The one argument this report is really about: a resume that went back
    // for the provider's backlog is what replays a minute somebody watched.
    /* Names the depth, not just the end it counted from: "ten segments back"
       is the line that would have settled the ten-minute replay in one look,
       where "the provider's oldest segment" read as harmless. */
    from: resumed ? 'provider live edge'
      : `${COLD_START_SEGMENTS} segments back from the provider's live edge`,
    restarts: session.restarts || 0,
  });
  session.proc = proc;
  session.exited = false;
  session.exitCode = undefined;
  session.args = redactUrl(args.join(' '));
  proc.stderr.on('data', (d) => {
    const text = d.toString();
    if (session._stderrHead.length < 6000) session._stderrHead += text;
    session._stderr = (session._stderr + text).slice(-2000);
  });
  proc.on('exit', (code) => {
    session.exited = true;
    session.exitCode = code;
    liveNote(session, 'ingest-exited', {
      code,
      /* The last few lines, not the last one. The final line is the encoder's
         own sign-off — "Qavg: 568.015" — which says nothing about why the
         run ended; the reason is a line or two above it, and a capture that
         cuts it off is a capture that cannot be read. */
      last: (session._stderr || '').split('\n').filter(Boolean).slice(-4).join(' | '),
    });
    if (remuxSessions.get(session.id) !== session) return; // killed on purpose
    // The feed dropped out from under an audience: reconnect. append_list
    // makes the new run continue the same playlist, so from the player's side
    // this is a pause in new segments, not an ending.
    if (Date.now() - session.lastAccess > LIVE_DVR.restartWindowMs) return;
    session.restarts = (session.restarts || 0) + 1;
    if (session.restarts > 30) return; // a feed this dead is an ending
    setTimeout(() => {
      if (remuxSessions.get(session.id) !== session) return;
      if (Date.now() - session.lastAccess > LIVE_DVR.restartWindowMs) return;
      spawnLiveDvr(session, input, true);
    }, 2000).unref();
  });
}

/**
 * The DVR session for a channel, started if it is not already running.
 * Shared: a second viewer of the same channel joins the same window on the
 * same single provider connection.
 */
async function ensureLiveDvr(cfg, channelId, low = false) {
  // The shrunk feed is a different ingest of the same channel and gets its
  // own name: one viewer on weak Wi-Fi must not replace the full-size feed
  // everybody else in the house is watching.
  const id = `live-${low ? 'lo-' : ''}${channelId}`;
  const existing = remuxSessions.get(id);
  if (existing && !(existing.exited && Date.now() - existing.lastAccess > LIVE_DVR.restartWindowMs)) {
    existing.lastAccess = Date.now();
    return existing;
  }
  if (existing) killSession(id);

  fs.mkdirSync(HLS_DIR, { recursive: true });
  const dir = path.join(HLS_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Ingest reads the provider's HLS, not its TS push feed — see the
  // live_start_index note in liveDvrArgs for why that decides startup time.
  //
  // One login for the life of the session, chosen now: a respawn after a
  // dropped feed reuses the same URL, so the same account carries the channel
  // from the first segment to the last rather than hopping between logins
  // every time the provider hiccups.
  //
  // Reserved until take() below, the same way /api/play holds a proxy URL:
  // without it, two tune-ins at once both see the last free slot and one of
  // them starts on an account that is already in use. If nothing is free,
  // still start — multiview and a recording already in progress are the
  // cases that need a second window — but take() the first login anyway so
  // the pool is not left reading idle while ffmpeg is pulling.
  const account = providers.pick(cfg, { reserve: true }) || providers.accounts(cfg)[0] || null;
  if (!account) throw new Error('No free provider connection for live ingest');
  const input = buildStreamUrl(account, 'live', channelId, 'm3u8');

  const session = {
    id,
    dir,
    live: true,
    low,
    lastAccess: Date.now(),
    fromProvider: true,
    idleMs: LIVE_DVR.idleMs,
    offset: 0,
    sourceDuration: 0,
    prebuffer: 0,
    subs: [],
    _stderr: '',
    _stderrHead: '',
    stderr() { return this._stderr; },
    stderrHead() { return this._stderrHead; },
    args: '',
  };
  /* The ingest holds its slot for as long as ffmpeg is running, which is what
     makes a live channel cost one connection however many people are watching
     it — they all read the Pi's window rather than the provider. take()
     consumes the reservation from pick() above. */
  session.account = account.id;
  session.releaseSlot = providers.take(account.id);
  remuxSessions.set(id, session);
  lastProviderActiveAt = Date.now();
  autoPauseActiveDownload();
  spawnLiveDvr(session, input);

  // Two segments inside the short wait, and that bar is doing real work: it
  // is a SPEED test, not just an existence test. A healthy feed banks the
  // provider's backlog several times faster than realtime, so two segments
  // appear in two or three seconds. A feed being throttled to about realtime
  // cannot produce them in time — and that is exactly the feed on which a
  // shallow buffer is worse than no buffer, because a viewer seated in it
  // rides the ingest frontier, stalling every few seconds. Slow feeds belong
  // on the direct path, and this bar is what sends them there.
  const playlist = path.join(dir, 'index.m3u8');
  const deadline = Date.now() + LIVE_DVR.startWaitMs;
  while (Date.now() < deadline) {
    session.lastAccess = Date.now(); // warming is not idleness
    if (fs.existsSync(playlist)) {
      const text = fs.readFileSync(playlist, 'utf8');
      if ((text.match(/\.(m4s|ts)/g) || []).length >= 2) return session;
    }
    if (session.exited && session.exitCode !== 0) {
      const detail = session._stderr.split('\n').filter(Boolean).pop() || `exit ${session.exitCode}`;
      killSession(id);
      throw new Error(`Live ingest failed: ${redactUrl(detail)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  killSession(id);
  throw new Error('Live ingest timed out starting');
}

/* ---- archive thumbnails ---- */

const THUMB_DIR = path.join(ROOT, 'thumbs');
const thumbInFlight = new Map(); // rel -> promise
let thumbRunning = 0;
const thumbWaiting = [];

function makeArchiveThumb(rel, abs, item, outFile) {
  if (thumbInFlight.has(rel)) return thumbInFlight.get(rel);
  const job = new Promise((resolve, reject) => {
    const run = () => {
      thumbRunning += 1;
      // A quarter of the way in: past any titles, deterministic, and clamped
      // so a short file still lands inside itself.
      const at = Math.max(1, Math.min((item.duration || 240) * 0.25, (item.duration || 240) - 5));
      const tmp = `${outFile}.part.jpg`;
      const proc = spawn('ffmpeg', [
        '-v', 'error', '-y',
        '-ss', String(Math.floor(at)),
        '-i', abs,
        '-frames:v', '1',
        '-vf', 'scale=480:-2',
        '-q:v', '5',
        tmp,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
      // A hung read off a failing drive must not wedge the queue.
      const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        thumbRunning -= 1;
        if (thumbWaiting.length) thumbWaiting.shift()();
        if (code === 0 && fs.existsSync(tmp)) {
          fs.renameSync(tmp, outFile);
          resolve();
        } else {
          fs.rmSync(tmp, { force: true });
          reject(new Error(stderr.split('\n').filter(Boolean).pop() || `ffmpeg exit ${code}`));
        }
      });
    };
    if (thumbRunning < 2) run();
    else thumbWaiting.push(run);
  }).finally(() => thumbInFlight.delete(rel));
  thumbInFlight.set(rel, job);
  return job;
}

/* ------------------------------------------------------------- m3u parsing */

/**
 * Parse a plain M3U/M3U8 playlist into channel records. Handles the usual
 * tvg-* attribute soup plus group-title.
 */
function parseM3U(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([a-zA-Z0-9-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(line))) attrs[m[1].toLowerCase()] = m[2];

      // The display name is everything after the first comma that isn't inside
      // a quoted attribute value. Splitting on the last comma instead would
      // mangle any title containing one ("Sample Movie, The").
      let inQuotes = false;
      let split = -1;
      for (let i = '#EXTINF:'.length; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) {
          split = i;
          break;
        }
      }
      const name = split === -1 ? '' : line.slice(split + 1).trim();
      pending = {
        name: name || attrs['tvg-name'] || 'Untitled',
        logo: attrs['tvg-logo'] || '',
        epgId: attrs['tvg-id'] || '',
        group: attrs['group-title'] || 'Uncategorized',
      };
    } else if (line.startsWith('#')) {
      continue;
    } else if (pending) {
      let url = line;
      if (baseUrl) {
        try {
          url = new URL(line, baseUrl).toString();
        } catch {
          /* keep the raw line — handleStream will reject it */
        }
      }
      pending.url = url;
      pending.id = `m3u-${out.length}`;
      out.push(pending);
      pending = null;
    }
  }
  return out;
}

/** Sort M3U entries into live / movie / series buckets by URL path. */
function bucketM3U(entries) {
  const buckets = { live: [], movie: [], series: [] };
  for (const e of entries) {
    let kind = 'live';
    if (/\/movie\//i.test(e.url) || /\.(mp4|mkv|avi)(\?|$)/i.test(e.url)) kind = 'movie';
    if (/\/series\//i.test(e.url)) kind = 'series';
    buckets[kind].push({ ...e, kind });
  }
  return buckets;
}

/* ---------------------------------------------------------- stream proxying */

const b64url = {
  encode: (s) => Buffer.from(s, 'utf8').toString('base64url'),
  decode: (s) => Buffer.from(String(s), 'base64url').toString('utf8'),
};

function proxyPath(absoluteUrl) {
  return `/stream?u=${encodeURIComponent(b64url.encode(absoluteUrl))}`;
}

/**
 * HLS playlists reference segments and sub-playlists by relative URL. If we
 * hand the raw text to the browser it will try to load them from our own
 * origin. Rewrite every reference to an absolute, proxied URL.
 */
function rewritePlaylist(text, baseUrl) {
  const abs = (ref) => {
    try {
      return proxyPath(new URL(ref, baseUrl).toString());
    } catch {
      return ref;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // Rewrite URI="..." on EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP, etc.
        return line.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${abs(ref)}"`);
      }
      return abs(t);
    })
    .join('\n');
}

/* ------------------------------------------------------- live TS pacing ---

 * Xtream servers dump a deep backlog the moment you connect — measured at
 * ~31 seconds of video delivered in the first 6 seconds, then realtime but in
 * lumpy 4-5s chunks. Handing that straight to the player leaves it 25+ seconds
 * behind live, which is what makes a latency-chasing client seek repeatedly.
 *
 * So we swallow the backlog here and only start forwarding once the provider
 * has caught up to realtime. The client then joins near the live edge and never
 * needs to chase.
 */

/** Read the PCR (program clock reference) out of a TS packet, in seconds. */
function readPcr(buf, i) {
  const adaptationControl = (buf[i + 3] & 0x30) >> 4;
  if (adaptationControl !== 2 && adaptationControl !== 3) return null;
  const fieldLength = buf[i + 4];
  if (fieldLength < 7) return null;
  if (!(buf[i + 5] & 0x10)) return null; // PCR_flag clear
  const base =
    buf[i + 6] * 33554432 +
    buf[i + 7] * 131072 +
    buf[i + 8] * 512 +
    buf[i + 9] * 2 +
    ((buf[i + 10] & 0x80) >> 7);
  return base / 90000;
}

/**
 * Locate a genuine TS packet boundary: a 0x47 that recurs at the 188-byte
 * stride. Returns -1 if this buffer doesn't contain enough to be sure.
 */
function findSync(buf, confirmations = 3) {
  const limit = buf.length - 188 * confirmations;
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] !== 0x47) continue;
    let ok = true;
    for (let n = 1; n <= confirmations; n += 1) {
      if (buf[i + 188 * n] !== 0x47) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Pipe upstream → res, discarding the opening backlog. "Caught up" means the
 * media clock has stopped running ahead of the wall clock; `capSeconds` bounds
 * how long we're willing to wait so channel changes stay responsive.
 */
function pipeLive(upstream, res, capSeconds, holdSeconds = 0) {
  const startWall = Date.now();
  let firstPcr = null;
  let lastPcr = null;
  let peakExcess = -Infinity;
  let lastGrowth = Date.now();
  let draining = true;
  let alignPending = false;
  let carry = Buffer.alloc(0);

  // Content arrives in ~5s lumps with gaps between. Sitting exactly on the live
  // edge means those gaps starve the decoder, so optionally bank a few seconds
  // before playing — latency traded for a buffer that absorbs the jitter.
  let holding = holdSeconds > 0;
  let holdStart = 0;
  let held = [];

  const stopDraining = () => {
    draining = false;
    alignPending = true;
    carry = Buffer.alloc(0);
    holdStart = Date.now();
  };

  const release = () => {
    holding = false;
    for (const piece of held) res.write(piece);
    held = [];
  };

  upstream.on('data', (chunk) => {
    if (!draining) {
      let out = chunk;
      if (alignPending) {
        // Resume on a real packet boundary. 0x47 shows up all over payload
        // data, so a lone match proves nothing — require it to repeat at the
        // 188-byte packet stride before trusting it.
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const at = findSync(buf);
        if (at < 0) {
          // Keep a tail in case the boundary straddles this chunk.
          carry = buf.subarray(Math.max(0, buf.length - 188 * 4));
          return;
        }
        out = buf.subarray(at);
        carry = Buffer.alloc(0);
        alignPending = false;
      }

      if (holding) {
        held.push(out);
        if (Date.now() - holdStart >= holdSeconds * 1000) release();
        return;
      }

      if (!res.write(out)) upstream.pause();
      return;
    }

    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let i = 0;
    let boundary = 0;
    while (i + 188 <= buf.length) {
      if (buf[i] !== 0x47) {
        i += 1;
        continue;
      }
      const pcr = readPcr(buf, i);
      if (pcr !== null) {
        if (firstPcr === null) firstPcr = pcr;
        lastPcr = pcr;
      }
      i += 188;
      boundary = i;
    }
    carry = buf.subarray(boundary);

    const wall = (Date.now() - startWall) / 1000;
    if (firstPcr !== null && lastPcr !== null) {
      const excess = lastPcr - firstPcr - wall;
      if (excess > peakExcess + 1) {
        peakExcess = excess;
        lastGrowth = Date.now();
      }
    }

    // Settled = the backlog stopped growing for a beat. Capped either way.
    const idle = (Date.now() - lastGrowth) / 1000;
    if (wall >= capSeconds || (idle > 2.5 && wall > 1.5)) stopDraining();
  });

  res.on('drain', () => upstream.resume());
  upstream.on('end', () => {
    if (holding) release();
    res.end();
  });
  upstream.on('error', () => res.end());
}

function isPlaylist(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  return (
    ct.includes('mpegurl') ||
    ct.includes('x-mpegurl') ||
    /\.m3u8(\?|$)/i.test(url)
  );
}

async function handleStream(req, res, query) {
  const encoded = query.get('u');
  if (!encoded) return send(res, 400, 'Missing u');

  let target;
  try {
    target = b64url.decode(encoded);
    const parsed = new URL(target);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
  } catch {
    return send(res, 400, 'Bad target URL');
  }

  const denied = proxyAllowed(target);
  if (denied) return send(res, 400, denied);

  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;

  let upstream;
  try {
    upstream = await request(target, { headers, allowUrl: proxyAllowed });
  } catch (err) {
    return send(res, 502, `Upstream error: ${err.message}`);
  }

  req.on('close', () => {
    try { upstream.destroy(); } catch { /* already gone */ }
  });

  const contentType = upstream.headers['content-type'] || '';

  if (isPlaylist(upstream.finalUrl, contentType)) {
    /* A playlist fetch is not a stream. Counting it as one made the first
       HLS request consume the /api/play reservation, then drop it the moment
       the text arrived, so the segments that actually occupy the provider
       arrived as extra takes on an account that already looked full. */
    let body;
    try {
      body = await readBody(upstream, 8 * 1024 * 1024);
    } catch (err) {
      return send(res, 502, `Upstream error: ${err.message}`);
    }
    const rewritten = rewritePlaylist(body.toString('utf8'), upstream.finalUrl);
    res.writeHead(upstream.statusCode || 200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    return res.end(rewritten);
  }

  /* This connection is now occupying a slot on whichever login its
     credentials belong to. The slot is taken here rather than where the URL
     was built because here is where the pipe actually opens — and released
     whichever way the response ends. */
  const account = providers.forUrl(readConfig(), target);
  const giveBack = account ? providers.take(account.id) : null;
  providerStreams += 1;
  lastProviderActiveAt = Date.now();
  autoPauseActiveDownload();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (giveBack) giveBack();
    providerStreams = Math.max(0, providerStreams - 1);
    lastProviderActiveAt = Date.now();
  };
  res.on('close', release);
  upstream.on('close', release);

  const passthrough = {};
  for (const h of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
  ]) {
    if (upstream.headers[h]) passthrough[h] = upstream.headers[h];
  }
  passthrough['access-control-allow-origin'] = '*';

  res.writeHead(upstream.statusCode || 200, passthrough);

  // Live TS only: drop the provider's opening backlog so the player joins near
  // the live edge. Movies must never be drained — you'd lose the opening.
  // Both numbers are query-controlled, so they are capped: an unbounded hold
  // buffers the whole stream in RAM, and drain=1e10 never starts forwarding.
  const drain = Math.min(30, Math.max(0, Number(query.get('drain')) || 0));
  const hold = Math.min(15, Math.max(0, Number(query.get('hold')) || 0));
  // Riding alongside the pipe, not replacing it — this is the same provider
  // connection a download would use, so its rate belongs in the same meter.
  upstream.on('data', (chunk) => meterBytes(chunk.length));
  if (drain > 0) pipeLive(upstream, res, drain, hold);
  else upstream.pipe(res);
}

/** Logos and posters are frequently http-only or hotlink-blocked. */
async function handleImage(req, res, query) {
  const src = query.get('u');
  if (!src) return send(res, 400, 'Missing u');
  const denied = proxyAllowed(src);
  if (denied) return send(res, 400, denied);
  try {
    const upstream = await request(src, {
      headers: { accept: 'image/*' },
      timeout: 10000,
      allowUrl: proxyAllowed,
    });
    if ((upstream.statusCode || 500) >= 400) {
      upstream.resume();
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, {
      'content-type': upstream.headers['content-type'] || 'image/jpeg',
      'cache-control': 'public, max-age=86400',
    });
    req.on('close', () => {
      try { upstream.destroy(); } catch { /* already gone */ }
    });
    upstream.pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

/* ---------------------------------------------------------------- library

 * One call per section that does the expensive work on the server: filter to
 * the categories worth showing, then strip each record down to the handful of
 * fields the UI actually renders. The provider's raw payloads run to tens of
 * megabytes; re-serialising those on a Pi and pushing them over Tailscale is
 * what made the grids take forever to appear.
 */

const LIBRARY_ACTIONS = {
  live: ['get_live_categories', 'get_live_streams', 'live'],
  movies: ['get_vod_categories', 'get_vod_streams', 'movie'],
  series: ['get_series_categories', 'get_series', 'series'],
};

/* How many channels a guide may ask about, how long a listing stays good,
 * and how many the box will fetch in one go.
 *
 * The cap is not tuning for its own sake: each one is a separate call to a
 * provider with a single connection. The page may ASK about forty — a
 * category listing is a whole page of channels, not a handful of favourites
 * — but only six are fetched per request, and the rest come back empty and
 * fill in on the next poll. A guide that arrives a row at a time is a guide;
 * forty calls fired at once is a denial of service against yourself.
 *
 * The TTL is generous because a programme that started twenty minutes ago is
 * still the programme that is on. */
const EPG_MAX_CHANNELS = 40;
const EPG_TTL_MS = 15 * 60 * 1000;
const EPG_PER_REQUEST = 6;
const epgCache = new Map();

/**
 * The slice of a day's listings worth sending to a browser.
 *
 * The guide index holds a day and a half so the page can be opened at any
 * hour without a refetch; a single answer only ever needs what is on now and
 * what follows it. Sending the lot would be a megabyte of JSON per poll.
 */
/* Thirty-two rather than sixteen because the schedule can now be scrolled
   forward. Sixteen was one screen's worth from now, which is all the guide
   ever drew; asking what is on in eight hours means the answer has to still
   be in the list by then, and half-hour programmes run out of sixteen before
   nine o'clock. */
function windowOf(listings, now) {
  const from = Math.floor(now / 1000) - 3600;
  const to = Math.floor(now / 1000) + 12 * 3600;
  return listings.filter((l) => l.stop > from && l.start < to).slice(0, 32);
}

const libraryCache = new Map();
const LIBRARY_TTL = 30 * 60 * 1000;
/** Payload shape version — bump when projectItem gains or loses a field. */
const LIBRARY_SHAPE = 8;
const LIBRARY_CACHE_PATH = path.join(ROOT, 'library-cache.json');

/**
 * Survive restarts. Re-pulling 141MB from the provider on every boot is the
 * difference between the grid appearing instantly and staring at a skeleton.
 */
function loadLibraryCache() {
  try {
    const rows = JSON.parse(fs.readFileSync(LIBRARY_CACHE_PATH, 'utf8'));
    for (const [key, entry] of Object.entries(rows)) {
      // Drop entries written by older payload shapes; without this the file
      // accumulates every shape and filter pattern it has ever seen.
      if (!key.startsWith(`v${LIBRARY_SHAPE}:`)) continue;
      libraryCache.set(key, entry);
    }
  } catch {
    /* no cache yet */
  }
}

/* ------------------------------------------------------- the outside guide */

/**
 * Guides worth offering, so nobody has to go and find a URL.
 *
 * These are the open XMLTV feeds the IPTV world runs on. They are listed
 * rather than switched on by default: they are somebody else's server, and
 * quietly making the box fetch half a gigabyte a day from a stranger is not a
 * decision to take on a viewer's behalf. Pick the ones that match what you
 * actually watch — a US household wants the first two and nothing else, and
 * every feed added is another few hundred megabytes to scan.
 *
 * These names go stale. `US1` became `US2` and `US_LOCALS2` became
 * `US_LOCALS1` without anything announcing it, and a list written down here
 * cannot know that — it just starts answering 404. Which is why the screen
 * can read the host's own index: when one of these stops working, trust that
 * over this.
 */
const GUIDE_CATALOGUE = [
  { label: 'United States', url: 'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz' },
  { label: 'US local stations', url: 'https://epgshare01.online/epgshare01/epg_ripper_US_LOCALS1.xml.gz' },
  { label: 'US sports', url: 'https://epgshare01.online/epgshare01/epg_ripper_US_SPORTS1.xml.gz' },
  { label: 'United Kingdom', url: 'https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz' },
  { label: 'Canada', url: 'https://epgshare01.online/epgshare01/epg_ripper_CA1.xml.gz' },
  { label: 'Netherlands', url: 'https://epgshare01.online/epgshare01/epg_ripper_NL1.xml.gz' },
  { label: 'Germany', url: 'https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz' },
  { label: 'Turkey', url: 'https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz' },
  { label: 'Everything, every country', url: 'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz' },
];

/**
 * Every live channel the box currently knows about.
 *
 * Read out of the library cache rather than pulled from the provider on
 * purpose: the guide refresh must never be the reason a 141MB catalogue gets
 * fetched. If the cache is cold the refresh simply waits for the next tick,
 * by which time somebody will have opened Live TV and filled it.
 */
/**
 * Everything the box has a listing for on a tab, out of whatever it has cached.
 *
 * The same trick knownLiveChannels() uses next door: the library is fetched
 * per category and per filter, so there is no one list to point at — but the
 * cache holds every page that has been asked for, and folding them together
 * is the closest thing to a catalogue this box has without going back to the
 * provider for one.
 *
 * `tab` is the TAB NAME, because that is what the cache key is built from —
 * 'movies', plural, not 'movie'. The singular matched no key that has ever
 * existed, which returned an empty catalogue, made the recommendation come
 * back "no library", and took the whole row off the page.
 */
function knownCatalogue(tab) {
  const seen = new Map();
  for (const [key, entry] of libraryCache) {
    if (!key.startsWith(`v${LIBRARY_SHAPE}:${tab}:`)) continue;
    for (const item of entry.payload?.items || []) {
      if (!seen.has(String(item.id))) seen.set(String(item.id), item);
    }
  }
  return [...seen.values()];
}

/** Every film the box has a listing for. */
function knownMovies() {
  return knownCatalogue('movies');
}

/** Every show the box has a listing for. Same trick, other tab. */
function knownSeries() {
  return knownCatalogue('series');
}

/** What an audience reached for, remembered across restarts of this process. */
const similarCache = new Map();

/*
 * "Not that one" — said about a SUGGESTION, not about a title.
 *
 * The bin on a shelf card hides a title from the library: it is how somebody
 * gets rid of the eleven copies of a film they will never watch, and it is
 * meant to be permanent and everywhere. The bin on a For You card is a
 * different sentence entirely — "stop offering me this" — and paying for it
 * with the title itself would be a trap: the row is full of things nobody has
 * seen, so the only way to find out whether you want one is to open it, and
 * dismissing the ones you don't should not quietly delete them out of search
 * and off every other shelf.
 *
 * So it is stored separately, per profile and per kind, and read by exactly
 * one thing: the recommender.
 */
function notInterestedIds(profile, kind) {
  const want = kind === 'series' ? 'series' : 'movie';
  return (profile.notInterested || [])
    .filter((key) => String(key).startsWith(`${want}:`))
    .map((key) => String(key).slice(want.length + 1));
}

function knownLiveChannels() {
  const seen = new Map();
  for (const [key, entry] of libraryCache) {
    if (!key.startsWith(`v${LIBRARY_SHAPE}:live:`)) continue;
    for (const item of entry.payload?.items || []) {
      if (!seen.has(String(item.id))) {
        seen.set(String(item.id), {
          id: item.id,
          epgId: item.epgId || '',
          name: item.name || '',
          /* The country the provider files it under — "US" out of "US| ABC".
           * splitTitle already lifted it off the name into `tag`; the guide
           * needs it to keep ABC.us and ABC.au apart. */
          country: String(item.tag || '').split(/\s+/)[0] || '',
        });
      }
    }
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------ NFL scores */

/**
 * The football slate, from ESPN's public scoreboard.
 *
 * Chosen because it needs no key: a key in a page served to the living room
 * is a key given away, and the alternative feeds all want one. It is
 * undocumented rather than private — the same endpoint espn.com's own
 * scoreboard reads — so every field is taken defensively and a shape that has
 * moved yields no games rather than an exception.
 *
 * Mapped HERE rather than in the television, so the app stays a reader: one
 * place understands ESPN, one cache serves every screen in the house, and the
 * Shield never learns where any of it came from.
 */
/**
 * Where a football slate may be asked for, in order.
 *
 * `<SPORT>_URLS` is a comma-separated list and overrides everything;
 * `<SPORT>_URL` is the single-address override that was here first and still
 * works; otherwise the built-in chain. Whatever the address, what comes back
 * is read by footballGames() below, which works out which scoreboard it is
 * looking at rather than being told.
 */
function feedAddresses(list, one, fallback) {
  const given = String(list || '')
    .split(',')
    .map((entry) => {
      /* A '+' joins addresses into a GROUP — fetched together and merged
         rather than one after the other. It is how the built-in college list
         asks a day either side of today, and an override has to be able to
         say the same thing or it cannot stand in for the list it replaces. */
      const parts = entry.split('+').map((u) => u.trim()).filter(Boolean);
      return parts.length > 1 ? parts : (parts[0] || '');
    })
    .filter((entry) => (Array.isArray(entry) ? entry.length : entry));
  if (given.length) return given;
  if (one) return [one];
  return fallback;
}

/*
 * The zone this house keeps time in.
 *
 * Not the box's, and not the browser's. The box's zone is a setting nobody
 * looks at and the browser's is wherever a laptop happens to be open, and a
 * kickoff drawn in either is a number that changes meaning depending on
 * which screen you read it from. This household is in the Eastern zone and
 * does not travel, so the times are Eastern — said once, here, rather than
 * negotiated on every screen.
 *
 * It is also the zone the scoreboards themselves are filed under, which is
 * the other reason: asking for "today" means asking for the day the games
 * are on, and that day turns over at midnight Eastern.
 */
const HOUSE_ZONE = 'America/New_York';

/* Today, in that zone. A Saturday's late games run past midnight and are
   filed under the day they started. */
function easternDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HOUSE_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

/*
 * Not ESPN.
 *
 * ESPN refuses this box and it is not a header or a query string: the report
 * from the box came back 403 on site.api.espn.com for the NFL scoreboard and
 * for all four college addresses, an empty body from cdn.espn.com, and the
 * user agent has been a browser's the whole time. Six addresses at one
 * publisher is one address, asked six ways.
 *
 * So these are other people's scoreboards, and the shape each one answers in
 * is worked out from the answer rather than assumed — which is what lets a
 * list mix publishers at all.
 *
 * THE NCAA'S OWN, which is the same argument that makes baseball the feed
 * that has never once failed: when the body that runs the sport publishes the
 * scores, ask them. Filed by date and division, so `fbs` is the cut that
 * `groups=80` was asking ESPN for. Two path shapes because the box answered
 * 404 to the one without `all-conf` in it and that is the likelier spelling,
 * not a certainty; and a public mirror of the same data on a different host,
 * for the day data.ncaa.com is the one refusing us.
 *
 * THESPORTSDB, last, and the only one of these that also knows about the NFL.
 * A day's fixtures rather than a live scoreboard, so it lags — but a card
 * with the right two teams and a start time on it is a card, and the football
 * band has had nothing at all. Key 3 is their published free one; 123 is the
 * other published free one, in case the first has been retired.
 */
const SPORTSDB_KEYS = ['3', '123'];
const stamp = ({ year, month, day }) => `${year}-${month}-${day}`;

/*
 * TheSportsDB's addresses, in the order they are worth asking.
 *
 * Filed by day, which is the whole difficulty: whose day? A game at eight in
 * the evening Eastern is the small hours of tomorrow in UTC. So the days are
 * a GROUP — fetched together and merged — rather than three entries in a
 * row, because a list stops at the first address that ANSWERS and a day with
 * one game on it is an answer.
 *
 * `league` is a NAME, and it has to be the name this publisher uses. Asked
 * for 'NCAA Football' it replies, politely and with a 200,
 * `{"events":[],"Message":"Invalid League ID passed"}` — which reads as a
 * quiet Saturday until something prints the body. So college passes no name
 * at all and goes by sport and by league id instead, both of which this box
 * has watched answer.
 */
const sportsdbDay = (league, leagueId) => {
  const today = stamp(easternDate());
  const tomorrow = stamp(easternDate(new Date(Date.now() + 24 * 3600 * 1000)));
  const yesterday = stamp(easternDate(new Date(Date.now() - 24 * 3600 * 1000)));
  const day = (key, date, query) =>
    `https://www.thesportsdb.com/api/v1/json/${key}/eventsday.php?d=${date}&${query}`;
  const days = (query) => [yesterday, today, tomorrow].map((d) => day(SPORTSDB_KEYS[0], d, query));
  /* The league's own next fixtures. No date in the address, so it is the one
   * form that cannot be asked for the wrong day.
   *
   * INSIDE the group, never as an entry of its own. It lists what has not
   * started yet — by definition it cannot contain a game being played — so
   * standing alone on the chain it is a source that makes live games
   * disappear: any hiccup in the addresses above it and the list falls
   * through to an answer that can only hold the future. A one o'clock game
   * went missing at half past five while the six o'clock one stayed. As part
   * of the group it merges with the day and can only ever add. */
  const next = leagueId
    ? [`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEYS[0]}/eventsnextleague.php?id=${leagueId}`]
    : [];
  return [
    ...(league ? [[...days(`l=${encodeURIComponent(league)}`), ...next]] : []),
    /* By sport, which answers every American code at once — the Canadian one
       included, so footballGames() keeps only the rows belonging to the code
       being asked for. */
    [...days('s=American%20Football'), ...next],
    // And the other published free key, for the day the first one is retired.
    ...(league ? [day(SPORTSDB_KEYS[1], today, `l=${encodeURIComponent(league)}`)] : []),
  ];
};

/* A day either side of today, asked together and merged.
 *
 * The NCAA files a game under the day it KICKED OFF, and a college Saturday
 * does not fit inside a calendar day: a ten-thirty kickoff on the east coast
 * is still being played at half past one the next morning, by which time
 * "today" is a different file with that game nowhere in it.
 *
 * A GROUP, not three more entries on the list. Three separate addresses
 * would stop at the first that answered, which is the same single day again;
 * these are fetched together, merged and de-duplicated, and the group as a
 * whole is one answer. What is out of date drops out at the window.
 *
 * data.ncaa.com is not on this list any more. Four addresses were tried
 * there and all four answered 404 NoSuchKey — not a refusal, a path that
 * does not exist — while this mirror of the same data answered thirty-five
 * kilobytes of Saturday. Guessing at somebody else's bucket layout is not
 * worth four requests a poll when the thing being guessed at is already
 * being served.
 */
const ncaaDay = ({ year, month, day }) =>
  `https://ncaa-api.henrygd.me/scoreboard/football/fbs/${year}/${month}/${day}/all-conf`;

/*
 * ESPN, on a host this box has never asked.
 *
 * Every refusal so far has come from site.api.espn.com, with an empty body
 * from cdn.espn.com — and those are two of at least five addresses ESPN
 * serves this data from. site.web.api.espn.com carries the same paths as the
 * one that refuses us, right down to `apis/site/v2/sports/football/...`, so
 * whatever comes back needs no new reader: it is the shape nflGame() has
 * understood all along.
 *
 * First on both lists, because it is the only source anywhere on them that
 * publishes the DOWN, THE DISTANCE AND THE SPOT — which is the ball on the
 * field, the thing the card was built to draw and has had nothing to draw
 * with since ESPN stopped answering. It also gives an exact kickoff and a
 * running game clock, where a fixtures list gives a scheduled time and lags.
 *
 * Costs one request per poll when it is refused, and the list falls straight
 * through to what is working now.
 */
const espnWeb = (league, query) =>
  `https://site.web.api.espn.com/apis/site/v2/sports/football/${league}/scoreboard${query || ''}`;

function collegeAddresses() {
  const today = easternDate();
  const yesterday = easternDate(new Date(Date.now() - 24 * 3600 * 1000));
  const tomorrow = easternDate(new Date(Date.now() + 24 * 3600 * 1000));
  return [
    espnWeb('college-football', '?groups=80&limit=100'),
    [ncaaDay(yesterday), ncaaDay(today), ncaaDay(tomorrow)],
    // No league NAME: this publisher does not know 'NCAA Football' as one.
    ...sportsdbDay(null, '4479'),
  ];
}

function proAddresses() {
  /* 4391 is the NFL on TheSportsDB. A league id that has changed costs one
     address answering nothing, which the list walks straight past. */
  return [espnWeb('nfl'), ...sportsdbDay('NFL', '4391')];
}

/** The addresses this feed will knock on, resolved for today. */
const nflUrls = () => feedAddresses(process.env.NFL_URLS, process.env.NFL_URL, proAddresses());
const ncaafUrls = () =>
  feedAddresses(process.env.NCAAF_URLS, process.env.NCAAF_URL, collegeAddresses());

/* Live scores move on every play, and a living room with four screens open
 * must not become four requests a second at somebody else's server. */
const NFL_TTL_MS = 30000;
let nflCache = { at: 0, goodAt: 0, games: [], error: '', source: '', tried: [] };

function nflStatus(state) {
  if (state === 'in') return 'live';
  if (state === 'post') return 'final';
  return 'upcoming';
}

const NCAAF_TTL_MS = 30000;
let ncaafCache = { at: 0, goodAt: 0, games: [], error: '', source: '', tried: [] };

/** One ESPN event as the Game shape `public/tv/js/scores.js` documents. */
function nflGame(event, sport = 'nfl') {
  const comp = (event.competitions || [])[0] || {};
  const status = comp.status || event.status || {};
  const type = status.type || {};
  const state = nflStatus(type.state);

  const side = (which) => {
    const c = (comp.competitors || []).find((x) => x.homeAway === which) || null;
    if (!c) return null;
    return {
      abbr: c.team?.abbreviation || c.team?.shortDisplayName || '',
      /* ESPN ships the club's mark with the scoreboard, so unlike baseball
         there is nothing to construct — the address is in the payload. Where
         it is missing on a college row the same table the NCAA scoreboard
         uses answers, so the coverage report means the same thing whichever
         address the slate came from. */
      logo: c.team?.logo
        || (sport === 'ncaaf'
          ? collegeMarks.logo(c.team?.location, c.team?.displayName, c.team?.shortDisplayName)
          : ''),
      record: (c.records || [])[0]?.summary || '',
      score: c.score === undefined || c.score === null || c.score === ''
        ? null : Number(c.score),
      // ESPN names the team that has the ball by id, not by side.
      possession: Boolean(comp.situation?.possession)
        && String(comp.situation.possession) === String(c.id ?? c.team?.id),
    };
  };

  const kickoff = Date.parse(comp.date || event.date || '') || 0;
  let clock = '';
  if (state === 'live') {
    const quarter = Number(status.period) || 0;
    // Overtime is period 5 and calling it Q5 is wrong on television.
    const label = quarter > 4 ? 'OT' : `Q${quarter}`;
    clock = [quarter ? label : '', status.displayClock || ''].filter(Boolean).join(' · ');
  } else if (state === 'final') {
    clock = type.shortDetail || 'Final';
  } else if (kickoff) {
    clock = new Date(kickoff).toLocaleTimeString('en-US',
      { timeZone: HOUSE_ZONE, hour: 'numeric', minute: '2-digit' });
  }

  const situation = state === 'live'
    ? [comp.situation?.shortDownDistanceText, comp.situation?.possessionText]
      .filter(Boolean).join(' · ')
    : '';

  // "FOX", "CBS", "NBC", "NFL Network" — close enough for matchChannel(),
  // which is deliberately loose about the provider's prefixes and suffixes.
  const network = (comp.broadcasts || [])
    .flatMap((b) => b.names || [])
    .filter(Boolean)[0] || '';

  let note = '';
  if (state === 'upcoming' && kickoff) {
    const mins = Math.round((kickoff - Date.now()) / 60000);
    if (mins > 0 && mins < 240) note = `Kicks off in ${mins} min`;
  }

  const away = side('away');
  const home = side('home');

  /*
   * Where the ball is, as a field rather than a sentence.
   *
   * A card draws a field with the ball on it, so it needs a position, not
   * "3rd & 7 · GB 41". The position is worked out from `possessionText` —
   * the club whose half the ball is in, and the yard number — rather than
   * from ESPN's own `yardLine`, whose zero end is not documented and would be
   * a coin flip drawn the wrong way round half the season.
   *
   * The field is laid out the way the card is: the away side's goal line on
   * the LEFT at 0, the home side's on the RIGHT at 100. So a ball on the away
   * team's own 41 is 41 yards from the left end; the same yard number on the
   * home team's side is 41 from the right, which is 59.
   */
  const spot = String(comp.situation?.possessionText || '').trim();
  let yardLine = null;
  const onSide = /^([A-Z]{2,4})\s+(\d{1,2})$/i.exec(spot);
  if (onSide) {
    const club = onSide[1].toUpperCase();
    const yards = Number(onSide[2]);
    if (away && club === String(away.abbr).toUpperCase()) yardLine = yards;
    else if (home && club === String(home.abbr).toUpperCase()) yardLine = 100 - yards;
  } else if (/midfield/i.test(spot)) {
    yardLine = 50;
  }

  const down = Number(comp.situation?.down) || null;
  const drive = state === 'live' && (down || yardLine !== null) ? {
    down,
    distance: Number(comp.situation?.distance) || null,
    /* ESPN's own words for it — "3rd & 7", "1st & Goal" — which is the line
       nobody should be reassembling from parts. */
    text: comp.situation?.shortDownDistanceText || comp.situation?.downDistanceText || '',
    spot,
    yardLine,
    /* Which way the offence is going, in the card's own terms: the side with
       the ball is driving at the other side's end zone. */
    driving: away && away.possession ? 'right' : (home && home.possession ? 'left' : ''),
    redZone: Boolean(comp.situation?.isRedZone),
  } : null;

  return {
    id: String(event.id || comp.id || ''),
    sport,
    status: state,
    /* ESPN's own description of the state — "Scheduled", "Halftime", "End of
       3rd Quarter", "Delayed". The card prints it under the start time the
       way baseball prints Warmup. */
    detailedState: type.shortDetail || type.description || '',
    channelMatch: network,
    channelName: network,
    /* How a game finds the provider's row for THAT game rather than the
       network carrying it.
     *
     * Two spellings per side, because the provider is not consistent and
     * college is where it shows. A pro row says 'BEARS X PACKERS'; a college
     * row is far likelier to say 'ALABAMA X GEORGIA' than 'CRIMSON TIDE X
     * BULLDOGS', and some rows use neither and go with 'ALA X UGA'. The
     * school name leads because it is the common case; the nickname is tried
     * after it rather than instead. */
    teamMatch: (comp.competitors || [])
      .map((c) => (sport === 'ncaaf'
        ? (c.team?.location || c.team?.shortDisplayName || '')
        : (c.team?.name || c.team?.shortDisplayName || '')))
      .filter(Boolean),
    teamAlt: (comp.competitors || [])
      .map((c) => (sport === 'ncaaf'
        ? (c.team?.name || '')
        : (c.team?.location || '')))
      .filter(Boolean),
    /* The two abbreviations, which is what a cramped provider row uses and
       what the guide sometimes carries. Short and therefore dangerous on
       their own — the matcher only reaches for them last. */
    teamShort: (comp.competitors || [])
      .map((c) => c.team?.abbreviation || '')
      .filter(Boolean),
    redZone: false,
    away,
    home,
    clock,
    situation,
    drive,
    kickoff,
    note,
    // Left null on purpose: where a channel matches, the real EPG start and
    // stop describe the broadcast better than a guess from the game clock.
    progress: null,
    placeholder: false,
  };
}

/**
 * The events out of an ESPN scoreboard answer, whichever address it came from.
 *
 * The site API puts them at the top level. espn.com's own feed wraps the very
 * same objects a couple of levels down. Reading both here is what lets the
 * addresses above stand in for each other without nflGame() knowing.
 */
function espnEvents(body) {
  if (Array.isArray(body?.events)) return body.events;
  if (Array.isArray(body?.content?.sbData?.events)) return body.content.sbData.events;
  if (Array.isArray(body?.scoreboard?.events)) return body.scoreboard.events;
  return [];
}

/*
 * The NCAA's own scoreboard.
 *
 * Unauthenticated, filed by the day's date and by division, so `fbs` is the
 * cut `groups=80` used to ask ESPN for. It carries the score, the period, the
 * clock, the start time and the network — everything a card draws except the
 * down and the yard line, which as far as this box can tell only ESPN
 * publishes. So a college card sourced from here shows the field with no ball
 * on it rather than a wrong one, and the same goes for the club marks:
 * ncaa.com does not ship a logo address with the scoreboard, and the card
 * already prefers an abbreviation to a hole where a badge should be.
 */

/*
 * The club marks.
 *
 * Baseball's come with the scoreboard — one mlbstatic.com address per team id
 * — and the ones on this list do not: ncaa.com ships no logo address at all,
 * so the cards have been printing six-character codes where the badges go.
 *
 * The names and ESPN team ids in college-teams.json are the CSV out of
 * saiemgilani's gist, kept as ids rather than addresses because every one of
 * the 757 rows was the same address with a different number in it. The
 * addresses are ESPN's image CDN, which is not the host that refuses this box
 * — that is site.api.espn.com, an entirely different service — but if it
 * turns out to refuse us too, a card with 'MICH' on it is exactly what is
 * there now, so nothing is lost by trying.
 *
 * MATCHING is the whole difficulty, because the two lists do not agree on
 * what a school is called: ncaa.com writes 'Kennesaw St.' and 'Middle Tenn.'
 * where the gist has 'Kennesaw State' and 'Middle Tennessee', and their
 * six-character codes (KENSAW, MIDTEN) are nothing like the gist's
 * abbreviations (KENN, MTSU). So both sides are reduced to the same shape:
 * upper case, the punctuation gone, and the ST/STATE argument settled by
 * spelling it out on both sides. Every name a team is known by goes into the
 * index — school, and the three alternates the gist carries — and an
 * abbreviation only when it belongs to exactly one club, because 79 of them
 * do not.
 */
const COLLEGE_LOGO = 'https://a.espncdn.com/i/teamlogos/ncaa/500/{id}.png';

/* The words a scoreboard shortens, spelled back out.
 *
 * ncaa.com writes in newspaper style — 'South Ala.', 'Middle Tenn.', 'Miami
 * (Fla.)', 'N.C. State' — and the gist writes schools out, or nearly: its
 * alternates include 'Miami (FL)', 'North Carolina St.' and 'LA Tech'. The
 * two meet if both are expanded, and expanding BOTH is what makes this safe:
 * the same function runs over the index and over the lookup, so a rule that
 * is wrong is wrong symmetrically and simply fails to match rather than
 * matching the wrong club.
 *
 * 'LA' is deliberately absent. It is Louisiana in 'LA Tech' and a surname in
 * 'La Salle', and the gist already carries 'LA Tech' as an alternate, so
 * there is nothing to gain and a real school to get wrong. */
const SAID_SHORT = {
  ALA: 'ALABAMA', ARIZ: 'ARIZONA', ARK: 'ARKANSAS', CALIF: 'CALIFORNIA',
  COLO: 'COLORADO', CONN: 'CONNECTICUT', DEL: 'DELAWARE', FLA: 'FLORIDA',
  FL: 'FLORIDA', GA: 'GEORGIA', ILL: 'ILLINOIS', IND: 'INDIANA', KAN: 'KANSAS',
  KY: 'KENTUCKY', MD: 'MARYLAND', MASS: 'MASSACHUSETTS', MICH: 'MICHIGAN',
  MINN: 'MINNESOTA', MISS: 'MISSISSIPPI', MO: 'MISSOURI', MONT: 'MONTANA',
  NEB: 'NEBRASKA', NEV: 'NEVADA', OKLA: 'OKLAHOMA', ORE: 'OREGON',
  TENN: 'TENNESSEE', TEX: 'TEXAS', VA: 'VIRGINIA', VT: 'VERMONT',
  WASH: 'WASHINGTON', WIS: 'WISCONSIN', WYO: 'WYOMING',
  NC: 'NORTH CAROLINA', SC: 'SOUTH CAROLINA', ND: 'NORTH DAKOTA',
  SD: 'SOUTH DAKOTA', NM: 'NEW MEXICO', NJ: 'NEW JERSEY', NH: 'NEW HAMPSHIRE',
  WVA: 'WEST VIRGINIA',
  // 'St' and 'State' are the same word; which gets written depends only on
  // how much room the writer had. So are the compass points.
  ST: 'STATE', N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST',
  // And three the sport shortens rather than the country: 'App State',
  // 'Coastal Caro.', 'Cent. Michigan'.
  APP: 'APPALACHIAN', CARO: 'CAROLINA', CENT: 'CENTRAL',
};

/** One shape for a school's name, whoever wrote it. */
function schoolKey(name) {
  const flat = String(name || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    /* Dropped rather than turned into a space, so 'N.C. State' stays two
       words and not three — otherwise NC is never seen as a unit and North
       Carolina is out of reach for ever. The ʻokina belongs here for the
       same reason: Hawai'i is one word however it is typed. */
    .replace(/[.'’`ʻ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!flat) return '';
  const words = flat.split(' ');
  /* A single word is left exactly as it is, and this is the rule that keeps
     the whole thing honest. Expanding one turns an ABBREVIATION into a claim
     on somebody else's name: the gist carries 'ARK' as an alternate for
     Arkansas State, and spelled out that is Arkansas — a different club, a
     wrong badge, and a wrong badge is worse than none because it is a claim
     about which game you are looking at. Expansion earns its keep on names
     of two words or more, where the short word is a qualifier and the rest
     says which school. */
  if (words.length === 1) return words[0];
  /* Nothing is thrown away. Dropping 'College' as a filler word looked
     tidy and quietly merged Colorado College into Colorado, Cornell College
     into Cornell and Louisiana College into Louisiana — fifteen clubs, each
     one a wrong badge waiting to happen. Both sides go through this same
     function, so a word kept on both sides costs nothing. */
  return words.map((word) => SAID_SHORT[word] || word).join(' ');
}

const collegeMarks = (() => {
  const byName = new Map();
  const byAbbr = new Map();
  let table;
  try {
    // eslint-disable-next-line global-require
    table = require('./college-teams.json');
  } catch {
    // A box without the file is a box with the cards it had before.
    return { logo: () => '', size: 0 };
  }
  const address = (id) => (table.logo || COLLEGE_LOGO).replace('{id}', id);
  /* Every club's own name first, and the alternates only afterwards.
     Four names are claimed by two clubs each — 'Louisiana' is the school in
     Lafayette and also something Louisiana College is known as, and there is
     'Union' and 'Benedict' and 'Cumberland' — and a club's OWN name has the
     better claim to it than another club's nickname. Ordered rather than
     refused, because refusing both would cost Louisiana its badge to settle
     an argument with a school that does not play this sport. */
  for (const team of table.teams || []) {
    const key = schoolKey(team.name);
    if (key && !byName.has(key)) byName.set(key, address(team.id));
  }
  for (const team of table.teams || []) {
    const url = address(team.id);
    const abbr = String(team.abbr || '').toUpperCase().trim();
    for (const name of team.alt || []) {
      /* The gist repeats each club's abbreviation in its alternates. Those
         belong in the abbreviation index, which refuses the ambiguous ones,
         and not in the name index, which does not. */
      if (String(name).toUpperCase().trim() === abbr) continue;
      const key = schoolKey(name);
      if (key && !byName.has(key)) byName.set(key, url);
    }
    if (!abbr) continue;
    /* Ambiguous abbreviations are worse than none: a badge is a claim about
       which game this is, and 79 of these belong to more than one club. Set
       to null on the second sighting so the first cannot answer for both. */
    byAbbr.set(abbr, byAbbr.has(abbr) ? null : url);
  }
  return {
    size: byName.size,
    /** The mark for a club, from whatever the scoreboard called it. */
    logo(...names) {
      for (const name of names) {
        const key = schoolKey(name);
        if (key && byName.has(key)) return byName.get(key);
      }
      for (const name of names) {
        const abbr = String(name || '').toUpperCase().trim();
        if (abbr && byAbbr.get(abbr)) return byAbbr.get(abbr);
      }
      return '';
    },
  };
})();

/**
 * ncaa.com's state words, in the three the rest of this file speaks.
 *
 * Read loosely, and with the clock as a second opinion. Matching four exact
 * words and calling everything else 'upcoming' means one unfamiliar spelling
 * — 'in progress', 'I', 'Final/OT' — quietly files a game in the wrong third
 * of the grid, where LIVE NOW is the first thing on the page and the rest is
 * below the fold. A period and a running clock are a game in progress
 * whatever the state word says about it.
 */
function ncaaStatus(game) {
  const word = String(game.gameState || game || '').toLowerCase();
  if (/final|post|complete|cancel|postpon/.test(word)) return 'final';
  if (/live|progress|halftime|\bin\b/.test(word)) return 'live';

  const period = String(game.currentPeriod || '').trim();
  const clock = String(game.contestClock || '').trim();
  if (/final/i.test(period)) return 'final';
  /* A period that names a quarter, or a clock with time left on it. Either is
     a game that has started, whatever the state word was called. */
  if (/\d|half|ot|overtime/i.test(period) && !/^pre/i.test(period)) return 'live';
  if (clock && clock !== '0:00' && clock !== '00:00') return 'live';
  return 'upcoming';
}

/** One ncaa.com game as the Game shape `public/tv/js/scores.js` documents. */
/**
 * How far behind UTC the house zone is at a given instant.
 *
 * There is no way to build a Date from a wall-clock time in a named zone, so
 * it is done the other way round: format the guess IN that zone, read back
 * what it called itself, and the difference is the offset. One pass is exact
 * everywhere except the hour a clock change lands in, which is four in the
 * morning in March and not a kickoff.
 */
function zoneOffsetMs(atUtc) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HOUSE_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atUtc));
  const at = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(at.year), Number(at.month) - 1, Number(at.day),
    Number(at.hour) % 24, Number(at.minute), Number(at.second));
  return atUtc - asUtc;
}

/**
 * A kickoff, from the words a scoreboard prints rather than from a number.
 *
 * '08-29-2026' and '7:00PM ET' is what the NCAA's scoreboard gives, and for
 * a long time this code wanted `startTimeEpoch` instead — which the mirror
 * that actually answers does not send. Every game came out undated, and once
 * undated games were dropped from the band the whole slate went with them:
 * thirty-five kilobytes of Saturday read as nothing at all.
 *
 * The times are Eastern, which is both the zone the sport is scheduled in
 * and the one this house keeps, so no zone has to be parsed out of the
 * string — 'ET' is the only thing it ever says.
 */
function ncaaKickoff(game) {
  const stamped = (Number(game.startTimeEpoch) || 0) * 1000;
  if (stamped) return stamped;

  const date = String(game.startDate || '').trim();
  const time = String(game.startTime || '').trim();
  if (!date || !time) return 0;

  // '08-29-2026', and '2026-08-29' in case the mirror normalises it.
  const us = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(date);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
  if (!us && !iso) return 0;
  const [year, month, day] = us
    ? [Number(us[3]), Number(us[1]), Number(us[2])]
    : [Number(iso[1]), Number(iso[2]), Number(iso[3])];

  // '7:00PM ET', '7:00 PM ET', '12:00PM'. Noon is written out sometimes.
  let hour;
  let minute = 0;
  const clock = /(\d{1,2}):(\d{2})\s*([AP])\.?M\.?/i.exec(time);
  if (clock) {
    hour = Number(clock[1]) % 12;
    minute = Number(clock[2]);
    if (/^P$/i.test(clock[3])) hour += 12;
  } else if (/^noon$/i.test(time)) {
    hour = 12;
  } else {
    return 0;
  }

  /* Read as if the wall clock were UTC, then moved by however far the house
     zone is behind UTC at that moment. */
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return guess + zoneOffsetMs(guess);
}

function ncaaGame(row) {
  const game = row?.game || row || {};
  const state = ncaaStatus(game);
  /* A game whose kickoff has not been set says so in words, and may carry a
     placeholder instant — midnight — beside them. Taken at face value that
     is a card claiming a twelve o'clock kickoff, sorted to the front of the
     day because midnight is the earliest thing on it. No instant is the
     truth, and the band leaves those games off altogether. */
  const said = ncaaKickoff(game);
  const tba = !said || /\btb[ad]\b/i.test(String(game.startTime || ''));
  const kickoff = tba ? 0 : said;

  const side = (which) => {
    const team = game[which] || {};
    const names = team.names || {};
    return {
      abbr: names.char6 || names.short || '',
      /* Not shipped with this scoreboard, so it is looked up by name. Where
         the name is one nothing recognises the card prints the abbreviation,
         which is what that fallback has always been for. */
      logo: collegeMarks.logo(names.short, String(names.seo || '').replace(/-/g, ' '),
        names.full, names.char6),
      // '(4-1)' as ncaa.com writes it; the card wants '4-1'.
      record: String(team.description || '').replace(/[()]/g, '').trim(),
      score: team.score === undefined || team.score === null || team.score === ''
        ? null : Number(team.score),
      possession: false,
    };
  };

  let clock = '';
  if (state === 'live') {
    clock = [game.currentPeriod, game.contestClock].filter(Boolean).join(' · ');
  } else if (state === 'final') {
    clock = game.finalMessage || 'Final';
  } else if (kickoff) {
    /* A fallback only. The screen draws this from `kickoff` itself — see the
       note on startsAt() in desktop.js — because this box is one machine in
       one timezone and the screens are wherever somebody is sitting. */
    clock = new Date(kickoff).toLocaleTimeString('en-US',
      { timeZone: HOUSE_ZONE, hour: 'numeric', minute: '2-digit' });
  } else {
    clock = 'TBA';
  }

  let note = '';
  if (state === 'upcoming' && kickoff) {
    const mins = Math.round((kickoff - Date.now()) / 60000);
    if (mins > 0 && mins < 240) note = `Kicks off in ${mins} min`;
  }

  const named = (which, key) => String((game[which]?.names || {})[key] || '').trim();

  return {
    id: String(game.gameID || game.url || ''),
    sport: 'ncaaf',
    status: state,
    /* NOT the startTime string. ncaa.com writes it in Eastern — '7:00 PM ET'
       — and printing that under a start time the card has just drawn in the
       viewer's own zone is two different times on one card. */
    detailedState: state === 'final' ? (game.finalMessage || 'Final')
      : state === 'live' ? String(game.currentPeriod || '')
        : (tba ? 'Start time to be announced' : ''),
    channelMatch: game.network || '',
    channelName: game.network || '',
    /* The school as a broadcast says it — 'Michigan', 'Ohio State' — which is
       what a provider's own row for the game is likeliest to be named after. */
    teamMatch: [named('away', 'short'), named('home', 'short')].filter(Boolean),
    teamAlt: [],
    /* Six characters, which is what a cramped provider row uses. Short and
       therefore dangerous alone; the matcher reaches for them last. */
    teamShort: [named('away', 'char6'), named('home', 'char6')].filter(Boolean),
    redZone: false,
    away: side('away'),
    home: side('home'),
    clock,
    situation: '',
    // Only ESPN publishes the down and the spot. A field with no ball on it
    // is honest; a field with a guessed one is not.
    drive: null,
    kickoff,
    note,
    progress: null,
    placeholder: false,
  };
}

/** The games out of an ncaa.com scoreboard answer. */
function ncaaGames(body) {
  const rows = Array.isArray(body?.games) ? body.games : [];
  return rows.map(ncaaGame);
}

/*
 * TheSportsDB — a day's fixtures rather than a live scoreboard.
 *
 * Last on every list, and the only source here that also knows about the NFL.
 * It lags: the scores move on their own schedule rather than on the play, and
 * some rows never get a clock at all. But a card with the right two teams, a
 * start time and a network on it is a card, and the football band has had
 * nothing whatever.
 *
 * The one thing it gives that nobody else on these lists does is a badge per
 * club, which is what puts the marks back on the cards.
 */
function sportsdbStatus(row) {
  const word = String(row.strStatus || '').trim().toUpperCase();
  if (!word || word === 'NS' || word === 'NOT STARTED') {
    // Some rows carry no status at all and only the clock says it is on.
    return String(row.strProgress || '').trim() ? 'live' : 'upcoming';
  }
  if (['FT', 'AOT', 'FINAL', 'MATCH FINISHED', 'POST'].includes(word)) return 'final';
  if (word === 'PPD' || word === 'CANC') return 'upcoming';
  return 'live';
}

/*
 * A TheSportsDB time, as the instant it means.
 *
 * This publisher writes its times in UTC and says so nowhere in the string:
 * `strTimestamp` is '2026-08-29T17:00:00', and by the language's own rules a
 * date-time with no offset on it is LOCAL time. Parsed that way, a one
 * o'clock kickoff on the east coast came out as five — which is precisely
 * the four hours between the two, and precisely what the card was showing.
 *
 * The fallback built from `dateEvent` and `strTime` had the Z on it all
 * along, which is why this only ever went wrong on rows that carried a
 * timestamp — that is to say, on nearly all of them.
 */
function sportsdbInstant(text) {
  const said = String(text || '').trim();
  if (!said) return 0;
  // A string that names its own zone is left alone.
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(said)) return Date.parse(said) || 0;
  return Date.parse(`${said.replace(' ', 'T')}Z`) || 0;
}

function sportsdbGame(row, sport) {
  const state = sportsdbStatus(row);
  const kickoff = sportsdbInstant(row.strTimestamp)
    || sportsdbInstant(`${row.dateEvent || ''}T${row.strTime || '00:00:00'}`);

  const side = (team, score, badge) => ({
    /* No abbreviation is published, so the card gets the name it has. The
       mark usually loads, and where it does not the fallback prints this. */
    abbr: String(team || '').trim(),
    /* This publisher does ship a badge. Where one is missing on a college
       row the same table the NCAA scoreboard uses is asked — and it is asked
       for the name with the mascot taken off too, because this list writes
       'Michigan Wolverines' where that one writes 'Michigan'. */
    logo: String(badge || '') || (sport === 'ncaaf'
      ? collegeMarks.logo(team, String(team || '').split(' ').slice(0, -1).join(' '))
      : ''),
    record: '',
    score: score === undefined || score === null || score === '' ? null : Number(score),
    possession: false,
  });

  let clock = '';
  if (state === 'live') clock = String(row.strProgress || row.strStatus || '').trim();
  else if (state === 'final') clock = 'Final';
  else if (kickoff) {
    clock = new Date(kickoff).toLocaleTimeString('en-US',
      { timeZone: HOUSE_ZONE, hour: 'numeric', minute: '2-digit' });
  }

  let note = '';
  if (state === 'upcoming' && kickoff) {
    const mins = Math.round((kickoff - Date.now()) / 60000);
    if (mins > 0 && mins < 240) note = `Kicks off in ${mins} min`;
  }

  const away = String(row.strAwayTeam || '').trim();
  const home = String(row.strHomeTeam || '').trim();

  return {
    id: String(row.idEvent || ''),
    sport,
    status: state,
    /* 'NS' is this publisher's way of writing 'has not started', which is
       what a start time on a card already says. Printed underneath it, it is
       two characters of noise where the caption tells you something. */
    detailedState: /^(NS|NOT STARTED|)$/i.test(String(row.strStatus || '').trim())
      ? '' : String(row.strStatus || '').trim(),
    channelMatch: String(row.strTVStation || '').trim(),
    channelName: String(row.strTVStation || '').trim(),
    /* The club as this source names it — 'Michigan Wolverines', 'Green Bay
       Packers'. Longer than a provider row usually is, so the last word is
       offered behind it: 'Wolverines' and 'Packers' are what a row that
       carries a nickname would say. */
    teamMatch: [away, home].filter(Boolean),
    teamAlt: [away.split(' ').pop(), home.split(' ').pop()].filter(Boolean),
    teamShort: [],
    redZone: false,
    away: side(away, row.intAwayScore, row.strAwayTeamBadge),
    home: side(home, row.intHomeScore, row.strHomeTeamBadge),
    clock,
    situation: '',
    // Nobody but ESPN publishes the down and the spot, and a guessed ball on
    // the field is worse than no ball on it.
    drive: null,
    kickoff,
    note,
    progress: null,
    placeholder: false,
  };
}

/**
 * Whatever scoreboard this is, as games.
 *
 * The chain mixes publishers now, so the shape is worked out from the answer
 * rather than declared alongside the address. Which also means an address put
 * in by hand — an override, a probe — needs no second setting saying what
 * kind of thing lives there.
 */
/* What counts as today's slate, whichever day somebody filed it under.
 *
 * The lists now reach either side of the calendar day and, in one case, at a
 * league's next fifteen fixtures — which is what makes them robust about the
 * day boundary and what would otherwise put Thursday week on a band headed
 * LIVE NOW. Fourteen hours back covers a college Saturday from the noon
 * kickoffs to the finals of the late game; sixteen forward covers tonight
 * without reaching tomorrow afternoon. */
const SLATE_BACK_MS = 14 * 3600 * 1000;
const SLATE_AHEAD_MS = 16 * 3600 * 1000;

/** Is this game part of what is on today? */
function onTodaysSlate(game) {
  // A game being played is on now, whatever its kickoff says.
  if (game.status === 'live') return true;
  /* A game with no announced kickoff is not on today's slate, and keeping
   * one was a mistake that hid the day it was meant to protect.
   *
   * A scoreboard asked for a date it has nothing for does not answer nothing
   * — it rolls forward and hands back the next week's fixtures, and a week
   * out none of them has a time yet. So the three days asked either side all
   * came back with the SAME set of undated games, and a rule that kept
   * anything without a kickoff let every one of them through: ten cards of
   * next Saturday reading TBA, with the actual slate nowhere among them.
   *
   * A game nobody has scheduled is also not a game anybody can watch, which
   * is what this band is for. */
  if (!game.kickoff) return false;
  return game.kickoff > Date.now() - SLATE_BACK_MS
    && game.kickoff < Date.now() + SLATE_AHEAD_MS;
}

function footballGames(body, sport) {
  // ncaa.com: a list of { game: {...} }.
  if (Array.isArray(body?.games)) {
    return ncaaGames(body).filter((g) => g.id).filter(onTodaysSlate);
  }

  const events = espnEvents(body);
  if (!events.length) return [];
  // Both ESPN and TheSportsDB call the list `events`; only one of them puts a
  // competition inside each row.
  /* `competitions` and nothing looser. ESPN serves a second, lighter
     scoreboard whose events carry `competitors` at the top level and no
     competition at all — handed to nflGame() that reads as a game with an id
     and nothing else, which is a row of blank cards rather than an answer the
     list can walk past. */
  if (events[0] && events[0].competitions) {
    return events.map((e) => nflGame(e, sport)).filter((g) => g.id).filter(onTodaysSlate);
  }
  if (events[0] && (events[0].idEvent || events[0].strHomeTeam)) {
    /* An address asked by sport rather than by league answers with both
       American codes in one list, and a college band full of NFL fixtures is
       worse than an empty one. A row that does not say which league it is in
       is kept: the address was asked for this sport either way. */
    const belongs = sport === 'nfl' ? /\bNFL\b/i : /NCAA|COLLEGE/i;
    return events
      .filter((e) => !e.strLeague || belongs.test(String(e.strLeague)))
      .map((e) => sportsdbGame(e, sport))
      .filter((g) => g.id)
      .filter(onTodaysSlate);
  }
  return [];
}

/**
 * A football slate, from the first address that answers.
 *
 * The list mixes publishers now — ESPN refuses this box outright, on every
 * path and from both of its hosts, so it had to — and the shape each one
 * answers in is worked out by footballGames() rather than declared here.
 *
 * Falls through on failure only. What comes back carries `source` — which
 * address actually answered — and `tried`, the ones that did not and why,
 * because "the band is empty" has several causes and they are
 * indistinguishable from the sofa.
 */
/**
 * One entry on a chain, which may be several addresses fetched together.
 *
 * A group is for a source filed by something the box has to guess at — the
 * day a game is filed under, when the day boundary falls in the middle of the
 * games. Asking them in sequence would stop at the first that answered and
 * learn nothing; asked together and merged, the guess stops mattering.
 *
 * A group fails only if every address in it failed. One member refusing while
 * another answers is not a failure, it is a day with nothing on it.
 */
async function fetchGroup(entry, sport) {
  const urls = Array.isArray(entry) ? entry : [entry];
  const seen = new Map();
  const failures = [];
  for (const url of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const body = await fetchJson(url, SITE_HEADERS);
      const games = footballGames(body, sport);
      /* A two hundred that is really a complaint.
       *
       * TheSportsDB answers an address it does not like with a 200 and
       * `{"events":[],"Message":"Invalid League ID passed"}` — and something
       * that reads only the status code cannot tell that from a Tuesday.
       * Whatever the message is, an answer that says nothing and complains
       * is a failure, and the chain and the report should both hear it. */
      const complaint = String((body && body.Message) || '').trim();
      if (complaint && !games.length) throw new Error(complaint);
      // Same game from two days' files is one game.
      for (const game of games) {
        if (!seen.has(game.id)) seen.set(game.id, game);
      }
    } catch (err) {
      failures.push({ url, error: err.message });
    }
  }
  if (failures.length === urls.length) throw new Error(failures[0].error);
  /* The failures come back even when the group succeeded. One member refusing
     while another answers is not a failure of the group — but it is still a
     thing that happened, and a report that hides it is a report that cannot
     explain why the slate is thinner than it should be. */
  return { games: [...seen.values()], failures };
}

async function footballSlate(urls, sport, cache) {
  const tried = [];
  let answeredEmpty = '';
  for (const entry of urls) {
    const url = Array.isArray(entry) ? entry.join(' + ') : entry;
    try {
      // eslint-disable-next-line no-await-in-loop
      const got = await fetchGroup(entry, sport);
      const { games } = got;
      for (const failed of got.failures) tried.push(failed);
      if (games.length) {
        const now = Date.now();
        return { at: now, goodAt: now, games, error: '', source: url, tried };
      }
      /* An empty answer used to end the list, on the reasoning that a source
       * which answered has answered. That reasoning does not survive contact
       * with a scoreboard filed BY DAY: ask for the wrong day and the reply
       * is a perfectly polite empty list, indistinguishable from a Tuesday.
       * A game at eight in the evening Eastern is filed under tomorrow by
       * anybody keeping their dates in UTC, and the band said there was no
       * football on while two games were about to kick off.
       *
       * So an empty answer is now a reason to keep asking, and the list
       * carries the neighbouring day and a date-free address behind the
       * obvious ones. The whole list coming back empty IS the answer — and
       * costs a longer rest before anybody asks again, which is what stops
       * seven addresses being walked every thirty seconds all through an
       * out-of-season month. */
      tried.push({ url, error: 'no games' });
      answeredEmpty = answeredEmpty || url;
    } catch (err) {
      tried.push({ url, error: err.message });
    }
  }

  /* Everybody answered and nobody had a game. That is a quiet day, not a
     fault, and saying otherwise would put a red error under a band that is
     empty for the most ordinary reason there is. */
  const refused = tried.filter((t) => t.error !== 'no games');
  if (!refused.length) {
    return {
      at: Date.now(),
      goodAt: 0,
      games: [],
      error: '',
      quiet: tried.length,
      source: answeredEmpty,
      tried,
    };
  }
  /* Every address refused. Keep the last good slate for a few minutes rather
     than emptying the band over one bad poll — a Saturday afternoon is
     exactly when a feed is least willing to talk to a Raspberry Pi — but do
     not silently serve last Sunday either.

     `at` is when the box last ASKED and `goodAt` is when the games it is
     holding were true. They have to be two clocks. Written as one, a feed
     that keeps failing keeps `at` pinned at the last good answer, the
     back-off measures itself against a timestamp that never moves, and past
     the window every single poll walks the whole list again — which is the
     stampede the back-off exists to prevent. */
  const heldSince = cache.goodAt || 0;
  const holding = Boolean(cache.games.length) && Date.now() - heldSince < 10 * 60 * 1000;
  /* The distinct reasons, and how many addresses gave them. Two 403s and a
     truncated body reads as one confusing sentence without the count — and
     the count is what says "this was a list, and all of it failed" rather
     than "the feed is down", which are different problems. */
  const why = [...new Set(refused.map((t) => t.error))].join(' · ');
  return {
    at: Date.now(),
    goodAt: holding ? heldSince : 0,
    games: holding ? cache.games : [],
    error: tried.length > 1 ? `${why} (${tried.length} addresses tried)` : why,
    source: holding ? cache.source || '' : '',
    tried,
  };
}

/* How long to leave a feed alone after EVERY address on its list refused.
 *
 * A chain is only cheap while something on it answers. Five addresses asked
 * every thirty seconds is ten requests a minute at somebody else's server for
 * as long as a page is open, which is how a box gets itself blocked properly
 * rather than intermittently. A feed that is down is still down two minutes
 * later, and a slate is not worth a stampede. */
const FEED_FAIL_TTL_MS = 120000;
/* And how long after every address answered with nothing.
 *
 * Longer than a refusal, because a quiet day is a settled fact rather than a
 * fault that might clear: the NFL is out of season for five months and
 * walking seven addresses every two minutes through all of it is a way to
 * get this box refused by the people still willing to talk to it. Ten
 * minutes is well inside the notice anybody needs of a kickoff. */
const FEED_QUIET_TTL_MS = 600000;

/**
 * Is the last answer still good enough not to ask again?
 *
 * Three answers and three cadences: a slate with games in it moves on every
 * play and is worth the short one; a list that refused is worth retrying
 * before long; a day with nothing on it is worth leaving alone.
 */
function feedFresh(cache, ttl) {
  const age = Date.now() - cache.at;
  if (cache.games.length) {
    /* A fixtures list is not a scoreboard, and asking one every thirty
       seconds is both pointless and the way to get a free key throttled —
       which is not a quiet failure but a source that starts answering with
       nothing while the games are on. Asked at the rate its data actually
       moves. */
    const slow = /thesportsdb\.com/.test(String(cache.source || ''));
    return age < (slow ? Math.max(ttl, FEED_FAIL_TTL_MS) : ttl);
  }
  return age < (cache.error ? FEED_FAIL_TTL_MS : FEED_QUIET_TTL_MS);
}

/*
 * A walk already in progress is a thing to wait on, not to start again.
 *
 * Each sport walks its addresses ONE AT A TIME, falling through on a refusal
 * and on an empty answer alike, and every address is allowed twenty-five
 * seconds to time out — so a single ask can legitimately run for a minute or
 * more when an upstream is wedged. The cache is what stops that being paid
 * twice, but the cache is only written when a walk FINISHES. Nothing was
 * watching for one in progress.
 *
 * So every ask that arrived during those ninety seconds started its own walk.
 * A phone, a laptop and a television on the same slow minute meant three full
 * walks of every address: slower for all three, and three times the traffic
 * to somebody else's server, for one answer all of them wanted. Worse on a
 * bad minute than on a good one, which is the wrong way round.
 *
 * The first ask does the work and the rest hold its promise. Cleared in a
 * `finally` so a walk that throws cannot wedge the sport for ever — the next
 * ask starts a fresh one.
 */
const walking = new Map();

function oncePerWalk(key, run) {
  const held = walking.get(key);
  if (held) return held;
  const doing = (async () => run())().finally(() => walking.delete(key));
  walking.set(key, doing);
  return doing;
}

async function ncaafScores() {
  if (feedFresh(ncaafCache, NCAAF_TTL_MS)) return ncaafCache;
  ncaafCache = await oncePerWalk('ncaaf',
    () => footballSlate(ncaafUrls(), 'ncaaf', ncaafCache));
  return ncaafCache;
}

async function nflScores() {
  if (feedFresh(nflCache, NFL_TTL_MS)) return nflCache;
  nflCache = await oncePerWalk('nfl', () => footballSlate(nflUrls(), 'nfl', nflCache));
  return nflCache;
}

/**
 * Every address, asked, and what each one actually said.
 *
 * The ordinary chain stops at the first address that answers, which is right
 * for a scoreboard and useless for finding out why there is no scoreboard: it
 * reports what the ones BEFORE the winner said and nothing about the ones
 * after. Three rounds of this have now been spent guessing which address is
 * the broken one from a report that could not say.
 *
 * So this asks all of them, on purpose, and says for each: the status, how
 * many bytes came back, what the body starts with, and how many games this
 * box could read out of it. That last one is the question a status code
 * cannot answer — an address can answer 200 with perfectly good JSON in a
 * shape nothing here understands, and from the sofa that is indistinguishable
 * from a refusal.
 *
 * Never on the ordinary poll. It is a page somebody opens.
 */
async function probeFootball(sport, urls, find) {
  const rows = [];
  const wanted = String(find || '').trim().toUpperCase();
  for (const entry of urls) {
    for (const url of (Array.isArray(entry) ? entry : [entry])) {
    const began = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(url, { headers: SITE_HEADERS, timeout: 15000 });
      // eslint-disable-next-line no-await-in-loop
      const raw = (await readBody(res)).toString('utf8');
      const row = {
        url,
        status: res.statusCode || 0,
        bytes: raw.length,
        type: res.headers['content-type'] || '',
        ms: Date.now() - began,
        games: 0,
        /* The first of it, so a body that is an error page or a login wall
           says so in the report rather than only as a byte count. */
        head: raw.slice(0, 160).replace(/\s+/g, ' '),
      };
      try {
        const games = footballGames(JSON.parse(raw), sport);
        row.games = games.length;
        /* "Some games are being missed" is two entirely different problems wearing
           the same face: the address does not carry the game, or it carries
           it and this box drops it. Nothing visible from the sofa tells them
           apart, and the answer is in two lines — is the name anywhere in
           what came back, and did a game come out of the mapping with it. */
        if (wanted) {
          row.found = {
            inBody: raw.toUpperCase().includes(wanted),
            inGames: games.some((g) => [g.away?.abbr, g.home?.abbr,
              ...(g.teamMatch || []), ...(g.teamShort || [])]
              .some((n) => String(n || '').toUpperCase().includes(wanted))),
          };
        }
      } catch (err) {
        row.unreadable = err.message;
        if (wanted) row.found = { inBody: raw.toUpperCase().includes(wanted), inGames: false };
      }
      rows.push(row);
    } catch (err) {
      rows.push({ url, status: 0, error: err.message, ms: Date.now() - began });
    }
    }
  }
  return rows;
}

/*
 * The baseball slate, from the same scoreboard.
 *
 * Same shape, same reasons, different sport — and in this house the sport that
 * is actually on for six months of the year. Two things about baseball that
 * football does not have:
 *
 *   - There is no clock. The half-inning IS the clock, and ESPN already writes
 *     it the way a broadcast does ('Top 5th'), so that is taken rather than
 *     rebuilt out of a period number.
 *   - The provider carries a channel PER GAME on nights like this — 'MLB 01 |
 *     Rockies x Nationals' — which is a better match than the network
 *     carrying it. So both team names travel with the game and the television
 *     tries them first; see matchChannel in public/tv/js/scores.js.
 */
const MLB_URL = process.env.MLB_URL
  || 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
const MLB_TTL_MS = 30000;
let mlbCache = { at: 0, goodAt: 0, games: [], error: '', source: '' };

/** One ESPN baseball event as the Game shape the television documents. */
function mlbGame(event) {
  const comp = (event.competitions || [])[0] || {};
  const status = comp.status || event.status || {};
  const type = status.type || {};
  const state = nflStatus(type.state);
  const situation = comp.situation || {};

  const side = (which) => {
    const c = (comp.competitors || []).find((x) => x.homeAway === which) || null;
    if (!c) return null;
    return {
      abbr: c.team?.abbreviation || c.team?.shortDisplayName || '',
      record: (c.records || [])[0]?.summary || '',
      score: c.score === undefined || c.score === null || c.score === ''
        ? null : Number(c.score),
      /* The dot marks who is at bat, which is what possession means in a game
         with no ball to hold: the away side bats the top of the inning. */
      possession: state === 'live' && which === (topOfInning(type) ? 'away' : 'home'),
    };
  };

  const first = Date.parse(comp.date || event.date || '') || 0;
  let clock = '';
  if (state === 'live') {
    // 'Top 5th', 'Mid 5th', 'Bot 7th' — ESPN writes the half-inning the way a
    // broadcast says it, so there is nothing to improve on here.
    clock = type.shortDetail || type.detail
      || (Number(status.period) ? `Inning ${status.period}` : 'LIVE');
  } else if (state === 'final') {
    clock = type.shortDetail || 'Final';
  } else if (first) {
    clock = new Date(first).toLocaleTimeString('en-US',
      { timeZone: HOUSE_ZONE, hour: 'numeric', minute: '2-digit' });
  }

  let line = '';
  if (state === 'live') {
    /* Named the way a broadcast names them, which is up the diamond: first,
       second, third — 'runners on first and third', never 'third and first'. */
    const bases = [
      situation.onFirst ? '1st' : '',
      situation.onSecond ? '2nd' : '',
      situation.onThird ? '3rd' : '',
    ].filter(Boolean);
    const outs = Number.isFinite(Number(situation.outs))
      ? `${Number(situation.outs)} out` : '';
    const count = Number.isFinite(Number(situation.balls)) && Number.isFinite(Number(situation.strikes))
      ? `${Number(situation.balls)}-${Number(situation.strikes)}` : '';
    line = [outs, bases.length ? `${bases.join(' & ')}` : 'bases empty', count]
      .filter(Boolean).join(' · ');
  }

  const network = (comp.broadcasts || [])
    .flatMap((b) => b.names || [])
    .filter(Boolean)[0] || '';

  /* 'Rockies', 'Nationals' — what an event channel is named after. */
  const teamMatch = ['away', 'home']
    .map((which) => (comp.competitors || []).find((x) => x.homeAway === which))
    .map((c) => c?.team?.shortDisplayName || c?.team?.name || '')
    .filter(Boolean);

  let note = '';
  if (state === 'upcoming' && first) {
    const mins = Math.round((first - Date.now()) / 60000);
    if (mins > 0 && mins < 240) note = `First pitch in ${mins} min`;
  }

  return {
    id: String(event.id || comp.id || ''),
    sport: 'mlb',
    status: state,
    channelMatch: network,
    channelName: network || teamMatch.join(' at '),
    teamMatch,
    redZone: false,
    away: side('away'),
    home: side('home'),
    clock,
    situation: line,
    kickoff: first,
    note,
    progress: null,
    placeholder: false,
  };
}

/** Whether the away side is batting, read off however ESPN phrased it. */
function topOfInning(type) {
  const said = String(type.shortDetail || type.detail || '').toLowerCase();
  if (said.startsWith('top') || said.startsWith('mid')) return true;
  if (said.startsWith('bot') || said.startsWith('end')) return false;
  return true;
}

/*
 * Baseball comes from baseball, first.
 *
 * ESPN's scoreboard answered this box with 403 — not a mistake in the request
 * but their edge declining to serve something that is not a browser sitting on
 * espn.com, which is not a thing a Raspberry Pi in Montana can argue with. So
 * the first source asked is MLB's own: statsapi.mlb.com is the public API the
 * league publishes, wants no key, and has nothing between it and the caller.
 * ESPN stays as the second attempt, because a source that is refused today may
 * not be tomorrow and two of them agreeing costs nothing.
 *
 * `hydrate` is not optional here: the bare schedule carries the score and
 * little else, and the inning, the runners, the count and who is carrying the
 * broadcast all arrive only because they are asked for by name.
 */
const MLB_STATS_URL = process.env.MLB_STATS_URL
  || 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=team,linescore,broadcasts(all)';

/*
 * The same schedule, asked for the starting pitchers as well.
 *
 * A card for a game that has not started shows the two probables with their
 * record and ERA, which is the only thing there is to say about a game with no
 * score yet — and none of it is in the bare schedule. Nested hydration is how
 * statsapi is asked for a pitcher's season line in the same call rather than
 * two lookups per game, thirty times a day.
 *
 * Asked FIRST and not INSTEAD: a hydration string the API dislikes is a 400
 * for the whole schedule, which would take the scores down to add a detail to
 * them. So the plain URL above stays in the list behind it, and a day when
 * this form stops being accepted costs the pitcher lines and nothing else.
 */
const MLB_STATS_FULL_URL = process.env.MLB_STATS_FULL_URL
  /* A box told where the schedule lives means both forms of it. Reading only
     the plain override would leave this one still pointed at the league while
     everything else had been redirected — which is a test, or a mirror, quietly
     talking to two different servers. */
  || process.env.MLB_STATS_URL
  || 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=team,linescore,'
    + 'broadcasts(all),probablePitcher(stats(group=pitching,type=season))';

/* The league's own marks, which is where a logo for an MLB club should come
   from: one address per team id, served by the league, no scraping and nothing
   to keep up to date when a club changes its cap. Fetched through the box's
   image proxy so the living room is not making requests to mlbstatic.com. */
const mlbLogo = (id) => (id ? `https://www.mlbstatic.com/team-logos/${id}.svg` : '');

/** One statsapi.mlb.com game as the Game shape the television documents. */
function mlbStatsGame(game) {
  const line = game.linescore || {};
  const teams = game.teams || {};
  const abstract = String(game.status?.abstractGameState || '').toLowerCase();
  const state = abstract === 'live' ? 'live' : (abstract === 'final' ? 'final' : 'upcoming');
  /* 'Top', 'Middle', 'Bottom', 'End' — the away side bats until the middle. */
  const half = String(line.inningState || '').toLowerCase();
  const top = half.startsWith('top') || half.startsWith('mid');

  /* The starting pitcher and his season line, as the card prints it:
     "De La Rosa (2-2, 2.84)". Every part of it is optional — the probable is
     not named until the club says so, and a pitcher making his debut has no
     record to show — so each piece is carried separately and the card writes
     whatever arrived. */
  const probable = (t) => {
    const p = t && t.probablePitcher;
    if (!p || !p.fullName) return null;
    const line = (p.stats || [])
      .map((s) => s.splits && s.splits[0] && s.splits[0].stat)
      .find((stat) => stat && (stat.era !== undefined || stat.wins !== undefined)) || {};
    return {
      name: p.fullName,
      /* The surname is what a scoreboard has room for. */
      last: String(p.lastName || p.fullName).split(' ').slice(-1)[0] || p.fullName,
      wins: Number.isFinite(Number(line.wins)) ? Number(line.wins) : null,
      losses: Number.isFinite(Number(line.losses)) ? Number(line.losses) : null,
      era: line.era !== undefined && line.era !== null && line.era !== '-.--'
        ? String(line.era) : '',
    };
  };

  const side = (which) => {
    const t = teams[which];
    if (!t) return null;
    const record = t.leagueRecord;
    return {
      abbr: t.team?.abbreviation || t.team?.teamName || '',
      /* The club's own id, which is the address of its mark. */
      teamId: Number(t.team?.id) || null,
      logo: mlbLogo(t.team?.id),
      record: record && Number.isFinite(record.wins) ? `${record.wins}-${record.losses}` : '',
      score: Number.isFinite(t.score) ? Number(t.score) : null,
      possession: state === 'live' && which === (top ? 'away' : 'home'),
      pitcher: probable(t),
    };
  };

  const first = Date.parse(game.gameDate || '') || 0;
  let clock = '';
  if (state === 'live') {
    clock = [line.inningState, line.currentInningOrdinal].filter(Boolean).join(' ')
      || game.status?.detailedState || 'LIVE';
  } else if (state === 'final') {
    clock = 'Final';
  } else if (first) {
    clock = new Date(first).toLocaleTimeString('en-US',
      { timeZone: HOUSE_ZONE, hour: 'numeric', minute: '2-digit' });
  }

  let situation = '';
  if (state === 'live') {
    const offense = line.offense || {};
    const bases = [
      offense.first ? '1st' : '',
      offense.second ? '2nd' : '',
      offense.third ? '3rd' : '',
    ].filter(Boolean);
    const outs = Number.isFinite(line.outs) ? `${line.outs} out` : '';
    const count = Number.isFinite(line.balls) && Number.isFinite(line.strikes)
      ? `${line.balls}-${line.strikes}` : '';
    situation = [outs, bases.length ? bases.join(' & ') : 'bases empty', count]
      .filter(Boolean).join(' · ');
  }

  /* A national broadcast if there is one, because that is the channel this
     house is most likely to carry; otherwise whatever television is listed. */
  const casts = (game.broadcasts || []).filter((b) => /tv/i.test(b.type || 'TV'));
  const network = (casts.find((b) => b.isNational) || casts[0] || {}).name || '';

  const teamMatch = ['away', 'home']
    .map((which) => teams[which]?.team?.teamName || teams[which]?.team?.shortName || '')
    .filter(Boolean);

  let note = '';
  const detail = game.status?.detailedState || '';
  if (state === 'upcoming' && /postpon|delay|suspend/i.test(detail)) note = detail;
  else if (state === 'upcoming' && first) {
    const mins = Math.round((first - Date.now()) / 60000);
    if (mins > 0 && mins < 240) note = `First pitch in ${mins} min`;
  }

  /* The diamond and the count, as numbers rather than as the sentence the
     television used to print. A scoreboard draws these — three bases lit or
     unlit, and three rows of dots — and it cannot do that from "1 out · 1st &
     3rd · 2-1". The sentence stays too: the Shield still reads it. */
  const offense = line.offense || {};
  const onBase = {
    first: Boolean(offense.first),
    second: Boolean(offense.second),
    third: Boolean(offense.third),
  };
  const count = {
    balls: Number.isFinite(line.balls) ? line.balls : null,
    strikes: Number.isFinite(line.strikes) ? line.strikes : null,
    outs: Number.isFinite(line.outs) ? line.outs : null,
  };

  /* What the league itself calls this game's state — 'Warmup', 'Pre-Game',
     'Delayed: Rain', 'Postponed'. Warmup is the one worth drawing: it is the
     moment the broadcast comes on, which is the moment there is a point in
     tuning to the channel. */
  const detailState = String(game.status?.detailedState || '');

  return {
    id: String(game.gamePk || ''),
    sport: 'mlb',
    status: state,
    /* The league's own word for it, beside our three-state summary. */
    detailedState: detailState,
    warmup: /warmup/i.test(detailState),
    channelMatch: network,
    channelName: network || teamMatch.join(' at '),
    teamMatch,
    redZone: false,
    away: side('away'),
    home: side('home'),
    clock,
    inningState: String(line.inningState || ''),
    inning: line.currentInningOrdinal || '',
    onBase,
    count,
    situation,
    kickoff: first,
    note,
    progress: null,
    placeholder: false,
  };
}

async function fetchJson(url, headers) {
  const res = await request(url, { headers });
  if ((res.statusCode || 500) >= 400) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode}`);
  }
  return JSON.parse((await readBody(res)).toString('utf8'));
}

/*
 * Headers a browser would send. ESPN's edge is what refuses this box, and a
 * request that looks like the page's own is the only lever there is from
 * here — it costs nothing and it is the difference between 403 and 200 on
 * plenty of Akamai front ends.
 */
const SITE_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  referer: 'https://www.espn.com/',
  origin: 'https://www.espn.com',
};

async function mlbScores() {
  if (feedFresh(mlbCache, MLB_TTL_MS)) return mlbCache;
  // One walk, however many are asking — see oncePerWalk above.
  return oncePerWalk('mlb', walkMlb);
}

async function walkMlb() {
  const tried = [];
  const fromStats = async (url) => {
    const body = await fetchJson(url, { accept: 'application/json' });
    return (body.dates || [])
      .flatMap((d) => d.games || [])
      .map(mlbStatsGame)
      .filter((g) => g.id);
  };
  const sources = [
    /* With the pitchers, then without them. A hydration string the API stops
       accepting must cost the pitcher lines, not the scores — and when the two
       forms are the same address there is only one door to knock on. */
    ['statsapi.mlb.com', () => fromStats(MLB_STATS_FULL_URL)],
    ...(MLB_STATS_URL === MLB_STATS_FULL_URL ? []
      : [['statsapi.mlb.com (no pitchers)', () => fromStats(MLB_STATS_URL)]]),
    ['espn', async () => {
      const body = await fetchJson(MLB_URL, SITE_HEADERS);
      return (body.events || []).map(mlbGame).filter((g) => g.id);
    }],
  ];

  for (const [name, read] of sources) {
    try {
      const games = await read();
      if (games.length) {
        const now = Date.now();
        mlbCache = { at: now, goodAt: now, games, error: '', source: name };
        return mlbCache;
      }
      /* An empty answer is an answer — an off day — but keep asking the next
         source before believing it, since a refusal can also look empty. */
      tried.push(`${name}: no games`);
    } catch (err) {
      tried.push(`${name}: ${err.message}`);
    }
  }

  /* Nobody had any. That is either a quiet day, which is not an error, or
     every source refused, which is — and the attempts say which. */
  const refused = tried.some((line) => !line.endsWith('no games'));
  /* Two clocks, for the reason footballSlate() spells out: written as one,
     a feed that keeps failing pins `at` at the last good answer and every
     poll thereafter walks the whole list again. */
  const heldSince = mlbCache.goodAt || 0;
  const holding = refused && Boolean(mlbCache.games.length)
    && Date.now() - heldSince < 10 * 60 * 1000;
  mlbCache = {
    at: Date.now(),
    goodAt: holding ? heldSince : 0,
    games: holding ? mlbCache.games : [],
    error: refused ? tried.join(' · ') : '',
    source: holding ? mlbCache.source : '',
  };
  return mlbCache;
}

/** Where the open guides live, and where to go looking for the current names. */
const GUIDE_CATALOGUE_HOME = 'https://epgshare01.online/epgshare01/';

/**
 * Refuse to fetch anything on this network, and say why.
 *
 * Both the probe and the directory listing make the box fetch an address of
 * your choosing and hand you back what came back, which is otherwise a fine
 * way to read a printer's admin page or a neighbouring service that was never
 * meant to be reachable from a browser. The portal is unauthenticated by
 * design, so the guard is on the address rather than on who is asking.
 *
 * Node's URL parser already folds `http://2130706433/` and `http://127.1/`
 * into `127.0.0.1`. What it leaves for us: a trailing dot on localhost, and
 * IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`, which it spells `::ffff:7f00:1`).
 */
function mappedIpv4(host) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return '';
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function privateAddress(target) {
  let host;
  try {
    host = new URL(target).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return 'That is not a web address.';
  }
  host = host.replace(/\.+$/, '');
  const mapped = mappedIpv4(host);
  if (mapped) host = mapped;
  const isPrivate = host === 'localhost'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === '::1'
    || host === '0.0.0.0'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    // The tailnet this box lives on counts as inside.
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host)
    || /^fe80:/i.test(host);
  return isPrivate ? 'Only addresses out on the internet can be tested.' : '';
}

/**
 * Whether /stream or /img may fetch this URL.
 *
 * Public internet is allowed — HLS segments live on CDNs whose host is not
 * the panel's. Private addresses are allowed only when they are the
 * configured provider or playlist origin, so a local Xtream panel still
 * plays and a LAN M3U of cameras on the playlist host still plays, while
 * `http://169.254.169.254/` and the router at `192.168.1.1` do not.
 */
function originKey(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${host}:${port}`;
}

function configuredOrigins(cfg) {
  const out = new Set();
  const add = (raw) => {
    if (!raw) return;
    try {
      out.add(originKey(normalizeHost(String(raw))));
    } catch {
      /* ignore */
    }
  };
  if (!cfg) return out;
  add(cfg.host);
  add(cfg.playlistUrl);
  for (const account of providers.accounts(cfg)) add(account.host);
  return out;
}

function proxyAllowed(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return 'That is not a web address.';
  }
  if (!/^https?:$/.test(u.protocol)) return 'Only http and https URLs can be fetched.';
  const privateErr = privateAddress(target);
  if (!privateErr) return '';
  try {
    if (configuredOrigins(readConfig()).has(originKey(u))) return '';
  } catch {
    /* ignore */
  }
  return privateErr;
}

/**
 * A listing read out of the channel's own name.
 *
 * Event channels are sold with the fixture written into the name:
 *
 *   MLB 01 | Rockies x Nationals start:2026-08-27 18:05:00 stop:2026-08-28 01:18:20
 *
 * No guide on earth carries these — they exist for one night and are renamed
 * for the next — but the provider has already said exactly what is on and
 * when, so there is nothing to look up. The times are read as UTC, which is
 * what this provider publishes; if a fixture shows an hour out, that is the
 * assumption to revisit.
 */
const EVENT_TIMES = /start:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})[\s\S]*?stop:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i;

function listingFromName(name) {
  const raw = String(name || '');
  const m = EVENT_TIMES.exec(raw);
  if (!m) return null;
  const start = Math.floor(Date.parse(`${m[1]}T${m[2]}Z`) / 1000);
  const stop = Math.floor(Date.parse(`${m[3]}T${m[4]}Z`) / 1000);
  if (!start || !stop || stop <= start) return null;
  // Everything before "start:" is the fixture, minus the separator it was
  // hanging off.
  const title = raw.slice(0, m.index).replace(/[|\-–—:\s]+$/, '').trim();
  return title ? [{ title, start, stop }] : null;
}

/** The provider's whole guide in one request, rather than one call a channel. */
function providerGuideUrl(cfg) {
  if (!cfg || cfg.mode !== 'xtream' || !cfg.host) return null;
  const u = new URL(normalizeHost(cfg.host) + '/xmltv.php');
  u.searchParams.set('username', cfg.username);
  u.searchParams.set('password', cfg.password);
  return u.toString();
}

/**
 * Assemble the source list for one refresh.
 *
 * The provider's own feed goes FIRST, so where it has listings they win: they
 * are the ones actually describing the stream you will be watching, and an
 * open guide's idea of what is on "ESPN" is a good guess rather than a fact.
 * The open guides then fill the enormous hole underneath.
 *
 * It is also the only source that costs anything. It comes off the one
 * connection, so it is skipped while somebody is watching — the open guides
 * are ordinary downloads and never wait for anyone.
 */
function guideRefreshSources(cfg, { includeProvider = true } = {}) {
  const list = [];
  if (includeProvider && cfg?.useProviderGuide !== false && !providerBusy()) {
    const url = providerGuideUrl(cfg);
    if (url) list.push({ url, label: "the provider's own guide", secret: true });
  }
  for (const url of guideSources(cfg)) list.push({ url, label: redactUrl(url) });
  return list;
}

let guideRefreshing = null;

function refreshGuide({ force = false } = {}) {
  if (guideRefreshing) return guideRefreshing;
  const cfg = readConfig();
  const channels = knownLiveChannels();
  /* Nothing to match against yet.
   *
   * The channel list comes out of the library cache, and on a box that has
   * not shown Live TV since it started there is not one. Waiting is right —
   * pulling the catalogue to build a guide would be the tail wagging the dog
   * — but it must be SAID, because the alternative is a viewer pressing Save
   * and fetch and watching nothing happen at all. */
  if (!channels.length) {
    return Promise.resolve({ ...guide.status(), blocked: 'no-channels' });
  }
  guide.setSources(guideSources(cfg));
  /* Only guides for the country you actually watch. Default US; '' accepts
     every country, for anyone whose library is not one nation's. */
  guide.setCountry(cfg?.guideCountry === undefined ? 'us' : cfg.guideCountry);
  guide.setChannels(channels);
  const sources = guideRefreshSources(cfg);
  if (!sources.length) return Promise.resolve(guide.status());
  guideRefreshing = guide.refresh({ force, sources })
    .catch((err) => {
      console.log(`  Guide: refresh failed — ${err.message}`);
      return guide.status();
    })
    .finally(() => {
      guideRefreshing = null;
    });
  return guideRefreshing;
}

/**
 * Build (or rebuild) one cache entry, deduplicating concurrent callers — two
 * devices opening Movies at once should cost one provider pull, not two.
 */
const libraryInFlight = new Map();

function rebuildLibrary(cfg, tab, pattern, cacheKey) {
  const running = libraryInFlight.get(cacheKey);
  if (running) return running;

  const job = buildLibrary(cfg, tab, pattern)
    .then((payload) => {
      /* An empty library is never cached, and never allowed to replace one
       * that is not.
       *
       * A provider that answers 200 with nothing — busy, rate-limiting, or
       * simply between updates — used to be written down as the truth and
       * then served for the whole cache lifetime, so one bad minute became
       * an evening of "The library came back empty". Handing back the last
       * good copy is right in every case: if the library really is empty
       * there is nothing to lose by showing yesterday's, and if it is not,
       * this is the difference between a blink and a broken box. */
      if (!(payload.items || []).length) {
        const held = libraryCache.get(cacheKey);
        if (held && (held.payload.items || []).length) return held.payload;
        return payload;
      }
      libraryCache.set(cacheKey, { at: Date.now(), payload });
      persistLibraryCache();
      return payload;
    })
    .finally(() => libraryInFlight.delete(cacheKey));

  // Background refreshes have no awaiter; don't let a failure crash the process.
  job.catch(() => {});
  libraryInFlight.set(cacheKey, job);
  return job;
}

/** The movies the box has already listed, without asking the provider again. */
function cachedMovies() {
  for (const [key, entry] of libraryCache) {
    if (!key.startsWith(`v${LIBRARY_SHAPE}:movies:`)) continue;
    const items = (entry.payload && entry.payload.items) || [];
    if (items.length) return items;
  }
  return [];
}

/**
 * The credits crawl: one film's details every few seconds, and only when the
 * provider is doing nothing else.
 *
 * The gate is the box's own single-connection rule — the same one that pauses
 * a download the moment somebody presses play. A metadata call is small, but
 * it is a call on the one connection, and nobody watching anything should
 * ever be queued behind the index being built.
 */
const CREDIT_CRAWL_MS = 4000;

function crawlCredits() {
  const cfg = readConfig();
  if (!cfg || cfg.mode !== 'xtream') return Promise.resolve(null);
  return people.crawl({
    items: cachedMovies(),
    busy: () => providerBusy() || Boolean(activeJob && activeJob.status === 'downloading'),
    fetchInfo: async (id) => {
      const url = xtreamApiUrl(providers.forMeta(cfg) || cfg, { action: 'get_vod_info', vod_id: id });
      const upstream = await request(url, { timeout: 15000 });
      if ((upstream.statusCode || 500) >= 400) {
        upstream.resume();
        throw new Error(`HTTP ${upstream.statusCode}`);
      }
      const body = JSON.parse((await readBody(upstream)).toString('utf8'));
      return body && body.info ? body.info : {};
    },
  });
}

let cacheWriteTimer = null;
function persistLibraryCache() {
  clearTimeout(cacheWriteTimer);
  cacheWriteTimer = setTimeout(() => {
    // Async write: this file runs to ~7MB, and a sync write of that size is a
    // visible stall on a Pi while streams are flowing.
    fs.writeFile(LIBRARY_CACHE_PATH, JSON.stringify(Object.fromEntries(libraryCache)), () => {});
  }, 500);
  cacheWriteTimer.unref?.();
}

/**
 * Provider tags that get bolted onto the FRONT of a title.
 *
 * This provider names things like a man typing with his elbows: "4K-MAX-
 * Trading Places", "EN - The Batman", "MAX - Succession". None of it is the
 * title, all of it sorts and searches as though it were, and a grid of it
 * reads as a list of the word MAX.
 *
 * A list rather than a shape, deliberately. "Strip any short capitalised run
 * before a dash" would also eat "IT - Chapter Two" and "US - Us", which are
 * films. Everything here is a language, a country, a quality or a studio, and
 * nothing here is a film. Anything FOLLOWING the title — the year, a country
 * in brackets — is left exactly as it is; that part is information.
 */
const TITLE_TAGS = new Set([
  // quality and packaging
  '4K', 'UHD', 'HD', 'FHD', 'SD', 'HQ', 'HEVC', 'H265', 'H264', 'X265', 'X264',
  '1080P', '720P', '2160P', 'MULTI', 'MULTISUB', 'SUB', 'DUB', 'VIP', 'PPV',
  '3D', 'IMAX', 'REMUX', 'BLURAY', 'WEB', 'WEBDL',
  // languages and countries — IT is left out on purpose, it is a film
  'EN', 'ENG', 'US', 'USA', 'UK', 'GB', 'CA', 'AU', 'NZ', 'IE',
  'FR', 'FRA', 'ES', 'ESP', 'SPA', 'DE', 'GER', 'DEU', 'NL', 'PT', 'BR', 'POR',
  'AR', 'ARA', 'TR', 'TUR', 'RU', 'RUS', 'PL', 'POL', 'SE', 'SWE', 'NO', 'DK',
  'FI', 'GR', 'RO', 'HU', 'CZ', 'IN', 'HI', 'PK', 'MX', 'LAT', 'LATINO',
  'AFR', 'ASIA', 'EU', 'EX-YU', 'EXYU', 'SCAND', 'BALKAN', 'SC', 'NOR', 'DAN',
  'ICE', 'DUT', 'NLD', 'BE', 'CH', 'AT', 'ZA', 'JP', 'JPN', 'KR', 'KOR',
  'CN', 'CHN', 'TH', 'VN', 'ID', 'MY', 'PH', 'IL', 'IR', 'EG', 'MA', 'SA',
  'AE', 'BG', 'HR', 'RS', 'SI', 'SK', 'UA', 'LT', 'LV', 'EE',
  // studios and services
  'MAX', 'HBO', 'NF', 'NETFLIX', 'AMZN', 'AMAZON', 'PRIME', 'DSNY', 'DISNEY',
  'DSNP', 'APPLE', 'ATVP', 'ATV', 'PMNT', 'PARAMOUNT', 'PMTP', 'PEACOCK',
  'PCOK', 'HULU', 'STARZ', 'SHO', 'SHOWTIME', 'CRAV', 'BRITBOX', 'MGM', 'AMC',
  'DISCOVERY', 'CINEMAX', 'LIONSGATE', 'A24',
]);

/**
 * The one prefix worth keeping.
 *
 * Everything else in front of a title is filing — a language, a country, a
 * quality, a studio — and belongs on the switcher rather than in the name.
 * This one is not filing, it is a warning, and a household box that quietly
 * removed it would be doing nobody a favour.
 */
const KEPT_TAGS = new Set(['XXX']);

/**
 * Does this look like a filing code rather than a word of the title?
 *
 * Short, and written the way codes are written: capitals, digits, and the
 * plus signs the streaming services have taken to. "A+", "AMZ", "D+", "NL",
 * "4K", "MAX" all qualify; "Mission", "Bytta", "Frost" do not, because they
 * are not shouted.
 *
 * This is looser than the list it backs up, deliberately — the list could
 * only ever remove prefixes somebody had already thought of, and new ones
 * arrive with every provider reshuffle. The cost is that a title genuinely
 * called "IT - Chapter Two" loses its "IT", which is the trade that was
 * asked for: all of them gone.
 */
const looksLikeTag = (token) => token.length <= 5 && /^[A-Z0-9][A-Z0-9+&]*$/.test(token);

/** Marks a title as 4K wherever the provider chose to say so. */
const UHD_TAG = /(^|[^A-Z0-9])(4K|UHD|2160P)([^A-Z0-9]|$)/i;

/**
 * The title with the provider's prefixes taken off the front.
 *
 * Repeated, because they stack: "4K-MAX- Trading Places" is two of them. It
 * only ever removes from the FRONT, only whole tags from the list above, and
 * it gives up and hands back the original rather than return an empty string
 * — a title made entirely of tags is more likely a channel than a mistake.
 */
function cleanTitle(raw) {
  return splitTitle(raw).name;
}

/**
 * The title, and the tags that were sitting in front of it.
 *
 * The tags are not rubbish once removed — they are the only thing telling
 * three otherwise identical rows apart, and they become the labels on a
 * grouped card's switcher. "4K-MAX- Trading Places" is the 4K one; the
 * NL one beside it is the Dutch one; without the prefix they are three
 * indistinguishable copies of the same film.
 */
function splitTitle(raw) {
  const original = String(raw || '').trim();
  let name = original;
  const tags = [];
  for (let i = 0; i < 6; i += 1) {
    const m = /^([A-Za-z0-9+&]{1,12})\s*[-|:\u2013\u2022]\s*/.exec(name);
    if (!m) break;
    const token = m[1].toUpperCase();
    if (KEPT_TAGS.has(token)) break;
    if (!TITLE_TAGS.has(token) && !looksLikeTag(m[1])) break;
    tags.push(token);
    name = name.slice(m[0].length).trimStart();
  }
  const trimmed = name.trim();
  // A name made only of tags keeps its name and loses its tags: it is more
  // likely a channel than a mistake, and stripping it to nothing helps
  // nobody.
  if (!trimmed) return { name: original, tags: [] };
  return { name: trimmed, tags };
}

/**
 * Adult, by the tag the provider puts in front of it.
 *
 * Kept as a flag rather than left for the browser to infer from the name,
 * because the browser then has to keep inferring it — in the grid, in the
 * shelves, in every search — and one place that forgets is one place it
 * shows up.
 */
const isAdult = (raw) => /(^|[^a-z0-9])xxx([^a-z0-9]|$)/i.test(String(raw || ''));

/** Is this title 4K, by anything the provider said anywhere in the name? */
const isUhd = (raw) => UHD_TAG.test(String(raw || ''));

function projectItem(row, kind) {
  const split = splitTitle(row.name);
  if (kind === 'live') {
    return {
      kind,
      id: row.stream_id,
      name: split.name,
      tag: split.tags.join(' '),
      logo: row.stream_icon || '',
      categoryId: String(row.category_id ?? ''),
      epgId: row.epg_channel_id || '',
      // The channel number the provider files it under. The guide shows it
      // beside the name, the way a guide has since teletext.
      num: Number(row.num) || 0,
      uhd: isUhd(row.name),
      adult: isAdult(row.name),
    };
  }
  if (kind === 'movie') {
    return {
      kind,
      id: row.stream_id,
      name: split.name,
      tag: split.tags.join(' '),
      logo: row.stream_icon || '',
      categoryId: String(row.category_id ?? ''),
      uhd: isUhd(row.name),
      adult: isAdult(row.name),
      ext: row.container_extension || 'mp4',
      rating: row.rating || '',
      // Upload time, used to sort the New Releases row newest-first.
      added: Number(row.added) || 0,
    };
  }
  return {
    kind,
    id: row.series_id,
    name: split.name,
    tag: split.tags.join(' '),
    logo: row.cover || '',
    categoryId: String(row.category_id ?? ''),
    uhd: isUhd(row.name),
    adult: isAdult(row.name),
    rating: row.rating || '',
    // Feed the genre shelves — provider categories carry no genre split.
    genre: row.genre || '',
    added: Number(row.last_modified) || 0,
  };
}

async function fetchXtreamJson(cfg, action) {
  const upstream = await request(xtreamApiUrl(providers.forMeta(cfg) || cfg, { action }), { timeout: 120000 });
  const body = (await readBody(upstream)).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Provider returned malformed JSON for ${action}`);
  }
}

async function buildLibrary(cfg, tab, pattern) {
  const [catAction, listAction, kind] = LIBRARY_ACTIONS[tab];

  let match = () => true;
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'i');
      match = (name) => re.test(name || '');
    } catch {
      // A bad pattern shouldn't blank the library — show everything instead.
      match = () => true;
    }
  }

  const [rawCats, rawItems] = await Promise.all([
    fetchXtreamJson(cfg, catAction),
    fetchXtreamJson(cfg, listAction),
  ]);

  const cats = Array.isArray(rawCats) ? rawCats : [];
  const items = Array.isArray(rawItems) ? rawItems : [];

  const keptCats = cats.filter((c) => match(c.category_name));
  const allowed = new Set(keptCats.map((c) => String(c.category_id)));

  return {
    categories: keptCats.map((c) => ({ id: String(c.category_id), name: c.category_name })),
    items: items
      .filter((row) => allowed.has(String(row.category_id ?? '')))
      .map((row) => projectItem(row, kind)),
    totals: { categories: cats.length, items: items.length },
  };
}

/* -------------------------------------------------------------- API routes */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Explicit length so the browser can report real download progress instead
    // of an indeterminate spinner. Without it Node falls back to chunked.
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** Xtream base64-encodes EPG titles and descriptions. */
function decodeEpg(listing) {
  const dec = (s) => {
    try {
      return Buffer.from(String(s || ''), 'base64').toString('utf8');
    } catch {
      return String(s || '');
    }
  };
  return {
    ...listing,
    title: dec(listing.title),
    description: dec(listing.description),
  };
}

async function handleApi(req, res, pathname, query) {
  const cfg = readConfig();
  const mode = cfg && cfg.mode;

  if (pathname === '/api/config') {
    if (req.method === 'GET') return json(res, 200, publicConfig(cfg));

    if (req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }

      const next = {
        mode: incoming.mode === 'm3u' ? 'm3u' : 'xtream',
        preferredFormat: incoming.preferredFormat === 'ts' ? 'ts' : 'm3u8',
      };

      // Guide settings belong to the box, not to a mode — an Xtream account
      // needs outside listings at least as badly as an M3U one does. Carried
      // over from the stored config so connecting a provider never silently
      // drops feeds that were already set up.
      const held = readConfig();
      next.epgUrls = guideSources(held);
      next.useProviderGuide = held?.useProviderGuide !== false;
      /* Carried over for the same reason the guide feeds are: this object is
         built from scratch on every save, so anything not named here is
         quietly dropped — and connecting a provider must not throw away a
         recommendation key somebody pasted a month ago. */
      if (held?.tmdbKey) next.tmdbKey = held.tmdbKey;

      if (next.mode === 'xtream') {
        if (!incoming.host || !incoming.username || !incoming.password) {
          return json(res, 400, { error: 'Host, username and password are required.' });
        }
        next.host = normalizeHost(incoming.host);
        next.username = String(incoming.username).trim();
        next.password = String(incoming.password);
        /* The first login is also the first entry in the pool. The three loose
           fields stay beside it: everything that reads a config still finds
           what it always found, and a box that rolls back to an older build
           keeps working. */
        next.accounts = [{
          id: 'p1', host: next.host, username: next.username, password: next.password, label: '',
        }];

        // Verify before saving — better to fail here than on the first click.
        try {
          const probe = await request(xtreamApiUrl(next, {}));
          const body = (await readBody(probe)).toString('utf8');
          const info = JSON.parse(body);
          if (!info.user_info || info.user_info.auth === 0) {
            return json(res, 401, { error: 'Provider rejected those credentials.' });
          }
          writeConfig(next);
          providers.note('p1', info.user_info);
          return json(res, 200, { ...publicConfig(next), userInfo: info.user_info });
        } catch (err) {
          return json(res, 502, {
            error: `Could not reach the provider: ${err.message}`,
          });
        }
      }

      if (!incoming.playlistUrl) {
        return json(res, 400, { error: 'A playlist URL is required.' });
      }
      next.playlistUrl = String(incoming.playlistUrl).trim();
      next.epgUrl = String(incoming.epgUrl || '').trim();
      try {
        const probe = await request(next.playlistUrl);
        if ((probe.statusCode || 500) >= 400) {
          probe.resume();
          return json(res, 502, { error: `Playlist returned HTTP ${probe.statusCode}.` });
        }
        probe.resume();
      } catch (err) {
        return json(res, 502, { error: `Could not fetch the playlist: ${err.message}` });
      }
      writeConfig(next);
      return json(res, 200, publicConfig(next));
    }

    if (req.method === 'DELETE') {
      try {
        fs.unlinkSync(CONFIG_PATH);
      } catch {
        /* already gone */
      }
      return json(res, 200, { configured: false });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- Recordings ----
   *
   * A promise the box made in advance. The list is everything it has been
   * asked to keep, whatever state it reached; scheduling takes a listing's
   * own start and stop, because that is what the viewer pressed record on.
   */
  if (pathname === '/api/recordings') {
    if (req.method === 'GET') {
      /* The size of a recording in progress read from the file itself rather
         than from the last scheduler pass. The scheduler runs every twenty
         seconds, which is the right cadence for deciding things and the wrong
         one for a number somebody is watching climb. */
      const live = new Set(recordings.active().map((r) => r.id));
      const items = recordings.all().map((row) => (live.has(row.id)
        ? { ...row, bytes: recordings.fileSize(path.join(RECORDINGS_DIR, row.file)) }
        : row));
      return json(res, 200, {
        items,
        active: [...live],
        free: providers.free(cfg),
        capacity: providers.capacity(cfg),
        /* So the screen can say how much room is left for more of them, in
           the same terms the downloads page uses. */
        freeBytes: Number.isFinite(diskFree(RECORDINGS_DIR)) ? diskFree(RECORDINGS_DIR) : null,
      });
    }

    if (req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const row = recordings.schedule({
        channelId: incoming.channelId,
        channelName: incoming.channelName,
        title: incoming.title,
        subtitle: incoming.subtitle,
        description: incoming.description,
        startsAt: Number(incoming.startsAt),
        endsAt: Number(incoming.endsAt),
        profileId: incoming.profileId,
      });
      if (!row) {
        return json(res, 400, { error: 'A channel and a start and end time are required.' });
      }
      /* Already in progress by the time somebody pressed record — a
         programme half over is still worth the rest of it. */
      recordings.tick(Date.now(), { begin: beginRecording });
      return json(res, 200, { recording: recordings.get(row.id) });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  const recMatch = /^\/api\/recordings\/([\w-]+)(\/file|\/save)?$/.exec(pathname);
  if (recMatch) {
    const id = recMatch[1];
    const row = recordings.get(id);
    if (!row) return json(res, 404, { error: 'No such recording' });

    /* Watching one, or saving it to a phone. A recording still in progress is
       playable — it is a fragmented mp4 written so that what exists on disk
       plays — which is what makes "start watching the game from the beginning
       while it is still on" work at all. */
    if (recMatch[2]) {
      if (!row.file || !recordings.fileSize(path.join(RECORDINGS_DIR, row.file))) {
        return json(res, 409, { error: 'Nothing has been recorded yet' });
      }
      localPlaybackAt = Date.now();
      return serveLocalFile(req, res, path.join(RECORDINGS_DIR, row.file), {
        attachmentName: recMatch[2] === '/save' ? `${row.title}.mp4` : null,
      });
    }

    /* Stopping and deleting are different things and the difference matters:
       a viewer taking the connection back mid-programme keeps the half that
       was written. Only DELETE throws the file away. */
    if (req.method === 'POST') {
      recordings.cancel(id, { reason: 'Stopped to free the connection.' });
      return json(res, 200, { recording: recordings.get(id) });
    }
    if (req.method === 'DELETE') {
      recordings.remove(id);
      return json(res, 200, { removed: true });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- The logins, and what the provider says about each ----
   *
   * The panel behind "Manage providers". Everything here is the provider's own
   * answer about an account — when it expires, how many connections it allows,
   * how many it thinks are open — beside the box's own count of what it is
   * using. Passwords never leave the box: they are what this file is 0600 for.
   */
  /*
   * Films like this one, for the page about it.
   *
   * The same reckoning the For You row uses, pointed at one film instead of
   * at a profile — what an audience reached for next, then the people who
   * made it, then the shelf. The shelf last rather than not at all, so a film
   * nobody has indexed still has a row under it.
   */
  if (pathname === '/api/similar') {
    const id = String(query.get('id') || '').trim();
    if (!id) return json(res, 400, { error: 'Which film?' });
    const movies = knownMovies();
    const film = movies.find((m) => String(m.id) === id)
      /* A film opened straight from a link may not be in any page the box has
         cached, and the name is the only thing the co-taste layer needs. */
      || { id, name: String(query.get('name') || ''), categoryId: '' };
    const answer = await recommend.similarTo({
      film,
      movies: movies.filter((m) => !m.adult),
      people,
      cache: similarCache,
      fetchJson: (url, headers) => fetchJson(url, { ...SITE_HEADERS, ...(headers || {}) }),
      log: (line) => console.log(line),
      tmdbKey: String(cfg?.tmdbKey || '').trim(),
    });
    return json(res, 200, answer);
  }

  /*
   * The key for the one recommendation service properly built for the
   * question.
   *
   * Written, never read back. It goes in config.json beside the provider
   * password — the file this box keeps at 0600 — and the only thing any
   * screen is ever told about it is whether there is one. A key that can be
   * fetched by anything that can reach this page is a key that has been
   * given away.
   */
  if (pathname === '/api/tmdb') {
    if (req.method === 'GET') {
      return json(res, 200, { set: Boolean(String(cfg?.tmdbKey || '').trim()) });
    }
    if (req.method === 'PUT') {
      if (!cfg) return json(res, 400, { error: 'Connect a provider first.' });
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const key = String(incoming.key || '').trim();
      /* Long enough for a v4 read token, which is a JWT of a couple of
         hundred characters — the first shape of this check topped out at a
         hundred and twenty and would have refused the better credential of
         the two. Dots are part of it, not a typo. */
      if (key && !/^[A-Za-z0-9._-]{16,800}$/.test(key)) {
        return json(res, 400, { error: 'That does not look like a key or a read token.' });
      }
      writeConfig({ ...cfg, tmdbKey: key });
      /* Whatever was remembered was remembered without it, or with the old
         one. Both are the wrong answer now. */
      similarCache.clear();
      return json(res, 200, { set: Boolean(key) });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  if (pathname === '/api/providers') {
    if (req.method === 'GET') {
      const list = providers.accounts(cfg);
      /* Asked of the provider rather than remembered, but not on every open:
         an expiry date does not move, and a panel asked once a minute by a
         page somebody left open is a panel that starts refusing. */
      for (const account of list) {
        if (!providers.stale(account.id) && !query.get('refresh')) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const probe = await request(xtreamApiUrl(account, {}), { timeout: 15000 });
          // eslint-disable-next-line no-await-in-loop
          const body = JSON.parse((await readBody(probe)).toString('utf8'));
          if (body && body.user_info && body.user_info.auth !== 0) {
            providers.note(account.id, body.user_info);
          } else {
            providers.note(account.id, null, 'The provider rejected this login.');
          }
        } catch (err) {
          providers.note(account.id, null, err.message);
        }
      }
      return json(res, 200, {
        accounts: providers.report(cfg),
        free: providers.free(cfg),
        capacity: providers.capacity(cfg),
        inUse: providers.inUse(cfg),
      });
    }

    /* ---- another login on the same provider ---- */
    if (req.method === 'POST') {
      if (!cfg || cfg.mode !== 'xtream') {
        return json(res, 400, { error: 'Not in Xtream mode' });
      }
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const username = String(incoming.username || '').trim();
      const password = String(incoming.password ?? '');
      if (!username || !password) {
        return json(res, 400, { error: 'A username and password are required.' });
      }

      /* The same provider, always. The library is one catalogue keyed by the
         provider's own stream ids — point a second panel at it and half the
         ids would open the wrong thing, or nothing at all. */
      const host = normalizeHost(incoming.host || cfg.host);
      if (host !== normalizeHost(cfg.host)) {
        return json(res, 400, {
          error: 'Extra logins have to be on the same provider — the library is '
            + "keyed by that provider's own ids.",
        });
      }

      const existing = providers.accounts(cfg);
      if (existing.some((a) => a.username === username)) {
        return json(res, 409, { error: 'That login is already on the box.' });
      }

      const candidate = { host, username, password };
      let info;
      try {
        const probe = await request(xtreamApiUrl(candidate, {}), { timeout: 15000 });
        info = JSON.parse((await readBody(probe)).toString('utf8'));
      } catch (err) {
        return json(res, 502, { error: `Could not reach the provider: ${err.message}` });
      }
      if (!info || !info.user_info || info.user_info.auth === 0) {
        return json(res, 401, { error: 'The provider rejected those credentials.' });
      }

      const id = `p${Date.now().toString(36)}`;
      const next = readConfig() || cfg;
      next.accounts = [...existing.map((a) => ({ ...a })), {
        id, host, username, password, label: String(incoming.label || '').trim(),
      }];
      writeConfig(next);
      providers.note(id, info.user_info);
      return json(res, 200, {
        accounts: providers.report(next),
        capacity: providers.capacity(next),
      });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- removing one ----
   *
   * Removing the last login is the old "disconnect provider": there is no
   * library without one, so the box goes back to setup rather than sitting
   * there configured and unable to answer.
   */
  if (/^\/api\/providers\/[\w-]+$/.test(pathname)) {
    if (req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
    const id = pathname.split('/').pop();
    const list = providers.accounts(cfg);
    if (!list.some((a) => a.id === id)) return json(res, 404, { error: 'No such login' });

    if (list.length <= 1) {
      try {
        fs.unlinkSync(CONFIG_PATH);
      } catch {
        /* already gone */
      }
      providers.forget(id);
      return json(res, 200, { configured: false });
    }

    const next = readConfig() || cfg;
    next.accounts = list.filter((a) => a.id !== id).map((a) => ({ ...a }));
    /* The loose fields follow the list: they are what an older build and a
       few call sites still read, and leaving them pointed at a login that has
       been removed is how a box ends up authenticating as nobody. */
    next.host = next.accounts[0].host;
    next.username = next.accounts[0].username;
    next.password = next.accounts[0].password;
    writeConfig(next);
    providers.forget(id);
    return json(res, 200, { accounts: providers.report(next), capacity: providers.capacity(next) });
  }

  /* ---- Profiles ---- */
  /* ---- The lock itself, on or off ---- */
  if (pathname === '/api/profiles/lock') {
    if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed' });
    if (!attemptAllowed(req)) {
      return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    }
    let incoming;
    try {
      incoming = JSON.parse(await collectRequestBody(req));
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const data = readProfiles();
    const ok = verifyPassword(incoming.password, data.auth);
    noteAttempt(req, ok);
    if (!ok) return json(res, 401, { error: 'That password is not correct.' });

    data.profileLock = incoming.locked === true;
    writeProfiles(data);
    return json(res, 200, { locked: data.profileLock });
  }

  if (pathname === '/api/profiles') {
    const data = readProfiles();

    if (req.method === 'GET') {
      return json(res, 200, {
        profiles: data.profiles.map(publicProfile),
        // So the browser knows whether to ask for a password before it does.
        locked: data.profileLock,
      });
    }

    if (req.method === 'POST') {
      if (!attemptAllowed(req)) {
        return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
      }
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }

      if (data.profileLock) {
        const ok = verifyPassword(incoming.password, data.auth);
        noteAttempt(req, ok);
        if (!ok) return json(res, 401, { error: 'That password is not correct.' });
      }

      const name = String(incoming.name || '').trim().slice(0, 40);
      if (!name) return json(res, 400, { error: 'A profile name is required.' });
      if (data.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return json(res, 409, { error: 'A profile with that name already exists.' });
      }
      if (data.profiles.length >= 12) {
        return json(res, 409, { error: 'That is as many profiles as this server holds.' });
      }

      const profile = blankProfile(
        name,
        String(incoming.color || '#A21F24').slice(0, 24),
        String(incoming.emoji || '🎬').slice(0, 8)
      );

      // First profile inherits whatever was already favorited and pinned
      // before profiles existed, so nothing is lost on upgrade.
      if (!data.profiles.length) {
        const legacy = readPrefs();
        profile.favorites = legacy.favorites || [];
        profile.pinnedCategories = legacy.pinnedCategories || [];
      }

      data.profiles.push(profile);
      writeProfiles(data);
      return json(res, 200, publicProfile(profile));
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  const profileMatch =
    /^\/api\/profiles\/([\w-]+)(\/prefs|\/history|\/rating|\/taste|\/progress|\/foryou|\/seeds|\/notinterested)?$/.exec(pathname);
  if (profileMatch) {
    const data = readProfiles();
    const profile = findProfile(data, profileMatch[1]);
    if (!profile) return json(res, 404, { error: 'No such profile' });
    const suffix = profileMatch[2] || '';

    /* per-profile favorites and pins */
    if (suffix === '/prefs') {
      if (req.method === 'GET') {
        return json(res, 200, {
          favorites: profile.favorites || [],
          pinnedCategories: profile.pinnedCategories || [],
          pinnedGames: profile.pinnedGames || [],
          scoreSport: profile.scoreSport || 'mlb',
          pinOrder: profile.pinOrder || {},
          deletedItems: profile.deletedItems || [],
          deletedCategories: profile.deletedCategories || [],
          // A profile that has already watched or favorited something has
          // plainly found its way around, so it is not walked through the
          // basics. Only genuinely new ones get the tour.
          tourDone: profile.tourDone
            ?? ((profile.history || []).length > 0 || (profile.favorites || []).length > 0),
          // The Live TV note is separate, and shown the first time Live is
          // opened rather than in the opening tour. A profile that has already
          // pinned something has plainly worked pinning out on its own.
          liveTourDone: profile.liveTourDone
            ?? (profile.pinnedCategories || []).some((key) => key.startsWith('live:')),
          // Whether the starter pins have been laid down. Kept apart from the
          // note above so clearing one does not silently re-run the other.
          livePinsSeeded: profile.livePinsSeeded
            ?? (profile.pinnedCategories || []).some((key) => key.startsWith('live:')),
          // Whether this profile has been told the corner button changed. A
          // profile that has not finished the tour has not been told anything
          // yet and gets it there instead, pointed at the button itself.
          reportNoticeSeen: profile.reportNoticeSeen === true,
          // Whether the two-step explanation at the top of Downloads has been
          // read and put away.
          dlExplainSeen: profile.dlExplainSeen === true,
          // Whose box this is. Sent rather than worked out from the name on
          // the client, so there is one answer to the question.
          owner: isOwnerProfile(profile),
          // Everyone but Hunter has a download allowance. Sent so the UI can
          // show what is left rather than only finding out by being refused.
          downloadLimit: downloadLimitFor(profile),
          downloadUsed: downloadBytesFor(profile.id),
        });
      }
      if (req.method === 'PUT') {
        let incoming;
        try {
          incoming = JSON.parse(await collectRequestBody(req));
        } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        if (Array.isArray(incoming.favorites)) {
          profile.favorites = incoming.favorites.slice(0, 500);
        }
        if (Array.isArray(incoming.pinnedCategories)) {
          profile.pinnedCategories = incoming.pinnedCategories.slice(0, 300);
        }
        /* Which sport the scores band shows. On the profile rather than in
           one browser: somebody who follows football in October follows it on
           the phone too. */
        if (typeof incoming.scoreSport === 'string') {
          profile.scoreSport = ['nfl', 'mlb', 'ncaaf'].includes(incoming.scoreSport)
            ? incoming.scoreSport : 'mlb';
        }
        /* The starred games. Ids with the moment they were starred, so the
           list can be pruned by age — a game id is good for a day, and a
           profile that collected them for a season would be a list of
           thousands of games nobody can name. */
        if (Array.isArray(incoming.pinnedGames)) {
          profile.pinnedGames = incoming.pinnedGames
            .filter((p) => p && p.id)
            .map((p) => ({ id: String(p.id).slice(0, 40), at: Number(p.at) || 0 }))
            .slice(0, 60);
        }
        // These three were being dropped on the floor. The client has kept
        // them in the same object as favorites for a while, and PUT only ever
        // read two fields out of it — so hiding a title or reordering pins
        // looked like it worked and was gone by the next reload, on every
        // device including the one that did it.
        if (incoming.pinOrder && typeof incoming.pinOrder === 'object') {
          profile.pinOrder = {};
          for (const [tab, ids] of Object.entries(incoming.pinOrder)) {
            if (Array.isArray(ids)) profile.pinOrder[tab] = ids.slice(0, 300);
          }
        }
        if (Array.isArray(incoming.deletedItems)) {
          profile.deletedItems = incoming.deletedItems.slice(0, 2000);
        }
        if (Array.isArray(incoming.deletedCategories)) {
          profile.deletedCategories = incoming.deletedCategories.slice(0, 500);
        }
        if (typeof incoming.tourDone === 'boolean') profile.tourDone = incoming.tourDone;
        if (typeof incoming.liveTourDone === 'boolean') profile.liveTourDone = incoming.liveTourDone;
        if (typeof incoming.livePinsSeeded === 'boolean') {
          profile.livePinsSeeded = incoming.livePinsSeeded;
        }
        if (typeof incoming.reportNoticeSeen === 'boolean') {
          profile.reportNoticeSeen = incoming.reportNoticeSeen;
        }
        if (typeof incoming.dlExplainSeen === 'boolean') {
          profile.dlExplainSeen = incoming.dlExplainSeen;
        }
        writeProfiles(data);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    /* playback progress — the raw material for recommendations */
    if (suffix === '/history' && req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      if (!incoming.key) return json(res, 400, { error: 'key is required' });

      profile.history = profile.history || [];
      const existing = profile.history.find((r) => r.key === incoming.key);
      const row = existing || { key: incoming.key, firstAt: Date.now(), plays: 0 };

      row.kind = incoming.kind || row.kind || '';
      row.id = incoming.id ?? row.id;
      row.name = incoming.name || row.name || '';
      row.categoryId = incoming.categoryId ?? row.categoryId ?? '';
      row.categoryName = incoming.categoryName || row.categoryName || '';
      row.poster = incoming.poster || row.poster || '';
      row.seriesId = incoming.seriesId ?? row.seriesId;
      row.season = incoming.season ?? row.season;
      row.episode = incoming.episode ?? row.episode;
      if (Number.isFinite(incoming.position)) row.position = Math.max(0, incoming.position);

      // Enforce it server-side too: a live channel has no runtime and can
      // never be "finished", whatever a client reports.
      const isLive = row.kind === 'live';
      if (!isLive && Number.isFinite(incoming.duration) && incoming.duration > 0) {
        row.duration = incoming.duration;
      }
      if (isLive) {
        row.duration = 0;
        row.completed = false;
      } else if (incoming.completed) {
        row.completed = true;
      }
      if (incoming.newPlay || !existing) row.plays = (row.plays || 0) + 1;
      row.at = Date.now();

      if (!existing) profile.history.push(row);
      // Keep the most recent slice; unbounded history would bloat the file.
      profile.history.sort((a, b) => b.at - a.at);
      if (profile.history.length > HISTORY_LIMIT) {
        profile.history.length = HISTORY_LIMIT;
      }

      writeProfiles(data);
      return json(res, 200, { ok: true });
    }

    /* explicit thumbs — the strongest personalization signal */
    if (suffix === '/rating' && req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      if (!incoming.key) return json(res, 400, { error: 'key is required' });
      profile.ratings = profile.ratings || {};
      const value = Number(incoming.value);
      if (value === 0) delete profile.ratings[incoming.key];
      else profile.ratings[incoming.key] = value > 0 ? 1 : -1;
      writeProfiles(data);
      return json(res, 200, { ratings: profile.ratings });
    }

    /* where this profile left off in one specific title */
    /* Take one row off Continue watching, and nothing else.
     *
     * Deliberately not a deletion of the title: it stays in the library, it
     * stays searchable, it stays in favourites. All this forgets is that it
     * was watched — which is the whole of what somebody means when they want
     * a half-finished film off their landing page. The library's own hiding
     * lives elsewhere, behind Deleted in the sidebar, and is a different
     * decision with a different way back. */
    if (suffix === '/history' && req.method === 'DELETE') {
      const key = query.get('key');
      if (!key) return json(res, 400, { error: 'key is required' });
      const before = (profile.history || []).length;
      profile.history = (profile.history || []).filter((r) => r.key !== key);
      if (profile.history.length !== before) writeProfiles(data);
      return json(res, 200, { removed: before - profile.history.length });
    }

    if (suffix === '/progress' && req.method === 'GET') {
      const row = (profile.history || []).find((r) => r.key === query.get('key'));
      if (!row) return json(res, 200, { found: false });
      return json(res, 200, {
        found: true,
        position: Math.floor(row.position || 0),
        duration: Math.floor(row.duration || 0),
        completed: Boolean(row.completed),
        at: row.at || 0,
      });
    }

    /* aggregated signals for the personalization layer */
    if (suffix === '/taste' && req.method === 'GET') {
      return json(res, 200, tasteProfile(profile));
    }

    /*
     * For you — films this house has NOT seen.
     *
     * The reckoning is in recommend.js, which is handed the catalogue, the
     * credits index and a way to reach the internet, and knows nothing about
     * HTTP or about this file. What it hands back is library items, because
     * a recommendation for a film that cannot be played here is not one.
     */
    if (suffix === '/foryou' && req.method === 'GET') {
      /* Films or shows. The same reckoning either way — what somebody liked,
         who made it, what an audience reached for next — asked of the other
         half of the catalogue. */
      const kind = query.get('kind') === 'series' ? 'series' : 'movie';
      const catalogue = kind === 'series' ? knownSeries() : knownMovies();
      if (!catalogue.length) {
        return json(res, 200, {
          items: [], needs: 'library', picks: [], similar: { asked: 0, answered: 0 },
        });
      }
      const answer = await recommend.forYou({
        profile,
        kind,
        catalogue: catalogue.filter((m) => !m.adult),
        categoryAffinity: tasteProfile(profile).categoryAffinity,
        people,
        seeds: (profile.tasteSeeds || []).filter(
          (row) => (row.kind || 'movie') === kind),
        notInterested: notInterestedIds(profile, kind),
        cache: similarCache,
        /* Somebody else's server, so it is asked the way every other outside
           address here is asked, and it is allowed to fail. */
        /* Headers passed through, because one of the recommendation services
           takes its credential in an Authorization header rather than in the
           query string — which is the better half of the pair, since a
           secret in a URL is a secret in every log it passes through. */
        fetchJson: (url, headers) => fetchJson(url, { ...SITE_HEADERS, ...(headers || {}) }),
        log: (line) => console.log(line),
        /* Read here rather than passed around: it lives in config.json with
           the provider password, 0600, and it must not travel to a browser
           or into any URL this box hands out. */
        tmdbKey: String(cfg?.tmdbKey || '').trim(),
      });
      return json(res, 200, answer);
    }

    /*
     * The films somebody picked when asked what they love.
     *
     * Stored on the profile beside the ratings, because that is what they
     * are: a thumbs-up given before there was anything to give one to. Kept
     * small — this is a seed, not a second favourites list.
     */
    if (suffix === '/seeds' && req.method === 'PUT') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const rows = Array.isArray(incoming.seeds) ? incoming.seeds : [];
      /* Kept per kind: answering the film picker must not wipe the show
         picker, and a show id and a film id can be the same number. Seeds
         saved before this carried no kind and are films, which is what
         `|| 'movie'` says on the way back out. */
      const kind = incoming.kind === 'series' ? 'series' : 'movie';
      const held = (profile.tasteSeeds || []).filter(
        (row) => (row.kind || 'movie') !== kind);
      const fresh = rows.slice(0, 12).map((row) => ({
        kind,
        id: String(row.id || ''),
        name: String(row.name || '').slice(0, 200),
      })).filter((row) => row.id);
      profile.tasteSeeds = [...held, ...fresh];
      writeProfiles(data);
      return json(res, 200, {
        seeds: profile.tasteSeeds.filter((row) => (row.kind || 'movie') === kind),
      });
    }

    /*
     * Suggestions somebody has answered.
     *
     * A list of `kind:id`, and nothing else reads it — see notInterestedIds
     * above for why this is not the same thing as the library bin. Capped,
     * because it grows one press at a time and nothing ever prunes it; the
     * oldest answers are the ones worth forgetting, since a row that has been
     * refused two hundred times has bigger problems than its bookkeeping.
     */
    if (suffix === '/notinterested') {
      if (req.method === 'GET') {
        return json(res, 200, { notInterested: profile.notInterested || [] });
      }
      if (req.method === 'PUT') {
        let incoming;
        try {
          incoming = JSON.parse(await collectRequestBody(req));
        } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        const kind = incoming.kind === 'series' ? 'series' : 'movie';
        const id = String(incoming.id || '').slice(0, 64);
        if (!id) return json(res, 400, { error: 'Which one?' });
        const key = `${kind}:${id}`;
        const held = (profile.notInterested || []).filter((row) => row !== key);
        /* `on` absent means "bin it", which is the press that has a button on
           it today. `on: false` takes it back — nothing in the app sends that
           yet, and it is here because a list somebody can only ever add to is
           a list somebody eventually wants undone, and the endpoint that
           wrote it is the obvious place to ask. */
        if (incoming.on === false) profile.notInterested = held;
        else profile.notInterested = [...held, key].slice(-500);
        writeProfiles(data);
        return json(res, 200, { notInterested: profile.notInterested });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    /* rename / restyle — open, like editing a profile on a TV app */
    if (!suffix && req.method === 'PATCH') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      if (incoming.name) {
        const name = String(incoming.name).trim().slice(0, 40);
        const clash = data.profiles.some(
          (p) => p.id !== profile.id && p.name.toLowerCase() === name.toLowerCase()
        );
        if (clash) return json(res, 409, { error: 'A profile with that name already exists.' });
        profile.name = name;
      }
      if (incoming.color) profile.color = String(incoming.color).slice(0, 24);
      if (incoming.emoji) profile.emoji = String(incoming.emoji).slice(0, 8);
      writeProfiles(data);
      return json(res, 200, publicProfile(profile));
    }

    /* deleting throws away watch history, so it needs the password */
    if (!suffix && req.method === 'DELETE') {
      if (!attemptAllowed(req)) {
        return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
      }
      let incoming = {};
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        /* body is optional — with the lock off there is nothing to send */
      }
      if (data.profileLock) {
        const ok = verifyPassword(incoming.password, data.auth);
        noteAttempt(req, ok);
        if (!ok) return json(res, 401, { error: 'That password is not correct.' });
      }

      data.profiles = data.profiles.filter((p) => p.id !== profile.id);
      writeProfiles(data);
      return json(res, 200, { removed: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- Feedback and bug reports ---- */
  if (pathname === '/api/reports') {
    if (req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse((await collectRequestBody(req)).toString('utf8') || '{}');
      } catch {
        return json(res, 400, { error: 'Bad JSON' });
      }

      const clip = (value, max) => redactUrl(String(value ?? '').trim()).slice(0, max);
      const message = clip(incoming.message, REPORT_LIMITS.message);
      if (!message) return json(res, 400, { error: 'Say something about it first.' });

      const profile = ownerOf(incoming.profileId);
      const report = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        kind: incoming.kind === 'bug' ? 'bug' : 'idea',
        // The first line is the title; the whole thing is still the body, so
        // nothing is lost to making it readable in a list.
        title: message.split('\n')[0].slice(0, 90),
        message,
        contact: clip(incoming.contact, REPORT_LIMITS.contact),
        context: clip(incoming.context, REPORT_LIMITS.context),
        page: clip(incoming.page, REPORT_LIMITS.page),
        version: clip(incoming.version, 20),
        device: clip(incoming.device, 200),
        profile: profile?.name || clip(incoming.profileName, 60) || 'unknown',
        profileId: profile?.id || '',
      };

      const reports = readReports();
      reports.unshift(report);
      writeReports(reports);

      return json(res, 200, { ok: true, id: report.id });
    }

    if (req.method === 'GET') {
      // The box is unauthenticated by design — see the README — so this is not
      // a security boundary and is not dressed as one. It stops one household
      // member idly reading another's reports through the UI, which is the
      // only thing it could honestly do.
      if (!isOwnerProfile(ownerOf(query.get('profileId')))) {
        return json(res, 403, { error: 'Reports are only shown to the owner profile.' });
      }
      return json(res, 200, { reports: readReports() });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- Preferences (pinned categories, favorites) ---- */
  if (pathname === '/api/prefs') {
    if (req.method === 'GET') return json(res, 200, readPrefs());
    if (req.method === 'PUT') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const prefs = readPrefs();
      if (Array.isArray(incoming.pinnedCategories)) {
        prefs.pinnedCategories = incoming.pinnedCategories.slice(0, 300);
      }
      if (Array.isArray(incoming.favorites)) {
        prefs.favorites = incoming.favorites.slice(0, 500);
      }
      if (typeof incoming.captionTrack === 'string') {
        prefs.captionTrack = incoming.captionTrack.slice(0, 120);
      }
      if (typeof incoming.filtersEnabled === 'boolean') {
        prefs.filtersEnabled = incoming.filtersEnabled;
      }
      // Weak Wi-Fi. Stored on the box rather than in the browser so the same
      // corner of the house behaves the same on every device in it.
      if (typeof incoming.lowBandwidth === 'boolean') {
        prefs.lowBandwidth = incoming.lowBandwidth;
      }
      if (incoming.filters && typeof incoming.filters === 'object') {
        for (const tab of ['live', 'movies', 'series']) {
          if (typeof incoming.filters[tab] === 'string') {
            prefs.filters[tab] = incoming.filters[tab];
          }
        }
      }
      writePrefs(prefs);
      return json(res, 200, prefs);
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- Downloads ---- */
  if (pathname === '/api/health') {
    return json(res, 200, await readHealth());
  }

  /* One yes/no for "is anyone actually using this right now". The auto-updater
   * asks before restarting, so a push never drops a film mid-scene.
   *
   * A finished remux still plays from disk with ffmpeg long gone, so provider
   * traffic alone would read as idle while someone is halfway through a film.
   * lastAccess is the honest signal: the reaper at the top of this file already
   * trusts it to decide a session is abandoned. */
  /* Filler bytes, purely so a phone can measure what it actually gets from this
   * box. /api/health reports what the Pi sees of its own link; on a connection
   * from outside the house that is a different number from what arrives, and
   * the gap between them is exactly where playback problems hide.
   *
   * Random rather than zeros: anything compressing the response in transit
   * would otherwise report a speed nobody can actually stream at. */
  if (pathname === '/api/speedtest') {
    const asked = Number(query.get('bytes')) || 8 * 1024 * 1024;
    const total = Math.min(Math.max(asked, 1024), 64 * 1024 * 1024);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': total,
      'cache-control': 'no-store',
    });
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        const size = Math.min(SPEEDTEST_CHUNK.length, total - sent);
        sent += size;
        const slice = size === SPEEDTEST_CHUNK.length ? SPEEDTEST_CHUNK : SPEEDTEST_CHUNK.subarray(0, size);
        // Respect backpressure, or a slow link buffers the whole sample in RAM
        // on a box that does not have it to spare.
        if (!res.write(slice)) return res.once('drain', pump);
      }
      res.end();
    };
    req.on('close', () => res.destroy());
    pump();
    return;
  }

  if (pathname === '/api/activity') {
    const streaming = providerStreams > 0;
    const watching = [...remuxSessions.values()].some((s) => Date.now() - s.lastAccess < 60_000);
    const downloading = Boolean(activeJob && activeJob.status === 'downloading');
    // Generous window: Safari can leave a real gap between range requests while
    // it chews through what it already has, and a false idle here costs someone
    // their film.
    const playingLocal = Date.now() - localPlaybackAt < 90_000;
    /*
     * A RECORDING IS THE BUSIEST THE BOX EVER IS, and it counted for nothing.
     *
     * beginRecording spawns ffmpeg itself; it never touches providerStreams,
     * opens no remux session and starts no download — so a box quietly
     * writing a two-hour programme set every flag here to false and told the
     * auto-updater it was idle. The updater pulled, restarted the portal, the
     * ffmpeg went with it, and the row came back as `partial` or `missed`
     * with "The box restarted while this was recording."
     *
     * Which is precisely the way to lose every recording you ever asked for
     * and have nothing to blame but a deploy. Nobody is in the room when this
     * happens, which is the whole point of recording, and it is exactly why
     * an unattended job has to say so louder than a watched one.
     */
    const live = recordings.active();
    const recording = live.length > 0;
    /*
     * And WHEN it will be done, because "busy" alone is not enough here.
     *
     * The updater holds for ten minutes and then goes anyway — deliberately,
     * so a busy flag that never clears cannot stall every deploy for ever. A
     * ball game is three hours, so a recording would be cut off at the ten
     * minute mark by the very mechanism meant to protect it.
     *
     * A recording is the one kind of busy with a KNOWN END, so it can say
     * when: hold until this moment, not indefinitely. The updater keeps its
     * own ceiling on top of this — a number from the box is still a number
     * from a program that might be wrong.
     */
    const recordingUntil = live.reduce(
      (latest, row) => Math.max(latest, recordings.closesAt(row)), 0);
    return json(res, 200, {
      busy: streaming || watching || downloading || playingLocal || recording,
      streaming,
      watching,
      downloading,
      playingLocal,
      recording,
      recordingUntil: recordingUntil || null,
    });
  }

  if (pathname === '/api/downloads') {
    if (req.method === 'GET') {
      const rows = [...downloads.values()].sort((a, b) => b.createdAt - a.createdAt);
      return json(res, 200, {
        items: rows,
        active: activeJob ? activeJob.id : null,
        queued: queue.length,
        freeBytes: Number.isFinite(diskFree(DOWNLOAD_DIR)) ? diskFree(DOWNLOAD_DIR) : null,
      });
    }

    if (req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      if (!incoming.name) return json(res, 400, { error: 'A name is required' });

      // A third kind of source: a file on the archive drive. Identified by
      // its path within the index rather than by a provider id, and checked
      // against the index here — resolve() refuses traversal, and a path the
      // index does not list is not a thing this will convert.
      const archivePath = String(incoming.archivePath || '');
      if (archivePath) {
        if (!archive.entry(archivePath) || !archive.resolve(archivePath)) {
          return json(res, 404, { error: 'Not in the archive index' });
        }
      } else if (!incoming.streamId && !incoming.sourceUrl) {
        return json(res, 400, { error: 'streamId or sourceUrl is required' });
      }

      // Checked here rather than in the browser. The browser is where the
      // number is shown; this is where it means anything.
      const profileId = String(incoming.profileId || '');
      const owner = readProfiles().profiles.find((p) => p.id === profileId);
      const allowance = downloadLimitFor(owner);
      if (Number.isFinite(allowance)) {
        const used = downloadBytesFor(profileId);
        if (used >= allowance) {
          return json(res, 413, {
            error: `That's your ${gb(allowance)} of downloads used up. `
              + 'Delete something from Downloads to make room.',
            used,
            limit: allowance,
          });
        }
      }

      // The same title is never saved twice. Matched on what it IS (kind +
      // provider stream id), not on the name, and a failed attempt does not
      // count — failure is exactly when asking again should work.
      // An archive file's identity is its path on the drive, which slots
      // into the same duplicate check every other title uses.
      const wantId = archivePath
        ? `archive:${archivePath}`
        : (incoming.streamId ? String(incoming.streamId) : '');
      const wantKind = incoming.kind === 'series' ? 'series' : 'movie';
      if (wantId) {
        const dup = [...downloads.values()].find((j) => j.kind === wantKind
          && j.streamId === wantId && j.status !== 'error');
        if (dup) {
          return json(res, 409, {
            error: dup.status === 'done'
              ? 'Already downloaded — it\'s in Downloads.'
              : 'Already in the download queue.',
            id: dup.id,
            status: dup.status,
          });
        }
      }

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const job = {
        id,
        name: safeName(incoming.name),
        kind: incoming.kind === 'series' ? 'series' : 'movie',
        streamId: wantId,
        sourceUrl: incoming.sourceUrl || '',
        // Where on the drive this came from, and the flag the worker branches
        // on. Empty for everything that comes off the provider.
        archivePath,
        // Archive titles always land as mp4, whatever they started as.
        ext: archivePath ? 'mp4' : ((incoming.ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'),
        poster: incoming.poster || '',
        // Ties the offline copy to the same watch position as the stream.
        resumeKey: incoming.resumeKey || '',
        // Series identity, so the Downloads grid can group episodes under the
        // show they belong to instead of listing each one loose.
        seriesId: incoming.seriesId ? String(incoming.seriesId) : '',
        seriesName: incoming.seriesName || '',
        season: Number(incoming.season) || 0,
        episode: Number(incoming.episode) || 0,
        subtitle: incoming.subtitle || '',
        // Who this counts against. Downloads are shared — anyone can play
        // anything that is on the box — but the allowance is per profile.
        profileId,
        bytes: 0,
        total: 0,
        status: 'queued',
        error: '',
        createdAt: Date.now(),
      };
      enqueue(job);
      return json(res, 200, job);
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  const downloadMatch =
    /^\/api\/downloads\/([\w-]+)(\/file|\/save|\/retry|\/pause|\/optimize)?$/.exec(pathname);
  if (downloadMatch) {
    const job = downloads.get(downloadMatch[1]);
    if (!job) return json(res, 404, { error: 'No such download' });
    const suffix = downloadMatch[2] || '';

    if (suffix === '/file' || suffix === '/save') {
      if (job.status !== 'done') return json(res, 409, { error: 'Download not finished' });
      // Playing, or saving to the phone. Either way the box is in use and a
      // restart underneath it would cut the transfer off mid-stream.
      localPlaybackAt = Date.now();
      return serveLocalFile(req, res, path.join(DOWNLOAD_DIR, job.file), {
        attachmentName: suffix === '/save' ? `${job.name}.${job.ext}` : null,
        // How the page watches a save it can no longer see for itself.
        track: suffix === '/save' ? (query.get('track') || '') : '',
      });
    }

    if (suffix === '/pause' && req.method === 'POST') {
      if (job.status !== 'downloading' && job.status !== 'queued') {
        return json(res, 409, { error: 'That download is not running' });
      }
      // Partial bytes stay on disk; /retry resumes from the current offset.
      const wasActive = activeJob && activeJob.id === job.id;
      job.status = 'paused';
      job.autoPaused = false; // a manual pause sticks until manually resumed
      const at = queue.indexOf(job.id);
      if (at >= 0) queue.splice(at, 1);
      if (wasActive && activeRequest) {
        try {
          activeRequest.destroy();
        } catch {
          /* already torn down */
        }
      }
      persistDownloads();
      return json(res, 200, job);
    }

    // Convert a finished download to browser-native MP4, or try again after a
    // failure. Without this a botched conversion left the file as .mkv with no
    // way back — and every play of it fell to slow on-the-fly conversion.
    if (suffix === '/optimize' && req.method === 'POST') {
      if (job.status !== 'done') return json(res, 409, { error: 'Download not finished' });
      if (job.preparing) return json(res, 409, { error: 'Already optimizing' });
      if (!hasFfmpeg()) return json(res, 501, { error: 'ffmpeg is not installed on the server' });
      if (NATIVE_CONTAINERS.has(String(job.ext || '').toLowerCase())) {
        return json(res, 200, { ok: true, alreadyNative: true });
      }
      queuePrepare(job);
      return json(res, 200, { ok: true });
    }

    if (suffix === '/retry' && req.method === 'POST') {
      if (job.status === 'downloading' || job.status === 'queued') {
        return json(res, 409, { error: 'Already running' });
      }
      job.status = 'queued';
      job.error = '';
      // Asked for by hand (Resume all, or resuming one), so the automatic
      // backoff starts over rather than counting this against it.
      job.tries = 0;
      job.failedAt = 0;
      job.permanent = false;
      persistDownloads();
      queue.push(job.id);
      processQueue();
      return json(res, 200, job);
    }

    if (req.method === 'DELETE') {
      cancelJob(job, { removeFile: true });
      return json(res, 200, { removed: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  if (!cfg) return json(res, 409, { error: 'Not configured' });

  /* ---- What is on, for a handful of channels at once ---- */
  //
  // The player already asks for one channel's listings when it tunes in. A
  // guide on the landing page is the same question asked of six channels at
  // once, and that is a different problem: this provider allows ONE
  // connection, and while ffmpeg is streaming through it every metadata call
  // comes back `{"error":""}`. Six calls fired from a browser while somebody
  // is watching something would be six failures and a connection contended
  // for no reason.
  //
  // So it is asked here instead, where the box already knows whether the
  // provider is free, and answered from a cache the rest of the time. A
  // listing is good for as long as the programme runs; half an hour old is
  // still true.
  if (pathname === '/api/epg/now') {
    if (mode !== 'xtream') return json(res, 200, { channels: [], reason: 'not-xtream' });

    const ids = String(query.get('ids') || '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, EPG_MAX_CHANNELS);
    if (!ids.length) return json(res, 200, { channels: [] });

    const now = Date.now();
    const fresh = [];
    const stale = [];
    // Only built if one of the ids might need it — this walks the cache.
    const liveNames = new Map(knownLiveChannels().map((c) => [String(c.id), c.name]));
    for (const id of ids) {
      /* The outside guide first, and it is not a cache — it is a whole day of
       * listings already on disk, for far more channels than the provider
       * will answer for one at a time. When it has the channel there is
       * nothing to ask anybody, so the row paints immediately and the one
       * connection is never touched. */
      const fromGuide = guide.lookup(id);
      if (fromGuide) {
        fresh.push({ id, known: true, source: 'guide', listings: windowOf(fromGuide, now) });
        continue;
      }
      // An event channel says what is on in its own name. Nothing to look up
      // and nobody to ask.
      const fromName = listingFromName(liveNames.get(String(id)));
      if (fromName) {
        fresh.push({ id, known: true, source: 'name', listings: windowOf(fromName, now) });
        continue;
      }
      const held = epgCache.get(id);
      if (held && now - held.at < EPG_TTL_MS) fresh.push(held.channel);
      else stale.push(id);
    }

    // Playback owns the connection. Whatever is already known is served, and
    // the rest waits — a guide is worth having, and never worth a stutter.
    if (stale.length && !providerBusy()) {
      for (const id of stale.slice(0, EPG_PER_REQUEST)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const upstream = await request(xtreamApiUrl(providers.forMeta(cfg) || cfg, {
            // Twenty, not ten: still one call to the provider, and it is what
            // the schedule needs to be able to scroll forward at all.
            action: 'get_short_epg', stream_id: id, limit: 20,
          }));
          // eslint-disable-next-line no-await-in-loop
          const body = (await readBody(upstream)).toString('utf8');
          const data = JSON.parse(body);
          const listings = (data.epg_listings || []).map(decodeEpg);
          const channel = { id, known: true, listings: listings.map((l) => ({
            title: l.title || '',
            start: Number(l.start_timestamp) || 0,
            stop: Number(l.stop_timestamp) || 0,
          })).filter((l) => l.start && l.stop) };
          epgCache.set(id, { at: now, channel });
          fresh.push(channel);
        } catch {
          // A channel the provider has no listings for is not an error, it
          // is a channel with no listings. Remembered as such so it is not
          // asked again every few seconds.
          epgCache.set(id, { at: now, channel: { id, known: true, listings: [] } });
        }
      }
    }

    /* Anything still unanswered comes back as itself with nothing in it, so
     * the page can lay out every row it asked for rather than reflowing as
     * answers trickle in — but marked `known: false`, which is the whole
     * difference between "this channel has no listings" and "the box has not
     * got to this channel yet".
     *
     * Without that the page cannot tell them apart, and either says "no
     * listings" about a channel that has some, or leaves a row blank for ten
     * seconds waiting for an answer that already came back empty. */
    const answered = new Set(fresh.map((c) => c.id));
    for (const id of ids) if (!answered.has(id)) fresh.push({ id, known: false, listings: [] });

    return json(res, 200, {
      channels: ids.map((id) => fresh.find((c) => c.id === id)),
      busy: providerBusy(),
    });
  }

  /* ---- The football slate ---- */
  if (pathname === '/api/scores/nfl') {
    const slate = await nflScores();
    return json(res, 200, {
      games: slate.games,
      at: slate.at,
      error: slate.error || undefined,
    });
  }

  /* ---- What a live channel's window has been doing ----
   *
   * The answer to "it jumped back to where I started watching", which is a
   * question about a moment that has already gone. Each live session keeps
   * its last few dozen notable moments — ingest started, ingest exited,
   * ingest resumed, and any time the published window moved in a way a player
   * would react to. `window-restarted` is the one that matters: a media
   * sequence or a first segment going backwards is a player's cue to treat
   * the stream as a new one and join it at the beginning. */
  if (pathname === '/api/live/report') {
    const wanted = query.get('id') || '';
    const sessions = [...remuxSessions.values()]
      .filter((s) => s.live && (!wanted || s.id === wanted || s.id.endsWith(`-${wanted}`)))
      .map((s) => ({
        id: s.id,
        low: Boolean(s.low),
        alive: !s.exited,
        restarts: s.restarts || 0,
        idleSeconds: Math.round((Date.now() - s.lastAccess) / 1000),
        window: s.window || null,
        notes: (s.notes || []).map((note) => ({ ...note, ago: `${Math.round((Date.now() - note.at) / 1000)}s` })),
      }));
    return json(res, 200, { sessions, now: Date.now() });
  }

  /* ---- Who is in what ----
   *
   * The client holds the library already, so this answers with ids and lets
   * the page pick its own cards out of what it has — a name in a big library
   * can be in eighty films, and eighty projected records is a payload for
   * nothing. `indexed` and `total` travel with it because the honest answer
   * to "everything with this actor" is "everything the box has looked at so
   * far", and the page says so. */
  if (pathname === '/api/people/films') {
    const name = query.get('name') || '';
    if (!name) return json(res, 400, { error: 'name is required' });
    const ids = people.filmsWith(name);
    const state = people.status();
    return json(res, 200, {
      name,
      ids,
      directed: ids.filter((id) => people.directed(name, id)),
      indexed: state.films,
      total: cachedMovies().length,
      scanning: Boolean(state.crawl.at) && state.films < cachedMovies().length,
    });
  }

  /* ---- What they look like ----
   *
   * A page asks about everybody on it at once. Cached answers come back
   * immediately; the rest are fetched one at a time, because this is somebody
   * else's server and a dozen parallel requests from a set-top box is how a
   * polite endpoint stops being available. */
  if (pathname === '/api/people/portraits') {
    const names = (query.get('names') || '').split('|').map((n) => n.trim()).filter(Boolean);
    const out = [];
    for (const name of names.slice(0, 16)) {
      // eslint-disable-next-line no-await-in-loop
      const face = await people.portrait(name, request, readBody).catch(() => null);
      out.push({ name, image: face ? face.image : '', id: face ? face.id : '' });
    }
    return json(res, 200, { people: out });
  }

  /* ---- The baseball slate ---- */
  if (pathname === '/api/scores/mlb') {
    const slate = await mlbScores();
    return json(res, 200, {
      games: slate.games,
      at: slate.at,
      error: slate.error || undefined,
    });
  }

  /* ---- Both, in one call ----
   *
   * The television asks for the sports it can show rather than for a sport it
   * has to know about, so a season ending is not a change to the app: in
   * August this answers baseball and nothing else, in December it answers
   * both, and the row simply shows what is live. Fetched together and each
   * cached on its own, so a sport that is out of season — or a feed that is
   * down — costs an empty list rather than the whole row. */
  /* ---- every address, asked ----
   *
   * `/api/scores` reports the addresses it got as far as, which is the right
   * report for a chain that stops at the first answer and the wrong one for
   * working out why there is no answer at all. This asks every address in
   * both football lists and says what each said, including the ones the
   * ordinary poll never reaches. A page somebody opens, never the poll.
   */
  if (pathname === '/api/scores/probe') {
    const only = String(query.get('sport') || '').toLowerCase();
    /* `find` answers the question a games COUNT cannot: a game that is not on
       the band is either not in what the address sent, or is in it and this
       box dropped it, and those are different bugs with the same symptom. */
    const find = String(query.get('find') || '').slice(0, 40);

    /* An address that is not on any list yet.
     *
     * Finding out whether somebody's server will talk to THIS box has meant
     * shipping a version to ask it, which is a deploy and a wait per guess.
     * `?url=` asks whatever you hand it and reports the same four things —
     * status, size, the start of the body, and how many games came out of
     * the mapping. Guarded like every other endpoint here that fetches an
     * address somebody typed: the box will not be talked into knocking on
     * its own network's doors.
     */
    const one = String(query.get('url') || '').trim();
    if (one) {
      const bad = privateAddress(one);
      if (bad) return json(res, 400, { error: bad });
      const sport = only === 'nfl' ? 'nfl' : 'ncaaf';
      return json(res, 200, {
        at: Date.now(),
        feeds: [{ sport, find: find || undefined, addresses: await probeFootball(sport, [one], find) }],
      });
    }

    const lists = [
      ['ncaaf', ncaafUrls()],
      ['nfl', nflUrls()],
    ].filter(([sport]) => !only || only === sport);
    const feeds = [];
    for (const [sport, urls] of lists) {
      // eslint-disable-next-line no-await-in-loop
      feeds.push({ sport, find: find || undefined, addresses: await probeFootball(sport, urls, find) });
    }
    /* And one club mark, actually fetched. The addresses are ESPN's image
       CDN, which is a different service from the API that refuses this box —
       but "different service" is a reasonable belief, not a fact, and a
       badge that does not load looks from the sofa exactly like a badge that
       was never looked up. */
    let mark = null;
    const sample = collegeMarks.logo('Michigan');
    if (sample) {
      const began = Date.now();
      try {
        const probeRes = await request(sample, { headers: SITE_HEADERS, timeout: 15000 });
        const body = await readBody(probeRes);
        mark = {
          url: sample,
          status: probeRes.statusCode || 0,
          bytes: body.length,
          type: probeRes.headers['content-type'] || '',
          ms: Date.now() - began,
        };
      } catch (err) {
        mark = { url: sample, status: 0, error: err.message, ms: Date.now() - began };
      }
    }
    return json(res, 200, { at: Date.now(), feeds, mark, marksKnown: collegeMarks.size });
  }

  if (pathname === '/api/scores') {
    const [nfl, mlb, ncaaf] = await Promise.all([nflScores(), mlbScores(), ncaafScores()]);
    const games = [
      ...nfl.games.map((g) => ({ ...g, sport: g.sport || 'nfl' })),
      ...mlb.games,
      ...ncaaf.games,
    ];
    return json(res, 200, {
      games,
      at: Math.max(nfl.at, mlb.at, ncaaf.at),
      error: [nfl.error, mlb.error, ncaaf.error].filter(Boolean).join(' · ') || undefined,
      /* A per-feed report, for the same reason the guide has one: an empty row
       * has several possible causes and they are indistinguishable from the
       * sofa. Opening this URL on the box answers "did it ask, who did it ask,
       * and what came back" in one line each. The addresses are public and
       * carry no credentials, so they can be shown. */
      feeds: [
        { sport: 'nfl',
          /* Groups kept as groups. An address nested inside an array is
             one this feed asks TOGETHER with its siblings and merges, which
             is a different thing from one it falls back to — and the
             difference is the whole reason a live game stopped
             disappearing. Flattened, the report could not show it. */
          url: nflUrls(),
          source: nfl.source || undefined,
          games: nfl.games.length,
          at: nfl.at,
          error: nfl.error || undefined,
          /* How many addresses answered and had nothing. An empty band with
             no error behind it is a quiet day, and the number is what says
             the box asked properly before deciding that. */
          quiet: nfl.quiet || undefined,
          /* Which addresses were asked and what each said. An empty band has
             several causes and this is the line that tells them apart. */
          tried: nfl.tried?.length ? nfl.tried : undefined },
        { sport: 'ncaaf',
          url: ncaafUrls(),
          source: ncaaf.source || undefined,
          games: ncaaf.games.length,
          at: ncaaf.at,
          error: ncaaf.error || undefined,
          quiet: ncaaf.quiet || undefined,
          /* How many clubs on the slate found a mark, and the names of the
             ones that did not. Two lists have to agree on what a school is
             called for a badge to appear, and when they do not the answer is
             a name to add — which is only actionable if the box says which
             name. */
          marks: ncaaf.games.length ? {
            known: collegeMarks.size,
            missing: [...new Set(ncaaf.games.flatMap((g) => [
              g.away && !g.away.logo ? g.away.abbr : '',
              g.home && !g.home.logo ? g.home.abbr : '',
            ]).filter(Boolean))].slice(0, 30),
          } : undefined,
          tried: ncaaf.tried?.length ? ncaaf.tried : undefined },
        {
          sport: 'mlb',
          /* Two sources, asked in this order. Which one answered matters when
             one of them is refusing the box. */
          url: [...new Set([MLB_STATS_FULL_URL, MLB_STATS_URL, MLB_URL])],
          source: mlb.source || undefined,
          games: mlb.games.length,
          at: mlb.at,
          error: mlb.error || undefined,
        },
      ],
    });
  }

  /* ---- What this host actually publishes ---- */
  //
  // A hardcoded list of feed names is a guess about somebody else's server,
  // and it goes stale silently: two of three US files began answering 404
  // while the third downloaded fine, and nothing about that is knowable from
  // here. The directory page settles it — the same page a person would open
  // to look, read by the box so the list on screen is the real one.
  if (pathname === '/api/epg/available') {
    const home = String(query.get('url') || GUIDE_CATALOGUE_HOME).trim();
    const bad = privateAddress(home);
    if (bad) return json(res, 400, { error: bad });
    try {
      const files = await guide.listing(home);
      return json(res, 200, { home, files });
    } catch (err) {
      return json(res, 200, { home, files: [], error: err.message });
    }
  }

  /* ---- What a feed actually says ---- */
  //
  // "HTTP 404" is where a diagnosis stops rather than starts, and two of three
  // feeds from one host saying it — with the filenames verified correct and
  // the third downloading fine — is not something anybody can reason about
  // from the outside. So the box asks and repeats the answer: the status, what
  // the headers claim, what the first bytes really are, and the top of the
  // body, which on a block or a rate-limit page says so in words.
  if (pathname === '/api/epg/probe') {
    const target = String(query.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) {
      return json(res, 400, { error: 'That is not a web address.' });
    }
    const bad = privateAddress(target);
    if (bad) return json(res, 400, { error: bad });
    const said = await guide.probe(target);
    /* A guide that 404s has almost always been RENAMED rather than
     * withdrawn, so the status code is not the useful part of the answer —
     * the neighbouring filename is. Only asked for on a failure, and only of
     * the directory the missing file was in. */
    if (said.status >= 400 || said.error) {
      try {
        const home = new URL('./', target).toString();
        if (!privateAddress(home)) {
          said.alternatives = guide.nearestNames(target, await guide.listing(home));
        }
      } catch {
        /* the host has no index, which is not a second failure worth naming */
      }
    }
    return json(res, 200, said);
  }

  /* ---- Why a channel has no listings ---- */
  //
  // "I saved and fetched the US feeds but I am not getting NBC listings."
  //
  // Without this the only way to answer that is to guess, and the answer is
  // nearly always something you could see in a second if the two sides were
  // put side by side: we call it NBC EAST, the guide calls it NBC. So the box
  // shows both rather than being asked to be cleverer.
  if (pathname === '/api/epg/explain') {
    // Answered against what the box knows NOW, not against whatever the last
    // refresh happened to run on — the channel you are asking about may well
    // be one that has appeared since.
    const channels = knownLiveChannels();
    guide.setCountry(cfg?.guideCountry === undefined ? 'us' : cfg.guideCountry);
    guide.setChannels(channels);
    return json(res, 200, { ...guide.explain(query.get('q') || ''), known: channels.length });
  }

  /* ---- Where the listings come from ---- */
  //
  // The provider has no listings at all for most of what it sells, and the
  // only way round that is to read a guide somebody else publishes. This is
  // the screen for saying which ones, and for seeing whether it worked —
  // coverage is the whole point, so it is the number reported first.
  if (pathname === '/api/epg/sources') {
    if (req.method === 'GET') {
      const st = guide.status();
      const known = knownLiveChannels().length;
      return json(res, 200, {
        ...st,
        /* Whole, not redacted.
         *
         * This is a form field, and what comes out of it goes back in. Sending
         * the redacted spelling — host, "…", last segment — meant the
         * catalogue tick boxes never matched so nothing looked chosen, and a
         * second Save wrote `https://host/…/epg_ripper_US1.xml.gz` into the
         * config as if it were an address. The feeds then 404 and the guide
         * quietly empties. Redaction belongs on the labels in `lastRun`, which
         * are for reading, not for round-tripping. */
        sources: guideSources(cfg),
        useProviderGuide: cfg?.useProviderGuide !== false,
        guideCountry: cfg?.guideCountry === undefined ? 'us' : cfg.guideCountry,
        hasProviderGuide: Boolean(providerGuideUrl(cfg)),
        known,
        blocked: known || st.covered ? null : 'no-channels',
        catalogue: GUIDE_CATALOGUE,
      });
    }

    if (req.method === 'POST') {
      if (!cfg) return json(res, 400, { error: 'Connect a provider first.' });
      let incoming;
      try {
        incoming = JSON.parse(await collectRequestBody(req));
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }

      if (Array.isArray(incoming.urls)) {
        const urls = incoming.urls
          .map((u) => String(u || '').trim())
          .filter(Boolean)
          .slice(0, 12);
        for (const u of urls) {
          if (!/^https?:\/\//i.test(u)) {
            return json(res, 400, { error: `That is not a web address: ${u}` });
          }
          const bad = privateAddress(u);
          if (bad) return json(res, 400, { error: bad });
        }
        cfg.epgUrls = urls;
        // The single legacy field has been folded into the list; leaving it
        // set would resurrect a removed feed on the next read.
        delete cfg.epgUrl;
      }
      if (incoming.useProviderGuide !== undefined) {
        cfg.useProviderGuide = Boolean(incoming.useProviderGuide);
      }
      if (incoming.country !== undefined) {
        cfg.guideCountry = String(incoming.country || '').trim().toLowerCase().slice(0, 2);
      }
      writeConfig(cfg);
      guide.setSources(guideSources(cfg));

      // Refreshing takes minutes on a big feed, so the answer does not wait
      // for it. The screen polls this endpoint and watches `running`.
      const known = knownLiveChannels().length;
      if (incoming.refresh !== false && known) refreshGuide({ force: true });
      return json(res, 200, {
        ...guide.status(),
        sources: guideSources(cfg),
        useProviderGuide: cfg.useProviderGuide !== false,
        known,
        blocked: known ? null : 'no-channels',
      });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ---- Xtream passthrough ---- */
  if (pathname === '/api/xtream') {
    if (mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });
    const params = {};
    for (const [k, v] of query.entries()) {
      if (k !== 'username' && k !== 'password') params[k] = v;
    }
    try {
      const upstream = await request(xtreamApiUrl(providers.forMeta(cfg) || cfg, params));
      const body = (await readBody(upstream)).toString('utf8');
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return json(res, 502, { error: 'Provider returned malformed JSON.' });
      }
      if (params.action === 'get_short_epg' && Array.isArray(data.epg_listings)) {
        data.epg_listings = data.epg_listings.map(decodeEpg);
      }
      /* Every film anybody opens teaches the credits index for free — the
         call has already been paid for, and this is the only place the cast
         and the director ever pass through the box. */
      if (params.action === 'get_vod_info' && data && data.info) {
        /* Studios out before anybody sees them, index and card alike.
         *
         * This provider writes the production companies into `director` on a
         * good many films — Analyze This lists four, and the page put every
         * one of them up as a director with its initials in a circle. Doing
         * it here rather than on the page means the credits index gets the
         * same clean list, which matters more than the display does: a
         * shared director is the strongest signal the recommender has, so an
         * index that believes Warner Bros. Pictures directed nine hundred
         * films quietly ties all nine hundred together. */
        const clean = (raw) => String(raw || '')
          .split(/[,/|]/)
          .map((s) => s.trim())
          .filter((s) => s && !people.isCompany(s))
          .join(', ');
        if (data.info.director) data.info.director = clean(data.info.director);
        if (data.info.cast) data.info.cast = clean(data.info.cast);
        if (data.info.actors) data.info.actors = clean(data.info.actors);
        people.note(params.vod_id, data.info);
      }
      return json(res, 200, data);
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* ---- M3U playlist ---- */
  if (pathname === '/api/playlist') {
    if (mode !== 'm3u') return json(res, 400, { error: 'Not in M3U mode' });
    try {
      const upstream = await request(cfg.playlistUrl);
      const text = (await readBody(upstream, 32 * 1024 * 1024)).toString('utf8');
      const buckets = bucketM3U(parseM3U(text, upstream.finalUrl || cfg.playlistUrl));
      for (const kind of Object.keys(buckets)) {
        buckets[kind] = buckets[kind].map((item) => ({
          ...item,
          streamUrl: proxyPath(item.url),
          logo: item.logo ? `/img?u=${encodeURIComponent(item.logo)}` : '',
        }));
      }
      return json(res, 200, buckets);
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* ---- Filtered, compact library for one section ---- */
  if (pathname === '/api/library') {
    const tab = query.get('tab');
    if (!LIBRARY_ACTIONS[tab]) return json(res, 400, { error: 'Unknown tab' });
    if (mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });

    const prefs = readPrefs();
    /* `all=1` sets the filter aside for this one request without touching
     * what is stored. The Settings switch is a decision about the whole
     * library — flip it and every page reloads from nothing — which is far
     * too much to ask of somebody who only wants to find one foreign film
     * they know the name of. This is that search, and nothing else.
     *
     * The cache key already carries the pattern, so the wide catalogue gets
     * its own entry and neither copy evicts the other. */
    const pattern = (prefs.filtersEnabled && !query.get('all')) ? prefs.filters[tab] : '';
    // Bump LIBRARY_SHAPE whenever projectItem changes, so a cache written by
    // an older build is ignored rather than served without the new fields.
    const cacheKey = `v${LIBRARY_SHAPE}:${tab}:${pattern}`;
    const hit = libraryCache.get(cacheKey);
    const fresh = hit && Date.now() - hit.at < LIBRARY_TTL;

    if (!query.get('refresh') && fresh) {
      return json(res, 200, { ...hit.payload, cached: true });
    }

    // Stale-while-revalidate: an expired entry is still last night's catalogue,
    // which beats a 15-second blank grid. Serve it now, refresh behind it.
    if (!query.get('refresh') && hit) {
      rebuildLibrary(cfg, tab, pattern, cacheKey);
      return json(res, 200, { ...hit.payload, cached: true, stale: true });
    }

    try {
      const payload = await rebuildLibrary(cfg, tab, pattern, cacheKey);
      return json(res, 200, { ...payload, cached: false });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* ---- Remux a non-native container into HLS ---- */
  if (pathname === '/api/remux') {
    if (!hasFfmpeg()) {
      return json(res, 501, {
        error:
          'ffmpeg is not installed, so .mkv files cannot be converted. Install it with: brew install ffmpeg',
      });
    }

    const downloadId = query.get('download');
    let input;
    let fromProvider = true;
    let subKey = '';

    if (downloadId) {
      // Local file: no provider connection burned, and much faster.
      const job = downloads.get(downloadId);
      if (!job || job.status !== 'done') return json(res, 404, { error: 'No such download' });
      input = path.join(DOWNLOAD_DIR, job.file);
      fromProvider = false;
      subKey = `dl:${downloadId}`;
    } else {
      const kind = query.get('kind');
      const id = query.get('id');
      const ext = query.get('ext') || 'mkv';
      if (!kind || !id) return json(res, 400, { error: 'kind and id are required' });
      if (mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });
      /* Whichever login has room, not always the first one. A converted film
         holds a connection for as long as ffmpeg is pulling it, so sending
         every one of them down account #1 is how two logins still behave like
         one. startRemux reads the choice back out of the URL and holds the
         slot for the life of the conversion. */
      const chosen = providers.pick(cfg, { reserve: true }) || cfg;
      input = buildStreamUrl(chosen, kind === 'series' ? 'series' : 'movie', id, ext);
      // Keyed on what identifies the title, never on the URL that carries the
      // account password.
      subKey = `${kind}:${id}:${ext}`;
    }

    try {
      const probed = await probeTitle(input, subKey);
      const session = await startRemux(input, {
        fromProvider,
        // The probe has already read the source; taking its codec here means
        // startRemux does not go and read it a second time.
        videoCodec: (query.get('vcodec') || '').toLowerCase() || probed.codec,
        startSeconds: Math.max(0, Number(query.get('start') || 0)),
        audioDelayMs: Number(query.get('adelay') || 0),
        sourceDuration: probed.duration,
        subs: probed.subs,
        // Which session this one supersedes — a seek replacing its own
        // conversion, or a cell replacing what it was showing. Named by the
        // caller because only the caller knows; everything else that happens
        // to be running belongs to somebody else's screen.
        replaces: query.get('replaces') || '',
        // Shrink it on the way out, for a viewer whose Wi-Fi cannot carry
        // the real thing.
        low: query.get('low') === '1',
      });
      return json(res, 200, {
        url: `/hls/${session.id}/index.m3u8`,
        format: 'm3u8',
        session: session.id,
        prebuffer: session.prebuffer,
        offset: session.offset,
        sourceDuration: session.sourceDuration,
        subs: session.subs.map((sub) => ({
          lang: sub.lang,
          label: subtitleLabel(sub),
          url: `/hls/${session.id}/${sub.file}`,
        })),
      });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* How far a Save to device has got. The page cannot see the browser's own
     download, so it watches what the box is sending instead. */
  if (pathname === '/api/save-progress') {
    const t = saveTransfers.get(query.get('id') || '');
    if (!t) return json(res, 404, { error: 'No such transfer' });
    const elapsed = Math.max(0.001, ((t.endedAt || Date.now()) - t.startedAt) / 1000);
    return json(res, 200, {
      id: t.id,
      name: t.name,
      total: t.total,
      sent: t.sent,
      bytesPerSec: t.sent / elapsed,
      // Ended means the connection closed — finished if everything went, and
      // stopped part-way if it did not.
      done: t.total > 0 && t.sent >= t.total,
      ended: Boolean(t.endedAt),
      // How long since anything last moved. A browser that fetches in
      // ranges — which is what Safari does with a large file — closes one
      // connection and opens the next, so `ended` on its own is a normal
      // moment mid-download and must never be read as "it stopped". Only
      // ended AND quiet for a while means that.
      idleMs: Date.now() - t.at,
      stalled: !t.endedAt && Date.now() - t.at > 15000,
    });
  }

  if (pathname === '/api/remux/status') {
    const session = remuxSessions.get(query.get('id'));
    if (!session) return json(res, 404, { error: 'Session expired' });
    session.lastAccess = Date.now();
    const { seconds, complete } = remuxReadySeconds(session);
    return json(res, 200, {
      seconds,
      complete,
      target: session.prebuffer,
      failed: Boolean(session.exited && session.exitCode !== 0 && !complete),
      error: session.exited && session.exitCode !== 0 ? session.stderr().split('\n').pop() : '',
    });
  }

  if (pathname === '/api/remux/probe') {
    const session = remuxSessions.get(query.get('id'));
    if (!session) return json(res, 404, { error: 'Session expired' });
    if (!hasFfmpeg()) return json(res, 501, { error: 'ffprobe is not installed' });
    const { seconds, complete } = remuxReadySeconds(session);
    const probe = await probeOutput(session);
    return json(res, 200, {
      session: session.id,
      offset: session.offset,
      exited: Boolean(session.exited),
      exitCode: session.exitCode ?? null,
      lastError: session.exited && session.exitCode !== 0
        ? redactUrl(session.stderr().split('\n').pop()) : '',
      declaredSeconds: seconds,
      complete,
      // ffmpeg's own reading of the source, straight from its header. The only
      // view of the provider's audio that costs nothing to obtain.
      input: redactUrl(session.stderrHead() || '')
        .split('\n')
        .filter((line) => /^\s*(Input #0|Stream #0:|Output #0)/.test(line))
        .map((line) => line.trim())
        .slice(0, 8),
      args: session.args,
      ...probe,
    });
  }

  if (pathname === '/api/remux/stop') {
    // Conversions only. Live ingests are shared across viewers and reap
    // themselves when nobody fetches; one cell giving up on a film must not
    // cut the channel playing next to it.
    //
    // With an id, only that session stops. Without one it is still the old
    // blanket sweep, because the player closing really does mean "nothing I
    // started is wanted any more" — but a multiview cell closing means only
    // itself, and unqualified it was stopping every other cell's conversion
    // as well. That is half of why a cell would die minutes later.
    const only = query.get('id');
    if (only) {
      const sess = remuxSessions.get(only);
      if (sess && !sess.live) killSession(only);
      return json(res, 200, { stopped: true, id: only });
    }
    for (const [id, sess] of [...remuxSessions]) if (!sess.live) killSession(id);
    return json(res, 200, { stopped: true });
  }

  /* ---- The archive drive ---- */

  if (pathname.startsWith('/api/archive/')) {
    // Same honesty as the reports gate: the box is unauthenticated by design,
    // so this is not a security boundary and is not dressed as one. The
    // archive is Hunter's drive; the tab is hidden from every other profile,
    // and this keeps the API from quietly working anyway.
    if (!isOwnerProfile(ownerOf(query.get('profileId')))) {
      return json(res, 403, { error: 'The archive is only available on the owner profile.' });
    }
  }

  if (pathname === '/api/archive/status') {
    return json(res, 200, archive.status());
  }

  if (pathname === '/api/archive/browse') {
    return json(res, 200, archive.browse({
      dir: query.get('dir') || '',
      page: Math.max(0, Number(query.get('page') || 0)),
    }));
  }

  if (pathname === '/api/archive/search') {
    return json(res, 200, archive.search(query.get('q')));
  }

  if (pathname === '/api/archive/recent') {
    return json(res, 200, { items: archive.recent(Number(query.get('limit') || 60)) });
  }

  /* A frame from a quarter of the way in, as the card's artwork.
   *
   * Made lazily on first request and cached forever on the SD card — the
   * drive is mounted read-only, so the cache cannot live there. A scroll can
   * ask for thirty at once, so at most two ffmpegs run and the rest wait
   * their turn; a second request for a thumbnail already being made joins
   * the in-flight one instead of spawning a twin. Deterministic (25% of the
   * runtime, not random) so the cache is stable and a card never changes
   * its face between visits. */
  if (pathname === '/api/archive/thumb') {
    const rel = query.get('path');
    const item = archive.entry(rel);
    if (!item) return json(res, 404, { error: 'Not in the archive index' });

    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const file = path.join(THUMB_DIR,
      `${crypto.createHash('sha1').update(rel).digest('hex')}.jpg`);
    if (!fs.existsSync(file)) {
      if (!archive.mounted()) return json(res, 503, { error: 'Drive not mounted' });
      const abs = archive.resolve(rel);
      if (!abs || !fs.existsSync(abs)) return json(res, 404, { error: 'Missing on disk' });
      if (!hasFfmpeg()) return json(res, 501, { error: 'ffmpeg is not installed' });
      try {
        await makeArchiveThumb(rel, abs, item, file);
      } catch (err) {
        return json(res, 500, { error: redactUrl(err.message) });
      }
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      // The frame never changes — the file it came from is an archive.
      'cache-control': 'public, max-age=604800, immutable',
    });
    return res.end(body);
  }

  /* Decide how one archive file gets on screen, and start it.
   *
   * Direct play is the fast path and covers most of the drive: the browser
   * fetches byte ranges straight off the disk, so playback starts as soon as
   * the first range lands and seeking is free. Everything else goes through
   * the same HLS machinery the provider streams use — including the encode
   * branch in ffmpegArgs for the codecs no browser decodes. */
  if (pathname === '/api/archive/play') {
    const rel = query.get('path');
    const item = archive.entry(rel);
    if (!item) return json(res, 404, { error: 'Not in the archive index' });

    if (!archive.mounted()) {
      return json(res, 503, {
        error: 'The archive drive is not mounted. Check that it is plugged in and powered.',
      });
    }

    const abs = archive.resolve(rel);
    if (!abs) return json(res, 403, { error: 'Refused' });
    if (!fs.existsSync(abs)) {
      return json(res, 404, {
        error: 'Indexed, but missing on disk. Re-run the scanner if the drive changed.',
      });
    }

    // Shrink it on the way out, when the viewer's link cannot carry the real
    // thing. This is also the one case where a browser-native file is NOT
    // handed over as it stands: the whole point is that the file as it
    // stands is too big for the link.
    const low = query.get('low') === '1';

    // Resuming does not change the decision: the file is served over ranges,
    // so the browser seeks to the resume point itself. Sending it through
    // ffmpeg to start at an offset would be slower and produce a worse
    // scrubber than the native one.
    // With no ffmpeg there is nothing to shrink it with, and a file that
    // plays as it stands is better than an error about one that would have
    // been smaller.
    if (item.playback === 'direct' && (!low || !hasFfmpeg())) {
      return json(res, 200, {
        mode: 'direct',
        url: `/archive/file?path=${encodeURIComponent(rel)}`,
        sourceDuration: item.duration || 0,
      });
    }

    if (!hasFfmpeg()) {
      return json(res, 501, {
        error: `${(item.container || '').toUpperCase()} needs ffmpeg to play, and ffmpeg is not installed.`,
      });
    }

    // THE WHOLE EPISODE, EVERY TIME. This endpoint used to start the
    // conversion at the resume point, and a season of lip-sync faults traces
    // back to exactly that: on these decades-old rips, any way of asking
    // ffmpeg to begin mid-file — demuxer seek, sequential read-and-discard,
    // content-clock rebuild — lands the two tracks apart in some file
    // eventually. Playing from the top has never once drifted. So the top is
    // the only place a conversion is allowed to begin: one session per file,
    // keyed by the file, converting start to finish, and the PLAYER seeks
    // within the growing output to reach a resume point. A second request for
    // the same file — a resume, a seek past the frontier, a reopen — joins
    // the session already running rather than starting a rival.
    // The small version is a different conversion of the same file, so it
    // gets its own name — otherwise one viewer's cached full-size episode
    // would be handed to somebody who asked for the small one.
    const sessionKey = `arc-${low ? 'lo-' : ''}`
      + crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);
    const asResponse = (session) => ({
      mode: 'hls',
      url: `/hls/${session.id}/index.m3u8`,
      format: 'm3u8',
      session: session.id,
      prebuffer: session.prebuffer,
      offset: 0,
      // The index knows the real duration; a transcode session does not,
      // so the scrubber would otherwise show only what has been encoded.
      sourceDuration: item.duration || session.sourceDuration || 0,
      transcoding: item.playback === 'transcode',
      subs: (session.subs || []).map((sub) => ({
        lang: sub.lang,
        label: subtitleLabel(sub),
        url: `/hls/${session.id}/${sub.file}`,
      })),
    });

    const running = remuxSessions.get(sessionKey);
    if (running && !(running.exited && running.exitCode !== 0)) {
      running.lastAccess = Date.now();
      return json(res, 200, asResponse(running));
    }
    if (running) killSession(sessionKey);

    // Already converted, in this sitting or any earlier one? killSession
    // keeps a FINISHED conversion's directory on disk precisely for this
    // moment: the episode is resurrected as a session and the resume is
    // instant — no ffmpeg, no wait, across server restarts too.
    const cachedDir = path.join(HLS_DIR, sessionKey);
    try {
      const playlist = fs.readFileSync(path.join(cachedDir, 'index.m3u8'), 'utf8');
      if (playlist.includes('#EXT-X-ENDLIST')) {
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(path.join(cachedDir, 'meta.json'), 'utf8'));
        } catch {
          /* the playlist is the cache; the meta is a bonus */
        }
        const now = new Date();
        try {
          fs.utimesSync(cachedDir, now, now);   // freshly watched = last pruned
        } catch {
          /* best effort */
        }
        const session = {
          id: sessionKey,
          dir: cachedDir,
          proc: { kill() {} },
          exited: true,
          exitCode: 0,
          lastAccess: Date.now(),
          fromProvider: false,
          offset: 0,
          sourceDuration: meta.sourceDuration || item.duration || 0,
          prebuffer: readPrefs().prebufferSeconds || DEFAULT_PREBUFFER,
          stderr: () => '',
          stderrHead: () => '',
          args: 'served from the finished-conversion cache',
          subs: meta.subs || [],
        };
        remuxSessions.set(sessionKey, session);
        return json(res, 200, asResponse(session));
      }
      // An unfinished directory with no session behind it is a crash
      // leftover whose frontier will never move; clear it and convert anew.
      fs.rmSync(cachedDir, { recursive: true, force: true });
    } catch {
      /* nothing cached — convert */
    }

    try {
      // The conversion about to start will write on the order of the source
      // file's size. Make room FIRST — evicting old episodes down to a floor
      // of the space reserve plus the expected output — because an ENOSPC
      // halfway through a two-hour transcode wastes the whole run and, far
      // worse, crowds the card every other feature lives on. If the cache is
      // already empty and space is still short, the conversion is allowed to
      // try: it fails with a plain error rather than being refused on a
      // guess.
      pruneArchiveCache(SPACE_RESERVE + Math.max(2 * 1024 ** 3, item.size || 0));
      const session = await startRemux(abs, {
        fromProvider: false,
        videoCodec: item.vcodec || '',
        // From zero, unconditionally. Never reintroduce a start offset here:
        // it is the fault the whole design above exists to remove.
        startSeconds: 0,
        // Not seeking, but 'demux' also selects the content clock — audio
        // timestamps rebuilt from the samples themselves — which is the
        // arrangement the from-the-top path has always held sync with.
        seekMode: 'demux',
        sourceDuration: item.duration || 0,
        id: sessionKey,
        low,
      });
      // What the cache cannot recover from the files alone, written beside
      // them: the true runtime and the subtitle listing.
      try {
        fs.writeFileSync(path.join(session.dir, 'meta.json'), JSON.stringify({
          sourceDuration: item.duration || session.sourceDuration || 0,
          subs: session.subs || [],
        }));
      } catch {
        /* best effort */
      }
      // With the new conversion underway, make room by letting the oldest
      // finished episodes go if the cache has outgrown its allowance.
      pruneArchiveCache();
      return json(res, 200, asResponse(session));
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* ---- Resolve a playable, proxied URL ---- */
  if (pathname === '/api/play') {
    const kind = query.get('kind');
    const id = query.get('id');
    const ext = query.get('ext') || '';
    if (!kind || !id) return json(res, 400, { error: 'kind and id are required' });
    if (!cfg || cfg.mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });
    try {
      // A live HLS channel goes through the Pi's own DVR window when it can:
      // ~2 minutes of local playlist instead of the provider's ~60 seconds,
      // which is what stops segments expiring under a slow viewer. Any
      // failure — no ffmpeg, a dead feed, a timeout, no free slot — falls
      // back to the direct proxy, which is exactly what this endpoint always
      // returned.
      //
      // Tried BEFORE reserving a proxy slot: the reservation used to be taken
      // first, so ensureLiveDvr's pick() saw the only login as full, started
      // ffmpeg on cfg credentials without take(), and left the reservation
      // to expire while the ingest was already using the connection.
      // On a weak link the channel goes through the DVR whatever the
      // preferred format is — the shrunk feed only exists there, and the
      // direct TS proxy hands over the provider's full-size stream, which is
      // the thing that cannot get through.
      const lowWanted = query.get('low') === '1';
      const format = ext || cfg.preferredFormat;
      if (kind === 'live' && (format === 'm3u8' || lowWanted)
          && hasFfmpeg() && /^[\w-]+$/.test(id)) {
        try {
          const session = await ensureLiveDvr(cfg, id, lowWanted);
          return json(res, 200, {
            url: `/hls/${session.id}/index.m3u8`, format: 'm3u8', dvr: true,
            low: lowWanted,
          });
        } catch {
          /* direct proxy below */
        }
      }

      /* Which login opens this. The choice is reserved for a few seconds
         because the URL is built here and the pipe opens in the NEXT request:
         without it, two things started together would both be told to use the
         same free account and one of them would be refused. */
      const chosen = providers.pick(cfg, { reserve: true });
      /* Option B, and the only place it is visible.
       *
       * A box with nothing free is the ordinary state of a single-login
       * account and always has been — the request goes out anyway and the
       * provider decides. The one case worth REFUSING is a recording holding
       * the last connection, because that is the only thing taking it that
       * nobody in the room started and nobody can see. So say what is
       * running, until when, and hand back its id: the screen turns that into
       * one press that stops it. */
      if (!chosen) {
        const held = recordings.blocking();
        if (held) {
          return json(res, 503, {
            error: `Recording ${held.title} on ${held.channelName}.`,
            recording: held,
          });
        }
      }
      const direct = buildStreamUrl(chosen || cfg, kind, id, ext);
      let url = proxyPath(direct);

      // How an MPEG-TS channel is opened. One setting, not a choice.
      //
      // drain = seconds spent swallowing the provider's opening backlog, which
      //         is what otherwise leaves you half a minute behind.
      // hold  = seconds of jitter buffer banked before playback starts, which
      //         is what absorbs this provider's lumpy 4-5s delivery.
      //
      // These are the figures the old "balanced" mode used, and they are here
      // because they are the ones that measured zero stalls and zero seeks —
      // the other two modes each gave up one of the two things a viewer wants.
      const LIVE_TS = { drain: 12, hold: 4 };
      if (kind === 'live' && format === 'ts') {
        url += `&drain=${LIVE_TS.drain}&hold=${LIVE_TS.hold}`;
      }
      return json(res, 200, { url, format });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  return json(res, 404, { error: 'Unknown endpoint' });
}

/** Serve playlists and segments out of an active remux session's directory. */
function serveRemux(req, res, pathname) {
  const match = /^\/hls\/([\w-]+)\/([\w.-]+)$/.exec(pathname);
  if (!match) return send(res, 404, 'Not found');

  const session = remuxSessions.get(match[1]);
  if (!session) return send(res, 404, 'Session expired');
  session.lastAccess = Date.now();

  const file = path.join(session.dir, match[2]);
  if (!file.startsWith(session.dir)) return send(res, 403, 'Forbidden');

  fs.readFile(file, (err, body) => {
    if (err) return send(res, 404, 'Not found');
    const isPlaylist = file.endsWith('.m3u8');
    let data = body;

    // Without #EXT-X-ENDLIST a player classifies the playlist as LIVE and
    // chases its "live edge" — here the conversion frontier, which runs well
    // ahead of realtime. The playhead gets dragged forward and re-buffered,
    // which is what surfaces as the video playing at the wrong speed.
    //
    // ffmpeg only writes the end marker when it exits, and it can be killed or
    // reaped before that. Once the process is gone the file is final, so close
    // the playlist ourselves and relabel it VOD. While it is genuinely still
    // being written we leave EVENT alone, so the player keeps reloading and
    // picking up new segments.
    if (isPlaylist) {
      let text = data.toString('utf8');

      // ffmpeg derives TARGETDURATION from the requested segment length, but a
      // stream copy can only cut on existing keyframes — with HEVC's long GOPs
      // that yields segments longer than the declared target. The spec requires
      // TARGETDURATION to be at least the longest segment, and players schedule
      // their loading against it, so correct it to what was actually written.
      const longest = Math.max(
        0,
        ...[...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]) || 0)
      );
      const declared = Number((/#EXT-X-TARGETDURATION:(\d+)/.exec(text) || [])[1] || 0);
      if (longest > declared) {
        text = text.replace(
          /#EXT-X-TARGETDURATION:\d+/,
          `#EXT-X-TARGETDURATION:${Math.ceil(longest)}`
        );
      }

      // A live playlist must never carry ENDLIST, and refraining from adding
      // one is only half of that: ffmpeg WRITES one itself when its input
      // runs dry and it exits. A viewer who sees it reclassifies the stream
      // as finished and stops polling the playlist — so when the ingest
      // respawns two seconds later, nobody is listening, and a measured
      // session sat frozen at the 90-second mark of a live game. Strip it.
      if (session.live) {
        text = text.replace(/#EXT-X-ENDLIST\s*/g, '');
        // Every live playlist that goes out is watched on the way past, so
        // "it jumped backwards" has a record of the moment it did.
        watchLivePlaylist(session, text);
      }
      if (session.exited && !session.live) {
        if (!text.includes('#EXT-X-ENDLIST')) text = `${text.trimEnd()}\n#EXT-X-ENDLIST\n`;
        text = text.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
      }

      data = Buffer.from(text, 'utf8');
    }

    // fMP4 output produces init.mp4 + .m4s segments; TS output produces .ts.
    const isVtt = file.endsWith('.vtt');
    const type = isPlaylist
      ? 'application/vnd.apple.mpegurl'
      : isVtt
        ? 'text/vtt; charset=utf-8'
        : /\.(mp4|m4s)$/.test(file)
          ? 'video/mp4'
          : 'video/mp2t';
    res.writeHead(200, {
      'content-type': type,
      // A subtitle file grows while the conversion runs, exactly as the
      // playlist does, so it must not be cached as though it were finished.
      'cache-control': isPlaylist || isVtt ? 'no-store' : 'public, max-age=3600',
      'access-control-allow-origin': '*',
    });
    res.end(data);
  });
}

/* ----------------------------------------------------------------- statics */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (statErr, stat) => {
    // A directory is served by its index.html, so /tv/ reaches the Shield app
    // the way a URL typed on a television is actually typed. One level only:
    // the retry lands on a file or on the 404 below.
    if (!statErr && stat.isDirectory()) {
      return serveStatic(req, res, `${pathname.replace(/\/+$/, '')}/index.html`);
    }
    if (statErr || !stat.isFile()) return send(res, 404, 'Not found');

    // `no-cache` alone tells the browser to revalidate but gives it nothing to
    // revalidate against, so it can sit on a stale app.js indefinitely — which
    // shows up as the UI running code that no longer exists on disk. Send real
    // validators so a changed file is always picked up, and an unchanged one
    // still costs nothing.
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();

    const freshEtag = req.headers['if-none-match'];
    const freshSince = req.headers['if-modified-since'];
    if (freshEtag === etag || (!freshEtag && freshSince === lastModified)) {
      res.writeHead(304, { etag, 'last-modified': lastModified, 'cache-control': 'no-cache' });
      return res.end();
    }

    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        etag,
        'last-modified': lastModified,
      });
      res.end(data);
    });
  });
}

/* -------------------------------------------------------------------- main */

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = parsed;

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, searchParams);
    if (pathname.startsWith('/hls/')) return serveRemux(req, res, pathname);
    if (pathname === '/archive/file') {
      // resolve() is the security boundary: traversal, absolute paths, and
      // anything not in the index all come back null.
      const rel = searchParams.get('path');
      const abs = archive.resolve(rel);
      if (!abs) return send(res, 404, 'Not found');
      // `save=1` is the same bytes with a filename on them, which is what
      // turns a stream into a file in Downloads or Files. Only offered for
      // containers a phone actually opens — everything else is converted
      // first, through the downloads queue.
      let attachmentName = null;
      if (searchParams.get('save')) {
        const entry = archive.entry(rel) || {};
        const ext = String(entry.container || path.extname(abs).replace('.', '') || 'mp4');
        attachmentName = `${entry.title || path.basename(abs, path.extname(abs))}.${ext}`;
        // Saving is a transfer off the box like any other; a restart in the
        // middle of it would cut the file in half.
        localPlaybackAt = Date.now();
      }
      return serveLocalFile(req, res, abs, {
        attachmentName,
        track: searchParams.get('save') ? (searchParams.get('track') || '') : '',
      });
    }
    if (pathname === '/stream') return await handleStream(req, res, searchParams);
    if (pathname === '/img') return await handleImage(req, res, searchParams);
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

loadDownloads();
sweepScratch();
recoverOrphanedDownloads();
reportDiskSpace();
loadLibraryCache();
archive.configure({ root: ARCHIVE_ROOT, indexPath: ARCHIVE_INDEX });
guide.configure({ dir: ROOT, log: (line) => console.log(`  ${line}`), guard: privateAddress });
people.load(PEOPLE_PATH, (line) => console.log(`  ${line}`));
recordings.load(RECORDINGS_DIR, (line) => console.log(`  ${line}`));

/* The scheduler.
 *
 * Everything it does is decided from the clock and the rows rather than from
 * a timer having fired at the right moment — so a box that was asleep, or
 * restarting, or busy, catches up on the next pass instead of silently
 * missing a programme. A recording that is genuinely too late to start says
 * so rather than sitting as "scheduled" for ever. */
setInterval(() => {
  try {
    recordings.tick(Date.now(), { begin: beginRecording });
  } catch (err) {
    console.error(`  recordings: scheduler stumbled — ${err.message}`);
  }
}, recordings.TICK_MS).unref?.();

/* Filling in who is in what, slowly, while nobody is using the connection.
   Five minutes after boot so the library is cached first — there is nothing
   to crawl until the box knows what films exist. */
setTimeout(() => {
  setInterval(() => { crawlCredits().catch(() => {}); }, CREDIT_CRAWL_MS).unref?.();
}, 5 * 60 * 1000).unref?.();

/* The guide, kept current in the background.
 *
 * Half an hour after boot, then hourly — and the module itself decides
 * whether anything is actually due, which is once every six hours. The delay
 * matters: a box that has just started is busy loading the library and
 * recovering downloads, and scanning a few hundred megabytes of XML on top of
 * that is how a Pi ends up thrashing before anyone has pressed anything. */
/* Half an hour when there is an index to fall back on; two minutes when there
 * is not. A box with no listings at all — a new one, or one whose index was
 * thrown away because the matching rules changed under it — should not sit
 * blank for half an hour to spare a load it is not carrying yet. */
setTimeout(() => {
  refreshGuide();
  setInterval(() => refreshGuide(), 60 * 60 * 1000).unref?.();
}, (guide.status().covered ? 30 : 2) * 60 * 1000).unref?.();

// Downloads from before the browser-native conversion existed are still .mkv;
// bring them up to date so their playback stops depending on HLS sessions.
setTimeout(() => {
  for (const job of downloads.values()) {
    if (job.status === 'done' && !NATIVE_CONTAINERS.has(String(job.ext || '').toLowerCase())) {
      queuePrepare(job);
    }
  }
}, 5000).unref?.();

server.listen(PORT, HOST, () => {
  const configured = readConfig() ? 'configured' : 'awaiting setup';
  const paused = [...downloads.values()].filter((j) => j.status === 'paused').length;
  console.log(`\n  IPTV Portal  →  http://${HOST}:${PORT}   (${configured})`);
  if (paused) console.log(`  ${paused} download(s) paused by the last shutdown — resume from the Downloads tab.`);

  const arc = archive.status();
  if (arc.error) {
    console.log(`  Archive: ${arc.error}`);
  } else {
    console.log(
      `  Archive: ${arc.indexed} files indexed at ${arc.root} `
        + `(${arc.mounted ? 'mounted' : 'NOT MOUNTED'}) — `
        + `${arc.counts.direct || 0} direct, ${arc.counts.remux || 0} remux, `
        + `${arc.counts.transcode || 0} transcode`
    );
  }
  console.log('');
});
