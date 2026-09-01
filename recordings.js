/*
 * Recordings — a promise the box makes in advance.
 *
 * The live DVR is a two-minute rolling window that exists so somebody can
 * pause and rewind. This is the other thing: keep a programme, whole, because
 * it was asked for before it aired and nobody will be in the room when it
 * does.
 *
 * ── Where the video comes from ───────────────────────────────────────────
 * Two sources, and which one is used decides whether the recording costs a
 * provider connection at all.
 *
 *   THROUGH THE BOX'S OWN WINDOW, when somebody is already watching that
 *   channel. The live ingest is already pulling it and republishing locally,
 *   so a recorder reading that local playlist is a second reader of one
 *   stream — no second connection, nothing taken from anybody. It also keeps
 *   the ingest alive: the reaper watches `lastAccess`, and a recorder that
 *   never stops fetching means the window stays up after the viewer leaves.
 *   The recording inherits the slot rather than asking for one.
 *
 *   STRAIGHT FROM THE PROVIDER otherwise, which takes a slot from the pool
 *   and holds it for the whole programme.
 *
 * ── Who wins when the box is full ────────────────────────────────────────
 * The recording does. It was asked for in advance and nobody is standing
 * there; the viewer is present and can be told, in words, what is running and
 * until when — and can stop it with one press if they would rather have the
 * connection. The reverse policy breaks a promise in an empty room, which is
 * the one failure nobody would see coming.
 *
 * A recording therefore also starts even when it takes the LAST slot. It does
 * not interrupt anybody already watching; it means the next person has a
 * decision to make, and the message they get names the programme.
 *
 * ── Padding ──────────────────────────────────────────────────────────────
 * Listings drift, broadcasts overrun, and a recording that starts exactly on
 * the hour reliably loses the first thirty seconds. Every recording carries a
 * lead and a tail, and they are part of the record rather than a setting
 * somebody has to remember.
 */

const fs = require('fs');
const path = require('path');

/* Start this far before the listing says, and stop this far after. A minute
   either side costs a few megabytes and is the difference between having the
   opening titles and not. */
const LEAD_MS = 60 * 1000;
const TAIL_MS = 3 * 60 * 1000;

/* How often the scheduler looks. A programme starts on a minute boundary, so
   anything under half a minute is precision nobody can use. */
const TICK_MS = 20 * 1000;

/* A recording that has not written anything in this long is not recording. A
   feed can stall for a while and recover, so this is generous — but a silent
   ffmpeg holding a provider slot until midnight is worse than a short file. */
const STALL_MS = 5 * 60 * 1000;

/** Everything a recording is, and the only shape that is written to disk. */
const SHAPE = [
  'id', 'channelId', 'channelName', 'title', 'subtitle', 'description',
  'startsAt', 'endsAt', 'leadMs', 'tailMs', 'status', 'file', 'bytes',
  'error', 'profileId', 'createdAt', 'startedAt', 'finishedAt', 'source',
];

const store = {
  dir: '',
  index: '',
  /** id → record */
  rows: new Map(),
  /** id → { proc, release, lastBytes, lastGrewAt } */
  running: new Map(),
  log: () => {},
};

const clean = (row) => Object.fromEntries(SHAPE.map((key) => [key, row[key]]));

function persist() {
  try {
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.index, JSON.stringify([...store.rows.values()].map(clean)), {
      mode: 0o600,
    });
  } catch (err) {
    store.log(`recordings: could not write the index — ${err.message}`);
  }
}

function load(dir, log = () => {}) {
  store.dir = dir;
  store.index = path.join(dir, 'index.json');
  store.log = log;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rows = JSON.parse(fs.readFileSync(store.index, 'utf8'));
    for (const row of rows) {
      if (!row || !row.id) continue;
      /* Anything the box thought was recording when it stopped was not
         finished, and the file on disk is however far it got. Saying so is
         better than showing it as complete. */
      if (row.status === 'recording') {
        row.status = fileSize(path.join(dir, row.file || '')) > 0 ? 'partial' : 'missed';
        row.error = row.error || 'The box restarted while this was recording.';
      }
      store.rows.set(row.id, row);
    }
    const waiting = [...store.rows.values()].filter((r) => r.status === 'scheduled').length;
    log(`recordings: ${store.rows.size} kept, ${waiting} scheduled`);
  } catch {
    /* no recordings yet, which is the ordinary state of a new box */
  }
}

