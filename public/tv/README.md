# Treasureflix — TV

The Shield build of the portal: 1920×1080, remote only, football first.

This is the implementation of `Treasure Theater TV.dc.html` from the Claude
Design handoff. It is a self-contained folder of static files that talks to the
portal's existing `/api/*` — **no server changes are needed**.

## Where it is

`public/tv/`, served by the portal's own static handler at
`http://<box>:<port>/tv/` — or `/tv`, which now redirects to it. On the Shield,
open that URL — in the browser, or as the start URL of whatever WebView wrapper
you use. It deploys with everything else through `deploy.sh`; there is nothing
separate to install.

**The trailing slash is not optional, which is why `/tv` is a 301.** It used to
answer 200, and that was worse than a 404: the right HTML served at the wrong
base. A browser resolves a relative `css/tokens.css` against the directory of
the current URL, and the directory of `/tv` is `/`. Measured before the fix —

```
/tv                 200
/css/tokens.css     404   <- what /tv then asks for
/tv/css/tokens.css  200
```

— so the page arrived unstyled with no script at all, which on a television
reads as a broken box rather than a mistyped address. One redirect fixes every
relative path at once, and carries the query string over.

No new endpoints, no new dependencies, no build step. The browser portal at `/`
is untouched.

The one change outside this folder: `serveStatic` in `server.js` now serves a
directory's `index.html`. It served files only, so `/tv/` answered 404 and just
`/tv/index.html` worked — not a URL to type on a television. The fallback only
affects requests that would otherwise have 404'd.

Two things it borrows from the portal root when served from there, each with a
local fallback so the folder also works standing alone:

| Asset | Portal path | Fallback |
| --- | --- | --- |
| Bebas Neue | `/fonts/bebas-neue-*.woff2` | `assets/fonts/` |
| Bison mark | `/bison.png` | `assets/bison.png` |

`hls.js` and `mpegts.js` come from the same CDN tags `public/index.html` uses.
If the box is ever offline at boot, vendor them next to this README and change
the two `<script>` tags — the app falls back to the `<video>` element's own
playback when neither is present.

## The start screen

> *"accessing https://tv.treasurestatecapital.com/tv/ shows a blank screen at
> first and then things load after a few seconds, I would rather have the
> start screen than a blank page at first"*

Two causes. hls.js and mpegts.js were plain `<script>` tags in the `<head>`,
so the browser drew **nothing** until both had come from the CDN. They're
`defer` now. Deferred scripts still run in order and before the app module
at the foot of the page, so the app finds them as before. And there was
nothing to draw until the app had the profile and its first screen.

So `#boot` is in `index.html` itself, styled inline: the red bull, the
wordmark and a sweeping line on black. It paints with the first bytes of the
page, says what it's waiting on (`bootSay`), and fades out once the first
screen has drawn (`bootDone`, called from `render()`). If the box can't be
reached it steps aside so the reason shows. After 20 seconds with no app, it
says to check the box. `tests/tvboot.test.js` runs it with a 3-second CDN and
a slow box: the start screen is up in about half a second.

## A controller, not just a remote

> "how can i use the player on an xbox"

An Xbox has Microsoft Edge, which is Chromium, which plays everything this app
serves. The obstacle is input. This app was written for a Shield remote, so it
listens for arrow keys, `Enter` and `Escape` — and on an Xbox that works only
in Edge's **d-pad mode**. Edge opens in **cursor mode**, where the left stick
drives a mouse pointer and the app receives nothing whatever. The first thing
anybody does is push a direction, watch nothing happen, and conclude the box is
broken.

So `gamepad.js` reads the pad directly. The Gamepad API reports it in either
mode, and every button maps onto a key the app already handles — no screen has
to learn what a controller is:

| pad | key | 
| --- | --- |
| d-pad, left stick | `ArrowUp` / `Down` / `Left` / `Right` |
| **A** | `Enter` |
| **B** | `Escape` (which this app already treats as BACK) |

