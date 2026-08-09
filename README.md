# Treasure Theater

Private media server for Treasure State — trading-desk operations and the
principal's personal film and television collection. Point it at your IPTV
provider once and you get Live TV, Movies and Series in one browsable library
that runs in any browser on the network.

## Look and feel

The bison in the header and on the loading screen is the real Treasure State
Capital mark, not a redraw. It's extracted from the logo plate into
`public/bison.png` — a white silhouette on transparency — by
`scripts/extract-bison.js`, which decodes the PNG with nothing but Node's own
`zlib`, keys the flat red background out through the green channel (the plate
sits near G=31, the mark at G=255, and using that ramp as alpha keeps the
antialiased edges smooth), and crops to the emblem, stopping short of the
vertical rule that separates it from the wordmark.

The header bar is the brand crimson **#A21F24**, sampled from the mark itself.
Everything below it is a warm, low-lit neutral rather than flat black — a
screening room rather than a terminal — with a trace of the same red in every
surface so the header doesn't sit on top of an unrelated grey app.

No npm install, no build step — one Node file and three static files.

## Run it

```bash
node server.js
```

Then open http://127.0.0.1:8420 and fill in the setup form.

To use a different port or bind to your LAN so the TV and phone can reach it:

```bash
PORT=9000 HOST=0.0.0.0 node server.js
```

## Deploying to the Pi

`git push` is the whole deploy. `scripts/auto-update.sh` runs on the Pi every
couple of minutes, and when `origin/main` moves it pulls and restarts the
portal on its own. Setup and troubleshooting are in
[scripts/README.md](scripts/README.md).

Two things follow from that. **`main` is the live branch** — anything merged
there is running on the television a couple of minutes later, with nobody
reviewing it in between, so work on a branch and merge when you mean it. And
**an update waits for the box to be idle**: the script asks `/api/activity`
first and holds off while a film is playing, a stream is open or a download is
running, rather than dropping a stream mid-scene. It retries on the next tick.

`./deploy.sh` still rsyncs straight from a laptop and is still the fastest way
to try something, but the two do not mix well — see the end of
[scripts/README.md](scripts/README.md).

## Connecting your provider

**Xtream Codes** (most common — you were given a server URL, username and
password):

| Field | Example |
| --- | --- |
| Server URL | `http://your-provider.com:8080` |
| Username | your username |
| Password | your password |
| Live format | MPEG-TS (`.ts`) for lower latency, or HLS (`.m3u8`) |

MPEG-TS gives noticeably lower live latency than HLS because there's no segment
buffering — but it only works if the provider serves H.264 + AAC, which is all
mpegts.js can decode. HEVC/H.265 channels will fail on TS and need HLS. Check
with ffprobe before assuming:

```bash
ffprobe -v error -show_entries stream=codec_name -of csv "http://HOST/live/USER/PASS/STREAM_ID.ts"
```

Credentials are verified against the provider before anything is saved, so a
typo fails at the setup screen rather than silently on the first click.

**M3U playlist** — if all you have is a `get.php?...&type=m3u_plus` URL, use the
second tab. Channels are grouped by `group-title` and sorted into live/movies/
series by URL shape. There is no guide data in this mode.

Settings are written to `config.json` next to `server.js` with `0600`
permissions. It contains your password in plain text, so keep it off shared
machines and out of version control. The gear icon in the header wipes it.

## What it does

- **Live TV** — channel grid by category, with now/next guide data pulled from
  the provider's short EPG.
- **Movies** — full VOD library with posters, synopsis, runtime and genre.
- **Series** — season picker and episode list; click an episode to play.
- **Category search** — filter the category list itself, which matters when the
  provider hands you 900+ of them.
- **Pinned categories** — the pin icon on any category hover-reveals; pinned
  ones collect in a "Pinned" section at the top of the list, per section.
- **Favorites** — heart anything from the player.
- **Downloads** — pull a movie or episode to disk for offline viewing.
- **Search** — filters the current section as you type.

