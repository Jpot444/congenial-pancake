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
 *
 * ── IT CARRIES ON ────────────────────────────────────────────────────────
 *
 * "if something is being recorded on DVR, ever anything else should be pumped
 *  secondary. It should be always recorded. And even if the pie goes down,
 *  whatever was recorded should be saved. And whenever the pie regains
 *  connectivity, it should start the recording again."
 *
 * This is the part that was missing, and it is why the DVR did not work. A
 * recording used to have exactly one life: it started, and the first thing to
 * go wrong ended it for good.
 *
 *   the feed dropped for ten seconds   → `partial`, never tried again
 *   the box restarted                  → `partial`, never tried again
 *   the provider hiccuped at 2am       → `partial`, never tried again
 *
 * `partial` was a final state, and nothing in the scheduler ever looked at one
 * again — so a three-hour game came back as eleven minutes and a sentence
 * about the feed. Nobody is in the room when this happens, which is the whole
 * point of recording.
 *
 * A recording now has a WINDOW rather than an attempt. While the window is
 * open — from the lead before it starts to the tail after it ends — the box's
 * job is to be writing. Anything that stops it is a pause, not an ending:
 *
 *   INTERRUPTED is the new state and the whole of the fix. A feed that
 *   dropped, a box that restarted, a stall — all of them land here while the
 *   window is open, and the scheduler starts them again within seconds.
 *
 *   PARTIAL now means what it says: the window closed and we have some of it.
 *   It is an outcome, not a wound.
 *
 * AND NOTHING ALREADY WRITTEN IS EVER OVERWRITTEN. Each attempt writes its own
 * PART — `<file>.part-1.mp4`, `-2`, `-3` — and the parts are joined into one
 * file when the window closes. ffmpeg's `-y` would otherwise truncate two
 * hours of a game the moment the feed blipped and the box tried again, which
 * is a worse failure than the one being fixed.
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

/*
 * And how long to wait for the FIRST byte, which is a different question.
 *
 * The five minutes above is for a feed that was working and went quiet — a
 * provider can stumble for a while and come back, and cutting a good recording
 * short is the worse mistake. A recording that has written nothing AT ALL has
 * nothing to protect: it is holding a provider slot on the strength of a
 * connection that never delivered, and every minute of that is a minute not
 * spent trying a connection that might.
 *
 * Ninety seconds, not thirty: an HLS recording legitimately spends twenty or
 * thirty fetching a playlist and its first segments before anything lands.
 */
const FIRST_BYTE_MS = 90 * 1000;

/** Everything a recording is, and the only shape that is written to disk. */
const SHAPE = [
  'id', 'channelId', 'channelName', 'title', 'subtitle', 'description',
  'startsAt', 'endsAt', 'leadMs', 'tailMs', 'status', 'file', 'bytes',
  'error', 'profileId', 'createdAt', 'startedAt', 'finishedAt', 'source',
  // How many times the box has tried to start this, and whether a person
  // stopped it — see the retry block in tick(). The wait between attempts is
  // measured from `finishedAt`, so it needs no field of its own.
  'tries', 'byHand',
  // Every attempt's own file, in order. One entry is the ordinary case; more
  // than one means the window was interrupted and picked up again, and they
  // are joined into `file` when it closes. Written to disk with everything
  // else, because a box that restarted has to know what it already has.
  'parts',
  // How many times it has been picked up again, for the record — a recording
  // that came back four times is a different story from one that ran clean,
  // and the difference is worth keeping even when both end as `done`.
  'resumes',
];

/*
 * How long to wait before trying a failed start again, and the ceiling.
 *
 * A recording that wrote NOTHING has nothing to lose by being attempted
 * again, and an overnight booking is exactly the case that cannot ask anybody
 * to press retry. One refused connection at two in the morning — a slot
 * momentarily full, a provider hiccup, a channel that comes up late — ended
 * the whole eight-hour window at minute one, and the morning showed "failed"
 * with no hint that a single retry would have caught it.
 *
 * Backing off so a channel that is genuinely gone is not hammered all night:
 * a minute, then two, then three, settling at five.
 */
const RETRY_STEP_MS = 60 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

/*
 * And how fast to pick one up again once it HAS been recording.
 *
 * A different number from the one above, because it answers a different
 * question. The backoff above is about a channel that may not exist: a minute
 * between attempts is polite to a provider and costs nothing, since there is
 * nothing to miss. This one is about a feed that was working a moment ago and
 * dropped — every second here is a second of the programme on the floor, so
 * it is seconds, not minutes.
 *
 * A part that wrote something resets the count. A feed that drops every few
 * minutes all evening therefore keeps being picked up quickly rather than
 * sliding down a ladder into five-minute gaps.
 */
