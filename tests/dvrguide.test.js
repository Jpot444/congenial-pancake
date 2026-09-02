/**
 * The schedule, as the way in to the DVR — and as something you can scroll.
 *
 * "I want to access the DVR start by clicking on whatever show i want to
 *  record in the listings. I also want the listings to have a feature where
 *  I can scroll to later times to see what is on later"
 *
 * Two requests about the same grid, and they belong together because they
 * answer each other: the reason to look at nine o'clock is to do something
 * about what is on then, and the only thing worth doing about a programme
 * that has not started is to keep it.
 *
 * The recording engine has been on the box since the drive was repartitioned
 * — POST a channel and two timestamps and the scheduler opens the file a
 * minute early and closes it three minutes late. Nothing on any screen had
 * ever pressed it. This suite is about the screen.
 *
 * The two claims, stated so they can fail:
 *
 *   1. THE WINDOW MOVES. The grid draws four hours starting with this one,
 *      and Later walks it forward two at a time to eight hours out. The
 *      clock along the top says so, the now-line is only drawn while now is
 *      actually in view, and the way back is one press rather than four.
 *
 *   2. PRESSING A PROGRAMME ASKS. It used to tune the channel silently,
 *      which is one of the two things somebody could have meant. Now it
 *      offers both, and Record posts the programme's own start and stop —
 *      in milliseconds, which is what the store keys on and NOT what the
 *      listing carries, so the conversion is the bug this test exists to
 *      catch. Afterwards the slab says it is being kept, without the grid
 *      being redrawn.
 */
const { chromium } = require('./playwright.js');

const BASE = 'http://127.0.0.1:8481';
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const CHANS = Array.from({ length: 3 }, (_, i) => ({
  kind: 'live', id: String(700 + i), name: `US: CHANNEL ${i} ᴴᴰ`, num: 100 + i,
  categoryId: 'sport',
}));

/* The grid starts at the top of the current hour, so the listings are built
   from that rather than from now — otherwise "the second hour" lands in a
   different place depending on what minute the suite is run at. */
const HOUR = 3600;
const top = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
/* Twelve hours of hourly programmes from the top of this hour, which is what
   the box's own /api/epg/now window covers. Named by the hour they are in so
   an assertion can say which one it expected to see. */
