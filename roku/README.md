# Portal for Roku

A native Roku channel (BrightScript / SceneGraph) that browses and plays the
same Live TV, Movies and Series catalogue as the web player, from the same Pi.

Almost entirely a **client**. Every screen is built out of endpoints the web
player already uses, and pins and favorites are read and written through
`/api/prefs` so the two stay in sync.

One addition to `server.js` was needed: `/api/remux` now accepts `kind=live`.
It previously built a `movie` URL for anything that was not `series`, so a live
channel could not be repackaged at all — and repackaging is the only thing that
makes an HEVC channel play on this hardware. The change is additive: no
existing caller passes `kind=live` to that endpoint, so nothing the web player
does behaves differently. See *When playback is refused*.

Private, sideloaded channel. No Channel Store submission involved.

---

## Enabling Developer Mode on the Roku

Do this once per device.

1. On the Roku remote, press:
   **Home ×3, Up ×2, Right, Left, Right, Left, Right**
   The *Developer Settings* screen appears.
2. Choose **Enable installer and restart**, then **I Agree** to the SDK licence.
3. Set a **developer password** and write it down — you need it for every
   upload, and the only way to change it is to disable and re-enable the mode.
4. The Roku reboots. When it comes back the screen shows its IP address; note
   that too. (It's also under *Settings → Network → About*.)

Developer Mode stays on until you turn it off, and survives reboots.

## Sideloading the channel

Build the package:

```sh
./roku/tools/package.sh
# -> roku/build/portal-roku.zip
```

Then either upload it from a browser:

1. Go to `http://<roku-ip>` on a machine on the same network.
2. Sign in as user **rokudev** with the developer password from step 3 above.
3. Under *Development Application Installer*, click **Upload**, pick
   `roku/build/portal-roku.zip`, and click **Install**.
4. The channel launches straight away, and afterwards appears on the Roku home
   screen as **Portal**.

…or let the script do it:

```sh
./roku/tools/package.sh 192.168.1.44
# prompts for the developer password, or reads $ROKU_DEV_PASSWORD
```

Re-running either one replaces the installed copy. Only one sideloaded channel
can be installed at a time — that is a Roku limit, not ours.

### Watching the logs

While a sideloaded channel runs, the device streams its console on port 8085.
macOS dropped `telnet`, so use `nc`:

```sh
nc <roku-ip> 8085
```

Every `print`, every crash and every SceneGraph warning shows up there. It is
the only real debugging surface, so keep it open the first time you run this.

---

## Using it

The channel opens on **Live TV**. The top row is the section picker; below it
the category list on the left and the grid on the right.

| Key | Where | What it does |
| --- | --- | --- |
| **D-pad** | anywhere | Move focus |
| **OK** | section tab | Switch section |
| **OK** | category | Open that category in the grid |
| **OK** | channel | Play it |
| **OK** | movie / series | Open its detail screen |
| **\* (options)** | category | Pin / unpin it — jumps to the top of the list |
| **\* (options)** | grid item, detail, series | Add / remove from favorites |
| **Back** | grid → categories → tabs → out | Step back one level |
| **Back** | during a conversion | Cancel it |
| **Up / OK / Info** | during playback | Show the title banner again |

**Search** is the first row of the category list. Open it and the list filters
as you type, exactly like the web player's category box; Back closes the
keyboard and keeps the filter.

**Settings** (last tab) holds the server address, the MKV switch described
below, and a *Reload the library* button that forces the next section to pull
fresh from the provider instead of the Pi's cache.

---

## Configuration

The server address defaults to `http://192.168.1.18:8420` and is editable from
*Settings → Server address*. It is stored in the Roku registry, so it survives
relaunches but not a reinstall of the channel. You can type a bare host
(`192.168.1.20`) — `:8420` is filled in, and so is `http://`.

Note this is the Pi's **LAN** address, not the `kalshi.taila9b3f4.ts.net` name
the web player uses. Roku has no Tailscale client, so the TV cannot resolve
that name — it fails at DNS before reaching the Pi, and the channel reports
"could not resolve host". The practical consequence is that the channel only
works on the home network, which for a television is no great loss.

Give the Pi a **DHCP reservation** on the router. A LAN address is a lease, and
when it moves the channel simply stops finding the server. There is no fallback
to lean on: Roku will not reliably resolve `.local` mDNS names either.

This is not hypothetical. The Pi was answering on both `.15` and `.18` — one
address being a stale lease — and `.15` stopped responding partway through
development, taking the channel's default with it. `deploy.sh` targets `.18`,
which is the reliable one.

A value saved from the Settings screen lives in the registry and takes
precedence over this default, so changing `ConfigDefaultBase()` will not move a
device that has already had an address typed into it. Retype it in Settings on
that device, or uninstall and re-sideload to clear the registry.

To change the compiled-in default, edit `ConfigDefaultBase()` in
[`source/Config.brs`](source/Config.brs).

---

## How it maps onto the API

Everything below was read out of `server.js` rather than assumed. Two things
did not match the brief:

- **`/api/prefs` is `GET` and `PUT`, not `POST`.** A POST returns
  `405 Method not allowed` (server.js:2492). The channel uses PUT, and sends
  back only `pinnedCategories` and `favorites` — the handler merges field by
  field, so the web player's `liveLatency` and category filters are left alone.
- **`/stream?u=` and `/img?u=` encode their target differently.**
  `/stream` expects base64url (`proxyPath()`, server.js:1680); `/img` takes a
  plain URL (`handleImage()`, server.js:1952). The channel never builds a
  `/stream` URL itself — `/api/play` returns one ready-made — and wraps posters
  with `/img?u=<url-encoded>`.

| What the channel needs | Endpoint | Notes |
| --- | --- | --- |
| The categories in a section | `GET /api/xtream?action=get_live_categories` (or `get_vod_`/`get_series_`) | Filtered here with the prefs regex — see below |
| The streams inside one category | `GET /api/xtream?action=get_live_streams&category_id=` (or `get_vod_streams`/`get_series`) | One category at a time; this is the unit the grid shows |
| Movie synopsis, runtime, genre, codecs | `GET /api/xtream?action=get_vod_info&vod_id=` | |
| Seasons and episodes | `GET /api/xtream?action=get_series_info&series_id=` | |
| What's on now, for the live banner | `GET /api/xtream?action=get_short_epg&stream_id=&limit=1` | server.js base64-decodes the titles for us |
| A playable URL | `GET /api/play?kind=&id=&ext=` | Returns a `/stream?u=…` path and the container it resolved |
| Non-native containers | `GET /api/remux` then poll `/api/remux/status` | Then `/api/remux/stop` when playback ends |
| Posters and logos | `GET /img?u=` | |
| Pins and favorites | `GET` / `PUT /api/prefs` | |

### Why not /api/library

The brief pointed at `/api/library`, and v1 used it. It does not survive
contact with this provider. One call for Live returns **57,050 streams across
911 categories, 10.2 MB of JSON**. Turning that into ContentNodes took 24
seconds and then the Roku killed the channel outright:

```
[library] live: fetch+parse 5080ms, 10246234 bytes
[library] live: built 57050 items in 911 categories, 24523ms total
EXIT_CHANNEL_MEM_LIMIT_FG
```

That is a hard per-channel memory ceiling, not something a leaner projection
gets under. A browser can hold a 10 MB catalogue; a Roku cannot.

Only one category is ever on screen, and they average about 63 items — so the
channel fetches the category list once and the streams one category at a time,
which is what Xtream's `category_id` parameter is for. `/api/xtream` forwards
every parameter except the credentials, so this needs nothing new from the
server. Category lists are small enough to cache for all three sections at
once; the streams inside them are not cached at all.

Two consequences worth knowing:

- **The category filter runs here, not on the server.** `/api/library` applied
  `prefs.filters[tab]` itself; going direct to `/api/xtream` skips that, so the
  channel reads the same regex from `/api/prefs` and applies it with `roRegex`.
  A pattern that fails to compile keeps everything, matching what
  `buildLibrary()` does. This is duplicated logic and the two need to stay in
  step.
- **No item counts beside each category.** The web player has them because it
  has already downloaded every item. Here the count appears in the grid heading
  once the category opens.

### Live TV really is HLS — confirmed, not assumed

The brief said live should come back as HLS and need no format negotiation.
That checks out:

- `buildStreamUrl()` (server.js:521) builds a live URL as
  `…/live/<user>/<pass>/<id>.${ext || cfg.preferredFormat || 'm3u8'}`, and the
  channel sends no `ext` for live, so the Pi's `preferredFormat: m3u8` wins.
- `/api/play` returns that as `{ url, format: "m3u8" }`, and its `drain`/`hold`
  latency tuning is gated on `format === 'ts'` (server.js:2851) — so with m3u8
  configured, **the Lowest/Balanced/Instant picker is already a no-op**. That
  is a second reason it stays out of v1, beyond it just being out of scope.
- `handleStream()` spots the `.m3u8` and rewrites every segment reference to a
  proxied absolute path before serving it as
  `application/vnd.apple.mpegurl` — which the Video node opens with
  `streamFormat = "hls"` and nothing else.

If the Pi's `preferredFormat` is ever switched to `ts`, live still plays:
`StreamFormatFor()` maps whatever `/api/play` reports onto the right
`streamFormat`, and `ts` is a format the Video node handles.

### When playback is refused

Roku's decoders and its HLS parser are both stricter than a browser's, so a
stream the web player opens can still be refused here — an unsupported codec,
or a playlist that parses everywhere else. Rather than stopping at the first
refusal, the channel falls back once and says so on the console:

Both kinds fall back the same way: **anything refused on direct play is
retried through `/api/remux`**, which repackages it and normalises the audio.

Live earns a note, and a correction. A channel reporting `error -5: malformed
data` looks like a codec the box cannot decode, and the obvious suspect is
HEVC — Roku, like iOS, will not demux HEVC inside MPEG-TS. That guess was
wrong here. Probing the actual stream found:

```
Video: h264 (High), 1920x1080, 59.94 fps
Audio: aac (HE-AAC), 48000 Hz, stereo
```

Ordinary H.264, read at 28x realtime. The likely offender is the audio:
**HE-AAC** (AAC+ with SBR) is unevenly supported across Roku models, and
1080p59.94 H.264 additionally needs Level 4.2. Either shows up as a demux
failure, which the device reports as corrupt data rather than as anything to
do with codecs — so "malformed data" is a much weaker signal than it looks.

The remuxer fixes it anyway, but by a different route than expected: with no
`acodec` passed it re-encodes audio to plain stereo AAC-LC while copying the
video, which is cheap and lands inside what every model supports.

Two things follow for live conversions. They **skip the ffprobe step**: it
costs a second connection to a provider that allows exactly one, and ffprobe
is SIGKILLed if it runs long, a teardown that can leave ffmpeg locked out —
which presents as a conversion that starts, prints nothing, and times out. And
since the probe is what would have detected HEVC, live is assumed H.264 unless
a caller passes `vcodec`; the codec only chooses TS versus fMP4 packaging.

One retry, then the error is reported. `[player] error <code>: <message>` in
the console is the device's own verdict, and Roku's error codes are documented
by number.

### Fonts

The channel ships DejaVu Sans rather than using Roku's system font. IPTV
listings are full of characters the system font has no glyph for — the
superscript `ᴴᴰ` that channel names use, box-drawing separators, accented
titles — and each one renders as an empty square. DejaVu covers those, at
about 1.4 MB for the regular and bold faces. `fonts/LICENSE.txt` is its
licence, which permits redistribution.

A font alone is not enough. Listings also carry emoji, regional-indicator flag
pairs and letters from the mathematical alphanumeric blocks, and **no font that
could reasonably be shipped covers those** — DejaVu does not, and swapping it
for another would only move which characters break. So `SafeText()` in
[`source/Util.brs`](source/Util.brs) folds what is left down to ASCII where
there is an obvious equivalent and drops it where there is not:

| Listing text | On screen |
| --- | --- |
| `US\| CNBC ᴴᴰ` | `US\| CNBC HD` |
| `US\| ESPN 𝐇𝐃` | `US\| ESPN HD` |
| `🇺🇸 US\| FOX NEWS` | `US\| FOX NEWS` |
| `ＵＳ｜ ABC` | `US\| ABC` |
| `EN - Café ★ 4ᴷ` | `EN - Café ★ 4K` |

Accents and symbols DejaVu does cover are left alone — only the unrenderable is
touched. Pure-ASCII strings take a fast path and are returned unchanged, which
is most of them.

This applies to display only. Item nodes keep the provider's original string in
`rawName`, and that is what a favorite writes back to `/api/prefs`, so the web
player still shows the emoji it can render.

### Which containers get remuxed

`IsNativeContainer()` in [`source/Api.brs`](source/Api.brs) treats **mp4, m4v
and mov** as playable directly and sends everything else — mkv above all —
through `/api/remux` first. That mirrors `NATIVE_CONTAINERS` in
`public/app.js`, so the two clients make the same call about the same title.

Roku's Video node *can* open an `.mkv`, which is why *Settings → Play MKV
without converting* exists. It is **off by default** on purpose: HEVC inside
MKV only decodes on 4K models, and MKV seeking needs the cue index that
usually sits at the end of the file — dragging that over the proxy from a Pi
is a long silent stall before anything appears. Turn it on if your Roku is a
4K model on a fast link and you'd rather skip the conversion wait; turn it
back off the first time something won't open.

When a conversion is needed the channel does the same handshake as the web
player: start it, then poll `/api/remux/status` until the server's `prebuffer`
target is banked, showing progress the whole time. It calls `/api/remux/stop`
when playback ends, because ffmpeg holds the provider's single connection
until it is told to let go.

---

## Layout

```
roku/
  manifest              channel metadata, icons, splash
  source/               compiled into every thread's scope
    main.brs            entry point
    Config.brs          server address + MKV switch, in the registry
    Api.brs             URL building, container and stream-format rules
    Http.brs            the one roUrlTransfer wrapper — task threads only
    Content.brs         API rows <-> ContentNodes
    Util.brs            conversions, pin/favorite key formats
    Theme.brs           the web player's palette
  components/
    MainScene.*         tabs, categories, grids, and all the orchestration
    DetailView.*        movie synopsis / runtime / genre, Play, Favorite
    SeriesView.*        season picker + episode list
    PlayerView.*        the Video node and its banner
    TextEntry.*         on-screen keyboard, for search and the server address
    CategoryRow.*  PosterCard.*  ChannelCard.*  EpisodeRow.*
    tasks/
      RequestTask.*     one JSON request
      LibraryTask.*     /api/library -> ContentNode tree
      RemuxTask.*       start a conversion, wait for the prebuffer
  images/               generated by tools/make-images.py from public/bison.png
  fonts/                DejaVu Sans — the system font lacks glyphs the
                        provider's titles use
  tools/
    check.py            static checks (blocks, handlers, references)
    make-images.py      icon and splash generator
    package.sh          build the zip, optionally upload it
```

Two structural rules worth knowing before editing:

**All network work happens on Task nodes.** `HttpRequest()` blocks, and
blocking the render thread freezes the picture. A fresh Task instance is
created per call, because a Task can only be running once.

**`/api/library` is parsed into ContentNodes on the task thread, not the render
thread.** Movies runs to thousands of rows; nodes cross the thread boundary by
reference, where the raw arrays would be deep-copied. The category list holds
lightweight proxy nodes rather than the real category nodes — appending one of
those to a second parent would move it out of the library tree.

### Checks

```sh
python3 roku/tools/check.py
```

There is no BrightScript compiler on hand, so this stands in for one: it
balances `sub`/`if`/`for`/`while` blocks, verifies every `onChange`,
`observeField` target and `<function>` resolves to a real routine, checks
`itemComponentName` and script URIs point at something, rejects reserved words
used as names, and validates the manifest's file references. `package.sh` runs
it before zipping.

The reserved-word rule earns its place: `tab`, `stop`, `library` and `pos` are
all BrightScript keywords, and using one as a variable gets you a bare
"Syntax Error" on the device with no indication of which token is at fault.

---

## Not in v1

Deliberately left out, in rough order of how much they'd be missed:

- **Resume / watch history.** The web player remembers where you stopped
  (`/api/profiles/:id/progress`). Here every title starts from the beginning.
  This is the biggest gap and the obvious next thing to build.
- **Profiles.** The web player keeps favorites and pins *per profile* via
  `/api/profiles/:id/prefs`, and falls back to the global `/api/prefs` when no
  profile is picked. The channel only uses the global one — so it syncs with a
  profile-less web session, but not with a specific persona. A profile picker
  at launch would close this.
- **An "All" pseudo-category**, and **item counts in the category list**. Both
  need the whole section in memory at once, which is exactly what the channel
  cannot do — see *Why not /api/library*. Counts show in the grid heading
  instead, once a category is open.
- **Search within a section.** Only the category list is searchable, matching
  the scope. Item search would want a server-side endpoint rather than
  filtering thousands of nodes on the device.
- **Downloads / offline playback**, and **the live latency picker** — the
  latter is a no-op while `preferredFormat` is `m3u8`, as shown above.
- **Seeking inside a remuxed title.** The web player restarts the conversion at
  an offset (`/api/remux?start=`); here trick play is whatever the Video node
  manages over the generated playlist.
- **Deep linking.** `main.brs` passes `launchArgs` into the scene, which is the
  hook for it, but nothing reads them yet.
