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
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PREFS_PATH = path.join(ROOT, 'prefs.json');
const PROFILES_PATH = path.join(ROOT, 'profiles.json');
const HLS_DIR = path.join(ROOT, 'hls');
/** Containers a browser will open directly. Anything else needs remuxing. */
const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'mov']);
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');
const DOWNLOAD_INDEX = path.join(DOWNLOAD_DIR, 'index.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIME = {
  '.mp4': 'video/mp4',
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

const SPACE_RESERVE = 2 * 1024 * 1024 * 1024; // keep 2 GB for the OS and state

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
  writeJsonAtomic(CONFIG_PATH, cfg, { mode: 0o600 });
  // `mode` only applies when the file is created; re-assert it on overwrite.
  fs.chmodSync(CONFIG_PATH, 0o600);
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
      liveLatency: parsed.liveLatency || 'balanced',
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
    liveLatency: 'balanced',
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
 * the password gates creating and deleting a profile, but switching between
 * existing ones is open, exactly like a TV app. The server has no auth of its
 * own, so the network it sits on is the real perimeter.
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
  return data;
}

function writeProfiles(data) {
  writeJsonAtomic(PROFILES_PATH, data, { mode: 0o600 });
  try {
    fs.chmodSync(PROFILES_PATH, 0o600);
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

/** Strip the password before anything goes over the wire to the browser. */
function publicConfig(cfg) {
  if (!cfg) return { configured: false };
  return {
    configured: true,
    mode: cfg.mode,
    host: cfg.host || '',
    username: cfg.username || '',
    playlistUrl: cfg.playlistUrl || '',
    epgUrl: cfg.epgUrl || '',
    preferredFormat: cfg.preferredFormat || 'm3u8',
  };
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
          const next = new URL(loc, u).toString();
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

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
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
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
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

  return {
    disk: {
      free: Number.isFinite(free) ? free : null,
      total: diskTotal,
      reserve: SPACE_RESERVE,
      low: Number.isFinite(free) && free < SPACE_RESERVE,
    },
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
    now: Date.now(),
  };
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
  return buildStreamUrl(cfg, job.kind === 'series' ? 'series' : 'movie', job.streamId, job.ext);
}

async function runJob(job) {
  const { part, final } = jobPaths(job);
  const start = partSize(job);

  job.status = 'downloading';
  job.error = '';
  job.bytes = start;
  persistDownloads();

  const headers = {};
  if (start > 0) headers.range = `bytes=${start}-`;

  const upstream = await request(jobSourceUrl(job), { headers, timeout: 60000 });
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
let lastProviderActiveAt = 0;
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

function providerBusy() {
  // A finished remux (ffmpeg exited) plays from disk and holds nothing.
  const remuxing = [...remuxSessions.values()].some((s) => s.fromProvider && !s.exited);
  const busy = providerStreams > 0 || remuxing;
  if (busy) lastProviderActiveAt = Date.now();
  return busy;
}

/** Called the moment a stream starts; puts the running download on ice. */
function autoPauseActiveDownload() {
  const job = activeJob;
  if (!job || job.status !== 'downloading') return;
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

/** Bring auto-paused work back once the connection has stayed quiet. */
setInterval(() => {
  if (providerBusy()) return;
  if (Date.now() - lastProviderActiveAt < RESUME_GRACE_MS) return;
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
      if (providerBusy() || Date.now() - lastProviderActiveAt < RESUME_GRACE_MS) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const id = queue.shift();
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

/** Serve a completed download from disk, with Range support for seeking. */
function serveLocalFile(req, res, filePath, { attachmentName } = {}) {
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
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  headers['content-length'] = stat.size;
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
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
function probeOutput(session) {
  // Probed per segment, deliberately, rather than by handing ffprobe the
  // playlist. Asked about an HLS playlist ffprobe reports the duration the
  // playlist *claims* — it adds up the EXTINF lines — so the two sides of the
  // comparison would come from the same source and the check could never fail.
  // A segment file is the content itself, timestamps and all.
  let target;
  let declared = 0;
  let total = 0;
  try {
    const text = fs.readFileSync(path.join(session.dir, 'index.m3u8'), 'utf8');
    const segments = [];
    let pending = 0;
    for (const line of text.split('\n')) {
      const inf = /^#EXTINF:([\d.]+)/.exec(line.trim());
      if (inf) {
        pending = Number(inf[1]) || 0;
        total += pending;
        continue;
      }
      const name = line.trim();
      if (name && !name.startsWith('#')) segments.push({ name, declared: pending });
    }
    // The newest is very likely still being written, so take the one behind it.
    const pick = segments[segments.length - (segments.length > 1 ? 2 : 1)];
    if (!pick) return Promise.resolve({ error: 'nothing written yet' });
    declared = pick.declared;
    target = path.join(session.dir, pick.name);
  } catch (err) {
    return Promise.resolve({ error: `couldn't read the playlist — ${err.message}` });
  }

  // A fragmented-MP4 segment carries no headers of its own, so on its own it is
  // unreadable. Stitching the init segment in front of it makes a valid file.
  let temp = '';
  const init = path.join(session.dir, 'init.mp4');
  if (target.endsWith('.m4s') && fs.existsSync(init)) {
    try {
      temp = path.join(session.dir, 'probe-tmp.mp4');
      fs.writeFileSync(temp, Buffer.concat([fs.readFileSync(init), fs.readFileSync(target)]));
      target = temp;
    } catch {
      temp = '';   // fall through and probe the bare segment; it may still parse
    }
  }

  const declaredTotal = total;
  return new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries',
        'stream=codec_type,codec_name,avg_frame_rate,r_frame_rate,time_base,sample_rate,channels',
        '-show_entries', 'format=duration',
        '-of', 'json',
        target,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 25000);
    timer.unref?.();
    proc.stdout.on('data', (d) => (out += d));

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

    const finish = () => {
      clearTimeout(timer);
      dropTemp();
      let parsed = {};
      try {
        parsed = JSON.parse(out);
      } catch {
        return resolve({ error: 'ffprobe returned nothing readable' });
      }
      const streams = parsed.streams || [];
      const video = streams.find((s) => s.codec_type === 'video') || {};
      const audio = streams.find((s) => s.codec_type === 'audio') || {};
      const real = Number(parsed.format?.duration) || 0;
      resolve({
        declaredTotal,
        segment: {
          declared,
          real,
          // 1.0 is honest. Far from it is a conversion writing a timeline that
          // does not match the content it put in the segment.
          ratio: real && declared ? declared / real : 0,
        },
        video: {
          codec: video.codec_name || '',
          fps: video.avg_frame_rate || '',
          rawFps: video.r_frame_rate || '',
          timeBase: video.time_base || '',
        },
        audio: {
          codec: audio.codec_name || '',
          sampleRate: Number(audio.sample_rate) || 0,
          channels: Number(audio.channels) || 0,
          timeBase: audio.time_base || '',
        },
      });
    };
    proc.on('close', finish);
    proc.on('error', () => {
      dropTemp();
      resolve({ error: 'ffprobe is not available' });
    });
  });
}

function killSession(id) {
  const session = remuxSessions.get(id);
  if (!session) return;
  try {
    session.proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(session.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  remuxSessions.delete(id);
}

/**
 * Ask ffprobe about the source. Returns the video codec (which decides TS vs
 * fMP4 packaging) and the container's own duration — a reliable fallback when
 * the provider's metadata is unavailable, which it often is while streaming.
 */
function probeSource(input) {
  // Keep this cheap. Matroska carries codec and duration in the header, so a
  // small window is enough — and it matters: a heavy probe holds the
  // provider's single connection long enough to stall the remux behind it.
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
        '-select_streams', 'v:0',
        '-analyzeduration', '1000000',
        '-probesize', '600000',
        '-show_entries', 'stream=codec_name',
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
      let codec = '';
      let duration = 0;
      for (const line of out.split('\n')) {
        const name = /^codec_name=(.+)$/.exec(line.trim());
        if (name) codec = name[1].toLowerCase();
        const dur = /^duration=([\d.]+)$/.exec(line.trim());
        if (dur) duration = Math.floor(Number(dur[1]) || 0);
      }
      resolve({ codec, duration });
    };

    proc.on('close', finish);
    proc.on('error', finish);
  });
}

function ffmpegArgs(input, outDir, videoCodec, startSeconds = 0, audio = {}) {
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

  const isHevc = /hevc|h265/.test(videoCodec || '');

  // -ss ahead of -i is the fast seek: ffmpeg jumps in with Range requests
  // rather than decoding from the top. With -c copy it lands on the nearest
  // preceding keyframe, so the real start can be a second or two early.
  if (startSeconds > 0) args.push('-ss', String(startSeconds));

  args.push(
    '-i', input,
    // Rebase timestamps so a seeked session still starts its playlist at zero.
    '-avoid_negative_ts', 'make_zero',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy'
  );

  // Most of the English catalogue is already stereo AAC — exactly what every
  // browser wants. Copying it skips a decode+encode+resample per stream, which
  // is free headroom on the Pi. Only the 5.1 / E-AC3 tracks need converting.
  const audioIsReady =
    /^aac$/i.test(audio.codec || '') && Number(audio.channels || 0) > 0 && Number(audio.channels) <= 2;

  if (audioIsReady) {
    args.push('-c:a', 'copy');
  } else {
    // E-AC3/AC-3 5.1 is common here and inconsistently supported. Stereo AAC
    // is cheap to produce and plays on everything.
    args.push(
      '-c:a', 'aac',
      '-ac', '2',
      '-b:a', '160k',
      // Guards audio against drifting away from video over a long playback.
      // Honest note: this does NOT fix the ~0.9s late audio start that `-ss`
      // introduces on a seek — measured before and after, that gap was unchanged.
      '-af', 'aresample=async=1'
    );
  }

  // Apple's HLS spec carries HEVC in fragmented MP4 only — HEVC inside MPEG-TS
  // will not play on iOS at all. It also insists on the hvc1 tag, not hev1.
  if (isHevc) {
    args.push(
      '-tag:v', 'hvc1',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(outDir, 'seg%05d.m4s')
    );
  } else {
    args.push('-hls_segment_filename', path.join(outDir, 'seg%05d.ts'));
  }

  args.push(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    path.join(outDir, 'index.m3u8')
  );
  return args;
}

/**
 * Spawn a remux and resolve once the playlist has real segments in it. Only one
 * provider-backed session runs at a time — the account allows a single
 * connection, so a second would just fail.
 */
async function startRemux(input, { fromProvider, videoCodec, startSeconds = 0, audio = {} }) {
  if (!hasFfmpeg()) throw new Error('ffmpeg is not installed on this machine');

  // One viewer, one session: whatever was running is now abandoned, and an
  // abandoned local-file remux would otherwise keep ffmpeg grinding through
  // the whole film. A seek must not stack encoders on the Pi.
  for (const id of [...remuxSessions.keys()]) killSession(id);

  if (fromProvider) {
    // The remux is about to occupy the provider slot; playback wins.
    lastProviderActiveAt = Date.now();
    autoPauseActiveDownload();
  }

  // The container choice depends on the video codec, so we must know it before
  // spawning. The provider usually tells us; fall back to probing. The same
  // probe hands back the source duration, which the scrubber uses when the
  // provider's own metadata is unavailable.
  const probed = videoCodec ? { codec: videoCodec, duration: 0 } : await probeSource(input);
  const codec = probed.codec;

  fs.mkdirSync(HLS_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(HLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const proc = spawn(
    'ffmpeg',
    ['-v', 'error', '-y', ...ffmpegArgs(input, dir, codec, startSeconds, audio)],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });

  const session = {
    id,
    dir,
    proc,
    lastAccess: Date.now(),
    fromProvider,
    // Where this session sits in the film. The client adds it back so the
    // scrubber reads in real running time rather than session time.
    offset: startSeconds,
    sourceDuration: probed.duration || 0,
    // A seek should feel responsive, so bank less than on a cold open — but
    // not 8s: at this provider's pacing that drains before the first drop.
    prebuffer: startSeconds > 0 ? 45 : readPrefs().prebufferSeconds || DEFAULT_PREBUFFER,
    stderr: () => stderr,
  };
  remuxSessions.set(id, session);

  proc.on('exit', (code) => {
    session.exited = true;
    session.exitCode = code;
  });

  const playlist = path.join(dir, 'index.m3u8');
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    if (fs.existsSync(playlist)) {
      const text = fs.readFileSync(playlist, 'utf8');
      // Wait for a couple of segments so playback doesn't start and stall.
      if ((text.match(/\.(ts|m4s)/g) || []).length >= 2) return session;
    }
    if (session.exited && session.exitCode !== 0) {
      const detail = stderr.split('\n').filter(Boolean).pop() || `exit ${session.exitCode}`;
      killSession(id);
      throw new Error(`ffmpeg failed: ${detail}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  killSession(id);
  throw new Error('Remux timed out starting up');
}

/** Reap sessions nothing has fetched from in a while. */
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, s] of remuxSessions) if (s.lastAccess < cutoff) killSession(id);
}, 60000).unref();

for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const id of [...remuxSessions.keys()]) killSession(id);
    if (signal !== 'exit') process.exit(0);
  });
}

/* ------------------------------------------------------------- m3u parsing */

/**
 * Parse a plain M3U/M3U8 playlist into channel records. Handles the usual
 * tvg-* attribute soup plus group-title.
 */
function parseM3U(text) {
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
      pending.url = line;
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

  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;

  let upstream;
  try {
    upstream = await request(target, { headers });
  } catch (err) {
    return send(res, 502, `Upstream error: ${err.message}`);
  }

  // This connection is now occupying the provider slot — yield the download
  // queue to it, and release the slot whichever way the response ends.
  providerStreams += 1;
  lastProviderActiveAt = Date.now();
  autoPauseActiveDownload();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    providerStreams = Math.max(0, providerStreams - 1);
    lastProviderActiveAt = Date.now();
  };
  res.on('close', release);
  upstream.on('close', release);

  const contentType = upstream.headers['content-type'] || '';

  if (isPlaylist(upstream.finalUrl, contentType)) {
    const body = await readBody(upstream);
    const rewritten = rewritePlaylist(body.toString('utf8'), upstream.finalUrl);
    res.writeHead(upstream.statusCode || 200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    return res.end(rewritten);
  }

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
  const drain = Number(query.get('drain') || 0);
  const hold = Number(query.get('hold') || 0);
  // Riding alongside the pipe, not replacing it — this is the same provider
  // connection a download would use, so its rate belongs in the same meter.
  upstream.on('data', (chunk) => meterBytes(chunk.length));
  if (drain > 0) pipeLive(upstream, res, drain, hold);
  else upstream.pipe(res);

  req.on('close', () => upstream.destroy());
}

/** Logos and posters are frequently http-only or hotlink-blocked. */
async function handleImage(req, res, query) {
  const src = query.get('u');
  if (!src) return send(res, 400, 'Missing u');
  try {
    const upstream = await request(src, {
      headers: { accept: 'image/*' },
      timeout: 10000,
    });
    if ((upstream.statusCode || 500) >= 400) {
      upstream.resume();
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, {
      'content-type': upstream.headers['content-type'] || 'image/jpeg',
      'cache-control': 'public, max-age=86400',
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

const libraryCache = new Map();
const LIBRARY_TTL = 30 * 60 * 1000;
/** Payload shape version — bump when projectItem gains or loses a field. */
const LIBRARY_SHAPE = 3;
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

function projectItem(row, kind) {
  if (kind === 'live') {
    return {
      kind,
      id: row.stream_id,
      name: row.name,
      logo: row.stream_icon || '',
      categoryId: String(row.category_id ?? ''),
      epgId: row.epg_channel_id || '',
    };
  }
  if (kind === 'movie') {
    return {
      kind,
      id: row.stream_id,
      name: row.name,
      logo: row.stream_icon || '',
      categoryId: String(row.category_id ?? ''),
      ext: row.container_extension || 'mp4',
      rating: row.rating || '',
      // Upload time, used to sort the New Releases row newest-first.
      added: Number(row.added) || 0,
    };
  }
  return {
    kind,
    id: row.series_id,
    name: row.name,
    logo: row.cover || '',
    categoryId: String(row.category_id ?? ''),
    rating: row.rating || '',
    // Feed the genre shelves — provider categories carry no genre split.
    genre: row.genre || '',
    added: Number(row.last_modified) || 0,
  };
}

async function fetchXtreamJson(cfg, action) {
  const upstream = await request(xtreamApiUrl(cfg, { action }), { timeout: 120000 });
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

      if (next.mode === 'xtream') {
        if (!incoming.host || !incoming.username || !incoming.password) {
          return json(res, 400, { error: 'Host, username and password are required.' });
        }
        next.host = normalizeHost(incoming.host);
        next.username = String(incoming.username).trim();
        next.password = String(incoming.password);

        // Verify before saving — better to fail here than on the first click.
        try {
          const probe = await request(xtreamApiUrl(next, {}));
          const body = (await readBody(probe)).toString('utf8');
          const info = JSON.parse(body);
          if (!info.user_info || info.user_info.auth === 0) {
            return json(res, 401, { error: 'Provider rejected those credentials.' });
          }
          writeConfig(next);
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

  /* ---- Profiles ---- */
  if (pathname === '/api/profiles') {
    const data = readProfiles();

    if (req.method === 'GET') {
      return json(res, 200, { profiles: data.profiles.map(publicProfile) });
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

      const ok = verifyPassword(incoming.password, data.auth);
      noteAttempt(req, ok);
      if (!ok) return json(res, 401, { error: 'That password is not correct.' });

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
    /^\/api\/profiles\/([\w-]+)(\/prefs|\/history|\/rating|\/taste|\/progress)?$/.exec(pathname);
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
        /* body optional; password check below will fail anyway */
      }
      const ok = verifyPassword(incoming.password, data.auth);
      noteAttempt(req, ok);
      if (!ok) return json(res, 401, { error: 'That password is not correct.' });

      data.profiles = data.profiles.filter((p) => p.id !== profile.id);
      writeProfiles(data);
      return json(res, 200, { removed: true });
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
      if (['low', 'balanced', 'instant'].includes(incoming.liveLatency)) {
        prefs.liveLatency = incoming.liveLatency;
      }
      if (typeof incoming.filtersEnabled === 'boolean') {
        prefs.filtersEnabled = incoming.filtersEnabled;
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
    return json(res, 200, {
      busy: streaming || watching || downloading || playingLocal,
      streaming,
      watching,
      downloading,
      playingLocal,
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
      if (!incoming.streamId && !incoming.sourceUrl) {
        return json(res, 400, { error: 'streamId or sourceUrl is required' });
      }

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const job = {
        id,
        name: safeName(incoming.name),
        kind: incoming.kind === 'series' ? 'series' : 'movie',
        streamId: incoming.streamId ? String(incoming.streamId) : '',
        sourceUrl: incoming.sourceUrl || '',
        ext: (incoming.ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4',
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

  /* ---- Xtream passthrough ---- */
  if (pathname === '/api/xtream') {
    if (cfg.mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });
    const params = {};
    for (const [k, v] of query.entries()) {
      if (k !== 'username' && k !== 'password') params[k] = v;
    }
    try {
      const upstream = await request(xtreamApiUrl(cfg, params));
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
      return json(res, 200, data);
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* ---- M3U playlist ---- */
  if (pathname === '/api/playlist') {
    if (cfg.mode !== 'm3u') return json(res, 400, { error: 'Not in M3U mode' });
    try {
      const upstream = await request(cfg.playlistUrl);
      const text = (await readBody(upstream)).toString('utf8');
      const buckets = bucketM3U(parseM3U(text));
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
    if (cfg.mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });

    const prefs = readPrefs();
    const pattern = prefs.filtersEnabled ? prefs.filters[tab] : '';
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

    if (downloadId) {
      // Local file: no provider connection burned, and much faster.
      const job = downloads.get(downloadId);
      if (!job || job.status !== 'done') return json(res, 404, { error: 'No such download' });
      input = path.join(DOWNLOAD_DIR, job.file);
      fromProvider = false;
    } else {
      const kind = query.get('kind');
      const id = query.get('id');
      const ext = query.get('ext') || 'mkv';
      if (!kind || !id) return json(res, 400, { error: 'kind and id are required' });
      if (cfg.mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });
      input = buildStreamUrl(cfg, kind === 'series' ? 'series' : 'movie', id, ext);
    }

    try {
      const session = await startRemux(input, {
        fromProvider,
        videoCodec: (query.get('vcodec') || '').toLowerCase(),
        startSeconds: Math.max(0, Number(query.get('start') || 0)),
        audio: {
          codec: (query.get('acodec') || '').toLowerCase(),
          channels: Number(query.get('achannels') || 0),
        },
      });
      return json(res, 200, {
        url: `/hls/${session.id}/index.m3u8`,
        format: 'm3u8',
        session: session.id,
        prebuffer: session.prebuffer,
        offset: session.offset,
        sourceDuration: session.sourceDuration,
      });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
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
      lastError: session.exited && session.exitCode !== 0 ? session.stderr().split('\n').pop() : '',
      declaredSeconds: seconds,
      complete,
      ...probe,
    });
  }

  if (pathname === '/api/remux/stop') {
    for (const id of [...remuxSessions.keys()]) killSession(id);
    return json(res, 200, { stopped: true });
  }

  /* ---- Resolve a playable, proxied URL ---- */
  if (pathname === '/api/play') {
    const kind = query.get('kind');
    const id = query.get('id');
    const ext = query.get('ext') || '';
    if (!kind || !id) return json(res, 400, { error: 'kind and id are required' });
    if (cfg.mode !== 'xtream') return json(res, 400, { error: 'Not in Xtream mode' });
    try {
      const direct = buildStreamUrl(cfg, kind, id, ext);
      let url = proxyPath(direct);

      // drain = seconds we'll spend swallowing the provider's backlog.
      // hold  = seconds of jitter buffer banked before playback starts.
      const MODES = {
        low: { drain: 12, hold: 0 },
        balanced: { drain: 12, hold: 4 },
        instant: { drain: 0, hold: 0 },
      };
      const format = ext || cfg.preferredFormat;
      if (kind === 'live' && format === 'ts') {
        const mode = MODES[query.get('latency')] || MODES.balanced;
        if (mode.drain > 0) url += `&drain=${mode.drain}&hold=${mode.hold}`;
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

      if (session.exited) {
        if (!text.includes('#EXT-X-ENDLIST')) text = `${text.trimEnd()}\n#EXT-X-ENDLIST\n`;
        text = text.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
      }

      data = Buffer.from(text, 'utf8');
    }

    // fMP4 output produces init.mp4 + .m4s segments; TS output produces .ts.
    const type = isPlaylist
      ? 'application/vnd.apple.mpegurl'
      : /\.(mp4|m4s)$/.test(file)
        ? 'video/mp4'
        : 'video/mp2t';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': isPlaylist ? 'no-store' : 'public, max-age=3600',
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
  console.log('');
});
