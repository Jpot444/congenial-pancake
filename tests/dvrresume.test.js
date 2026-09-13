/**
 * A recording carries on.
 *
 * "We need to fix the DVR because it just does not work... if something is
 *  being recorded on DVR, ever anything else should be pumped secondary. It
 *  should be always recorded. And even if the pie goes down, whatever was
 *  recorded should be saved. And whenever the pie regains connectivity, it
 *  should start the recording again."
 *
 * The DVR had exactly one life per recording: it started, and the first thing
 * to go wrong ended it for good. `partial` was a FINAL state and nothing in
 * the scheduler ever looked at one again, so all three of these came to the
 * same thing —
 *
 *   the feed dropped for ten seconds   → partial, never tried again
 *   the box restarted                  → partial, never tried again
 *   the provider hiccuped at 2am       → partial, never tried again
 *
 * — and a three-hour game came back as eleven minutes and a sentence about the
 * feed. Nobody is in the room when that happens, which is the whole point of
 * recording.
 *
 * This drives recordings.js directly, with the clock and the files under the
 * suite's control and `begin` standing in for ffmpeg. That is the right level:
 * what was wrong is the LIFECYCLE — which states are endings and which are
 * pauses — and a test that spawned real encoders would be testing ffmpeg while
 * the bug sat in a state machine.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const MIN = 60 * 1000;

/**
 * A fresh module with a fresh directory and a clock the suite drives.
 *
 * The clock matters. Every wait in here is measured between a time the module
 * WROTE down and the time it is asked about, and a suite advancing one of
 * those while the module read the other from the wall clock would be measuring
 * the drift between them rather than the backoff.
 */
function freshModule() {
  const at = require.resolve('../recordings.js');
  delete require.cache[at];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(at);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-'));
  const clock = { at: Date.now() };
  mod.load(dir, () => {}, () => clock.at);
  return { mod, dir, clock };
}

/**
 * ffmpeg, as far as the lifecycle is concerned: something that was asked to
 * start, writes when told to, and stops when told to.
 */
function fakeEncoder(mod, dir) {
  const started = [];
  const begin = (row) => {
    const part = mod.nextPart(row);
    started.push({ id: row.id, part });
    fs.writeFileSync(path.join(dir, part), '');
    mod.began(row, {
      proc: { kill() { /* the suite ends these itself */ } },
      release: () => {},
      source: 'provider',
    });
  };
  /** Minutes of programme land in the part that is open. */
  const write = (row, bytes) => {
    const parts = mod.partsOf(row);
    const part = parts[parts.length - 1];
    fs.appendFileSync(path.join(dir, part), 'x'.repeat(bytes));
  };
  return { begin, write, started };
}

const sched = (mod, now, { start = 0, end = 60 * MIN } = {}) => mod.schedule({
  channelId: '77',
  channelName: 'US| NBC EAST',
  title: 'The Game',
  startsAt: now + start,
  endsAt: now + end,
  profileId: 'own1',
});

