/*
 * Wrapped — how much of the year each profile actually spent watching.
 *
 * "add a treasureflix wrapped the same way i have a wrapped for treasuredible"
 *
 * The watch history can't answer that by itself. It keeps one row per title
 * with where you got to, which says a film was finished and nothing about
 * WHEN the two hours were spent, and a live channel's row only remembers its
 * last sitting. So the history heartbeat (every fifteen seconds while
 * something plays) also lands here, as seconds per day per hour per title —
 * the same shape Treasuredible's ListeningLog keeps.
 *
 * A beat only counts what the playhead moved, and never more than the clock
 * did since the last beat: a paused film sends beats that move nothing, and a
 * seek forward moves the playhead an hour in a second. A gap longer than
 * BEAT_GAP_S is a new sitting, so the first beat after it counts nothing.
 *
 * ── BACKDATED ───────────────────────────────────────────────────────────
 * Everything watched before this existed is rebuilt once, from the history
 * rows as they stood: a finished film or episode counts its runtime, a
 * half-watched one how far it got, a channel its last sitting. That is a
 * floor, not a measurement — a rewatch counts once and a channel watched
 * fifty times counts once — and it is placed on the day and hour the row was
 * last touched. Stats that include it say so (`estimated`).
 *
 * Kept in its own file rather than on the profile: profiles.json goes to
 * every screen on every change, and a year of days has no business riding
 * along with it.
 */

const fs = require('fs');

const BEAT_GAP_S = 75;
const DAY_MIN_S = 60; // a day with less than a minute of watching doesn't count as one

let file = null;
let data = { profiles: {} };
let saveTimer = null;

function configure(opts) {
  file = opts.file;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = { profiles: {} };
  }
  if (!data.profiles) data.profiles = {};
}

function save() {
  if (!file || saveTimer) return;
  // Beats arrive four a minute per screen; one write every few seconds is plenty.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`  watch-log.json not saved: ${err.message}`);
    }
  }, 5000);
}

function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (file) fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function logFor(profileId) {
  return (data.profiles[profileId] ||= { days: {}, items: {}, finished: [] });
}

/** "Entourage (2004) (US) — S2E14" -> "Entourage (2004) (US)" */
function showName(name) {
  return String(name || '').replace(/\s+(?:[—-]\s+)?S\d+\s*E\d+.*$/i, '').trim();
}

/**
 * A provider's name as a person would write it, for the cards:
 * "EN-TOP -139.Shutter.Island.2010" -> "Shutter Island (2010)",
 * "EN - Ted Lasso (2020) (US)" -> "Ted Lasso (2020)".
 */
function tidy(raw) {
  const original = String(raw || '').trim();
  let name = original;
  for (let i = 0; i < 4; i += 1) {
    const m = /^([A-Za-z0-9+&]{1,6})\s*[-|:–•]\s*/.exec(name);
    if (!m || !(/^[A-Z][A-Z0-9+&]*$/.test(m[1]) || (i > 0 && /^\d{1,3}$/.test(m[1])))) break;
    name = name.slice(m[0].length);
  }
  name = name.replace(/^\d{1,3}\.\s*(?=[A-Za-z])/, '');
  if (!/\s/.test(name) && /\./.test(name)) name = name.replace(/\./g, ' ');
  name = name
    .replace(/\s+start:\d{4}-.*$/, '')
    .replace(/\s((?:19|20)\d\d)$/, ' ($1)')
    .replace(/\s*\((?:US|GB|UK|CA|AU)\)\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return name || original;
}

/**
 * What a row is, by its key before its kind: a downloaded episode plays as a
 * "movie" and so does a clip from the Archive, and neither is a film.
 */
function kindOf(row) {
  const prefix = String(row.key || '').split(':')[0];
  if (prefix === 'series' || prefix === 'archive') return prefix;
  if (prefix === 'live' || prefix === 'recording') return 'live';
  return row.kind === 'series' || row.kind === 'live' ? row.kind : 'movie';
}

function metaOf(row) {
  const kind = kindOf(row);
  const meta = { kind, name: row.name || '', poster: row.poster || '' };
  if (kind === 'series') {
    meta.seriesId = row.seriesId ?? String(row.key).split(':')[1] ?? row.id;
    meta.show = showName(row.name);
  }
  if (kind === 'live' && row.categoryName) meta.category = row.categoryName;
  return meta;
}

/** Spread `seconds` over the hours leading up to `endMs`. */
function addTime(log, row, seconds, endMs) {
  let left = Math.round(seconds);
  let end = endMs;
  while (left > 0) {
    const at = new Date(end - 1);
    const hourStart = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours()).getTime();
    const chunk = Math.min(left, Math.ceil((end - hourStart) / 1000));
    const day = (log.days[dayOf(at)] ||= { hours: new Array(24).fill(0), items: {} });
    day.hours[at.getHours()] += chunk;
    day.items[row.key] = (day.items[row.key] || 0) + chunk;
    left -= chunk;
    end = hourStart;
  }
  log.items[row.key] = metaOf(row);
}