Pins and favorites are stored **server-side** in `prefs.json`, not in browser
storage, so they're identical on every device that hits the same server. That's
the point once this lives on the Pi behind Tailscale. Favorites from the older
localStorage-only build are migrated automatically on first load.

## Downloads and offline viewing

Open a movie and press the download arrow in the player bar; for a series, each
episode row has its own arrow. Files land in `downloads/` next to `server.js`.

From the Downloads tab each finished item offers:

- **Save to this device** — sends the file with `Content-Disposition:
  attachment`. On an iPad this drops it into the Files app, where it's genuinely
  offline and survives airplane mode.
- **Play** — streams it from local disk, using no provider connection at all.

**Your account allows one concurrent connection**, so downloads run strictly one
at a time and a download in progress will block live playback. That's why every
running download has a **Pause** button: pause it, watch what you want, then
resume. Pausing keeps the partial file and resumes from the exact byte offset
via a Range request rather than starting over. Downloads interrupted by a server
restart come back as paused and resume the same way.

Saved files keep their original container. Most of this library is `.mkv`, which
the iPad's built-in player won't open — use **VLC** or **Infuse** for saved
files. (Streaming inside the portal handles `.mkv` automatically; see below.)

## How playback works

Providers don't send CORS headers and usually serve plain HTTP, so the browser
can't touch them directly. Everything is proxied through the local server:

- `/api/xtream` — provider API passthrough (credentials are added server-side
  and never reach the browser).
- `/stream?u=…` — media proxy. HLS playlists are rewritten so every segment and
  key comes back through the proxy too; `Range` headers pass through for
  seeking in movies.
- `/img?u=…` — logo and poster proxy, so http-only artwork still loads.