(async () => {
  /* ---- 1. the feed drops mid-programme ------------------------------- */
  /*
   * The reported failure, and the commonest one: a provider drops the
   * connection twenty minutes into a three-hour game.
   */
  console.log('\n  the feed drops twenty minutes in');
  {
    const { mod, dir, clock } = freshModule();
    const enc = fakeEncoder(mod, dir);
    let now = clock.at;
    const row = sched(mod, now, { end: 180 * MIN });

    mod.tick(now, enc);
    check('it starts', mod.get(row.id).status === 'recording', mod.get(row.id).status);
    enc.write(mod.get(row.id), 2000);

    /* ffmpeg exits. The window has two and a half hours left on it. */
    now = clock.at += 20 * MIN;
    mod.ended(row.id, 1);
    const after = mod.get(row.id);
    console.log(`    after the drop: ${after.status} — ${after.error}`);
    check('it is not called finished', after.status !== 'done', after.status);
    check('nor written off as partial while the programme is still on',
      after.status !== 'partial', after.status);
    check('it is interrupted, which is a state the scheduler acts on',
      after.status === 'interrupted', after.status);
    check('and it says it is coming back', /picking it back up/i.test(after.error || ''),
      after.error);

    /* Seconds, not minutes. Every one of them is programme on the floor. */
    now = clock.at += 6 * 1000;
    mod.tick(now, enc);
    const back = mod.get(row.id);
    console.log(`    six seconds later: ${back.status}, ${mod.partsOf(back).length} parts`);
    check('it is recording again within seconds', back.status === 'recording', back.status);
    check('into a NEW part, so the first twenty minutes survive',
      mod.partsOf(back).length === 2, JSON.stringify(mod.partsOf(back)));
    check('and the first part is still on disk with its bytes in it',
      mod.fileSize(path.join(dir, mod.partsOf(back)[0])) === 2000,
      String(mod.fileSize(path.join(dir, mod.partsOf(back)[0]))));
    check('the size it reports is everything caught, not the current attempt',
      mod.bytesOf(back) === 2000, String(mod.bytesOf(back)));
  }

  /* ---- 2. the box goes down -------------------------------------------- */
  /*
   * "even if the pie goes down, whatever was recorded should be saved. And
   *  whenever the pie regains connectivity, it should start the recording
   *  again"
   *
   * A restart is not a different case from the one above, and the fix is that
   * it stops being treated as one: what matters is whether the programme is
   * still on.
   */
  console.log('\n  and the box restarts mid-programme');
  {
    const { mod, dir, clock } = freshModule();
    const enc = fakeEncoder(mod, dir);
    const now = clock.at;
    const row = sched(mod, now, { end: 180 * MIN });
    mod.tick(now, enc);
    enc.write(mod.get(row.id), 5000);
    const file = mod.partsOf(mod.get(row.id))[0];

    /* The box stops without warning — a deploy, a power cut, a crash. The
       index on disk still says `recording`, which is what load() has to make
       sense of. */
    const at = require.resolve('../recordings.js');
    delete require.cache[at];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const after = require(at);
    after.load(dir, () => {});
    const back = after.get(row.id);
    console.log(`    coming back up: ${back.status} — ${back.error}`);
    check('what was recorded is still there',
      after.fileSize(path.join(dir, file)) === 5000,
      String(after.fileSize(path.join(dir, file))));
    check('and the recording is picked back up rather than written off',
      back.status === 'interrupted', back.status);

    const enc2 = fakeEncoder(after, dir);
    after.tick(Date.now() + 10 * 1000, enc2);
    check('the scheduler starts it again', after.get(row.id).status === 'recording',
      after.get(row.id).status);
    check('without touching what it already had',
      after.fileSize(path.join(dir, file)) === 5000,
      String(after.fileSize(path.join(dir, file))));
  }

  /* ---- 3. a restart AFTER the programme is over ------------------------ */
  /*
   * The other half of the same question. Nothing to go back for, so this is
   * an outcome rather than a pause — and it is `partial`, not `missed`,
   * because two of the three hours is two of the three hours.
   */
  console.log('\n  and a restart after it was over');
  {
    const { mod, dir, clock } = freshModule();
    const enc = fakeEncoder(mod, dir);
    const now = clock.at;
    const row = sched(mod, now, { start: -120 * MIN, end: -30 * MIN });
    /* Forced into the state a crash leaves behind. */
    const live = mod.get(row.id);
    live.status = 'recording';
    live.parts = [mod.nextPart(live)];
    fs.writeFileSync(path.join(dir, live.parts[0]), 'x'.repeat(9000));

    const at = require.resolve('../recordings.js');
    delete require.cache[at];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const after = require(at);
    after.load(dir, () => {});
    const back = after.get(row.id);
    console.log(`    ${back.status} — ${back.error}`);
    check('a window that has closed is not picked back up',
      back.status !== 'interrupted', back.status);
    check('and what was caught is called partial rather than missed',
      back.status === 'partial', back.status);
    void enc;
  }

  /* ---- 4. a person stopping it is a decision --------------------------- */
  /*
   * The one thing that must NOT be picked back up. Somebody taking the
   * connection back mid-programme, and the box starting again ten seconds
   * later, is the box arguing with the button.
   */
  console.log('\n  but a person stopping it means it');
  {
    const { mod, dir, clock } = freshModule();
    const enc = fakeEncoder(mod, dir);
    let now = clock.at;
    const row = sched(mod, now, { end: 180 * MIN });
    mod.tick(now, enc);
    enc.write(mod.get(row.id), 1000);

    mod.cancel(row.id, { reason: 'Stopped to free the connection.' });
    const stopped = mod.get(row.id);
    console.log(`    ${stopped.status} — ${stopped.error}`);
    check('it stops', stopped.status !== 'recording', stopped.status);
    check('and keeps what it caught', mod.bytesOf(stopped) === 1000,
      String(mod.bytesOf(stopped)));

    const wasParts = mod.partsOf(stopped).length;
    for (let i = 0; i < 6; i += 1) {
      now = clock.at += 60 * 1000;
      mod.tick(now, enc);
    }
    const later = mod.get(row.id);
    check('and six minutes of scheduler passes do not restart it',
      later.status !== 'recording', later.status);
    check('nor open another part behind somebody’s back',
      mod.partsOf(later).length === wasParts,
      `${wasParts} → ${mod.partsOf(later).length}`);
  }

  /* ---- 5. a channel that is simply not there --------------------------- */
  /*
   * Retrying forever is right; retrying every twenty seconds forever is a
   * provider being hammered all night by a box that has already been told no.
   * A start that wrote NOTHING backs off in minutes; one that was recording
   * and dropped comes back in seconds. Both keep trying.
   */
  console.log('\n  a channel that will not come up at all');
  {
    const { mod, dir, clock } = freshModule();
    let now = clock.at;
    const row = sched(mod, now, { end: 180 * MIN });
    let attempts = 0;
    const dead = {
      begin: (r) => {
        attempts += 1;
        mod.nextPart(r);
        mod.noteFailure(r, 'The provider refused the connection.');
      },
    };
    /* Ten minutes of scheduler passes, every twenty seconds. */
    for (let i = 0; i < 30; i += 1) {
      mod.tick(now, dead);
      now = clock.at += 20 * 1000;
    }
    console.log(`    ${attempts} attempts in ten minutes`);
    check('it keeps trying rather than giving up', attempts > 1, String(attempts));
    check('but backs off instead of hammering every pass',
      attempts <= 6, `${attempts} attempts in 30 passes`);
    check('and is still trying at the end of the window',
      mod.get(row.id).status === 'failed' || mod.get(row.id).status === 'scheduled',
      mod.get(row.id).status);
    void dir;
  }

  /* ---- 6. a feed that keeps dropping ----------------------------------- */
  /*
   * The realistic bad night: a channel that works but drops every few minutes.
   * The backoff must not slide into five-minute gaps, because each gap is a
   * hole in the programme — a part that wrote something proves the channel
   * works and starts the ladder over.
   */
  console.log('\n  a feed that drops again and again');
  {
    const { mod, dir, clock } = freshModule();
    const enc = fakeEncoder(mod, dir);
    let now = clock.at;
    const row = sched(mod, now, { end: 180 * MIN });
    const gaps = [];
    for (let i = 0; i < 5; i += 1) {
      mod.tick(now, enc);
      if (mod.get(row.id).status !== 'recording') {
        /* Not back yet — let the clock run and try again. */
        now = clock.at += 10 * 1000;
        i -= 1;
        continue;
      }
      enc.write(mod.get(row.id), 500);
      const droppedAt = now;
      mod.ended(row.id, 1);
      /* How long until it is recording again. */
      let waited = 0;
      while (mod.get(row.id).status !== 'recording' && waited < 5 * MIN) {
        now = clock.at += 5 * 1000;
        waited = now - droppedAt;
        mod.tick(now, enc);
      }
      gaps.push(Math.round(waited / 1000));
    }
    console.log(`    gaps in seconds: ${JSON.stringify(gaps)}`);
    check('every drop is picked back up', gaps.length === 5, JSON.stringify(gaps));
    check('and none of them costs more than half a minute',
      gaps.every((g) => g <= 35), JSON.stringify(gaps));
    check('with every stretch kept as its own part',
      mod.partsOf(mod.get(row.id)).length >= 5,
      String(mod.partsOf(mod.get(row.id)).length));
    check('and the total caught is all of them added up',
      mod.bytesOf(mod.get(row.id)) === 2500, String(mod.bytesOf(mod.get(row.id))));
  }

  /* ---- 7. the window closing is the end -------------------------------- */
  console.log('\n  and the window closing ends it');
  {
    const { mod, dir, clock } = freshModule();
    const enc = fakeEncoder(mod, dir);
    let now = clock.at;
    const row = sched(mod, now, { end: 30 * MIN });
    mod.tick(now, enc);
    enc.write(mod.get(row.id), 4000);

    const joined = [];
    now = clock.at += 40 * MIN;      // past the end plus the tail
    mod.tick(now, { ...enc, join: (r) => joined.push(r.id) });
    const end = mod.get(row.id);
    console.log(`    ${end.status}, ${mod.partsOf(end).length} part(s)`);
    check('it finishes', end.status === 'done', end.status);
    check('and stops being restarted once the programme is over',
      mod.partsOf(end).length === 1, String(mod.partsOf(end).length));
    void joined;
  }

  /* ---- 8. several parts get joined ------------------------------------- */
  /*
   * The box does the joining — this module does not know what ffmpeg is — so
   * what is checked here is that it is ASKED to, once, on every path that
   * ends a recording.
   */
  console.log('\n  and several parts are handed over to be joined');
  {
    const { mod, dir, clock } = freshModule();
    const enc = fakeEncoder(mod, dir);
    let now = clock.at;
    const row = sched(mod, now, { end: 30 * MIN });
    mod.tick(now, enc);
    enc.write(mod.get(row.id), 1000);
    mod.ended(row.id, 1);
    now = clock.at += 10 * 1000;
    mod.tick(now, enc);
    enc.write(mod.get(row.id), 1000);

    const joined = [];
    const hooks = { ...enc, join: (r) => joined.push(mod.partsOf(r).length) };
    now = clock.at += 40 * MIN;
    mod.tick(now, hooks);
    mod.tick(now + 1000, hooks);
    console.log(`    join asked for with ${JSON.stringify(joined)} parts`);
    check('the box is asked to join them', joined.length >= 1, JSON.stringify(joined));
    check('and told about both parts', joined[0] === 2, JSON.stringify(joined));
    void dir;
  }

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