Nothing else is mapped. A control that exists only on a pad would be one nobody
holding a remote can reach, and this app is used with both.

Four things it is careful about:

- **It repeats, but not every frame.** A held direction waits 420ms and then
  walks at 110ms — about six places a second. Unrepeated, a long row is
  unusable; at 60fps it would cross the screen before you let go.
- **OK and BACK never repeat.** Holding A through a list of channels, opening
  each in turn, is nobody's intention.
- **A resting stick is ignored.** The threshold is 0.6, because a pad at rest
  reads a little off centre and a drifting one would walk the focus across the
  screen on its own.
- **A press that arrives twice counts once.** In Edge's d-pad mode the pad
  *already* arrives as arrow keys and Enter, and the Gamepad API reports the
  same press at the same moment — so one push of A would open a channel twice.
  Whichever arrives first wins and the other is dropped inside 60ms.

Polled only while a pad is connected, so a television with no controller near
it does no work at all. A pad that was already on when the page loaded raises
no `gamepadconnected` event — which on an Xbox is the normal case — so the
first key or pointer press starts the poll as well.

`tests/gamepad.test.js` drives a synthetic pad: there is no controller on a
test box, and what is under test is the mapping and the repeat behaviour rather
than whether Chromium can talk to USB.

## The scores feed — connected

`ENDPOINT` is `/api/scores/nfl`, served by the Pi from **ESPN's public
scoreboard**. It needs no key, which is the reason it was chosen: a key in a
page served to the living room is a key given away.

The Pi reads it and maps it, not the television. One place understands ESPN's
shape, one 30-second cache serves every screen in the house, and if the feed is
ever swapped for one that DOES want a key, nothing in this folder has to learn
about it. `normalize()` is still the only place a different feed would touch —
it is close to a pass-through now because the box already emits the Game shape.

What comes across: score, quarter and clock, down and distance, which team has
the ball, the broadcast network, and the kickoff time for anything not started.
`matchChannel()` ties a game to a real channel by name — loosely, so `FOX` from
ESPN finds `US| FOX ᴴᴰ` — which is what makes OK on a score card tune the actual
broadcast. The progress bar still comes from that channel's EPG start and stop,
because the real thing beats a guess from the game clock.

**An empty slate is an answer, not a failure.** On a Tuesday the row is empty,
and if ESPN is unreachable it stays empty rather than falling back to invented
scores — placeholder numbers on a television are worse than no numbers by a
distance. The placeholder slate only appears if `ENDPOINT` is blanked.

The endpoint can be pointed elsewhere for testing without touching the code:

```sh
NFL_URL=http://127.0.0.1:9922/ node server.js
```

## The screens

| Screen | Source |
| --- | --- |
| Live TV home | `/api/library?tab=live`, `/api/profiles/:id/prefs` (hearted + pinned), `/api/epg/now` |
| Player | `/api/play?kind=live`, `/api/epg/now`, `/api/profiles/:id/history` |
| Guide (▼) | `/api/epg/now` for the channels in the flip list |
| Other games (▼ on a game) | `/api/scores` matched against `/api/library?tab=live` |

The slate is asked for **once** and shared: `getGames()` holds it for thirty
seconds and coalesces callers, because behind that one address the box asks
ESPN, the MLB stats API and the NCAA scoreboard — three services across the
internet, and four screens in this app want the answer. The Live screen paints
before it arrives and fills the games row in afterwards, replacing that row
alone and putting the cursor back; the row then re-asks once a minute while the
screen is up, and stops when it is left.