const RESUME_STEP_MS = 5 * 1000;
const RESUME_MAX_MS = 30 * 1000;

const store = {
  dir: '',
  index: '',
  /*
   * One notion of now.
   *
   * The module used to keep two: `tick(now)` was handed a time by the caller,
   * while everything that RECORDED a time — noteFailure, ended, stop — reached
   * for store.clock() itself. In the box they are the same clock and it never
   * mattered; the moment anything drives the scheduler on its own clock the
   * two disagree, and the backoff is measured between them.
   *
   * Injectable, so a suite can advance time and have every part of this agree
   * about what time it is. Nothing else about it changes.
   */
  clock: () => Date.now(),
  /*
   * What to do the moment a recording finishes — joining its parts into the
   * one file the row promises. Registered by the box, because this module does
   * not know what ffmpeg is.
   *
   * Called from the paths that END a recording rather than waited for on the
   * next scheduler pass: somebody who stops a recording and presses play
   * should not be told to come back in twenty seconds, and anything reading
   * `row.file` should find a file there. The sweep in tick() stays as the
   * safety net for whatever this misses — a box that stopped in between.
   */
  finished: null,
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

function load(dir, log = () => {}, clock = null) {
  store.dir = dir;
  store.index = path.join(dir, 'index.json');
  store.log = log;
  if (clock) store.clock = clock;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rows = JSON.parse(fs.readFileSync(store.index, 'utf8'));
    for (const row of rows) {
      if (!row || !row.id) continue;
      /*
       * Anything the box thought was recording when it stopped was not
       * finished — and whether that is an ENDING depends entirely on whether
       * the programme is still on.
       *
       * "even if the pie goes down, whatever was recorded should be saved.
       *  And whenever the pie regains connectivity, it should start the
       *  recording again"
       *
       * A box that restarts eleven minutes into a three-hour game comes back
       * with the window still wide open. Calling that `partial` and stopping
       * was how a deploy, a power cut or a crash cost the whole programme.
       * It is `interrupted` now, which the scheduler picks up within seconds,
       * and the eleven minutes already on disk are kept as the first part.
       */
      if (row.status === 'recording') {
        row.parts = partsOf(row);
        const held = row.parts.reduce((n, f) => n + fileSize(path.join(dir, f)), 0);
        if (store.clock() < closesAt(row)) {
          row.status = 'interrupted';
          row.error = 'The box restarted — picking it back up.';
        } else {
          row.status = held > 0 ? 'partial' : 'missed';
          row.error = row.error || 'The box restarted while this was recording.';
        }
      }
      store.rows.set(row.id, row);
    }
    const waiting = [...store.rows.values()].filter((r) => r.status === 'scheduled').length;
    const resuming = [...store.rows.values()].filter((r) => r.status === 'interrupted').length;
    log(`recordings: ${store.rows.size} kept, ${waiting} scheduled`
      + `${resuming ? `, ${resuming} to pick back up` : ''}`);
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

/* ---------------------------------------------------------------- parts ── */

/*
 * Every attempt writes its own file.
 *
 * This is what makes picking a recording back up safe. ffmpeg is given `-y`
 * and would truncate whatever is there — so a feed that blipped two hours into
 * a game, with the box dutifully starting again, would have thrown the two
 * hours away to record the last twenty minutes. The parts are joined when the
 * window closes; until then they are simply files, in order, and every one of
 * them plays on its own.
 */
const partName = (row, n) => `${String(row.file).replace(/\.mp4$/i, '')}.part-${n}.mp4`;

/** The parts this row has, as recorded — or found on disk if the list is lost. */
function partsOf(row) {
  if (Array.isArray(row.parts) && row.parts.length) return row.parts.slice();
  /* A row written by a build before parts existed has one file and no list. */
  if (row.file && fileSize(path.join(store.dir, row.file)) > 0) return [row.file];
  return [];
}

/** The file the next attempt should write, and the list it joins. */
function nextPart(row) {
  const parts = partsOf(row);
  /* The first attempt of a recording whose only file IS `file` — a row from
     before this existed — must not overwrite it, so it starts at part 2. */
  const n = parts.length + 1;
  const name = partName(row, n);
  row.parts = [...parts, name];
  persist();
  return name;
}

/** What is on disk for this row, across every part. */
function bytesOf(row) {
  const parts = partsOf(row);
  if (!parts.length) return fileSize(path.join(store.dir, row.file || ''));
  return parts.reduce((n, f) => n + fileSize(path.join(store.dir, f)), 0);
}

/** The part being written right now, which is the one to serve while it runs. */
function newestPart(row) {
  const parts = partsOf(row).filter((f) => fileSize(path.join(store.dir, f)) > 0);
  return parts.length ? parts[parts.length - 1] : (row.file || '');
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
    id: `rec-${store.clock().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
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
    createdAt: store.clock(),
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
    /* Marked as a person's doing before it is stopped. A stop with nothing
       written yet lands on `failed`, which the scheduler now retries — and
       restarting something somebody has just switched off would be the box
       arguing with the button. */
    row.byHand = true;
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
  /* Every part, not just the file the row promises. A recording that was
     picked back up twice has three files on disk, and deleting only the one
     named in `file` would leave the other two on the drive for ever with
     nothing left pointing at them. */
  for (const name of new Set([...partsOf(row), row.file].filter(Boolean))) {
    try {
      fs.unlinkSync(path.join(store.dir, name));
    } catch {
      /* already gone, or never written */
    }
  }
  store.rows.delete(row.id);
  persist();
  return true;
}

/** A recording has finished, one way or another: make its file real. */
function settle(row) {
  if (!store.finished) return;
  try {
    store.finished(row);
  } catch (err) {
    store.log(`recordings: could not finish ${row.id} — ${err.message}`);
  }
}

/** The box says how to turn a finished recording's parts into its file. */
function whenFinished(fn) {
  store.finished = fn;
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
  row.bytes = bytesOf(row);
  row.finishedAt = store.clock();
  /*
   * Whether this is an ending depends on whether the programme is still on.
   *
   * A stall at minute eleven of a three-hour game used to land on `partial`
   * and stay there. The feed stopping is a reason to start again, not a reason
   * to give up — unless a PERSON stopped it, which is a decision, or the
   * window has closed, which is the end.
   */
  const open = store.clock() < closesAt(row) && !row.byHand;
  if (!reason) row.status = 'done';
  /* Same split as ended(): something that was writing comes back on the fast
     ladder, something that never wrote a byte on the slow one. */
  else if (open && row.bytes > 0) row.status = 'interrupted';
  else if (open) row.status = 'failed';
  else row.status = row.bytes > 0 ? 'partial' : 'failed';
  if (reason) row.error = reason;
  persist();
  /* Interrupted is not finished — it is about to be picked back up, and the
     parts are joined when the window finally closes. */
  if (row.status !== 'interrupted') settle(row);
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

    /*
     * Parts waiting to be joined.
     *
     * Swept here rather than at the end of each path, because there are four
     * ways a recording finishes — ffmpeg exiting, a stall, the window closing,
     * a person stopping it — and a join that hung off one of them would be
     * missed by the other three. Idempotent: the box sets `parts` to the
     * single joined file when it succeeds, so a row is only ever seen once.
     */
    if (!live && (row.status === 'done' || row.status === 'partial')) {
      const parts = partsOf(row);
      /* More than one to join, or one under a part name that has to become the
         file the row promises. Both go the same way, and both are idempotent:
         the box sets `parts` to [file] when it is done, so a row is only ever
         picked up here once. */
      if (parts.length > 1 || (parts.length === 1 && parts[0] !== row.file)) {
        hooks.join?.(row);
        continue;
      }
    }

    if (live) {
      if (now >= closesAt(row)) {
        stop(row.id);
        continue;
      }
      /* A feed that stopped writing is not recording, whatever ffmpeg thinks
         it is doing — and it is holding a provider slot while it does it. */
      const bytes = bytesOf(row);
      if (bytes > live.lastBytes) {
        live.lastBytes = bytes;
        live.lastGrewAt = now;
        row.bytes = bytes;
      } else if (now - live.lastGrewAt > (live.lastBytes ? STALL_MS : FIRST_BYTE_MS)) {
        stop(row.id, {
          reason: live.lastBytes
            ? 'The feed stopped sending.'
            : 'The feed never started sending.',
        });
      }
      continue;
    }

    /*
     * Anything that stopped inside a window that is still open.
     *
     * This is the whole of "it should always be recorded". Two states arrive
     * here and they wait different lengths of time:
     *
     *   FAILED — nothing was ever written. The channel may not exist, so the
     *   ladder is minutes: polite to a provider, and there is nothing to miss
     *   while waiting.
     *
     *   INTERRUPTED — it WAS writing and something stopped it: the feed, a
     *   stall, the box restarting. The channel demonstrably works, so the
     *   ladder is seconds. Every one of them is a second of the programme on
     *   the floor.
     *
     * Never when a person did it. Stopping a recording to take the connection
     * back is a decision, and starting it again a moment later would be the
     * box arguing with whoever pressed the button.
     */
    const stalled = row.status === 'failed' || row.status === 'interrupted';
    if (stalled && !row.byHand && now >= opensAt(row) && now < closesAt(row)) {
      /* Measured from when it stopped rather than kept in a field of its own:
         the first attempt has to wait as long as the rest, or a failure that
         is instant becomes a retry every tick. */
      const tries = row.tries || 0;
      const wait = row.status === 'interrupted'
        ? Math.min(RESUME_MAX_MS, RESUME_STEP_MS * (tries + 1))
        : Math.min(RETRY_MAX_MS, RETRY_STEP_MS * (tries + 1));
      if (now - (row.finishedAt || 0) < wait) continue;
      row.tries = tries + 1;
      if (row.status === 'interrupted') row.resumes = (row.resumes || 0) + 1;
      row.status = 'scheduled';
      persist();
      /* Falls through on purpose: the lines below start a scheduled row, and
         this one is due now. */
    }

    if (row.status !== 'scheduled') continue;

    /* Too late to be worth starting — the programme is over. Said out loud
       rather than left sitting as "scheduled" for ever. And what it is called
       depends on whether anything was caught: a recording that ran for two of
       its three hours is PARTIAL, which is an outcome, and only one that
       caught nothing at all was missed. */
    if (now >= closesAt(row)) {
      row.bytes = bytesOf(row);
      row.status = row.bytes > 0 ? 'partial' : 'missed';
      row.error = row.bytes > 0
        ? (row.error || 'The feed dropped before the programme ended.')
        : (row.error || 'The box was not running when this aired.');
      row.finishedAt = now;
      if (row.bytes > 0) hooks.join?.(row);
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
  row.startedAt = store.clock();
  row.source = source || '';
  row.error = '';
  persist();
  store.running.set(row.id, {
    proc,
    release,
    lastBytes: 0,
    lastGrewAt: store.clock(),
  });
}

/** ffmpeg exited on its own — the feed ended, or it was told to stop. */
function ended(id, code) {
  const row = get(id);
  if (!row || !store.running.has(id)) return;
  const live = store.running.get(id);
  store.running.delete(id);
  if (live.release) live.release();
  const before = row.bytes || 0;
  row.bytes = bytesOf(row);
  row.finishedAt = store.clock();
  /*
   * ffmpeg exiting is the commonest interruption there is, and it used to be
   * the end of the recording.
   *
   * A provider drops the connection, the Wi-Fi blips, the channel restarts its
   * encoder — ffmpeg exits, and with the old rule a three-hour booking became
   * whatever had been written by then plus "the feed ended before the
   * programme did". While the window is open the answer is to start again.
   */
  const open = store.clock() < closesAt(row) && !row.byHand;
  if (open && row.bytes > before) {
    /*
     * It WAS recording and something stopped it. The channel demonstrably
     * works, so this comes back on the fast ladder and the count starts over —
     * a feed that drops all evening must not slide into five-minute gaps.
     */
    row.status = 'interrupted';
    row.error = 'The feed stopped — picking it back up.';
    row.tries = 0;
  } else if (open) {
    /*
     * Nothing was written, which is a different fault with a different wait.
     * `failed` is this file's word for "no footage": the channel may not
     * exist, so the scheduler backs off in minutes rather than seconds. It is
     * still retried for as long as the window is open.
     */
    row.status = 'failed';
    row.error = row.error || `Nothing was written (ffmpeg exited ${code}).`;
  } else if (row.bytes > 0) {
    row.status = 'done';
  } else {
    row.status = 'failed';
    row.error = row.error || `Nothing was written (ffmpeg exited ${code}).`;
  }
  persist();
  if (row.status !== 'interrupted') settle(row);
}

function noteFailure(row, message) {
  row.status = 'failed';
  row.error = message;
  row.finishedAt = store.clock();
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
  whenFinished,
  all,
  get,
  active,
  /* The parts an attempt writes and reads — see the note above partName. */
  nextPart,
  partsOf,
  bytesOf,
  newestPart,
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