function finish(log, row, whenMs) {
  if (kindOf(row) === 'live') return;
  const day = dayOf(new Date(whenMs));
  const year = day.slice(0, 4);
  if (log.finished.some((f) => f.key === row.key && f.day.startsWith(year))) return;
  log.finished.push({ key: row.key, day, ...metaOf(row) });
}

/**
 * One history beat. `before` is the row as it was before this beat (or null
 * for a first play), `row` as it is now.
 */
function beat(profileId, before, row, now = Date.now()) {
  const log = logFor(profileId);
  if (before && Number.isFinite(before.at) && Number.isFinite(before.position)) {
    const wall = (now - before.at) / 1000;
    const moved = (row.position || 0) - before.position;
    if (wall > 0 && wall <= BEAT_GAP_S && moved > 0) {
      addTime(log, row, Math.min(moved, wall), now);
      save();
    }
  }
  if (row.completed && !(before && before.completed)) {
    finish(log, row, now);
    save();
  }
}

/** How much a history row stands for, for the one-time backdating. */
function estimate(row) {
  const pos = Math.max(0, row.position || 0);
  if (kindOf(row) === 'live') return pos;
  const dur = Math.max(0, row.duration || 0);
  if (row.completed && dur) return dur;
  return dur ? Math.min(pos, dur) : pos;
}

/** Rebuild what came before from the history, once per profile. */
function backfill(profiles) {
  let changed = false;
  for (const profile of profiles) {
    // A log that already exists has been counting beats; rebuilding it from
    // the history now would count all of that twice.
    if (data.profiles[profile.id]) continue;
    const log = logFor(profile.id);
    for (const row of profile.history || []) {
      if (!row.key || !Number.isFinite(row.at)) continue;
      const seconds = estimate(row);
      if (seconds >= 1) addTime(log, row, seconds, row.at);
      if (row.completed) finish(log, row, row.at);
    }
    log.backfilledAt = Date.now();
    changed = true;
  }
  if (changed) save();
}

function forget(profileId) {
  if (data.profiles[profileId]) {
    delete data.profiles[profileId];
    save();
  }
}

function longestRun(days) {
  let best = 0, start = null, run = 0, prev = null, first = null;
  for (const d of [...days].sort()) {
    const date = new Date(`${d}T12:00`);
    run = prev && Math.round((date - prev) / 86400000) === 1 ? run + 1 : 1;
    if (run === 1) first = d;
    if (run > best) { best = run; start = first; }
    prev = date;
  }
  return { length: best, start };
}

