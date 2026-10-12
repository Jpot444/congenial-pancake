/**
 * A live channel the provider swaps for a placeholder.
 *
 * "playlist reset 32s ago seq 634→0", "playlist vod, 1 segments of ~11s",
 * then the picture froze at 70.1s and stayed frozen. The provider had replaced
 * the channel with its placeholder clip — what it sends a login it thinks has
 * too many connections — marked finished. The engine took it for a film with
 * nothing more to come and nothing tried again.
 *
 * Real hls.js on a real live stream (see relay.test.js for why it is vendored
 * and why VP9): playing normally, then the playlist is swapped mid-stream for
 * exactly what the report showed, and the player has to notice and tune back
 * in by itself.
 */
const { chromium } = require('./playwright.js');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HLS_JS = path.join(__dirname, 'vendor', 'hls-1.5.17.min.js');

(async () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('  no ffmpeg on this box — skipped');
    process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-'));
  spawnSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=60',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8',
    '-g', '30', '-keyint_min', '30',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
    '-start_number', '600', path.join(dir, 'index.m3u8')]);
  const listFile = path.join(dir, 'index.m3u8');
  if (!fs.existsSync(listFile)) {
    console.log('  could not write a stream — skipped');
    process.exit(0);
  }
  const LIVE_LIST = fs.readFileSync(listFile, 'utf8').replace(/#EXT-X-ENDLIST\s*$/, '');
  /* What the report showed the provider sending instead: sequence 0, one
     segment, finished. */
  const PLACEHOLDER = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n'
    + '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\nindex600.m4s\n'
    + '#EXT-X-ENDLIST\n';
  let serving = 'live';

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/cdn.jsdelivr.net/npm/hls.js@*/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(HLS_JS) }));
  await page.route('**/live-ph/**', (r) => {
    const name = path.basename(new URL(r.request().url()).pathname);
    if (name === 'index.m3u8') {
      return r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl',
        body: serving === 'live' ? LIVE_LIST : PLACEHOLDER });
    }
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ status: 200, contentType: name.endsWith('.m4s') ? 'video/iso.segment' : 'video/mp4',
      body: fs.readFileSync(file) });
  });
  let plays = 0;
  await page.route('**/api/play**', (r) => {
    plays += 1;
    /* A fresh ask of the box is what brings the channel back. */
    serving = 'live';
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: `/live-ph/index.m3u8?n=${plays}`, format: 'm3u8', dvr: false }) });
  });
  const json = (body) => (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/library**', json({ categories: [], items: [], totals: { items: 0 } }));
  await page.route('**/api/epg/now**', json({ channels: [], busy: false }));
  await page.route('**/api/scores**', json({ games: [], feeds: [] }));
  await page.route('**/api/xtream**', json({ epg_listings: [] }));

  await page.addInitScript(() => localStorage.setItem('portal.profile', 'own1'));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Hls, null, { timeout: 15000 });
  await page.evaluate(() => {
    document.querySelector('#tour')?.remove();
    state.config.mode = 'xtream';
    openPlayer({ kind: 'live', id: 702, name: 'US| PLACEHOLDER TEST', categoryId: 'c1' });
  });

  console.log('\n  playing normally');
  await page.waitForFunction(() => {
    const v = document.querySelector('#video');
    return v && !v.paused && v.currentTime > 1;
  }, null, { timeout: 30000 }).catch(() => {});
  const before = await page.evaluate(() => document.querySelector('#video').currentTime);
  check('the channel is playing', before > 1, String(before));
  check('asked the box once', plays === 1, String(plays));

  /* ---- the swap ------------------------------------------------------------- */
  console.log('\n  the provider swaps the channel for its placeholder');
  serving = 'placeholder';
  const swappedAt = Date.now();
  let retuned = false;
  while (Date.now() - swappedAt < 15000) {
    if (plays >= 2) { retuned = true; break; }
    await wait(200);
  }
  const took = Date.now() - swappedAt;
  const said = await page.evaluate(() => (document.querySelector('#toast')?.textContent || '').trim());
  console.log(`    re-tuned: ${retuned} after ${took}ms · said: ${JSON.stringify(said)}`);
  check('the player tunes back in by itself', retuned, `${plays} asks`);
  check('within a few seconds of the swap', took < 8000, `${took}ms`);
  check('and says what happened', /tuning back in/i.test(said), said);

  await wait(4000);
  const after = await page.evaluate(() => {
    const v = document.querySelector('#video');
    return { paused: v.paused, t: v.currentTime };
  });
  console.log('   ', JSON.stringify(after));
  check('and the channel plays again', !after.paused, JSON.stringify(after));

  /* ---- and does not hammer a provider that has nothing ------------------------ */
  console.log('\n  a provider that keeps sending the placeholder');
  await page.route('**/api/play**', (r) => {
    plays += 1;   // and this time the placeholder stays
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: `/live-ph/index.m3u8?n=${plays}`, format: 'm3u8', dvr: false }) });
  });
  const startPlays = plays;
  serving = 'placeholder';
  await wait(9000);
  const extra = plays - startPlays;
  console.log(`    asked ${extra} more times in 9s`);
  check('it does not re-tune again straight away — at most once in 30s', extra <= 1, String(extra));

  await page.evaluate(() => closePlayer());
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