Playback engine is chosen by format: [hls.js](https://github.com/video-dev/hls.js)
for `.m3u8`, [mpegts.js](https://github.com/xqq/mpegts.js) for `.ts`, native
`<video>` for MP4. Both libraries load from jsDelivr, so the first load needs
internet.

## Profiles

Netflix-style personas. Each carries its own favorites, pinned categories,
watch history and ratings, all stored server-side in `profiles.json` so a
profile is the same on every device.

**Creating and deleting a profile requires the password.** Switching between
existing ones does not — that is deliberate, and matches how a TV app behaves.
Editing a name or icon is open too; only the destructive and additive actions
are gated.

Be clear-eyed about what that password is and isn't. It stops someone casually
adding a profile or wiping another's history. It is **not** access control for
the server, which still has no authentication of its own — anyone who can reach
the port can browse the library and switch into any existing profile. The
network is the perimeter.

The password is never written to disk in the clear: `profiles.json` holds a
scrypt salt and hash, seeded on first run, compared in constant time, and the
file is `0600`. Five wrong guesses from one address locks that address out for
a minute. To change the password, delete the `auth` block from `profiles.json`
and restart — it re-seeds.

The first profile created inherits whatever was already favorited and pinned
before profiles existed, so nothing is lost on upgrade.

## Personalization API

The watch history exists to feed recommendations. Every play reports against
the active profile — what, how far, and in which category — on start, every 15
seconds, and on close (via `sendBeacon`, so closing the tab still lands).

`GET /api/profiles/:id/taste` returns the signals pre-aggregated, so a
recommender doesn't have to re-derive them:

| Field | What it gives you |
| --- | --- |
| `categoryAffinity` | Categories ranked by score, with plays, seconds watched and completions |
| `ratings` | Explicit thumbs, `{ "movie:201": 1 }` |
| `continueWatching` | Started but unfinished — past 60s and under 95% |
| `recentlyWatched` | Last 60 titles, newest first |
| `watchedKeys` | Everything seen, for filtering it out of suggestions |
| `totals` | Titles, seconds watched, completions |

Scoring weights completion far above opening something, and an explicit thumb
above both: `completionRatio + (completed ? 1 : 0) + rating × 2`.

Two things that matter if you extend the scoring:

- **Live has no runtime.** A live stream reports the length of its *buffered
  window* as `duration` — often only a few seconds — so treating it like VOD
  marks a channel "finished" seconds after tuning in and inflates its affinity
  enormously. Live is forced to `duration: 0, completed: false` on both the
  client and the server, and its score comes from time spent instead: half an
  hour on a channel counts as one full watch.
- **History is capped** at 600 rows, newest first, so the file can't grow
  without bound.

Other endpoints: `GET/POST /api/profiles`, `PATCH/DELETE /api/profiles/:id`,
`GET/PUT /api/profiles/:id/prefs`, `POST /api/profiles/:id/history`,
`POST /api/profiles/:id/rating`.

## Library filtering

This provider sells everything it has to everyone: **57,046 live channels,
178,252 movies and 46,825 series** across every language it carries. Fetching
all of that, re-serialising it, and pushing it to a phone is what makes the
grids sit empty for a minute. (Favorites still appear instantly, because those
come from `prefs.json` and never touch the provider — a useful tell that the
library fetch is the slow part, not the UI.)

`/api/library` does the work server-side: it keeps only the categories you care
about, then strips each record to the handful of fields the UI renders.

| Section | Kept | Payload |
| --- | --- | --- |
| Live | 11,762 of 57,046 | 20.3 MB → **2.3 MB** |
| Movies | 19,739 of 178,252 | 70.8 MB → **4.0 MB** |
| Series | 3,529 of 46,825 | 50.5 MB → **0.6 MB** |

That's 141 MB down to 6.9 MB. Results are cached in memory for 30 minutes, so
after the first load every section returns in about 20 ms.

The **English / US only** checkbox above the category list toggles it. Patterns
live in `prefs.json` and are per-section, because the provider's naming is not
consistent:

```json
"filters": {
  "live":   "^US\\|",
  "movies": "^EN\\s*-",
  "series": "^ENGLISH\\b"
}
```

Live categories read `US| PRIME`, movie categories read `EN - ACTION`, and
series categories have no code at all — just `ENGLISH SERIES`. Anchoring at the
start is deliberate: it keeps `ENGLISH SERIES` while dropping
`SOMALIA ENGLISH SERIES`, `HEBREW EN SERIES` and `INDIA EN DUBBED`. Edit these
to taste — they're plain JavaScript regular expressions, matched
case-insensitively against the category name, and a malformed one falls back to
showing everything rather than blanking the library.

Turning the filter off works, but expect the original wait.

## Loading screen and prebuffering

Movies and episodes wait on a full-screen loading screen — charging bison,
prairie grass, and a progress bar pinned to the bottom of the viewport. The
percentage is real, not decorative:

- **Library loads** stream the response and report bytes received against
  `Content-Length` (which the server sets explicitly on every JSON reply).
- **Playback** reports seconds banked against the prebuffer target, read from
  the `#EXTINF` durations ffmpeg has actually written.

ffmpeg can only remux as fast as the provider serves. Starting playback on the
first segment means the player keeps catching up to the encoder and stalling
every few seconds — the fix is to bank a cushion first. The default is **45
seconds**, tunable via `prebufferSeconds` in `prefs.json`.

Measured on a 1080p movie: 45s banked, then 95 seconds of playback with **zero
stall events** and 120 seconds buffered ahead. hls.js is also configured with a
much larger forward buffer for VOD (`maxBufferLength: 120`), while live keeps
its tight low-latency settings — a deep forward buffer there would just be
latency.

The library cache is written to `library-cache.json`, so a restart no longer
re-pulls 141 MB from the provider. Cold load 4.3s → **0.016s** after a restart.

### The cinema player

Films and episodes open full-viewport with the chrome floating over the
picture. It fades out after three seconds of no mouse movement while playing —
and takes the cursor with it — then returns on any movement. A paused film
keeps its controls up.

- **Back** (top left) returns to Movies or Series, matching what was playing.
- **Skip ±10s**, play/pause, mute and fullscreen on the bottom bar.
- Keyboard: space or `k` to pause, `←`/`→` for ±10s, `f` for fullscreen.
- Favorite, download and close stay reachable in the top right.

Live TV keeps the old windowed player; the cinema layout is only for VOD.

**Fullscreen on iPhone and iPad hands over to Apple's player.** Everywhere else
the fullscreen button expands the shell so the custom chrome stays in frame, but
iOS gets `video.webkitEnterFullscreen()` and the standard system video view
instead. Two reasons: on iPhone the element Fullscreen API does not exist at all,
so the old shell-fullscreen was a silent no-op and the button simply did nothing;
and on iPad it worked but produced a scaled-up version of our bar rather than the
controls every other video app on the device uses.

The trade-off is that the native scrubber is back for as long as the system
player is up, and on a remuxed film it can only span what has been remuxed —
exactly the limitation [the custom bar exists to work around](#the-scrubber-runs-on-real-film-time).
The custom bar is restored on `webkitendfullscreen`.

Touch mode does not scale the playback controls. It still enlarges tap targets
for browsing — category lists, episode rows, nav, chips — where a fingertip is
still aiming at cursor-sized targets.

### Why the player uses dvh, not vh

Safari counts its own collapsible toolbars inside `100vh`. The cinema shell was
`height: 100vh` with the control bar pinned to its bottom, so on a phone the bar
sat underneath the browser chrome — and the overlay does not scroll, so there was
no way to bring it back. That is why the controls were unreachable without
rotating the phone or nudging the page.

`100dvh` tracks what is actually visible, with a plain `100vh` above it as the
fallback. The notch and the home indicator sit inside the viewport too, so the
bar and the top chrome clear them with `max(<padding>, env(safe-area-inset-*))`
— `max()` rather than addition, so desktop keeps its own spacing where there is
no inset to clear.

Watch out for the phone-width media queries: they re-declare `padding` wholesale,
which drops the insets on exactly the device that needs them. They restate them.

Two sizing rules go with it:

- **Transport buttons are 40px on a touch device**, keyed off `.touch` rather
  than a width query — a phone held sideways is 844px wide, so a width query
  misses the orientation people actually watch in. 40, not the 48/58 that used
  to swamp the picture, and it never shows in full screen, which on an iPhone or
  iPad is Apple's player.
- **Below 560px the scrubber gets its own line** above the transport row. One
  row could not hold both: the track collapsed to 0px at 320 and the fullscreen
  button was pushed off the edge. The mute button is dropped at that width
  instead — a phone has hardware volume keys.

### The header has to fit the screen

Everything in the bar is either a control or the badge, so anything that does
not fit is a button you cannot reach. Overflowing it does not scroll the bar —
it makes the whole document wider than the phone and the entire page slides
sideways, which is what made it awkward to use on a phone.

Two different things push it over, and they need separate answers:

- **Phones.** The badge, the profile chip and four 46px touch targets do not fit
  in 390px, let alone 320px. The wordmark is dropped below 560px — it is the only
  thing in the bar that is not a control — and the header's own buttons come down
  to 40px, which still clears a fingertip. At 320px that leaves ~50px spare.
- **Tablets in landscape.** The nav rejoins the flow as soon as it stops being a
  dropdown, and touch mode makes its five links about 464px wide, which is more
  than an iPad has left over at 1024 or 1194 once the badge and controls are
  placed. So the dropdown breakpoint is 1200, not 860. The 12.9" at 1366 has the
  room and keeps the full nav.

The badge is also the only flex item allowed to shrink, and it needs
`min-width: 0` to do it — without that a flex item refuses to go below its
content width and pushes the controls off the edge instead.

### The scrubber runs on real film time

The remux only knows the part it has written, so the native scrubber could
never show more than that. The bar works in film time instead: session offset
plus the video element's position. Seeking inside the span already remuxed is
an ordinary seek; landing outside it restarts the remux at that point with
`-ss`, and that becomes the new offset. The lighter band on the track marks
what's remuxed and therefore instant to seek within.

Two ordering details make this work, both learned the hard way:

- **Runtime is fetched before the remux starts.** This provider allows one
  connection, and while ffmpeg is streaming it answers `get_vod_info` with
  `{"error":""}`. Asking first is the only reliable order — and it means the
  scrubber shows the full length from the first frame.
- **`duration_secs` cannot be trusted.** It holds seconds on some titles
  (6000 for a 01:40:00 film) and minutes on others (173 for one running
  02:53:44). The formatted `duration` string is parsed instead, with ffprobe's
  reading of the source as a fallback and the remuxed length as a floor.

Keep the ffprobe call cheap (`-select_streams v:0`, small probe window). A
heavy probe holds the single provider connection long enough that the remux
queued behind it times out.

### Why films must be pinned to position zero

A remux that is still running has no `#EXT-X-ENDLIST`, so hls.js reads the
playlist as **live** and joins at the live edge minus three target durations.
With a 45s prebuffer and 6s segments that lands you 27 seconds into the film.
Both players are pinned to the start instead — `startPosition: 0` for hls.js,
and a seek on `loadedmetadata` for Safari's native HLS, which falls into the
same trap on iOS.

### When the provider can't keep up

ffmpeg only produces as fast as the provider serves. On a high-bitrate title
that can be slower than playback, so the cushion drains and the film stalls
mid-scene — which is why it happens on some films and not others, rather than
consistently.

A watcher tracks the **lead**: seconds remuxed minus the current playback
position. Below 12 seconds of runway it pauses deliberately and shows the
loading screen with real progress until 40 seconds are rebuilt, then resumes.
One honest wait, rather than repeated stuttering. It stops as soon as ffmpeg
writes `ENDLIST`, since there is no runway left to run out of.

**Known quirk:** while a remux is in progress the scrubber shows the length
remuxed so far, not the full running time. It corrects itself when ffmpeg
finishes the file.

## Playing movies and series (.mkv remuxing)

**The live format setting does not apply to VOD.** Movies and episodes are
served by the provider as direct files at whatever container they were stored
in — on this provider that is `.mkv`, essentially always. No browser opens
Matroska, which is the `file type is not supported` error on iPhone.

The portal fixes this by remuxing on demand through ffmpeg. **Video is copied
bit-for-bit — there is no re-encoding** — so it runs around 80× realtime and is
fine on a Raspberry Pi. Audio is downmixed to stereo AAC, because this library
ships a lot of E-AC3 5.1 that devices handle inconsistently.

Packaging depends on the video codec, and this part matters:

| Source video | Segments | Why |
| --- | --- | --- |
| H.264 | MPEG-TS | Universally supported. |
| HEVC / H.265 | fragmented MP4, tagged `hvc1` | Apple's HLS spec carries HEVC in fMP4 **only**. HEVC inside MPEG-TS will not play on iOS at all, and Apple requires the `hvc1` tag rather than `hev1`. |

A lot of this library is 4K HEVC, so that second row is not a corner case. The
codec comes from the provider's own metadata when available; otherwise the
server probes the source with ffprobe.

Downloaded files are remuxed from local disk, which is near-instant and uses no
provider connection. Streaming remuxes read from the provider and therefore
consume your single connection — only one runs at a time, and closing the player
stops it.

**ffmpeg is required for this.** Without it, `.mkv` playback returns a clear
error instead of failing silently:

```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Raspberry Pi / Debian
```

Remux output lands in `hls/` and is deleted when the session ends or after five
idle minutes. A full episode's segments are roughly the size of the source, so
keep an eye on space on the Pi's SD card.

## Live TV opens on its categories

Live used to land on one flat grid of every station the provider carries. At a
few thousand channels that is not a list anyone browses — the categories are the
only usable way in, and they were buried in a sidebar that is a drawer on a
phone.

So Live opens on square tiles, one per category, showing a single station logo
and the channel count. Tapping one drills into just that category's stations,
with an **All categories** button back out. Same on the phone, the iPad and the
Mac — the only difference is how many squares fit in a row.

**The cover logo is the first still one in the category.** Providers hand out a
lot of animated logos — spinning idents and promo loops — and a wall of those
moving at once is unreadable. Nothing in the URL declares it, but the format
gives it away in practice: nobody ships a still station logo as a GIF or an
APNG, so those are skipped when picking. WebP is deliberately not treated as
animated, since most of those are ordinary still images.

An animated logo is never taken as a second choice. A category whose stations
*all* carry one falls back to showing its name, which is quieter than a looping
ident — if a category of yours ends up as bare text, that is why.

Details worth knowing:

- **Search still cuts across everything.** Typing in the header collapses the
  tiles and searches every station in every category, because looking for one
  channel by name is the case the tiles are bad at. Clearing it returns you to
  the squares.
- **Pinned categories come first.** The sidebar pins already mean "put this at
  the top", so the tiles honour them rather than inventing a second ordering.
- **Empty categories are dropped.** Providers ship plenty of them.
- The sidebar hides on the tile screen — the tiles *are* the category picker —
  and comes back once you are inside one, so you can switch without going out.

Logos use `object-fit: contain`, not `cover`: a station logo cropped square is
unreadable, which is the same reason the channel grid contains rather than
covers.

## Live latency

Xtream servers dump a deep backlog the instant you connect. Measured on this
provider: **~31 seconds of video delivered in the first 6 seconds** (up to 6.7×
realtime), then realtime *on average* but in lumpy 4–5 second chunks with gaps
between them.

Handed straight to a player, that means two problems. You sit ~25 seconds behind
live, and mpegts.js's built-in latency chaser — which seeks whenever the buffer
exceeds **1.5s** — fires on every single lump. That produces continuous
skip-ahead and is what makes the stream unwatchable.

The portal handles this at both ends:

- The proxy reads the stream's **PCR clock** and swallows the opening backlog,
  only forwarding once the provider has caught up to realtime. The player joins
  near the live edge with nothing to chase. Resuming happens on a verified TS
  packet boundary (a `0x47` confirmed at the 188-byte stride — a lone `0x47`
  appears constantly inside payload data and would desync the demuxer).
- The client **disables latency chasing entirely**, so playback is never seeked
  out from under you. The `LIVE` pill in the player bar shows how far behind you
  are; click it to jump to the edge deliberately.

Three modes, selectable in the player bar and remembered in `prefs.json`:

| Mode | Latency | Behaviour |
| --- | --- | --- |
| Lowest | ~3s | Rides the live edge. May stutter — a 5s delivery gap can outrun a 3s cushion. |
| Balanced *(default)* | ~7s | Banks a 4s jitter buffer before starting. Measured zero stalls and zero seeks over 50s. |
| Instant start | ~25s | No draining. Plays immediately, stays far behind live. |

**Playback rate is never touched.** The portal doesn't auto-adjust speed to
catch up, so a speed-controller extension keeps full control. Your chosen rate
is preserved across channel changes, which a plain `load()` would otherwise
reset to 1×.

## Known limits

- **MKV and AVI won't play.** No browser decodes them. Movies served as MKV need
  a transcode or a native player — this is a browser limitation, not a bug here.
- The server is unauthenticated. It binds to `127.0.0.1` by default; if you set
  `HOST=0.0.0.0`, anyone on your network can use your subscription. Don't
  port-forward it.
- Very large libraries load fully into memory in the browser. With 57k channels
  and 178k movies, the first load of a section takes several seconds.
- Series resume points aren't tracked yet — episodes start from zero.
- Downloads have no disk-space guard. A 4K film here runs 4–5 GB; check the Pi's
  free space before queueing a stack of them.

## Layout

```
server.js            proxy + static server, zero dependencies
config.json          created at setup (gitignored)
public/index.html    markup
public/styles.css    dark theme
public/app.js        routing, library loading, player
```
