/**
 * A recording that could not start is tried again.
 *
 * "last night i recorded something overnight that said 'failed' this morning.
 *  But there was no disconnection from the pi last night. I didnt force any
 *  restarts but it might be auto updating still?"
 *
 * It was not the updater, and the state says so. A restart lands on `partial`
 * or `missed` carrying "The box restarted while this was recording" — that is
 * what load() writes over a row it finds mid-flight. `failed` is a different
 * word for a different thing, and it means exactly one thing in this file:
 * NOTHING WAS WRITTEN.
 *
 * All three places that set it agree on that. ffmpeg exiting with an empty
 * file; a stall detected before the first byte ever arrived; a refusal to
 * start at all, for want of disk or a process. So the provider was asked and
 * gave nothing back.
 *
 * THE FAULT IS THAT ONE ASK WAS THE ONLY ASK. The scheduler starts rows whose
 * status is `scheduled` and nothing else, so a failure at the first minute of
 * an eight-hour window ended it there — and an overnight booking is precisely
 * the case that cannot ask anybody to press retry. One momentarily full slot
 * at two in the morning cost the whole night, and the morning showed "failed"
 * with no hint that a single retry would have caught it.
 *
 * Nothing written means nothing to lose, which is what makes this safe: there
 * is no footage for a fresh attempt to overwrite. A recording that HAS
 * written something is left alone — picking that up again needs the file in
 * parts, and is not what this is.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const recordings = require('../recordings.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const MIN = 60 * 1000;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recretry-'));
  recordings.load(dir, () => {});

  /* An overnight booking: starts now, runs eight hours. */
  const started = [];
  const hooks = { begin: (r) => { if (r.id === mine) started.push(r.id); } };
  const row = recordings.schedule({
    channelId: '700', channelName: 'ESPN', title: 'The Overnight Thing',
    startsAt: Date.now(), endsAt: Date.now() + 8 * 60 * MIN,
  });
  const mine = row.id;

  /* ---- the first attempt, and its failure ------------------------------- */
  console.log('\n  the provider gives nothing back at two in the morning');
  let now = Date.now();
  recordings.tick(now, hooks);
  check('the box tries to start it', started.length === 1, JSON.stringify(started));

  /* ffmpeg came up and exited having written nothing — which is the state the
     morning showed. */
  recordings.began(recordings.get(row.id), { proc: { kill() {} }, release: null,
    source: 'provider' });
  recordings.ended(row.id, 1);
  const dead = recordings.get(row.id);
  console.log('   after the first try:', JSON.stringify(
    { status: dead.status, bytes: dead.bytes, error: dead.error }));
  check('and it is recorded as failed, with nothing written',
    dead.status === 'failed' && !dead.bytes, JSON.stringify(dead.status));
  /* The distinction the question turns on: this is not the sentence a restart
     leaves behind. */
  check('which is not the sentence a restart would have left',
    !/restarted/i.test(dead.error || ''), dead.error);

  /* ---- and it is asked again -------------------------------------------- */
  console.log('\n  and it does not give up on the night');
  recordings.tick(now + 5 * 1000, hooks);
  check('not instantly — that would be a spin, not a retry',
    started.length === 1, JSON.stringify(started));

  recordings.tick(now + 70 * 1000, hooks);
  console.log('   attempts:', started.length, JSON.stringify(recordings.get(row.id).status));
  /* The whole fix. One refused connection must not end an eight-hour window
     at its first minute. */
  check('a minute later it tries again', started.length === 2, JSON.stringify(started));

  /* Backing off, so a channel that is genuinely gone is not hammered all
     night: a minute, then two, then three. Timed from the FAILURE, which is
     where the wait is measured from — the second attempt has now been made,
     so the next one owes two minutes. */
  recordings.began(recordings.get(row.id), { proc: { kill() {} }, release: null });
  recordings.ended(row.id, 1);
  const failedAt = recordings.get(row.id).finishedAt;
  recordings.tick(failedAt + 90 * 1000, hooks);
  check('and the wait grows rather than staying at a minute',
    started.length === 2, `${started.length} attempts after 90s of a 2 min wait`);
  recordings.tick(failedAt + 130 * 1000, hooks);
  console.log('   attempts now:', started.length);
  check('but it does come round again', started.length === 3, String(started.length));

  /* ---- until the programme is over -------------------------------------- */
  console.log('\n  and it stops trying once the programme has gone');
  recordings.began(recordings.get(row.id), { proc: { kill() {} }, release: null });
  recordings.ended(row.id, 1);
  const past = Date.now() + 9 * 60 * MIN;
  const before = started.length;
  recordings.tick(past, hooks);
  console.log('   after the window:', JSON.stringify(recordings.get(row.id).status));
  check('nothing is started for a programme that has finished',
    started.length === before, `${started.length} vs ${before}`);

  /* ---- a person switching it off is not a fault ------------------------- */
  /*
   * Stopping a recording to take the connection back also lands on `failed`
   * when it had not written anything yet. Retrying that would be the box
   * arguing with whoever pressed the button.
   */
  console.log('\n  and a recording somebody switched off stays off');
  const byHand = recordings.schedule({
    channelId: '701', channelName: 'NBC', title: 'The One Switched Off',
    startsAt: Date.now(), endsAt: Date.now() + 4 * 60 * MIN,
  });
  const handStarted = [];
  const handHooks = { begin: (r) => { if (r.id === byHand.id) handStarted.push(r.id); } };
  recordings.tick(Date.now(), handHooks);
  recordings.began(recordings.get(byHand.id), { proc: { kill() {} }, release: null });
  recordings.cancel(byHand.id, { reason: 'Stopped to free the connection.' });
  const off = recordings.get(byHand.id);
  console.log('   ', JSON.stringify({ status: off.status, byHand: off.byHand }));
  const wasStarted = handStarted.length;
  recordings.tick(Date.now() + 10 * MIN, handHooks);
  check('it is not started again behind their back',
    handStarted.length === wasStarted, `${handStarted.length} vs ${wasStarted}`);

  /* ---- and one that recorded something is left alone -------------------- */
  /*
   * The safety this rests on. A fresh attempt overwrites the file, so it may
   * only ever run when there is nothing in it — half a programme is worth
   * more than a retry.
   */
  console.log('\n  and a half-written one is not started over the top of itself');
  const partial = recordings.schedule({
    channelId: '702', channelName: 'FOX', title: 'The Half One',
    startsAt: Date.now(), endsAt: Date.now() + 4 * 60 * MIN,
  });
  const partStarted = [];
  const partHooks = { begin: (r) => { if (r.id === partial.id) partStarted.push(r.id); } };
  recordings.tick(Date.now(), partHooks);
  recordings.began(recordings.get(partial.id), { proc: { kill() {} }, release: null });
  /* Something on disk, and then the feed dies. */
  fs.writeFileSync(path.join(dir, recordings.get(partial.id).file), Buffer.alloc(4096));
  recordings.ended(partial.id, 1);
  const half = recordings.get(partial.id);
  console.log('   ', JSON.stringify({ status: half.status, bytes: half.bytes }));
  check('what was written makes it a partial, not a failure',
    half.status === 'partial' && half.bytes > 0, JSON.stringify(half.status));
  const wasPart = partStarted.length;
  recordings.tick(Date.now() + 10 * MIN, partHooks);
  check('and nothing restarts on top of it',
    partStarted.length === wasPart, `${partStarted.length} vs ${wasPart}`);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
