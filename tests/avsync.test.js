/**
 * The audio offset filter chain.
 *
 * The manual control that used to drive this is gone — it was a slider behind
 * a button at the top of the player, and it was removed on request. The FILTER
 * is not gone and must not be: `realign` uses the same chain to pad the head of
 * the audio when a seek lands the two streams apart, which is automatic and is
 * the thing that keeps lips and voices together. So the chain is still tested
 * in full, and the control's absence is tested as its own claim.
 *
 * audioFilter is lifted from server.js so the chain under test is the shipped
 * one.
 */
const { chromium } = require('./playwright.js');
const PATHS = require('./paths.js');
const fs = require('fs');

const SRC = PATHS.SERVER;
const BASE = 'http://127.0.0.1:8481';
const CLIP = fs.readFileSync(__dirname + '/clip.wav');
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the filter chain -----------------------------------------------------
const source = fs.readFileSync(SRC, 'utf8');
// Matched on the name alone: pinning the signature made this suite break
// the moment a parameter was added, which is not what it is testing.
const start = source.indexOf('function audioFilter(');
let depth = 0;
let end = start;
for (let i = source.indexOf('{', start); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const audioFilter = new Function(`${source.slice(start, end)}; return audioFilter;`)();

console.log('  filter chain');
const none = audioFilter(0);
console.log('   ', none);
// async is a MODE, not a rate. 1 enables filling and trimming; anything
// larger additionally allows stretching by that many samples per second —
// async=1000 at 48kHz is a licence to change tempo by 2.08%.
check('gap filling is armed', /\basync=1(?![\d.])/.test(none), none);
check('and the tempo is never licensed to change',
  !/async=(?!1(?![\d.]))[\d.]+/.test(none), none);
check('the hard/soft threshold is explicit', /min_hard_comp=0\.100/.test(none), none);
check('with no pad the track starts where it was handed over',
  /first_pts=0/.test(none), none);
check('the head is still padded to zero', /first_pts=0/.test(none), none);
check('no offset means no delay stage', !/adelay|atrim/.test(none), none);

const later = audioFilter(250);
console.log('   ', later);
check('a positive offset delays the audio', /adelay=250:all=1/.test(later), later);
check('and does not also trim it', !/atrim/.test(later), later);

const earlier = audioFilter(-250);
console.log('   ', earlier);
check('a negative offset trims the front off', /atrim=start=0\.250/.test(earlier), earlier);
check('and rebases what is left', /asetpts=PTS-STARTPTS/.test(earlier), earlier);
check('and does not also delay it', !/adelay/.test(earlier), earlier);

// No tempo arm, and this is the guard on it coming back. One existed for two
// versions, driven by a measured "drift rate"; two reports of the same file
// at the same resume point then showed a gap identical to the millisecond
// over different spans — a constant divided by a growing number. A remux does
// not change tempo, and nothing may on evidence like that.
console.log('\n  no tempo, on purpose');
check('the chain never stretches or squeezes the audio',
  !/atempo/.test(audioFilter(0)) && !/atempo/.test(audioFilter(250))
  && !/atempo/.test(audioFilter(0, 2.5)), audioFilter(0, 2.5));
check('and a caller passing one anyway is ignored rather than obeyed',
  !/atempo/.test(audioFilter(0, 0, 0.9676)), audioFilter(0, 0, 0.9676));

check('the offset is clamped', /adelay=5000:/.test(audioFilter(99999)), audioFilter(99999));
check('and clamped the other way', /atrim=start=5\.000/.test(audioFilter(-99999)),
  audioFilter(-99999));
for (const junk of [null, undefined, NaN, 'abc', '']) {
  check(`junk (${JSON.stringify(junk)}) falls back to no offset`,
    !/adelay|atrim/.test(audioFilter(junk)), audioFilter(junk));
}
check('a fractional value is rounded, not passed through',
  /adelay=150:/.test(audioFilter(150.4)), audioFilter(150.4));

// --- the control is gone --------------------------------------------------
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/api/profiles/*/taste', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: '{"recentlyWatched":[],"categoryAffinity":[],"ratings":{}}' }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('#profileGate').isVisible()) {
    await page.locator('.profile-tile').first().click();
    await page.waitForTimeout(1500);
  }

  console.log('\n  the manual control');
  const gone = await page.evaluate(() => ({
    button: document.querySelector('#avSyncBtn'),
    panel: document.querySelector('#avSyncPanel'),
    slider: document.querySelector('#avSyncSlider'),
    topBar: [...document.querySelectorAll('.player-bar-actions > *')].map((e) => e.id),
  }));
  console.log('   left in the top bar:', JSON.stringify(gone.topBar));
  check('the audio sync button is gone from the player', gone.button === null);
  check('and so is the panel it opened', gone.panel === null && gone.slider === null,
    JSON.stringify(gone));
  // Everything else up there stays. Removing one control must not take its
  // neighbours with it.
  check('reload, favourite and close are still there',
    ['reloadBtn', 'favBtn', 'playerClose'].every((id) => gone.topBar.includes(id)),
    JSON.stringify(gone.topBar));

  // No manual control came back. One did, briefly, twice — and both times it
  // was the wrong answer to a fault that was never the file drifting: the
  // archive rip held sync for its whole runtime when played from the start
  // and broke ONLY on resume, at a constant offset per resume point. That is
  // a seek fault, not a sync fault, and it is fixed where the seek happens.
  console.log('\n  and no manual control came back');
  const nothing = await page.evaluate(() => ({
    wrap: document.querySelector('#syncWrap'),
    btn: document.querySelector('#syncBtn'),
  }));
  check('no sync button anywhere', nothing.wrap === null && nothing.btn === null,
    JSON.stringify(nothing));

  // The fix that replaced it: how the middle of a file is REACHED. Lifted
  // from ffmpegArgs so the arguments under test are the shipped ones.
  console.log('\n  how the middle of a file is reached');
  const source = fs.readFileSync(PATHS.SERVER, 'utf8');
  const fstart = source.indexOf('function ffmpegArgs(');
  let depth = 0; let fend = fstart;
  for (let i = source.indexOf('{', fstart); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { fend = i + 1; break; } }
  }
  // audioFilter is stubbed — the chain's own content has its checks above;
  // here only the seek placement is on trial.
  const ffmpegArgs = new Function(
    `const audioFilter = () => 'stub'; const UA = 'ua'; const path = { join: (...a) => a.join('/') };
     ${source.slice(fstart, fend)}; return ffmpegArgs;`
  )();

  const at = (args, flag) => args.indexOf(flag);
  const provider = ffmpegArgs('http://p/f.mkv', '/tmp/x', 'h264', 2135);
  check('a provider stream still jumps — the demuxer seek, before -i',
    at(provider, '-ss') > -1 && at(provider, '-ss') < at(provider, '-i'),
    provider.slice(0, 12).join(' '));

  const archive = ffmpegArgs('/mnt/archive/f.mp4', '/tmp/x', 'h264', 2135, 0, 0, [], 0, 'demux');
  check('an archive resume reads sequentially — the cut comes after -i',
    at(archive, '-ss') > at(archive, '-i'), archive.join(' ').slice(0, 200));
  check('so both tracks ride one pipe and are cut at the same instant',
    (archive.filter((a) => a === '-ss').length === 1), archive.join(' '));
  check('and never asks the file\'s seek index anything',
    !archive.includes('-noaccurate_seek'), archive.join(' '));

  const fresh = ffmpegArgs('/mnt/archive/f.mp4', '/tmp/x', 'h264', 0, 0, 0, [], 0, 'demux');
  check('playing from the start adds no seek at all', !fresh.includes('-ss'),
    fresh.join(' ').slice(0, 160));

  check('the archive endpoint asks for the sequential mode',
    /seekMode: 'demux'/.test(source), 'archive play does not set seekMode');

  // And the audio in that mode runs on the content clock: timestamps rebuilt
  // from the running sample count, nothing the container claims consulted.
  // A sequential resume still came back audio-ahead while aresample chased
  // the container's audio timeline; its probe showed the audio stream
  // extending 2.2s past the video within 26s of output. The sample count is
  // the one clock that cannot lie — it IS the content.
  console.log('\n  whose clock the audio runs on');
  const contentAf = audioFilter(0, 0, 0, 'content');
  const containerAf = audioFilter(0, 0, 0, 'container');
  console.log('   content clock:  ', contentAf);
  console.log('   container clock:', containerAf);
  check('archive audio is timed by counting its own samples',
    /asetpts=N\/SR\/TB/.test(contentAf), contentAf);
  check('with nothing chasing container timestamps — no async, no first_pts',
    !/async|first_pts/.test(contentAf), contentAf);
  check('resampled to the pinned output rate first',
    /^aresample=48000,/.test(contentAf), contentAf);
  check('and a delay or pad cannot sneak into that mode either',
    !/adelay|atrim|first_pts/.test(audioFilter(1500, 3, 0, 'content')),
    audioFilter(1500, 3, 0, 'content'));
  check('while provider streams keep the container clock and its gap-filling',
    /async=1\b/.test(containerAf) && /first_pts/.test(containerAf)
    && !/asetpts/.test(containerAf), containerAf);
  check('and ffmpegArgs hands the content clock to demux mode',
    /seekMode === 'demux' \? 'content' : 'container'/.test(source),
    'the mode wiring is gone');
  /* No MANUAL delay — which is not the same as no delay.
   *
   * The slider this pin was written for is gone and stays gone: asking
   * somebody to dial their own lip-sync from the sofa is not a feature, it
   * is a fault with a knob on it. What replaced it is a delay nobody sets —
   * the box measures the gap in what it wrote, and the rebuild carries that
   * measurement so a seeked conversion comes back corrected instead of
   * reproducing the same offset. */
  const app = fs.readFileSync(PATHS.APP, 'utf8');
  check('the manual sync control is still gone', !/avSync/.test(app));
  check('and the only delay sent is the one the box measured for itself',
    /film\.audioDelayMs \+ \(gap < 0/.test(app)
    && /adelay: Math\.round\(film\.audioDelayMs\)/.test(app),
    'the measured correction is not wired to the request');
  check('with nothing offering to set it by hand',
    !/adelay/.test(fs.readFileSync(PATHS.INDEX, 'utf8')));

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
