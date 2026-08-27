/**
 * Closed captions, and the speed pill that is no longer over the picture.
 *
 * Three layers, and they are checked separately because they fail separately:
 *
 *   1. **Reading the source.** `parseProbe` turns ffprobe's flat key=value
 *      output into the subtitle tracks. Picture subtitles — PGS off a Blu-ray,
 *      VobSub off a DVD — are pictures of words, and converting one to WebVTT
 *      is OCR rather than a remux, so they must not be offered.
 *   2. **Asking ffmpeg for them.** The subtitle files ride the SAME ffmpeg run
 *      as extra outputs. A second process would be a second read of the source,
 *      and on a provider that allows one connection the second read is the one
 *      that fails. Just as important: nothing is added when nothing is known to
 *      be there, because an output with no streams in it kills the whole
 *      command — the picture included.
 *   3. **The button.** In the bottom row, only when there is something behind
 *      it, remembering the language across films.
 *
 * ffmpeg is not installed on the machine this runs on, so layers 1 and 2 are
 * checked as what is *asked for* rather than what comes back. That is the
 * honest limit of what can be verified here and it is stated rather than
 * papered over.
 */
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const SERVER = fs.readFileSync(PATHS.SERVER, 'utf8');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The player's chrome fades after three idle seconds and stops taking clicks
 * with it. A person moves the mouse and it comes back; a test that clicked
 * through the fade would be testing something nobody can do.
 */
const wake = async (page) => {
  await page.mouse.move(640, 500);
  await page.mouse.move(640, 700);
  await wait(250);
};

