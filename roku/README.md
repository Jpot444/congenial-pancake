# Portal for Roku

A native Roku channel (BrightScript / SceneGraph) that browses and plays the
same Live TV, Movies and Series catalogue as the web player, from the same Pi.

It is a **client only**. `server.js` is untouched — every screen here is built
out of endpoints the web player already uses, and pins and favorites are read
and written through `/api/prefs` so the two stay in sync.

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

While a sideloaded channel runs, the device streams its console over telnet:

```sh
telnet <roku-ip> 8085
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

The server address defaults to `http://kalshi.taila9b3f4.ts.net:8420` and is
editable from *Settings → Server address*. It is stored in the Roku registry,
so it survives relaunches but not a reinstall of the channel. You can type a
bare host (`192.168.1.20`) — `:8420` is filled in, and so is `http://`.

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
| Categories + items per section | `GET /api/library?tab=live\|movies\|series` | Parsed and turned into a ContentNode tree on a Task thread |
| Movie synopsis, runtime, genre, codecs | `GET /api/xtream?action=get_vod_info&vod_id=` | |
| Seasons and episodes | `GET /api/xtream?action=get_series_info&series_id=` | |
| What's on now, for the live banner | `GET /api/xtream?action=get_short_epg&stream_id=&limit=1` | server.js base64-decodes the titles for us |
| A playable URL | `GET /api/play?kind=&id=&ext=` | Returns a `/stream?u=…` path and the container it resolved |
| Non-native containers | `GET /api/remux` then poll `/api/remux/status` | Then `/api/remux/stop` when playback ends |
| Posters and logos | `GET /img?u=` | |
| Pins and favorites | `GET` / `PUT /api/prefs` | |

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
`itemComponentName` and script URIs point at something, and validates the
manifest's file references. `package.sh` runs it before zipping.

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
- **An "All" pseudo-category.** The web player has one; here a category must be
  picked. Two reasons: 15,000 posters is not a browsable surface on a D-pad,
  and a node can only have one parent, so an All row would mean a second copy
  of every item node in memory.
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