/** Wrapped-style totals for one profile's year. */
function stats(profileId, year, top = 10) {
  const log = logFor(profileId);
  const prefix = `${year}-`;
  const months = new Array(12).fill(0), weekdays = new Array(7).fill(0), hours = new Array(24).fill(0);
  const totals = { movie: 0, series: 0, live: 0, archive: 0 };
  const movies = {}, shows = {}, channels = {}, archive = new Set();
  const perDay = {};
  let binge = null;

  for (const [d, v] of Object.entries(log.days)) {
    if (!d.startsWith(prefix)) continue;
    const date = new Date(`${d}T12:00`);
    const dayTotal = v.hours.reduce((a, b) => a + b, 0);
    perDay[d] = dayTotal;
    months[date.getMonth()] += dayTotal;
    weekdays[(date.getDay() + 6) % 7] += dayTotal; // Monday first
    v.hours.forEach((s, h) => (hours[h] += s));
    const episodesToday = {};
    for (const [key, s] of Object.entries(v.items)) {
      const meta = log.items[key] || {};
      const kind = totals[meta.kind] !== undefined ? meta.kind : 'movie';
      totals[kind] += s;
      if (kind === 'series') {
        const id = String(meta.seriesId ?? key);
        const show = (shows[id] ||= { title: '', poster: meta.poster, seconds: 0, episodes: new Set() });
        // Episodes of one show can carry differently-written names; the
        // shortest is the one without an episode's title stuck on the end.
        const title = tidy(meta.show || meta.name);
        if (!show.title || title.length < show.title.length) show.title = title;
        show.seconds += s;
        show.episodes.add(key);
        if (s >= 300) episodesToday[id] = (episodesToday[id] || 0) + 1;
      } else if (kind === 'archive') {
        archive.add(key);
      } else if (kind === 'live') {
        const ch = (channels[key] ||= { title: tidy(meta.name), poster: meta.poster, seconds: 0 });
        ch.seconds += s;
      } else {
        const m = (movies[key] ||= { title: tidy(meta.name), poster: meta.poster, seconds: 0 });
        m.seconds += s;
      }
    }
    for (const [id, n] of Object.entries(episodesToday)) {
      if (!binge || n > binge.episodes) binge = { day: d, episodes: n, title: shows[id].title, poster: shows[id].poster };
    }
  }

  const ranked = (o) => Object.values(o).sort((a, b) => b.seconds - a.seconds).slice(0, top);
  const card = (e) => ({ title: e.title, poster: e.poster || '', seconds: Math.round(e.seconds),
    ...(e.episodes ? { episodes: e.episodes.size } : {}) });
  const watchedDays = Object.keys(perDay).filter((d) => perDay[d] >= DAY_MIN_S);
  const streak = longestRun(watchedDays);
  const topDay = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0];
  const allDays = Object.keys(log.days).sort();
  const finished = log.finished.filter((f) => f.day.startsWith(prefix)).sort((a, b) => b.day.localeCompare(a.day));
  const backfilledDay = log.backfilledAt ? dayOf(new Date(log.backfilledAt)) : null;

  return {
    year,
    years: [...new Set([...allDays.map((d) => Number(d.slice(0, 4))), year])].sort((a, b) => b - a),
    since: allDays[0] || null,
    estimated: Boolean(backfilledDay && backfilledDay >= `${year}-01-01` && allDays.some((d) => d.startsWith(prefix) && d <= backfilledDay)),
    estimatedUntil: backfilledDay,
    total: Math.round(Object.values(perDay).reduce((a, b) => a + b, 0)),
    movies: Math.round(totals.movie),
    series: Math.round(totals.series),
    live: Math.round(totals.live),
    archive: Math.round(totals.archive),
    daysWatched: watchedDays.length,
    streak: streak.length,
    streakStart: streak.start,
    topDay: topDay ? { day: topDay[0], seconds: Math.round(topDay[1]) } : null,
    binge: binge && binge.episodes > 1 ? binge : null,
    months: months.map(Math.round),
    weekdays: weekdays.map(Math.round),
    hours: hours.map(Math.round),
    topShows: ranked(shows).map(card),
    topMovies: ranked(movies).map(card),
    topChannels: ranked(channels).map(card),
    movieCount: Object.keys(movies).length,
    showCount: Object.keys(shows).length,
    episodeCount: Object.values(shows).reduce((n, s) => n + s.episodes.size, 0),
    channelCount: Object.keys(channels).length,
    archiveCount: archive.size,
    moviesFinished: finished.filter((f) => f.kind === 'movie').length,
    episodesFinished: finished.filter((f) => f.kind === 'series').length,
    finishedMovies: finished.filter((f) => f.kind === 'movie').map((f) => ({ title: tidy(f.name), poster: f.poster, day: f.day })),
  };
}

module.exports = { configure, beat, backfill, forget, stats, flush, showName, tidy, estimate };
