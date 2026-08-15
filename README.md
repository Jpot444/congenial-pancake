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

### On an iPhone home screen

Added to the home screen from Safari, this used to come up as a **"P"** on a
grey tile. A site with no `apple-touch-icon` gets a screenshot or the first
letter of its document title, and the title still begins "Portal" — so both
halves of that were the same omission.

`public/bison.png` is now the icon, and deliberately **the same file** the
profile gate and the loading screen already show rather than a copy made for
the purpose, which is one more thing to keep in step. The `<link rel="icon">`
points at it too, so the browser tab carries the mark instead of a TV emoji.
`apple-mobile-web-app-title` names it *Treasure Theater*, which is what the app
is called everywhere except its `<title>`.

Two things about that file decide what the tile actually looks like, and
neither is visible from the markup:

- **It carries transparency, and iOS paints that black.** The mark is a white
  silhouette on nothing, so the tile is white-on-black rather than white on the
  brand crimson.
- **It is 219×148, not square.** iOS fits a non-square icon to the square tile.

Both are consequences of using the mark itself, unaltered. If the shape looks
wrong on the phone, the fix is to centre those exact pixels on a square canvas
— no recolouring and no resampling, so still the same bison.

iOS caches home-screen icons hard: an existing shortcut keeps the old tile
until it is removed and added again.

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
  **Drag a pin to reorder them**; the order is stored per profile and per
  section. A tap still unpins — the drag only starts once the pointer has moved
  past a few pixels, so the two gestures do not fight each other.
- **Favorites** — heart anything from the player.
- **Downloads** — pull a movie or episode to disk for offline viewing.
- **Search** — filters the current section as you type.

Pins and favorites are stored **server-side** in `prefs.json`, not in browser
storage, so they're identical on every device that hits the same server. That's
the point once this lives on the Pi behind Tailscale. Favorites from the older
localStorage-only build are migrated automatically on first load.

## Downloads: two steps, and only the second one is offline

This was called "downloads and offline viewing" and that was a lie worth
correcting rather than quietly fixing, because somebody believed it and was
right to.

**A download goes to the Pi, and the Pi is not offline.** Reaching the player
means reaching the box, so when the wifi is out, a file sitting in `downloads/`
is exactly as unreachable as the stream. The old tour copy went further — it
promised a download "plays even when the wifi shits the bed" — which is simply
false. That sentence is gone.

What the box copy *is* is a **cache**, and a good one:

- it costs **no provider connection**, so it does not compete with anything;
- it starts immediately rather than waiting on the provider's ~0.58 MB/s pacing
  and a 45-second prebuffer;
- several people can watch the same title at once, which a one-connection
  account otherwise forbids.

**The offline copy is the second step: Save to device.** That is the one that
lives on your phone and survives airplane mode. It is now offered the moment a
download is ready, as an action on the toast, rather than waiting in a list
nobody had a reason to go back to — and Downloads itself carries a short note
saying which step is which, dismissible and remembered per profile.

### Why it cannot go straight to the device

Three reasons, and each on its own is enough:

1. **Credentials.** Your phone never talks to the provider. The Pi holds the
   username and password and proxies everything, so a direct download would mean
   putting them on every device in the house.
2. **The container.** The provider ships `.mkv`, which **no phone will play**. A
   direct download would drop a dead file into the Files app. `prepareForBrowser`
   converts every finished download to MP4 and sets `job.ext = 'mp4'`, and that
   is the file `/save` hands over — which is also why the offer waits for
   `preparing` to clear rather than firing when the bytes land.
3. **The single connection.** A straight-through transfer holds it for the whole
   download, with no pause and no resume. The box's version pauses itself the
   moment somebody starts watching.

So the two steps are not an accident of the design. The second step is the
payload, and the first step is what makes the payload playable.

Open a movie and press the download arrow in the player bar; for a series, each
episode row has its own arrow. Files land in `downloads/` next to `server.js`.

From the Downloads tab each finished item offers:

- **Save to device** — sends the file with `Content-Disposition: attachment`, as
  a plain link with `download` rather than a fetch into a blob: a film is
  gigabytes and a phone has not got them to spare. iOS puts it in Files, a Mac in
  Downloads.
- **Play** — streams it from local disk, using no provider connection at all.
- **✕**, top right of the poster — deletes it and frees the space. On a series
  card at the top level that means the whole show, after a confirmation naming
  how many episodes go. Inside a show, each episode carries its own ✕ and
  removing one leaves the rest; take the last one and you land back at the top
  level rather than in an empty folder.

The ✕ was previously revealed on hover, which meant it did not exist on a phone
at all — a finger cannot hover, so deleting anything needed a mouse. It is now
shown outright wherever the pointer cannot hover.

**Your account allows one concurrent connection**, so downloads run strictly one
at a time and a download in progress will block live playback. That's why every
running download has a **Pause** button: pause it, watch what you want, then
resume. Pausing keeps the partial file and resumes from the exact byte offset
via a Range request rather than starting over. Downloads interrupted by a server
restart come back as paused and resume the same way.

### Downloading, once