The once-a-minute profile poll only redraws when something a screen is actually
drawn from has changed — hearted channels, pinned categories, binned items,
ratings, the chosen sport. The write counter it used to act on moves every time
any player in the house reports its position, which is twice a minute per
device, so acting on it alone rebuilt the screen all evening for news that was
somebody else's playhead.
| Channel bar (OK) | the same flip list, current channel marked |
| Multi-view | four `/api/play` streams, audio follows focus |
| Movies | `/api/library?tab=movies`, `/api/profiles/:id/taste`, `get_vod_info` for the spotlight synopsis |
| Series | `/api/library?tab=series`, `/api/profiles/:id/taste` |
| Show page | `get_series_info` — seasons come from the episodes that exist, not the provider's season count |
| Favorites | `/api/profiles/:id/prefs` |
| Archive | `/api/archive/status|browse|recent|play` (owner profile only, `profileId` on every call) |
| Downloads | `/api/downloads`, `…/pause`, `…/retry` |
| Search | the three cached libraries plus `/api/archive/search` |
| Playback of anything not live | `/api/play?kind=movie|series`, `/api/archive/play`, `/api/downloads/:id/file` |

That last row is the one screen past the design: the mockup stops at the loading
screen for films and episodes, and without a VOD player nothing on Movies,
Series, Archive or Downloads can actually be watched. It keeps the design's
language — brand field while it opens, one bottom scrim, hints spelled out.

## The remote

| Key | What it does |
| --- | --- |
| ▲ ▼ ◀ ▶ | move; rows remember their column |
| OK | watch / open / press |
| BACK | up a level; on Live TV it parks on the nav |
| ▼ in the player | the other games on a game, otherwise the guide |
| ▼ again, from the other games | the guide |
| OK in the player | the channel bar, without leaving the picture |
| ◀ ▶ / ▲ ▼ while a film plays | 10 seconds / 5 minutes |

`Escape` and `Backspace` are accepted as BACK, so the whole thing is drivable
from a keyboard while you are working on it.

## Rules of the box this app obeys

These are not stylistic choices; getting them wrong makes the box misbehave.

- **One provider connection.** Playback owns it. The library is fetched once per
  section per session and cached; EPG is asked for in one batch per screen and
  held for five minutes; no polling runs while the player is up.
- **Metadata dies during playback.** While ffmpeg is streaming, the provider
  answers metadata calls with `{"error":""}`. The spotlight synopsis is only
  fetched on browse screens, and only after the cursor has settled for 700ms.
- **The archive is owner-only** and answers 403 otherwise, so the screen says so
  instead of showing an empty drive. Every archive call carries `profileId`.
- **A download is a cache, not an offline copy.** The Downloads screen says it in
  those words, because "downloaded" implies something it does not mean here.
- **Favourites and pins live on the box**, per profile — hearted on the phone,
  there on the TV.

## Layout

The stage is exactly 1920×1080 and is *scaled* to the panel rather than
reflowed. A Shield is always 16:9, and a 10-foot layout that reflows only ever
gets smaller. Every dimension in `css/tv.css` is the number from the design.

Focus, never hover: one cream double ring (a background-coloured spacer ring,
then the ring itself) plus a 6px lift; nav pills invert to a cream fill instead.
Crimson stays chrome-only so the ring never fights the header.

## Files

```
index.html          the shell: header, nav, screen hosts, hint bar
css/tokens.css      design-system tokens, verbatim
css/tv.css          the layout, all screens
js/app.js           router, chrome, key handling, the loading screen
js/focus.js         the D-pad: rows, columns, column memory, scrolling
js/api.js           every call this app makes to the box
js/state.js         profile, prefs, taste, library and EPG caches
js/scores.js        THE PLACEHOLDER SCORES FEED — swap point
js/ui.js            element makers, artwork with station-name plates, toast
js/screens/*.js     one module per screen
```

A screen module exports `render(host, app, params)` and, as needed,
`activate(node, app)`, `onKey(key, ctx)`, `onFocus(node)`, `back(app)`,
`leave()`, and `fullbleed`. It paints into the host it is handed and numbers its
own rows; focus, scrolling and the nav are the shell's job.
