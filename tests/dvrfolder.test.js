/**
 * Why nothing you recorded was ever there, and where recordings live now.
 *
 * "I'm not convinced it is recording things because nothing I have recorded
 *  has saved, but it might have been because i launched updates. I want to see
 *  a progress in my downloads folder that shows what I have downloading and
 *  that it is processing it. I also want to be able to access my saved DVR
 *  recordings from the downloads folder"
 *
 * The guess in the middle of that sentence was right.
 *
 * ── THE BOX RESTARTED ON TOP OF THEM ─────────────────────────────────────
 * beginRecording spawns ffmpeg itself. It never touches providerStreams,
 * opens no remux session and starts no download — so /api/activity, which is
 * the only thing the auto-updater asks, had every one of its flags false
 * while a two-hour programme was being written. The updater read that as an
 * idle box, pulled, and restarted the portal. ffmpeg went with it, and the
 * row came back as `partial` or `missed` carrying "The box restarted while
 * this was recording."
 *
 * Nobody is in the room when this happens. That is the entire point of
 * recording, and it is why an unattended job has to shout louder than a
 * watched one, not quieter.
 *
 * A recording is also the one kind of busy that knows when it ends, so it
 * says so: the updater holds ten minutes and then goes anyway — correct for
 * "somebody is watching", fatal for a ball game — and a recording can name
 * the moment it is done instead.
 *
 * ── AND THEY WERE INVISIBLE ──────────────────────────────────────────────
 * Recordings only ever appeared in the guide, on the slab of the programme
 * they came from. So a finished one lived at a spot in a grid of times that
 * had already scrolled out of the week, and no page answered "what have I
 * recorded" or "is it recording right now". They are on the downloads page
 * now, which is already the page for what is on the box.
 */
const { chromium } = require('./playwright.js');
const BASE = 'http://127.0.0.1:8481';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const now = Date.now();
const RECORDINGS = [
  { id: 'r1', channelId: '700', channelName: 'ESPN', title: 'The Ball Game',
    startsAt: now - 40 * 60000, endsAt: now + 80 * 60000, status: 'recording',
    file: 'r1.mp4', bytes: 900 * 1024 * 1024 },
  { id: 'r2', channelId: '701', channelName: 'NBC', title: 'Last Night\'s Film',
    startsAt: now - 26 * 3600000, endsAt: now - 24 * 3600000, status: 'done',
    file: 'r2.mp4', bytes: 3.2 * 1024 ** 3 },
  { id: 'r3', channelId: '702', channelName: 'FOX', title: 'The One That Was Lost',
    startsAt: now - 50 * 3600000, endsAt: now - 48 * 3600000, status: 'partial',
    file: 'r3.mp4', bytes: 140 * 1024 * 1024,
    error: 'The box restarted while this was recording.' },
  { id: 'r4', channelId: '703', channelName: 'CBS', title: 'On Later',
    startsAt: now + 3 * 3600000, endsAt: now + 5 * 3600000, status: 'scheduled',
    file: '', bytes: 0 },
];