function fileSize(full) {
  try {
    return fs.statSync(full).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------- the list ── */

const all = () => [...store.rows.values()].sort((a, b) => b.startsAt - a.startsAt);

const get = (id) => store.rows.get(String(id)) || null;

/** What is being written right now, with the reason a viewer would be told. */
function active() {
  return [...store.running.keys()]
    .map((id) => store.rows.get(id))
    .filter(Boolean);
}

/**
 * A name for the file that is readable in a directory listing and safe on any
 * filesystem — this lands on ext4 today and could be copied to a phone
 * tomorrow.
 */
function fileName(row) {
  const stamp = new Date(row.startsAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const words = `${row.title || row.channelName || 'recording'}`
    .replace(/[^\w\d ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/ /g, '_');
  return `${stamp}_${words || 'recording'}.mp4`;
}

/**
 * Ask for a programme to be kept.
 *
 * Takes the listing's own start and stop rather than a duration: a listing is
 * what the viewer pressed record on, and if it is wrong the padding is what
 * covers it.
 */
function schedule({ channelId, channelName, title, subtitle, description,
  startsAt, endsAt, profileId }) {
  const start = Number(startsAt) || 0;
  const end = Number(endsAt) || 0;
  if (!channelId || !start || end <= start) return null;

  /* The same programme asked for twice is one recording. Pressing record on a
     card that is already set should say so rather than quietly making a
     second file of the same hour. */
  const already = [...store.rows.values()].find((row) =>
    String(row.channelId) === String(channelId)
    && row.startsAt === start
    && row.status !== 'failed'
    && row.status !== 'cancelled');
  if (already) return already;

  const row = {
    id: `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    channelId: String(channelId),
    channelName: String(channelName || ''),
    title: String(title || channelName || 'Recording'),
    subtitle: String(subtitle || ''),
    description: String(description || ''),
    startsAt: start,
    endsAt: end,
    leadMs: LEAD_MS,
    tailMs: TAIL_MS,
    status: 'scheduled',
    file: '',
    bytes: 0,
    error: '',
    profileId: String(profileId || ''),
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    source: '',
  };
  row.file = fileName(row);
  store.rows.set(row.id, row);
  persist();
  return row;
}

/** When this recording should actually open and close the file. */
const opensAt = (row) => row.startsAt - (row.leadMs ?? LEAD_MS);
const closesAt = (row) => row.endsAt + (row.tailMs ?? TAIL_MS);

/**
 * Drop one. A recording in progress is stopped and whatever was written is
 * kept — a viewer who takes the connection back mid-programme should get the
 * first half rather than nothing.
 */
function cancel(id, { reason = '' } = {}) {
  const row = get(id);
  if (!row) return null;
  const live = store.running.get(row.id);
  if (live) {
    stop(row.id, { reason: reason || 'Stopped.' });
    return get(id);
  }
  if (row.status === 'scheduled') {
    row.status = 'cancelled';
    row.error = reason;
    persist();
  }
  return row;
}

/** Forget it entirely, and take the file with it. */
function remove(id) {
  const row = get(id);
  if (!row) return false;
  if (store.running.has(row.id)) stop(row.id, { reason: 'Removed.' });
  try {
    if (row.file) fs.unlinkSync(path.join(store.dir, row.file));
  } catch {
    /* already gone, or never written */
  }
  store.rows.delete(row.id);
  persist();
  return true;
}

function stop(id, { reason = '' } = {}) {
  const live = store.running.get(id);
  const row = get(id);
  if (!live || !row) return;
  store.running.delete(id);
  try {
    /* SIGINT rather than SIGKILL: ffmpeg finishes the file it is writing, so
       what is on disk plays. A killed mp4 with no moov atom does not. */
    live.proc.kill('SIGINT');
  } catch {
    /* already gone */
  }
  if (live.release) live.release();
  row.bytes = fileSize(path.join(store.dir, row.file));
  row.finishedAt = Date.now();
  row.status = row.bytes > 0 ? (reason ? 'partial' : 'done') : 'failed';
  if (reason) row.error = reason;
  persist();
}

/* --------------------------------------------------------- the scheduler ── */

/**
 * One pass. Started, stopped and swept — all of it decided from the clock and
 * the rows, so nothing depends on a timer having fired at exactly the right
 * moment or on the box having been awake for the whole programme.
 */
function tick(now, hooks) {
  for (const row of store.rows.values()) {
    const live = store.running.get(row.id);

    if (live) {
      if (now >= closesAt(row)) {
        stop(row.id);
        continue;
      }
      /* A feed that stopped writing is not recording, whatever ffmpeg thinks
         it is doing — and it is holding a provider slot while it does it. */
      const bytes = fileSize(path.join(store.dir, row.file));
      if (bytes > live.lastBytes) {
        live.lastBytes = bytes;
        live.lastGrewAt = now;
        row.bytes = bytes;
      } else if (now - live.lastGrewAt > STALL_MS) {
        stop(row.id, { reason: 'The feed stopped sending.' });
      }
      continue;
    }

    if (row.status !== 'scheduled') continue;

    /* Too late to be worth starting — the programme is over. Said out loud
       rather than left sitting as "scheduled" for ever. */
    if (now >= closesAt(row)) {
      row.status = 'missed';
      row.error = row.error || 'The box was not running when this aired.';
      row.finishedAt = now;
      persist();
      continue;
    }

    if (now >= opensAt(row)) hooks.begin(row);
  }
}

/**
 * Take over a running recording's bookkeeping. Called by the box once it has
 * actually spawned ffmpeg, so this module never has to know how.
 */
function began(row, { proc, release, source }) {
  row.status = 'recording';
  row.startedAt = Date.now();
  row.source = source || '';
  row.error = '';
  persist();
  store.running.set(row.id, {
    proc,
    release,
    lastBytes: 0,
    lastGrewAt: Date.now(),
  });
}

/** ffmpeg exited on its own — the feed ended, or it was told to stop. */
function ended(id, code) {
  const row = get(id);
  if (!row || !store.running.has(id)) return;
  const live = store.running.get(id);
  store.running.delete(id);
  if (live.release) live.release();
  row.bytes = fileSize(path.join(store.dir, row.file));
  row.finishedAt = Date.now();
  if (row.bytes > 0) {
    /* Reaching the end of the programme is the ordinary way this finishes,
       and ffmpeg exiting early with a file is still a recording. */
    row.status = Date.now() >= row.endsAt ? 'done' : 'partial';
    if (row.status === 'partial') row.error = 'The feed ended before the programme did.';
  } else {
    row.status = 'failed';
    row.error = row.error || `Nothing was written (ffmpeg exited ${code}).`;
  }
  persist();
}

function noteFailure(row, message) {
  row.status = 'failed';
  row.error = message;
  row.finishedAt = Date.now();
  persist();
}

/**
 * What a viewer should be told when the box has no connection left.
 *
 * Only ever about recordings: a box that is full because somebody is watching
 * something is a different sentence, and one the viewer can work out for
 * themselves. This one they cannot, because the thing holding the connection
 * is invisible and nobody in the room started it.
 */
function blocking() {
  const [row] = active();
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    channelName: row.channelName,
    until: closesAt(row),
  };
}

module.exports = {
  load,
  all,
  get,
  active,
  schedule,
  cancel,
  remove,
  stop,
  tick,
  began,
  ended,
  noteFailure,
  blocking,
  opensAt,
  closesAt,
  fileSize,
  dir: () => store.dir,
  LEAD_MS,
  TAIL_MS,
  TICK_MS,
};
