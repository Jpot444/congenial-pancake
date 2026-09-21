/**
 * A live playlist that only ever goes on.
 *
 * "There are still so many jumps back to previous spots when I'm watching
 *  live tv."
 *
 * The cause was in a playback report all along:
 *
 *   playlist reset  seq 3325→3288 · 3332→3298 · 3335→3300 · 3301→2037
 *
 * A media sequence does not go backwards. The provider answers one URL from
 * several backend nodes, each numbering its own output, so two refreshes of
 * the same channel can come from encoders minutes or hours apart. The box
 * proxied that faithfully — and a player handed a timeline that jumps
 * backwards has no choice: it treats the stream as new, discards the buffer,
 * re-seats the playhead, and shows video already watched.
 *
 * FIXING IT IN THE PLAYER WAS THE WRONG LAYER, and was tried first. Seeking
 * forward out of the jump fought hls.js's own seat — thirty-two seconds back
 * from the edge — so the engine put the playhead straight back and one jump
 * became two. By the time the player sees it, the timeline its buffer was
 * built on is already gone; there is nothing left to correct.
 *
 * So the regression is never handed over. The box reads every playlist it
 * proxies anyway, keeps the last one it served for that channel, and serves
 * that again rather than one that has gone backwards. To the player the
 * stream simply has nothing new for a moment, which every HLS client handles.
 *
 * The bound matters as much as the rule: "never backwards" must not become
 * "never moves again". A channel that genuinely restarted stays renumbered,
 * and holding the old playlist for ever would freeze the picture waiting for
 * numbers that are not coming back.
 */
const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const SERVER = fs.readFileSync(path.join(PATHS.ROOT, 'server.js'), 'utf8');

/* Lifted by name so this tests what ships, the way allowance and livedvr do. */
const lift = (name) => {
  const start = SERVER.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`not found: ${name}`);
  let depth = 0;
  let i = SERVER.indexOf('{', SERVER.indexOf(')', start));
  for (; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1;
    else if (SERVER[i] === '}' && --depth === 0) break;
  }
  return SERVER.slice(start, i + 1);
};

const box = new Function(`
  const console = { log() {} };
  const LAST_PLAYLIST_MS = 45000;
  const lastPlaylists = new Map();
  ${lift('playlistKey')}
  const mediaSequence = (text) => {
    const hit = /#EXT-X-MEDIA-SEQUENCE:(\\d+)/.exec(text);
    return hit ? Number(hit[1]) : null;
  };
  /* Lifted too, because forwardOnlyPlaylist calls them. A harness that lifts
     one function by name has to lift what that function reaches for — the
     alternative is a ReferenceError the first time the shipped code grows a
     helper, which is exactly what happened when it learned to notice the same
     segment arriving under a new number. */
  ${lift('segmentUris')}
  const directNotes = new Map();
  const DIRECT_NOTE_MS = 600000;
  ${lift('noteDirectReplay')}
  ${lift('forwardOnlyPlaylist')}
  return { forwardOnlyPlaylist, lastPlaylists, playlistKey, directNotes };
`)();

const { forwardOnlyPlaylist, lastPlaylists, directNotes } = box;

const URL_A = 'http://provider.example/live/u/p/902.m3u8';
/* The same channel on the OTHER login: a different URL for the same feed, and
   the numbering problem does not care which account fetched it. */
const URL_A2 = 'http://provider.example/live/u2/p2/902.m3u8';
const URL_B = 'http://provider.example/live/u/p/700.m3u8';

const playlist = (seq, count = 6, seconds = 11) => [
  '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(seconds)}`,
  `#EXT-X-MEDIA-SEQUENCE:${seq}`,
  ...Array.from({ length: count }, (_, k) => `#EXTINF:${seconds.toFixed(3)},\nseg${seq + k}.ts`),
].join('\n');

const seqOf = (text) => Number((/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text) || [])[1]);