(async () => {
  /* ---- the box says it is busy while it is writing ---------------------- */
  /*
   * Asked of the real endpoint on the real box, because this is the one that
   * decides whether a deploy lands on top of a recording — and it is a
   * server-side question that no amount of browser testing would reach.
   */
  console.log('\n  what the updater is told');
  const idle = await (await fetch(`${BASE}/api/activity`)).json();
  console.log('   idle:', JSON.stringify(idle));
  check('an idle box reports itself idle', idle.busy === false, JSON.stringify(idle));
  /* The flag has to EXIST, or the updater is reading a field that is not
     there and every recording is unprotected again. */
  check('and answers the recording question at all',
    'recording' in idle && 'recordingUntil' in idle, JSON.stringify(idle));
  check('with nothing being recorded', idle.recording === false, JSON.stringify(idle));

  const booked = await (await fetch(`${BASE}/api/recordings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /* Starting now and running two hours — a ball game, which is the case
       that was being destroyed at the ten minute mark. */
    body: JSON.stringify({ channelId: '700', channelName: 'ESPN',
      title: 'The Ball Game', startsAt: Date.now(), endsAt: Date.now() + 7200_000 }),
  })).json();
  console.log('   booked:', JSON.stringify(booked.recording?.status));

  const during = await (await fetch(`${BASE}/api/activity`)).json();
  console.log('   while recording:', JSON.stringify(during));
  /* ffmpeg is not installed in this container, so the row cannot reach
     `recording` — which is the honest limit of what can be checked here, and
     it is checked rather than glossed over. */
  if (during.recording) {
    check('a running recording makes the box busy', during.busy === true,
      JSON.stringify(during));
    /* Ten minutes is the general hold and a game is three hours. Without an
       end time the protection above expires halfway through the second
       inning. */
    check('and says when it will be done, so the hold can outlast ten minutes',
      Number(during.recordingUntil) > Date.now() + 3600_000,
      String(during.recordingUntil));
  } else {
    console.log('   (no ffmpeg in this container — the running case is not reachable here)');
    check('the endpoint still carries the field the updater reads',
      during.recording === false && during.recordingUntil === null,
      JSON.stringify(during));
  }
  await fetch(`${BASE}/api/recordings/${booked.recording.id}`, { method: 'DELETE' });

  /* ---- and they are on the downloads page ------------------------------- */
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"categories":[],"items":[],"totals":{"items":0}}' }));
  await page.route('**/api/downloads**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"items":[],"active":null,"queued":0}' }));
  await page.route('**/api/recordings', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: RECORDINGS, active: ['r1'] }) }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible().catch(() => false)) {
    await page.locator('.profile-tile').first().click();
    await wait(1200);
  }
  await page.evaluate(() => { location.hash = '#/downloads'; });
  await page.waitForSelector('.rec-card', { timeout: 10000 });
  await wait(500);

  console.log('\n  the downloads page');
  const shown = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.rec-card')].map((c) => ({
      title: c.querySelector('.card-title')?.textContent || '',
      sub: c.querySelector('.card-sub')?.textContent || '',
      badge: c.querySelector('.dl-badge')?.textContent || '',
      bar: c.querySelector('.dl-artfill')?.style.width || '',
      buttons: [...c.querySelectorAll('.dl-actions button')].map((b) => b.textContent),
    })),
    sections: [...document.querySelectorAll('.dl-section h2')].map((h) => h.textContent),
    meta: document.querySelector('#contentMeta')?.textContent || '',
  }));
  console.log('   sections:', JSON.stringify(shown.sections));
  for (const c of shown.cards) console.log('   ', JSON.stringify(c));

  /* Nothing has been DOWNLOADED here at all — the page used to say "Nothing
     saved yet" over four recordings sitting on the drive. */
  check('recordings show even with no downloads',
    shown.cards.length === 4, String(shown.cards.length));
  check('under a heading of their own',
    shown.sections.includes('Recordings'), JSON.stringify(shown.sections));

  const live = shown.cards.find((c) => /Ball Game/.test(c.title));
  console.log('   live:', JSON.stringify(live));
  /* The literal request: something on this page that shows it is happening. */
  check('the one being written says so', /RECORDING/.test(live.badge), live.badge);
  check('and has a progress bar that is part way along',
    parseFloat(live.bar) > 20 && parseFloat(live.bar) < 60, live.bar);
  check('and says how much longer and how big it is so far',
    /min to go/.test(live.sub) && /MB|GB/.test(live.sub), live.sub);
  /* A recording in progress is written so that what exists on disk plays, so
     the game can be watched from the beginning while the rest arrives. */
  check('and can be watched from the start already',
    live.buttons.some((b) => /watch from the start/i.test(b)), JSON.stringify(live.buttons));
  check('and stopped from here', live.buttons.some((b) => /stop/i.test(b)),
    JSON.stringify(live.buttons));

  const kept = shown.cards.find((c) => /Last Night/.test(c.title));
  console.log('   kept:', JSON.stringify(kept));
  /* The other half of the request: reaching a finished recording at all. */
  check('a finished recording is playable from here',
    kept.buttons.some((b) => /^play$/i.test(b)), JSON.stringify(kept.buttons));
  check('and says how big it is', /GB/.test(kept.sub), kept.sub);

  const lost = shown.cards.find((c) => /Lost/.test(c.title));
  console.log('   lost:', JSON.stringify(lost));
  /* The state this box has been quietly producing, and the sentence that
     explains a folder full of stubs. */
  check('one cut short says what happened to it',
    /restarted/i.test(lost.sub), lost.sub);
  check('and still offers the part that was written',
    lost.buttons.some((b) => /^play$/i.test(b)), JSON.stringify(lost.buttons));

  const later = shown.cards.find((c) => /On Later/.test(c.title));
  check('a booked one shows as booked and can be called off',
    /BOOKED/.test(later.badge) && later.buttons.some((b) => /cancel/i.test(b)),
    JSON.stringify(later));
  /* Nothing has been written yet, so there is nothing to play. */
  check('and offers nothing to play', !later.buttons.some((b) => /play/i.test(b)),
    JSON.stringify(later.buttons));

  check('and the count at the top mentions what is happening now',
    /recording now/.test(shown.meta), shown.meta);

  /* ---- the bar actually moves ------------------------------------------- */
  /*
   * A progress bar that only redraws when something else happens to change is
   * not progress. The page's own poll has to notice a file growing.
   */
  console.log('\n  and it keeps up');
  const before = await page.evaluate(() =>
    document.querySelector('.rec-card .dl-artfill')?.style.width);
  await page.evaluate(() => {
    // The same recording, further along and bigger.
    const row = state.recordings.find((r) => r.id === 'r1');
    row.startsAt = Date.now() - 100 * 60000;
    row.bytes = 2 * 1024 ** 3;
    renderDownloads();
  });
  await wait(300);
  const after = await page.evaluate(() => ({
    bar: document.querySelector('.rec-card .dl-artfill')?.style.width,
    sub: document.querySelector('.rec-card .card-sub')?.textContent || '',
  }));
  console.log('   ', JSON.stringify({ before, after }));
  check('the bar moves as the recording grows',
    parseFloat(after.bar) > parseFloat(before), JSON.stringify({ before, after }));
  check('and so does the size beside it', /GB/.test(after.sub), after.sub);

  await page.close();
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