/** The source text of a named function, straight out of the shipped server. */
function source(name) {
  const start = SERVER.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} in server.js`);
  let depth = 0;
  let i = SERVER.indexOf('{', start);
  for (; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1;
    else if (SERVER[i] === '}' && --depth === 0) break;
  }
  return SERVER.slice(start, i + 1);
}

const TEXT_CODECS = /const TEXT_SUBTITLE_CODECS = new Set\(\[[^\]]*\]\);/.exec(SERVER)[0];
const LANG_NAMES = /const LANGUAGE_NAMES = \{[\s\S]*?\n\};/.exec(SERVER)[0];

// eslint-disable-next-line no-new-func
const parseProbe = new Function(
  `${TEXT_CODECS}\n${source('parseProbe')}\nreturn parseProbe;`)();
// eslint-disable-next-line no-new-func
const subtitleLabel = new Function(
  `${LANG_NAMES}\n${source('subtitleLabel')}\nreturn subtitleLabel;`)();

// A film as this provider actually ships them: HEVC, one audio track, a couple
// of text subtitle tracks, and a picture-based one that cannot become WebVTT.
const PROBE_OUT = `index=0
codec_name=hevc
codec_type=video
index=1
codec_name=aac
codec_type=audio
TAG:language=eng
index=2
codec_name=subrip
codec_type=subtitle
TAG:language=eng
index=3
codec_name=subrip
codec_type=subtitle
TAG:language=spa
TAG:title=Latin America
index=4
codec_name=hdmv_pgs_subtitle
codec_type=subtitle
TAG:language=fre
duration=6134.208000
`;

(async () => {
  // --- reading the source --------------------------------------------------
  console.log('\n  what the probe finds');
  const probed = parseProbe(PROBE_OUT);
  console.log('   probed:', JSON.stringify(probed));
  check('the video codec comes from the video stream, not the first stream',
    probed.codec === 'hevc', probed.codec);
  check('and the duration still comes through', probed.duration === 6134,
    String(probed.duration));
  check('both text subtitle tracks are found', probed.subs.length === 2,
    JSON.stringify(probed.subs));
  check('the picture-based one is left out — it would need OCR, not a remux',
    !probed.subs.some((s) => /pgs/.test(s.codec)), JSON.stringify(probed.subs));
  // `-map 0:s:N` counts within the subtitle streams, not across all streams.
  check('tracks are numbered the way -map 0:s:N counts them',
    probed.subs.map((s) => s.at).join() === '0,1', JSON.stringify(probed.subs));
  check('languages are carried', probed.subs.map((s) => s.lang).join() === 'eng,spa',
    JSON.stringify(probed.subs));

  const noSubs = parseProbe('index=0\ncodec_name=h264\ncodec_type=video\nduration=1.0\n');
  check('a film with no subtitles reports none rather than guessing',
    noSubs.subs.length === 0 && noSubs.codec === 'h264', JSON.stringify(noSubs));

  console.log('\n  what the tracks are called');
  check('a language code becomes a language',
    subtitleLabel({ lang: 'eng', title: '' }) === 'English',
    subtitleLabel({ lang: 'eng', title: '' }));
  check('and the file\'s own title is kept, since "Forced" and "SDH" matter',
    subtitleLabel({ lang: 'spa', title: 'Latin America' }) === 'Spanish — Latin America',
    subtitleLabel({ lang: 'spa', title: 'Latin America' }));
  check('an unknown code shows the code rather than nothing',
    subtitleLabel({ lang: 'zzz', title: '' }) === 'ZZZ',
    subtitleLabel({ lang: 'zzz', title: '' }));
  check('and a track with neither is still named something',
    subtitleLabel({ lang: '', title: '' }) === 'Subtitles');

  // --- what ffmpeg is asked for --------------------------------------------
  console.log('\n  the ffmpeg command');
  const path = require('path');
  // eslint-disable-next-line no-new-func
  const ffmpegArgs = new Function('path', 'UA',
    `${source('audioFilter')}\n${source('ffmpegArgs')}\nreturn ffmpegArgs;`)(path, 'test-agent');

  const bare = ffmpegArgs('http://x/y.mkv', '/out', 'hevc', 0, 0, 0, []);
  const withSubs = ffmpegArgs('http://x/y.mkv', '/out', 'hevc', 0, 0, 0, probed.subs);
  console.log('   added:', JSON.stringify(withSubs.slice(bare.length)));

  check('with nothing known, the command is exactly what it has always been',
    bare.join(' ') === withSubs.slice(0, bare.length).join(' '),
    bare.join(' '));
  check('and nothing subtitle-shaped is in it at all',
    !bare.join(' ').includes('0:s:') && !bare.join(' ').includes('webvtt'),
    bare.join(' '));

  const tail = withSubs.slice(bare.length).join(' ');
  check('a known track is mapped by its subtitle index',
    tail.includes('-map 0:s:0') && tail.includes('-map 0:s:1'), tail);
  check('written as WebVTT, which is what a <track> can read',
    (tail.match(/-c:s webvtt/g) || []).length === 2, tail);
  check('to its own file per track, since WebVTT holds one',
    tail.includes(path.join('/out', 'sub0.vtt'))
    && tail.includes(path.join('/out', 'sub1.vtt')), tail);
  check('the playlist output still comes first — subtitles are extra outputs '
    + 'on the same run, not a second run',
    withSubs.indexOf('-f') < withSubs.indexOf('0:s:0'), String(withSubs.indexOf('-f')));
  check('and there is still exactly one input',
    withSubs.filter((a) => a === '-i').length === 1, String(withSubs.filter((a) => a === '-i').length));

  // The safety net: if the extra outputs are what killed it, the picture wins.
  check('a failed run with subtitles retries without them',
    /if \(wanted\.length\) \{\s*\n\s*return startRemux\(input, \{ \.\.\.opts, noSubs: true \}\);/.test(SERVER)
    || SERVER.includes('return startRemux(input, { ...opts, noSubs: true });'),
    'no fallback found in startRemux');

  // --- the button ----------------------------------------------------------
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });

  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.route('**/api/fake-stream', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/wav', body: CLIP }));

  // Two subtitle files, served as the server serves them — and, when asked,
  // the way the server serves them at the very START of a conversion: a real
  // file with nothing in it yet, because ffmpeg has not reached the first
  // line of dialogue.
  const VTT = (who) => `WEBVTT\n\n00:00:00.000 --> 00:00:30.000\n${who} line\n`;
  let vttFetches = 0;
  let vttEmpty = false;
  await page.route('**/sub*.vtt*', (r) => {
    vttFetches += 1;
    const which = /sub0/.test(r.request().url()) ? 'English' : 'Spanish';
    return r.fulfill({ status: 200, contentType: 'text/vtt; charset=utf-8',
      body: vttEmpty ? 'WEBVTT\n' : VTT(which) });
  });

  let remuxSubs = [
    { lang: 'eng', label: 'English', url: '/hls/s1/sub0.vtt' },
    { lang: 'spa', label: 'Spanish — Latin America', url: '/hls/s1/sub1.vtt' },
  ];
  let complete = false;
  // '**' and not '*' before the subpath: a single star does not cross '/',
  // so '**/api/remux*' quietly let '/api/remux/status' through to the real
  // server, whose 404 stopped the caption refresher — in the TEST only.
  await page.route('**/api/remux**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/remux/status') {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ seconds: 45, complete, target: 45, failed: false, error: '' }) });
    }
    if (url.pathname === '/api/remux/stop') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"stopped":true}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ session: 's1', url: '/api/fake-stream', prebuffer: 45,
        offset: 0, sourceDuration: 5400, subs: remuxSubs }) });
  });
  await page.route('**/api/xtream*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  // The chosen track is saved to prefs.json on the server, so a previous run
  // of THIS file leaves English selected and "starts off" passes or fails by
  // whether anyone ran it before. Start from a known state.
  await page.evaluate(async () => { prefs.data.captionTrack = ''; await prefs.save(); });

  // --- the speed pill is off the picture -----------------------------------
  console.log('\n  the speed pill over the picture');
  const gone = await page.evaluate(() => ({
    el: document.querySelector('#speedWarn'),
    stillInBar: Boolean(document.querySelector('#vodSpeed')),
  }));
  console.log('   speed:', JSON.stringify(gone));
  check('the pill parked over the middle of the frame is gone', gone.el === null);
  check('but the badge in the bar stays, for the rare time a rate is meddled with',
    gone.stillInBar);
  // And it must still work: nothing here sets a rate, so the badge is the only
  // way to notice and undo an extension that has.
  const rateBadge = await page.evaluate(() => {
    const v = document.querySelector('#video');
    v.playbackRate = 0.5;
    paintSpeed();
    const shown = !document.querySelector('#vodSpeed').hidden;
    document.querySelector('#vodSpeed').click();
    return { shown, after: v.playbackRate, hidden: document.querySelector('#vodSpeed').hidden };
  });
  console.log('   badge:', JSON.stringify(rateBadge));
  check('an odd rate still shows in the bar', rateBadge.shown, JSON.stringify(rateBadge));
  check('and pressing it still puts playback back to normal',
    rateBadge.after === 1 && rateBadge.hidden, JSON.stringify(rateBadge));

  // --- the caption button --------------------------------------------------
  console.log('\n  the caption button');
  await page.evaluate(() => {
    state.library.movies = { categories: [{ id: 'm1', name: 'Films' }], items: [
      { kind: 'movie', id: 901, name: 'A Film', logo: '', ext: 'mkv', categoryId: 'm1' }] };
    state.downloads = { items: [], active: null, queued: 0 };
    location.hash = '#/movies';
    render();
  });
  await wait(500);
  const before = await page.evaluate(() => !document.querySelector('#ccWrap').hidden);
  check('there is no caption button with no player open', before === false);

  await page.evaluate(() => openPlayer(state.library.movies.items[0]));
  await wait(3000);

  const withCc = await page.evaluate(() => ({
    shown: !document.querySelector('#ccWrap').hidden,
    tracks: [...document.querySelector('#video').textTracks].map((t) => t.label),
    inBar: Boolean(document.querySelector('#vodBar').contains(document.querySelector('#ccWrap'))),
    beforeMute: document.querySelector('#ccWrap').compareDocumentPosition(
      document.querySelector('#vodMute')) & Node.DOCUMENT_POSITION_FOLLOWING,
  }));
  console.log('   cc:', JSON.stringify(withCc));
  check('a film with subtitles grows a caption button', withCc.shown, JSON.stringify(withCc));
  check('in the bottom row of the player, with the other controls',
    withCc.inBar, JSON.stringify(withCc));
  check('beside mute and fullscreen rather than off on its own',
    Boolean(withCc.beforeMute), JSON.stringify(withCc));
  check('and both tracks are attached',
    withCc.tracks.join() === 'English,Spanish — Latin America', JSON.stringify(withCc.tracks));

  // Off by default, and the menu offers off as a choice.
  await wake(page);
  await page.locator('#ccBtn').click();
  await wait(300);
  const menu = await page.evaluate(() => ({
    open: !document.querySelector('#ccMenu').hidden,
    items: [...document.querySelectorAll('.cc-item')].map((b) => b.textContent),
    on: [...document.querySelectorAll('.cc-item.is-on')].map((b) => b.textContent),
  }));
  console.log('   menu:', JSON.stringify(menu));
  check('the menu opens on the button', menu.open);
  check('with Off and every track', menu.items.join() === 'Off,English,Spanish — Latin America',
    JSON.stringify(menu.items));
  check('and starts off', menu.on.join() === 'Off', JSON.stringify(menu.on));

  await page.locator('.cc-item', { hasText: 'English' }).first().click();
  await wait(600);
  const chosen = await page.evaluate(() => ({
    modes: [...document.querySelector('#video').textTracks].map((t) => [t.label, t.mode]),
    menuClosed: document.querySelector('#ccMenu').hidden,
    lit: document.querySelector('#ccBtn').classList.contains('is-on'),
    stored: prefs.data.captionTrack,
  }));
  console.log('   chosen:', JSON.stringify(chosen));
  // 'hidden', not 'showing': the browser's own cue renderer differs per
  // WebKit device and on an iPad drew nothing at all, so cues load and fire
  // while the drawing is the app's own overlay.
  check('picking one turns it on', chosen.modes.find((m) => m[0] === 'English')[1] === 'hidden',
    JSON.stringify(chosen.modes));
  check('and leaves the others off',
    chosen.modes.filter((m) => m[1] === 'hidden').length === 1, JSON.stringify(chosen.modes));
  check('the menu closes behind you', chosen.menuClosed);
  check('the button lights up, so it reads as on with nobody speaking',
    chosen.lit, JSON.stringify(chosen));
  check('and the choice is remembered on the profile',
    chosen.stored === 'English', chosen.stored);

  // The cues actually arrived — a track element that fetched nothing would
  // pass every check above and show no subtitles at all.
  const cues = await page.evaluate(() => {
    const t = [...document.querySelector('#video').textTracks].find((x) => x.label === 'English');
    return { count: t.cues ? t.cues.length : -1, first: t.cues?.[0]?.text || '',
      line: t.cues?.[0]?.line };
  });
  console.log('   cues:', JSON.stringify(cues));
  check('the track really loaded its cues', cues.count > 0, JSON.stringify(cues));
  check('and they are the right file\'s', /English/.test(cues.first), cues.first);
  // The words on screen come from the app's own overlay, drawn the same way
  // on every platform — seek into a cue and the text must be there.
  const drawn = await page.evaluate(async () => {
    const video = document.querySelector('#video');
    video.currentTime = 2;   // inside the first cue of the fixture
    await new Promise((r) => setTimeout(r, 600));
    const t = [...video.textTracks].find((x) => x.label === 'English');
    captions.drawCues(t);    // cuechange timing varies headless; draw from state
    const box = document.querySelector('#ccOverlay');
    return { shown: !box.hidden, text: box.textContent };
  });
  console.log('   overlay:', JSON.stringify(drawn));
  check('and the app\'s own overlay draws them — the browser\'s renderer is',
    drawn.shown && /English/.test(drawn.text), JSON.stringify(drawn));
  console.log('       not trusted, because on an iPad it drew nothing');

  // Readable from a couch. The old ceiling was 24px, which on a TV-sized
  // window reads as fine print from across a room.
  const sized = await page.evaluate(() => {
    const line = document.querySelector('.cc-line');
    return line ? Math.round(parseFloat(getComputedStyle(line).fontSize)) : 0;
  });
  check('the words are sized for the far side of the room',
    sized >= 32, `${sized}px at 1280w`);

  // --- nothing else may turn them back on ----------------------------------
  //
  // hls.js manages its own in-band tracks and WebKit carries a caption picker
  // of its own; either can flip a TextTrack's mode long after Off was
  // pressed — and did, captions reappearing from a place no button press had
  // touched. The menu is the only authority: any outside flip is reverted at
  // the moment it happens.
  console.log('\n  nothing else may turn them back on');
  const meddledOn = await page.evaluate(async () => {
    const t = [...document.querySelector('#video').textTracks].find((x) => x.label !== 'English');
    t.mode = 'showing';   // an engine "helpfully" enables the other track
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelector('#video').textTracks].map((x) => [x.label, x.mode]);
  });
  check('a track somebody else turned on is put straight back off',
    meddledOn.every(([label, mode]) => mode === (label === 'English' ? 'hidden' : 'disabled')),
    JSON.stringify(meddledOn));

  const meddledOff = await page.evaluate(async () => {
    captions.choose('');
    await new Promise((r) => setTimeout(r, 150));
    const t = [...document.querySelector('#video').textTracks].find((x) => x.label === 'English');
    t.mode = 'showing';   // the engine re-enables the one you just turned off
    await new Promise((r) => setTimeout(r, 300));
    return {
      modes: [...document.querySelector('#video').textTracks].map((x) => [x.label, x.mode]),
      overlay: document.querySelector('#ccOverlay').hidden,
    };
  });
  check('after Off, a track the engine re-enables snaps back off',
    meddledOff.modes.every(([, mode]) => mode === 'disabled'), JSON.stringify(meddledOff));
  check('and nothing is drawn over the picture', meddledOff.overlay === true,
    JSON.stringify(meddledOff));

  // iOS native fullscreen is the one sanctioned exception: the platform
  // draws there, so the chosen track legitimately runs 'showing'.
  const nativeOk = await page.evaluate(async () => {
    captions.choose('English');
    await new Promise((r) => setTimeout(r, 150));
    captions.nativeMode(true);
    await new Promise((r) => setTimeout(r, 300));
    const during = [...document.querySelector('#video').textTracks]
      .find((x) => x.label === 'English').mode;
    captions.nativeMode(false);
    await new Promise((r) => setTimeout(r, 300));
    const after = [...document.querySelector('#video').textTracks]
      .find((x) => x.label === 'English').mode;
    return { during, after };
  });
  check('iOS native fullscreen may hold the chosen track showing',
    nativeOk.during === 'showing', JSON.stringify(nativeOk));
  check('and hands it back to our overlay on the way out', nativeOk.after === 'hidden',
    JSON.stringify(nativeOk));

  // --- a conversion is still being written ---------------------------------
  console.log('\n  while the conversion is still running');
  const fetchesBefore = vttFetches;
  await page.evaluate(() => captions.build());
  await wait(600);
  const reread = await page.evaluate(() => ({
    modes: [...document.querySelector('#video').textTracks].map((t) => [t.label, t.mode]),
    srcs: [...document.querySelectorAll('#video track')].map((t) => t.src.includes('?t=')),
  }));
  console.log('   reread:', JSON.stringify(reread), vttFetches - fetchesBefore);
  check('re-reading a growing subtitle file fetches it again',
    vttFetches > fetchesBefore, `${fetchesBefore} → ${vttFetches}`);
  check('past the cache, or it would answer with the short version it already had',
    reread.srcs.every(Boolean), JSON.stringify(reread.srcs));
  check('and the track you chose stays on across the swap',
    reread.modes.find((m) => m[0] === 'English')[1] === 'hidden', JSON.stringify(reread.modes));

  // --- words that arrive late ----------------------------------------------
  //
  // Captions turned on at the start of a conversion fetch a file with nothing
  // in it yet, and on a flat 20-second re-read the viewer reported waiting
  // half a minute for words the menu said were already on. Until the first
  // fetch returns actual cues the re-read runs on the quick cadence, so the
  // wait is seconds.
  console.log('\n  words that arrive late');
  vttEmpty = true;
  await page.evaluate(() => closePlayer());
  await wait(400);
  await page.evaluate(() => openPlayer(state.library.movies.items[0]));
  await wait(3000);
  const beforeWords = await page.evaluate(() => {
    const t = [...document.querySelector('#video').textTracks].find((x) => x.label === 'English');
    return { mode: t?.mode || '', cues: t?.cues ? t.cues.length : -1 };
  });
  console.log('   while empty:', JSON.stringify(beforeWords));
  check('the chosen track is on while the file is still empty',
    beforeWords.mode === 'hidden' && beforeWords.cues === 0, JSON.stringify(beforeWords));
  vttEmpty = false;
  await wait(5000);   // two quick beats — nowhere near the 20s cruise interval
  const arrived = await page.evaluate(() => {
    const t = [...document.querySelector('#video').textTracks].find((x) => x.label === 'English');
    return t?.cues ? t.cues.length : -1;
  });
  check('and the words appear within seconds of being written, not half a minute',
    arrived > 0, `${arrived} cues after 5s`);

  // --- the next film -------------------------------------------------------
  console.log('\n  the next film');
  remuxSubs = [{ lang: 'eng', label: 'English', url: '/hls/s2/sub0.vtt' }];
  await page.evaluate(() => closePlayer());
  await wait(500);
  await page.evaluate(() => openPlayer(state.library.movies.items[0]));
  await wait(3000);
  const next = await page.evaluate(() => ({
    tracks: [...document.querySelector('#video').textTracks].map((t) => [t.label, t.mode]),
    lit: document.querySelector('#ccBtn').classList.contains('is-on'),
  }));
  console.log('   next:', JSON.stringify(next));
  check('the last film\'s tracks do not carry over',
    next.tracks.length === 1, JSON.stringify(next.tracks));
  check('and English comes back on by itself, because that is what you wanted last time',
    next.tracks[0][1] === 'hidden' && next.lit, JSON.stringify(next));

  // --- a film with no subtitles at all -------------------------------------
  //
  // The button STAYS. Hiding it was the first try and it was wrong twice over:
  // a title with no captions looks identical to a build that never shipped the
  // feature, and a control that comes and goes by title is one you stop
  // looking for. The menu carries the answer instead.
  console.log('\n  a film with none');
  remuxSubs = [];
  await page.evaluate(() => closePlayer());
  await wait(500);
  await page.evaluate(() => openPlayer(state.library.movies.items[0]));
  await wait(3000);
  await wake(page);
  const none = await page.evaluate(() => ({
    shown: !document.querySelector('#ccWrap').hidden,
    tracks: document.querySelector('#video').textTracks.length,
    lit: document.querySelector('#ccBtn').classList.contains('is-on'),
  }));
  console.log('   none:', JSON.stringify(none));
  check('the button is still there — you can always find it', none.shown,
    JSON.stringify(none));
  check('but not lit, because nothing is on', none.lit === false, JSON.stringify(none));
  await page.locator('#ccBtn').click();
  await wait(300);
  const emptyMenu = await page.evaluate(() => ({
    items: document.querySelectorAll('.cc-item').length,
    note: document.querySelector('.cc-none')?.textContent || '',
  }));
  console.log('   empty menu:', JSON.stringify(emptyMenu));
  check('and it says the film has none rather than opening onto a blank box',
    /no subtitles in this film/i.test(emptyMenu.note), emptyMenu.note);
  check('with no choices to make', emptyMenu.items === 0, String(emptyMenu.items));

  // --- live TV -------------------------------------------------------------
  //
  // A channel has no bottom bar at all, which is why there was no button on
  // one. It moves up into the bar the live player does have.
  console.log('\n  a live channel');
  await page.evaluate(() => closePlayer());
  await wait(400);
  await page.evaluate(() => {
    state.library.live = { categories: [{ id: 'c1', name: 'US| SPORTS' }],
      items: [{ kind: 'live', id: 1, name: 'US| NBC East', logo: '', categoryId: 'c1' }] };
    openPlayer(state.library.live.items[0]);
  });
  await wait(2500);
  await page.mouse.move(640, 300);
  await page.mouse.move(640, 200);
  await wait(300);
  const live = await page.evaluate(() => {
    const wrap = document.querySelector('#ccWrap');
    const box = wrap.getBoundingClientRect();
    return {
      shown: !wrap.hidden,
      inTopBar: Boolean(document.querySelector('.player-bar-actions')?.contains(wrap)),
      filmBar: !document.querySelector('#vodBar').hidden,
      top: Math.round(box.top),
      opensDown: wrap.classList.contains('cc-top'),
      round: document.querySelector('#ccBtn').classList.contains('icon-btn'),
    };
  });
  console.log('   live:', JSON.stringify(live));
  check('there is a caption button on a channel too', live.shown, JSON.stringify(live));
  // This page runs as a DESKTOP, where the top bar has the room and live CC
  // stays in it. On Apple touch it docks bottom-right in the live strip
  // instead — that half lives in livechrome.test.js, which runs as an iPhone.
  check('in the top bar on desktop, which has the room',
    live.inTopBar && !live.filmBar, JSON.stringify(live));
  check('near the top of the screen where that bar is', live.top < 120, String(live.top));
  check('and it wears the round shape the other buttons up there wear',
    live.round, JSON.stringify(live));

  // Opening downward matters: a menu that opened upward from the top bar would
  // be off the top of the screen.
  await page.locator('#ccBtn').click();
  await wait(300);
  const liveMenu = await page.evaluate(() => {
    const m = document.querySelector('#ccMenu');
    const box = m.getBoundingClientRect();
    return { open: !m.hidden, top: Math.round(box.top), bottom: Math.round(box.bottom),
      onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
      note: document.querySelector('.cc-none')?.textContent || '' };
  });
  console.log('   live menu:', JSON.stringify(liveMenu));
  check('its menu opens downward and stays on the screen',
    liveMenu.open && liveMenu.onScreen, JSON.stringify(liveMenu));
  check('and says what live captions depend on',
    /broadcaster sends them/i.test(liveMenu.note), liveMenu.note);

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