(async () => {
  /* ---- the ordinary case, which must be untouched ---------------------- */
  console.log('\n  a playlist rolling forward is passed straight through');
  check('the first one is served as it arrived',
    seqOf(forwardOnlyPlaylist(URL_A, playlist(3325))) === 3325);
  check('and so is the next one, further on',
    seqOf(forwardOnlyPlaylist(URL_A, playlist(3332))) === 3332);
  check('and one that has not moved at all is still served',
    seqOf(forwardOnlyPlaylist(URL_A, playlist(3332))) === 3332);

  /* ---- the report, reproduced ------------------------------------------ */
  /*
   * The exact numbers that were captured, in the order they were captured.
   * Every one of these used to reach the player.
   */
  /*
   * Stated as the INVARIANT rather than as a list of expected numbers, which
   * is what this section asserted first and got wrong.
   *
   * Replaying the captured sequence shows why: 3301 arrives after 3335, so
   * 3301 is itself a regression and the box is right to keep holding 3335
   * rather than accept it and then reject 2037. The provider was bouncing
   * between nodes, not stepping down once. Checking each pair against a
   * predicted value encoded my guess about the order; checking that what is
   * served never goes backwards is the actual promise, and it holds whatever
   * order the provider sends.
   */
  console.log('\n  and the renumbered ones from the report never reach the player');
  const captured = [3325, 3288, 3332, 3298, 3335, 3300, 3301, 2037];
  const servedSeq = captured.map((seq) => seqOf(forwardOnlyPlaylist(URL_A, playlist(seq))));
  console.log('   provider sent:', captured.join(' → '));
  console.log('   player saw:   ', servedSeq.join(' → '));
  let wentBack = null;
  for (let i = 1; i < servedSeq.length; i += 1) {
    if (servedSeq[i] < servedSeq[i - 1]) wentBack = `${servedSeq[i - 1]} → ${servedSeq[i]}`;
  }
  check('what the player is served never goes backwards, whatever arrives',
    wentBack === null, wentBack);
  /* And nothing is invented: every number the player sees is one the provider
     really published, so this holds a playlist back but never writes one. */
  check('and every sequence it does see is one the provider really sent',
    servedSeq.every((seen) => captured.includes(seen)), JSON.stringify(servedSeq));
  check('ending on the furthest forward the provider ever got',
    servedSeq[servedSeq.length - 1] === Math.max(...captured),
    `${servedSeq[servedSeq.length - 1]} vs ${Math.max(...captured)}`);

  /* ---- the player is given something it can use ------------------------ */
  /*
   * Not an error and not an empty body: the playlist it already has. A player
   * reads that as "no new segments yet", which is an ordinary moment in every
   * live stream, and keeps playing what is in its buffer.
   */
  console.log('\n  what it gets instead is the playlist it already had');
  forwardOnlyPlaylist(URL_A, playlist(4000));
  const held = forwardOnlyPlaylist(URL_A, playlist(2000));
  check('it is a valid playlist, not an error or an empty one',
    /^#EXTM3U/.test(held) && /seg4000\.ts/.test(held), held.slice(0, 60));
  check('with the sequence the player is already playing',
    seqOf(held) === 4000, String(seqOf(held)));

  /* ---- one channel does not silence another ---------------------------- */
  console.log('\n  and it is per channel, not per box');
  forwardOnlyPlaylist(URL_A, playlist(5000));
  check('a different channel is judged on its own numbering',
    seqOf(forwardOnlyPlaylist(URL_B, playlist(12))) === 12,
    'channel 700 was measured against channel 902');

  /* The same channel fetched on the other login is the same channel. Keyed on
     the file rather than the URL, because the pool can hand out either
     account for the same feed and the numbering problem is the provider's
     either way. */
  console.log('\n  and the same channel on the other login is the same channel');
  forwardOnlyPlaylist(URL_A2, playlist(5010));
  check('a regression arriving on the second login is caught too',
    seqOf(forwardOnlyPlaylist(URL_A, playlist(4500))) === 5010,
    String(seqOf(forwardOnlyPlaylist(URL_A, playlist(4500)))));

  /* ---- never backwards must not mean never again ----------------------- */
  /*
   * The bound. A channel that really restarted — a new programme, an encoder
   * replaced — goes backwards and stays there. Holding the old playlist for
   * ever would freeze the picture waiting for numbers that are never coming.
   */
  console.log('\n  but a channel that really started over is let through');
  forwardOnlyPlaylist(URL_B, playlist(900));
  check('held at first, while it might be a rotation',
    seqOf(forwardOnlyPlaylist(URL_B, playlist(10))) === 900);
  /* Age the remembered one past the window rather than sleeping 45 seconds. */
  const seen = lastPlaylists.get('700.m3u8');
  seen.at = Date.now() - 46_000;
  check('and taken as a real restart once it has stayed that way',
    seqOf(forwardOnlyPlaylist(URL_B, playlist(10))) === 10,
    String(seqOf(forwardOnlyPlaylist(URL_B, playlist(10)))));
  check('after which the new numbering is what carries on',
    seqOf(forwardOnlyPlaylist(URL_B, playlist(11))) === 11);

  /* ---- a finished stream is not a live one ----------------------------- */
  console.log('\n  and a finished playlist is left entirely alone');
  const vod = `${playlist(0, 3)}\n#EXT-X-ENDLIST`;
  check('an ENDLIST playlist is never held back',
    /#EXT-X-ENDLIST/.test(forwardOnlyPlaylist(URL_A, vod))
    && seqOf(forwardOnlyPlaylist(URL_A, vod)) === 0);
  /* Nor is anything without a sequence at all — a master playlist, say. */
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8';
  check('and a playlist with no media sequence is passed through',
    forwardOnlyPlaylist(URL_A, master) === master);

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