const LISTINGS = (id) => Array.from({ length: 12 }, (_, h) => ({
  title: `${id} hour ${h}`,
  start: top + h * HOUR,
  stop: top + (h + 1) * HOUR,
}));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/epg/now*', (r) => {
    const ids = String(new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ channels: ids.map((id) => ({
        id, known: true, listings: LISTINGS(id) })) }) });
  });

  /* The recording store, stood up in the test rather than on the box: this
     suite is about what the screen sends and what it does with the answer,
     and the store itself has its own suite. */
  const booked = [];
  const posts = [];
  const deletes = [];
  await page.route('**/api/recordings', (r) => {
    if (r.request().method() === 'POST') {
      const body = JSON.parse(r.request().postData() || '{}');
      posts.push(body);
      const row = {
        id: `rec-${posts.length}`,
        channelId: String(body.channelId),
        channelName: body.channelName,
        title: body.title,
        startsAt: Number(body.startsAt),
        endsAt: Number(body.endsAt),
        status: 'scheduled',
        bytes: 0,
      };
      booked.push(row);
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ recording: row }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: booked, active: [], free: 1, capacity: 2 }) });
  });
  await page.route('**/api/recordings/*', (r) => {
    const id = r.request().url().split('/').pop();
    if (r.request().method() === 'DELETE') {
      deletes.push(id);
      const at = booked.findIndex((row) => row.id === id);
      if (at >= 0) booked.splice(at, 1);
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: '{"removed":true}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1400);
  }

  await page.evaluate(async (items) => {
    state.config.mode = 'xtream';
    state.library.live = { categories: [{ id: 'sport', name: 'Sport' }], items };
    state.tab = 'live';
    state.query = '';
    state.category = 'sport';
    state.listings = false;
    location.hash = '#/live';
    await new Promise((r) => setTimeout(r, 400));
    state.category = 'sport';
    document.querySelector('#listingsBtn').click();
    await new Promise((r) => setTimeout(r, 1400));
  }, CHANS);

  /** What the grid is showing: the clock along the top and the first row. */
  const look = () => page.evaluate(() => ({
    hours: [...document.querySelectorAll('.listings-guide .guide-hour')]
      .map((h) => h.textContent),
    when: document.querySelector('.listings-guide .guide-nav-when')?.textContent || '',
    whenOff: document.querySelector('.listings-guide .guide-nav-when')?.disabled,
    backOff: document.querySelector('.listings-guide .guide-nav-btn')?.disabled,
    laterOff: [...document.querySelectorAll('.listings-guide .guide-nav-btn')]
      .pop()?.disabled,
    nowLine: document.querySelectorAll('.listings-guide .guide-now-line').length,
    titles: [...document.querySelectorAll(
      '.listings-guide .guide-row:first-child .guide-prog-title')].map((t) => t.textContent),
  }));

  const press = (label) => page.evaluate((want) => {
    const button = [...document.querySelectorAll(
      '.listings-guide .guide-nav-btn, .listings-guide .guide-nav-when')]
      .find((b) => b.textContent.includes(want));
    button.click();
    return new Promise((r) => setTimeout(r, 1400));
  }, label);

  /* ---- 1. the window moves --------------------------------------------- */
  /*
   * Which programme "this hour" is, asked of the screen rather than of a
   * number worked out when this file was loaded.
   *
   * The listings are built from the top of the current hour, and so were the
   * expectations — both frozen at import. If the hour rolls over at any point
   * during this suite, the box moves on and the frozen expectations do not,
   * and every assertion below fails by exactly one in the same direction. That
   * really happened, in a sweep that crossed an hour boundary, and it read as
   * a routing bug because the sweep it happened in had touched routing.
   *
   * So the first hour on screen is read once, and everything after it is
   * counted from there. What this suite is actually about is how the window
   * MOVES — four across, two per press, eight and no further — and none of
   * that cares which hour of the day it started in.
   */
  console.log('\n  the schedule starts where it always did');
  const at0 = await look();
  const base = Number((/hour (\d+)/.exec(at0.titles[0] || '') || [])[1]);
  const hours = (from, count = 4) =>
    Array.from({ length: count }, (_, i) => `700 hour ${from + i}`).join(',');
  check('the first row is a programme this fixture put there',
    Number.isFinite(base), JSON.stringify(at0.titles[0]));
  console.log('   ', JSON.stringify(at0));
  check('four hours across the top, beginning with this one',
    at0.hours.length === 4, JSON.stringify(at0.hours));
  check('the line at now is drawn, because now is on screen',
    at0.nowLine === 1, String(at0.nowLine));
  check('and it says it is showing now', at0.when === 'On now', at0.when);
  check('with nothing earlier to go back to', at0.backOff === true, String(at0.backOff));
  check('the first row is this hour and the three after it',
    at0.titles.join(',') === hours(base), JSON.stringify(at0.titles));

  console.log('\n  and Later walks it forward');
  await press('Later');
  const at2 = await look();
  console.log('   ', JSON.stringify(at2));
  /* Two hours, not four: the window overlaps itself so pressing Later reads
     as scrolling rather than as being handed an unrelated page. */
  check('two hours on, so half of what was on screen comes with it',
    at2.hours[0] === at0.hours[2] && at2.hours[1] === at0.hours[3],
    JSON.stringify([at0.hours, at2.hours]));
  check('and the programmes in it are the later ones',
    at2.titles.join(',') === hours(base + 2), JSON.stringify(at2.titles));
  /* The window now begins two hours from the top of this hour, so now is
     behind its left edge and the line goes with it. */
  check('now has gone off the left edge, so its line goes too',
    at2.nowLine === 0, String(at2.nowLine));
  check('the label stops saying "on now" and says when it is',
    at2.when !== 'On now' && /\d/.test(at2.when), at2.when);
  check('and going back is now offered', at2.backOff === false, String(at2.backOff));

  console.log('\n  as far as the box can answer, and no further');
  await press('Later');
  await press('Later');
  const at6 = await look();
  await press('Later');
  const at8 = await look();
  console.log('   ', JSON.stringify(at8));
  check('eight hours out is the far end',
    at8.titles.join(',') === hours(base + 8), JSON.stringify(at8.titles));
  check('and Later stops offering itself there',
    at6.laterOff === false && at8.laterOff === true,
    JSON.stringify([at6.laterOff, at8.laterOff]));
  /* Now is four hours behind the left edge. A line pinned to that edge would
     be claiming the whole window is still ahead of itself. */
  check('the line at now is not drawn over a window now is not in',
    at8.nowLine === 0, String(at8.nowLine));

  console.log('\n  and the way back is one press, not four');
  await press(at8.when);
  const back = await look();
  console.log('   ', JSON.stringify(back));
  check('pressing the label returns to now',
    back.when === 'On now' && back.titles[0] === `700 hour ${base}`,
    JSON.stringify(back));

  /* ---- 2. pressing a programme ----------------------------------------- */
  console.log('\n  pressing a programme asks what you meant');
  await press('Later');            // so the programme is in the future
  const opened = await page.evaluate(async () => {
    const slabs = [...document.querySelectorAll(
      '.listings-guide .guide-row:first-child .guide-prog')];
    slabs[1].click();              // hour 3, an hour or two out
    await new Promise((r) => setTimeout(r, 600));
    return {
      open: !document.querySelector('#progModal').hidden,
      title: document.querySelector('#progTitle').textContent,
      chan: document.querySelector('#progChan').textContent,
      when: document.querySelector('#progWhen').textContent,
      record: document.querySelector('#progRecord').textContent,
      recordHidden: document.querySelector('#progRecord').hidden,
      watch: document.querySelector('#progWatch').textContent,
    };
  });
  console.log('   ', JSON.stringify(opened));
  check('a sheet opens rather than the channel', opened.open === true, String(opened.open));
  /* Two hours on from now, so the second slab in the row — counted from
     whichever hour the box is actually in, see `base` above. */
  check('naming the programme that was pressed',
    opened.title === `700 hour ${base + 3}`, opened.title);
  check('and the channel it is on, tidied the way the row is',
    opened.chan === 'CHANNEL 0', opened.chan);
  check('it offers to record it', opened.record === 'Record' && !opened.recordHidden,
    JSON.stringify(opened));
  check('and it still offers the thing pressing it used to do',
    opened.watch === 'Watch CHANNEL 0', opened.watch);

  console.log('\n  and Record books the programme, not the hour it was pressed in');
  await page.evaluate(async () => {
    document.querySelector('#progRecord').click();
    await new Promise((r) => setTimeout(r, 900));
  });
  console.log('   posted:', JSON.stringify(posts));
  const sent = posts[0] || {};
  check('the box is asked once', posts.length === 1, String(posts.length));
  check('for the channel the row belongs to',
    String(sent.channelId) === '700', String(sent.channelId));
  /* The listing carries seconds and the store keys on milliseconds. Got wrong
     this books a programme in 1970 and the scheduler marks it missed. */
  check('with the programme\'s own start, in milliseconds',
    sent.startsAt === (top + (base + 3) * HOUR) * 1000, `${sent.startsAt}`);
  check('and its own end',
    sent.endsAt === (top + (base + 4) * HOUR) * 1000, `${sent.endsAt}`);
  check('under the profile that asked for it', sent.profileId === 'own1', sent.profileId);

  const marked = await page.evaluate(() => {
    const slabs = [...document.querySelectorAll(
      '.listings-guide .guide-row:first-child .guide-prog')];
    return {
      rec: slabs.map((s) => s.classList.contains('is-rec')),
      dots: document.querySelectorAll('.listings-guide .guide-prog-rec').length,
      says: document.querySelector('#progRecord').textContent,
      note: document.querySelector('#progNote').textContent,
    };
  });
  console.log('   ', JSON.stringify(marked));
  check('the slab says it is being kept, and only that slab',
    marked.rec.filter(Boolean).length === 1 && marked.rec[1] === true,
    JSON.stringify(marked.rec));
  check('with a mark on it', marked.dots === 1, String(marked.dots));
  check('and the button turns into the way out of it',
    /don.t record/i.test(marked.says), marked.says);
  check('saying what the box will actually do', /minute early/.test(marked.note), marked.note);

  console.log('\n  pressing it again unbooks it');
  await page.evaluate(async () => {
    document.querySelector('#progRecord').click();
    await new Promise((r) => setTimeout(r, 900));
  });
  const undone = await page.evaluate(() => ({
    rec: [...document.querySelectorAll('.listings-guide .guide-prog')]
      .filter((s) => s.classList.contains('is-rec')).length,
    says: document.querySelector('#progRecord').textContent,
  }));
  console.log('   deleted:', JSON.stringify(deletes), JSON.stringify(undone));
  check('the box is told to drop it', deletes.length === 1, JSON.stringify(deletes));
  check('and the grid stops claiming it', undone.rec === 0, String(undone.rec));
  check('and offers to record it again', undone.says === 'Record', undone.says);

  console.log('\n  and Watch is still there for whoever meant that');
  const watched = await page.evaluate(async () => {
    document.querySelector('#progWatch').click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      sheet: document.querySelector('#progModal').hidden,
      player: !document.querySelector('#playerOverlay').hidden,
    };
  });
  console.log('   ', JSON.stringify(watched));
  check('the sheet closes and the channel opens',
    watched.sheet === true && watched.player === true, JSON.stringify(watched));

  await page.evaluate(() => closePlayer());
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