The same title is never saved twice, and both ends enforce it: the client
turns the request into an explanation ("Already downloaded — it's in
Downloads." / "Already in the download queue.") before asking, and the server
refuses a duplicate with a 409 in case anything asks anyway. Matched on what
the title IS — kind plus provider stream id — never on the name, and a FAILED
attempt does not count, because failing is exactly when asking again should
work. On a show's card, every episode already saved wears a green check where
its download arrow was, and one on its way says so; pressing either explains
instead of queueing a copy.

**A whole season is one press** — the "Download season" button beside the
season chips (and the download button in the player does the same for the
open season). It skips everything already saved or queued, then asks before
committing the box, saying exactly how many episodes it is about to queue and
how many it is skipping. They download one at a time — the provider allows a
single connection — and pause automatically while anybody is watching.

### Every profile but one has a 20GB allowance

`hunter` downloads without limit. Everyone else gets 20GB, counted across that
profile's own downloads — finished files at what they weigh, running and queued
ones at what they *will* weigh, so queueing twenty at once cannot sail past the
line before the first of them lands.

It is checked twice, because the two moments know different things. **At the
request**, all that exists is what is already used; over the line and the POST
comes back `413` with a sentence the client toasts as-is. **When the download
starts**, `Content-Length` arrives and the file's real size is known for the
first time — so this is the only gate that can stop a single 5GB film asked for
by a profile sitting at zero. That one destroys the socket, deletes the partial,
and fails the job with a message naming the film's size and what is left, which
the Downloads grid shows on the card. Only the second check can be the whole
answer, and only the first can refuse without spending a connection.

A season download asks per episode, so a refusal partway through used to be
reported as "Queued 0 episodes" with no reason given. The loop now carries the
first refusal out and says it.

The count is per profile rather than per box on purpose. The Pi's disk is
shared, so a global cap would mean whoever downloaded first got everything and
everyone else got a wall — an allowance nobody could reason about. Per profile,
the number in front of you is yours and deleting your own things is what frees
it.

Two things it deliberately is not. It is **not** enforcement: profiles carry no
authentication, so anyone can switch into `hunter` and download freely. It is a
guard rail for a handful of people who share a Pi, and it is honest about that.
And it is **not** a disk-space guard — the sum of everyone's allowances can
still outrun the card. Downloads record their owner (`profileId` on the job) so
a file bought by one profile is not charged to another; downloads made before
this shipped have no owner and count against nobody.

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

**Every device here runs Chrome**, which is why the desktop path assumes MSE
and hls.js rather than native HLS. It does not make the iOS branches dead code:
on an iPhone or iPad every browser is WebKit underneath, Chrome included,
because Apple requires it. `isIOS()` keys off the device rather than the
browser name for exactly that reason, so the native-fullscreen handoff and the
HEVC-in-fMP4 packaging still apply to Chrome on the phone.

The playback report names the browser it came from, and whether that browser
has MSE, native HLS and hls.js. Several rounds of chasing an audio fault were
spent reasoning about engine behaviour without the report ever saying which
engine was running.

## Profiles

Netflix-style personas. Each carries its own favorites, pinned categories,
watch history and ratings, all stored server-side in `profiles.json` so a
profile is the same on every device.

**The password is optional, and off by default.** Creating, deleting, renaming
and switching are all open unless the **profile lock** is turned on, which is
done from the link under *Manage profiles*. With the lock on, adding and
deleting ask for the password again; editing a name or icon stays open either
way.

Turning the lock on needs the password too, not just turning it off. Off→on
being free would let anyone lock everyone else out of a switch they had no way
to flip back.

The password itself is kept whether the lock is on or not, so switching it back
on does not mean choosing a new one.

Be clear-eyed about what that password is and isn't. It stops someone casually
adding a profile or wiping another's history. It is **not** access control for
the server, which still has no authentication of its own — anyone who can reach
the port can browse the library and switch into any existing profile. The
network is the perimeter. That is most of why the lock is off by default:
demanding a password to add a profile on a box only close friends can reach was
friction spent on a boundary that was never there.

The password is never written to disk in the clear: `profiles.json` holds a
scrypt salt and hash, seeded on first run, compared in constant time, and the
file is `0600`. Five wrong guesses from one address locks that address out for
a minute. To change the password, delete the `auth` block from `profiles.json`
and restart — it re-seeds.

The first profile created inherits whatever was already favorited and pinned
before profiles existed, so nothing is lost on upgrade.

## The suggestion box

**The pulse in the corner is Hunter's.** It reports memory, temperature, load
and what is converting — a diagnostic for whoever runs the box, and nothing
anybody else can act on. So for every other profile that button is not the
pulse: it is a way to say something is broken, or to ask for something. Swapped,
not added beside — one button lives in that corner and which one depends on who
is watching.

Ownership is by **name**, `hunter`, the same way the download allowance is, and
for the same reason: this is a house of a few people who all know each other,
and an `owner: true` field on a profile anyone can edit from the profile screen
would be ownership in name only. The server decides it and sends the answer with
the profile's prefs, so there is one place that knows rather than two that could
disagree.

### What happens to a report

It lands in `reports.json` on the box — gitignored, `0600`, because a report
carries whatever somebody chose to type, including how to reach them — and
turns up in the **Reports** section of Pi health, newest first, alongside
everything else the box is telling you. Each one carries who sent it, whether
it is a problem or an idea, the version and page it came from, how to reach
them if they said, and the playback report if there was one.

That is the whole of it. There is no forward, nothing to configure and nothing
that can be unreachable — the thing that has to work is that Hunter sees it, and
the box he is looking at is the box it is stored on.

### Credentials are stripped on the way in

A bug report is very often a pasted playback report, and this provider puts the
account password **inside every stream URL**. Nothing leaves the box now — but a
report is a thing people copy out of the panel and paste elsewhere, which is
exactly how those credentials got loose twice before.

So `redactUrl` runs over every free-text field **at the point of storage**,
not when something is displayed. That way no copy anywhere carries a credential:
not the file, not the panel, not whatever gets pasted out of it. A URL survives
as host plus filename, which is what makes a report readable, and the
credentials in the middle of it do not survive at all.

### Being told about it

A profile that was already here gets **one modal, once**, the next time it signs
in — a button changing under somebody is worth a sentence, and the people who
most need to know there is now a way to report a problem are exactly the ones
who were here before there was. Written down on the profile
(`reportNoticeSeen`), so it does not come back on the next device.

A **new** profile does not see it. The tour explains the same button while
pointing at it, which is better, and two explanations of one button is one too
many — so the tour step is marked seen on the way past. That step reads
differently depending on which button is actually in the corner, the same way
the Downloads step reads differently depending on the allowance.

Hunter can send a report too, from inside the Reports section. He is not the
only one who finds bugs, and a suggestion box he cannot use is a strange thing
to own.

## The walkthrough

A new profile gets a guided tour on its first load: a dimmed screen with a hole
punched over one control at a time, a card beside it explaining what the control
does, a count of how many steps are left, **Next**, and an **✕** that ends it.
It is written for the handful of people who actually use this, so it is rude.
That is the point — nobody reads a polite tour.

`tourDone` is stored per profile alongside favorites, so it runs once per
person rather than once per browser. Switching to a phone does not start it
again.

Three things about it are less obvious than they look:

**The steps are chosen from what is on screen, not from a list.** Each step
names a selector; a step whose target is not rendered is dropped before the
tour starts. So the desktop tour walks the nav and the phone tour walks the tab
bar, without either layout being described anywhere.

That only works if the *visible* copy is the one picked. Several steps name both
layouts (`.nav a[href="#/live"], .tabbar a[href="#/live"]`) and both exist in
the DOM at all times — the hidden one is hidden with `hidden`, not removed.
`querySelector` returns the first match in document order, which on a phone is
the desktop nav link, which has no box, so the step was dropped and the phone
tour lost every tab. The lookup takes the first match **that has client rects**,
which is the one the reader can see.

**The highlight is one element, not four.** A hole in a dim overlay is normally
four divs boxing the target in. This is a single box with `box-shadow: 0 0 0
9999px rgba(8,5,5,.78)` — the shadow paints everything outside the box, so
moving the highlight is four style writes and the dimming follows for free. It
also means the hole can be transitioned, which is why it slides between steps
rather than jumping.

**The card is placed, not positioned in CSS.** It goes below the highlight, or
above it when there is no room below, then is clamped into the viewport — a card
half off the screen is worse than one slightly overlapping what it points at.
On a resize it repaints, because a phone rotating mid-tour otherwise leaves the
hole over nothing.

The Downloads step reads the profile's own allowance rather than a fixed
sentence, so `hunter` is told there is no limit and everyone else is told the
number they have.

### Starter pins, and the one note that is not in the tour

Every profile starts with Hunter's Live TV categories already pinned — the
networks and the PPV feeds — so nobody's first visit is four hundred categories
deep with the game somewhere in the middle. A separate one-step note explains
them, shown **the first time that profile opens Live TV** rather than during
the opening tour: the pins are three clicks from where that tour runs, and a
step pointing at a screen you are not on explains nothing. It is tracked by its
own `liveTourDone`, so ending the opening tour early does not skip it.

The pins are stored by the provider's category **id**, but the starter list is
written as **names**, because ids mean nothing outside one provider's account.
Names are resolved to ids once, when a profile first reaches Live TV — the
first moment the categories exist at all.

Matching them is less trivial than it looks. The provider dresses names in
quality tags built from unicode superscripts — `US| NBC ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ` — which
read as letters and digits to a human and as nothing at all to `a-z0-9`.
Stripping them is the point, so a channel still matches when its tag changes.

But stripping alone is wrong, and the real list proves it: it contains both
`US| PPV EVENT` and `US| PPV EVENT ⁽ᴮᴷ⁾`, which strip to the same string. Going
stripped-first pinned one of them twice and lost the other. So the full name is
tried first, and the stripped form only as a fallback — and only when it picks
out exactly one category, since guessing between two that differ by a tag gets
it wrong half the time.

A name that matches nothing is skipped. The seeding is marked done either way:
a provider that renamed everything will not have renamed it back by the next
visit, and re-running would fight anyone who unpinned what it left.

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

Other endpoints: `GET/POST /api/profiles`, `PUT /api/profiles/lock`,
`PATCH/DELETE /api/profiles/:id`,
`GET/PUT /api/profiles/:id/prefs`, `POST /api/profiles/:id/history`,
`POST /api/profiles/:id/rating`.

## Hiding a title you never want to see

Hover a film or show on the desktop and a bin appears in the corner of the
poster — deliberately on hover, so it is not sitting on every poster in the
library. It hides that title from the grids, from the named rows, from For You
and from search. All four, because hiding it from some and not the others is
worse than not hiding it at all.

Hidden, not deleted: the provider still carries the title and will keep sending
it, so this is a list of things not to show. It is kept per profile, since one
person's junk is another's watchlist.

Live TV has the same thing, at both levels. A bin on a **category tile** hides
that whole category from the grid, with a **Deleted** tile at the end of the
grid to get them back; a bin on a **station card** hides that one channel. The
two are stored separately, since one is keyed by kind and id and the other by
category.

Hidden titles and channels collect under **Deleted**, at the foot of the
category list, which only appears once something is in it. In there the button turns into a restore arrow
and is always visible rather than hover-revealed — it is the only way back, and
hover is not a gesture a phone has.

Category counts are taken after the hidden ones are removed, so a category that
says 6 opens with 6 in it.

This is stored per profile and so is meant to follow you between devices — and
for a long time it did not. `PUT /api/profiles/:id/prefs` accepted the whole
object but only ever wrote `favorites` and `pinnedCategories` through to
`profiles.json`; `deletedItems`, `deletedCategories` and `pinOrder` were saved
by the client, acknowledged by the server and dropped. Nothing failed, which is
why it lasted: the tab you were on kept the hiding, because it kept it in
memory. The server now persists every key it is sent, and returns them all.

## The home screen

`#/home` is the landing page, and **the badge in the top left is the way back
to it**. It is deliberately not a tab — it is in neither the desktop nav nor the
phone tab bar, because it is where you already are when you open the app.

On a desktop it is one large poster of the last thing watched, a 2×2 of the
four before it alongside, and the two favorite sets side by side underneath.

Only two things changed from the first version of that layout, and neither is
the shape:

**The favorites are the posters themselves.** They used to be four thumbnails
on a box that opened the favorites *list*, so reaching anything you had starred
took two clicks and the first was never the one you wanted. Now pressing a
poster opens it — a channel tunes in, a film or a show opens its page, the same
rule the grids follow. The column heading carries an *All 40 ›* link only when
it is showing fewer than there are.

**The whole page fits the window.** That is the constraint the sizes bend to.
`.home-recent-layout` has an explicit height in `vh` rather than letting the
hero's artwork decide, because with the favorites underneath it is the height
that runs out first. Two other things had to give: the app shell's 80px of
run-off padding, which home does not want because it is not meant to scroll,
and the second line of title under a favorite, where the artwork identifies the
thing anyway.

The favorite tiles are a fixed six across rather than `auto-fill`. They sit in
a known half of the page, and letting them wrap would put the second line below
the fold — which is the one thing this is for.

**Nothing on this page is cropped.** Every image is `object-fit: contain`, and
that is not a detail — it is the difference between seeing a poster and seeing
the middle of one. The boxes are sized by the layout, so their shape is
whatever is left after the block height is divided up; the artwork's shape is
whatever the provider sent, and the two are never the same. `cover` fills the
box by throwing away the difference, which on a block wider than a 16:9 still
means the top and bottom of every one of them — heads cut off, logos clipped.
The recent block is deliberately as *tall* as the page budget allows for the
same reason: a taller block is a box closer to the picture's own shape, and so
less empty margin around it.

Channels get a 16:10 plate rather than a 2:3 one — an ident is wide and has
writing on it — and the four cards under the hero use 16:10 on a phone too,
since the artwork in that row is mostly wide and a tall box around a wide
picture is margin, not poster.

On a phone it all stacks — a hero beside a 2×2 leaves both unreadable at 390px,
and two favorite columns more so — and the four under the hero become one row
rather than a 2×2.

Two things make the page worth having at all:

- **It needs no library fetch.** Everything on it comes from watch history and
  favorites, both already loaded, so the badge always lands somewhere instantly
  even on a cold start where Movies would sit on a skeleton.
- **Series collapse to one card.** History is recorded per episode, and five
  cards of the same show is not a landing page.

**Continue watching plays; it does not browse.** Clicking a show here starts
the episode that was left off. It used to open the show's page, which is the
exact work the row exists to skip.

It still routes *through* the show's page to get there, and that is the
interesting part. A history row knows the episode **number**; everything
downstream wants its **index** in the season, and the episode list is the only
thing that can turn one into the other. So the click records what it wants in
`state.resumeEpisode`, navigates to the show, and the render picks the request
up once the list exists — reusing the resume prompt, the next-episode arming
and the playing-row marker rather than duplicating them for one entry point.

Two consequences worth stating. The player is raised **before** the navigation,
so the show's page does not flash past behind it while the episodes are
fetched. And because the page is genuinely built underneath, the player's
**Series** button lands on it with nothing left to load — which is the other
half of what this is for.

The request is claimed and cleared the moment a render sees it, so a request
that cannot be met — the provider dropped that episode — does not sit in the
state waiting to fire at the next show someone opens. When it cannot be met the
empty player is taken back off the screen and the show's page, already drawn,
is what is left.

Tiles carry `min-width: 0`. A grid item's default `min-width: auto` is its
min-content width, so without it one long film title is enough to push a tile
past its track — and once the old home screen did exactly that, 146px wider
than the phone it was on.

## Two layouts, not one that stretches

The phone button in the header opens **This device**, which chooses between a
phone layout and a desktop one and remembers it in `localStorage` — the same
profile is used from both, and only one of them wants any of this.

Phone layout is a different shape, not a scaled-down desktop:

- **The sections move to a bottom bar.** Live, Movies, Series, Favorites and
  Saved sit where a thumb reaches, the way a native app puts them, and the
  hamburger and its dropdown are hidden — two routes to the same five places is
  one too many. The bar clears the home indicator with
  `env(safe-area-inset-bottom)`.
- **The document does not scroll; the view inside it does.** The bar used to be
  `position: fixed; bottom: 0` over a scrolling page, which is correct
  everywhere except the one place this runs. WebKit detaches fixed elements
  during momentum scrolling and rubber-banding, so scrolling past the end of a
  shelf bounced the whole page and dragged the bar up into the middle of the
  screen with it. Nothing can hold a fixed element still through that bounce —
  the bounce *is* the browser moving the viewport out from under it.

  So the bar is not fixed any more. Under `has-tabbar`, `body` becomes a
  `position: fixed; inset: 0` column that cannot scroll, `#appView` is the only
  thing in it that does, and the bar is an ordinary row at the bottom of the
  column.

  **The frame is sized to what you can SEE**, which is not the same box as the
  viewport. Two earlier versions failed identically, which was the tell:
  `height: 100dvh` and `position: fixed; inset: 0` both place the bottom edge at
  the bottom of the *layout* viewport. Open this from an iPhone home-screen icon
  created before the app declared itself standalone and that view carries
  Safari's chrome, with the layout viewport running on behind its bottom
  toolbar — so the bar was correctly at the bottom of the viewport and
  underneath the toolbar. Invisible, twice, for the same reason.

  Three things fix it, and each covers a case the others do not:

  - **`--app-h`**, set from `visualViewport.height`, is the part actually on the
    glass with browser chrome and any keyboard already subtracted. CSS has no
    unit for that — `dvh` tracks the toolbars but is still the layout viewport
    in this mode — so it is measured and written into a custom property on
    `resize` (never `scroll`, which fires on every frame of a toolbar sliding).
  - **`min-height: 0` on the frame.** `body { min-height: 100vh }` further up
    the stylesheet defeated every height above it, and on iOS `100vh` is the
    *large* viewport — the one including the strip behind the toolbars. The
    frame could not be made shorter than the visible area however it was sized.
    This was the line really holding the bar down there.
  - **`apple-mobile-web-app-capable`**, so a home-screen icon opens with no
    browser chrome at all and the question does not arise. iOS reads it when the
    icon is created, so an icon added earlier keeps its old mode until it is
    removed and re-added — which is why the two above matter regardless. An
  element in normal flow in a container that never scrolls has nothing to drift
  against. `overscroll-behavior: contain` on the view keeps its own overscroll
  to itself and `none` on the body refuses it outright, so the bounce never
  reaches the frame at all.

  Three things follow. The page no longer carries padding to end above the bar —
  the bar sits *beside* the page now, not on top of it, and that padding would
  be a gap. And `window.scrollTo` no longer scrolls anything here, so
  `scrollViewTop()` scrolls whichever of the two is actually the scroller. And
  the version stamp on the home screen is no longer pinned above the bar but is
  simply the last line of the page — pinned, with the reserved padding gone, it
  landed on top of the last row of posters.

  A desktop is untouched: no bar, ordinary document scrolling, sticky header.
- **A fixed number of posters to a row**, 2, 3 or 4, set in the same panel.
  Desktop keeps `auto-fill` and takes as many as the width allows, so the
  choice only appears in phone layout.

The class behind it is still `.touch`, because every sizing rule in the
stylesheet already hangs off that name and phone layout is what it has always
meant. It auto-enables on a coarse pointer, so a phone and an iPad get it
without being asked; the panel overrides that either way.

## Reordering pins uses pointer events, not drag-and-drop

HTML5 drag-and-drop is the obvious way to build this and it does not work on
iOS Safari at all, which is where this gets used. So the pin is dragged with
pointer events, which behave the same under a finger, a mouse and a trackpad.

Three details carry it:

- `touch-action: none` on a pinned pin. Without it the browser claims the
  gesture as a page scroll and the row never moves — the feature would look
  broken on a phone and fine on a laptop.
- A **6px threshold** before a drag starts, so a tap still unpins. The click
  that lands at the end of a drag is swallowed, or letting go would unpin the
  row that was just moved.
- Rows swap when the pointer crosses a **neighbour's midpoint**, not its edge.
  Edges make rows flicker back and forth while the pointer sits on the
  boundary.

The pointer is tracked by id as well as captured, so a refused capture degrades
to a working drag rather than no drag at all.

## Row headers open the whole row

Movies and Series browse as named rows — New Releases, IMDB Top 250 and the
rest, defined by `MOVIE_ROWS` and `SERIES_ROWS` in `public/app.js`. Each rail
shows only the first 40 titles, because a rail of several thousand is neither
scrollable nor useful.

**The header is a button.** Tapping it drops the rails and lays that row out as
a full grid, paged 60 at a time by the existing Load more, with an **All
movies** / **All series** button back to the rows. Before this, everything past
the fortieth title in a row could only be reached by knowing what to search for.

A row is not the same thing as a provider category — one row can pull from
several, or from per-title genre metadata — so this rides on its own bit of
state rather than the sidebar's category filter. Changing tab clears it, and a
row that stops existing (a changed filter, a category the provider dropped)
falls back to the rows rather than showing an empty page under a title that is
no longer there.

## What order the rows are in

Two answers, because the rows want opposite things.

**New Releases is newest-added first, and nothing else.** The provider stamps
every record — `added` on a movie, `last_modified` on a series — and
`buildShelves` sorts on it descending. New arrivals therefore climb to the front
on their own; the library cache is 30-minute stale-while-revalidate, so a title
the provider added this morning is at the head of the row by lunchtime without
anyone touching the code.

The row is named after a provider category (`EN - NEW RELEASES …`), and that
name is not something we control. If it is ever renamed, split or dropped, the
match finds nothing and the row would simply vanish — so it carries
`fallbackAll: true`: with no category match it draws from the whole tab and lets
`added` do the work. The row means "what is new", not "what is in the category
the provider currently calls new".

**Every other row is shuffled.** A rail shows the first 40 of a row that may
hold three thousand, and without this you would see the same forty posters until
the provider's library order changed — the other 2,960 might as well not exist.
`shuffleShelf` deals a different 40 to the front instead.

The shuffle is a seeded Fisher–Yates, not `Math.random()` in a sort comparator,
and the seeding is where the behaviour actually lives:

- **One seed per page load** (`SHUFFLE_SEED`), mixed with the row title. So the
  posters hold still while you browse — `render()` runs on every pin, hide, tab
  change and search keystroke, and artwork that rearranged under the pointer
  each time would be worse than never shuffling.
- **A fresh seed next visit.** Reload, or come back tomorrow, and it is a
  different hand.

Two rows are exempt. New Releases, for the reason above. And **For You**, whose
order *is* its content — it is the things you watched, most recent first, and
shuffling it would throw away the only information it carries.

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

**`loadTab` hides its own loading screen.** It used to show it and leave hiding
it to whoever called — which held for the two callers that navigate to a tab,
and then broke the moment a third appeared. Multi-view's picker fetches Movies
or Series on demand, had no reason to know it had inherited a loading screen,
and left the bar sitting at 100% over the picker for ever. The overlay is
`z-index: 400`, above everything, so the categories loaded fine and were simply
unreachable underneath it. Whoever shows it hides it, in a `finally`, so a
failed fetch does not strand it either.

### The cinema player

Films and episodes open full-viewport with the chrome floating over the
picture. It fades out after three seconds of no mouse movement while playing —
and takes the cursor with it — then returns on any movement. A paused film
keeps its controls up.

- **Back** (top left) returns to Movies or Series, matching what was playing.
- **Skip ±10s**, play/pause, **subtitles**, mute and fullscreen on the bottom bar.
- Keyboard: space or `k` to pause, `←`/`→` for ±10s, `f` for fullscreen.
- Favorite, download, subtitles and close stay reachable in the top right,
  alongside a **reload** button that throws the current connection away and rebuilds it
  from the same spot — a new remux session for a converted film, a re-resolve
  for live, a re-attach for a file on disk. It is there for playback that has
  gone wrong in a way pausing will not clear.

Live TV keeps the old windowed player; the cinema layout is only for VOD.

### A gradient is not a button

The strip across the top of the player — back button, title, and a gradient to
lift them off the picture — was `position: absolute; top: 0; left: 0; right: 0`,
so its box covered the whole top of the frame and **took every tap that landed
on it**, gradient included.

That only mattered once somebody tried to use the controls underneath it. A live
channel keeps the browser's own video controls, and on iOS those are drawn in the
**top-left corner of the picture** — fullscreen and picture-in-picture, exactly
where our back button and channel name are. They looked like they were covering
the buttons. They were not; the invisible strip around them was.

So the strip is `pointer-events: none` and the controls inside it are
`pointer-events: auto`. Same for the actions in the opposite corner, whose 26px
of padding was swallowing taps for the same reason. Decoration passes taps
through; controls take their own.

**Live also gets a fullscreen button of our own**, in the top-right with the
other controls — the opposite corner from the one iOS uses, so the two can never
argue. It runs the same `goFullscreen()` as the film bar's, including the iOS
path that hands over to Apple's player. A film does not get a second one; it has
one in the film bar already.

**The room reserved for that corner is measured, not guessed.** The strip used a
flat `padding-right: 200px`, which was right for the four buttons there when it
was written and wrong the moment a fifth arrived — the channel name simply ran on
underneath the LIVE pill. `--player-actions-w` is that row's real width, kept up
to date by a `ResizeObserver`, because the widest control in it is the LIVE pill
and its text changes every second between "LIVE" and "118s behind". Anything
measured only on open would be wrong a second later, which is how the name got
under the pill in the first place.

### Subtitles

A **CC button in the bottom bar**, next to mute, listing every track the player
has plus Off. The choice is remembered on the profile, so a film opens with the
same subtitles as the last one.

**It is always there while a player is.** Hiding it on a title with no captions
was the first try and it was wrong twice over: a film with none looks identical
to a build that never shipped the feature, and a control that comes and goes by
title is one you stop looking for. The menu carries the answer instead, and says
which of the three reasons applies — the film has none, the file has none, or
the broadcaster is not sending any.

**Live TV gets one too**, in the top bar, because a channel has no bottom bar to
put it in. The button moves between the two rather than being duplicated, and
its menu flips which way it opens so it never lands off the top of the screen.

**Cues sit clear of the controls.** A browser puts subtitles at the very bottom
of the video, which is exactly where the scrubber and these buttons are. `::cue`
can colour text but cannot place it, so the position is set on the cue itself —
and only on cues that never asked for one, since a source that positioned its
own meant it.

The tracks come from two unrelated places, and the menu deliberately does not
say which is which, because a viewer has no reason to care:

- **Sidecars.** A conversion writes its text subtitle streams out as WebVTT
  beside the video segments, and those are attached as `<track>` children.
  This is where a film's subtitles come from.
- **In-band.** Captions carried inside the stream — CEA-608 on a live channel,
  a text track in a downloaded MP4 — which hls.js and the browser surface on
  their own.

Both land in `video.textTracks`, so that list is the single source of truth and
the menu is built from it rather than from what we believe we attached.

**The subtitle files ride the same ffmpeg run**, as extra outputs off the one
input:

```
-map 0:v:0 -map 0:a:0? … index.m3u8  -map 0:s:0 -c:s webvtt sub0.vtt
```

That is the whole reason it is shaped this way. A second ffmpeg would be a
second read of the source, and on a provider that allows **one connection** the
second read is the one that fails — or worse, takes the connection off the
picture. One input, several outputs, one connection.

Three consequences worth knowing:

- **Nothing is mapped unless a probe has actually seen it.** An output with no
  streams in it is fatal to the *whole* command, so a hopeful `-map 0:s:0?` on a
  film with no subtitles would take the video down with it. With nothing known,
  the command is byte-for-byte what it has always been.
- **Only text subtitles are offered.** PGS off a Blu-ray and VobSub off a DVD
  are pictures of words; turning one into WebVTT is OCR, not a remux. They are
  left out of the menu rather than listed and then failing to appear.
- **The picture wins.** If subtitle outputs were attached and ffmpeg died, the
  session restarts once without them. A source whose subtitle stream ffmpeg
  cannot write must not be a source you cannot watch.

**A sidecar is read while it is still being written.** A `<track>` fetches once
and keeps what it got, so a track turned on early would hold the first few
minutes of dialogue and then fall silent for the rest of the film. While the
conversion is running the element is replaced every 20 seconds against a
cache-busted URL, which re-reads the file as it has grown, and the chosen track
is turned straight back on so the swap is invisible.

Finding the tracks costs **one short probe per title, cached** — the same
`probeSource` the remuxer has always run when the provider withheld the video
codec, now reading every stream rather than just `v:0`. The extra streams are
free: the expense is the bytes pulled off the network to fill the probe window,
and those are read either way. Since the probe now also hands back the codec,
the remux no longer goes and reads the source a second time for it. The cache is
keyed on `kind:id:ext` and never on the stream URL, which carries the account
password.

**The playback-rate pill over the picture is gone.** Nothing in this app ever
sets a rate other than 1, but an extension can, and a film quietly running at
0.75× is baffling without something saying so — which is why that was said
twice, once in the bar and once floating in the middle of the frame outside the
fading chrome. The floating one sat over every title whether or not anything
was wrong with it. The badge in the bar stays, and still resets the rate when
pressed.

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

### The phone player is a different player

A phone is held in one hand and watched at arm's length, so phone layout gets
its own arrangement rather than a squeezed desktop one:

- **The transport comes off the bar** and sits centred over the picture just
  above it — low on the screen, where a thumb already is, rather than dead
  centre. The buttons are 52px, and 68px for play.
- **The bar keeps the scrubber and the clock**, with fullscreen at the far edge.
- **The title is one line**, ellipsised, with the season and episode beneath. A
  wrapped title used to shove the controls down the screen, so where they sat
  depended on how long the name was.
- **Download and reload are hidden** mid-film. Neither is a thing you reach for
  on a phone, and favourite and close are.

The wrapper around the three transport buttons is `display: contents` on a
desktop, so it does not exist for layout there; phone layout turns it into a
real box and positions it. And the whole thing keys off phone layout rather
than a width, because a phone held sideways is 844px wide and a width query
misses the orientation people actually watch in.

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

### A seek stops the stream it is leaving

Nothing replaces the video source until the new conversion has banked enough to
play through, which is tens of seconds. Left alone, the outgoing stream carries
on for all of it — a loading screen with the previous scene still talking
behind it, from a part of the film you have already decided to leave.

So a seek that restarts the conversion pauses the player before the loading
screen goes up, and `attach` starts the new stream when it arrives. A jump that
fails puts the old one back rather than leaving the film silently stopped
somewhere nobody asked for.

Only seeks that restart the conversion. A jump inside the window already
converted is instant, with nothing to wait through.

### A seek swaps sessions all at once

`film.offset` and `film.ready` describe whichever conversion is on screen, and
they are applied at the moment the new stream attaches — not when the remux
request comes back.

The difference is the buffering wait, which for a seek is tens of seconds. Set
early, the offset described the incoming session while the outgoing one played
on: the scrubber jumped forward by the distance of the seek several seconds
before the picture did, and any position saved in that window was wrong by the
same amount. It showed up in a playback report as the film position moving
fifteen seconds in one tick with the measured rate still reading 1.00×.

`waitForPrebuffer` therefore does not touch `film` at all — it is watching the
incoming session, and the loader has its own progress. The caller owns the
swap.

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

### When something plays at the wrong speed: the playback report

The reload button rebuilds the stream from where it is, which fixes a
connection that has gone bad. It does nothing for a film that plays at a tenth
of speed with the audio dragging to match, because that is not a bad
connection. **Pi health → Playback** says which of the two you are looking at.

The number it turns on is how fast the media clock advances against the wall
clock — media seconds per real second, sampled every second and averaged over
the last ten. Not what the player claims, what actually happened. That one
measurement splits the problem three ways:

| what the report says | what it means |
| --- | --- |
| measured ≈ playbackRate, both low | the **rate** was set. Nothing in the portal sets a rate other than 1, so this is the browser or a stray gesture — not the stream. |
| measured well below playbackRate, many `waiting` events | the stream is **not arriving** fast enough. Bandwidth: run the speed test below it. |
| measured below playbackRate, few stalls | the media is **decoding slowly**, which points at the remux rather than the network. |

A plain-language verdict sits above the raw numbers, so the report is readable
without knowing any of the above, and **Copy report** puts the whole thing on
the clipboard. Over plain http the clipboard API is unavailable — there is no
secure context on the tailnet — so it falls back to selecting the text for a
long press.

**It keeps the last reading after the player closes.** The health panel is in
the header, which the player overlay covers, so there is no way to open it
while the problem is on screen: you hit the bug, close the player, and only
then go looking. A report that only existed during playback would always be
empty by the time anyone read it. The panel says how old the reading is.

`worst measured` matters more than the current rate — a slowdown that recovered
still leaves its mark, and the first six seconds are ignored because start-up
reads as a stall. **The worst moment survives a reload**, kept with the full
report from when it happened. It has to: the first thing anyone does about bad
playback is rebuild the stream, which starts a fresh session, so a record that
reset with the session would be wiped by the very act of reacting to the
problem and the report would describe the recovery every time. Only opening a
different title clears it.

#### A row a second, because averages hide things

The figures above are averages over ten seconds, and an average is exactly the
wrong instrument for a fault that lasts four. Worse, a worst-case reading is
only recorded once six seconds of window have built up behind it — and seeking
clears that window. Someone whose playback has gone wrong seeks again to shake
it off, and again, which keeps resetting the very measurement meant to catch
it. Both of the first two real reports came back reading a flat 1.000×.

So the watchdog also keeps a plain log: one row per second for the last two
minutes, held across reloads and seeks, with every relevant player event
written onto the row it happened in.

    timeline  (film position, rate, readyState/networkState, buffered to)
      +  3s      5.3   0.10x  rs4/1 buf 120
      +  4s     20.0       -  rs4/1 buf 120  seeking waiting seeked canplay
      +  5s     20.1   0.09x  rs4/1 buf 120

A seek shows as `-` rather than a rate collapse, since the media clock jumps
there for an honest reason. Stretches where the clock fell behind for two
seconds or more are pulled out as **slow spells** and summarised above the log,
and the verdict reports them even when every average has gone back to saying
everything is fine — which is the state things are usually in by the time
anyone can open the panel.

#### The half the browser cannot see

Every number above describes the timeline the player was handed. If the
conversion wrote a timeline that disagrees with its own contents, all of them
read as perfectly healthy — media clock at 1×, nothing stalling, no frames
dropped — while what you watch and hear is wrong. No measurement available
inside a browser can see past that.

So the server inspects its own output. `/api/remux/probe` reads the playlist,
picks a segment that has finished being written, and ffprobes the file itself:

    a segment     claims 6.000s, holds 6.000s  → timeline 1.000

Deliberately per segment, not per playlist. Asked about an HLS playlist ffprobe
reports the duration the playlist *claims* — it adds the EXTINF lines up — so
both sides of the comparison would come from the same source and the check
could never fail. A segment file is the content itself. Fragmented output has
its init segment stitched on first, since an fMP4 segment alone carries no
headers and will not parse.

**A fragment's length is not its duration.** Its timeline starts at its own
base decode time, so ffprobe's `duration` for one is the moment it *ends* —
subtract `start_time` or a healthy six-second segment three minutes into a film
reads as three minutes of content and rates the conversion 0.03. This check
cried wolf exactly once before that was noticed.

The probe runs unprompted about twelve seconds into each session rather than
when the panel is opened, because the panel cannot be reached from inside the
player — by the time anyone looks, the session in question is usually gone. It
reads only files already on disk, so it costs no provider connection and is
safe while a film is playing.

**Provider credentials are stripped before any of this is shown.** This
provider puts the account in the URL path — `/series/<user>/<pass>/id.mkv` —
and ffmpeg prints the URL it opened, so the report would otherwise hand out the
subscription to whoever it was pasted to. Host and filename survive, which is
enough to tell what was playing. It applies to the source lines, the ffmpeg
command and any error text, and covers credentials in userinfo as well as in
the path.

The report also carries **the version that produced it** and **the ffmpeg
command as it was actually run**. Two rounds of this were spent unable to tell
whether a fix had reached the box yet; the flags themselves settle it.

It also reports **what ffmpeg found in the source** — codec, sample rate,
channel layout — taken from the header ffmpeg prints before it starts work.
That is the only description of the provider's audio obtainable without
spending the single connection playback needs on a second probe, which is why
the remux runs at `-v info -nostats` and both ends of its stderr are kept: the
head describes the input, the tail carries whatever went wrong.

### Next episode

Series get a **Next episode** button in the player, offered 45 seconds before
the episode runs out.

A fixed mark rather than anything cleverer. This started out reading the
picture to find where the credits began — average brightness measured against
the episode's own baseline, held for several seconds, since nothing in an
Xtream stream marks the credits and there is no metadata to read. It worked,
but a detector that fires on what is on screen fires at a different point in
every episode, and sometimes in a dark scene that was not the credits at all. A
mark you can predict is worth more than one that is occasionally earlier, so
the detector is gone and the mark is the whole rule.

The end of the file is a second trigger, for an episode whose runtime is not
known well enough to count backwards from.

**A runtime that is still being converted is never used.** Mid-remux the
player's own duration is only what ffmpeg has written so far, which trails just
behind the play head — subtract that from the position and every moment looks
like the last one. Only a runtime from metadata counts; failing that, the
player's duration is used only when nothing is being remuxed. With neither, the
end of the file is the only trigger.

The card lives inside the transport bar rather than floating over the picture,
because the bar is the only thing that knows how tall the controls are on each
layout — on a phone the transport buttons float above it, and stacking off them
is what keeps the card clear without an offset that goes stale. Revealing it
pins the chrome up: an offer that faded out three seconds later would be worse
than no offer.

What counts as "next" depends on where the episode came from. Streamed, it is
the next episode in the season and then the first of the season after it.
Played from Downloads, it is the next episode of that show **that is also on
disk** — offering one that has to be fetched would turn an offline watch into a
stalled one.

## Version number

`VERSION` at the top of `public/app.js`, shown in the bottom-left corner of the
home screen and nowhere else. Bump it on every deploy:

- **A whole number** — `18` → `19` — for a new feature.
- **A second part** — `18` → `18.1`, and on up to `18.9` — for a change to
  something that already existed.
- **A third part** — `18.2` → `18.2.1` — for something genuinely small: a
  wording fix, a stray margin, a one-line guard.

It is a plain string, not a number, so `18.10` follows `18.9` perfectly happily
and nothing rounds anything off.

It is read from the client bundle rather than reported by the server on
purpose. The question it answers is "did my push actually reach the Pi", and a
stale number means the code running in front of you is stale — which is exactly
what you wanted to know. Static files are served with real ETags, so a changed
`app.js` is always picked up and the number cannot be stale in the other
direction.

### Everything is packaged as fragmented MP4

Both HEVC and H.264 come out of the remux as fMP4 segments with an `init.mp4`.
HEVC has to be — Apple's HLS spec carries it no other way. H.264 was left as
MPEG-TS because it worked, and for the video it did.

The audio is why it no longer is. An MPEG-TS segment reaches hls.js as a
transport stream it has to demux and rebuild into MP4 for the browser itself,
reconstructing every AAC frame's timing from ADTS headers as it goes. Get that
spacing wrong and the samples are laid down at the wrong intervals, which is
heard as a pitch shift — a deep, dragging voice — while the video, whose frames
carry their own timestamps, stays perfectly in time. Every measurement a
browser can make of that reads as healthy.

fMP4 segments carry explicit sample counts and durations in their own headers
and are passed to the browser essentially untouched, which takes that
reconstruction out of the path. It also leaves one packaging format instead of
two.

### The conversion measures its own alignment and starts over

Seeking with `-c:v copy` cannot land on the mark. The video begins at the
keyframe at or before it; the audio begins wherever the container's next audio
packet falls. On this provider's files the two are anywhere from nothing to
**three seconds** apart, varying with where you seek — `-ss 610` measured 0ms,
`-ss 641` 1131ms, `-ss 1028` 2913ms, all on the same title. `-noaccurate_seek`
does not close it; seeking a Matroska positions the file at a cluster, and the
audio for that cluster can already be behind.

Nothing knows that distance before the conversion runs. But two segments in it
can simply be **measured**, so it is: the probe reads the first segment, and if
the audio starts more than 100ms after the video, the session is thrown away
and a second one started with exactly that much silence padded onto the front
of the audio (`aresample`'s `first_pts`, in samples, negative).

Left to the player, a file whose tracks start apart is at the mercy of whatever
that player decides to do about it — and the measurements here say this one
decides wrong. Costing the few seconds it takes to write two segments, once per
seek and only when there is a gap worth closing, is the cheaper end of that
trade.

It never goes round twice. The second pass is marked aligned whatever it
measures, so a source this cannot fix wastes one restart rather than looping,
and a probe that fails leaves the first session playing untouched.

### The manual audio offset is gone

The player used to carry one — a slider behind a speaker icon beside the reload
button, −600ms to +800ms, half of it a live Web Audio delay and half a rebuild
with the head of the audio trimmed. It was removed on request.

Two things it leaves behind, both deliberate:

- **`audioFilter` stays, and is still tested in full.** `realign` uses the same
  chain to pad the head of the audio when a seek lands the two streams apart.
  That is automatic, it is what keeps lips and voices together across a jump,
  and it has nothing to do with the control that is gone.
- **`/api/remux?adelay=` still works.** Nothing sends it now, but the endpoint
  has no reason to shrink and the automatic correction goes through the same
  code.

What it does *not* leave behind is the Web Audio graph.
`createMediaElementSource` takes audio away from the element's own output and
cannot be undone for the life of the page, so a control nobody is using is not
a harmless thing to leave wired up.

### `async` is a mode, not a rate — and the 1000 was wrong

This section previously said `async=1` meant "one sample a second, about
0.002%, which reads like on and is in practice off", and that raising it to
1000 armed the correction properly. **That reading was wrong**, and the
correction it justified is what this section is now about.

ffmpeg's own words:

> Setting this to 1 will enable filling and trimming, larger values represent
> the maximum amount in samples that the data may be stretched or squeezed for
> each second.

and in `swr_init`:

```c
if (s->async) {
    if (s->min_compensation >= FLT_MAX/2) s->min_compensation = 0.001;
    if (s->async > 1.0001) s->max_soft_compensation = s->async / (double) s->in_sample_rate;
}
```

So `async=1` is a **mode**: it turns on hard compensation — real silence
inserted, real samples dropped — and leaves `max_soft_compensation` at zero, so
the soft branch never runs and the tempo is never touched. It was never "off".

Anything above 1 additionally switches on **soft** compensation: stretching and
squeezing, bounded by `async / sample_rate`. At the 1000 this was set to, and
48kHz, that is a standing licence to alter the audio's tempo by **2.08% per
second** — which is both audible and, over a few minutes, seconds of lip-sync.

It is now `async=1:min_hard_comp=0.100`. A remux must never change tempo: if
audio and its timestamps disagree, the honest repair is to insert silence or
drop samples, which is a click at worst, not to run the whole track fast.
`min_hard_comp` is the threshold between the two paths and is stated rather
than left to its default, because that value *is* the behaviour.

**What this does and does not explain.** A report came in with audio ending
977ms short of video 44.8s into a session that started perfectly aligned — a
drift of 2.18% per second, sitting right on the 2.08% ceiling that `async=1000`
authorises. That is suggestive, not proof: `aresample` matches audio to the
audio stream's *own* timestamps and knows nothing about the video, so a source
whose audio genuinely drifts would produce the same reading with any setting.
The change is worth making either way, and it is also a clean experiment — with
soft compensation off, the next report separates the two. If the drift is gone
it was the filter. If it is unchanged at 2.18%, the source drifts and
`aresample` was faithfully reproducing it, and the fix belongs somewhere else.

### Drift is not the same fault as an offset

The probe reports both, and they need telling apart.

An **offset** is the two streams starting at different points and staying that
far apart — a seek landing video on a keyframe before the mark. Constant, and
fixed by padding the head (above).

**Drift** is them starting together and pulling apart. It is inaudible at the
head and unwatchable a few minutes in, which is exactly the "worse the deeper
you go" symptom that took several rounds to pin down.

The report gives the gap at the **end of the opening segment** and at the end
of a **recent** one, and the rate is the difference between them over the time
between them.

That took two goes to get right, and the wrong one shipped. The first version
reported the gap in a *single* segment divided by how long the session had been
running — which assumes the gap grew from zero without ever checking. Some gap
at the end of a segment is entirely normal: the muxer cuts on a video keyframe
and the audio frames do not land on that instant, so the two tracks end at
slightly different places every time. Dividing that standing gap by elapsed
time reports a constant as a runaway, and worse, one that appears to get worse
the longer you watch — because the divisor is the only thing changing.

A real report made that unmistakable: a 5.115s gap at 54s into a session came
out as **−94.8ms per second**, or 9.5%, which would be inaudible for about four
seconds and then unwatchable. The same numbers with the gap measured at both
ends give a rate of **zero**. The probe test now carries that exact case, and
run against the old arithmetic it reproduces −9.48% from a gap that never
moved.

A span under six seconds is refused rather than divided by — that is one
segment apart, the soonest two distinct measurements exist, and anything
shorter is two readings of the same moment.

### The player rebuilds itself when the audio falls behind

With the measurement trustworthy, a real fault showed up: resuming an episode
sometimes produces a conversion whose audio runs slow — 0ms apart at the
opening segment and **5.9 seconds** apart by 33 seconds in, about 22%. Backing
out of the show and starting it again clears it, which says the source is fine
and that particular ffmpeg run went wrong.

So the player does that itself. The probe is asked every 20 seconds for the
first two minutes of a conversion — rather than the usual 60 — and when it
reports the audio falling behind, the stream is rebuilt from the current
position: the same `reloadStream()` the reload button uses, which is the same
thing as backing out and starting the episode again. It takes roughly half a
minute to notice, since a rate needs two segments to exist before it means
anything.

Both the **rate** and the **standing gap** have to be past their thresholds —
10ms/s and 0.5s. Either alone is a false positive waiting to happen: a rate on
its own can be two close-together segments and a rounding error, and a gap on
its own is the ragged edge where the muxer cut on a keyframe.

Guarding the loop takes more than remembering the session, because **a rebuild
creates a new session**, which would be eligible all over again. Twice per
viewing, and never within 90 seconds of the last one. If a second rebuild has
not fixed it, a third will not either, and restarting the picture over and over
is worse than bad audio somebody can decide about for themselves.

**What this does not do is explain the fault.** It is a recovery, not a
diagnosis: something in that ffmpeg run drops roughly a fifth of the audio, and
what remains unknown is whether it is the seek landing badly, the provider
serving a bad range on the first request, or the encoder falling behind on a
Pi that is also doing something else. The rebuild makes it survivable while
that stays open.

### Audio starts where the video starts

`-ss` ahead of `-i` seeks the container, which is what makes a seek fast — but
with `-c:v copy` the video can only begin at the keyframe at or before the
mark, while the audio begins at the mark itself. The two streams end up
starting at different points, and a browser handed a track that starts late
does not necessarily wait for it: it plays what it has, and the audio runs
ahead of the picture.

`-noaccurate_seek` is what fixes it. Accurate seeking discards everything
between the keyframe and the mark — but a copied video stream cannot be cut
mid-GOP, so only the audio gets trimmed, and `-avoid_negative_ts make_zero`
then slides both down by the same amount. The output opens with the video
already running and the audio arriving a fraction of a second later; measured
on this provider, **1184ms**, and 1904ms on a title with longer GOPs.
Turning accurate seeking off keeps that audio
instead of discarding it, so both streams begin at the keyframe and land
together.

**This is not a complete fix.** It measured 0ms seeking to 610s and 1131ms
seeking to 641s on the same title, with `-noaccurate_seek` present in the
command both times — the first was a seek that happened to land on a keyframe,
not a fix working. Seeking a Matroska positions the file at a cluster, and the
first audio packet after that position can be most of a second behind the video
keyframe, whatever accurate seeking is set to.

The gap is inherent to copying the video: a copied stream can only begin at a
keyframe, the audio can begin anywhere, and nothing can trim the video to meet
it without re-encoding. Closing it properly means padding the audio with
silence back to the video's start, which needs the keyframe position *before*
the conversion runs — another probe against the provider's single connection.

Before spending that, the report now measures **where the player put each
track**: hls.js buffers audio and video separately and applies a
`timestampOffset` to each, and if it slides the audio back to meet the video
then the file being right is beside the point.

    buffers         video: 0.00-157.00 (offset 0.000)
                    audio: 1.13-157.00 (offset 0.000)

Equal offsets with the audio range starting late means the player is honouring
the file and the gap is only silence at the head. Different offsets, or both
ranges starting together, means the audio has been dragged forward and
everything after it plays against the wrong picture.

The cost is that playback starts up to one GOP before the spot you asked for,
and the scrubber still reports the spot you asked for — so it reads early by
that much. On a title with 11-second segments that is several seconds. It is
the better error of the two: an early start is barely noticeable, audio against
the wrong picture is unwatchable. Correcting it would mean learning where the
keyframe actually landed, which is another probe against the provider's single
connection, so it stays uncorrected until it annoys someone.

`aresample=async=1:first_pts=0` stays alongside it. `first_pts=0` pads any
residual gap so the audio track still begins at zero, and `async=1` is there
for what it always was — keeping audio from drifting away from video over a
long playback. On its own it was not enough: the filter sees the audio already
starting at zero and has nothing to pad, because the offset is introduced later
by the muxer rebasing both streams.

The playback report measures the result rather than assuming it. The probe
reads the **first** segment of the session and reports where each stream
begins:

    a/v start     video 0.000s, audio 0.000s  → offset 0ms

Anything past ~120ms is called out in the verdict, because an offset shows up
in nothing else the player reports — the clock, the frame rate and the
buffering are all perfectly correct, the two tracks are simply not aligned.

### Audio is always re-encoded, never copied

The remux copies the video stream untouched and **re-encodes the audio every
time** — stereo AAC-LC at a fixed 48kHz.

Copying stereo AAC straight through was there as free headroom, and for most of
the catalogue it worked. It cost a real bug. `codec_name` is `aac` for both
AAC-LC and HE-AAC, and an HE-AAC stream carries only half its sample rate in
the core with SBR restoring the top; a decoder that takes the core alone plays
it an octave down and at half speed. That is a deep, dragging voice over
completely normal video — and it is invisible to every measurement the player
can make, because the video clock, the frame rate, the buffering and the
segment timings are all genuinely fine.

Nothing in the provider's metadata distinguishes the two profiles, and probing
the source for it would spend the single provider connection playback itself
needs. Re-encoding removes the question: every browser decodes the result
identically. It costs a few percent of one core against a video copy already
running many times faster than playback, and it is what the download optimizer
had been doing all along — the streaming path was the odd one out.

The playback report names the profile of what came out, so the next report can
confirm it rather than assume. **This did not fix the deep-voice fault** — the
next report came back reading `aac LC 48000Hz` and sounding exactly the same,
which is what pointed at the packaging above. The re-encode stays because
pinning the format is worth having regardless, and because it ruled the
encoder out.

## Every title has its own page

Clicking a series opens `#/series/<id>` and a film `#/movies/<id>`: the poster
on the left, and on the right the name, year, genre, rating, synopsis and a
favorite button. Underneath that is whatever there is to decide — for a show
the seasons across the top of its episode list, for a film one **Play** button
and how long it runs. Opening either puts the player over it, and the player's
back button lands on that card rather than on the grid.

A film's details are fetched by the card rather than at playback, which is
strictly better: the provider answers a metadata call while its one connection
is free and returns nothing once ffmpeg is streaming through it. The answer is
cached, so pressing play does not ask twice.

Live TV has no page of its own. There is nothing to decide about a channel, so
it tunes straight in.

Both used to happen inside the player. Episodes were picked there, so opening a show put an empty video
frame on screen with a list underneath it; a film's synopsis was only readable
once it was already playing. The player was pressed into service as a browser
because that is where the metadata happened to be fetched. Browsing belongs
with the rest of the library, and the player is left to do the one thing it is
for.

Two things follow from making it a real route rather than internal state: the
browser's back button leaves a show the way anyone would expect, and the player
has somewhere to return to **by name** instead of by guessing which grid the
title came from.

The fetched episode list is cached per show, so coming back out of the player
is instant rather than another round trip to the provider.

Narrow windows and phones stack it — poster above, episodes below — since two
columns need width that is not there.

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
  are; click it to jump to the edge deliberately. This got walked back twice and
  walked back again — see below.

**There is no latency setting.** There used to be three modes in a dropdown —
ride the edge, balanced, don't drain at all — which asked the viewer to trade
stalling against being behind live without giving them any way to know which
they were about to get. The trade is real; it just has a right answer on this
provider, so the app makes it.

The reason one setting can be both clean and close is that those two costs are
**not on the same dial**, which the dropdown implied they were:

| | set by | what it costs |
| --- | --- | --- |
| How far behind you are | where the playhead sits relative to the end of the playlist | latency |
| How much cushion you have | how much between the playhead and that end is downloaded | nothing |

A live playlist only ever exposes up to the edge, so buffering aggressively
cannot push you further behind — it fills in the gap you are already standing
in. The cushion is free.

**The distance is in seconds, not segments.** This was got wrong once and the
measurement is worth keeping. It was `liveSyncDurationCount: 3` — three segments
back — which reads like a cushion and is not one: that count multiplies the
playlist's own `targetDuration` and is then clamped into whatever playlist
happens to exist at the moment of joining. A measured session joined **2.8
seconds** from the end of the loaded data:

| | playhead | buffered to | cushion | |
| --- | --- | --- | --- | --- |
| joined | 27.2 | 30 | 2.8s | **stalled 6s** |
| | 30.6 | 40 | 9.4s | |
| | 40.0 | 40 | 0.0s | **stalled 3s** |
| | 44.5 | 60 | 15.5s | smooth to the end |

It stalled the instant the playhead caught the buffer, twice, and then played
perfectly for the rest of the session once about ten seconds of cushion had
accumulated on its own. The cushion was the whole story; the segment count never
delivered one.

So an **HLS** channel joins a stated number of seconds behind the edge rather
than a segment count, and then moves to a seat measured from the channel's own
window (see below). It holds everything between there and the edge
(`maxBufferLength: 45`). `lowLatencyMode` is off, because this provider
does not serve LL-HLS parts and with it on hls.js works to stay nearer the edge
than the stream can support — stalling bought with nothing.
`liveMaxLatencyDuration` is parked at 600 — deliberately unreachable, so hls.js
never seeks on its own. Nothing else seeks either; see below for why the two
attempts at getting back to live were both worse than staying put.

### Nothing chases the live edge

This was wrong twice, in opposite directions, and the second one shipped.

First `liveMaxLatencyDuration: 60` against a channel that publishes a
**58-second** playlist — a safety net pitched past the end of the playlist,
which can never fire. Then a correction of our own, measured against the window
so it *would* fire, which jumped the picture forward and put a message on screen
saying it had.

Both were built on the assumption that being far behind live is a fault worth
interrupting the picture to fix. **It is not.** On a slow link the sequence is:
the buffer runs dry, playback stalls, and the gap to the live edge grows by
however long the stall lasted. Seeking forward to close that gap throws away the
one thing keeping the picture up — the video already downloaded — and buys a
seat nearer an edge the link cannot keep up with, which starves again within
seconds. It turns one stall into a stall plus a jump.

What is wanted from a channel is that it keeps playing. Forty seconds behind
costs nothing except on a live score, and nothing about it is worth a jump or a
message. So **nothing moves the playhead**: no correction of ours, and
`liveMaxLatencyDuration` parked at 600 so hls.js does not do it either. The
`LIVE` pill still shows the gap and still jumps to the edge when pressed —
deliberately, by somebody who wanted it.

hls.js's own **stall and gap recovery is left alone**, and that is a different
thing: it steps over a hole in the media, which is the difference between a
picture that continues and one frozen for good. Switching it off would freeze
the stream, not steady it. A forced jump can still happen for a reason no
client controls — if the playhead falls so far behind that the oldest segments
expire out of the playlist, the material under it is gone and the player has
nowhere to stand. That is the link, not a setting.

### Where to sit, and when to start

Recovering from drift was the smaller half, and fixing it first is why the next
report still stalled. The seat was the problem.

`liveSyncDuration` was **18 seconds**, and this provider publishes **11-second
segments**. So the playhead sat 1.6 segments from the edge — and a segment is
only fetchable once it is complete, which means there was never more than about
one segment to be had, no matter what `maxBufferLength` asked for. The measured
session:

```
+13s   first segment lands (10s of media, 13s to arrive)   play starts
+20s   playhead reaches the end of it
+21s   stalled
+28s   second segment lands (10s of media, 15s to arrive)
```

It started with **7.1 seconds** of video downloaded and spent it in seven
seconds. That is not really a stall — it is starting before there was anything
to start with. And at the moment it stalled, **33 seconds of playlist had been
published and simply not been fetched yet**, so the material was there. Only
the head start was missing.

Two changes:

- **The seat moves back to ~32 seconds**, about half the window this provider
  publishes. It is a middle rather than a maximum, because the two failure
  modes pull opposite ways: too near the edge and there is never a cushion, too
  far back and the oldest segments expire out of the playlist under the
  playhead — which forces a jump nobody chose, and is the one kind of jump the
  client cannot prevent.
- **Live does not start until there is a cushion** — `LIVE_PREROLL`, 30% of the
  window. The wait is visible and counts up, because a picture that has not
  appeared is otherwise indistinguishable from a broken one, and it is capped
  at `LIVE_WAIT_MAX` (20s), because a stall you can see the reason for still
  beats a spinner with no end. A link fast enough to fill it never notices it.

This is the "delay it a few more seconds" fix, and it is spent once at the join
rather than as a stall a few seconds later.

### The Pi's own live buffer

Everything above tunes the client against the provider's playlist, and the
provider's playlist is the problem: it publishes **~60 seconds** per channel.
That number caps every cushion, and it is the source of the one jump no client
setting can prevent — drift 60 seconds behind and the segment under the
playhead **expires off the provider's server**; the player is forced forward
because the material is genuinely gone.

So the Pi makes its own window. When a live channel is opened, one ffmpeg per
channel reads the provider's **own HLS playlist, from its oldest segment**
(`-live_start_index 0`) — **stream copy, no transcoding**, so it costs a Pi
almost nothing — and republishes it as local HLS: ~4-second segments, **~2
minutes of playlist** (`LIVE_DVR` in `server.js`). The client is handed the
local URL, marked `dvr: true`, and takes a deeper seat: `LIVE_DVR_SEAT`, 45
seconds.

Which input the ingest reads decides how fast a channel opens, and it was got
wrong once: the TS push feed arrives at 1× realtime, and a stream copy can only
cut segments on keyframes, so the first segments could take longer to exist
than the readiness timeout — a measured session spent 15 silent seconds
warming a DVR that then fell back to the direct path anyway, paying for both.
The provider's playlist, by contrast, holds ~50 seconds of already-published
video at any moment: ingesting it from index 0 pulls all of that at link speed,
so the Pi's window opens ~50 seconds deep within a few seconds instead of
growing from nothing.

Which is also why readiness is a **speed test**: `/api/play` hands over the
DVR only if it shows **two segments within five seconds**. A healthy feed
banks the backlog at several times realtime and clears that bar easily. A feed
throttled to about realtime cannot — and that is exactly the feed on which a
shallow buffer is worse than no buffer: a measured session seated a viewer in
a 4-second window glued to the ingest frontier, stalling every few seconds,
strictly worse than the direct path it had replaced. Slow feeds go direct,
fast feeds get the window, and no tune-in waits more than five seconds to find
out which it is. In order of importance, the window buys:

- **Nothing expires under the viewer inside two minutes of drift.** The forced
  jump is gone from every link that is not two whole minutes slow, and two
  minutes is the ceiling on how far behind anybody can ever be.
- **The provider's burstiness stops at the Pi.** Its published backlog is
  banked as the first ~50 seconds of window, so a viewer joins with a real
  cushion the moment the channel opens, and the lumpy delivery afterwards
  lands on the Pi's disk, not in the viewer's buffer.
- **Fine-grained fetching.** ~4-second segments instead of the provider's 11,
  so a cushion can actually be assembled — with 11-second segments, "one more
  segment" was an 11-second wait for 11 seconds of video.
- **One provider connection per channel, shared.** Every multiview cell used
  to cost its own.

The lifecycle is the boring half and the half that has to be right. Sessions
live in the same table as film conversions so serving, reaping and
provider-busy logic all apply, flagged `live: true` where the rules differ: a
live playlist is never closed with `ENDLIST` (the feed drops; ffmpeg is
respawned into the same directory with `append_list`, so the playlist carries
straight on and a drop is a hiccup, not an ending), the kill-everything sweeps
that conversions run spare live sessions (a multiview film cell must not
silence the channel beside it), and live sessions reap after **45 idle
seconds** rather than five minutes, because an ingest holds a provider
connection and hls.js's playlist polling keeps `lastAccess` fresh for as long
as anybody is actually watching.

"Never closed with ENDLIST" has to be enforced on the way OUT, not just by
refraining on the way in: **ffmpeg writes an `ENDLIST` itself** when its input
runs dry and it exits cleanly. A viewer who sees it reclassifies the stream as
finished and stops polling the playlist — so when the ingest respawns two
seconds later, nobody is listening, and a measured session sat frozen at the
90-second mark of a live game. `serveRemux` strips the marker from every live
playlist it serves. The respawned run also raises `discont_start`, marking its
first segment as a discontinuity: its timestamps restart wherever the
provider's backlog now begins, and unmarked they would be mapped onto the old
timeline as a visible jump. Any failure — no ffmpeg on the box, a dead
feed, a start-up timeout — falls back to the direct proxy, which is exactly
what the endpoint always returned.

### What even this does not fix

The delivery rate into the Pi. A session measured over the **direct Tailscale
address** — no tunnel anywhere in the path — still showed 0.5–1.1 Mbit/s
against a stream that needs ~2.5, which moves the bottleneck upstream: at that
moment the **provider itself was starving the Pi**. Earlier sessions through
the tunnel measured much the same, so the tunnel was a suspect and is now
mostly exonerated; the pattern across every measured session is a provider
that delivers around or below 1× at peak hours.

The DVR removes every failure mode downstream of that — expiry, burstiness,
coarse segments, cold starts — and guarantees 45 seconds of material is always
*available* on the Pi. It cannot make the provider *send* faster. When the
provider runs under 1×, the Pi's window edge advances slower than realtime,
the viewer's cushion drains, and the picture eventually pauses — no jump, just
a pause — until delivery resumes. That number lives with the provider, and no
setting on either box changes it.

An **MPEG-TS** channel gets `drain: 12, hold: 4` — the figures the old
"balanced" mode used, and the ones that measured zero stalls and zero seeks over
50 seconds. The other two modes each gave up one of the two things anybody
actually wants.

Both players take the same object, `LIVE_HLS`. Multi-view constructs its own
engine, and two copies of a tuning like this drift the moment one is touched.

### The report says why, not just that

A timeline can say the buffer ran out. It cannot say **why**, and the two
candidates want opposite fixes: either the link is not delivering the stream
faster than it plays — in which case no amount of tuning invents bandwidth — or
it is, and the player is sitting too close to the live edge to have anything in
hand. This was tuned twice on inference and moved in the wrong direction both
times, so the numbers that separate them are in the playback report:

```
link vs stream  9.4 Mbit/s measured, 11.2 Mbit/s needed  →  0.84x headroom
playlist        live, 3 segments of ~10s = 30s window
latency         21.4s behind the edge, asked for 18.0s
```

- **headroom** below 1.0× means the stream is arriving no faster than it plays,
  and nothing configurable fixes that. Above it, the cushion is buildable and
  the settings are the thing to look at.
- **window** is the ceiling on any cushion. You cannot buffer past the live
  edge, so a playlist that publishes 30 seconds cannot give you 45 however
  `maxBufferLength` is set.
- **latency** against what was asked for says whether the join distance is doing
  what it claims. They disagreed once already, which is what
  `liveSyncDurationCount` turned out to be.

They come from hls.js itself — `bandwidthEstimate`, the level's `bitrate`, the
level's `details`, and `latency`/`targetLatency` — and the block prints nothing
at all on a non-hls.js engine or an engine with nothing to say, because a
diagnostic must never be the reason a report fails.

**The readout stays, and it measures the right thing.** The pill shows the
distance to the **live edge** — the newest moment the playlist publishes, read
from the engine — as "Ns delay". It used to show the distance to the end of the
*downloaded buffer*, which is a different number that lies at exactly the worst
moment: a starved link drains the buffer, the gap to it reads zero, and the
pill said `LIVE` to a viewer half a minute behind with no cushion at all. The
seat is 30–45 seconds back by design, so a delay is the normal, healthy state
and is shown as a plain fact; the word `LIVE` is reserved for genuinely riding
the edge. Pressing it still jumps to the edge. What that must never be is something the player decides on its own —
a seek nobody asked for is the "skips to the end" fault this has already been
through once.

**Playback rate is never touched.** The portal doesn't auto-adjust speed to
catch up, so a speed-controller extension keeps full control. Your chosen rate
is preserved across channel changes, which a plain `load()` would otherwise
reset to 1×.

## The archive drive

The **Archive** tab plays a 2 TB external drive plugged into the Pi — 5,853
files, browsable by folder and searchable by title, with resume points and the
cinema player exactly like everything else.

**It is Hunter's tab.** Every other profile has no Archive in either nav,
typing the address bounces to home, and the API refuses their `profileId` —
the same honesty-not-security gate the reports use, since the box is
unauthenticated by design.

`scripts/scan-library.js` probes the drive once and writes
`library-index.ndjson`, recording for each file whether it can be served as-is
(byte ranges straight off the disk — instant start, free seeking), needs its
container converted, or needs a full video re-encode. The portal reads that
index at boot and never guesses at play time. The index outlives the mount:
with the drive unplugged the tab still browses and every play attempt says
plainly that the drive is not plugged in.

Roughly a third of the drive is MPEG-4 ASP (DivX/XviD in `.avi`), which no
browser decodes. Those are encoded to H.264 on demand as they play — measured
4.7× realtime on the Pi 4 — through the same HLS pipeline the provider streams
use; nothing is converted up front and nothing is stored. Provider streams
always pass through untouched and never take the encode branch.

The client-supplied path is checked twice: resolved-and-prefix-checked against
the drive root (so traversal cannot escape it), and required to exist in the
index (so the feature cannot be used as a general file server for whatever
else is on the disk).

`ARCHIVE_ROOT` (default `/mnt/archive`) says where the drive mounts, and is
set in `ecosystem.config.js` so it survives pm2 restarts. Setup and
re-scanning: **[docs/archive-drive.md](docs/archive-drive.md)**.

Pi health carries an **Archive drive** row: free and used space with a bar
when mounted, a plain "Not plugged in" when it isn't, and no row at all on a
box that has never had an index. Read live on the panel's four-second poll,
because "is the drive still there" is half of what the row is for.

## Multi-view

Two to four live channels on one screen, reached from a button on Live TV.

**It used to live behind a beta switch.** That switch existed to hold one
question open — whether an account that allows a single connection could feed
several cells at once. It answered it (see below: HLS holds no connection open),
and once a feature works, keeping it behind a switch only makes it harder to
find. So the switch went with it; it had nothing else in it.

**How many is a choice**, and the layout follows it rather than the cells
laying themselves out — so three is one large beside two stacked, not three
across with a hole where the fourth would be. The count is kept per device.
Dropping it stops the cells it removes rather than hiding them: a cell playing
off-screen still holds whatever the provider gave it.

**Each cell has its own transport** — pause, and ten seconds either way. Live
is not a film, so the skip is clamped to what the element reports as
`seekable`: back reaches as far as the buffer still holds (`backBufferLength`
is 60s here, which is what sets that), and forward stops at the live edge.
Pressing at the edge does nothing rather than throwing the position somewhere
invalid.

### A film or an episode in a cell

A cell will take a film or an episode as well as a channel — but it is a
different animal, and the difference is worth stating because it is what the
design is shaped around.

A channel costs a run of short segment fetches. A film is a **conversion**:
ffmpeg on the Pi, reading one continuous stream from the provider. And the
server runs exactly one of those at a time on purpose — `startRemux` kills
every existing session before it spawns, because a seek must not stack encoders
on a Raspberry Pi.

So **one cell can hold a conversion**, and asking a second cell for one takes
the first one's picture away. That is enforced in the client and said out loud
when it happens, rather than left to be discovered as a cell that mysteriously
went black. Channels alongside are untouched; they are not conversions.

Three more things follow from a conversion not being a channel:

- **hls.js needs the opposite settings.** While ffmpeg is still writing, the
  playlist has no end marker, so hls.js reads it as live — and with a back
  buffer being evicted the playhead can fall out of the window and get dragged
  to the "live edge", which here is just however far ffmpeg has got. A cell
  playing a conversion gets `backBufferLength: Infinity` and `startPosition: 0`;
  a channel keeps the low-latency ones.
- **Stopping the cell has to stop the box.** A conversion is a process, not a
  socket the browser can drop: left running it grinds through a film nobody is
  watching and keeps the provider connection with it.
- **The wait is reported on the cell.** The main player's `waitForPrebuffer`
  puts the full-screen loader up and writes the module-level `activeRemux` —
  both of which belong to the one thing the main player is doing, and the
  loader would cover the other three cells.

A finished download in a container the browser already plays is the exception
to all of it: no ffmpeg, no provider connection, and nothing stopping several
cells doing it at once.

**The picker is the Live TV page.** A Live TV / Movies / Series / Favorites /
Recent switch across
the top, then categories as cards with their artwork, then what is inside one —
and for a series a third step, because a show is not a thing you can play. If
the section has never been opened this session its library is fetched on the
spot rather than telling somebody to go and open a page they came here to
avoid. Otherwise: channels inside one, on the same `.grid.is-cats` /
`.grid.is-live` the library uses and built by the same `liveCategoryCard` — not
a copy that looks like it today and drifts tomorrow. It is a full sheet rather
than a small modal for the same reason: a list of names in a 520px box was a
different thing wearing the same words. Pinned categories lead in the order
they were dragged into. Typing cuts across every category, because a search
that only looked inside the folder you happened to be in would be a worse
search. The one thing the tiles lose here is the bin — hiding a category from
inside the sheet would re-render the page underneath it, which is not what
pressing it there means.

**Favorites and Recent are the two shortcuts**, and they skip all of that. Both
are flat lists — no category step, because putting a folder in front of the six
things somebody came here to pick from is the work these exist to remove — and
neither waits on a fetch, since both are the profile's own lists rather than the
provider's. Each tile says what kind of thing it is, because unlike a category
these lists are mixed.

The two are not the same shape underneath, and that is where the work is:

- A **favorite** is a whole library record. The heart in the player saves the
  item, not a reference to it, so a channel or a film goes straight into a cell
  with nothing to look up. A favorited *show* still opens its episode list — a
  show is not a thing you can play.
- A **history row** is not a record. It carries a name and a poster so the home
  screen can draw it before any library has loaded, but not the fields a stream
  needs: no container extension, and for a show an episode *number* rather than
  the provider's episode id. So the tile draws from the row and the resolving
  waits until it is tapped — load the library, find the record, and for a show
  fetch the episode list to turn "season 2, episode 5" into an id. It goes
  straight into the episode, which is the same call Continue watching makes on
  the home screen and for the same reason. If that episode is gone but the show
  is not, it hands over the episode list rather than failing at somebody who
  only wanted to carry on watching.

Recent folds to one row per title, newest first. The history is per-episode,
and five tiles of the same show would crowd out four other things.

**The live player carries a channel in.** A four-pane button in the player's
top-right corner — with the other controls, which in cinema mode *is* the
corner — closes the player and opens multi-view with whatever was on screen
already in the first free cell. Live only: multi-view is four live channels,
and a film has nothing to put beside it.

**A show opens its episode list inside its own cell.** When a cell is playing an
episode, the name in that cell's bar becomes the way into the whole show —
seasons, every episode, and a mark on the one that is on. The name is where the
name of the thing already is, so there is nothing new to find; it only reads as
pressable when there is a show behind it, because on a channel or a film it is a
label, and a label that looks pressable is a lie.

It opens **inside the cell**, absolutely positioned within that box. A sheet over
the whole screen would have been easier to build and the wrong thing to build:
the other three cells are still playing, and choosing the next episode of one
show is no reason to take the game away from somebody. The idle fade is held off
while a list is open, for the same reason it is held off for the picker — chrome
that vanishes while you are reading it is not chrome. Stopping the cell closes
the list with it, since the show it was about is gone.

**The bars get out of the way.** Cell chrome and the top bar fade after three
seconds and return on any movement, pointer or touch — the same bargain the
main player makes. Empty cells keep their prompt: there is no picture there to
be in the way of. The fade is held off while the picker is open, since a menu
being dismissed by a timer is not a thing anyone wants.

**One cell can take the whole screen**, which also asks the browser for real
fullscreen. Backing out by any route returns to the grid, never to Live TV:
the expand button again, Escape, the browser's own control, or the cell being
stopped while it is blown up. A `fullscreenchange` listener is what catches the
routes that do not come through our own button, and Escape is intercepted so
one press shrinks and only the second leaves. The other cells keep running
underneath — tearing them down would mean re-asking the provider for all of
them on the way back.

**It works, and the prediction that it would not was wrong.** This was built
expecting one cell to play and the rest to be refused, because the account
allows **one connection at a time** — the same limit that makes downloads pause
while you watch. Four channels ran for several minutes without a complaint.

The reason is a distinction that limit hides: it counts **connections held
open**, and HLS does not hold one. A live channel here is
`…/live/user/pass/ID.m3u8`, and playing it is a series of short segment
fetches, each opening and closing. Four of those interleave without ever being
concurrent in the sense the provider counts.

What *does* hold a connection open is a single continuous GET — which is
exactly what a **download** is, and what live becomes when the provider is set
to **MPEG-TS** instead of HLS. That is the real shape of the limit: downloads
pause live playback not because the account is busy, but because both are one
long GET. Multi-view in MPEG-TS mode should collapse to one working cell; that
is the falsifiable half of this and it has not been run yet.

So each cell shows the delivery it got (`M3U8` / `TS`), and that tag carries the
explanation with it: HLS holds no connection open, MPEG-TS holds one and this
account allows one. The rest of the design still stands, because it is what made
the answer legible either way:

- Each cell reports its own outcome, on the cell, **in the provider's words**.
  "Refused: All connections for this account are in use" is the finding; a
  spinner that never resolves would not be.
- The header **no longer counts** playing against asked for. That tally was a
  readout for the experiment above, and the experiment answered its question —
  a permanent "4 playing of 4 asked for" over a working grid is just noise. The
  half of it that was not a measurement — which cell is holding a connection
  open — moved onto the cell that is holding it, where it is about something.
- **Cells can be dragged into each other's places** by the grip in the bar. The
  swap exchanges the two boxes *in the DOM* rather than handing one cell's
  channel to the other: moving the box takes the video element, its engine and
  whatever it has buffered along with it, so the picture does not blink, where
  re-pointing a cell would mean tearing an engine down and asking the provider
  again for something already on screen. `cells` is reordered to match, because
  everything else — which cells the count shows, which one is blown up — is by
  position. That in turn is why every button closes over its cell **record**
  rather than the index it was built at: a control that remembered its slot
  would act on whichever cell had since moved into it.
- A failed cell **does not retry by itself**, but every cell carries a **↻** in
  its bar. On MPEG-TS a quiet reconnect loop would take the connection off
  whichever cell currently has it, and the sequence of who held it when is the
  thing being observed — so somebody says when, rather than the app guessing.
  The button matters most on a cell that was turned away: the bar is shown
  whenever a channel has been *asked for*, not only when one is playing, so a
  refused cell carries the reason and the way to try again side by side.
  Refreshing keeps the channel, leaves the other cells alone, and takes the
  sound with it if that was the cell you were listening to.
- Opening multi-view closes the main player first, so it is not a fifth
  claimant on the connection while the other four are being counted.

It is a **separate player**, not the main one reconfigured. The main player is
built around there being exactly one of everything — one video element, one
engine, one film bar, one watchdog, one remux session, all module-level — and
none of that survives being asked to be four things at once. Sharing it would
have meant unpicking every one of those globals for something that already
worked standing on its own.

Every cell starts muted and exactly one may be unmuted at a time. Four live
channels talking at once is not a feature, and a browser will refuse to
autoplay with sound in any case.

On a phone the four cells stack rather than tiling; four cells across 390px is
nothing anybody can watch.

## Known limits

- **MKV and AVI won't play.** No browser decodes them. Movies served as MKV need
  a transcode or a native player — this is a browser limitation, not a bug here.
- The server is unauthenticated. It binds to `127.0.0.1` by default; if you set
  `HOST=0.0.0.0`, anyone on your network can use your subscription. Don't
  port-forward it.
- Very large libraries load fully into memory in the browser. With 57k channels
  and 178k movies, the first load of a section takes several seconds.
- Series resume points aren't tracked yet — episodes start from zero.
- Downloads have no disk-space guard. The 20GB per-profile allowance is not one:
  it is per profile, `hunter` is exempt from it, and nothing stops the sum of
  everyone's from outrunning the card. A 4K film here runs 4–5 GB; check the
  Pi's free space before queueing a stack of them.

## Layout

```
server.js            proxy + static server, zero dependencies
config.json          created at setup (gitignored)
public/index.html    markup
public/styles.css    dark theme
public/app.js        routing, library loading, player
```
