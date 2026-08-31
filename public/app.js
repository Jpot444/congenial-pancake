/* IPTV Portal — front end.
 *
 * Everything talks to the local server, never to the provider directly:
 *   /api/xtream   → provider API passthrough
 *   /api/playlist → parsed M3U (M3U mode)
 *   /api/play     → resolves a proxied, playable stream URL
 */

/**
 * What has shipped. Bumped by hand on every deploy — minor for a change to
 * something that already existed, whole number for a new feature.
 *
 * Shown in the corner of the home screen and nowhere else. Its whole purpose
 * is to answer "did my push actually reach the Pi", so it is deliberately read
 * from the client bundle rather than reported by the server: a stale number
 * means the code running in front of you is stale, which is exactly the
 * question being asked. Static files are served with real validators, so a
 * changed app.js is always picked up and the number cannot lie in the other
 * direction.
 */
const VERSION = '36.2';

const PAGE_SIZE = 60;

const $ = (sel) => document.querySelector(sel);

/* Titles and SSIDs come from the provider and the network, not from us, so
   anything interpolated into markup gets escaped on the way in. */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const state = {
  config: null,
  tab: 'live',
  category: null,
  query: '',
  catQuery: '',
  /** Title of the shelf opened out into a full list, or null on the rows. */
  shelf: null,
  /** Which show's card is open, from `#/series/<id>`, or '' on the grid. */
  seriesId: '',
  /** Which film's card is open, from `#/movies/<id>`, or '' on the grid. */
  movieId: '',
  /** Episode lists already fetched, so leaving the player is instant. */
  seriesCache: {},
  /** Film details already fetched. Keyed by id; null means the provider had
      nothing, which is worth remembering so it is not asked twice. */
  vodCache: {},
  /** The person whose films are being shown, when one is. */
  person: '',
  /** Per-tab cache: { categories: [], items: [] } */
  library: { live: null, movies: null, series: null },
  /* The same three sections with the English/US filter set aside, fetched
   * only when somebody asks a search to look wider. Kept apart from
   * `library` on purpose: browsing stays the short catalogue it has always
   * been, and one search for a foreign title does not turn the Movies page
   * into 178,000 items until the next reload. */
  libraryAll: { live: null, movies: null, series: null },
  /** Whether search is currently looking past the English/US filter. */
  searchWide: false,
  /** Live TV showing a schedule rather than a grid of channels. */
  listings: false,
  visible: PAGE_SIZE,
  filtered: [],
  downloads: { items: [], active: null, queued: 0 },
  /** The archive drive: current folder, what's in it, and how much is shown. */
  archive: { dir: '', data: null, status: null, visible: PAGE_SIZE, searching: false },
  recentlyWatched: [],
  /** This profile's explicit thumbs, keyed the way history is. A film's page
      shows which way one went and changes it. Kept here rather than fetched
      per page: it arrives with the rest of the taste payload, and the box has
      one provider connection to spend on things that are not this. */
  ratings: {},
  /** An episode Continue watching asked for, waiting on the list that can
      turn its number into an index. `{ seriesId, season, episode }`. */
  resumeEpisode: null,
  /** What the box is recording or has recorded, so a guide slab can say so.
      Fetched when the schedule is drawn; it is a small list and the box
      answers it without touching the provider. */
  recordings: [],
};

/* ------------------------------------------------------- prefs (server) */

/**
 * Pins and favorites are held on the server so they're the same on the
 * laptop, the iPad and the phone. Kept in memory and pushed on change.
 */
const prefs = {
  data: {
    pinnedCategories: [],
    favorites: [],
    filtersEnabled: true,
    filters: {},
    // The subtitle track last turned on, by label. Somebody who wants English
    // subtitles wants them on the next film too, and being asked again every
    // time is the thing this remembers them to avoid.
    captionTrack: '',
    // Weak Wi-Fi: have the box shrink everything before it crosses the link.
    // Remembered rather than asked, because the corner of the house with bad
    // signal is still bad tomorrow.
    lowBandwidth: false,
  },

  async load() {
    try {
      this.data = await api('/api/prefs');
    } catch {
      /* fall back to the empty defaults */
    }
  },

  async save() {
    try {
      await fetch('/api/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.data),
      });
    } catch {
      toast('Could not save preferences to the server.');
    }
  },

};

/* -------------------------------------------------------------- profiles

 * Personas, in the Netflix sense. Favorites, pinned categories, watch history
 * and ratings all hang off whichever profile is active. Which profile this
 * device last used is remembered locally; everything else lives on the server
 * so a profile is the same on the laptop, the iPad and the phone.
 */

const AVATARS = ['🎬', '🍿', '📺', '🎥', '🐂', '🌾', '⭐', '🎯', '🃏', '🚀', '🎸', '🏈'];
const SWATCHES = ['#A21F24', '#6E1418', '#2F5D50', '#2B4C7E', '#7A4E1D', '#4A3A63'];

const profiles = {
  all: [],
  current: null,
  locked: false,
  data: { favorites: [], pinnedCategories: [] },

  async load() {
    const res = await api('/api/profiles');
    this.all = res.profiles || [];
    // Whether adding or removing a profile needs the password. Off unless
    // somebody deliberately turned it on.
    this.locked = res.locked === true;
    const lastId = localStorage.getItem('portal.profile');
    const match = this.all.find((p) => p.id === lastId);
    if (match) await this.select(match, { silent: true });
  },

  async select(profile, { silent = false } = {}) {
    this.current = profile;
    localStorage.setItem('portal.profile', profile.id);
    this.data = await api(`/api/profiles/${profile.id}/prefs`);
    $('#chipAvatar').textContent = profile.emoji;
    $('#chipAvatar').style.background = profile.color;
    $('#chipName').textContent = profile.name;
    $('#profileChip').hidden = false;
    // Which of the two lives in the corner depends on who is watching, so it
    // is decided here rather than once at startup.
    reporter.applyButtons();
    if (!silent) toast(`Watching as ${profile.name}.`);
  },

  /** Recently watched, which fills the For You shelf. */
  async loadTaste() {
    if (!this.current) return;
    try {
      // A link to the box slow enough to hang this would otherwise hang
      // whatever is waiting on it, with nothing on screen to say why.
      const taste = await Promise.race([
        api(`/api/profiles/${this.current.id}/taste`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000)),
      ]);
      state.recentlyWatched = taste.recentlyWatched || [];
      state.ratings = taste.ratings || {};
    } catch {
      // Keep whatever was already loaded. Emptying it here blanked Continue
      // watching every time the call was merely slow.
    }
  },

  async save() {
    if (!this.current) return;
    try {
      await fetch(`/api/profiles/${this.current.id}/prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.data),
      });
    } catch {
      toast('Could not save to this profile.');
    }
  },

  /* -- pinned categories -- */
  pinKey(tab, id) {
    return `${tab}:${id}`;
  },
  isPinned(tab, id) {
    return (this.data.pinnedCategories || []).includes(this.pinKey(tab, id));
  },
  togglePin(tab, id) {
    const key = this.pinKey(tab, id);
    const list = (this.data.pinnedCategories ||= []);
    const at = list.indexOf(key);
    if (at >= 0) list.splice(at, 1);
    else list.unshift(key);
    this.save();
    return at < 0;
  },
  /** The pinned ids for one tab, in the order they should be shown. */
  pinOrder(tab) {
    const prefix = `${tab}:`;
    return (this.data.pinnedCategories || [])
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  },
  /**
   * Record the order a tab's pins were dragged into. Other tabs' pins are kept
   * as they were — the list is shared, but the ordering only ever means
   * anything within one tab.
   */
  setPinOrder(tab, ids) {
    const prefix = `${tab}:`;
    const others = (this.data.pinnedCategories || []).filter((key) => !key.startsWith(prefix));
    this.data.pinnedCategories = [...ids.map((id) => this.pinKey(tab, id)), ...others];
    this.save();
  },

  /**
   * The order the channel row was dragged into.
   *
   * Favourites are one list holding channels, films and shows, kept newest
   * first — so this permutes the entries IN PLACE rather than rewriting the
   * list: the positions the given keys already occupy are filled with those
   * keys in their new order, and everything else stays exactly where it was.
   * Dragging a channel must not shuffle the films on the Favorites page.
   */
  setFavOrder(keys) {
    const list = this.data.favorites || [];
    const rank = new Map(keys.map((key, i) => [key, i]));
    const slots = [];
    const moving = [];
    list.forEach((entry, i) => {
      if (!rank.has(entry.key)) return;
      slots.push(i);
      moving.push(entry);
    });
    if (moving.length < 2) return;
    moving.sort((a, b) => rank.get(a.key) - rank.get(b.key));
    slots.forEach((at, i) => { list[at] = moving[i]; });
    this.data.favorites = list;
    this.save();
  },

  /* -- deleted titles --
   *
   * Hidden rather than removed: the provider still carries them and will keep
   * sending them, so this is a list of things not to show. Kept per profile,
   * since one person's junk is another's watchlist.
   */
  isDeleted(item) {
    return (this.data.deletedItems || []).includes(this.favKey(item));
  },
  toggleDeleted(item) {
    const key = this.favKey(item);
    const list = (this.data.deletedItems ||= []);
    const at = list.indexOf(key);
    if (at >= 0) list.splice(at, 1);
    else list.unshift(key);
    this.save();
    return at < 0;
  },
  /** Everything hidden in this section, newest first. */
  deletedItems(tab) {
    const keys = this.data.deletedItems || [];
    const lib = state.library[tab];
    if (!lib) return [];
    const byKey = new Map(lib.items.map((i) => [this.favKey(i), i]));
    return keys.map((key) => byKey.get(key)).filter(Boolean);
  },

  /* -- hidden live categories --
   *
   * Separate from deletedItems: that list is keyed by kind and id and holds
   * titles and channels, while this one hides a whole category of them.
   */
  isDeletedCategory(id) {
    return (this.data.deletedCategories || []).includes(String(id));
  },
  toggleDeletedCategory(id) {
    const list = (this.data.deletedCategories ||= []);
    const at = list.indexOf(String(id));
    if (at >= 0) list.splice(at, 1);
    else list.unshift(String(id));
    this.save();
    return at < 0;
  },

  /* -- favorites -- */
  favKey(item) {
    return `${item.kind}:${item.id}`;
  },
  hasFav(item) {
    return (this.data.favorites || []).some((f) => f.key === this.favKey(item));
  },
  toggleFav(item) {
    const key = this.favKey(item);
    const list = (this.data.favorites ||= []);
    const at = list.findIndex((f) => f.key === key);
    if (at >= 0) list.splice(at, 1);
    else list.unshift({ key, item });
    this.data.favorites = list.slice(0, 500);
    this.save();
    return at < 0;
  },
  favItems() {
    return (this.data.favorites || []).map((f) => f.item);
  },
};

/* --------------------------------------------------------------- helpers */

async function api(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const img = (src) => (src ? `/img?u=${encodeURIComponent(src)}` : '');

/**
 * How a live channel is played. One setting, not a choice, and this is it.
 *
 * There used to be three modes in a dropdown — ride the edge, balanced, don't
 * drain at all — which asked the viewer to trade stalling against being behind
 * without giving them any way to know which they were about to get. The trade
 * is real, but it has a right answer on this provider, and it is this.
 *
 * The important thing about live is that those two costs are NOT on the same
 * dial, even though the dropdown implied they were:
 *
 *   * **How far behind you are** is set by where the playhead sits relative to
 *     the end of the playlist — `liveSyncDurationCount`, in segments.
 *   * **How much cushion you have** is how much of the playlist between the
 *     playhead and that end has been downloaded — `maxBufferLength`.
 *
 * A live playlist only ever exposes up to the edge, so buffering aggressively
 * cannot push you further behind: it can only fill in the gap you are already
 * standing in. The cushion is free.
 *
 * **The distance is in seconds, not segments, and that is the whole of the
 * fix for the stalls.** It was `liveSyncDurationCount: 3` — three segments back
 * — which reads like a cushion and is not one. That count multiplies the
 * playlist's own `targetDuration` and is then clamped into whatever playlist
 * happens to exist at the moment of joining, and a measured session joined
 * **2.8 seconds** from the end of the loaded data. It stalled the instant the
 * playhead caught up, twice, and then played perfectly for the rest of the
 * session once around ten seconds of cushion had accumulated on its own:
 *
 *     joined  pos 27.2  buf 30   2.8s ahead   stalled 6s
 *             pos 30.6  buf 40   9.4s ahead
 *             pos 40.0  buf 40   0.0s ahead   stalled 3s
 *             pos 44.5  buf 60  15.5s ahead   smooth to the end
 *
 * `liveSyncDuration` is that distance stated outright, so it does not depend on
 * the provider's segment length or on how much playlist had arrived yet. The
 * worst slow spell in that session was 6 seconds; 18 is three times it.
 *
 * `lowLatencyMode` is off because this provider does not serve LL-HLS parts;
 * with it on, hls.js works to stay nearer the edge than the stream can support,
 * which is stalling bought with nothing.
 *
 * **And nothing chases the edge — not on jitter, not ever.** How far behind
 * you are is not a fault to be corrected. Seeking forward to close a gap
 * throws away the downloaded video that was keeping the picture up and buys a
 * position nearer an edge the link cannot keep up with, which starves again
 * within seconds: one stall becomes a stall plus a jump. A channel that stays
 * forty seconds behind and keeps playing is the better outcome, and it is the
 * one this aims for.
 *
 * **Eighteen seconds was not far enough back, and the reason is arithmetic.**
 * This provider publishes 11-second segments, so sitting 18 seconds back is a
 * seat 1.6 segments from the edge — and since a segment only becomes fetchable
 * once it is complete, the most that can ever be in hand is about one of them.
 * A measured session started playing with **7.1 seconds** of video downloaded
 * and stalled seven seconds later, exactly on cue.
 *
 * So the seat is a middle. Too near the edge and there is never a cushion; too
 * far back and the oldest segments expire out of the playlist under the
 * playhead, which forces a jump nobody chose. Roughly half of the window is
 * the seat that trades those off, and on this provider that is ~32 seconds.
 */

/** How much video to have in hand before starting, as a share of the window. */
const LIVE_PREROLL = 0.3;
/** But never more than this many seconds of waiting-room, however deep the
 * window is — the point is a head start, not a screening delay. */
const LIVE_PREROLL_CAP = 10;

/**
 * The seat when the Pi's own live buffer is serving the channel.
 *
 * The server ingests the channel once and republishes it with a window of
 * about two minutes (see live DVR in server.js), so the two failure modes that
 * priced the direct seat move apart: segments cannot expire under the playhead
 * until two whole minutes of drift, and the material behind the seat is on the
 * Pi's disk rather than subject to the provider's mood. 45 seconds back buys
 * over ten of the Pi's ~4s segments of runway while staying well inside the
 * two minutes behind live that is the outer limit of acceptable.
 */
const LIVE_DVR_SEAT = 45;

/**
 * How many times a multiview cell will pick itself back up before giving in.
 *
 * Four cells share one link and one box, so a cell being starved long enough
 * to lose its place is ordinary rather than exceptional — and it used to end
 * that cell for the rest of the sitting. The budget refills as soon as the
 * cell is genuinely playing again, so this is five failures in a row, not
 * five all evening.
 */
const MV_RECOVER_TRIES = 5;

/**
 * How the player behaves on a link that keeps faltering.
 *
 * The stream itself is already small by the time this matters — the box
 * shrank it — so the remaining enemy is not size but interruption: a few
 * seconds of nothing, over and over. Every one of these settings buys
 * patience. A fragment that fails is retried far more times and for far
 * longer before it is called fatal, because on a weak link the difference
 * between "slow" and "broken" is mostly how long you are willing to wait.
 */
const LOW_PATIENCE = {
  // A minute of runway rather than seconds of it.
  maxBufferLength: 90,
  maxMaxBufferLength: 600,
  // Keep asking. hls.js gives a fragment six tries by default and then
  // declares the stream dead; on bad Wi-Fi six tries is an ordinary bad
  // minute, not a verdict.
  fragLoadingMaxRetry: 12,
  fragLoadingRetryDelay: 1500,
  fragLoadingMaxRetryTimeout: 30000,
  manifestLoadingMaxRetry: 8,
  manifestLoadingRetryDelay: 1500,
  levelLoadingMaxRetry: 8,
  levelLoadingRetryDelay: 1500,
  // A slow response is not a failed one. The defaults time out long before
  // a struggling link has finished answering.
  fragLoadingTimeOut: 60000,
  manifestLoadingTimeOut: 30000,
  levelLoadingTimeOut: 30000,
};

const LIVE_HLS = {
  lowLatencyMode: false,
  // Seconds behind the edge to join at. This provider publishes 58-60s of
  // playlist on every channel measured, so this is about half of it: enough
  // room ahead to hold a real cushion, enough behind that segments do not
  // expire under the playhead.
  liveSyncDuration: 32,
  // Parked out of reach on purpose. This is hls.js's own latency chaser, and
  // a stream that keeps playing while running late is exactly what is wanted
  // here — there is nothing for it to fix.
  liveMaxLatencyDuration: 600,
  // Hold everything from the playhead to the edge. Costs no latency: the
  // playlist stops at the edge, so this can only fill the gap already there.
  maxBufferLength: 45,
  maxMaxBufferLength: 90,
  backBufferLength: 60,
  // hls.js never draws cues itself. The captions module runs every track in
  // 'hidden' mode and paints its own overlay; left true, hls.js flips its
  // in-band track to 'showing' on its own schedule — which is one of the
  // ways captions came back after being turned off.
  subtitleDisplay: false,
};

/**
 * How tall the app frame is allowed to be, in pixels on the glass.
 *
 * The phone frame cannot be sized in viewport units. `100dvh` and a fixed box
 * inset to zero both describe the LAYOUT viewport, and on an iPhone opening
 * this from a home-screen icon that predates the standalone meta tag, the
 * layout viewport continues on behind Safari's bottom toolbar. A tab bar at the
 * bottom of that box is underneath the toolbar and cannot be seen — which is
 * what happened, twice, to two different-looking fixes that were making the
 * same mistake.
 *
 * `visualViewport.height` is the part that is actually on the glass: browser
 * chrome and the keyboard are already subtracted from it. There is no CSS unit
 * for that, so it is measured and written into a custom property.
 *
 * Only `resize` is listened to. `scroll` fires continuously while Safari's
 * toolbar slides and would rewrite the frame height on every frame of it;
 * resize fires when the height actually settles, which is the moment that
 * matters.
 */
/**
 * How much room the player's buttons need, so the title can stop short of them.
 *
 * The top strip reserved a flat 200px for that corner. That was right for the
 * four buttons there when it was written, and wrong the moment a fifth arrived:
 * the channel name ran on underneath the LIVE pill. Which buttons are up
 * depends on what is playing — live has a pill and a multi-view button a film
 * does not — so the figure cannot be a constant. It is measured.
 *
 * Watched rather than merely called, because the widest of those controls is
 * the LIVE pill and its text changes every second: "LIVE" one moment and
 * "118s behind" the next. Anything that measured on open alone would be wrong
 * a second later, which is how the name ended up under the pill in the first
 * place.
 */
function reservePlayerActions() {
  const bar = document.querySelector('.player-bar-actions');
  if (!bar) return;
  const w = Math.ceil(bar.getBoundingClientRect().width);
  if (w > 0) document.documentElement.style.setProperty('--player-actions-w', `${w}px`);
}

if (window.ResizeObserver) {
  const bar = document.querySelector('.player-bar-actions');
  if (bar) new ResizeObserver(reservePlayerActions).observe(bar);
}

const appHeight = {
  apply() {
    const vv = window.visualViewport;
    const h = Math.round(vv ? vv.height : window.innerHeight);
    if (h > 0) document.documentElement.style.setProperty('--app-h', `${h}px`);
  },

  watch() {
    this.apply();
    const again = () => {
      // Two passes: iOS reports the old height for a frame or two after the
      // chrome moves, and the second one is the true figure.
      this.apply();
      reservePlayerActions();
      setTimeout(() => { this.apply(); reservePlayerActions(); }, 300);
    };
    window.visualViewport?.addEventListener('resize', again);
    window.addEventListener('resize', again);
    window.addEventListener('orientationchange', again);
    // Coming back from the background or from another app: iOS often lays out
    // once with a stale height on the way in.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) again();
    });
  },
};
appHeight.watch();

/**
 * Back to the top of whatever is actually scrolling.
 *
 * On a desktop that is the document. On a phone it is the view: the document
 * is pinned to the screen so nothing can rubber-band the tab bar out of the
 * bottom of it, which means `window.scrollTo` there scrolls something that
 * never moves.
 */
function scrollViewTop() {
  const view = document.body.classList.contains('has-tabbar')
    ? document.querySelector('#appView:not([hidden])')
    : null;
  if (view) view.scrollTop = 0;
  else window.scrollTo({ top: 0 });
}

/* ----------------------------------------------------------- this device

 * A phone and a desktop are far enough apart to be two layouts rather than one
 * that stretches between them. Phone gets the sections as a bottom bar; desktop
 * keeps the hamburger.
 *
 * TWO questions, not one. They used to be the same question, and an iPad is the
 * device that shows why they are not:
 *
 *   * `html.touch` — should this be built for a finger? 44px targets, and
 *     anything that only appeared on :hover shown outright. True for every
 *     iPhone and every iPad — and for anyone who picks Phone by hand, because
 *     a good deal of what hangs off this class is phone LAYOUT rather than
 *     target size: the player that puts its transport out over the picture,
 *     the detail page that stacks. Picking Phone has always meant those, and
 *     narrowing `touch` to mean only "a finger" would quietly take them away.
 *   * `device.phone` / `body.has-tabbar` — is this a PHONE-shaped screen? The
 *     sections move to a bottom bar and the nav becomes its overflow.
 *
 * An iPad is the first without the second: a finger, on a screen wide enough
 * for the portal's own chrome. It used to get both, because a coarse pointer
 * set `touch` and `touch` WAS phone layout — so an 820pt screen was laid out as
 * a large phone. It now gets finger-sized targets and the nav, which is what
 * the design asks for.
 *
 * There used to be a posters-per-row setting here as well — 2, 3 or 4, picked
 * by hand, phone only. It is gone. The grid now names one target poster WIDTH
 * and lets the column count fall out of the screen, so it is right on an SE, a
 * Pro Max, an iPad and a desktop without anyone choosing a number, and right on
 * hardware that does not exist yet. See --poster-min in styles.css.
 *
 * Kept per-device in localStorage rather than in the profile: the same profile
 * is used from both, and only one of them wants any of this.
 */

/* Below this, a screen is phone-shaped. It is the width at which the portal's
   own header stops fitting — see the laptop breakpoints in desktop.css, whose
   last step is the one that gets an iPad's 820pt bar down to size. */
const PHONE_MAX = 820;

const device = {
  phone: false,
  coarse: false,
  /** Did a person choose the layout, or are we reading the hardware? */
  chosen: false,

  /* A finger, or a layout that is built like one. Either is enough. */
  get touch() { return this.coarse || this.phone; },

  init() {
    const saved = localStorage.getItem('portal.touch');
    // A coarse pointer means a finger, which is every iPhone and every iPad.
    this.coarse = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
    this.chosen = saved !== null;
    this.phone = this.chosen ? saved === '1' : this.autoPhone();

    // The column setting is retired. Clear what an older build stored rather
    // than leaving a key in localStorage that nothing reads.
    localStorage.removeItem('portal.cols');
    this.apply();
  },

  /* A finger on a phone-shaped screen. A finger on a bigger one is an iPad,
     which has the room for the nav and is better off with it. */
  autoPhone() {
    return this.coarse && window.innerWidth < PHONE_MAX;
  },

  /* An iPad turned on its side crosses PHONE_MAX, so the answer has to be
     re-asked on resize — but never once somebody has chosen for themselves. */
  reflow() {
    if (this.chosen) return;
    const next = this.autoPhone();
    if (next === this.phone) return;
    this.phone = next;
    this.apply();
    if (state.config) render();
  },

  apply() {
    const root = document.documentElement;
    root.classList.toggle('touch', this.touch);

    const btn = $('#touchToggle');
    btn.classList.toggle('is-on', this.phone);
    btn.setAttribute('aria-pressed', String(this.phone));

    $('#tabBar').hidden = !this.phone;
    // The bar covers the foot of the page, so the page has to stop above it.
    document.body.classList.toggle('has-tabbar', this.phone);

    for (const b of document.querySelectorAll('#layoutSeg button')) {
      b.classList.toggle('is-on', (b.dataset.phone === '1') === this.phone);
    }

    syncTabs();
  },

  setPhone(on) {
    this.phone = on;
    this.chosen = true;
    localStorage.setItem('portal.touch', on ? '1' : '0');
    this.apply();
  },
};

addEventListener('resize', () => device.reflow());

/** Mark the open section on whichever nav is showing. */
function syncTabs() {
  for (const link of document.querySelectorAll('.nav a, .tabbar a')) {
    link.classList.toggle('is-active', link.dataset.tab === state.tab);
  }
}

$('#touchToggle').addEventListener('click', () => {
  $('#deviceModal').hidden = false;
});
$('#deviceClose').addEventListener('click', () => {
  $('#deviceModal').hidden = true;
});
$('#deviceModal').addEventListener('click', (event) => {
  if (event.target.id === 'deviceModal') $('#deviceModal').hidden = true;
});

$('#layoutSeg').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  device.setPhone(button.dataset.phone === '1');
  // The sidebar and the rails lay out differently between the two.
  if (state.config) render();
});

/* ------------------------------------------------------- multi-view --- */

/**
 * Multi-view is on for everyone now.
 *
 * It lived behind a beta switch while the question it was built to answer was
 * still open — whether an account that allows one connection could feed several
 * cells at once. It can, because HLS holds no connection open, and it has run
 * that way long enough that keeping it behind a switch was only making it
 * harder to find. The switch went with it: it existed to hold this.
 *
 * The button is Live TV's, because that is the only page where putting four
 * things side by side means anything.
 */
function applyMultiviewButton() {
  $('#multiviewBtn').hidden = state.tab !== 'live';
}

/**
 * The listings button, beside multi-view and for the same reason.
 *
 * Both are ways of looking at a whole category at once rather than one
 * channel at a time — multi-view by watching four of them, this by reading
 * what is on all of them. It belongs to Live TV alone: a schedule is a thing
 * channels have and films do not.
 */
function applyListingsButton() {
  const button = $('#listingsBtn');
  button.hidden = state.tab !== 'live' || state.config?.mode !== 'xtream';
  button.classList.toggle('is-on', state.listings);
  $('#listingsLabel').textContent = state.listings ? 'Channels' : 'Listings';
  button.title = state.listings
    ? 'Back to the channel grid'
    : "What's on, across everything on this page";
}

$('#listingsBtn').addEventListener('click', () => {
  state.listings = !state.listings;
  applyListingsButton();
  render();
});

$('#multiviewBtn').addEventListener('click', () => multiview.open());


/**
 * Two to four live channels on one screen.
 *
 * Its own player, deliberately. The main one is built around there being
 * exactly one of everything — one video element, one engine, one film bar, one
 * watchdog, one remux session, all module-level — and none of that survives
 * being asked to be four things at once. Sharing it would have meant unpicking
 * every one of those globals for a feature that already worked here.
 *
 * It was built expecting to fail: the account allows one connection at a time.
 * It does not fail, because HLS holds no connection open — see the README. Each
 * cell still reports its own outcome in the provider's words, because that is
 * what made the answer legible and is what will make the MPEG-TS case legible
 * when somebody tries it.
 */
const MV_MAX = 4;
const MV_SKIP = 10;          // seconds a skip button moves
const MV_IDLE = 3000;        // how long the chrome stays up with nothing moving

/**
 * What the picker can offer. The first three are the provider's libraries and
 * browse as categories; the last two are this profile's own flat lists, need
 * no fetch, and are the fast way to fill a cell with something you already
 * know you want.
 */
const MV_SOURCES = ['live', 'movies', 'series', 'favorites', 'recent', 'archive'];

const multiview = {
  cells: [],
  count: 4,
  picking: -1,
  solo: -1,
  idleTimer: null,
  /** What the picker is offering — one of MV_SOURCES. */
  source: 'live',
  /** Which category the picker is inside, or null at the top level. */
  browsing: null,
  /** Which folder of the archive drive the picker is inside, '' at the top. */
  archiveDir: '',
  /** Which show the picker is inside, for the episode step. */
  show: null,

  /* -- building ------------------------------------------------------- */

  /** Cells are built once; opening, closing and resizing do not rebuild them. */
  build() {
    if (this.cells.length) return;
    const grid = $('#mvGrid');
    for (let i = 0; i < MV_MAX; i += 1) grid.append(this.cell(i));

    const saved = Number(localStorage.getItem('portal.mvCount'));
    this.count = [2, 3, 4].includes(saved) ? saved : 4;
    for (const button of document.querySelectorAll('#mvCountSeg button')) {
      button.addEventListener('click', () => this.setCount(Number(button.dataset.count)));
    }
  },

  /** Where a cell is right now, which reordering changes under it. */
  at(cell) {
    return this.cells.indexOf(cell);
  },

  cell(index) {
    // The record is made first and the handlers close over IT rather than over
    // `index`, because cells can be dragged into each other's places — a
    // button that remembered where it was built would then act on whichever
    // cell had moved into that slot.
    const rec = {
      engine: null,
      item: null,
      format: '',
      // A film or an episode rather than a channel: it is a conversion, and
      // only one of those can run at a time.
      vod: false,
      remux: '',
      label: '',
      // Asked for is not the same as playing, and on this account it was
      // expected not to be. Tracked separately so the count says which.
      ok: false,
    };
    this.cells[index] = rec;

    const box = el('div', 'mv-cell');
    const video = el('video');
    video.playsInline = true;
    // Every cell starts silent. Four live channels all talking at once is not
    // a feature, and a browser will refuse to autoplay with sound anyway —
    // one cell can be unmuted at a time, below.
    video.muted = true;
    video.autoplay = true;

    const empty = el('button', 'mv-empty');
    // Not "a channel" any more: a cell will take a film or an episode too.
    empty.innerHTML = '<span class="mv-plus">+</span><span>Add a channel or film</span>';
    empty.addEventListener('click', () => this.pick(this.at(rec)));

    const button = (cls, label, title, onClick) => {
      const b = el('button', cls);
      b.innerHTML = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
        this.wake();          // pressing a control counts as being here
      });
      return b;
    };

    const bar = el('div', 'mv-bar');
    // A button rather than a label, because on a show it is the way into the
    // episode list. It only reads as pressable when there is a show behind it.
    const name = el('button', 'mv-name');
    name.type = 'button';
    name.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openEpisodes(this.at(rec));
    });
    // Which delivery each cell got. This is the answer to why several at once
    // works at all, so it belongs on the screen rather than in a comment.
    const tag = el('span', 'mv-tag');

    const back = button('mv-btn', '−10', `Back ${MV_SKIP} seconds`,
      () => this.skip(this.at(rec), -MV_SKIP));
    const play = button('mv-btn mv-play', '❚❚', 'Pause', () => this.toggle(this.at(rec)));
    const fwd = button('mv-btn', '+10', `Forward ${MV_SKIP} seconds`,
      () => this.skip(this.at(rec), MV_SKIP));
    const again = button('mv-btn mv-again', '↻', 'Refresh this stream',
      () => this.refresh(this.at(rec)));
    const sound = button('mv-btn mv-sound', '🔇', 'Listen to this one',
      () => this.listen(this.at(rec)));
    const grow = button('mv-btn mv-grow', '⤢', 'Full screen',
      () => this.expand(this.at(rec)));
    const drop = button('mv-btn mv-drop', '✕', 'Stop this channel',
      () => this.stop(this.at(rec)));

    // The handle. Dragging it onto another cell swaps the two.
    const grip = el('button', 'mv-btn mv-grip');
    grip.innerHTML = '⠿';
    grip.title = 'Drag to move this stream';
    grip.setAttribute('aria-label', grip.title);
    this.makeDraggable(grip, rec);

    bar.append(name, tag, grip, back, play, fwd, again, sound, grow, drop);

    const note = el('p', 'mv-status');
    note.hidden = true;   // an empty one still paints as a grey strip

    // The episode list, inside the cell it belongs to.
    //
    // A sheet over the whole screen would be the easy way to build this and the
    // wrong thing to build: the other three cells are still playing, and
    // choosing the next episode of one show is not a reason to take the game
    // away from someone. It is absolutely positioned within the cell box, so it
    // covers exactly the picture it is about.
    const sheet = el('div', 'mv-sheet');
    sheet.hidden = true;
    const sheetTop = el('div', 'mv-sheet-top');
    const sheetTitle = el('h4', 'mv-sheet-title');
    const sheetClose = el('button', 'mv-btn');
    sheetClose.type = 'button';
    sheetClose.innerHTML = '✕';
    sheetClose.title = 'Back to the picture';
    sheetClose.setAttribute('aria-label', sheetClose.title);
    sheetClose.addEventListener('click', (event) => {
      event.stopPropagation();
      this.closeEpisodes(this.at(rec));
    });
    sheetTop.append(sheetTitle, sheetClose);
    const sheetBody = el('div', 'mv-sheet-body');
    sheet.append(sheetTop, sheetBody);

    box.append(video, note, bar, empty, sheet);
    Object.assign(rec, {
      box, video, empty, bar, name, tag, play, sound, note,
      sheet, sheetTitle, sheetBody,
    });
    return box;
  },

  /* -- the episode list, inside the cell --------------------------------- */

  /**
   * Open the show that is playing in this cell, in this cell.
   *
   * Reached by pressing the name in the cell's own bar, which is where the
   * name of the thing already is — so there is nothing new to find. The list
   * is the whole show, seasons and all, not just what is next: picking an
   * episode is the reason somebody opened it.
   */
  async openEpisodes(index) {
    const cell = this.cells[index];
    const show = cell?.item;
    if (!show || show.kind !== 'series') return;

    cell.sheet.hidden = false;
    cell.sheetTitle.textContent = show.name;
    cell.sheetBody.innerHTML = '';
    this.wake();

    const loading = el('p', 'mv-sheet-note');
    loading.textContent = 'Loading episodes…';
    cell.sheetBody.append(loading);

    if (!state.seriesCache[show.id]) {
      try {
        state.seriesCache[show.id] =
          await api('/api/xtream', { action: 'get_series_info', series_id: show.id });
      } catch (err) {
        loading.textContent = `Couldn't load episodes: ${err.message}`;
        return;
      }
    }
    // Left while it was in flight, or the cell was repointed at something else.
    if (cell.sheet.hidden || cell.item !== show) return;
    this.paintEpisodes(cell, show);
  },

  paintEpisodes(cell, show) {
    const body = cell.sheetBody;
    body.innerHTML = '';
    const episodes = state.seriesCache[show.id]?.episodes || {};
    const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
    if (!seasons.length) {
      const note = el('p', 'mv-sheet-note');
      note.textContent = 'No episodes listed for this show.';
      return body.append(note);
    }

    // Which one is on now, so the list says where you are rather than making
    // you count. The override is what the cell was actually started with.
    const playingId = String(cell.override?.id ?? '');

    for (const season of seasons) {
      const head = el('p', 'mv-season');
      head.textContent = `Season ${season}`;
      body.append(head);
      for (const ep of episodes[season] || []) {
        const row = el('button', 'mv-ep');
        row.type = 'button';
        const num = el('span', 'mv-ep-num');
        num.textContent = `E${ep.episode_num}`;
        const title = el('span', 'mv-ep-title');
        title.textContent = ep.title || `Episode ${ep.episode_num}`;
        row.append(num, title);
        if (String(ep.id) === playingId) {
          row.classList.add('is-playing');
          const now = el('span', 'mv-ep-now');
          now.textContent = 'Playing';
          row.append(now);
        }
        row.addEventListener('click', (event) => {
          event.stopPropagation();
          const at = this.at(cell);
          this.closeEpisodes(at);
          this.start(at, show, {
            kind: 'series',
            id: ep.id,
            ext: ep.container_extension || 'mp4',
            vcodec: ep.info?.video?.codec_name || '',
            label: `${show.name} — S${season}E${ep.episode_num}`,
          });
        });
        body.append(row);
      }
    }
  },

  closeEpisodes(index) {
    const cell = this.cells[index];
    if (!cell) return;
    cell.sheet.hidden = true;
    this.wake();
  },

  /** Is any cell showing its episode list? The chrome must not fade over one. */
  sheetOpen() {
    return this.cells.some((c) => c && !c.sheet.hidden);
  },

  /* -- moving cells around ---------------------------------------------- */

  /**
   * Swap two cells.
   *
   * The DOM nodes are exchanged rather than the streams inside them. Handing a
   * playing `<video>` to another box would mean tearing its engine down and
   * asking the provider all over again for something already on screen; moving
   * the box takes the element, the engine and whatever it has buffered with it,
   * and the picture does not so much as blink.
   *
   * `cells` is reordered to match, because everything else — which cells the
   * count shows, which one is blown up — is by position.
   */
  swap(a, b) {
    if (a === b || !this.cells[a] || !this.cells[b]) return;
    const boxA = this.cells[a].box;
    const boxB = this.cells[b].box;
    const grid = $('#mvGrid');

    // A marker, because inserting A before B moves A out from under B first.
    const marker = document.createComment('');
    grid.insertBefore(marker, boxA);
    grid.insertBefore(boxA, boxB);
    grid.insertBefore(boxB, marker);
    marker.remove();

    [this.cells[a], this.cells[b]] = [this.cells[b], this.cells[a]];
    // Sound is a property of the cell, and the cell has moved with it.
    if (this.solo === a) this.solo = b;
    else if (this.solo === b) this.solo = a;
    this.paint();
  },

  /**
   * Pointer-events drag, the same bargain the pinned-category rows make: the
   * drag only begins once the pointer has moved a few pixels, so a tap on the
   * handle is still a tap and the two gestures do not fight.
   */
  makeDraggable(grip, rec) {
    let from = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let held = null;

    const cellUnder = (event) => {
      const node = document.elementFromPoint(event.clientX, event.clientY);
      const box = node?.closest?.('.mv-cell');
      if (!box) return -1;
      const at = this.cells.findIndex((c) => c.box === box);
      return at < this.count ? at : -1;
    };

    const clear = () => {
      for (const c of this.cells) c.box.classList.remove('is-dragging', 'is-target');
    };

    const onMove = (event) => {
      if (held !== event.pointerId) return;
      if (!dragging) {
        if (Math.abs(event.clientX - startX) < 6 && Math.abs(event.clientY - startY) < 6) return;
        dragging = true;
        rec.box.classList.add('is-dragging');
      }
      event.preventDefault();
      this.wake();
      const over = cellUnder(event);
      for (const c of this.cells) c.box.classList.remove('is-target');
      if (over >= 0 && over !== this.at(rec)) this.cells[over].box.classList.add('is-target');
    };

    const onUp = (event) => {
      if (held !== event.pointerId) return;
      grip.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      held = null;
      if (dragging) {
        const over = cellUnder(event);
        if (over >= 0 && over !== this.at(rec)) this.swap(this.at(rec), over);
      }
      dragging = false;
      clear();
    };

    grip.addEventListener('pointerdown', (event) => {
      from = this.at(rec);
      if (from < 0) return;
      held = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      grip.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  },

  /* -- opening and closing --------------------------------------------- */

  open() {
    this.build();
    // The main player holds the connection while it is up, and this is a
    // measurement of what happens when several are asked for at once. Leaving
    // it running would put a fifth claimant in the experiment.
    if (!$('#playerOverlay').hidden) closePlayer();
    $('#multiview').hidden = false;
    document.body.style.overflow = 'hidden';
    this.paint();
    this.wake();
  },

  close() {
    if ($('#multiview').hidden) return;
    this.unexpand({ silent: true });
    this.stopAll();
    clearTimeout(this.idleTimer);
    $('#multiview').classList.remove('is-idle');
    $('#multiview').hidden = true;
    $('#mvPicker').hidden = true;
    document.body.style.overflow = '';
  },

  /* -- how many cells --------------------------------------------------- */

  /**
   * Two, three or four. The grid template comes from the count rather than the
   * cells laying themselves out, so three is one large beside two stacked
   * rather than three across with a hole where the fourth would be.
   */
  setCount(count) {
    if (![2, 3, 4].includes(count)) return;
    // Anything being dropped has to let go of its stream first, or it keeps
    // playing off-screen and keeps whatever the provider gave it.
    for (let i = count; i < MV_MAX; i += 1) this.stop(i);
    this.count = count;
    localStorage.setItem('portal.mvCount', String(count));
    if (this.solo >= count) this.unexpand({ silent: true });
    this.paint();
  },

  /* -- one cell filling the screen -------------------------------------- */

  /**
   * Blow one cell up to the whole screen, and ask the browser for real
   * fullscreen while we are at it. Backing out of either returns to the grid
   * rather than closing multi-view, which is the whole point of the button.
   */
  expand(index) {
    const cell = this.cells[index];
    if (!cell?.item) return;
    if (this.solo === index) return this.unexpand();
    this.solo = index;
    this.paint();
    const root = $('#multiview');
    if (!document.fullscreenElement && root.requestFullscreen) {
      root.requestFullscreen().catch(() => {
        // Refused — the in-app blow-up above still stands on its own.
      });
    }
  },

  unexpand({ silent = false } = {}) {
    if (this.solo < 0) return;
    this.solo = -1;
    if (!silent) this.paint();
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  },

  /* -- chrome that gets out of the way ---------------------------------- */

  /**
   * The bars sit on top of the picture, so they fade out when nothing is
   * happening and come back on any movement — the same bargain the main
   * player makes. A cell with nothing in it keeps its prompt: there is no
   * picture there to be in the way of.
   */
  wake() {
    const root = $('#multiview');
    root.classList.remove('is-idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Not while a menu is open over the top of it, and not while somebody is
      // reading an episode list inside a cell.
      if ($('#mvPicker').hidden && !this.sheetOpen()) root.classList.add('is-idle');
    }, MV_IDLE);
  },

  /* -- painting --------------------------------------------------------- */

  paint() {
    const grid = $('#mvGrid');
    grid.dataset.count = String(this.count);
    grid.classList.toggle('is-solo', this.solo >= 0);

    this.cells.forEach((cell, i) => {
      const inUse = i < this.count;
      const live = Boolean(cell.item);
      // Beyond the chosen count the cell is gone, not merely empty — a blank
      // square is exactly what choosing a count is meant to avoid.
      cell.box.hidden = !inUse || (this.solo >= 0 && this.solo !== i);
      cell.box.classList.toggle('is-solo', this.solo === i);
      // `pending` is a cell that has been given something but has nothing to
      // show for it yet — a history row being turned into an episode id. The
      // prompt to add something would be inviting a second choice over the top
      // of the first.
      cell.empty.hidden = live || Boolean(cell.pending);
      cell.bar.hidden = !live;
      cell.video.hidden = !live;
      cell.name.textContent = cell.label || cell.item?.name || '';
      // Only a way in when there is a show behind it. On a channel or a film
      // the name is a label, and a label that looks pressable is a lie.
      const isShow = cell.item?.kind === 'series';
      cell.name.classList.toggle('is-link', isShow);
      cell.name.disabled = !isShow;
      cell.name.title = isShow ? `All episodes of ${cell.item.name}` : '';
      if (!isShow && !cell.sheet.hidden) cell.sheet.hidden = true;
      cell.tag.textContent = live && cell.format ? cell.format.toUpperCase() : '';
      cell.tag.hidden = !cell.tag.textContent;
      cell.tag.classList.toggle('is-held', cell.format === 'ts');
      // The header used to carry a running tally and an explanation of the
      // one-connection limit. It was a readout for an experiment, and the
      // experiment is over — but which delivery a cell got still matters when
      // two of them fight, so it says so on the cell that is holding one.
      cell.tag.title = cell.format === 'ts'
        ? 'MPEG-TS — holds a connection open the whole time it plays, and this '
          + 'account allows one. Two of these will fight.'
        : cell.format === 'm3u8'
          ? 'HLS — fetches a segment at a time and holds no connection open.'
          : cell.format === 'file' ? 'Playing from a downloaded file.' : '';
      cell.sound.textContent = cell.video.muted ? '🔇' : '🔊';
      cell.sound.classList.toggle('is-on', !cell.video.muted);
      cell.play.textContent = cell.video.paused ? '▶' : '❚❚';
      cell.play.title = cell.video.paused ? 'Play' : 'Pause';
    });

    for (const button of document.querySelectorAll('#mvCountSeg button')) {
      button.classList.toggle('is-on', Number(button.dataset.count) === this.count);
    }
  },

  /* -- transport -------------------------------------------------------- */

  toggle(index) {
    const cell = this.cells[index];
    if (!cell?.item) return;
    if (cell.video.paused) cell.video.play().catch(() => {});
    else cell.video.pause();
    this.paint();
  },

  /**
   * Nudge one cell along its own timeline.
   *
   * Live is not a film: how far back you can go is however much of the stream
   * the player still holds, and forward stops at the live edge. Clamped to
   * what the element says is seekable rather than assumed, so pressing it at
   * the edge does nothing instead of throwing the position somewhere invalid.
   */
  skip(index, seconds) {
    const cell = this.cells[index];
    const video = cell?.video;
    if (!cell?.item || !video || !video.seekable?.length) return;
    const first = video.seekable.start(0);
    const last = video.seekable.end(video.seekable.length - 1);
    video.currentTime = Math.max(first, Math.min(last, video.currentTime + seconds));
  },

  /**
   * Throw this cell's stream away and ask for it again.
   *
   * The one recovery a cell did not have. A failed cell does not retry by
   * itself — a reconnect loop would take the connection off whichever cell
   * currently has it, and on MPEG-TS the order of who held it when is the
   * thing being watched — so somebody has to say when, and until now saying
   * when meant stopping the cell and finding the channel in the picker again.
   *
   * Sound follows the stream: a cell you were listening to is still the one
   * you want to hear afterwards.
   */
  refresh(index) {
    const cell = this.cells[index];
    if (!cell?.item) return;
    const listening = !cell.video.muted;
    const item = cell.item;
    const again = cell.override || undefined;
    this.start(index, item, again).then(() => {
      if (listening && this.cells[index]?.item === item) this.listen(index);
    });
  },

  /** Exactly one cell may make a noise. */
  listen(index) {
    const wanted = this.cells[index];
    const turningOn = wanted.video.muted;
    for (const cell of this.cells) cell.video.muted = true;
    if (turningOn) {
      wanted.video.muted = false;
      // A muted element is allowed to autoplay; unmuting one that never got a
      // gesture can be refused, and silently.
      wanted.video.play().catch(() => {});
    }
    this.paint();
  },

  /* -- the picker ------------------------------------------------------- */

  pick(index) {
    this.picking = index;
    this.browsing = null;
    this.show = null;
    $('#mvSearch').value = '';
    $('#mvPicker').hidden = false;
    this.results('');
    $('#mvSearch').focus();
  },

  closePicker() {
    $('#mvPicker').hidden = true;
    this.wake();
  },

  async setSource(source) {
    if (!MV_SOURCES.includes(source)) return;
    this.source = source;
    this.browsing = null;
    this.show = null;
    $('#mvSearch').value = '';
    $('#mvSearch').placeholder = {
      live: 'Search channels…',
      movies: 'Search films…',
      series: 'Search shows…',
      favorites: 'Search favorites…',
      recent: 'Search what you have watched…',
      archive: 'Search the drive…',
    }[source];

    // The drive answers from the box's index rather than from a library held
    // in the browser, so this asks for the folder it is about to draw.
    if (source === 'archive') {
      this.archiveDir = '';
      this.results('');
      try {
        await loadArchive('');
      } catch (err) {
        toast(`Couldn't read the archive: ${err.message}`);
      }
      if (this.source === 'archive') this.results($('#mvSearch').value || '');
      return;
    }

    this.results('');

    // Favorites and Recent are already on this device — the profile's own
    // lists, not the provider's — so there is nothing to fetch and nothing to
    // wait for. Resolving one into something playable happens on the tap.
    if (source === 'favorites' || source === 'recent') return;

    // Multi-view is reached from Live TV, so Movies and Series have usually
    // never been opened in this session and their libraries are not loaded.
    // Fetching one here beats a dead end telling somebody to go and open a
    // page they came here to avoid.
    if (!state.library[source]) {
      $('#mvPickerSub').textContent = 'Loading…';
      try {
        await loadTab(source);
      } catch (err) {
        $('#mvPickerSub').textContent = `Couldn't load: ${err.message}`;
        return;
      }
      if (this.source !== source) return;   // switched again while it loaded
      this.results($('#mvSearch').value);
    }
  },

  /** Back out one level at a time: an episode list, then a category, then out. */
  pickerBack() {
    if ($('#mvSearch').value.trim()) {
      $('#mvSearch').value = '';
      return this.results('');
    }
    if (this.show) {
      this.show = null;
      return this.results('');
    }
    if (this.browsing) {
      this.browsing = null;
      return this.results('');
    }
    // Up one folder of the drive rather than straight out of the picker.
    if (this.source === 'archive' && this.archiveDir) {
      this.archiveDir = this.archiveDir.split('/').slice(0, -1).join('/');
      return loadArchive(this.archiveDir).then(() => {
        if (this.source === 'archive') this.results('');
      });
    }
    this.closePicker();
  },

  /**
   * Categories first, then what is inside one — the same two steps, and the
   * same tiles, as the library page for whichever source is chosen. Series get
   * a third step, because a show is not a thing you can play.
   *
   * Typing cuts across every category, because a search that only looked
   * inside the folder you happened to be in would be a worse search.
   */
  results(query) {
    const box = $('#mvResults');
    box.innerHTML = '';
    for (const b of document.querySelectorAll('#mvSourceSeg button')) {
      b.classList.toggle('is-on', b.dataset.source === this.source);
    }

    // The two shortcut lists are flat by nature — there is no category step to
    // take, and inventing one would put a folder in front of the six things
    // somebody came here to pick from. The episode step still applies: a
    // favorited show is a show, not something you can play.
    if (this.source === 'favorites' || this.source === 'recent') {
      if (this.show) return this.episodeTiles(box);
      box.classList.remove('is-cats');
      box.classList.add('is-live');
      $('#mvPickerBackLabel').textContent = query.trim() ? 'Back' : 'Cancel';
      return this.source === 'favorites'
        ? this.favoriteTiles(box, query)
        : this.recentTiles(box, query);
    }

    if (this.source === 'archive') {
      box.classList.remove('is-cats');
      box.classList.add('is-live');
      $('#mvPickerBackLabel').textContent =
        (query.trim() || this.archiveDir) ? 'Back' : 'Cancel';
      return this.archiveTiles(box, query);
    }

    const library = state.library[this.source];
    if (!library) {
      $('#mvPickerSub').textContent = '';
      $('#mvPickerTitle').textContent = 'Pick something';
      const note = el('p', 'show-note');
      note.textContent =
        `No ${this.source === 'live' ? 'channels' : this.source} loaded yet — `
        + 'open that section once and come back.';
      return box.append(note);
    }
    const q = query.trim().toLowerCase();
    // Multi-view searches its own box, so it needs the same door: adult
    // titles only once the word is typed here too.
    const all = browsable(library.items || [], q);

    if (this.show) return this.episodeTiles(box);

    const inCategory = Boolean(this.browsing) && !q;
    const flat = inCategory || Boolean(q);
    box.classList.toggle('is-cats', !flat);
    box.classList.toggle('is-live', flat && this.source === 'live');

    $('#mvPickerTitle').textContent = inCategory ? this.browsing.name : 'Pick something';
    $('#mvPickerBackLabel').textContent = inCategory || q ? 'Back' : 'Cancel';

    if (!all.length) {
      $('#mvPickerSub').textContent = '';
      const note = el('p', 'show-note');
      note.textContent = 'Nothing in here yet.';
      return box.append(note);
    }

    // Counts and cover art in one pass, exactly as the library page does it:
    // the item list runs to thousands, so walking it per category would show.
    const counts = new Map();
    const covers = new Map();
    for (const item of all) {
      const id = String(item.categoryId);
      counts.set(id, (counts.get(id) || 0) + 1);
      if (item.logo && !covers.has(id) && !looksAnimated(item.logo)) covers.set(id, item.logo);
    }

    if (!flat) return this.categoryTiles(box, library, counts, covers);

    const inside = inCategory
      ? all.filter((i) => String(i.categoryId) === String(this.browsing.id))
      : all;
    const hits = (q ? inside.filter((i) => i.name.toLowerCase().includes(q)) : inside)
      .filter((i) => !profiles.isDeleted(i))
      .slice(0, 300);

    $('#mvPickerSub').textContent = hits.length
      ? `${hits.length.toLocaleString()} ${hits.length === 1 ? 'title' : 'titles'}`
      : '';
    if (!hits.length) {
      const note = el('p', 'show-note');
      note.textContent = 'Nothing matches that.';
      return box.append(note);
    }
    for (const item of hits) box.append(this.titleTile(item));
  },

  categoryTiles(box, library, counts, covers) {
    const cats = (library.categories || []).filter(
      (cat) => counts.get(String(cat.id)) && !profiles.isDeletedCategory(cat.id)
    );
    // Pinned first, in the order they were dragged into — the same sequence
    // the library grid shows them in.
    const order = profiles.pinOrder(this.source);
    const pinned = cats
      .filter((c) => profiles.isPinned(this.source, c.id))
      .sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
    const rest = cats.filter((c) => !profiles.isPinned(this.source, c.id));
    const ordered = [...pinned, ...rest];

    $('#mvPickerSub').textContent =
      `${ordered.length.toLocaleString()} categor${ordered.length === 1 ? 'y' : 'ies'}`;
    if (!ordered.length) {
      const note = el('p', 'show-note');
      note.textContent = 'Nothing in here.';
      return box.append(note);
    }
    for (const cat of ordered) {
      const id = String(cat.id);
      box.append(liveCategoryCard(cat, counts.get(id) || 0, covers.get(id) || '', {
        bin: false,
        tab: this.source,
        onOpen: () => { this.browsing = cat; this.results(''); },
      }));
    }
  },

  /**
   * A tile for a channel, a film, or a show. Same shape, different action.
   *
   * `opts.sub` puts a line under the name and `opts.onPick` replaces what a
   * tap does — both only used by the two shortcut lists, where a tile has to
   * say what kind of thing it is (the list is mixed) and where getting from a
   * saved row to something playable takes more than handing over the record.
   */
  titleTile(item, { sub = '', onPick = null } = {}) {
    const card = el('button', 'card');
    const art = el('div', 'card-art');
    const nameOnly = () => {
      const fb = el('div', 'fallback');
      fb.textContent = item.name;
      art.append(fb);
    };
    const poster = item.logo || item.poster || '';
    if (poster) {
      const image = el('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = poster;
      image.addEventListener('error', () => { image.remove(); nameOnly(); });
      art.append(image);
    } else {
      nameOnly();
    }
    const title = el('h3', 'card-title');
    title.textContent = item.name;
    card.append(art, title);
    if (sub) {
      const line = el('p', 'card-sub');
      line.textContent = sub;
      card.append(line);
    }
    card.addEventListener('click', () => {
      if (onPick) return onPick();
      // A show is not a thing you can play — it is a list of things you can.
      if (item.kind === 'series') return this.openShow(item);
      this.closePicker();
      this.start(this.picking, item);
    });
    return card;
  },

  /* -- the two shortcut lists -------------------------------------------- */

  /**
   * Favorites. These are whole library records — the heart in the player saves
   * the item, not a reference to it — so a channel or a film goes straight into
   * a cell with nothing to look up. A show still opens its episode list.
   */
  /**
   * The drive, in a cell.
   *
   * Folders then files, the same two steps as the Archive page, because
   * 5,853 files flattened into one list is not something anybody browses.
   * Typing cuts across all of it — and only across the drive: the archive is
   * searched from the archive and nowhere else, which is exactly how the
   * main page treats it too.
   */
  async archiveTiles(box, query) {
    const q = query.trim();
    if (q) {
      try {
        await searchArchive(q);
      } catch (err) {
        const note = el('p', 'show-note');
        note.textContent = `Couldn't search the drive: ${err.message}`;
        return box.append(note);
      }
      if (this.source !== 'archive') return;   // moved on while it answered
      box.innerHTML = '';
    }

    const data = state.archive.data || { subdirs: [], items: [] };
    const dirs = q ? [] : (data.subdirs || []);
    const items = data.items || [];

    $('#mvPickerTitle').textContent = q ? 'Search results'
      : (this.archiveDir || 'Archive');
    $('#mvPickerSub').textContent = items.length || dirs.length
      ? `${dirs.length ? `${dirs.length} folder${dirs.length === 1 ? '' : 's'}` : ''}`
        + `${dirs.length && items.length ? ' · ' : ''}`
        + `${items.length ? `${items.length.toLocaleString()} file${items.length === 1 ? '' : 's'}` : ''}`
      : '';

    if (!dirs.length && !items.length) {
      const note = el('p', 'show-note');
      note.textContent = q ? 'Nothing on the drive matches that.'
        : 'Nothing here. Is the drive plugged in?';
      return box.append(note);
    }

    for (const dir of dirs) {
      const tile = this.titleTile(
        { name: dir.name, kind: 'movie', logo: '' },
        {
          sub: `${(dir.count || 0).toLocaleString()} file${dir.count === 1 ? '' : 's'}`,
          onPick: async () => {
            // `dir` is the full path from the top of the drive, already.
            this.archiveDir = dir.dir || dir.name;
            await loadArchive(this.archiveDir);
            if (this.source === 'archive') this.results('');
          },
        }
      );
      box.append(tile);
    }

    for (const entry of items) {
      box.append(this.titleTile(
        { name: entry.title, kind: 'movie', logo: '' },
        {
          sub: entry.duration ? `${Math.round(entry.duration / 60)} min` : 'On the drive',
          onPick: () => {
            const index = this.picking;
            this.closePicker();
            this.start(index, archiveItemToPlayable(entry));
          },
        }
      ));
    }
  },

  favoriteTiles(box, query) {
    const q = query.trim().toLowerCase();
    const kindWord = { live: 'Channel', movie: 'Film', series: 'Show' };
    const items = profiles.favItems()
      .filter((i) => i && i.name)
      .filter((i) => !profiles.isDeleted(i))
      .filter((i) => !q || i.name.toLowerCase().includes(q));

    $('#mvPickerTitle').textContent = 'Favorites';
    $('#mvPickerSub').textContent = items.length
      ? `${items.length.toLocaleString()} favorite${items.length === 1 ? '' : 's'}`
      : '';
    if (!items.length) {
      const note = el('p', 'show-note');
      note.textContent = q ? 'Nothing matches that.'
        : 'No favorites yet — tap the heart while watching something.';
      return box.append(note);
    }
    for (const item of items) {
      box.append(this.titleTile(item, { sub: kindWord[item.kind] || '' }));
    }
  },

  /**
   * Recently viewed. Unlike favorites these are HISTORY rows, which carry a
   * name and a poster but not the fields a stream needs — no extension, and
   * for a show an episode NUMBER rather than the provider's episode id. So a
   * tile draws from the row and the resolving waits until it is tapped, in
   * `startRecent`, where there is somewhere to report it going wrong.
   *
   * One row per title, newest first: the history is per-episode, and five
   * tiles of the same show would crowd out four other things.
   */
  recentTiles(box, query) {
    const q = query.trim().toLowerCase();
    const seen = new Set();
    const rows = [];
    for (const row of state.recentlyWatched || []) {
      if (!row?.name) continue;
      const key = `${row.kind}:${row.seriesId ?? row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (q && !row.name.toLowerCase().includes(q)) continue;
      rows.push(row);
      if (rows.length === 40) break;
    }

    $('#mvPickerTitle').textContent = 'Recently viewed';
    $('#mvPickerSub').textContent = rows.length
      ? `${rows.length} title${rows.length === 1 ? '' : 's'}` : '';
    if (!rows.length) {
      const note = el('p', 'show-note');
      note.textContent = q ? 'Nothing matches that.'
        : 'Nothing watched yet — this fills up as you use the app.';
      return box.append(note);
    }

    for (const row of rows) {
      const sub = row.kind === 'live' ? 'Channel'
        : row.kind === 'series' && row.season && row.episode
          ? `S${row.season}E${row.episode}`
          : row.kind === 'series' ? 'Show' : 'Film';
      box.append(this.titleTile(row, { sub, onPick: () => this.startRecent(row) }));
    }
  },

  /**
   * Turn a history row into something a cell can play.
   *
   * A channel or a film only needs its library record, for the extension the
   * conversion is asked for. A show needs the episode list as well, because
   * the row remembers season 2 episode 5 and the provider wants an episode id
   * — the same translation Continue watching does on the home screen, and for
   * the same reason: landing somebody on a show's page to find their own place
   * again is the work this is meant to skip.
   */
  async startRecent(row) {
    const index = this.picking;

    /* An archive title never was in the provider library, so looking it up
     * there ends in "no longer in the library" — the wrong words entirely for
     * a file sitting on the drive, and exactly what a viewer picking one out
     * of Recent was told. Its id carries its own path; that plus the row's
     * name is everything a cell needs. */
    if (String(row.id || '').startsWith('archive:')) {
      this.closePicker();
      return this.start(index, {
        kind: 'movie',
        id: row.id,
        name: row.name || '',
        archivePath: String(row.id).slice('archive:'.length),
        localOnly: true,
        logo: row.poster || '',
      });
    }

    /* A copy on the box needs no catalogue — see savedCopy(). */
    const onTheBox = savedCopy(row);
    if (onTheBox) {
      this.closePicker();
      return this.start(index, onTheBox);
    }

    const tab = row.kind === 'series' ? 'series' : row.kind === 'live' ? 'live' : 'movies';
    this.closePicker();

    const cell = this.cells[index];
    if (cell) {
      cell.pending = true;
      cell.note.hidden = false;
      cell.note.textContent = 'Finding it…';
      this.paint();
    }
    const giveUp = (why) => {
      if (!cell) return toast(why);
      cell.pending = false;
      cell.note.textContent = why;
      this.paint();
    };

    const wantId = String(row.kind === 'series' ? row.seriesId ?? row.id : row.id);
    let item;
    try {
      item = await findTitle(tab, wantId);
    } catch (err) {
      return giveUp(`Couldn't load ${tab}: ${err.message}`);
    }

    if (!item) return giveUp(missingWhy(tab));
    if (item.kind !== 'series') return this.start(index, item);

    // The episode list is the only thing that can turn "season 2, episode 5"
    // into the id the stream is asked for.
    try {
      state.seriesCache[item.id] ||=
        await api('/api/xtream', { action: 'get_series_info', series_id: item.id });
    } catch (err) {
      return giveUp(`Couldn't load episodes: ${err.message}`);
    }

    const episodes = state.seriesCache[item.id]?.episodes || {};
    const season = String(row.season || '');
    const wanted = Number(row.episode) || 0;
    const ep = (episodes[season] || []).find((e) => Number(e.episode_num) === wanted);
    if (!ep) {
      // The show is still here but that episode is not. Better to hand over the
      // list than to fail at somebody who only wanted to carry on watching.
      this.picking = index;
      $('#mvPicker').hidden = false;
      if (cell) { cell.note.hidden = true; cell.empty.hidden = false; this.paint(); }
      return this.openShow(item);
    }

    this.start(index, item, {
      kind: 'series',
      id: ep.id,
      ext: ep.container_extension || 'mp4',
      vcodec: ep.info?.video?.codec_name || '',
      label: `${item.name} — S${season}E${wanted}`,
    });
  },

  /* -- the third step, for series --------------------------------------- */

  async openShow(item) {
    this.show = item;
    $('#mvPickerTitle').textContent = item.name;
    $('#mvPickerSub').textContent = 'Loading episodes…';
    $('#mvPickerBackLabel').textContent = 'Back';
    $('#mvResults').innerHTML = '';
    if (!state.seriesCache[item.id]) {
      try {
        state.seriesCache[item.id] =
          await api('/api/xtream', { action: 'get_series_info', series_id: item.id });
      } catch (err) {
        $('#mvPickerSub').textContent = '';
        const note = el('p', 'show-note');
        note.textContent = `Couldn't load episodes: ${err.message}`;
        return $('#mvResults').append(note);
      }
    }
    if (this.show !== item) return;    // left while that was in flight
    this.episodeTiles($('#mvResults'));
  },

  episodeTiles(box) {
    box.innerHTML = '';
    box.classList.remove('is-cats');
    box.classList.add('is-live');
    const item = this.show;
    $('#mvPickerTitle').textContent = item.name;
    $('#mvPickerBackLabel').textContent = 'Back';

    const episodes = state.seriesCache[item.id]?.episodes || {};
    const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
    const rows = seasons.flatMap((season) =>
      (episodes[season] || []).map((ep) => ({ season, ep })));
    $('#mvPickerSub').textContent = rows.length
      ? `${rows.length} episode${rows.length === 1 ? '' : 's'}`
      : '';
    if (!rows.length) {
      const note = el('p', 'show-note');
      note.textContent = 'No episodes listed for this series.';
      return box.append(note);
    }

    for (const { season, ep } of rows) {
      const card = el('button', 'card');
      const art = el('div', 'card-art');
      const fb = el('div', 'fallback');
      fb.textContent = `S${season} E${ep.episode_num}`;
      art.append(fb);
      const title = el('h3', 'card-title');
      title.textContent = ep.title || `Episode ${ep.episode_num}`;
      card.append(art, title);
      card.addEventListener('click', () => {
        this.closePicker();
        this.start(this.picking, item, {
          kind: 'series',
          id: ep.id,
          ext: ep.container_extension || 'mp4',
          vcodec: ep.info?.video?.codec_name || '',
          label: `${item.name} — S${season}E${ep.episode_num}`,
        });
      });
      box.append(card);
    }
  },

  /* -- streams ---------------------------------------------------------- */

  /**
   * Put something in a cell.
   *
   * Live is a channel and costs nothing but segment fetches. A film or an
   * episode is a CONVERSION — ffmpeg on the Pi, reading one continuous stream
   * from the provider — and the server runs exactly one of those at a time by
   * design: startRemux kills whatever was running before it spawns. So one
   * cell can hold a conversion, and asking a second to takes the first one's
   * picture away. That is enforced here rather than discovered.
   */
  async start(index, item, override) {
    const cell = this.cells[index];
    if (!cell) return;
    const kind = override?.kind || item.kind;
    const vod = kind !== 'live';

    if (vod) {
      const busy = this.cells.findIndex((c, i) => i !== index && i < this.count && c.vod);
      if (busy >= 0) {
        toast('Only one film or episode at a time — the box converts it as it plays. '
          + `Stopping “${this.cells[busy].item?.name || 'the other one'}”.`);
        this.stop(busy);
      }
    }

    this.stop(index);
    cell.item = item;
    cell.vod = vod;
    cell.override = override || null;
    cell.label = override?.label || item.name;
    cell.ok = false;
    cell.note.hidden = false;
    cell.note.textContent = vod ? 'Converting…' : 'Asking for the stream…';
    this.paint();

    // Stamped so a slow answer for a cell that has since been stopped or
    // repointed does not attach itself over whatever is there now.
    const mine = (cell.token = (cell.token || 0) + 1);
    const stale = () => cell.token !== mine || cell.item !== item;

    try {
      const play = vod
        ? await this.resolveVod(cell, item, override, () => stale())
        : await api('/api/play', {
          kind: 'live',
          id: item.id,
          ext: item.ext || '',
          ...lowParam(),
        });
      if (stale() || !play) return;
      cell.format = play.format || '';
      this.attach(cell, play.url, play.format, vod, Boolean(play.dvr));
    } catch (err) {
      if (cell.token !== mine) return;
      // The interesting failure. Said plainly rather than as a stack.
      cell.note.textContent = `Refused: ${err.message}`;
      cell.ok = false;
      this.paint();
    }
  },

  /**
   * A film or an episode, ready to attach.
   *
   * A finished download in a container the browser already plays is the cheap
   * case and the only one that costs nothing at all — no ffmpeg, no provider
   * connection, and no limit on how many cells could do it. Everything else is
   * a conversion, and the wait for it is reported on the cell rather than
   * through the app-wide loader, which would cover the other three.
   */
  async resolveVod(cell, item, override, stale) {
    // A file on the archive drive. Its own endpoint, because it is not a
    // provider title and has no stream id to ask about — and because that
    // endpoint keeps one conversion per file, which a cell joins like any
    // other viewer.
    if (item.archivePath) {
      const data = await api('/api/archive/play', {
        path: item.archivePath,
        profileId: profiles.current?.id || '',
        ...lowParam(),
      });
      if (stale()) return null;
      if (data.mode === 'direct') return { url: data.url, format: 'file' };
      cell.remux = data.session || '';
      await this.waitForConversion(cell, data, stale);
      if (stale()) return null;
      return { url: data.url, format: 'm3u8' };
    }

    const kind = override?.kind || item.kind;
    const id = override?.id ?? item.id;
    const ext = override?.ext ?? item.ext ?? '';

    const local = findLocalCopy(kind, id);
    if (local && !needsRemux(local.ext)) {
      return { url: `/api/downloads/${local.id}/file`, format: 'file' };
    }

    // `replaces` is this cell's own previous conversion, if it had one. The
    // server clears that one away and leaves the other cells alone; without
    // it, opening a second converted title killed the first.
    const replaces = cell.remux || '';
    const remuxed = local
      ? await api('/api/remux', { download: local.id, replaces, ...lowParam() })
      : await api('/api/remux', {
        kind,
        id,
        ext,
        vcodec: override?.vcodec || item.vcodec || '',
        replaces,
        ...lowParam(),
      });
    if (stale()) {
      // Nothing is going to watch it, so do not leave ffmpeg grinding — but
      // only this one, not whatever the other cells are running.
      const mine = remuxed.session;
      if (mine) fetch(`/api/remux/stop?id=${encodeURIComponent(mine)}`).catch(() => {});
      return null;
    }
    cell.remux = remuxed.session || '';
    await this.waitForConversion(cell, remuxed, stale);
    if (stale()) return null;
    return { url: remuxed.url, format: 'm3u8' };
  },

  /**
   * Wait for the conversion to bank enough to play through, counting up on the
   * cell itself. The main player's waitForPrebuffer cannot be reused: it puts
   * the full-screen loader up and writes the module-level activeRemux, both of
   * which belong to the one thing the main player is doing.
   */
  async waitForConversion(cell, remux, stale) {
    if (!remux.session) return;
    const target = remux.prebuffer || 45;
    const startedAt = Date.now();
    for (;;) {
      if (stale()) return;
      let status;
      try {
        status = await api('/api/remux/status', { id: remux.session });
      } catch {
        return;                       // session gone; let the player try anyway
      }
      if (status.failed) throw new Error(status.error || 'Conversion failed');
      if (status.complete || status.seconds >= target) return;
      cell.note.textContent =
        `Converting — ${Math.round(status.seconds)}s of ${Math.round(target)}s banked`;
      // Give up waiting rather than hanging on a conversion that has stalled;
      // whatever has been written by then is usually enough to start on.
      if (Date.now() - startedAt > 90_000) return;
      await new Promise((r) => setTimeout(r, 700));
    }
  },

  attach(cell, url, format, vod = false, dvr = false) {
    const video = cell.video;
    cell.note.textContent = 'Connecting…';
    video.addEventListener('playing', () => {
      cell.note.hidden = true;
      cell.ok = true;
      this.paint();
    }, { once: true });
    // So the play/pause button follows the element rather than only the
    // button that was pressed — a stall or an ended stream moves it too.
    for (const evt of ['play', 'pause']) {
      video.addEventListener(evt, () => this.paint());
    }

    if (format === 'ts' && window.mpegts && mpegts.isSupported()) {
      cell.engine = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url: new URL(url, location.href).href },
        { enableWorker: true, liveBufferLatencyChasing: false, enableStashBuffer: false }
      );
      cell.engine.attachMediaElement(video);
      cell.engine.load();
      cell.engine.play().catch(() => {});
      cell.engine.on(mpegts.Events.ERROR, (type, detail) => {
        cell.note.hidden = false;
        cell.note.textContent = `Stream error — ${type}: ${detail}`;
        cell.ok = false;
        this.paint();
      });
      return;
    }

    if (format === 'm3u8' && window.Hls && Hls.isSupported()) {
      // backBufferLength is what the −10 button has to work with: it is how
      // much of the stream stays seekable behind the playhead.
      //
      // A conversion needs the opposite settings to a channel. Its playlist
      // has no end marker while ffmpeg is still writing, so hls.js reads it as
      // live — and with a back buffer being evicted the playhead can fall out
      // of the window and get dragged forward to the "live edge", which here
      // is just however far ffmpeg has got. Never evicting keeps the window
      // starting at zero, and startPosition pins it to the beginning.
      cell.engine = new Hls(vod
        ? {
          ...(lowMode() ? LOW_PATIENCE : {}),
          lowLatencyMode: false,
          backBufferLength: Infinity,
          liveSyncDuration: 1e9,
          liveMaxLatencyDuration: 2e9,
          liveDurationInfinity: false,
          maxBufferLength: 120,
          startPosition: 0,
        }
        : { ...LIVE_HLS, ...(dvr ? { liveSyncDuration: LIVE_DVR_SEAT } : {}),
          ...(lowMode() ? LOW_PATIENCE : {}) });
      cell.engine.loadSource(url);
      cell.engine.attachMedia(video);

      // A cell that has been playing a while is worth saving.
      //
      // Every fatal error used to end the cell for good, on reasoning
      // borrowed from the MPEG-TS path (a reconnect there would take the
      // provider connection off another cell). It does not hold here, and
      // the cost was that ordinary bad luck — a segment that expired while
      // this cell was starved of bandwidth by the three beside it, a
      // dropped connection — read as "Stream failed" and stayed that way.
      //
      // Recover in place instead: reload from the live edge for a channel,
      // from where it stands for a conversion, backing off each time. The
      // budget resets once it is genuinely playing again, so a stream that
      // hiccups every twenty minutes recovers every time, while one that is
      // truly gone still stops rather than retrying for ever.
      cell.tries = 0;
      cell.engine.on(Hls.Events.FRAG_BUFFERED, () => { cell.tries = 0; });
      cell.engine.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        const engine = cell.engine;
        if (!engine) return;

        const fatalEnd = (why) => {
          cell.note.hidden = false;
          cell.note.textContent = `Stream failed — ${why}`;
          cell.ok = false;
          this.paint();
          try { engine.destroy(); } catch { /* already gone */ }
          if (cell.engine === engine) cell.engine = null;
        };

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          cell.tries += 1;
          if (cell.tries > MV_RECOVER_TRIES) return fatalEnd(data.details);
          try { engine.recoverMediaError(); } catch { fatalEnd(data.details); }
          return;
        }

        if (data.type !== Hls.ErrorTypes.NETWORK_ERROR) return fatalEnd(data.details);

        cell.tries += 1;
        if (cell.tries > MV_RECOVER_TRIES) return fatalEnd(data.details);
        cell.note.hidden = false;
        cell.note.textContent = `Reconnecting… (${cell.tries} of ${MV_RECOVER_TRIES})`;
        cell.ok = false;
        this.paint();
        setTimeout(() => {
          // Gone from under us while we waited — closed, or swapped for
          // another title.
          if (cell.engine !== engine) return;
          try {
            // -1 is the live edge: a channel that fell off the back of the
            // playlist has to rejoin at the front, not where it was.
            engine.startLoad(vod ? undefined : -1);
          } catch {
            fatalEnd(data.details);
          }
        }, Math.min(1000 * 2 ** (cell.tries - 1), 8000));
      });
      return;
    }

    video.src = url;
    video.play().catch(() => {
      cell.note.hidden = false;
      cell.note.textContent = 'The browser would not start this one.';
    });
  },

  stop(index) {
    const cell = this.cells[index];
    if (!cell) return;
    cell.token = (cell.token || 0) + 1;   // orphan anything still in flight
    if (cell.engine) {
      try { cell.engine.destroy(); } catch { /* already gone */ }
      cell.engine = null;
    }
    // A conversion is a process on the box, not just a socket in the browser.
    // Left running it keeps ffmpeg grinding through a film nobody is watching
    // and keeps the provider connection with it. Named, always: unqualified,
    // this stopped every OTHER cell's conversion too, and those cells then
    // played on out of their buffers and died a couple of minutes later.
    if (cell.remux) {
      fetch(`/api/remux/stop?id=${encodeURIComponent(cell.remux)}`).catch(() => {});
      cell.remux = '';
    }
    cell.video.removeAttribute('src');
    cell.video.load();
    cell.video.muted = true;
    cell.item = null;
    cell.vod = false;
    cell.override = null;
    cell.label = '';
    cell.ok = false;
    cell.format = '';
    cell.note.hidden = true;
    cell.note.textContent = '';
    cell.pending = false;
    // The list belongs to the show that was in this cell; there isn't one now.
    if (cell.sheet) cell.sheet.hidden = true;
    if (this.solo === index) this.unexpand({ silent: true });
    this.paint();
  },

  stopAll() {
    for (let i = 0; i < this.cells.length; i += 1) this.stop(i);
  },
};

$('#mvClose').addEventListener('click', () => multiview.close());
$('#mvStopAll').addEventListener('click', () => multiview.stopAll());
$('#mvPickerBack').addEventListener('click', () => multiview.pickerBack());
for (const button of document.querySelectorAll('#mvSourceSeg button')) {
  button.addEventListener('click', () => multiview.setSource(button.dataset.source));
}
$('#mvSearch').addEventListener('input', (event) => multiview.results(event.target.value));

// Any sign of life brings the chrome back. Pointer and touch both, since the
// phone has no mouse to move.
for (const evt of ['mousemove', 'pointerdown', 'touchstart', 'keydown']) {
  $('#multiview').addEventListener(evt, () => multiview.wake());
}

// Leaving browser fullscreen by any route — Escape, the browser's own control,
// swiping down — has to put the grid back rather than leave one cell blown up
// over an empty screen.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && multiview.solo >= 0) {
    multiview.solo = -1;
    multiview.paint();
  }
});

/* ----------------------------------------------------------- pi health */

/**
 * A read-only look at the box. It exists because the portal ate itself once
 * when the card filled up silently — storage is the headline, and the panel
 * polls while open so the bar moves as downloads land and get deleted.
 */
/**
 * Where the listings come from.
 *
 * The provider answers `get_short_epg` for a minority of what it sells, and
 * for everything else the guide is blank however patiently you ask. The fix
 * is to read an XMLTV feed somebody else publishes and join it to our
 * channels by name and id, and this panel is the whole of the setting up.
 *
 * It reports coverage rather than success, because those are different
 * questions: a fetch that worked and matched nothing is the failure people
 * actually hit, and "1,318 of 1,680 channels" says so where a tick would not.
 */
const guideSources = {
  timer: null,
  catalogue: [],
  known: 0,
  /** Set the moment anything on this form is touched; cleared by a save. */
  dirty: false,

  async load() {
    const panel = $('#guidePanel');
    panel.hidden = !reporter.isOwner();
    if (panel.hidden) return;
    try {
      const data = await api('/api/epg/sources');
      this.paint(data);
      // While a scan is running the numbers move, so the panel follows it.
      // Once it settles the polling stops — this is a settings screen, not a
      // dashboard.
      if (data.running) this.watch();
      else this.stop();
    } catch {
      $('#guideNote').textContent = 'Could not read the guide settings.';
    }
  },

  watch() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.load(), 3000);
  },

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  },

  paint(data) {
    // A save answers with the settings, not with the catalogue or the channel
    // count, so what is already known is kept rather than blanked.
    if (data.catalogue) this.catalogue = data.catalogue;
    if (data.known !== undefined) this.known = data.known;
    const chosen = new Set(data.sources || []);

    $('#guideProvider').closest('.gsrc-row').hidden = !data.hasProviderGuide;

    /* The form is rebuilt only when it is not being edited.
     *
     * This panel polls itself every three seconds while a fetch is running,
     * and rebuilding the tick boxes from the stored settings on every poll
     * silently threw away whatever had just been changed. Unticking a dead
     * feed came straight back, which is exactly how two guides that answer
     * 404 survived being removed twice.
     */
    if (!this.dirty) {
      $('#guideProvider').checked = data.useProviderGuide !== false;
      // The catalogue as tick boxes, with anything hand-entered kept in the
      // box underneath so a URL nobody offered is not silently dropped.
      const picks = $('#guidePicks');
      picks.innerHTML = '';
      const known = new Set(this.catalogue.map((c) => c.url));
      for (const entry of this.catalogue) {
        const row = document.createElement('label');
        row.className = 'gsrc-pick';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = entry.url;
        box.checked = chosen.has(entry.url);
        box.addEventListener('change', () => { this.dirty = true; });
        const name = document.createElement('span');
        name.textContent = entry.label;
        row.append(box, name);
        picks.append(row);
      }
      $('#guideExtra').value = [...chosen].filter((u) => !known.has(u)).join('\n');
    }

    $('#guideCover').textContent = data.covered
      ? `${data.covered.toLocaleString()} of ${(this.known || 0).toLocaleString()} channels`
      : '';
    const said = this.summary(data);
    const note = $('#guideNote');
    note.textContent = said.text;
    note.classList.toggle('is-bad', said.bad);
    const running = $('#guideRunning');
    running.hidden = !data.running;
    running.textContent = 'Reading the guides… this takes a few minutes.';
    $('#guideSave').disabled = Boolean(data.running);
    this.paintRuns(data.lastRun);
  },

  /**
   * A line per feed, saying what it actually gave us.
   *
   * The summary above only ever spoke up when coverage was zero, so a box
   * where the provider's guide worked and all three open feeds silently
   * contributed nothing looked entirely healthy. It is not a summary's job to
   * hide that: every feed gets a line, every time.
   */
  paintRuns(lastRun) {
    const box = $('#guideRuns');
    const runs = lastRun?.sources || [];
    box.hidden = !runs.length;
    box.innerHTML = '';
    for (const s of runs) {
      const line = document.createElement('div');
      let state = 'is-ok';
      let said;
      if (!s.ok) {
        state = 'is-bad';
        said = s.error;
      } else if (s.notXmltv) {
        // Different fix from "0 matched", so it gets different words.
        state = 'is-bad';
        said = 'answered, but there was no XMLTV in it';
      } else {
        said = `${(s.channels || 0).toLocaleString()} channels, `
          + `${(s.programmes || 0).toLocaleString()} listings for you`;
      }
      line.className = `gsrc-run ${state}`;
      line.textContent = `${s.label} — ${said}`;
      // A feed that failed gets a way to ask why. The label is redacted for
      // reading, so the button carries the real address.
      if (state === 'is-bad' && s.url) {
        const test = document.createElement('button');
        test.type = 'button';
        test.className = 'gsrc-test';
        test.textContent = 'why?';
        test.addEventListener('click', () => this.probe(s.url, line));
        line.append(' ', test);
      }
      box.append(line);
    }
  },

  /**
   * Ask the host what it publishes today.
   *
   * The tick boxes above are a list written down when this was built, and a
   * list about somebody else's server is wrong the moment they rename
   * something. Ticking one of these puts the real address in the box below,
   * so what gets saved is what the host says exists.
   */
  async browse() {
    const out = $('#guideFound');
    const button = $('#guideBrowse');
    out.hidden = false;
    out.textContent = 'asking the host…';
    button.disabled = true;
    try {
      const d = await api('/api/epg/available');
      out.textContent = '';
      if (d.error || !d.files.length) {
        out.textContent = d.error
          ? `Could not read the list — ${d.error}`
          : 'The host did not give a list of files.';
        return;
      }
      const chosen = new Set($('#guideExtra').value.split('\n').map((s) => s.trim()));
      const head = document.createElement('p');
      head.className = 'gsrc-lead';
      head.textContent = `${d.files.length} guides on that host right now. `
        + 'Tick to add — the ones you already have are ticked.';
      out.append(head);
      const grid = document.createElement('div');
      grid.className = 'gsrc-picks';
      for (const f of d.files) {
        const row = document.createElement('label');
        row.className = 'gsrc-pick';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = chosen.has(f.url)
          || [...$('#guidePicks').querySelectorAll('input:checked')].some((b) => b.value === f.url);
        box.addEventListener('change', () => this.toggleExtra(f.url, box.checked));
        const name = document.createElement('span');
        name.textContent = f.size ? `${f.name}  (${f.size})` : f.name;
        row.append(box, name);
        grid.append(row);
      }
      out.append(grid);
    } catch (err) {
      out.textContent = err.message || 'Could not ask the host.';
    } finally {
      button.disabled = false;
    }
  },

  /** Add or remove one address from the free-text box. */
  toggleExtra(url, on) {
    this.dirty = true;
    const box = $('#guideExtra');
    const lines = box.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const without = lines.filter((l) => l !== url);
    box.value = (on ? [...without, url] : without).join('\n');
  },

  /** Ask the box what that feed actually said, and print it. */
  async probe(url, after) {
    const out = document.createElement('div');
    out.className = 'gsrc-probe';
    out.textContent = 'asking…';
    after.after(out);
    try {
      const d = await api('/api/epg/probe', { url });
      if (d.error) {
        out.textContent = `could not reach it at all — ${d.error}`;
        return;
      }
      const bits = [`HTTP ${d.status}`];
      if (d.redirected) bits.push(`ended up at ${d.finalUrl}`);
      if (d.headers['content-type']) bits.push(d.headers['content-type']);
      if (d.headers['content-length']) bits.push(`${d.headers['content-length']} bytes`);
      if (d.headers.server) bits.push(`served by ${d.headers.server}`);
      if (d.looks) bits.push(`looks like ${d.looks}`);
      out.textContent = bits.join(' · ') + (d.snippet ? `\n${d.snippet}` : '');

      /* A missing guide has nearly always been renamed, so the useful part of
       * "not found" is the neighbouring filename — offered as a swap rather
       * than as something to retype. */
      if (d.alternatives?.length) {
        const also = document.createElement('div');
        also.className = 'gsrc-swap';
        also.append(Object.assign(document.createElement('span'), {
          textContent: 'The host does have these — swap one in?',
        }));
        for (const f of d.alternatives) {
          const pick = document.createElement('button');
          pick.type = 'button';
          pick.className = 'gsrc-test';
          pick.textContent = f.size ? `${f.name} (${f.size})` : f.name;
          pick.addEventListener('click', () => {
            this.toggleExtra(url, false);
            // Ticked in the catalogue rather than typed? Untick it, or it
            // comes straight back on the next save.
            for (const box of $('#guidePicks').querySelectorAll('input')) {
              if (box.value === url) box.checked = false;
            }
            this.toggleExtra(f.url, true);
            pick.textContent = `${f.name} — added, now press Save and fetch`;
            pick.disabled = true;
          });
          also.append(pick);
        }
        out.append(also);
      }
    } catch (err) {
      out.textContent = err.message || 'could not test that.';
    }
  },

  /**
   * The one paragraph that says whether this is working.
   *
   * `bad` is not "no listings" — a box nobody has set up yet is not broken,
   * it is new. It means something was tried and did not work, which is the
   * only state worth colouring.
   */
  summary(data) {
    if (data.running) return { text: 'Reading the guides now.', bad: false };
    // Nothing to match a guide against until the box has seen the channel
    // list, and it will not fetch the catalogue just to build a guide.
    if (data.blocked === 'no-channels') {
      return {
        text: 'The box has not loaded your channel list yet. Open Live TV once, '
          + 'then come back and press this again.',
        bad: false,
      };
    }
    if (!data.covered) {
      if (!(data.sources || []).length && data.useProviderGuide === false) {
        return {
          text: 'Nothing is switched on, so listings come from the provider one '
            + 'channel at a time — which is why most channels show none.',
          bad: false,
        };
      }
      const failed = (data.lastRun?.sources || []).filter((s) => !s.ok);
      if (failed.length) {
        return { text: `Nothing matched. ${failed[0].label}: ${failed[0].error}.`, bad: true };
      }
      if (!data.lastRun) {
        return { text: 'Not fetched yet. Save and fetch to try it.', bad: false };
      }
      return {
        text: 'Fetched, but nothing matched our channel names. Try a guide for '
          + 'the country these channels are from.',
        bad: true,
      };
    }
    const bits = [`${data.programmes.toLocaleString()} listings.`];
    const chans = (n) => `${n.toLocaleString()} channel${n === 1 ? '' : 's'}`;
    if (data.byName || data.byGuess) {
      bits.push(`${chans(data.byId)} matched on the id the provider gave `
        + `${data.byId === 1 ? 'it' : 'them'}, ${data.byName.toLocaleString()} on `
        + `${data.byName === 1 ? 'its' : 'their'} name alone — a name match is a `
        + 'good guess, not a promise.');
    }
    if (data.byGuess) {
      bits.push(`${chans(data.byGuess)} matched only after trimming the name — `
        + 'a network said twice, a feed marking, a call sign. Worth a spot-check.');
    }
    if (data.lastRun?.truncated) bits.push('One feed was too big to read to the end.');
    if (data.at) bits.push(`Last read ${whenWords(data.at)}.`);
    return { text: bits.join(' '), bad: false };
  },

  /**
   * Put the two sides next to each other.
   *
   * Our channel reduces to a key; the guides' channels reduce to keys; they
   * matched or they did not. Showing the keys is the point — "yours is
   * nbceast, theirs is nbc" is a complete answer, where "no listings" is not
   * one at all.
   */
  async explain(query) {
    const out = $('#guideWhyOut');
    const q = String(query || '').trim();
    if (!q) {
      out.hidden = true;
      return;
    }
    let data;
    try {
      data = await api('/api/epg/explain', { q });
    } catch {
      return;
    }
    out.hidden = false;
    out.innerHTML = '';

    if (!data.channels.length) {
      out.append(Object.assign(document.createElement('p'), {
        className: 'gsrc-why-note',
        textContent: data.known
          ? `Nothing among your ${data.known.toLocaleString()} channels is called that.`
          : 'The box has not loaded your channel list yet — open Live TV once.',
      }));
      return;
    }

    for (const ch of data.channels) {
      const row = document.createElement('div');
      row.className = `gsrc-why-row${ch.covered ? ' is-on' : ''}`;
      const head = document.createElement('strong');
      head.textContent = ch.name;
      const said = document.createElement('span');
      said.className = 'gsrc-why-verdict';
      said.textContent = ch.covered
        ? `${ch.programmes} listings, matched on ${{
          id: 'the id the provider gave it',
          name: 'its name',
          callsign: 'its call sign',
          loose: 'a trimmed version of its name — worth checking it is the right channel',
        }[ch.matchedBy] || ch.matchedBy}`
        : 'No listings.';
      const keys = document.createElement('code');
      keys.className = 'gsrc-why-keys';
      keys.textContent = `yours: ${ch.keys.map((k) => k.key).join(' · ')}`;
      row.append(head, said, keys);

      // The other half of the answer, and the half that says what to do next.
      const near = document.createElement('div');
      near.className = 'gsrc-why-near';
      if (!data.offered) {
        near.textContent = 'The guides have not been read yet, so there is nothing '
          + 'to compare against. Press Save and fetch first.';
      } else if (ch.emptyMatch) {
        // The useful distinction: not "find another guide", but "this guide
        // has the channel and published no schedule for it".
        near.textContent = `The guides do have it — "${ch.emptyMatch}" — but published `
          + 'no schedule for it. Another feed would have to carry it instead.';
      } else if (!ch.near.length) {
        near.textContent = `Nothing like it among the ${data.offered.toLocaleString()} `
          + 'channels the guides published — a guide covering the country this '
          + 'channel is from would be the thing to add.';
      } else {
        near.textContent = `the guides have: ${ch.near
          .map((n) => `${n.name} (${n.key})`).join(', ')}`;
      }
      row.append(near);
      out.append(row);
    }
  },

  async save() {
    const button = $('#guideSave');
    // Deduplicated: a feed can be both ticked in the catalogue and typed in
    // the box below — which is what the swap button does — and sending it
    // twice means downloading and scanning it twice for the same listings.
    const urls = [...new Set([
      ...[...$('#guidePicks').querySelectorAll('input:checked')].map((b) => b.value),
      ...$('#guideExtra').value.split('\n').map((s) => s.trim()).filter(Boolean),
    ])];
    button.disabled = true;
    $('#guideNote').textContent = 'Saving…';
    try {
      const res = await fetch('/api/epg/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls, useProviderGuide: $('#guideProvider').checked }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      // The fetch runs on the box long after this returns, so the panel goes
      // straight into watching rather than claiming it is done — unless the
      // box said it could not start, in which case there is nothing to watch.
      this.dirty = false;
      this.paint({ ...data, running: !data.blocked });
      if (data.blocked) this.stop();
      else this.watch();
    } catch (err) {
      const note = $('#guideNote');
      note.textContent = err.message || 'Could not save that.';
      note.classList.add('is-bad');
      button.disabled = false;
    }
  },
};

$('#guideSave').addEventListener('click', () => guideSources.save());
$('#guideBrowse').addEventListener('click', () => guideSources.browse());

/* The "why has this got no listings" box. Typed into, so it waits for a
 * pause rather than asking the box on every keystroke. */
let whyTimer = null;
$('#guideProvider').addEventListener('change', () => { guideSources.dirty = true; });
$('#guideExtra').addEventListener('input', () => { guideSources.dirty = true; });
$('#guideWhy').addEventListener('input', () => {
  clearTimeout(whyTimer);
  whyTimer = setTimeout(() => guideSources.explain($('#guideWhy').value), 350);
});

/** "four minutes ago", for a timestamp the viewer should not have to subtract. */
function whenWords(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const health = {
  timer: null,
  lastBad: false,
  reportsOpen: false,

  async open() {
    $('#healthModal').hidden = false;
    this.paintPlayback();
    this.loadReports();
    guideSources.load();
    await this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.refresh();
      this.paintPlayback();
    }, 4000);
  },

  /**
   * What everyone else has sent in.
   *
   * Fetched once when the panel opens rather than on the four-second poll: the
   * rest of this panel is a live reading of the box and reports are a list
   * that changes when somebody types something, which is not every four
   * seconds. Fetched at all only for the owner, since the server will refuse
   * anyone else — and that refusal is the ordinary case, not an error worth
   * shouting about.
   */
  async loadReports() {
    const panel = $('#reportsPanel');
    const owner = reporter.isOwner();
    panel.hidden = !owner;
    this.reportsOpen = owner;
    if (!owner) return;

    const note = $('#reportsNote');
    const list = $('#reportsList');
    try {
      const data = await api('/api/reports', { profileId: profiles.current?.id || '' });
      const reports = data.reports || [];
      $('#reportsCount').textContent = reports.length ? String(reports.length) : '';
      list.innerHTML = '';
      if (!reports.length) {
        note.hidden = false;
        note.textContent = 'Nothing yet. Everyone else has a button for this where '
          + 'your pulse is.';
        return;
      }
      note.hidden = true;
      for (const r of reports) list.append(this.reportRow(r));
    } catch (err) {
      note.hidden = false;
      note.textContent = `Could not read the reports: ${err.message}`;
    }
  },

  reportRow(r) {
    const row = el('div', `report ${r.kind === 'bug' ? 'is-bug' : 'is-idea'}`);

    const head = el('div', 'report-head');
    const who = el('span', 'report-who');
    who.textContent = r.profile || 'someone';
    const tag = el('span', 'report-tag');
    tag.textContent = r.kind === 'bug' ? 'Problem' : 'Idea';
    const when = el('span', 'report-when');
    const at = new Date(r.at);
    when.textContent = Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
    head.append(tag, who, when);

    const body = el('p', 'report-body');
    body.textContent = r.message;

    row.append(head, body);

    const meta = el('p', 'report-meta');
    const bits = [`v${r.version || '?'}`, r.page || ''].filter(Boolean);
    if (r.contact) bits.push(`reach them: ${r.contact}`);
    meta.textContent = bits.join(' · ');
    row.append(meta);

    if (r.context) {
      const box = el('details', 'report-context');
      const sum = el('summary');
      sum.textContent = 'What was on screen';
      const pre = el('pre');
      pre.textContent = r.context;
      box.append(sum, pre);
      row.append(box);
    }
    return row;
  },

  /**
   * The playback report, refreshed alongside the rest of the panel.
   *
   * Live while something is playing, and otherwise the last snapshot the
   * watchdog banked — you cannot reach this panel from inside the player, so
   * by the time anyone opens it the playback being complained about has
   * usually just been closed. Hidden entirely when nothing has played, since
   * an empty block only raises questions.
   */
  paintPlayback() {
    const panel = $('#playbackPanel');
    const live = !$('#playerOverlay').hidden && $('#video').currentSrc && !$('#video').paused;
    const snap = playback.last;
    panel.hidden = !live && !snap;
    if (panel.hidden) return;

    const age = live ? 0 : Math.round((Date.now() - snap.at) / 1000);
    $('#playbackAge').textContent = live
      ? 'Live — updating every second.'
      : `From the last thing that played, ${age < 60 ? `${age}s` : `${Math.round(age / 60)}m`} ago.`;
    $('#playbackVerdict').textContent = live ? playback.verdict() : snap.verdict;
    $('#playbackReport').textContent = live ? playback.reportWithWorst() : snap.report;
  },

  close() {
    $('#healthModal').hidden = true;
    clearInterval(this.timer);
    this.timer = null;
    guideSources.stop();
  },

  async refresh() {
    let data;
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      $('#healthBody').innerHTML =
        `<p class="health-note">Can't reach the server — ${escapeHtml(err.message)}</p>`;
      $('#healthLive').classList.remove('is-beating');
      return;
    }
    $('#healthBody').innerHTML = this.render(data);
    const live = $('#healthLive');
    live.classList.add('is-beating');
    // A one-frame flicker each poll, so it's obvious the numbers are current.
    setTimeout(() => live.classList.remove('is-beating'), 600);
    this.markBadge(data);
  },

  /** Surface trouble on the header button so it's seen without opening. */
  markBadge(data) {
    const dot = $('#healthDot');
    const bad = data.disk.low || data.network.level === 'poor' || (data.power && !data.power.ok);
    const warn = data.network.level === 'fair' || (data.cpu.tempC || 0) >= 70 ||
      (data.disk.total && data.disk.free / data.disk.total < 0.1);
    dot.hidden = !(bad || warn);
    dot.classList.toggle('warn', !bad && warn);
  },

  render(d) {
    const rows = [];

    /* ---- storage: the reason this panel exists ---- */
    if (d.disk.free != null) {
      const total = d.disk.total || 0;
      const usedPct = total ? Math.min(100, ((total - d.disk.free) / total) * 100) : 0;
      const tone = d.disk.low ? 'bad' : d.disk.free < d.disk.reserve * 3 ? 'warn' : 'ok';
      rows.push(row('Storage', {
        value: `${gb(d.disk.free)} free`,
        sub: total ? `${gb(total - d.disk.free)} used of ${gb(total)}` : '',
        pill: [tone, tone === 'ok' ? 'Healthy' : tone === 'warn' ? 'Getting full' : 'Full'],
        bar: [tone, usedPct],
      }));
    }

    /* ---- the archive drive, when there is one ---- */
    if (d.archive) {
      if (!d.archive.mounted) {
        rows.push(row('Archive drive', {
          value: 'Not plugged in',
          sub: 'The library still browses; nothing will play until it is back.',
          pill: ['warn', 'Unplugged'],
        }));
      } else if (d.archive.free != null) {
        const total = d.archive.total || 0;
        const usedPct = total ? Math.min(100, ((total - d.archive.free) / total) * 100) : 0;
        rows.push(row('Archive drive', {
          value: `${gb(d.archive.free)} free`,
          sub: total ? `${gb(total - d.archive.free)} used of ${gb(total)}` : '',
          pill: ['ok', 'Mounted'],
          bar: ['ok', usedPct],
        }));
      } else {
        rows.push(row('Archive drive', { value: 'Mounted', pill: ['ok', 'Mounted'] }));
      }
    }

    /* ---- network strength ---- */
    const n = d.network;
    if (n.kind === 'wifi') {
      const tone = n.level === 'good' ? 'ok' : n.level === 'fair' ? 'warn' : 'bad';
      const bits = [`${n.dbm} dBm`];
      if (n.bitrateMbps) bits.push(`${n.bitrateMbps} Mbit/s link`);
      rows.push(row('Wi-Fi', {
        value: n.ssid || n.iface,
        sub: bits.join(' · '),
        pill: [tone, n.level === 'good' ? 'Strong' : n.level === 'fair' ? 'Fair' : 'Weak'],
      }));
    } else {
      rows.push(row('Network', { value: 'Wired', sub: 'Ethernet — no signal to worry about', pill: ['ok', 'Strong'] }));
    }

    /* ---- provider throughput: what actually decides if a stream plays ---- */
    const p = d.provider;
    if (p.bytesPerSec != null) {
      const ratio = p.bytesPerSec / p.needBytesPerSec;
      const tone = ratio >= 1.6 ? 'ok' : ratio >= 1.05 ? 'warn' : 'bad';
      rows.push(row('Provider', {
        value: `${(p.bytesPerSec / 1048576).toFixed(2)} MB/s`,
        sub: `${ratio.toFixed(1)}× what a 1080p stream needs`,
        pill: [tone, tone === 'ok' ? 'Comfortable' : tone === 'warn' ? 'Marginal' : 'Too slow'],
      }));
    } else {
      rows.push(row('Provider', {
        value: p.streaming ? 'Streaming' : 'Idle',
        sub: p.streaming ? 'Measuring…' : 'Speed shows while something is playing or downloading',
        pill: [p.streaming ? 'ok' : 'neutral', p.streaming ? 'Active' : 'Idle'],
      }));
    }

    /* ---- the Pi itself ---- */
    if (d.cpu.tempC != null) {
      const t = d.cpu.tempC;
      const tone = t < 65 ? 'ok' : t < 78 ? 'warn' : 'bad';
      rows.push(row('CPU', {
        value: `${t.toFixed(0)}°C`,
        sub: `load ${d.cpu.load1.toFixed(2)} across ${d.cpu.cores} core${d.cpu.cores === 1 ? '' : 's'}`,
        pill: [tone, tone === 'ok' ? 'Cool' : tone === 'warn' ? 'Warm' : 'Hot'],
      }));
    } else {
      rows.push(row('CPU', {
        value: `load ${d.cpu.load1.toFixed(2)}`,
        sub: `${d.cpu.cores} core${d.cpu.cores === 1 ? '' : 's'}`,
      }));
    }

    const m = d.memory;
    const memPct = m.total ? (m.used / m.total) * 100 : 0;
    rows.push(row('Memory', {
      value: `${gb(m.available)} free`,
      sub: `${memPct.toFixed(0)}% of ${gb(m.total)} in use`,
      pill: memPct > 92 ? ['bad', 'Tight'] : memPct > 80 ? ['warn', 'Busy'] : ['ok', 'Fine'],
    }));

    /* ---- downloads ---- */
    const dl = d.downloads;
    const parts = [`${dl.stored} stored`];
    if (dl.queued) parts.push(`${dl.queued} queued`);
    if (dl.failed) parts.push(`${dl.failed} failed`);
    rows.push(row('Downloads', {
      value: dl.active ? dl.active.name : parts.join(' · '),
      sub: dl.active && dl.active.total
        ? `${((dl.active.bytes / dl.active.total) * 100).toFixed(0)}% — ${parts.join(' · ')}`
        : (dl.active ? parts.join(' · ') : ''),
      pill: dl.active ? ['ok', 'Downloading'] : null,
    }));

    rows.push(row('Uptime', {
      value: duration(d.uptime.host),
      sub: `portal running ${duration(d.uptime.server)}`,
    }));

    /* ---- where a pushed update has got to ----
     *
     * The box updates itself, which means the gap between a change being
     * published and it arriving here was unaccounted for: it could be
     * seconds, or half an hour of deliberate waiting for a film to end, or
     * the updater having quietly stopped — and all three looked identical
     * from the sofa. This row is the difference. */
    const u = d.update;
    if (u) {
      const mins = (ms) => Math.max(0, Math.round(ms / 60000));
      const since = mins(Date.now() - u.at);
      const landed = u.appliedAt
        ? `last update landed ${duration((Date.now() - u.appliedAt) / 1000)} ago`
        : '';
      if (Date.now() - u.at > 10 * 60 * 1000) {
        // It runs every two minutes; ten quiet ones means it is not running.
        rows.push(row('Updates', {
          value: 'Updater is not checking in',
          sub: `last heard from it ${since} min ago — new versions will not arrive`,
          pill: ['bad', 'Stalled'],
        }));
      } else if (u.state === 'blocked') {
        rows.push(row('Updates', {
          value: 'Blocked',
          sub: 'the box cannot reach the repository — nothing new can arrive',
          pill: ['bad', 'Blocked'],
        }));
      } else if (u.state === 'held') {
        const waited = u.heldSince ? mins(Date.now() - u.heldSince) : 0;
        rows.push(row('Updates', {
          value: `A new version is waiting${waited ? ` — ${waited} min` : ''}`,
          sub: 'held back while somebody is watching; it installs itself once the box is idle',
          pill: ['warn', 'Waiting'],
        }));
      } else {
        rows.push(row('Updates', {
          value: u.state === 'applied' ? 'Just updated' : 'Up to date',
          sub: [u.local ? `version ${u.local}` : '', landed].filter(Boolean).join(' · '),
          pill: ['ok', 'Current'],
        }));
      }
    }

    /* ---- power: reads like a network fault, isn't one ---- */
    let note = '';
    if (d.power && !d.power.ok) {
      note = `<p class="health-note"><strong>Power warning:</strong> ${escapeHtml(d.power.flags.join(', '))}. ` +
        `An under-powered supply causes stalls and I/O errors that look exactly like a bad connection.</p>`;
    } else if (d.disk.low) {
      note = `<p class="health-note"><strong>Disk is critically low.</strong> ` +
        `New downloads will be refused until you free space — that guard is what stops a full card ` +
        `corrupting your profile and download list.</p>`;
    }

    return rows.join('') + note;

    function row(key, { value, sub = '', pill = null, bar = null }) {
      const pillHtml = pill && pill[0] !== 'neutral'
        ? `<span class="health-pill ${pill[0]}">${escapeHtml(pill[1])}</span>`
        : pill ? `<span class="health-pill">${escapeHtml(pill[1])}</span>` : '<span></span>';
      const barHtml = bar
        ? `<div class="health-bar ${bar[0]}"><i style="width:${bar[1].toFixed(1)}%"></i></div>`
        : '';
      return `<div class="health-row">
        <span class="health-key">${escapeHtml(key)}</span>
        <span class="health-val">${escapeHtml(String(value))}${sub ? `<span class="health-sub">${escapeHtml(sub)}</span>` : ''}</span>
        ${pillHtml}
        ${barHtml}
      </div>`;
    }

    function gb(bytes) {
      if (bytes == null) return '—';
      if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
      return `${Math.round(bytes / 1048576)} MB`;
    }

    function duration(secs) {
      const d2 = Math.floor(secs / 86400);
      const h = Math.floor((secs % 86400) / 3600);
      const mi = Math.floor((secs % 3600) / 60);
      if (d2) return `${d2}d ${h}h`;
      if (h) return `${h}h ${mi}m`;
      return `${mi}m`;
    }
  },
};

/* Quietly check every minute so a filling disk shows up as a dot on the
   button before it becomes the reason a download failed. */
async function watchHealthBadge() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) health.markBadge(await res.json());
  } catch {
    /* offline — the panel says so if opened */
  }
}
watchHealthBadge();
setInterval(watchHealthBadge, 60000);

$('#healthBtn').addEventListener('click', () => health.open());
$('#healthClose').addEventListener('click', () => health.close());

/* --------------------------------------------------- the suggestion box ---
 *
 * The pulse in the corner is a diagnostic for whoever runs the box. For
 * everyone else the useful thing in that corner is a way to say something is
 * broken — so that is what is there instead, and only Hunter sees the pulse.
 *
 * What is sent lands on the box, in the Reports section of Pi health, and
 * nowhere else. There is nothing to configure and nothing that can be
 * unreachable — the thing that has to work is that Hunter sees it.
 */
const reporter = {
  kind: 'bug',

  /**
   * Whose box this is. Everyone else gets the suggestion box.
   *
   * The server decides and sends the answer with the profile's prefs, so there
   * is one place that knows rather than two that could disagree. The name check
   * is only the fallback for the moment before those have arrived.
   */
  isOwner() {
    if (typeof profiles.data?.owner === 'boolean') return profiles.data.owner;
    return String(profiles.current?.name || '').trim().toLowerCase() === 'hunter';
  },

  /** Which of the two buttons belongs in the header for whoever is watching. */
  applyButtons() {
    const owner = this.isOwner();
    $('#healthBtn').hidden = !owner;
    $('#reportBtn').hidden = owner;
    // The archive is Hunter's drive, so its tab exists only on the owner
    // profile. Inline style rather than the hidden attribute, because the tab
    // bar styles its links with a display of their own and would win.
    document.querySelectorAll('a[data-tab="archive"]').forEach((a) => {
      a.style.display = owner ? '' : 'none';
    });
    // Same drive, same gate, inside multi-view's picker.
    document.querySelectorAll('#mvSourceSeg button[data-owner-only]').forEach((b) => {
      b.style.display = owner ? '' : 'none';
    });
  },

  /**
   * What is going along with the message.
   *
   * Read from the same places the playback report comes from, because a bug
   * report that says "it broke" and a bug report that carries the last thing
   * the watchdog saw are worth very different amounts. Shown in the form
   * before it is sent: nothing should be attached to somebody's words that
   * they cannot read first.
   */
  context() {
    const parts = [];
    const snap = playback.last;
    const live = !$('#playerOverlay').hidden && $('#video').currentSrc;
    if (live) {
      parts.push('— playing now —', playback.reportWithWorst());
    } else if (snap) {
      const age = Math.round((Date.now() - snap.at) / 1000);
      parts.push(`— the last thing that played, ${age}s ago —`, snap.verdict, '', snap.report);
    }
    return parts.join('\n').trim();
  },

  open({ kind = 'bug' } = {}) {
    this.setKind(kind);
    $('#reportMessage').value = '';
    $('#reportContact').value = '';
    $('#reportError').hidden = true;
    $('#reportSubmit').disabled = false;

    const ctx = this.context();
    $('#reportContextBox').hidden = !ctx;
    $('#reportContext').textContent = ctx;
    $('#reportContextHint').textContent = ctx
      ? '— the last playback report, with the addresses stripped out'
      : '';

    $('#reportLead').textContent = this.isOwner()
      ? 'Lands in the Reports section of this panel.'
      : 'It goes to Hunter, and shows up on his Pi health screen.';

    $('#reportModal').hidden = false;
    $('#reportMessage').focus();
  },

  close() {
    $('#reportModal').hidden = true;
  },

  setKind(kind) {
    this.kind = kind === 'idea' ? 'idea' : 'bug';
    for (const b of document.querySelectorAll('#reportKind button')) {
      b.classList.toggle('is-on', b.dataset.kind === this.kind);
    }
    $('#reportTitle').textContent = this.kind === 'bug' ? 'Report a problem' : 'Suggest something';
    $('#reportPrompt').textContent = this.kind === 'bug'
      ? 'What happened?'
      : 'What should it do?';
    $('#reportMessage').placeholder = this.kind === 'bug'
      ? 'What you were watching, what it did, and what you expected instead.'
      : 'Anything. Small things count.';
  },

  async send() {
    const message = $('#reportMessage').value.trim();
    const err = $('#reportError');
    if (!message) {
      err.hidden = false;
      err.textContent = 'Say something about it first.';
      return;
    }
    $('#reportSubmit').disabled = true;
    err.hidden = true;

    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: profiles.current?.id || '',
          profileName: profiles.current?.name || '',
          kind: this.kind,
          message,
          contact: $('#reportContact').value.trim(),
          context: this.context(),
          page: location.hash || '#/home',
          version: VERSION,
          device: navigator.userAgent,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);

      this.close();
      toast('Sent — Hunter will see it in Pi health.');
      if (health.reportsOpen) health.loadReports();
    } catch (e) {
      err.hidden = false;
      err.textContent = `Could not send it: ${e.message}`;
      $('#reportSubmit').disabled = false;
    }
  },
};

$('#reportBtn').addEventListener('click', () => reporter.open());
$('#reportCancel').addEventListener('click', () => reporter.close());
$('#reportsSend').addEventListener('click', () => { health.close(); reporter.open(); });
for (const b of document.querySelectorAll('#reportKind button')) {
  b.addEventListener('click', () => reporter.setKind(b.dataset.kind));
}
$('#reportForm').addEventListener('submit', (event) => {
  event.preventDefault();
  reporter.send();
});

/**
 * The one-time explanation.
 *
 * A button that changed under somebody is worth a sentence, and the people who
 * most need to know there is now a way to report a problem are exactly the
 * ones who were here before there was. Shown once per profile and written down
 * on the profile, so it does not come back on the next device.
 *
 * A new profile does not see this: the tour explains the same button while
 * pointing at it, which is better, and two explanations of one button is one
 * too many.
 */
const notice = {
  show({ title, body, key }) {
    $('#noticeTitle').textContent = title;
    $('#noticeBody').textContent = body;
    $('#noticeModal').hidden = false;
    this.key = key;
  },

  async close() {
    $('#noticeModal').hidden = true;
    if (this.key && profiles.current && !profiles.data[this.key]) {
      profiles.data[this.key] = true;
      await profiles.save();
    }
    this.key = null;
  },

  /** Nothing to say to a profile that has not finished the tour — it is next. */
  maybeShow() {
    if (!profiles.current || !profiles.data) return false;
    if (profiles.data.reportNoticeSeen) return false;
    if (!profiles.data.tourDone) return false;

    this.show(reporter.isOwner()
      ? {
        key: 'reportNoticeSeen',
        title: 'People can write to you now',
        body: 'Everyone else has a report button where your pulse is. What they '
          + 'send turns up in this panel, under Reports, alongside everything '
          + 'else the box is telling you. You can send one from there too.',
      }
      : {
        key: 'reportNoticeSeen',
        title: 'Tell Hunter when it breaks',
        body: 'The pulse in the corner is gone — it was only ever useful to '
          + 'whoever runs the box. In its place is a report button: press it '
          + 'when something is broken, or when you have thought of something '
          + 'this should do. It goes straight to Hunter, and it brings the last '
          + 'playback report with it so he does not have to ask what happened.',
      });
    return true;
  },
};

$('#noticeClose').addEventListener('click', () => notice.close());
/* --------------------------------------------------- connection test ---
 *
 * The health panel reports what the Pi sees of its own link. From outside the
 * house that is not the number that matters — what matters is what reaches the
 * device you are watching on, and only that device can measure it.
 *
 * Roughly what a stream needs, in Mbit/s. The server works in bytes per second
 * for the same judgement (needBytesPerSec); this is the same call in the units
 * a speed reads in.
 */
const SPEED_TIERS = [
  [25, 'ok', 'Plenty — anything in the library will play.'],
  [10, 'ok', 'Fine for 1080p.'],
  [4, 'warn', 'Marginal. High-bitrate films will stall to buffer.'],
  [0, 'bad', 'Too slow to stream. This is why playback stops after a second.'],
];

$('#speedTest').addEventListener('click', async () => {
  const btn = $('#speedTest');
  const out = $('#speedResult');
  const label = btn.textContent;

  btn.disabled = true;
  btn.textContent = 'Measuring…';
  out.hidden = false;
  out.textContent = 'Pulling a few MB from the box…';

  try {
    const started = performance.now();
    const res = await fetch(`/api/speedtest?bytes=${8 * 1024 * 1024}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let got = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        // A link slow enough to need the full sample has already answered the
        // question; a partial read gives the same rate without the wait.
        if (performance.now() - started > 12000) {
          await reader.cancel();
          break;
        }
      }
    } else {
      got = (await res.arrayBuffer()).byteLength;
    }

    const seconds = (performance.now() - started) / 1000;
    const mbit = (got * 8) / seconds / 1e6;
    const [, tone, verdict] = SPEED_TIERS.find(([floor]) => mbit >= floor);

    out.className = `health-note conn-${tone}`;
    out.textContent =
      `${mbit.toFixed(1)} Mbit/s (${(got / 1048576).toFixed(1)} MB in ${seconds.toFixed(1)}s). ${verdict}`;
  } catch (err) {
    out.className = 'health-note conn-bad';
    out.textContent = `Couldn't measure it — ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#copyPlayback').addEventListener('click', async () => {
  // Whatever is on screen, which may be a snapshot from a session that has
  // already ended — regenerating it here would copy the empty state instead.
  const text = `${$('#playbackVerdict').textContent}\n\n${$('#playbackReport').textContent}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Report copied — paste it into the chat.');
  } catch {
    // Clipboard access needs a secure context, and this is served over plain
    // http on the tailnet. Select it instead so it can be copied by hand.
    const pre = $('#playbackReport');
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Selected the report — copy it with your keyboard or a long press.');
  }
});

$('#healthModal').addEventListener('click', (e) => {
  if (e.target.id === 'healthModal') health.close();
});

/* ----------------------------------------------------------- walkthrough ---
 *
 * A one-time tour for a profile that has not been round the place yet.
 *
 * Steps name a target by selector and are dropped if that target is not on
 * screen — the tab bar exists only on a phone, the nav links only off it — so
 * one list serves both layouts without either being walked past something it
 * does not have.
 *
 * The copy is rude on purpose. This is a private box shared with people who
 * would find a polite product tour more offensive than the swearing.
 */
const TOUR = [
  {
    target: '.brand',
    title: 'Start here, dipshit',
    body: 'The bison is Home. Continue watching, your favourite channels, your '
      + 'favourite films — all on one page. Click him whenever you get lost, '
      + 'which will be constantly.',
  },
  {
    target: '.nav a[href="#/live"], .tabbar a[href="#/live"]',
    title: 'Live TV',
    body: 'Hundreds of channels, all of them showing something you do not want. '
      + 'You get categories first, then the actual channels — pin the ones you '
      + 'use so you are not scrolling past forty religious networks every time.',
  },
  {
    target: '.nav a[href="#/movies"], .tabbar a[href="#/movies"]',
    title: 'Movies',
    body: 'Rows of films. Click one and you get its own page — poster, plot, '
      + 'runtime, and a big Play button. Hover a poster and a little bin '
      + 'appears: that hides it forever, which is the correct response to most '
      + 'of them.',
  },
  {
    target: '.nav a[href="#/series"], .tabbar a[href="#/series"]',
    title: 'Series',
    body: 'Same idea, with seasons across the top and episodes down the side. '
      + 'When an episode is nearly done a Next Episode button turns up so you '
      + 'do not have to move a muscle. You are welcome.',
  },
  {
    target: '#searchInput, .search',
    title: 'Search, and lower your expectations',
    body: 'Type a couple of words and hope. The provider names things like a '
      + 'man typing with his elbows, so "the batman 2022 4K HDR REMUX" is a '
      + 'real title and "Batman" might not find it.',
  },
  {
    target: '.nav a[href="#/downloads"], .tabbar a[href="#/downloads"]',
    title: 'Downloads',
    copy: 'downloads',   // the allowance depends on who is watching
  },
  {
    target: '#profileChip',
    title: 'That is you',
    body: 'Your favourites, your history, your embarrassing taste — kept apart '
      + 'from everyone else\'s. Click it to switch to someone with better '
      + 'judgement.',
  },
  {
    // Whichever of the two is actually in the corner for this profile. The
    // step is dropped entirely if neither is, which is what `visible` is for.
    target: '#reportBtn:not([hidden]), #healthBtn:not([hidden])',
    title: 'When it inevitably breaks',
    copy: 'report',      // so does which button is in that corner
  },
];

/** What the note says, wherever this layout happens to keep the pins. */
const LIVE_TOUR_BODY = 'Every channel worth a shit is pinned up here already — '
  + 'the networks, the PPV feeds, all of it — so you are not hunting through '
  + 'four hundred categories to find the game.';

/**
 * The one note the opening tour does not carry, because it is about something
 * that is not on screen when the tour runs. Shown the first time a profile
 * opens Live TV, where the starter pins it is explaining are visible.
 */
const LIVE_TOUR = [
  {
    // Every pinned tile, boxed together — one tile with the others spilling
    // out beside it would not read as "this row is yours".
    target: '#grid .cat-card.is-pinned',
    all: true,
    title: 'These are Hunter\'s, now they\'re yours',
    body: `${LIVE_TOUR_BODY} Hit the pin on any category in the sidebar to add `
      + 'your own, drag them to reorder, and pin one off again when you realise '
      + 'you are never going to watch curling.',
  },
];

/**
 * The same note on the desktop portal, which keeps its pins somewhere else.
 *
 * A step that points at something has to point at the thing it is describing.
 * There the pins ARE the chip bar, they are dragged in the bar itself, and
 * there is no sidebar left to send anybody to.
 */
const LIVE_TOUR_DESK = [
  {
    target: '.catchip.pinned',
    all: true,
    title: 'These are Hunter\'s, now they\'re yours',
    body: `${LIVE_TOUR_BODY} They lead the bar in your order — drag them right `
      + 'there to rearrange, use the pin on any row heading to add your own, and '
      + 'pin one off again when you realise you are never going to watch curling.',
  },
];

/**
 * What every profile starts with pinned in Live TV — Hunter's own set, so
 * nobody's first visit is four hundred categories deep in religious networks
 * with the game somewhere in the middle.
 *
 * Named rather than keyed by id because ids are the provider's and mean
 * nothing here; the names are matched against whatever the provider actually
 * sends, once, when a profile first opens Live TV. A category that has since
 * been renamed simply does not match and is skipped — a starter pin is a
 * courtesy, not something worth failing over.
 */
const STARTER_LIVE_PINS = [
  'US| NFL PPV',
  'US| NCAAF PPV',
  'US| MLB PPV',
  'US| NCAAB PPV',
  'US| NBC ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| CBS ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| ABC ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| FOX ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| UFC PPV',
  'US| DAZN PPV',
  'US| NETFLIX PPV',
  'US| BALLY SPORTS PPV',
  'US| NBA TEAM PPV',
  'US| SOCCER PPV',
  'US| BTN+ PPV',
  'US| APPLE TV F1 PPV',
  'US| NHL PPV',
  'US| MLB TEAM PPV',
  'US| PPV EVENT ⁽ᴮᴷ⁾',
  'US| PPV EVENT',
  'US| THE MASTERS PPV',
  'US| PARAMOUNT+ ORIGINAL ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| MOVIES ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| PEACOCK ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| DIREC TV ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
  'US| SPECTRUM NETWORK ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ',
];

/**
 * A category name reduced to the part that identifies it. The provider dresses
 * every name in quality tags built from unicode superscripts — ᴴᴰ, ᴿᴬᵂ, ⁶⁰ᶠᵖˢ —
 * which are letters and digits to a human and nothing to `a-z0-9`. Stripping
 * them is the point: a channel is the same channel when the tag changes.
 */
function catKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Lay down the starter pins, once, the first time a profile reaches Live TV.
 *
 * Done here rather than when the profile is created because ids only exist
 * once the provider's categories have been fetched, and that is the first
 * moment they have been. Returns whether anything was pinned, so the note that
 * explains them is not shown over an empty row.
 */
function seedLivePins(categories) {
  if (!profiles.current || profiles.data.livePinsSeeded) return false;

  // Matched on the full name first, and only then on the stripped one. This
  // list contains both "US| PPV EVENT" and "US| PPV EVENT ⁽ᴮᴷ⁾", which strip
  // to the same thing — going stripped-first pinned the same category twice
  // and lost the other one entirely.
  const byName = new Map();
  const byKey = new Map();
  for (const cat of categories) {
    const id = String(cat.id);
    const name = String(cat.name || '').trim().toLowerCase();
    if (!byName.has(name)) byName.set(name, id);
    const key = catKey(cat.name);
    byKey.set(key, byKey.has(key) ? null : id);   // null marks an ambiguous key
  }

  const ids = [];
  const taken = new Set();
  for (const wanted of STARTER_LIVE_PINS) {
    // The loose match only when it picks out exactly one category. Guessing
    // between two that differ by a quality tag gets it wrong half the time.
    const id = byName.get(wanted.trim().toLowerCase()) || byKey.get(catKey(wanted));
    if (!id || taken.has(id)) continue;
    taken.add(id);
    ids.push(id);
  }

  // Marked done either way. A provider that renamed everything is not going to
  // have renamed it back by the next visit, and re-running this on every load
  // would fight anyone who unpinned what it left.
  profiles.data.livePinsSeeded = true;
  if (!ids.length) {
    profiles.save();
    return false;
  }

  // Ahead of anything the profile pinned itself, which for a new one is
  // nothing — but a profile seeded late should not have its own pins buried.
  const own = profiles.pinOrder('live').filter((id) => !ids.includes(id));
  profiles.setPinOrder('live', [...ids, ...own]);   // saves
  return true;
}

const tour = {
  steps: [],
  at: 0,
  doneKey: 'tourDone',

  /**
   * Only the steps whose target is actually on this screen — and for the ones
   * that name both a desktop and a phone control, the copy of it that is
   * showing. querySelector would hand back the desktop nav link on a phone,
   * where it is hidden, and the step would vanish.
   *
   * A step marked `all` keeps every match rather than the first, so the
   * highlight can box a whole row of them together.
   */
  visible(list) {
    return list.map((step) => {
      const shown = [...document.querySelectorAll(step.target)]
        .filter((node) => node.getClientRects().length);
      return { ...step, node: shown[0], nodes: step.all ? shown : shown.slice(0, 1) };
    }).filter((step) => step.node);
  },

  start(list = TOUR, doneKey = 'tourDone') {
    this.steps = this.visible(list);
    if (!this.steps.length) return;
    this.doneKey = doneKey;
    this.at = 0;
    $('#tour').hidden = false;
    this.paint();
    window.addEventListener('resize', this.reposition);
  },

  /** Written down so the tour does not come back on the next device. */
  async finish() {
    $('#tour').hidden = true;
    window.removeEventListener('resize', this.reposition);
    if (profiles.current && !profiles.data[this.doneKey]) {
      profiles.data[this.doneKey] = true;
      await profiles.save();
    }
  },

  next() {
    if (this.at >= this.steps.length - 1) return this.finish();
    this.at += 1;
    this.paint();
  },

  /** One rectangle around everything the step points at. */
  boxFor(step) {
    const rects = step.nodes.map((node) => node.getBoundingClientRect());
    const box = {
      top: Math.min(...rects.map((r) => r.top)),
      left: Math.min(...rects.map((r) => r.left)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      right: Math.max(...rects.map((r) => r.right)),
    };
    // A row of tiles that wraps can span most of the page, and a hole that
    // large stops being a highlight. Keep the rows that fit and drop the rest.
    const cap = window.innerHeight * 0.55;
    if (box.bottom - box.top > cap) box.bottom = box.top + cap;
    return { ...box, width: box.right - box.left, height: box.bottom - box.top };
  },

  paint() {
    const step = this.steps[this.at];
    const box = this.boxFor(step);
    const pad = 8;
    const hole = $('#tourHole');
    hole.style.top = `${box.top - pad}px`;
    hole.style.left = `${box.left - pad}px`;
    hole.style.width = `${box.width + pad * 2}px`;
    hole.style.height = `${box.height + pad * 2}px`;

    $('#tourTitle').textContent = step.title;
    $('#tourBody').textContent = step.body || TOUR_COPY[step.copy]?.() || '';
    const left = this.steps.length - this.at - 1;
    $('#tourLeft').textContent = left
      ? `${left} more ${left === 1 ? 'thing' : 'things'}`
      : 'last one';
    $('#tourNext').textContent = left ? 'Next' : 'Got it';

    this.place(box);
  },

  /**
   * Put the card beside the highlight, on whichever side it fits. Clamped to
   * the viewport at the end regardless: a card half off the screen is worse
   * than one slightly overlapping what it points at.
   */
  place(box) {
    const card = $('#tourCard');
    const gap = 14;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let top = box.bottom + gap;
    if (top + h > window.innerHeight - 8) top = box.top - h - gap;
    let left = box.left + box.width / 2 - w / 2;
    left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
    top = Math.max(12, Math.min(window.innerHeight - h - 12, top));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  },

  reposition: () => {
    if (!$('#tour').hidden) tour.paint();
  },
};

/**
 * Steps whose words are not the same for everybody. Named rather than left as
 * an empty body: there are two of them now, and "whichever step has no body"
 * stopped being an identity the moment there was a second one.
 */
const TOUR_COPY = {
  downloads: () => tourDownloadCopy(),
  report: () => tourReportCopy(),
};

/** The Downloads step, which reads differently depending on the allowance. */
function tourDownloadCopy() {
  const limit = profiles.data?.downloadLimit;
  const capped = Number.isFinite(limit) && limit > 0;
  return 'Pull a film or an episode onto the Pi and it plays instantly, with no '
    + 'waiting and without touching the provider — so two of you can watch the '
    + 'same thing at once. To have it when there is no wifi at all, press Save '
    + 'to device on it afterwards: that is the copy that lives on your phone. '
    + (capped
      ? `You get ${(limit / 1073741824).toFixed(0)}GB, so do not download an entire `
        + 'season of something you will never watch. Delete things with the X on '
        + 'the poster.'
      : 'No limit for you, obviously. Everyone else gets 3GB.');
}

/** The corner button, which is not the same button for everybody. */
function tourReportCopy() {
  return reporter.isOwner()
    ? 'The pulse shows what the Pi is doing — memory, temperature, what is '
      + 'converting. Everyone else has a report button here instead, and what '
      + 'they send turns up in this panel under Reports.'
    : 'Press this when something breaks, or when you have thought of something '
      + 'this should do. It goes straight to Hunter and it takes the last '
      + 'playback report with it, so he does not have to ask you what happened. '
      + 'Ideas count too — the box is not finished.';
}

$('#tourNext').addEventListener('click', () => tour.next());
$('#tourSkip').addEventListener('click', () => tour.finish());

/* ---------------------------------------------------------------- loader */

/* The full-screen overlay, and the projector-lamp sequence that plays over it
 * the first time it comes up.
 *
 * The sequence belongs to STARTING UP, and it runs once. This same overlay is
 * also what a seek, a prebuffer and a film-details fetch put up, and replaying
 * a lamp warming up and a wordmark wiping in over four seconds every time one
 * of those happens would make a three-hundred-millisecond wait feel like a
 * reboot — and would hold the hairline off screen for longer than the wait it
 * is reporting. So the first show() is the boot and everything after it gets
 * the same screen already at rest.
 *
 * This used to live in desktop.js, wrapping these methods from outside and only
 * while the desktop layout was on. It is here now because the startup screen is
 * every device's, not the desktop's.
 */

/* How long the CSS sequence runs, end to end: the sub-line is the last thing to
   start, at 1.75s for 1.5s, and the hairline draws to 2.2s + 1.1s. A little
   over that covers both. */
const BOOT_MS = 5200;

const loader = {
  booted: false,

  show(label, detail = '') {
    $('#loaderLabel').textContent = label;
    $('#loaderDetail').textContent = detail;
    this.set(0);

    const node = $('#loader');
    node.classList.remove('is-done');
    if (!this.booted) {
      this.booted = true;
      node.classList.add('is-booting');
      /* Taken off again once it has played. Hiding the overlay and showing it
         again puts the element back into rendering, and a CSS animation still
         attached to it starts over from the top — which is how a later, quick
         wait ended up sitting behind a wordmark that had not wiped in yet. */
      setTimeout(() => node.classList.remove('is-booting'), BOOT_MS);
    }

    node.hidden = false;
  },
  set(fraction, detail) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    $('#loaderFill').style.width = `${pct}%`;
    $('#loaderPct').textContent = `${pct}%`;
    if (detail !== undefined) $('#loaderDetail').textContent = detail;
    // At a hundred per cent the hairline goes white and the dot goes green, so
    // the last thing the screen does is say it finished rather than vanishing.
    $('#loader').classList.toggle('is-done', fraction >= 1);
  },
  label(text) {
    $('#loaderLabel').textContent = text;
  },
  hide() {
    $('#loader').hidden = true;
  },
};

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Fetch JSON while reporting real transfer progress. Needs Content-Length,
 * which the server now sets explicitly on every JSON response.
 */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  const total = Number(res.headers.get('content-length') || 0);

  if (!res.body || !total) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received / total, received, total);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const data = JSON.parse(new TextDecoder().decode(merged));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * A line at the bottom of the screen, optionally with one thing to do about it.
 *
 * An action makes it stay up longer — long enough to reach, on a phone, having
 * noticed it — but it still goes away on its own. A message that waits for a
 * press is a dialog, and this is not one.
 */
function toast(message, { action = null } = {}) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('has-action', Boolean(action));
  if (action) {
    const button = el('button', 'toast-action');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      node.hidden = true;
      clearTimeout(toast._t);
      action.run();
    });
    node.append(button);
  }
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (node.hidden = true), action ? 9000 : 2600);
}

function clockFromTimestamp(ts) {
  if (!ts) return '';
  return new Date(Number(ts) * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/* ----------------------------------------------------------------- setup */

function showSetup() {
  $('#setupView').hidden = false;
  $('#siteHeader').hidden = true;
  $('#appView').hidden = true;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.querySelectorAll('.mode-panel').forEach((p) => {
      p.hidden = p.dataset.panel !== tab.dataset.mode;
    });
  });
});

$('#setupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = document.querySelector('.tab.is-active').dataset.mode;
  const form = new FormData(event.target);
  const button = $('#setupSubmit');
  const error = $('#setupError');

  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Connecting…';

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode,
        host: form.get('host'),
        username: form.get('username'),
        password: form.get('password'),
        preferredFormat: form.get('preferredFormat'),
        playlistUrl: form.get('playlistUrl'),
        epgUrl: form.get('epgUrl'),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Connection failed.');

    state.config = data;
    if (data.userInfo && data.userInfo.exp_date) {
      const expires = new Date(Number(data.userInfo.exp_date) * 1000);
      toast(`Connected. Subscription runs to ${expires.toLocaleDateString()}.`);
    } else {
      toast('Connected.');
    }
    await startApp();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Connect';
  }
});

/* ------------------------------------------------------------- providers */
/*
 * The logins this box streams with.
 *
 * Everything in this app that feels like a limit comes from one fact: the
 * provider sells a connection, and one connection plays one thing. A download
 * pauses when somebody presses play, multi-view says it may not hold four
 * cells, the credits crawler only runs when the house is quiet. A second login
 * is a second connection, and this is where they are added — so the panel
 * leads with the two numbers that follow from it: how many things can play at
 * once, and when each subscription runs out.
 *
 * The expiry is the provider's own `exp_date`, asked of the panel rather than
 * remembered from the day the login was typed in. A trial that gets extended
 * says so here without anyone re-entering anything.
 */
const providerPanel = {
  open() {
    $('#providerModal').hidden = false;
    $('#provError').hidden = true;
    this.closeForm();
    this.load();
  },

  close() {
    $('#providerModal').hidden = true;
  },

  /* `api()` is the query-string helper; these are bodies and methods, so they
     go through fetch and share one place that turns a refusal into its
     sentence. */
  async send(path, method, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },

  async load({ refresh = false } = {}) {
    const lead = $('#provLead');
    lead.textContent = refresh ? 'Asking the provider…' : 'Reading the box…';
    try {
      const data = await api('/api/providers', refresh ? { refresh: 1 } : {});
      this.paint(data);
    } catch (err) {
      lead.textContent = `Could not read the logins: ${err.message}`;
      $('#provList').innerHTML = '';
    }
  },

  paint(data) {
    const accounts = data.accounts || [];
    const capacity = Number(data.capacity) || 0;

    /* A playlist box has no logins to manage — a plain M3U has no panel to
       ask about connections or expiry. It still has the one thing this
       screen replaced, though, so that is what it gets. */
    if (!accounts.length) {
      $('#provCapacity').textContent = '';
      $('#provLead').textContent = state.config && state.config.mode === 'm3u'
        ? 'This box plays from a playlist rather than a provider login, so '
          + 'there is nothing here that expires and no second connection to add.'
        : 'No provider is connected.';
      $('#provList').innerHTML = state.config && state.config.mode === 'm3u'
        ? `<div class="prov-row">
             <div class="prov-head">
               <span class="prov-name">Playlist</span>
               <span class="spacer"></span>
               <button type="button" class="prov-remove" data-disconnect="1"
                       title="Disconnect and return to setup"
                       aria-label="Disconnect and return to setup">×</button>
             </div>
             <p class="prov-note">${escapeHtml(state.config.playlistUrl || '')}</p>
           </div>`
        : '';
      $('#provAddBtn').hidden = true;
      return;
    }

    // The offer and the form are the same control in two states.
    $('#provAddBtn').hidden = !$('#provAddForm').hidden;
    $('#provCapacity').textContent = capacity ? `${capacity} at once` : '';
    /* The sentence somebody actually came here for, in the case that is
       almost always true: one login, one stream, and here is why. */
    $('#provLead').textContent = accounts.length <= 1
      ? 'One login, so one thing plays at a time — a download pauses while '
        + 'somebody watches. Add another and that number goes up.'
      : `${accounts.length} logins, so ${capacity} streams at once. `
        + `${data.free} free right now.`;

    $('#provList').innerHTML = accounts.map((a) => this.row(a)).join('');
    /* The provider already connected, taken from the login rather than the
       config: it is the host these credentials will actually be tried on. */
    $('#provHost').textContent = accounts[0].host
      || (state.config && state.config.host) || '';
  },

  row(a) {
    const name = a.label || a.username;
    /* An expiry is a date, and a date on its own makes nobody do anything.
       The days are what says whether it matters this week. */
    let expiry = 'Expiry unknown';
    let expiryClass = 'prov-unknown';
    if (a.expired) {
      expiry = `Expired ${new Date(a.expiresAt).toLocaleDateString()}`;
      expiryClass = 'prov-bad';
    } else if (a.expiresAt) {
      const on = new Date(a.expiresAt).toLocaleDateString(undefined,
        { year: 'numeric', month: 'short', day: 'numeric' });
      const days = a.daysLeft;
      expiry = days === 0 ? `Runs out today — ${on}`
        : days === 1 ? `1 day left — ${on}`
          : `${days} days left — ${on}`;
      expiryClass = days <= 3 ? 'prov-bad' : days <= 10 ? 'prov-warn' : 'prov-ok';
    }

    const tags = [];
    if (a.trial) tags.push('<span class="prov-tag">Trial</span>');
    if (a.status && !/^active$/i.test(a.status)) {
      tags.push(`<span class="prov-tag prov-tag-bad">${escapeHtml(a.status)}</span>`);
    }

    const inUse = a.streams
      ? `${a.streams} of ${a.slots} in use by this box`
      : `${a.slots} connection${a.slots === 1 ? '' : 's'}, idle`;

    /* The provider's own count, shown only when it disagrees with ours —
       that gap is either somebody else on the login or a connection the
       panel has not let go of, and both are worth seeing. */
    const theirs = Number.isFinite(a.activeCons) && a.activeCons > a.streams
      ? `<p class="prov-note">The provider says ${a.activeCons} connection`
        + `${a.activeCons === 1 ? ' is' : 's are'} open — more than this box is `
        + 'using. Something else is on this login.</p>'
      : '';

    const trouble = a.error
      ? `<p class="prov-note prov-bad">${escapeHtml(a.error)}</p>`
      : '';

    return `
      <div class="prov-row">
        <div class="prov-head">
          <span class="prov-name">${escapeHtml(name)}</span>
          ${tags.join('')}
          <span class="spacer"></span>
          <button type="button" class="prov-remove" data-remove="${escapeHtml(a.id)}"
                  title="Remove this login" aria-label="Remove this login">×</button>
        </div>
        <p class="prov-expiry ${expiryClass}">${escapeHtml(expiry)}</p>
        <p class="prov-note">${escapeHtml(inUse)}${a.label
          ? ` · ${escapeHtml(a.username)}` : ''}</p>
        ${theirs}${trouble}
      </div>`;
  },

  openForm() {
    $('#provAddForm').hidden = false;
    $('#provAddBtn').hidden = true;
    $('#provError').hidden = true;
    $('#provUser').focus();
  },

  closeForm() {
    const form = $('#provAddForm');
    form.hidden = true;
    form.reset();
    $('#provAddBtn').hidden = false;
  },

  async add() {
    const button = $('#provSave');
    const error = $('#provError');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const data = await this.send('/api/providers', 'POST', {
        username: $('#provUser').value.trim(),
        password: $('#provPass').value,
        label: $('#provLabel').value.trim(),
      });
      this.closeForm();
      /* Re-read rather than paint what the POST answered: the panel's lead
         line counts free slots, and that is a live figure the write does not
         carry. The library itself needs nothing — a second login is a second
         connection to the same catalogue. */
      await this.load();
      toast(`Login added. ${data.capacity} things can play at once now.`);
      await refreshConfig();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Add it';
    }
  },

  /**
   * Removing the last login is the old "disconnect provider": there is no
   * library without one, so the box goes back to setup rather than sitting
   * there configured and unable to answer.
   */
  /** A playlist box has no login to remove, only the playlist itself. */
  async disconnect() {
    if (!confirm('Disconnect and return to setup?')) return;
    await fetch('/api/config', { method: 'DELETE' });
    this.close();
    health.close();
    state.library = { live: null, movies: null, series: null };
    state.config = null;
    showSetup();
  },

  async remove(id) {
    const accounts = [...document.querySelectorAll('#provList .prov-row')];
    const last = accounts.length <= 1;
    const ask = last
      ? 'That is the only login. Removing it disconnects the provider and '
        + 'returns this box to setup. Do it?'
      : 'Remove this login? The box will have one less connection.';
    if (!confirm(ask)) return;

    try {
      const data = await this.send(`/api/providers/${encodeURIComponent(id)}`, 'DELETE');
      if (data.configured === false) {
        this.close();
        health.close();
        state.library = { live: null, movies: null, series: null };
        state.config = null;
        showSetup();
        return;
      }
      await this.load();
      await refreshConfig();
    } catch (err) {
      $('#provError').textContent = err.message;
      $('#provError').hidden = false;
    }
  },
};

/** Keep the app's own idea of how much room there is in step with the panel. */
async function refreshConfig() {
  try {
    const cfg = await api('/api/config');
    if (cfg && cfg.mode) state.config = cfg;
  } catch {
    /* the panel already said what went wrong */
  }
}

$('#settingsBtn').addEventListener('click', () => providerPanel.open());
$('#provClose').addEventListener('click', () => providerPanel.close());
$('#provAddBtn').addEventListener('click', () => providerPanel.openForm());
$('#provCancel').addEventListener('click', () => providerPanel.closeForm());
$('#provAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  providerPanel.add();
});
$('#providerModal').addEventListener('click', (e) => {
  if (e.target.id === 'providerModal') providerPanel.close();
  const remove = e.target.closest('[data-remove]');
  if (remove) providerPanel.remove(remove.dataset.remove);
  if (e.target.closest('[data-disconnect]')) providerPanel.disconnect();
});

/* ------------------------------------------------------- library loading */

/** Build categories from M3U group-titles, since there's no category API. */
function groupsToCategories(items) {
  const counts = new Map();
  for (const item of items) {
    const g = item.group || 'Uncategorized';
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  return [...counts.keys()].sort().map((name) => ({ id: name, name }));
}

async function loadTab(tab, { quiet = false, all = false } = {}) {
  // `all` is the same section with the language filter set aside. It lands in
  // its own store so the two never overwrite each other — a wide search must
  // not leave every other page holding the whole provider.
  const store = all ? state.libraryAll : state.library;
  if (store[tab]) return store[tab];

  if (state.config.mode === 'm3u') {
    const buckets = await api('/api/playlist');
    const bucketFor = { live: 'live', movies: 'movie', series: 'series' };
    for (const [key, bucket] of Object.entries(bucketFor)) {
      const items = (buckets[bucket] || []).map((row, i) => ({
        kind: bucket,
        id: row.id || `${bucket}-${i}`,
        name: row.name,
        logo: row.logo,
        categoryId: row.group || 'Uncategorized',
        group: row.group,
        directUrl: row.streamUrl,
        sourceUrl: row.url,
      }));
      state.library[key] = { categories: groupsToCategories(items), items };
    }
    return state.library[tab];
  }

  // The server filters and trims before sending, so this stays small even on
  // a provider carrying six figures of titles.
  const titles = { live: 'Live TV', movies: 'Movies', series: 'Series' };
  // A cross-library search fetches what it is missing WHILE showing what it
  // already has; a full-screen panel over those results would be a step
  // backwards from the thing it is loading.
  if (!quiet) loader.show(`Loading ${titles[tab] || tab}…`);

  // Whoever shows the loading screen hides it. Leaving that to the caller left
  // the bar sitting at 100% for ever the first time a caller forgot — so it is
  // owned here, where it cannot be forgotten again.
  try {
    const url = `/api/library?tab=${encodeURIComponent(tab)}${all ? '&all=1' : ''}`;
    const data = await fetchWithProgress(url, (f, got, total) => {
      if (!quiet) loader.set(f, `${mb(got)} of ${mb(total)}`);
    });

    if (!quiet) {
      loader.label('Building the library…');
      loader.set(1, `${(data.items || []).length.toLocaleString()} titles`);
    }

    const view = {
      categories: data.categories || [],
      items: (data.items || []).map((row) => ({ ...row, logo: img(row.logo) })),
      totals: data.totals,
    };

    /* An empty answer is never written down as the library.
     *
     * The box already refuses to cache one, for the reason spelled out beside
     * its own cache: a provider that answers 200 with nothing — busy,
     * rate-limiting, between updates — is not a provider with nothing. This
     * side did write it down, and then never asked again, because the first
     * line of this function returns whatever is stored. One bad answer became
     * a session in which EVERYTHING was missing: a film sitting in downloads,
     * a channel out of Continue watching, all of them told they were no
     * longer in the library when the library was simply not there.
     *
     * Not stored means asked again on the next press, which is the whole
     * repair. */
    if (view.items.length) store[tab] = view;
    return store[tab] || view;
  } finally {
    if (!quiet) loader.hide();
  }
}

/**
 * The finished download behind a history row, as something playable.
 *
 * Built from the row itself rather than from the library, which is the whole
 * point: a file on the drive is playable whether or not the provider is
 * still selling it, and whether or not the catalogue happens to be loaded.
 * Only films — an episode still needs its show to know which episode it is.
 */
function savedCopy(row) {
  if (!row || row.kind !== 'movie') return null;
  const job = downloadJobFor('movie', row.id);
  if (!job || job.status !== 'done') return null;
  return {
    kind: 'movie',
    id: row.id,
    name: row.name || job.name || '',
    ext: job.ext || 'mp4',
    logo: row.poster || '',
    resumeKey: row.key || `movie:${row.id}`,
  };
}

/**
 * Why a title could not be found, which is two different things.
 *
 * "No longer in the library" is a strong claim — it says the provider has
 * stopped carrying something — and for a while it was being made whenever
 * the library had not loaded, which is a completely different fact with a
 * completely different remedy. Somebody told their film is gone deletes it;
 * somebody told the library did not load presses again.
 */
function missingWhy(tab) {
  const held = state.library[tab];
  if (!held || !(held.items || []).length) {
    return 'The library has not loaded yet — try that again in a moment.';
  }
  return 'That title is no longer in the library.';
}

/**
 * Find one title by id, wherever in the provider it actually lives.
 *
 * Everything that opens a title — a card, Continue watching, a multi-view
 * cell — used to look in `state.library` and nowhere else, and say "no
 * longer in the library" when it came up empty. That was true enough while
 * the only titles on screen came from the filtered catalogue. It stopped
 * being true the moment search could show foreign ones: four versions of
 * Trading Places found under All languages, every one of them refusing to
 * play, because the id was never in the short list the player was reading.
 *
 * So the search is: what is already held, filtered first; then the whole
 * catalogue, fetched if it has to be. Fetching matters for the case that
 * has nothing to do with search — a foreign film watched last night, the
 * app reloaded since, and Continue watching holding an id that only the
 * wide catalogue can explain.
 *
 * Throws if a library cannot be loaded, so callers can tell "the box did
 * not answer" from "there is no such title" — which the old code could not.
 */
async function findTitle(tab, wantId) {
  const id = String(wantId);
  const lookIn = (store) => (store[tab]?.items || []).find((i) => String(i.id) === id);

  if (!state.library[tab]) await loadTab(tab);
  const near = lookIn(state.library);
  if (near) return near;

  /* The wide catalogue is consulted only if it is ALREADY in hand.
   *
   * It used to be fetched here when it was missing, which read well and was
   * a bad idea: it turned one press on a home-screen card into a pull of the
   * provider's entire unfiltered catalogue — six figures of titles the box
   * has to assemble in memory — for a lookup that fails either way when the
   * title really is gone. On a Pi with a gigabyte to its name that is how
   * the portal ends up restarting mid-request and the next page reports the
   * library as empty.
   *
   * So it stays opt-in. Press All languages and the catalogue is loaded, and
   * from that moment everything found in it opens and plays; without that,
   * a title the filter hides is reported missing, which is the same answer
   * this gave before any of it existed and costs nothing to arrive at. */
  return lookIn(state.libraryAll) || null;
}

/* ---------------------------------------------------------- movie rows ---

 * The Movies page is built from named rows rather than one flat grid. Each row
 * pulls from one or more of the provider's own categories — `match` is tested
 * against the category name, so several map into a single shelf.
 *
 * Edit this list to change what appears and in what order.
 */
const MOVIE_ROWS = [
  { title: 'For You', special: 'recent' },
  { title: 'New Releases', match: [/^EN\s*-\s*NEW RELEASE/i], fallbackAll: true, sort: 'added' },
  { title: 'IMDB Top 250', match: [/^EN\s*-\s*IMDB TOP 250/i] },
  { title: 'Action', match: [/^EN\s*-\s*ACTION/i, /^EN\s*-\s*ADVENTURE/i] },
  { title: 'Comedy', match: [/^EN\s*-\s*COMEDY/i] },
  { title: 'Horror', match: [/^EN\s*-\s*HORROR/i, /^EN\s*-\s*THRILLER/i] },
  { title: 'Documentary', match: [/^EN\s*-\s*DOCUMENTAR/i] },
  { title: 'Concerts', match: [/^EN\s*-\s*CONCERTS/i] },
  { title: 'Christmas', match: [/^EN\s*-\s*CHRISTMAS/i] },
  { title: 'Classic', match: [/^EN\s*-\s*2020 & OLD/i, /^EN\s*-\s*WESTERNS/i] },
];

/**
 * Series shelves lean on two signals the provider gives us: category names
 * for the platform rows (NETFLIX SERIES, HBO MAX…, matched at the start so
 * foreign variants like "GERMANY NETFLIX" stay out) and per-title `genre`
 * metadata for the genre rows, since the provider's own series categories
 * carry no genre split at all.
 */
const SERIES_ROWS = [
  { title: 'For You', special: 'recent' },
  { title: 'New Releases', all: true, sort: 'added' },
  { title: 'Netflix', match: [/^NETFLIX/i] },
  { title: 'HBO Max', match: [/^HBO MAX/i] },
  { title: 'Disney+', match: [/^DISNEY\+/i] },
  { title: 'Apple TV+', match: [/^APPLE\+/i] },
  { title: 'Prime Video', match: [/^AMAZON/i] },
  { title: 'Comedy', genre: /Comedy/i },
  { title: 'Drama', genre: /Drama/i },
  { title: 'Crime', genre: /Crime|Mystery/i },
  { title: 'Sci-Fi & Fantasy', genre: /Sci-?Fi|Fantasy/i },
  { title: 'Documentary', genre: /Documentary/i, match: [/DOCU-SERIES/i] },
  { title: 'Reality', genre: /Reality/i, match: [/REALITY/i] },
  { title: 'Kids', genre: /Kids|Animation|Family/i, match: [/KIDS/i] },
];

const SHELF_DEFS = { movies: MOVIE_ROWS, series: SERIES_ROWS };

/*
 * For you.
 *
 * This row was a list of what had already been watched, which is a useful row
 * and this app has one — Continue watching, on the landing page. As a
 * RECOMMENDATION it is the opposite of the job: the question is what to put
 * on next, and the one thing that certainly answers it is something nobody
 * here has seen.
 *
 * The reckoning is on the box, in recommend.js, because it needs the credits
 * index and it needs to ask somebody else's server what an audience reached
 * for after a film — neither of which belongs in a browser. What comes back
 * is library items with a line saying why each one is there.
 *
 * Films and shows both. They are two catalogues and two sets of signals — a
 * show has a genre line and no credits, a film has credits and no genre — so
 * they are asked for separately and held separately. One shared object would
 * mean opening the series tab wiped the film row, and the answer that came
 * back last would win whichever page you were looking at.
 */
const forYou = {
  movies: { items: [], needs: '', picks: [], similar: null, at: 0, asking: null },
  series: { items: [], needs: '', picks: [], similar: null, at: 0, asking: null },
};

/** The For You state for a tab, or a blank one for a tab that has none. */
function forYouFor(tab) {
  return forYou[tab] || { items: [], needs: '', picks: [], similar: null, at: 0, asking: null };
}

/** Which half of the catalogue a tab is asking about. */
const forYouKind = (tab) => (tab === 'series' ? 'series' : 'movie');

function forYouItems(tab) {
  /* Grouped like every other row. The box recommends out of the whole
     catalogue, which holds every copy, so without this a row of twenty-four
     could be eight titles wearing three faces each. */
  return groupVariants(forYouFor(tab).items);
}

/**
 * Ask the box what to recommend.
 *
 * Asked once and then left alone: the answer moves when somebody rates
 * something or finishes a film, not while they are looking at the page. The
 * hidden titles are taken out here rather than on the box, which does not
 * know about this profile's deletions.
 *
 * Which is a different list from the one the For You bin writes: that one
 * lives on the box, is read only by the recommender, and does not hide
 * anything from anywhere else. See `notInterested` below.
 */
async function loadForYou({ force = false, tab = 'movies' } = {}) {
  const held = forYou[tab === 'series' ? 'series' : 'movies'];
  if (held.asking) return held.asking;
  if (!force && held.at && Date.now() - held.at < 5 * 60 * 1000) return null;
  if (!profiles.current) return null;
  held.asking = (async () => {
    try {
      const data = await api(`/api/profiles/${profiles.current.id}/foryou`,
        { kind: forYouKind(tab) });
      held.items = (data.items || []).filter((i) => !profiles.isDeleted(i));
      held.needs = data.needs || '';
      held.picks = (data.picks || []).filter((i) => !profiles.isDeleted(i));
      held.similar = data.similar || null;
      held.at = Date.now();
      if (state.tab === 'movies' || state.tab === 'series') render();
    } catch {
      /* A row that cannot be built is a row that is not there. Everything
         else on the page is unaffected, and it is asked again on the next
         visit. */
      held.at = Date.now();
    } finally {
      held.asking = null;
    }
  })();
  return held.asking;
}

/**
 * "Not that one" — about a suggestion, not about a title.
 *
 * The bin on an ordinary card hides a title from the library: every shelf,
 * search, everywhere, on purpose. The bin inside For You says something much
 * smaller — stop offering me this — and it must not cost the title, because
 * this row is made entirely of things nobody here has seen and opening one is
 * the only way to find out whether you want it.
 *
 * So it removes the card from the row now and tells the box, which keeps the
 * list beside the ratings and hands it to nothing but the recommender.
 */
const notInterested = {
  async add(item, tab) {
    if (!profiles.current || !item) return;
    const kind = forYouKind(tab);
    const id = String(item.id);
    const held = forYou[tab === 'series' ? 'series' : 'movies'];
    /* Taken off the row before the round trip. The box is on the other side
       of a Tailscale link and the press has to land now. A grouped card
       carries its copies with it, and every one of them is the same
       suggestion — so all of them go. */
    const ids = new Set([id, ...(item.variants || []).map((v) => String(v.id))]);
    held.items = held.items.filter((row) => !ids.has(String(row.id)));
    held.picks = held.picks.filter((row) => !ids.has(String(row.id)));
    render();
    try {
      for (const one of ids) {
        // eslint-disable-next-line no-await-in-loop
        await fetch(`/api/profiles/${profiles.current.id}/notinterested`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, id: one }),
        });
      }
    } catch {
      /* Said and not written down. The row is right until the page is
         reloaded, and the press can be made again. */
    }
    toast(`Won't suggest ${item.name} again — it's still in your library.`);
  },
};

/**
 * A different forty every time you come back.
 *
 * Seeded once per load rather than per render, and by row title as well, so:
 * the shelves are stable while you are looking at them — pinning something or
 * hiding a title re-renders the page, and posters that jumped every time would
 * be worse than a fixed order — a row keeps its own arrangement rather than
 * every row reshuffling together, and the whole page looks different the next
 * time it is opened.
 *
 * mulberry32, because `Math.random()` cannot be seeded and a fresh shuffle on
 * every render is exactly what this is avoiding.
 */
const SHUFFLE_SEED = (Math.random() * 2 ** 32) >>> 0;

function shuffleShelf(title, items) {
  let seed = SHUFFLE_SEED;
  for (let i = 0; i < title.length; i += 1) {
    seed = (seed ^ title.charCodeAt(i)) >>> 0;
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildShelves(tab) {
  const lib = state.library[tab];
  if (!lib) return [];

  // Hidden titles are out of the rows too, not just the grids — and so is
  // anything adult, which nobody put on a landing shelf on purpose.
  const pool = browsable(lib.items.filter((i) => !profiles.isDeleted(i)), '');
  const rows = [];
  for (const def of SHELF_DEFS[tab] || []) {
    if (def.special === 'recent') {
      const items = forYouItems(tab);
      /* On Movies and Series this row is always here.
       *
       * It used to appear only when it had something, which sounds tidy and
       * is a trap: every way of having nothing then looked identical to the
       * feature not existing. A prefix typo made the box answer "no library",
       * the row disappeared off the page, and with it went the only door to
       * the picker and to the key — so the one screen that could have
       * explained what was wrong was the screen that had been removed.
       *
       * A row that can vanish is worse than the row it replaced. This one
       * says what it has, or asks, or says why it cannot. */
      if (tab === 'movies' || tab === 'series') {
        rows.push({
          title: def.title,
          items,
          ask: !items.length,
          tune: items.length > 0,
          /* Marked, so the cards on it get the bin that answers a
             suggestion rather than the one that hides a title. */
          forYou: true,
        });
      } else if (items.length) {
        rows.push({ title: def.title, items });
      }
      continue;
    }

    const ids = new Set(
      (def.match ? lib.categories.filter((c) => def.match.some((re) => re.test(c.name))) : [])
        .map((c) => String(c.id))
    );

    let items = def.all
      ? pool
      : pool.filter(
          (i) =>
            ids.has(String(i.categoryId)) ||
            (def.genre && def.genre.test(i.genre || ''))
        );

    // Every row here matches on the provider's own category names, and a
    // provider that renames one empties the row. For New Releases that matters
    // more than for the rest: it is the row that answers "what is new", so
    // when the named category is not there it falls back to the whole library
    // and lets `added` do the work. The answer is then the same either way —
    // newest first — rather than an empty shelf.
    if (!items.length && def.fallbackAll) items = pool;

    /* One card per title, here as well as in the grid.
     *
     * The grid grouped and the shelves did not, so the same film appeared
     * three times along a rail — and the Movies page IS the shelves. Grouped
     * per row rather than across the page, the same way the grid groups after
     * filtering: two shelves are two questions, and a film that is on both is
     * legitimately on both. */
    if (tab === 'movies' || tab === 'series') items = groupVariants(items);

    if (def.sort === 'added') {
      items = [...items].sort((a, b) => (b.added || 0) - (a.added || 0));
    } else if (!def.special) {
      // Everything else is shuffled. A shelf is capped at forty, so without
      // this the same forty posters are the whole of what a category ever
      // looks like — the rest of it might as well not be there.
      items = shuffleShelf(def.title, items);
    }
    if (items.length) rows.push({ title: def.title, items });
  }

  // Every row above matches on the provider's category names, so renaming or
  // re-prefixing them empties the entire page — a library of thousands behind a
  // "No rows to show yet". One row of everything is a poor page; it is a far
  // better one than none, and the header opens the full list.
  if (!rows.length && pool.length) {
    rows.push({ title: tab === 'series' ? 'All series' : 'All movies', items: pool });
  }

  return rows;
}

/* ------------------------------------------------------- search, all of it ---
 *
 * Typing in the box searches the WHOLE library, not the tab that happened to
 * be open. Somebody looking for a word does not know, and should not have to
 * know, whether the thing they are picturing is filed as a film, an episode
 * or a channel — and checking three tabs by hand is three times the work for
 * the same answer.
 *
 * The three sections fill in one at a time rather than together, because a
 * library that has not been opened yet has to be fetched: the tabs already
 * loaded appear at once, and the rest drop in as they arrive. Waiting for the
 * slowest one before showing any of them would make the common case — the
 * thing you wanted is a film, and Movies was already loaded — feel like the
 * rare one.
 *
 * The drive is deliberately NOT in here. It is a separate 5,853-file index on
 * the box, it answers over the network per keystroke, and it belongs to one
 * profile; it is searched from the Archive page, where that is what you asked
 * for.
 */
/**
 * Lower-cased and stripped of accents, so a keyboard can reach a title.
 *
 * The moment search stops being English-only this stops being optional:
 * "Le Fabuleux Destin d'Amélie Poulain" is unreachable by typing "amelie"
 * on a US keyboard, and a button that surfaces foreign titles nobody can
 * then type is half a feature. NFD splits an accented letter into the
 * letter and its mark; dropping the marks leaves the letter.
 *
 * Memoised onto the item because a search runs over the whole catalogue on
 * every keystroke, and with the filter set aside that catalogue is six
 * figures of titles.
 */
function foldText(text) {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

const foldedName = (item) => {
  if (item.folded === undefined) item.folded = foldText(item.name);
  return item.folded;
};

/**
 * The pages a search runs from.
 *
 * Home is one of them, and used not to be. Typing into the box from the
 * landing page set the query, painted the landing page again, and produced
 * nothing at all — the one page somebody is most likely to be standing on
 * when a title occurs to them was the one page that could not look for it.
 * Downloads and the archive keep their own searches, which look at their own
 * things.
 */
/**
 * Adult titles stay out of the way until they are asked for by name.
 *
 * The provider files a great deal of this and files it everywhere — in the
 * grids, in the shelves, in the New Releases row, and in the answer to any
 * search loose enough to catch it. None of it is wanted while somebody is
 * looking for a film with the family in the room, and all of it is wanted by
 * whoever went looking for it deliberately.
 *
 * So the door is the word itself: type "xxx" and they appear, do anything
 * else and they do not. It is not a lock — this box has no accounts and
 * pretends to none — it is a door that stays shut unless you open it, which
 * is the honest version of what was asked for.
 */
const asksForAdult = (query) => /(^|[^a-z0-9])xxx([^a-z0-9]|$)/i.test(String(query || ''));

/** Everything but the adult titles, unless the query went looking for them. */
function browsable(items, query = state.query) {
  if (asksForAdult(query)) return items;
  return items.filter((i) => !i.adult);
}

/**
 * One card per title, however many copies of it the provider sells.
 *
 * The same film arrives three and four times over — a 4K one, a Dutch one, a
 * Scandinavian one — because the provider files each in its own category and
 * the category name was living in the title. A grid of that reads as a grid
 * of duplicates, and picking between them means reading four near-identical
 * lines of text.
 *
 * Grouped on the cleaned title EXACTLY, which is the whole of the care here.
 * "Trading Places" three times is one card; "Bytta roller/Trading Places" is
 * a different film with a different name and gets its own; and "Trading
 * Places (2023)" is a different film that happens to share a name, which the
 * year says plainly — so an exact match on the name, year and all, is both
 * the simplest rule and the correct one.
 *
 * Order within a group is left as the library gave it, except that the one
 * with the most to offer leads: 4K first, so the card that opens is the best
 * copy rather than whichever happened to be listed first.
 */
function groupVariants(items) {
  const byName = new Map();
  const out = [];
  for (const item of items) {
    const key = foldedName(item);
    if (!key) { out.push(item); continue; }
    const held = byName.get(key);
    if (!held) {
      const lead = { ...item, variants: [item] };
      byName.set(key, lead);
      out.push(lead);
      continue;
    }
    held.variants.push(item);
    // The best copy leads the card, and lends it its poster and its mark.
    if (item.uhd && !held.uhd) {
      const kept = held.variants;
      Object.assign(held, item, { variants: kept });
    }
  }
  return out;
}

/**
 * Every copy of one title, for the switcher on its own page.
 *
 * Derived rather than carried: the grids group for display, but a card is
 * reached by id from a link or a history row, and that id may be any of the
 * copies. Asking the library the same question again is cheap and means the
 * card is right however it was arrived at.
 */
function variantsOf(tab, item) {
  if (!item) return [];
  const key = foldedName(item);
  for (const store of [state.library, state.libraryAll]) {
    const items = store[tab]?.items || [];
    if (!items.some((i) => String(i.id) === String(item.id))) continue;
    const found = items.filter((i) => foldedName(i) === key && !profiles.isDeleted(i));
    if (found.length) return found;
  }
  return [item];
}

/** What to call one copy on the switcher. */
function variantLabel(tab, item) {
  if (item.tag) return item.tag;
  const cats = state.library[tab]?.categories || state.libraryAll[tab]?.categories || [];
  const cat = cats.find((c) => String(c.id) === String(item.categoryId));
  return cat?.name || 'Standard';
}

/**
 * A query broken into the words it is actually made of.
 *
 * Search used to be one contiguous substring, which meant it only ever found
 * what you could already spell in order: "dark knight" found The Dark Knight
 * and "knight dark" found nothing, and neither did "batman knight" for a film
 * with both words in the title. Typing a few words you remember is the normal
 * way to look for something half-remembered, and it was the one way that did
 * not work.
 */
function searchTerms(query) {
  return foldText(query).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * How well a title answers a query, or 0 for not at all.
 *
 * Every word has to be in there somewhere — that is the widening, and it is
 * deliberately generous, because a near miss you can see past is worth more
 * than a clean miss you cannot. The score is what stops that generosity
 * turning into a wall: the whole phrase, in order, at the front of the title
 * outranks the same words scattered through a long one, so the thing being
 * looked for is at the top even when a hundred other titles technically
 * qualify.
 */
function matchScore(item, terms, phrase) {
  const name = foldedName(item);
  if (!name) return 0;

  let score = 0;
  for (const term of terms) {
    const at = name.indexOf(term);
    if (at === -1) return 0;                 // every word, or nothing
    score += 10;
    // At the start of a word rather than buried inside one: "man" matching
    // Manhattan is not the same find as "man" matching Spider Man.
    if (at === 0 || !/[a-z0-9]/.test(name[at - 1])) score += 40;
  }

  /* The words together, in the order they were typed, count for far more
   * than the same words apart — but only where the phrase is a phrase and
   * not the front of a longer word. Without the second half of that test
   * "man" ranked Manhattan above Spider Man, on the strength of starting
   * with the letters. Bounded on both sides, or it is not a match worth
   * promoting. */
  if (phrase) {
    const at = name.indexOf(phrase);
    const bounded = at !== -1
      && (at === 0 || !/[a-z0-9]/.test(name[at - 1]))
      && (at + phrase.length === name.length
        || !/[a-z0-9]/.test(name[at + phrase.length]));
    if (bounded) {
      score += 200;
      if (at === 0) score += 300;
      if (name === phrase) score += 500;
    }
  }

  // Between two titles that both qualify, the shorter one is the tighter
  // match — "Dune" over "Dune: Part Two Behind The Scenes Featurette".
  return score + Math.max(0, 60 - name.length) / 10;
}

/** The matches for a query, best first. */
function rankedMatches(items, query) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  items = browsable(items, query);
  const phrase = foldText(query).trim();
  const scored = [];
  for (const item of items) {
    const score = matchScore(item, terms, phrase);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((row) => row.item);
}

const SEARCH_TABS = ['home', 'live', 'movies', 'series'];

/** The sections a search fills in. Home has no library of its own to add. */
const SEARCH_SECTIONS = [
  { tab: 'live', title: 'Live TV' },
  { tab: 'movies', title: 'Movies' },
  { tab: 'series', title: 'Series' },
];
/** Per section, before it stops being a list and starts being a wall. */
const SEARCH_PER_SECTION = 60;
/** Bumped by every new search, so a slow library cannot land on a later one. */
let searchToken = 0;

function renderSearchAll() {
  const grid = $('#grid');
  const mine = (searchToken += 1);

  document.querySelector('.app-shell').classList.add('no-sidebar');
  grid.hidden = false;
  grid.className = 'grid';
  grid.innerHTML = '';
  $('#contentTitle').textContent = 'Search';
  $('#contentMeta').textContent = `“${state.query}”`;
  $('#loadMore').hidden = true;
  $('#emptyState').hidden = true;

  // One placeholder per section, in order, so the page has its shape before
  // anything has arrived and sections cannot land out of order.
  const slots = new Map();
  for (const section of SEARCH_SECTIONS) {
    const slot = el('div', 'search-section');
    slot.dataset.tab = section.tab;
    slots.set(section.tab, slot);
    grid.append(slot);
  }

  let answered = 0;
  let found = 0;

  const draw = (section, items, error) => {
    if (mine !== searchToken) return;          // a newer search is on screen
    const slot = slots.get(section.tab);
    if (!slot) return;
    slot.innerHTML = '';
    answered += 1;

    if (error) {
      const head = el('div', 'search-head');
      head.append(Object.assign(el('h2', 'search-head-title'),
        { textContent: section.title }));
      head.append(Object.assign(el('span', 'search-head-note'),
        { textContent: `couldn't load — ${error}` }));
      slot.append(head);
      return finish();
    }

    if (!items.length) return finish();        // nothing here; say nothing
    found += items.length;

    const head = el('div', 'search-head');
    head.append(Object.assign(el('h2', 'search-head-title'),
      { textContent: section.title }));
    head.append(Object.assign(el('span', 'search-head-note'), {
      textContent: items.length > SEARCH_PER_SECTION
        ? `${items.length.toLocaleString()} matches — showing ${SEARCH_PER_SECTION}`
        : `${items.length.toLocaleString()} match${items.length === 1 ? '' : 'es'}`,
    }));
    slot.append(head);

    const cards = el('div', `search-cards${section.tab === 'live' ? ' is-live' : ''}`);
    /* Sixty to begin with, and the rest on request.
     *
     * A wide search over a six-figure catalogue can answer with hundreds,
     * and painting all of them for every keystroke is how a search box
     * becomes unusable. But a cap that cannot be lifted is a cap that hides
     * the answer somewhere below the line, so the count says how many were
     * held back and one press draws them. */
    const paint = (limit) => {
      cards.innerHTML = '';
      for (const item of items.slice(0, limit)) cards.append(cardFor(item));
    };
    paint(SEARCH_PER_SECTION);
    slot.append(cards);

    if (items.length > SEARCH_PER_SECTION) {
      const more = el('button', 'btn btn-ghost btn-sm search-more');
      more.textContent = `Show all ${items.length.toLocaleString()}`;
      more.addEventListener('click', () => {
        paint(items.length);
        more.remove();
      });
      slot.append(more);
    }
    finish();
  };

  const finish = () => {
    if (answered < SEARCH_SECTIONS.length || found) return;
    // Every section has answered and none of them had anything.
    const empty = $('#emptyState');
    empty.hidden = false;
    // Nothing found under the English/US filter is the exact moment the
    // wider search is worth knowing about, so it is said here rather than
    // left to be noticed on a button somebody is not looking at.
    const wider = !state.searchWide && prefs.data.filtersEnabled !== false
      ? ' Try All languages, above, to search the titles the English/US filter hides.'
      : '';
    empty.textContent = `Nothing matches “${state.query}”.${wider}`
      + (reporter.isOwner() ? ' The drive is searched from the Archive page.' : '');
  };

  // Wide or narrow, it is the same search over a different catalogue.
  const held = state.searchWide ? state.libraryAll : state.library;

  const matches = (tab) => groupVariants(rankedMatches(
    (held[tab]?.items || []).filter((i) => !profiles.isDeleted(i)), state.query));

  for (const section of SEARCH_SECTIONS) {
    if (held[section.tab]) {
      draw(section, matches(section.tab));
      continue;
    }
    // Not loaded, so it has to be fetched — quietly, because a full-screen
    // loading panel over a page that is already showing results is worse
    // than a section that fills in a moment later.
    const slot = slots.get(section.tab);
    const head = el('div', 'search-head');
    head.append(Object.assign(el('h2', 'search-head-title'),
      { textContent: section.title }));
    head.append(Object.assign(el('span', 'search-head-note'), {
      // The wide catalogue is the whole provider and takes noticeably
      // longer, so it says which search it is waiting on rather than
      // leaving somebody watching an unexplained pause.
      textContent: state.searchWide ? 'searching every language…' : 'searching…',
    }));
    slot.append(head);

    loadTab(section.tab, { quiet: true, all: state.searchWide })
      .then(() => draw(section, matches(section.tab)))
      .catch((err) => draw(section, [], err.message));
  }
}

/**
 * Search past the English/US filter, without changing what the filter is.
 *
 * The provider sells in every language it can, and the stored filter throws
 * all of it away before it ever reaches the browser — which is right for
 * browsing, and wrong for the one evening somebody wants a film they know
 * the name of and cannot find. The Settings switch does exist, but it is a
 * decision about the whole library: flip it and every page reloads from
 * nothing, and it has to be remembered and flipped back.
 *
 * So this is a button on the search itself. It widens the search that is
 * already on screen, leaves browsing exactly as it was, and stays on for
 * the rest of the session because somebody hunting a foreign title is
 * rarely doing it once.
 */
function applyWideSearchButton() {
  const button = $('#wideSearchBtn');
  const searching = Boolean(state.query) && SEARCH_TABS.includes(state.tab);
  // With the filter switched off in Settings there is nothing hidden to go
  // looking for, and a button offering to widen an already-wide search is
  // just a lie with a globe on it.
  button.hidden = !searching || prefs.data.filtersEnabled === false;
  button.classList.toggle('is-on', state.searchWide);
  // The label, not the button: textContent here would take the icon with it.
  $('#wideSearchLabel').textContent = state.searchWide
    ? 'Every language' : 'All languages';
  button.title = state.searchWide
    ? 'Searching the whole provider. Press to go back to English/US only.'
    : 'Also search the titles the English/US filter hides.';
}

$('#wideSearchBtn').addEventListener('click', () => {
  state.searchWide = !state.searchWide;
  applyWideSearchButton();
  render();
  toast(state.searchWide
    ? 'Searching every language — the first one takes a moment.'
    : 'Back to English/US titles.');
});

function renderRows() {
  const grid = $('#grid');
  grid.hidden = true;
  $('#loadMore').hidden = true;
  $('#emptyState').hidden = true;

  const wrap = $('#rowsView');
  wrap.hidden = false;
  wrap.innerHTML = '';

  const rows = buildShelves(state.tab);
  if (!rows.length) {
    wrap.hidden = true;
    $('#emptyState').hidden = false;
    // With the catch-all row above, reaching here means the library itself came
    // back with nothing — so say that, rather than blaming the rows.
    const held = state.library[state.tab];
    const hidden = (held?.items || []).length && !buildShelves(state.tab).length;
    $('#emptyState').textContent = hidden
      ? 'Everything here is hidden. Open Deleted in the sidebar to put something back.'
      : 'The library came back empty. If the English / US-only filter is on, try turning it off.';
    return;
  }

  let total = 0;
  const frag = document.createDocumentFragment();

  for (const row of rows) {
    total += row.items.length;
    const section = el('section', 'shelf');

    // A button, not a heading: the rail only ever shows the first slice of a
    // row, and this is the way through to the rest of it.
    const head = el('button', 'shelf-head');
    head.type = 'button';
    head.title = `Show all of ${row.title}`;
    const title = el('h2', 'shelf-title');
    title.textContent = row.title;
    const count = el('span', 'shelf-count');
    count.textContent = row.items.length.toLocaleString();
    const more = el('span', 'shelf-more');
    more.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
    head.append(title, count, more);
    head.addEventListener('click', () => {
      state.shelf = row.title;
      state.visible = PAGE_SIZE;
      render();
      scrollViewTop();
    });

    const rail = el('div', 'rail');
    const track = el('div', 'rail-track');
    /* The row that has nothing to go on yet asks instead. Where the posters
       would be, because that is where somebody is already looking. */
    if (row.ask) {
      const ask = el('button', 'foryou-ask');
      ask.type = 'button';
      /* Three ways to have nothing, and they are not the same thing. Saying
         "pick some films" when the library has not loaded sends somebody to
         a picker that will be empty too. */
      const shows = state.tab === 'series';
      const these = shows ? 'shows' : 'films';
      const held = forYouFor(state.tab);
      const note = held.needs === 'library'
        ? `The box has not read the ${shows ? 'series' : 'film'} library yet. Open `
          + `${shows ? 'Series' : 'Movies'} again in a moment — and meanwhile you can `
          + 'still set a recommendation key here.'
        : held.at === 0
          ? 'Working out what to put here…'
          : `Pick a few ${these} and this row fills with things you have not seen — `
            + 'by who made them, and by what other people reached for next.';
      ask.append(
        Object.assign(el('span', 'foryou-ask-title'), { textContent: 'Tell me what you love' }),
        Object.assign(el('span', 'foryou-ask-note'), { textContent: note }),
        Object.assign(el('span', 'foryou-ask-go'), { textContent: `Pick some ${these}` })
      );
      ask.addEventListener('click', () => seedPicker.open(state.tab));
      track.append(ask);
    }
    // Cap each shelf; the full category is still reachable through search.
    for (const item of row.items.slice(0, 40)) {
      const card = cardFor(item, { forYou: row.forYou ? state.tab : '' });
      card.classList.add('rail-card');
      if (item.why && item.why.length) {
        /* Why this one, in the row rather than behind a hover: a
           recommendation nobody understands is a recommendation nobody
           trusts, and 'Directed by the person who made the last thing you
           liked' is the whole argument in five words. */
        const why = el('p', 'card-why');
        why.textContent = item.why[0];
        card.append(why);
      }
      track.append(card);
    }
    /* And a way back to the picker once the row is working. The settings for
       this row were reachable only through the empty state, which meant they
       stopped being reachable the moment the row started working — including
       the field for the key that would make it better. */
    if (row.tune) {
      const tune = el('button', 'foryou-ask is-tune');
      tune.type = 'button';
      tune.append(
        Object.assign(el('span', 'foryou-ask-title'), { textContent: 'Tune these' }),
        Object.assign(el('span', 'foryou-ask-note'), {
          textContent: `Change the ${state.tab === 'series' ? 'shows' : 'films'} these are `
            + 'based on, or set a key so the row can use what other audiences watched next.',
        }),
        Object.assign(el('span', 'foryou-ask-go'), { textContent: 'Open' })
      );
      tune.addEventListener('click', () => seedPicker.open(state.tab));
      track.append(tune);
    }

    const prev = el('button', 'rail-nav prev');
    prev.setAttribute('aria-label', `Scroll ${row.title} left`);
    prev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
    const next = el('button', 'rail-nav next');
    next.setAttribute('aria-label', `Scroll ${row.title} right`);
    next.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';

    // Tween it by hand. `behavior: 'smooth'` is unreliable here — it silently
    // does nothing in some engines — and the fixed floor covers a rail that
    // reports no width because it hasn't been laid out yet.
    const page = (dir) => {
      const step = Math.max(track.clientWidth * 0.85, 400);
      const from = track.scrollLeft;
      const to = Math.max(0, Math.min(track.scrollWidth - track.clientWidth, from + dir * step));
      if (to === from) return;

      const start = performance.now();
      const glide = (now) => {
        const t = Math.min(1, (now - start) / 320);
        const eased = 1 - (1 - t) * (1 - t); // ease-out
        track.scrollLeft = from + (to - from) * eased;
        if (t < 1) requestAnimationFrame(glide);
      };
      requestAnimationFrame(glide);
    };
    prev.addEventListener('click', () => page(-1));
    next.addEventListener('click', () => page(1));

    const syncNav = () => {
      prev.classList.toggle('is-off', track.scrollLeft < 8);
      next.classList.toggle(
        'is-off',
        track.scrollLeft + track.clientWidth >= track.scrollWidth - 8
      );
    };
    track.addEventListener('scroll', syncNav, { passive: true });
    requestAnimationFrame(syncNav);

    rail.append(prev, track, next);
    section.append(head, rail);
    frag.append(section);
  }

  wrap.append(frag);
  $('#contentMeta').textContent = `${rows.length} rows · ${total.toLocaleString()} titles`;
}

/**
 * One shelf opened out into the full scrollable list. The rails are capped, so
 * for a big row like New Releases most of it was previously only reachable by
 * knowing what to search for.
 */
function renderShelf() {
  const row = buildShelves(state.tab).find((r) => r.title === state.shelf);

  // The shelves are rebuilt from the library every time, so a row can stop
  // existing — a changed filter, a provider that dropped a category. Fall back
  // rather than showing an empty page for a title that is gone.
  if (!row) {
    state.shelf = null;
    return renderRows();
  }

  $('#rowsView').hidden = true;
  const grid = $('#grid');
  grid.hidden = false;
  grid.className = 'grid';
  grid.innerHTML = '';

  const back = el('button', 'btn btn-ghost folder-back');
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  back.append(document.createTextNode(state.tab === 'series' ? ' All series' : ' All movies'));
  back.addEventListener('click', () => {
    state.shelf = null;
    state.visible = PAGE_SIZE;
    render();
  });
  grid.before(back);

  // The row's own name replaces the tab's, since the back button already says
  // which tab this is and the shelf is what you are actually looking at.
  $('#contentTitle').textContent = row.title;

  const slice = row.items.slice(0, state.visible);
  state.filtered = row.items;

  const frag = document.createDocumentFragment();
  /* The full page of a row is the same row, so a card on it is the same card
     — including which bin it carries. Opening For You in full and finding the
     library bin there would mean the same poster meant two different things
     depending on how much of the row was on screen. */
  for (const item of slice) frag.append(cardFor(item, { forYou: row.forYou ? state.tab : '' }));
  grid.append(frag);

  $('#emptyState').hidden = true;
  $('#contentMeta').textContent =
    `${slice.length.toLocaleString()} of ${row.items.length.toLocaleString()}`;
  $('#loadMore').hidden = row.items.length <= state.visible;
}

/* ------------------------------------------------------------- rendering */

function renderCategories(categories, items) {
  const list = $('#catList');
  list.innerHTML = '';

  const counts = new Map();
  for (const item of items) {
    counts.set(item.categoryId, (counts.get(item.categoryId) || 0) + 1);
  }

  const makeRow = (id, name, count, { pinnable = true } = {}) => {
    const row = el('div', 'cat-row');

    const btn = el('button', 'cat');
    if (String(state.category ?? '') === String(id ?? '')) btn.classList.add('is-active');
    const label = el('span');
    label.textContent = name;
    const badge = el('b');
    badge.textContent = count.toLocaleString();
    btn.append(label, badge);
    btn.addEventListener('click', () => {
      state.category = id;
      state.visible = PAGE_SIZE;
      $('#sidebar').classList.remove('is-open');
      render();
    });
    row.append(btn);

    if (pinnable) {
      const pin = el('button', 'pin-btn');
      const pinned = profiles.isPinned(state.tab, id);
      pin.classList.toggle('is-on', pinned);
      pin.title = pinned ? 'Unpin category' : 'Pin to top';
      pin.setAttribute('aria-label', pin.title);
      pin.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6z"/><path d="M12 14v7"/></svg>';
      pin.addEventListener('click', (event) => {
        event.stopPropagation();
        const nowPinned = profiles.togglePin(state.tab, id);
        toast(nowPinned ? `Pinned “${name}”.` : `Unpinned “${name}”.`);
        render();
      });
      row.append(pin);
    }

    return row;
  };

  // "All" always sits at the very top and can't be pinned.
  list.append(makeRow(null, 'All', items.length, { pinnable: false }));

  const q = state.catQuery.toLowerCase();
  const visible = categories.filter((cat) => {
    if (!counts.get(String(cat.id))) return false;
    return !q || cat.name.toLowerCase().includes(q);
  });

  // Pins carry their own order so they can be dragged; everything else stays in
  // the order the provider sent.
  const order = profiles.pinOrder(state.tab);
  const pinned = visible
    .filter((c) => profiles.isPinned(state.tab, c.id))
    .sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
  const rest = visible.filter((c) => !profiles.isPinned(state.tab, c.id));

  const section = (title, rows, { reorderable = false } = {}) => {
    if (!rows.length) return;
    const heading = el('div', 'cat-section');
    heading.textContent = title;
    list.append(heading);
    for (const cat of rows) {
      const row = makeRow(cat.id, cat.name, counts.get(String(cat.id)) || 0);
      if (reorderable) {
        row.classList.add('cat-row-pinned');
        row.dataset.catId = String(cat.id);
        makePinDraggable(row);
      }
      list.append(row);
    }
  };

  if (pinned.length) {
    section('Pinned', pinned, { reorderable: true });
    section('All categories', rest);
  } else {
    for (const cat of rest) {
      list.append(makeRow(cat.id, cat.name, counts.get(String(cat.id)) || 0));
    }
  }

  // The bin sits at the very bottom, and only appears once there is something
  // in it — an empty row would just be a permanent reminder of a feature.
  if (canDelete(state.tab)) {
    const binned = profiles.deletedItems(state.tab);
    if (binned.length) {
      const heading = el('div', 'cat-section');
      heading.textContent = 'Hidden';
      list.append(heading);
      list.append(makeRow(DELETED_CATEGORY, 'Deleted', binned.length, { pinnable: false }));
    }
  }

  if (q && !visible.length) {
    const none = el('div', 'cat-empty');
    none.textContent = `No category matches “${state.catQuery}”.`;
    list.append(none);
  }
}

/**
 * Drag a pinned category by its pin to reorder it.
 *
 * Pointer events rather than HTML5 drag-and-drop, which iOS Safari does not
 * implement — on the phone this is mostly used from, the whole feature would
 * simply not exist. The drag only begins once the finger has moved past a
 * threshold, so a plain tap still unpins.
 */
function makePinDraggable(row) {
  const pin = row.querySelector('.pin-btn');
  if (!pin) return;

  pin.title = 'Unpin, or drag to reorder';
  pin.setAttribute('aria-label', pin.title);

  let startY = 0;
  let dragging = false;
  let heldPointer = null;
  let draggedAt = 0;
  const siblings = () => [...row.parentElement.querySelectorAll('.cat-row-pinned')];

  /**
   * Letting go can still fire a click on the pin, which would unpin the row
   * just moved. A one-shot listener is not enough: the click only fires at all
   * when the release lands back on the pin, and a drag usually ends somewhere
   * else — so the unused listener sat waiting and ate the next genuine tap.
   * A timestamp expires on its own instead.
   */
  pin.addEventListener('click', (click) => {
    if (Date.now() - draggedAt > 300) return; // an ordinary tap: let it unpin
    click.preventDefault();
    click.stopPropagation();
  }, true);

  const onMove = (event) => {
    if (heldPointer !== event.pointerId) return;

    if (!dragging) {
      if (Math.abs(event.clientY - startY) < 6) return;
      dragging = true;
      row.classList.add('is-dragging');
      document.body.classList.add('is-reordering');
    }

    // Put the row where the pointer actually is, in one move. Stepping it past
    // a single neighbour per event meant a quick drag — which delivers only a
    // handful of moves — dropped the row one place from where it started and
    // stopped, however far the finger had travelled.
    const others = siblings().filter((r) => r !== row);
    if (!others.length) return;

    // Midpoints rather than edges, so a row settles instead of flickering while
    // the pointer rests on a boundary.
    let target = others.findIndex((other) => {
      const box = other.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    if (target === -1) target = others.length;

    const before = others[target] || null;
    if (before) {
      if (row.nextElementSibling !== before) before.before(row);
    } else {
      const last = others[others.length - 1];
      if (last.nextElementSibling !== row) last.after(row);
    }
  };

  const finish = (event) => {
    if (heldPointer !== event.pointerId) return;
    heldPointer = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);

    if (!dragging) return; // a tap: leave it to the unpin handler
    dragging = false;
    row.classList.remove('is-dragging');
    document.body.classList.remove('is-reordering');
    draggedAt = Date.now();

    profiles.setPinOrder(state.tab, siblings().map((r) => r.dataset.catId));
  };

  pin.addEventListener('pointerdown', (event) => {
    heldPointer = event.pointerId;
    startY = event.clientY;
    dragging = false;
    // On the window, not on the pin. The first swap moves the row — and the
    // pin with it — out from under the cursor, and setPointerCapture was not
    // keeping the stream alive, so every later move was delivered somewhere
    // else and the drag stopped one place from where it began.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });
}

/**
 * How far through this title the profile is, 0–1, from the history already
 * loaded for the For You shelf. Returns 0 for unwatched or finished titles —
 * a full stripe on something you've completed is just noise.
 */
function watchedProgress(item) {
  const key = resumeKeyFor(item);
  for (const row of state.recentlyWatched || []) {
    // Series cards aggregate episodes, so match the show as well as the key.
    const isShow = item.kind === 'series' && String(row.seriesId ?? '') === String(item.id);
    if (row.key !== key && !isShow) continue;
    if (row.completed || !row.duration || !row.position) continue;
    const ratio = row.position / row.duration;
    if (ratio < 0.01 || ratio > RESUME_MAX_RATIO) continue;
    return ratio;
  }
  return 0;
}

/** Anything from the provider can be hidden; downloads are left alone. */
const DELETED_CATEGORY = '__deleted__';
/** The tile grid, showing the categories that have been hidden. */
const DELETED_CATS = '__deletedcats__';
const canDelete = (tab) => tab === 'movies' || tab === 'series' || tab === 'live';

/**
 * A poster.
 *
 * `opts.forYou` is the tab whose recommendation row this card is on, or ''
 * for every other card in the app. It changes exactly one thing — which bin
 * the card gets — and the difference matters: see below.
 */
function cardFor(item, opts = {}) {
  const card = el('button', 'card');

  const art = el('div', 'card-art');
  if (item.logo) {
    const image = el('img');
    image.loading = 'lazy';
    image.alt = '';
    image.src = item.logo;
    image.addEventListener('error', () => {
      image.remove();
      const fb = el('div', 'fallback');
      fb.textContent = item.name;
      art.append(fb);
    });
    art.append(image);
  } else {
    const fb = el('div', 'fallback');
    fb.textContent = item.name;
    art.append(fb);
  }

  // 4K sits apart from the badges below because it is not a state — SAVED
  // and LIVE say what this copy is doing, this says what it IS, and the two
  // are worth seeing at once rather than one winning.
  if (item.uhd) {
    const uhd = el('div', 'badge uhd');
    uhd.textContent = '4K';
    art.append(uhd);
  }

  if (item.kind === 'live') {
    const badge = el('div', 'badge live');
    badge.append(el('span', 'dot'));
    badge.append(document.createTextNode('LIVE'));
    art.append(badge);
  } else if (findLocalCopy(item.kind, item.id)) {
    // Already on disk — this one plays instantly and offline.
    const badge = el('div', 'badge saved');
    badge.textContent = 'SAVED';
    art.append(badge);
  }

  // Stripe along the foot of the poster for anything part-watched.
  const watched = watchedProgress(item);
  if (watched > 0) {
    const bar = el('div', 'card-progress');
    const fill = el('i');
    fill.style.width = `${Math.min(100, watched * 100)}%`;
    bar.append(fill);
    art.append(bar);
  }

  /* On For You, the bin answers the SUGGESTION.
   *
   * Everywhere else this icon hides a title from the library — every shelf,
   * every search, permanently, which is what somebody wants for the eleven
   * copies of a film they will never watch. On a recommendation row that
   * would be a trap. The whole row is things nobody here has seen, so the
   * only way to know whether you want one is to open it, and saying "not
   * this" about a guess should not delete a title out of a library you have
   * not looked at yet.
   *
   * Same icon, because it means the same thing to a hand: make this go away.
   * Different sentence, because the thing being made to go away is different.
   * Always visible rather than on hover — this is the one place the press is
   * part of using the row rather than housekeeping, and hover is not a thing
   * on a phone. */
  if (opts.forYou) {
    const bin = el('button', 'icon-btn card-bin is-foryou');
    bin.title = 'Not interested — stop suggesting this, keep it in the library';
    bin.setAttribute('aria-label', bin.title);
    bin.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>'
      + '<path d="M10 11v6M14 11v6"/></svg>';
    bin.addEventListener('click', (event) => {
      // The poster underneath opens the player.
      event.stopPropagation();
      notInterested.add(item, opts.forYou);
    });
    art.append(bin);
  } else if (canDelete(state.tab)) {
    // Hide a title you never want to see again, or put it back from the bin.
    // Revealed on hover so it is not sitting on every poster; in the bin it is
    // always there, since that is the only way back and hover is not a thing on
    // a phone.
    const gone = profiles.isDeleted(item);
    const bin = el('button', `icon-btn card-bin${gone ? ' is-restore' : ''}`);
    bin.title = gone ? 'Put back' : 'Hide this — it stops showing in lists and search';
    bin.setAttribute('aria-label', bin.title);
    bin.innerHTML = gone
      ? '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M3 4v5h5"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
    bin.addEventListener('click', (event) => {
      // The poster underneath opens the player.
      event.stopPropagation();
      const nowGone = profiles.toggleDeleted(item);
      toast(nowGone ? `Hid “${item.name}”. It's in Deleted.` : `Restored “${item.name}”.`);
      render();
    });
    art.append(bin);
  }

  const title = el('h3', 'card-title');
  title.textContent = item.name;
  card.append(art, title);

  if (item.rating) {
    const sub = el('p', 'card-sub');
    sub.textContent = `★ ${item.rating}`;
    card.append(sub);
  }

  card.addEventListener('click', () => openTitle(item));
  return card;
}

/**
 * Open a title's own page.
 *
 * Through the hash rather than by rendering directly, so the back button works
 * and so the player has a named place to return to. Live TV has no page —
 * there is nothing to decide about a channel, so it tunes straight in.
 */
function openTitle(item) {
  if (item.kind === 'live') return openPlayer(item);
  location.hash = `#/${item.kind === 'series' ? 'series' : 'movies'}/${item.id}`;
}

/** Kept for the places that specifically mean a show. */
function openSeries(item) {
  location.hash = `#/series/${item.id}`;
}

/* ----------------------------------------------------------------- home ---

 * Reached from the badge rather than a tab. Built entirely from watch history
 * and favorites, so it renders without waiting on a library fetch — which is
 * the point of a landing page.
 */

/**
 * A history row carries its own name and poster, so it can be drawn before any
 * library has loaded. Playing it needs the real record, which is fetched on
 * the way into the player rather than up front.
 */
async function playFromHistory(row) {
  /* An archive title never was in the provider library, so looking it up
   * there ends in "no longer in the library" — the wrong words for a file
   * sitting on the drive. Its id carries its own path (`archive:<path>`),
   * which with the row's name, poster and resume key is everything the
   * player needs; the server's index answers for the rest at play time. */
  if (String(row.id || '').startsWith('archive:')) {
    return openPlayer({
      kind: 'movie',
      id: row.id,
      name: row.name || '',
      archivePath: String(row.id).slice('archive:'.length),
      localOnly: true,
      resumeKey: row.key || String(row.id),
      logo: row.poster || '',
    });
  }
  const tab = row.kind === 'series' ? 'series' : row.kind === 'live' ? 'live' : 'movies';
  const wantId = String(row.kind === 'series' ? row.seriesId ?? row.id : row.id);

  /* A copy on the box needs no catalogue.
   *
   * The file is downloaded and sitting on the drive; whether the provider
   * still lists it is beside the point, and asking is how a film somebody
   * owns came to be reported as gone. Same reasoning as the archive branch
   * above, which was written for the same complaint and stopped one case
   * short of this one. */
  const saved = savedCopy(row);
  if (saved) return openPlayer(saved);

  let item;
  try {
    item = await findTitle(tab, wantId);
  } catch {
    return toast(`Couldn't load ${tab}.`);
  } finally {
    loader.hide();
  }

  if (!item) return toast(missingWhy(tab));
  if (item.kind !== 'series') return openPlayer(item);

  // A show resumes into the episode itself. Landing on the show's page and
  // making someone find their place again is the exact work Continue watching
  // exists to skip.
  //
  // It still goes through the show's page to get there, for two reasons: the
  // episode list is the only thing that can turn a history row's episode
  // NUMBER into the index everything downstream wants, and it leaves the page
  // genuinely rendered underneath, so the player's Series button lands on it
  // with nothing further to load. The player is raised first so the page does
  // not flash past behind it while the episodes are fetched.
  const season = String(row.season || '');
  const episode = Number(row.episode) || 0;
  if (season && episode) {
    state.resumeEpisode = { seriesId: String(item.id), season, episode };
    preparePlayer(item);
    $('#cinemaSub').textContent = `S${season}E${episode}`;
    status('Finding the episode…');
  }
  openSeries(item);
}

/**
 * A leading provider tag, off a name that was stored before they came off.
 *
 * The box cleans titles on the way out of the library, but a favourite or a
 * history row keeps the name it had when it was saved — so a channel starred
 * in July still reads "US: FOX NEWS HD" on a page built in August. This is
 * the same shape rule the box uses, applied at the point of display only:
 * what is stored stays what was starred.
 */
const TRIM_TAG = /^([A-Za-z0-9+&]{1,5})\s*[-|:\u2013\u2022]\s*/;
function trimTag(raw) {
  let name = String(raw || '').trim();
  for (let i = 0; i < 4; i += 1) {
    const m = TRIM_TAG.exec(name);
    if (!m) break;
    const token = m[1].toUpperCase();
    if (token === 'XXX') break;
    if (!/^[A-Z0-9][A-Z0-9+&]*$/.test(m[1])) break;
    name = name.slice(m[0].length).trimStart();
  }
  return name || String(raw || '').trim();
}

/** How many channels the guide shows. The box caps it too; this is the row. */
const GUIDE_CHANNELS = 6;
/** Hours across the grid. More and the columns cannot hold a title. */
const GUIDE_HOURS = 4;
/** A page of guide. Every row is one call to a one-connection provider. */
const LISTINGS_MAX = 40;
/** How many times to go back for rows the box had not fetched yet. */
const GUIDE_PASSES = 8;
const GUIDE_PASS_MS = 1200;
/* How far the window moves when somebody asks what is on later, and how far
 * forward it will go at all.
 *
 * Two hours rather than four so the window overlaps itself: pressing Later
 * carries half of what was on screen with it, which reads as scrolling
 * rather than as being handed a fresh unrelated page. Eight is where it
 * stops because the box's own answer stops there — /api/epg/now returns a
 * twelve-hour window, and a ninth hour would be a grid of empty rows. */
const GUIDE_STEP = 2;
const GUIDE_MAX_AHEAD = 8;

/** How far into the window the listings view is looking, in hours. */
let guideOffset = 0;
/** What that offset belongs to, so a different list starts at now again. */
let guideScope = '';

/**
 * "What's on" — now and next, for the channels somebody favourited.
 *
 * The listings are real: this provider answers `get_short_epg` per channel,
 * and the player has been showing them since long before this. What is new
 * is asking about six channels at once, which is why it goes through the
 * box's own endpoint rather than firing six calls from here — see the
 * comment on /api/epg/now for what a single-connection provider does when
 * six metadata calls arrive while somebody is watching a film.
 *
 * Drawn in two passes on purpose. The row appears immediately with the
 * channel names, because those are already known and the landing page must
 * not wait on the provider for anything; the programmes drop in when they
 * arrive. If they never do — provider busy, no listings for that channel —
 * the row is still a perfectly good list of channels to press.
 */
async function paintGuide(section, channels, opts = {}) {
  section.innerHTML = '';

  /* The window the grid covers: whole hours, starting with this one — or
   * with a later one, if somebody has asked what is on then.
   *
   * Whole hours because the axis has to read as a clock — "8:00, 9:00,
   * 10:00" — and a grid that started at 8:47 would be a truthful axis nobody
   * can scan. Four of them is what fits before the columns are too narrow to
   * hold a programme title. */
  const offsetHours = Math.max(0, Math.min(GUIDE_MAX_AHEAD, Number(opts.offsetHours) || 0));
  const from = new Date();
  from.setMinutes(0, 0, 0);
  const startAt = from.getTime() / 1000 + offsetHours * 3600;
  const endAt = startAt + GUIDE_HOURS * 3600;
  const span = endAt - startAt;
  /** Where a moment falls across the window, 0 to 1. */
  const across = (at) => Math.min(1, Math.max(0, (at - startAt) / span));

  /* The redesign's own section heading — the crimson rule, the Bebas caps,
     the count. A section that invents its own heading beside them reads as
     something bolted on. */
  const head = el('div', 'shelf-head');
  const label = el('h2', 'shelf-title');
  label.textContent = opts.title || "Tonight's guide";
  const count = el('span', 'shelf-count');
  count.textContent = opts.count
    || `${channels.length} favorite channel${channels.length === 1 ? '' : 's'}`;
  head.append(label, count);

  /* Later, and back. Only where the page can redraw itself — the landing
     page's guide is a glance at what is on now and has nowhere to put a
     second state. */
  if (opts.onOffset) {
    const nav = el('div', 'guide-nav');

    const back = el('button', 'guide-nav-btn');
    back.type = 'button';
    back.textContent = '‹ Earlier';
    back.disabled = offsetHours <= 0;
    back.addEventListener('click', () => opts.onOffset(offsetHours - GUIDE_STEP));

    /* Says where the window is, and takes you back to now when it is not
       there — which is the only way out that does not need counting presses. */
    const when = el('button', 'guide-nav-when');
    when.type = 'button';
    when.textContent = offsetHours === 0 ? 'On now' : guideWhen(startAt);
    when.disabled = offsetHours === 0;
    when.title = offsetHours === 0 ? '' : 'Back to now';
    when.addEventListener('click', () => opts.onOffset(0));

    const on = el('button', 'guide-nav-btn');
    on.type = 'button';
    on.textContent = 'Later ›';
    on.disabled = offsetHours >= GUIDE_MAX_AHEAD;
    on.addEventListener('click', () => opts.onOffset(offsetHours + GUIDE_STEP));

    nav.append(back, when, on);
    head.append(nav);
  }
  section.append(head);

  section.dataset.from = String(startAt);
  section.dataset.span = String(span);

  const grid = el('div', 'guide-grid');

  const axis = el('div', 'guide-axis');
  axis.append(Object.assign(el('span', 'guide-axis-head'), { textContent: 'Channel' }));
  const hours = el('div', 'guide-hours');
  for (let i = 0; i < GUIDE_HOURS; i += 1) {
    const mark = el('span', 'guide-hour');
    mark.textContent = clockFromTimestamp(startAt + i * 3600);
    hours.append(mark);
  }
  axis.append(hours);
  grid.append(axis);

  const body = el('div', 'guide-body');
  const tracks = new Map();
  for (const channel of channels) {
    const row = el('div', 'guide-row');

    const who = el('div', 'guide-chan');
    // Favourites keep the name they had when they were starred, tags and
    // all, so a channel starred in July still reads "US: FOX NEWS HD".
    // Trimmed for display only — what is stored stays what was starred.
    who.append(Object.assign(el('span', 'guide-chan-name'),
      // Leading provider tag off, trailing encoding marks off. A guide row is
      // eleven characters wide before it starts truncating, and "20/20 ᴿᴬᵂ"
      // spends three of them saying how the stream is packed.
      { textContent: cleanCatName(trimTag(channel.name)) }));
    if (channel.num) {
      who.append(Object.assign(el('span', 'guide-chan-num'),
        { textContent: String(channel.num) }));
    }

    const track = el('div', 'guide-track');
    // Something to press while the listings are still coming, and something
    // to press for ever if they never do. A guide that cannot say what is on
    // is still a row of channels.
    const waiting = el('button', 'guide-prog is-blank');
    waiting.style.left = '0%';
    waiting.style.width = '100%';
    waiting.append(Object.assign(el('span', 'guide-prog-title'), { textContent: '' }));
    waiting.addEventListener('click', () => openPlayer(channel));
    track.append(waiting);

    row.append(who, track);
    tracks.set(String(channel.id), { track, channel });
    body.append(row);
  }
  grid.append(body);

  /* The line at now, and the dot on top of it. It is the one thing on the
     grid that says which of these is happening, and it is why the whole
     thing is worth drawing as a timeline rather than a list.

     Only when now is actually in the window: scrolled forward to eight
     o'clock, a line pinned to the left edge would be claiming the whole
     window is still ahead of itself. */
  const at = Date.now() / 1000;
  if (at >= startAt && at < endAt) {
    const line = el('div', 'guide-now-line');
    /* A unitless fraction, not a percentage. The line sits at
     *   calc(channel-column + --at * (100% - channel-column))
     * and calc() will multiply a NUMBER by a length-percentage but not a
     * percentage by one — written as `4%` the whole expression is invalid, the
     * declaration is dropped, and the line silently parks itself at the very
     * left edge of the panel looking like a border. */
    line.style.setProperty('--at', String(across(at)));
    line.append(el('i'));
    body.append(line);
  }

  section.append(grid);

  /* Filled in over several passes, not one.
   *
   * The box will only fetch a handful of channels per request — one call to
   * a single-connection provider each — so a page of forty comes back mostly
   * empty the first time and fills in as it is asked again. Which is the
   * right shape for it: rows appearing one at a time is a guide arriving,
   * and forty calls fired at once is a denial of service against yourself.
   *
   * It stops when nothing new arrived, so a category the provider has no
   * listings for costs a couple of requests rather than a poll for ever. */
  const waiting = new Set(tracks.keys());
  for (let pass = 0; pass < GUIDE_PASSES && waiting.size; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    const landed = await fillGuide(tracks, waiting, section);
    if (landed === null) return;                       // asked and refused
    if (!landed) break;                                // nothing new to wait for
    // eslint-disable-next-line no-await-in-loop
    if (waiting.size) await new Promise((r) => setTimeout(r, GUIDE_PASS_MS));
  }
  // Whatever never arrived says so, rather than sitting blank for ever.
  for (const id of waiting) {
    const held = tracks.get(id);
    const blank = held?.track.querySelector('.guide-prog-title');
    if (blank && !blank.textContent) blank.textContent = 'No listings';
  }
}

/**
 * One pass at the listings. Returns how many rows it filled, or null if the
 * box refused outright.
 */
async function fillGuide(tracks, waiting, section) {
  if (!section.isConnected) return null;               // the page moved on
  let data;
  try {
    data = await api('/api/epg/now', { ids: [...waiting].join(',') });
  } catch {
    // A guide that cannot be had is not an error worth a message.
    for (const id of waiting) {
      const blank = tracks.get(id)?.track.querySelector('.guide-prog-title');
      if (blank) blank.textContent = 'No listings';
    }
    waiting.clear();
    return null;
  }

  let filled = 0;
  const now = Date.now() / 1000;
  const startAt = Number(section.dataset.from);
  const span = Number(section.dataset.span);
  const across = (at) => Math.min(1, Math.max(0, (at - startAt) / span));
  const endAt = startAt + span;

  for (const channel of data.channels || []) {
    const held = tracks.get(String(channel.id));
    if (!held) continue;

    // Only what falls inside the window, and only what has somewhere to sit.
    const listings = (channel.listings || [])
      .filter((l) => l.stop > startAt && l.start < endAt)
      .sort((a, b) => a.start - b.start);

    /* Nothing yet is not the same as nothing at all.
     *
     * `known` is the box saying it asked and there was nothing, as against
     * it not having got to this channel — it only fetches a few per request.
     * Without the distinction a row either claims "no listings" about a
     * channel that has some, or sits blank for ten seconds waiting for an
     * answer that already came back empty. */
    if (!listings.length) {
      if (!channel.known) continue;
      waiting.delete(String(channel.id));
      const blank = held.track.querySelector('.guide-prog-title');
      if (blank) blank.textContent = 'No listings';
      continue;
    }

    waiting.delete(String(channel.id));
    filled += 1;
    held.track.innerHTML = '';
    for (const listing of listings) {
      const left = across(listing.start);
      const right = across(listing.stop);
      const slab = el('button', 'guide-prog');
      if (listing.start <= now && now < listing.stop) slab.classList.add('is-now');
      if (listing.stop <= now) slab.classList.add('is-past');
      slab.style.left = `${left * 100}%`;
      slab.style.width = `${Math.max(0.5, (right - left) * 100)}%`;
      slab.append(
        Object.assign(el('span', 'guide-prog-title'), { textContent: listing.title }),
        Object.assign(el('span', 'guide-prog-time'), {
          textContent: `${clockFromTimestamp(listing.start)} – ${clockFromTimestamp(listing.stop)}`,
        })
      );
      slab.title = `${listing.title}  ${clockFromTimestamp(listing.start)}`;
      /* What the slab is, in the two numbers the recording store keys on, so
         a slab drawn on one pass can be re-marked when a booking lands on
         another without redrawing the grid. */
      slab.dataset.chan = String(held.channel.id);
      slab.dataset.start = String(listing.start * 1000);
      slab.dataset.stop = String(listing.stop * 1000);
      stampRecording(slab);
      slab.addEventListener('click', () => programmePanel.open(held.channel, listing));
      held.track.append(slab);
    }
  }
  return filled;
}

/* ------------------------------------------------ recording from the guide
 *
 * The schedule already knows what is on and when it ends, which is every
 * argument a recording needs. So pressing a programme asks the question the
 * slab is standing there posing — watch it, or keep it — rather than doing
 * one of the two silently.
 *
 * The box's side of this has been there since the store went in: POST a
 * channel and two timestamps and the scheduler does the rest, opening the
 * file a minute early and closing it three minutes late so a programme that
 * runs over is still whole. Nothing on any screen had ever pressed it.
 */

/** Which day and hour a window begins, said the way somebody would say it. */
function guideWhen(startAt) {
  const start = new Date(startAt * 1000);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((day - midnight) / 86400000);
  const name = days <= 0 ? '' : days === 1 ? 'Tomorrow '
    : `${start.toLocaleDateString([], { weekday: 'short' })} `;
  return `${name}${clockFromTimestamp(startAt)}`;
}

/**
 * The recording for a programme, if there is one.
 *
 * Matched on the channel and the start rather than on a title: the same
 * programme name comes round every week, and the guide and the store agree
 * on nothing except the clock. A minute of slack because an EPG start and
 * the number that was posted for it can round differently.
 */
function recordingFor(channelId, startMs) {
  return (state.recordings || []).find((row) =>
    String(row.channelId) === String(channelId)
    && Math.abs(Number(row.startsAt) - Number(startMs)) < 60_000
    && row.status !== 'cancelled'
    && row.status !== 'failed'
    && row.status !== 'missed');
}

/** Mark one slab with what the box intends to do about it. */
function stampRecording(slab) {
  if (!slab.dataset.chan) return;
  const row = recordingFor(slab.dataset.chan, slab.dataset.start);
  slab.classList.toggle('is-rec', Boolean(row) && row.status !== 'done');
  slab.classList.toggle('is-kept', row?.status === 'done');
  let dot = slab.querySelector('.guide-prog-rec');
  if (row && !dot) {
    dot = el('i', 'guide-prog-rec');
    slab.prepend(dot);
  } else if (!row && dot) {
    dot.remove();
  }
}

/** Re-mark every slab on the page, after a booking or a cancellation. */
function restampGuide() {
  document.querySelectorAll('.guide-prog[data-chan]').forEach(stampRecording);
}

/**
 * What the box is recording. Cheap and local — no provider is touched — so
 * it is simply asked again rather than kept in step by hand.
 */
async function loadRecordings() {
  try {
    const data = await api('/api/recordings');
    state.recordings = data.items || [];
  } catch {
    // A guide that cannot say which rows are being kept is still a guide.
    state.recordings = state.recordings || [];
  }
  restampGuide();
}

/**
 * Pressing a programme.
 *
 * Two things somebody could mean and no way to tell them apart from the
 * press, so it asks: watch the channel now, or keep this programme. The
 * second is the only place in the product that starts a recording, which is
 * why it is also the place that says what recording costs — the box has a
 * fixed number of provider connections and one of them goes to the file for
 * as long as the programme runs.
 */
const programmePanel = {
  channel: null,
  listing: null,

  open(channel, listing) {
    this.channel = channel;
    this.listing = listing;
    $('#progError').hidden = true;
    $('#progModal').hidden = false;
    this.paint();
    // Asked every time it opens: the answer changes when the scheduler runs,
    // and this is the one moment somebody is looking at it.
    loadRecordings().then(() => { if (!$('#progModal').hidden) this.paint(); });
  },

  close() {
    $('#progModal').hidden = true;
    this.channel = null;
    this.listing = null;
  },

  /** The booking for what is open, or undefined. */
  booked() {
    if (!this.channel || !this.listing) return undefined;
    return recordingFor(this.channel.id, this.listing.start * 1000);
  },

  paint() {
    const { channel, listing } = this;
    if (!channel || !listing) return;
    const row = this.booked();
    const now = Date.now() / 1000;
    const over = listing.stop <= now;
    const on = listing.start <= now && !over;

    $('#progTitle').textContent = listing.title || cleanCatName(trimTag(channel.name));
    $('#progWhen').textContent = [
      guideWhen(listing.start),
      '–',
      clockFromTimestamp(listing.stop),
      on ? '· on now' : '',
    ].filter(Boolean).join(' ');
    $('#progChan').textContent = cleanCatName(trimTag(channel.name));

    const note = $('#progNote');
    if (row && row.status === 'recording') {
      note.textContent = 'Recording now. It is holding one of the box’s connections '
        + 'until the programme ends.';
    } else if (row && row.status === 'scheduled') {
      note.textContent = 'Set to record. The box starts a minute early and stops three '
        + 'minutes late, so an overrun is still whole.';
    } else if (row && row.status === 'done') {
      note.textContent = 'Recorded. It is on the box.';
    } else if (over) {
      note.textContent = 'This has already finished.';
    } else {
      note.textContent = 'Recording spends one provider connection for as long as the '
        + 'programme runs.';
    }
    note.hidden = false;

    const record = $('#progRecord');
    record.hidden = over && !row;
    record.textContent = !row ? (on ? 'Record the rest' : 'Record')
      : row.status === 'recording' ? 'Stop recording'
      : row.status === 'done' ? 'Delete the recording'
      : 'Don’t record';
    record.classList.toggle('btn-primary', !row);
    record.classList.toggle('btn-ghost', Boolean(row));

    $('#progWatch').textContent = `Watch ${cleanCatName(trimTag(channel.name))}`;
  },

  watch() {
    const channel = this.channel;
    this.close();
    if (channel) openPlayer(channel);
  },

  /** The one button that means four things, depending on what is already set. */
  async press() {
    const { channel, listing } = this;
    if (!channel || !listing) return;
    const row = this.booked();
    const error = $('#progError');
    error.hidden = true;
    const button = $('#progRecord');
    button.disabled = true;
    try {
      if (!row) {
        await this.send('/api/recordings', 'POST', {
          channelId: channel.id,
          channelName: channel.name,
          title: listing.title || cleanCatName(trimTag(channel.name)),
          subtitle: listing.subtitle || '',
          description: listing.description || '',
          startsAt: listing.start * 1000,
          endsAt: listing.stop * 1000,
          profileId: profiles.current?.id || '',
        });
        toast(listing.start * 1000 <= Date.now()
          ? 'Recording now.'
          : `Set to record at ${clockFromTimestamp(listing.start)}.`);
      } else if (row.status === 'done') {
        await this.send(`/api/recordings/${row.id}`, 'DELETE');
        toast('Deleted.');
      } else if (row.status === 'recording') {
        // Stopped, not thrown away: the half that was written is still worth
        // having, and DELETE is the only thing here that loses a file.
        await this.send(`/api/recordings/${row.id}`, 'POST');
        toast('Stopped. What was recorded is kept.');
      } else {
        await this.send(`/api/recordings/${row.id}`, 'DELETE');
        toast('Not recording it.');
      }
      await loadRecordings();
      this.paint();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  },

  /** api() takes query parameters, not a method and a body. */
  async send(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `the box answered ${res.status}`);
    return data;
  },
};

/**
 * Tell me what you love.
 *
 * The one part of For You anybody has to do by hand, and only ever once: a
 * new profile has no history and no ratings, and a recommender with no signal
 * has nothing to be clever with. The films offered come from the box — a
 * spread across shelves rather than forty off one, because a picker showing
 * forty horror films teaches it that this house likes horror.
 */
const seedPicker = {
  chosen: new Set(),
  /* Which row was being tuned. Films and shows are separate questions with
     separate answers, and saving one must not wipe the other. */
  tab: 'movies',

  open(tab) {
    this.tab = tab === 'series' ? 'series' : 'movies';
    this.chosen = new Set();
    $('#seedError').hidden = true;
    $('#seedModal').hidden = false;
    $('#seedTitle').textContent = this.tab === 'series'
      ? 'Which shows do you love?' : 'Which films do you love?';
    this.paint();
    this.paintKey();
    // The picks come with the recommendation, so a row that has never been
    // asked for has none to show yet.
    if (!forYouFor(this.tab).picks.length) {
      loadForYou({ force: true, tab: this.tab }).then(() => this.paint());
    }
  },

  close() {
    $('#seedModal').hidden = true;
  },

  paint() {
    const grid = $('#seedGrid');
    const picks = forYouFor(this.tab).picks;
    grid.innerHTML = '';
    if (!picks.length) {
      grid.append(Object.assign(el('p', 'health-note'), { textContent: 'Asking the box…' }));
      return;
    }
    for (const film of groupVariants(picks)) {
      const tile = el('button', 'seed-tile');
      tile.type = 'button';
      if (this.chosen.has(String(film.id))) tile.classList.add('on');
      if (film.logo) {
        const art = el('img');
        art.loading = 'lazy';
        art.alt = '';
        art.src = `/img?u=${encodeURIComponent(film.logo)}`;
        art.addEventListener('error', () => art.remove());
        tile.append(art);
      }
      tile.append(Object.assign(el('span', 'seed-name'), { textContent: film.name || '' }));
      tile.addEventListener('click', () => {
        const id = String(film.id);
        if (this.chosen.has(id)) this.chosen.delete(id);
        else this.chosen.add(id);
        tile.classList.toggle('on', this.chosen.has(id));
        this.paintCount();
      });
      grid.append(tile);
    }
    this.paintCount();
  },

  paintCount() {
    const n = this.chosen.size;
    $('#seedSave').disabled = n < 3;
    $('#seedSave').textContent = n < 3
      ? `Pick ${3 - n} more`
      : `Use these ${n}`;
  },

  /** Whether the box has a key, which is the only thing it will say about it. */
  async paintKey() {
    try {
      const data = await api('/api/tmdb');
      $('#seedKeyState').textContent = data.set ? '· on' : '· off';
      $('#seedKeyBox').classList.toggle('on', Boolean(data.set));
      $('#seedKey').placeholder = data.set
        ? 'Saved — paste another to replace it'
        : 'Paste the key or the read token';
    } catch {
      $('#seedKeyState').textContent = '';
    }
  },

  async saveKey() {
    const field = $('#seedKey');
    const error = $('#seedError');
    error.hidden = true;
    try {
      const res = await fetch('/api/tmdb', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: field.value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `the box answered ${res.status}`);
      // Never held in the page any longer than the keystroke that typed it.
      field.value = '';
      await this.paintKey();
      toast(data.set ? 'Saved. Suggestions will use it.' : 'Key removed.');
      // Both rows lean on it, so both are worked out again.
      await Promise.all([
        loadForYou({ force: true, tab: 'movies' }),
        loadForYou({ force: true, tab: 'series' }),
      ]);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  },

  async save() {
    const seeds = forYouFor(this.tab).picks
      .filter((film) => this.chosen.has(String(film.id)))
      .map((film) => ({ id: String(film.id), name: film.name || '' }));
    if (seeds.length < 3) return;
    const error = $('#seedError');
    error.hidden = true;
    $('#seedSave').disabled = true;
    try {
      const res = await fetch(`/api/profiles/${profiles.current.id}/seeds`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seeds, kind: forYouKind(this.tab) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `the box answered ${res.status}`);
      }
      this.close();
      toast('Thanks — working out what you might like.');
      await loadForYou({ force: true, tab: this.tab });
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      $('#seedSave').disabled = false;
    }
  },
};

$('#seedClose').addEventListener('click', () => seedPicker.close());
$('#seedSave').addEventListener('click', () => seedPicker.save());
$('#seedKeySave').addEventListener('click', () => seedPicker.saveKey());
$('#seedModal').addEventListener('click', (e) => {
  if (e.target.id === 'seedModal') seedPicker.close();
});

$('#progClose').addEventListener('click', () => programmePanel.close());
$('#progWatch').addEventListener('click', () => programmePanel.watch());
$('#progRecord').addEventListener('click', () => programmePanel.press());
$('#progModal').addEventListener('click', (e) => {
  if (e.target.id === 'progModal') programmePanel.close();
});

/**
 * Forget that a title was watched, without touching the title.
 *
 * Removed from the screen first and asked of the box after: the row is
 * already gone from view by the time anybody could notice the request, and
 * if the box refuses, it comes back with a word about why rather than a
 * card that silently returns on the next reload.
 */
async function forgetWatched(row) {
  const key = row.key || `${row.kind}:${row.seriesId ?? row.id}`;
  const before = state.recentlyWatched || [];
  state.recentlyWatched = before.filter((r) => (r.key || '') !== key);
  renderHome();
  try {
    const url = `/api/profiles/${profiles.current.id}/history`
      + `?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `the box answered ${res.status}`);
    }
    toast('Removed from Continue watching. It is still in your library.');
  } catch (err) {
    state.recentlyWatched = before;
    renderHome();
    toast(`Couldn't remove it: ${err.message}`);
  }
}

/** One poster on the home screen, from a history row rather than a library item. */
function homeCard(row, className) {
  const card = el('button', `card ${className}`);
  const art = el('div', 'card-art');

  if (row.poster) {
    const image = el('img');
    image.loading = 'lazy';
    image.alt = '';
    image.src = row.poster;
    image.addEventListener('error', () => {
      image.remove();
      const fb = el('div', 'fallback');
      fb.textContent = row.name || '';
      art.append(fb);
    });
    art.append(image);
  } else {
    const fb = el('div', 'fallback');
    fb.textContent = row.name || '';
    art.append(fb);
  }

  // Same stripe the grids use, so a part-watched title reads the same here.
  const ratio = row.duration && row.position ? row.position / row.duration : 0;
  if (ratio > 0.01 && ratio < RESUME_MAX_RATIO && !row.completed) {
    const bar = el('div', 'card-progress');
    const fill = el('i');
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    bar.append(fill);
    art.append(bar);
  }

  const title = el('h3', 'card-title');
  title.textContent = row.seriesName || row.name || '';
  card.append(art, title);

  if (row.season && row.episode) {
    const sub = el('p', 'card-sub');
    sub.textContent = `S${row.season}·E${row.episode}`;
    card.append(sub);
  }

  card.addEventListener('click', () => playFromHistory(row));

  /* Take it off the landing page, and nothing more than that.
   *
   * Continue watching fills with things half-started and abandoned — a film
   * somebody sat through ten minutes of and gave up on sits at the front of
   * the house for weeks. This forgets that it was watched. It is NOT a
   * deletion: the title stays in the library, stays searchable, stays in
   * favourites. Hiding a title from the library is a different decision and
   * lives behind Deleted in the sidebar, with its own way back.
   *
   * Its own element rather than a corner of the card, because the card is a
   * button and a button inside a button is not a thing.
   */
  const drop = el('span', 'home-drop');
  // A span, not a button: the card itself IS a button and one cannot be
  // nested inside another. The role and the key handling are what a button
  // would have given it, and this way the card keeps its class, its layout
  // and its click exactly as they were.
  drop.setAttribute('role', 'button');
  drop.setAttribute('tabindex', '0');
  drop.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  drop.title = 'Remove from Continue watching';
  drop.setAttribute('aria-label',
    `Remove ${row.seriesName || row.name || 'this'} from Continue watching`);
  const forget = async (event) => {
    event.stopPropagation();
    event.preventDefault();
    await forgetWatched(row);
  };
  drop.addEventListener('click', forget);
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') forget(event);
  });
  art.append(drop);

  return card;
}


/**
 * One favorite, as a tile you press to open it.
 *
 * These used to be four thumbnails inside a box that opened the favorites
 * list — a preview of a page rather than the things themselves, so getting to
 * anything took two clicks and the first one was never the one you wanted.
 */
function homeFavTile(item) {
  const shape = item.kind === 'live' ? 'is-logo' : 'is-poster';
  const card = el('button', `card home-tile ${shape}`);
  const art = el('div', 'card-art');

  const fallback = () => {
    const fb = el('div', 'fallback');
    fb.textContent = item.name || '';
    art.append(fb);
  };
  if (item.logo) {
    const image = el('img');
    image.loading = 'lazy';
    image.alt = '';
    image.src = item.logo;
    image.addEventListener('error', () => { image.remove(); fallback(); });
    art.append(image);
  } else {
    fallback();
  }

  const title = el('h3', 'card-title');
  title.textContent = item.name || '';
  card.append(art, title);
  // A channel tunes in, a film or a show opens its page — the same rule the
  // grids follow, so a poster does the same thing wherever it is pressed.
  card.addEventListener('click', () => openTitle(item));
  return card;
}

/**
 * One favorites column: a heading, a row of tiles, and a way through to the
 * full list when there are more than fit.
 *
 * A column rather than a row of its own, because the two of them sit side by
 * side — stacked, they push the page past the bottom of the screen, which is
 * the one thing this layout is for.
 */
function homeFavColumn({ title, items, hash, empty, shown }) {
  const col = el('section', 'home-fav-col');

  const head = el('div', 'home-row-head');
  const label = el('h2', 'home-label');
  label.textContent = title;
  head.append(label);
  if (items.length > shown) {
    const more = el('button', 'home-more');
    more.textContent = `All ${items.length.toLocaleString()} ›`;
    more.addEventListener('click', () => { location.hash = hash; });
    head.append(more);
  }
  col.append(head);

  if (!items.length) {
    const none = el('p', 'home-empty');
    none.textContent = empty;
    col.append(none);
    return col;
  }

  const grid = el('div', 'home-tiles');
  for (const item of items.slice(0, shown)) grid.append(homeFavTile(item));
  col.append(grid);
  return col;
}

/**
 * Live TV as a schedule rather than a grid of channels.
 *
 * The same guide the landing page carries, pointed at whatever is on this
 * page instead of at favourites — so a category is a category's schedule,
 * and All is the first page of everything. It answers a different question
 * from the grid: the grid is "which channel", this is "what is on".
 *
 * Capped, and the cap is not shyness. Every row is one call to a provider
 * with a single connection, so a category of four hundred channels asked
 * about at once is an evening of nothing working. Forty is a page of guide.
 */
function renderListings() {
  const grid = $('#grid');
  grid.hidden = false;
  grid.className = 'grid is-listings';
  grid.innerHTML = '';
  $('#loadMore').hidden = true;
  $('#emptyState').hidden = true;

  const source = state.library.live;
  if (!source) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = 'Live TV has not loaded yet.';
    return;
  }

  const inCategory = state.category !== null && state.category !== DELETED_CATEGORY;
  let channels = browsable(source.items).filter((i) => !profiles.isDeleted(i));

  /* Inside a category, that category. Outside one, YOUR CHANNELS.
   *
   * "All of Live TV" is eleven thousand channels and a schedule of the first
   * forty of them alphabetically is a list of things nobody watches. The
   * favourites are the answer to "what's on" for anyone who has set any; the
   * whole lot is only the answer for somebody who has not. */
  const favIds = new Set((profiles.favItems ? profiles.favItems() : [])
    .filter((i) => i.kind === 'live').map((i) => String(i.id)));
  let scope = 'all';
  if (inCategory) {
    channels = channels.filter((i) => String(i.categoryId) === String(state.category));
    scope = 'category';
  } else if (favIds.size) {
    channels = channels.filter((i) => favIds.has(String(i.id)));
    scope = 'favourites';
  }

  const where = inCategory
    ? (source.categories.find((c) => String(c.id) === String(state.category))?.name
       || 'this category')
    : 'Live TV';
  $('#contentTitle').textContent = cleanCatName(where);

  if (!channels.length) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = 'No channels here to build a schedule from.';
    return;
  }

  const shown = channels.slice(0, LISTINGS_MAX);

  /* Where the window was left. Kept across a redraw of the same list — the
     grid repaints for all sorts of reasons and losing your place every time
     would make scrolling forward useless — and reset when the list itself
     changes, because "two hours into the sports category" means nothing once
     the category is football. */
  const key = `${scope}:${state.category ?? ''}`;
  if (guideScope !== key) {
    guideScope = key;
    guideOffset = 0;
  }

  /* Each window is a new section rather than the same one repainted. The
     fill runs in passes over a second or so, and a pass checks whether its
     section is still on the page before it does anything with the answer —
     so replacing the element is what stops the outgoing window's requests
     from landing in the incoming one. */
  let current = null;
  const draw = (offset) => {
    guideOffset = Math.max(0, Math.min(GUIDE_MAX_AHEAD, offset));
    const next = el('section', 'home-guide listings-guide');
    if (current) current.replaceWith(next);
    else grid.append(next);
    current = next;
    paintGuide(next, shown, {
      title: scope === 'favourites' ? "What's on your channels" : "What's on",
      count: shown.length < channels.length
        ? `first ${shown.length} of ${channels.length.toLocaleString()}`
        : `${shown.length} channel${shown.length === 1 ? '' : 's'}`,
      offsetHours: guideOffset,
      onOffset: draw,
    });
  };
  draw(guideOffset);
  // What is already being kept, so the slabs can say so as they are drawn.
  loadRecordings();

  $('#contentMeta').textContent = shown.length < channels.length
    ? `Showing ${shown.length} of ${channels.length.toLocaleString()} channels`
    : '';
}

function renderHome() {
  // render() hides everything before its branches now; this list survives
  // only as a belt for any future direct call.
  $('#grid').hidden = true;
  $('#rowsView').hidden = true;
  $('#downloadList').hidden = true;
  $('#archiveView').hidden = true;
  $('#emptyState').hidden = true;
  $('#loadMore').hidden = true;
  document.querySelectorAll('.folder-back').forEach((b) => b.remove());
  const shell = document.querySelector('.app-shell');
  shell.classList.add('no-sidebar');
  // This is the one page built to fit the window rather than scroll, so it
  // does not want the run-off room every other view is padded for.
  shell.classList.add('is-home');

  const view = $('#homeView');
  view.hidden = false;
  view.innerHTML = '';

  // One row per title: series history is per-episode, and five cards of the
  // same show is not a landing page.
  const seen = new Set();
  const recent = [];
  for (const row of state.recentlyWatched || []) {
    const key = `${row.kind}:${row.seriesId ?? row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(row);
    if (recent.length === 5) break;
  }

  if (recent.length) {
    const section = el('section', 'home-recent');
    const label = el('h2', 'home-label');
    label.textContent = 'Continue watching';
    section.append(label);

    const layout = el('div', 'home-recent-layout');
    layout.append(homeCard(recent[0], 'home-hero'));

    // The four alongside stay a 2×2 even with fewer than four to show, so the
    // hero keeps its proportions instead of stretching to fill the row.
    const quad = el('div', 'home-quad');
    for (const row of recent.slice(1, 5)) quad.append(homeCard(row, 'home-quad-card'));
    layout.append(quad);

    section.append(layout);
    view.append(section);
  }

  const favs = profiles.favItems();
  const channels = favs.filter((i) => i.kind === 'live');
  const titles = favs.filter((i) => i.kind !== 'live');

  // Side by side, and capped at what one line of a column holds: this is a
  // landing page, and the full list is one press away.
  const SHOWN = 6;
  const favRow = el('section', 'home-favs');
  favRow.append(
    homeFavColumn({
      title: 'Favorite channels',
      items: channels,
      hash: '#/favlive',
      empty: 'No favorite channels yet — tap the heart while watching one.',
      shown: SHOWN,
    }),
    homeFavColumn({
      title: 'Favorite movies & shows',
      items: titles,
      hash: '#/favorites',
      empty: 'No favorites yet — tap the heart while watching something.',
      shown: SHOWN,
    })
  );
  view.append(favRow);

  // What is on right now, for the channels this profile actually watches.
  // Appended empty and filled in behind, because the listings come from the
  // provider and the landing page is not allowed to wait on the provider.
  if (channels.length) {
    const guide = el('section', 'home-guide');
    view.append(guide);
    paintGuide(guide, channels.slice(0, GUIDE_CHANNELS));
  }

  if (!recent.length && !favs.length) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent =
      'Nothing here yet. Watch something and it will show up on this page.';
  }

  // Lives inside the home view rather than the page, so leaving home takes it
  // away without anything having to remember to hide it.
  const stamp = el('span', 'home-version');
  stamp.textContent = `v${VERSION}`;
  stamp.title = 'Version running in this browser';
  view.append(stamp);

  $('#contentMeta').textContent = profiles.current ? profiles.current.name : '';
}

/* ------------------------------------------------------- one title ---
 *
 * A show or a film gets its own page: the poster on the left, everything known
 * about it on the right, and whatever you do with it — pick an episode, press
 * play — underneath.
 *
 * Both used to happen inside the player. Opening a series put an empty video
 * frame on screen with a list of episodes below it, and a film's synopsis was
 * only readable once it was already playing. The player is left to do the one
 * thing it is for, and the library keeps the browsing.
 */
function detailCard(item, backHash, backLabel) {
  // render() hides everything before its branches now, but the card is also
  // reached by direct calls; the list stays so those arrive clean too.
  $('#grid').hidden = true;
  $('#rowsView').hidden = true;
  $('#downloadList').hidden = true;
  $('#emptyState').hidden = true;
  $('#loadMore').hidden = true;
  $('#homeView').hidden = true;
  $('#archiveView').hidden = true;
  document.querySelectorAll('.folder-back').forEach((b) => b.remove());

  const view = $('#seriesView');
  view.hidden = false;
  view.innerHTML = '';
  $('#contentMeta').textContent = '';

  const back = el('button', 'btn btn-ghost folder-back show-back');
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  back.append(document.createTextNode(` ${backLabel}`));
  back.addEventListener('click', () => { location.hash = backHash; });

  /* A film's page and a show's page are the same card with different things in
     it, and on a phone that difference matters to the artwork. A show stacks a
     season's worth of episodes underneath, so its poster comes down to a strip
     to keep them in reach; a film has one button and a runtime under it, and
     shrinking its poster to the same strip buys room for nothing. */
  const card = el('div', 'show-card');
  card.classList.add(item.kind === 'series' ? 'is-show' : 'is-film');
  const posterWrap = el('div', 'show-poster');
  if (item.logo) {
    const image = el('img');
    image.alt = '';
    // Straight through: loadTab already ran every library item's logo through
    // img(), so these arrive as `/img?u=…` proxy paths. Wrapping again made a
    // URL pointing the proxy at itself, which failed and fell back to printing
    // the title where the poster should be.
    image.src = item.logo;
    image.addEventListener('error', () => {
      image.remove();
      const fb = el('div', 'fallback');
      fb.textContent = item.name;
      posterWrap.append(fb);
    });
    posterWrap.append(image);
  } else {
    const fb = el('div', 'fallback');
    fb.textContent = item.name;
    posterWrap.append(fb);
  }

  const body = el('div', 'show-body');
  const heading = el('h2', 'show-title');
  heading.textContent = item.name;

  /* The switcher, when the provider sells this title more than once.
   *
   * Under the name rather than beside it: these are the same film, and the
   * choice between them is which copy to watch, not which film. One copy
   * gets no switcher at all — a row of tabs with a single tab on it is
   * furniture pretending to be a decision.
   */
  const tab = item.kind === 'series' ? 'series' : 'movies';
  const copies = variantsOf(tab, item);
  const picker = el('div', 'variant-pick');
  if (copies.length > 1) {
    for (const copy of copies) {
      const chip = el('button', 'variant-chip');
      chip.textContent = variantLabel(tab, copy);
      if (copy.uhd && !/4K/i.test(chip.textContent)) {
        chip.append(Object.assign(el('span', 'variant-4k'), { textContent: '4K' }));
      }
      if (String(copy.id) === String(item.id)) chip.classList.add('is-active');
      chip.addEventListener('click', () => {
        if (String(copy.id) === String(item.id)) return;
        location.hash = `#/${tab}/${copy.id}`;
      });
      picker.append(chip);
    }
  }

  const meta = el('p', 'show-meta');
  const plot = el('p', 'show-plot');
  plot.hidden = true;

  const fav = el('button', 'btn btn-ghost btn-sm show-fav');
  fav.textContent = profiles.hasFav(item) ? 'In favorites' : 'Add to favorites';
  fav.addEventListener('click', () => {
    const added = profiles.toggleFav(item);
    fav.textContent = added ? 'In favorites' : 'Add to favorites';
    toast(added ? 'Added to favorites.' : 'Removed from favorites.');
  });

  const actions = el('div', 'show-actions');
  actions.append(fav);

  /* Like and not-for-me, on the show's page as well as the film's.
   *
   * A show could be watched, favourited and finished and never tell the box
   * whether it was any good: the thumbs were built into the film page and
   * nowhere else, so half the library had no way to say the one thing For You
   * is made of.
   *
   * Beside Add to favorites because that is the row of things you do to a
   * title WITHOUT playing it, which is exactly what this is — a favourite
   * says "keep this where I can find it", a thumb says "more like this", and
   * neither of them starts anything. */
  const rating = ratingButtons(item);
  rating.classList.add('is-inline');
  actions.append(rating);

  // Films get a download beside it. Shows manage theirs per episode and per
  // season down in the list, and the archive is already on the box.
  if (item.kind === 'movie' && !item.archivePath && !item.localOnly) {
    const dl = el('button', 'btn btn-ghost btn-sm show-dl');
    const paintDl = () => {
      const have = downloadJobFor('movie', item.id);
      dl.textContent = have
        ? have.status === 'done' ? 'Downloaded' : 'In the queue'
        : 'Download';
      dl.classList.toggle('is-saved', have?.status === 'done');
    };
    paintDl();
    dl.addEventListener('click', async () => {
      await requestDownload(item);
      paintDl();
    });
    actions.append(dl);
  }

  const mount = el('div', 'show-episodes');
  body.append(heading, picker, meta, plot, actions, mount);
  card.append(posterWrap, body);
  view.append(back, card);

  /** Fill the meta line and synopsis from whatever the provider knows. */
  const describe = ({ year, genre, plot: text, extra }) => {
    meta.textContent = [year, genre, item.rating ? `★ ${item.rating}` : '', extra]
      .filter(Boolean).join(' · ');
    if (text) {
      plot.textContent = text;
      plot.hidden = false;
    }
  };

  return { mount, describe };
}

async function renderShowCard() {
  $('#contentTitle').textContent = 'Series';
  // Looking a title up can now go to the box for the wide catalogue, so
  // this can land on a page somebody has already left. Whatever they are
  // looking at now wins.
  const wanted = state.seriesId;
  let item;
  try {
    item = await findTitle('series', wanted);
  } catch (err) {
    if (state.seriesId !== wanted) return;
    return missingTitle(`Couldn't load the series list — ${err.message}`);
  }
  if (state.seriesId !== wanted) return;
  if (!item) return missingTitle('That show is no longer in the library.');

  const { mount, describe } = detailCard(item, '#/series', 'All series');
  renderSeries(item, mount, (info) =>
    describe({ year: info.releaseDate, genre: info.genre, plot: info.plot }));
}

/* ------------------------------------------------------------- a film ---
 *
 * A film's page, which stopped being a show's page.
 *
 * Both used to be detailCard(): a poster, a name, one line of facts and a
 * button. That card also had to hold a season of episodes, so everything a
 * film knows about itself — who made it, who is in it, what the file actually
 * is, where this profile stopped — either had nowhere to go or went onto the
 * end of the meta line. What reached the screen was a fraction of what the box
 * already had in hand.
 *
 * So: the backdrop is the page, the decision sits on top of it, and the rest
 * is laid out underneath in the order somebody reads it — the credits, the
 * cast, what the file actually is, and what else in the same category is worth
 * the next two hours. The column on the right is the three things that are
 * about YOU rather than about the film: whether it is on the box, what you
 * have done with it, and where to go and read more.
 *
 * A show keeps detailCard(). Its page is a season and a list, which is a
 * different shape with a different question at the top of it, and pretending
 * the two were one card is most of why this one was thin.
 *
 * Everything on it is the provider's own answer. Two things a film page
 * usually carries are missing because an Xtream panel does not know them — a
 * character name beside a cast member, and a certificate — and they are left
 * out rather than filled in with something likely. get_vod_info does carry
 * `tmdb_id`, so both are one API key away the day they are wanted.
 */

/* The line glyphs this page draws, on the same 24-box terms as every other
   icon in the product — the same paths as the standalone files in /icons,
   inlined because the page draws a dozen of them and twelve paths is not
   worth twelve requests to the Pi. */
const FILM_ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3v5h-5"/>',
  heart: '<path d="M12 21s-7.5-4.9-9.3-9.2C1.3 8.4 3.2 5 6.6 5c2 0 3.5 1.2 4.4 2.4l1 '
    + '1.3 1-1.3C13.9 6.2 15.4 5 17.4 5c3.4 0 5.3 3.4 3.9 6.8C19.5 16.1 12 21 12 21z"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  check: '<path d="M5 13l4 4 10-10"/>',
  globe: '<circle cx="12" cy="12" r="9"/>'
    + '<path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/>',
};

function filmIcon(name) {
  const box = el('span');
  box.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${FILM_ICON[name]}</svg>`;
  return box.firstElementChild;
}

/* Two things this page does not say, because nobody has told the box.
 *
 * A CERTIFICATE and a CHARACTER NAME are both TMDB's to answer. Xtream's
 * get_vod_info gives a flat comma-separated `cast` string with nothing about
 * who anybody played, and most panels carry no certificate at all. Both were
 * briefly filled from a table of likely answers — a cast member's second line
 * from their position in the list, a certificate from the genre — and both
 * are gone: a page that says "R" over a film nobody has rated is not laying
 * out around a hole, it is stating something it made up.
 *
 * Where a panel DOES carry a certificate it is shown; see filmCertificate.
 * get_vod_info also carries `tmdb_id`, so the real source is one API key
 * away whenever it is wanted. */

/** A certificate, only when the provider actually carries one. Panels differ
    on the field, and every one of these is the provider's own answer. */
function filmCertificate(info) {
  const said = info?.mpaa_rating ?? info?.certification ?? info?.age ?? '';
  const text = String(said).trim();
  // '0' and 'N/A' are how panels write "we do not know" — which is not a
  // certificate, and must not be drawn as one.
  if (!text || /^(0|n\/?a|none|null|unknown)$/i.test(text)) return '';
  return text.toUpperCase();
}

/** This profile's history row for a film. The resume point, the play count and
    the date in the sidebar all come from it. */
function filmHistory(item) {
  const key = resumeKeyFor(item);
  return (state.recentlyWatched || []).find(
    (row) => row.kind === 'movie' && row.key === key) || null;
}

/** A rail with a heading, a count and the two arrows that scroll it. Used for
    the cast and for the rest of the category, which are the same furniture
    with different cards in them. */
function filmRail(title, count) {
  const rail = el('section', 'film-rail');

  const head = el('div', 'film-rail-head');
  const heading = el('h2');
  heading.textContent = title;
  const tally = el('span', 'film-rail-count');
  tally.textContent = count;
  head.append(heading, tally);

  const track = el('div', 'film-rail-track');
  const arrows = el('div', 'film-rail-arrows');
  for (const [way, icon] of [[-1, 'back'], [1, 'next']]) {
    const arrow = el('button', 'film-rail-arrow');
    arrow.type = 'button';
    arrow.setAttribute('aria-label', way < 0 ? 'Scroll back' : 'Scroll on');
    arrow.append(filmIcon(icon));
    // A card and a half, so the row lands somewhere a card starts rather than
    // halfway through one.
    arrow.addEventListener('click', () => {
      track.scrollBy({ left: way * Math.round(track.clientWidth * 0.8), behavior: 'smooth' });
    });
    arrows.append(arrow);
  }
  head.append(arrows);

  rail.append(head, track);
  return { rail, track };
}

/** One of the sidebar's three cards: a caps heading over a body. */
function filmPanel(heading) {
  const panel = el('section', 'film-panel');
  const head = el('div', 'film-panel-head');
  head.textContent = heading;
  const body = el('div', 'film-panel-body');
  panel.append(head, body);
  return { panel, body, head };
}

/** A labelled row in the credits block — Director, Writers, Genres. */
function filmCreditRow(grid, label) {
  const name = el('span', 'film-credit-label');
  name.textContent = label;
  const value = el('div', 'film-credit-value');
  grid.append(name, value);
  return value;
}

/** A credit drawn as a chip that goes somewhere. */
function filmCreditChip(text, onClick) {
  const chip = el(onClick ? 'button' : 'span', 'film-chip');
  if (onClick) {
    chip.type = 'button';
    chip.addEventListener('click', onClick);
  }
  chip.textContent = text;
  return chip;
}

/**
 * How much of the card is spoken for, and by whom.
 *
 * The numbers are the ones the Downloads page and the server both work from:
 * the profile's own allowance out of prefs, what its jobs weigh out of the
 * queue, and the free space the box reports. The 2 GB floor is SPACE_RESERVE
 * in server.js — the point below which a download refuses to start rather
 * than filling the card and taking the portal down with it.
 */
function filmBoxNumbers() {
  const limit = profiles.data?.downloadLimit;
  const capped = Number.isFinite(limit) && limit > 0;
  const mine = profiles.current?.id || '';
  const used = (state.downloads.items || [])
    .filter((job) => job.profileId === mine)
    .reduce((n, job) => n + Math.max(Number(job.bytes) || 0, Number(job.total) || 0), 0);

  return {
    capped,
    used,
    limit,
    label: capped
      ? `${formatBytes(used)} of ${(limit / 1073741824).toFixed(0)} GB`
      : `No limit (${(profiles.current?.name || 'you').toLowerCase()})`,
    percent: capped ? Math.min(100, (used / limit) * 100) : 100,
    tone: capped && used / limit > 0.8 ? 'warn' : 'ok',
    free: Number.isFinite(state.downloads.freeBytes) ? state.downloads.freeBytes : null,
  };
}

/**
 * A film's page.
 *
 * Painted in two passes, because the second one costs a round trip through a
 * box with one provider connection. Everything the library already holds — the
 * poster, the name, the rating, where this profile stopped, whether it is on
 * the box — goes up straight away; describe() fills in what the provider says
 * when it says it. Filling in rather than redrawing, so nothing you had
 * started reading moves under you when the answer lands.
 */
function filmCard(item) {
  $('#grid').hidden = true;
  $('#rowsView').hidden = true;
  $('#downloadList').hidden = true;
  $('#emptyState').hidden = true;
  $('#loadMore').hidden = true;
  $('#homeView').hidden = true;
  $('#archiveView').hidden = true;
  document.querySelectorAll('.folder-back').forEach((b) => b.remove());

  const view = $('#seriesView');
  view.hidden = false;
  view.innerHTML = '';
  view.classList.add('film-page');
  $('#contentMeta').textContent = '';
  // The page head is the film's own title at 76px; "MOVIES" set over the top
  // of that says nothing the backdrop has not already said. Same treatment as
  // Home, and taken off again by render() on the way out.
  document.querySelector('.app-shell').classList.add('is-film', 'no-sidebar');
  document.querySelectorAll('.film-hero').forEach((old) => old.remove());

  const history = filmHistory(item);
  const at = watchedProgress(item);
  const runtimeSeconds = history?.duration || 0;

  /* ------------------------------------------------------------ the hero */
  const hero = el('header', 'film-hero');

  // The backdrop is the whole hero, with the scrims over it — so the picture
  // keeps going under the words rather than stopping at a box. Nothing is
  // known to put in it until the provider answers, and an empty one is the
  // fallback tile rather than a hole.
  const art = el('div', 'film-art');
  const scrims = el('div', 'film-scrims');
  hero.append(art, scrims);

  const heroInner = el('div', 'film-hero-inner');

  const category = (state.library.movies?.categories || [])
    .find((c) => String(c.id) === String(item.categoryId));
  const inCategory = (state.library.movies?.items || [])
    .filter((other) => String(other.categoryId) === String(item.categoryId)
      && !profiles.isDeleted(other));

  const back = el('button', 'film-back show-back');
  back.type = 'button';
  back.append(filmIcon('back'));
  back.append(document.createTextNode(category
    ? `${category.name} · ${inCategory.length.toLocaleString()}`
    : 'All movies'));
  back.addEventListener('click', () => { location.hash = '#/movies'; });
  heroInner.append(back);

  const stage = el('div', 'film-stage');

  /* ---- the poster, which is also the progress bar ---- */
  const posterWrap = el('div', 'film-poster');
  if (item.logo) {
    const image = el('img');
    image.alt = '';
    // Straight through: loadTab has already run every library logo through
    // img(), so these arrive as `/img?u=…`. Wrapping a proxied path again
    // points the proxy at itself, which fails and prints the title instead.
    image.src = item.logo;
    image.addEventListener('error', () => {
      image.remove();
      const fb = el('div', 'fallback');
      fb.textContent = item.name;
      posterWrap.append(fb);
    });
    posterWrap.append(image);
  } else {
    const fb = el('div', 'fallback');
    fb.textContent = item.name;
    posterWrap.append(fb);
  }

  /* The badge says what the file IS, not what a film of this sort usually is.
     It read '4K' off the provider's tag and '1080P' off nothing at all, over a
     library that carries plenty of 720p and worse. The real answer is in the
     ffprobe block get_vod_info returns, so the badge starts empty and is
     filled by describe() below once that has arrived. */
  const quality = el('span', 'film-poster-badge');
  quality.hidden = true;
  if (item.uhd) {
    // The one thing knowable before the details land: the provider's own 4K
    // tag, which is what the grid badges the card with too.
    quality.textContent = '4K';
    quality.hidden = false;
  }
  posterWrap.append(quality);

  if (at > 0) {
    const bar = el('div', 'film-poster-progress');
    const fill = el('i');
    fill.style.width = `${Math.min(100, at * 100)}%`;
    bar.append(fill);
    posterWrap.append(bar);
  }

  /* ---- the copy beside it ---- */
  const copy = el('div', 'film-copy');

  // Where you are, above the name: the section, then what kind of film it is
  // once the provider has said. The back pill says where you came FROM, which
  // is a different question and can be a different answer — a category and a
  // genre are not the same thing on this provider.
  const eyebrowRow = el('div', 'film-eyebrow-row');
  const eyebrow = el('span', 'film-eyebrow');
  eyebrow.textContent = 'Movies';
  eyebrowRow.append(eyebrow);

  // What this copy is doing, as against what it is. Only ever one of them, and
  // only when it is true — a row of greyed-out states nobody is in is furniture.
  const job = downloadJobFor('movie', item.id);
  if (job && job.status === 'done') {
    const pill = el('span', 'film-state is-saved');
    pill.textContent = 'ON THE BOX';
    eyebrowRow.append(pill);
  } else if (job) {
    const pill = el('span', 'film-state is-downloading');
    pill.textContent = 'DOWNLOADING';
    eyebrowRow.append(pill);
  }

  const heading = el('h1', 'film-title');
  heading.textContent = item.name;
  const year = el('span', 'film-year');
  heading.append(year);

  const meta = el('div', 'film-meta');
  const tagline = el('p', 'film-tagline');
  tagline.hidden = true;
  const plot = el('p', 'film-plot');
  plot.hidden = true;

  /* ---- the decision ---- */
  const actions = el('div', 'film-actions');

  const play = el('button', 'btn btn-primary play-title');
  play.append(filmIcon('play'));
  const playLabel = document.createTextNode(
    at > 0 && history?.position ? ` Resume ${hms(history.position)}` : ' Play');
  play.append(playLabel);
  // The page has already made the resume choice — that is what the two buttons
  // ARE — so the player is told rather than asked. Putting its modal up on top
  // of them would be the same question twice.
  play.addEventListener('click', () => openPlayer(item, { resume: at > 0 ? 'resume' : 'ask' }));
  actions.append(play);

  const restart = el('button', 'btn btn-ghost film-restart');
  restart.append(filmIcon('reload'));
  restart.append(document.createTextNode(' Start over'));
  restart.addEventListener('click', () => openPlayer(item, { resume: 'restart' }));
  actions.append(restart);

  actions.append(el('span', 'film-action-rule'));

  const fav = el('button', 'icon-btn film-icon-btn show-fav');
  const paintFav = () => {
    const on = profiles.hasFav(item);
    fav.classList.toggle('is-on', on);
    fav.title = on ? 'In favorites' : 'Add to favorites';
    fav.setAttribute('aria-label', fav.title);
    fav.setAttribute('aria-pressed', String(on));
  };
  fav.append(filmIcon('heart'));
  paintFav();
  fav.addEventListener('click', () => {
    const added = profiles.toggleFav(item);
    paintFav();
    toast(added ? 'Added to favorites.' : 'Removed from favorites.');
  });
  actions.append(fav);

  // Films get a download of their own. Shows manage theirs per episode down in
  // the list, and a file already on the archive drive is on the box by
  // definition — asking the provider for a second copy of it is nothing.
  let download = null;
  if (!item.archivePath && !item.localOnly) {
    download = el('button', 'icon-btn film-icon-btn show-dl');
    download.append(filmIcon('download'));
    const paintDownload = () => {
      const have = downloadJobFor('movie', item.id);
      download.classList.toggle('is-saved', have?.status === 'done');
      download.title = have
        ? have.status === 'done' ? 'Downloaded' : 'In the queue'
        : 'Download to the box';
      download.setAttribute('aria-label', download.title);
    };
    paintDownload();
    download.addEventListener('click', async () => {
      await requestDownload(item);
      paintDownload();
    });
    actions.append(download);
  }

  const hide = el('button', 'icon-btn film-icon-btn film-hide');
  hide.append(filmIcon('trash'));
  hide.title = 'Hide this — it stops showing in lists and search';
  hide.setAttribute('aria-label', hide.title);
  hide.addEventListener('click', () => {
    profiles.toggleDeleted(item);
    toast(`Hid “${item.name}”. It's in Deleted.`);
    // Back to the grid, because staying would leave you on the page of
    // something that is no longer in any list you can reach it from.
    location.hash = '#/movies';
  });
  actions.append(hide);

  const left = el('span', 'film-left');
  actions.append(left);

  /* The switcher, when the provider sells this title more than once.
   *
   * Under the decision rather than beside the name: three rows of the same
   * film become one card in the grid, so this is the only way to reach the
   * 4K copy, or the one with the language you want. It came off the page
   * with the card it used to live on — which quietly made the deduplication
   * a way of hiding copies rather than tidying them. One copy gets no
   * switcher: a row of tabs with one tab on it is furniture pretending to be
   * a decision. */
  const copies = variantsOf('movies', item);
  const picker = el('div', 'variant-pick film-variants');
  if (copies.length > 1) {
    for (const other of copies) {
      const chip = el('button', 'variant-chip');
      chip.textContent = variantLabel('movies', other);
      if (other.uhd && !/4K/i.test(chip.textContent)) {
        chip.append(Object.assign(el('span', 'variant-4k'), { textContent: '4K' }));
      }
      if (String(other.id) === String(item.id)) chip.classList.add('is-active');
      chip.addEventListener('click', () => {
        if (String(other.id) === String(item.id)) return;
        location.hash = `#/movies/${other.id}`;
      });
      picker.append(chip);
    }
  }

  copy.append(eyebrowRow, heading, meta, tagline, plot, actions, picker);
  stage.append(posterWrap, copy);
  heroInner.append(stage);
  hero.append(heroInner);

  /* --------------------------------------------------------- underneath */
  const below = el('div', 'film-below');
  const main = el('div', 'film-main');
  const side = el('aside', 'film-side');

  /* ---- credits ---- */
  const credits = el('div', 'film-credits');
  const directorRow = filmCreditRow(credits, 'Director');
  const writersRow = filmCreditRow(credits, 'Writers');
  const genresRow = filmCreditRow(credits, 'Genres');
  const providerRow = filmCreditRow(credits, 'Provider');
  providerRow.classList.add('film-provider');
  main.append(credits);

  /* ---- cast ---- */
  const cast = filmRail('Cast & Crew', '');
  cast.rail.hidden = true;
  main.append(cast.rail);

  /* ---- what the file is ---- */
  const specs = el('div', 'film-specs');
  const specCells = {};
  for (const key of ['Video', 'Audio', 'Container', 'Size']) {
    const cell = el('div', 'film-spec');
    const label = el('span', 'film-spec-label');
    label.textContent = key;
    const value = el('span', 'film-spec-value');
    const note = el('span', 'film-spec-note');
    cell.append(label, value, note);
    specs.append(cell);
    specCells[key] = { value, note };
  }
  main.append(specs);

  /* ---- what people who enjoyed this one went on to enjoy ----
   *
   * This was "More in Action", which is a shelf rather than a recommendation:
   * it answers what else the provider filed in the same place, and the
   * provider files by whatever its categories happen to be. Somebody who has
   * just read about a film is asking a better question than that.
   *
   * Drawn from the category first so the row is never empty while the box is
   * thinking, then replaced by the real answer when it lands. The rail is
   * built either way, because a row that appears a second late is a page that
   * jumps under somebody's hand. */
  const others = inCategory.filter((other) => String(other.id) !== String(item.id));
  const more = filmRail('Others enjoyed', '');
  more.track.classList.add('film-more-track');
  const fillMore = (list, note) => {
    more.track.innerHTML = '';
    for (const other of list.slice(0, 24)) {
      const card = cardFor(other);
      if (other.why && other.why.length) {
        const why = el('p', 'card-why');
        why.textContent = other.why[0];
        card.append(why);
      }
      more.track.append(card);
    }
    const count = more.rail.querySelector('.film-rail-count');
    if (count) count.textContent = note;
  };
  // Capped: the row scrolls, and building a thousand posters to sit off the
  // right-hand side of it costs the Pi the same as showing them.
  fillMore(others, category ? `from ${cleanCatName(category.name)}` : '');
  if (others.length || item.id) main.append(more.rail);

  api('/api/similar', { id: item.id, name: item.name || '' })
    .then((data) => {
      // The page may have moved on while the box was being asked.
      if (!more.rail.isConnected) return;
      if (data.items && data.items.length) fillMore(data.items, '');
    })
    .catch(() => {
      /* No answer is the category row that is already there. This section is
         a suggestion, and a suggestion that cannot be made is not an error
         worth a message on somebody's film page. */
    });

  /* ---- on the box ---- */
  const box = filmPanel('On the box');
  const boxState = el('div', 'film-box-state');
  box.body.append(boxState);

  const paintBox = () => {
    boxState.innerHTML = '';
    const have = downloadJobFor('movie', item.id);

    if (have && have.status === 'done') {
      const line = el('div', 'film-box-line is-ok');
      line.append(filmIcon('check'));
      line.append(document.createTextNode(
        ` Downloaded${have.total ? ` · ${formatBytes(have.total)}` : ''} · MP4`));
      const note = el('p', 'film-box-note');
      note.textContent = 'The box copy costs no provider connection. Save to device is '
        + 'the step that survives airplane mode.';
      const row = el('div', 'film-box-buttons');
      const disk = el('button', 'btn btn-ghost btn-sm');
      disk.textContent = 'Play from disk';
      disk.addEventListener('click', () => openPlayer(item, { resume: at > 0 ? 'resume' : 'ask' }));
      const device = el('button', 'btn btn-ghost btn-sm');
      device.textContent = 'Save to device';
      device.addEventListener('click', () => saveToDevice(have));
      row.append(disk, device);
      boxState.append(line, note, row);
    } else if (have) {
      const line = el('div', 'film-box-line is-busy');
      const what = el('span');
      what.textContent = have.status === 'paused' ? 'Paused' : 'Downloading';
      const much = el('span', 'film-box-pct');
      const done = Number(have.bytes) || 0;
      const total = Number(have.total) || 0;
      much.textContent = total
        ? `${Math.floor((done / total) * 100)}% · ${formatBytes(done)} of ${formatBytes(total)}`
        : formatBytes(done);
      line.append(what, much);
      const bar = el('div', 'film-bar');
      const fill = el('i');
      fill.style.width = total ? `${Math.min(100, (done / total) * 100)}%` : '0%';
      bar.append(fill);
      const note = el('p', 'film-box-note');
      note.textContent = 'Pauses itself the moment anybody starts watching.';
      boxState.append(line, bar, note);
    } else {
      const line = el('div', 'film-box-line');
      line.textContent = 'Not downloaded — streams from the provider.';
      const note = el('p', 'film-box-note');
      note.textContent = 'A box copy starts immediately instead of waiting on the '
        + "provider's pacing and a prebuffer.";
      boxState.append(line, note);
      if (!item.archivePath && !item.localOnly) {
        const go = el('button', 'btn btn-ghost btn-sm');
        go.textContent = 'Download to the box';
        go.addEventListener('click', async () => { await requestDownload(item); paintBox(); });
        boxState.append(go);
      }
    }
  };
  paintBox();

  box.body.append(el('div', 'film-rule'));

  const numbers = filmBoxNumbers();
  const figures = el('div', 'film-figures');
  const figure = (label, value) => {
    const row = el('div', 'film-figure');
    const name = el('span');
    name.textContent = label;
    const said = el('b');
    said.textContent = value;
    row.append(name, said);
    figures.append(row);
    return row;
  };
  // One connection is the rule the whole box is built around: a download
  // pauses itself when somebody presses play, and this is where you find out
  // whether that is about to happen to you.
  figure('Provider connection', state.downloads.active ? '0 of 1 free' : '1 of 1 free');
  figure('Your allowance', numbers.label);
  const allowanceBar = el('div', `film-bar is-${numbers.tone}`);
  const allowanceFill = el('i');
  allowanceFill.style.width = `${numbers.percent}%`;
  allowanceBar.append(allowanceFill);
  figures.append(allowanceBar);
  if (numbers.free !== null) {
    figure('Card free', `${formatBytes(numbers.free)} · 2 GB floor`);
  }
  box.body.append(figures);
  side.append(box.panel);

  /* ---- what this profile has done with it ---- */
  const seen = filmPanel(`Watched by ${profiles.current?.name || 'you'}`);
  const seenLine = el('div', 'film-seen-line');
  if (history) {
    const when = new Date(history.at || Date.now())
      .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const plays = Number(history.plays) || 1;
    seenLine.textContent = history.completed
      ? `Finished on ${when} · ${plays} play${plays === 1 ? '' : 's'}`
      : `Stopped at ${hms(history.position || 0)} on ${when} · `
        + `${plays} play${plays === 1 ? '' : 's'}`;
  } else {
    seenLine.textContent = 'Never opened on this profile';
  }
  const seenNote = el('p', 'film-box-note');
  seenNote.textContent = category
    ? `Counts toward ${category.name} affinity — completion weighs far above `
      + 'opening something.'
    : 'Completion weighs far above opening something.';

  seen.body.append(seenLine, seenNote, ratingButtons(item));
  side.append(seen.panel);

  /* ---- somewhere else to read about it ---- */
  const lookup = filmPanel('Look it up');
  lookup.body.classList.add('film-links');
  const query = encodeURIComponent(item.name);
  for (const [name, href] of [
    ['IMDb', `https://www.imdb.com/find/?q=${query}`],
    ['TheMovieDb', `https://www.themoviedb.org/search?query=${query}`],
    ['Trakt', `https://trakt.tv/search?query=${query}`],
  ]) {
    const link = el('a', 'film-link');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.append(filmIcon('globe'));
    link.append(document.createTextNode(name));
    lookup.body.append(link);
  }
  side.append(lookup.panel);

  below.append(main, side);
  view.append(below);
  /* The backdrop is the width of the window, and .wrap is 1440 with a gutter
     either side of it. So the hero goes where the home billboard goes —
     straight into #appView, above the wrap rather than inside it — and the
     band down its middle carries the wrap's own measure so the poster and the
     title line up with everything underneath them. clearStage() sweeps it,
     the same way it sweeps the folder back button. */
  $('#appView').prepend(hero);

  /**
   * The second pass: everything only the provider knows.
   *
   * Called once the get_vod_info round trip lands, and written to fill the
   * nodes already on screen rather than to rebuild the page — the first pass
   * is what somebody is reading while this is in flight.
   */
  const describe = (info) => {
    const bits = [];
    if (item.rating) {
      const star = el('span', 'film-star');
      star.textContent = '★';
      const score = el('span', 'film-score');
      score.append(star, document.createTextNode(` ${item.rating}`));
      bits.push(score);
    }

    const seconds = parseRuntime(info) || runtimeSeconds;
    if (seconds) bits.push(hms(seconds));
    if (info?.releasedate) bits.push(info.releasedate);
    if (info?.genre) bits.push(info.genre);

    const bytes = mediaBytes(info);
    const container = (info?.movie_data?.container_extension || item.ext || '').toUpperCase();
    if (bytes || container) {
      const file = el('span', 'film-file');
      file.textContent = [bytes ? formatBytes(bytes) : '', container].filter(Boolean).join(' · ');
      bits.push(file);
    }

    meta.innerHTML = '';
    bits.forEach((bit, i) => {
      if (i) {
        const dot = el('span', 'film-dot');
        dot.textContent = '·';
        meta.append(dot);
      }
      meta.append(typeof bit === 'string' ? document.createTextNode(bit) : bit);
    });
    // Only when the panel carries one. Most do not, and a line that is quiet
    // about it is right where a line that guesses is wrong.
    const certificate = filmCertificate(info);
    if (certificate) {
      const cert = el('span', 'film-cert');
      cert.textContent = certificate;
      meta.append(cert);
    }

    // The year sits inside the title, at half its size, the way a poster
    // credits one. Only once it is known: a bracket with nothing in it is
    // worse than no bracket.
    const released = String(info?.releasedate || '').slice(0, 4);
    year.textContent = /^\d{4}$/.test(released) ? ` ${released}` : '';

    eyebrow.textContent = info?.genre
      ? `Movies · ${String(info.genre).split(',').slice(0, 2).map((s) => s.trim()).join(', ')}`
      : 'Movies';

    // Some panels pass TMDB's one-line tagline through and most do not. It is
    // the loudest line on the page after the title, so it is drawn only when
    // there is a real one: a sentence lifted off the front of the synopsis to
    // fill the slot would read as the film's own line and not be it.
    if (info?.tagline) {
      tagline.textContent = info.tagline;
      tagline.hidden = false;
    }

    if (info?.plot) {
      plot.textContent = info.plot;
      plot.hidden = false;
    }

    // The backdrop, which is the point of the hero. Xtream gives an array and
    // the first is the widest; the poster is a 2:3 and stretching it across a
    // 600px band is worse than the fallback tile, so it is not a substitute.
    const backdrop = (info?.backdrop_path || [])[0];
    art.innerHTML = '';
    if (backdrop) {
      const image = el('img');
      image.alt = '';
      image.src = img(backdrop);
      image.addEventListener('error', () => image.remove());
      art.append(image);
    }

    // How much is left, beside the buttons, which is the number that decides
    // whether tonight is the night.
    const total = seconds || history?.duration || 0;
    left.textContent = total
      ? at > 0 && history?.position
        ? `${hms(Math.max(0, total - history.position))} left of ${hms(total)}`
        : hms(total)
      : '';

    /* ---- credits ---- */
    /* A label with nothing under it is not information, so a row the provider
       said nothing about takes itself and its label off the grid rather than
       standing there empty. Xtream has no writer field at all on most panels,
       which is the row this happens to most. */
    const names = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
    const fillRow = (row, people, onClick) => {
      row.innerHTML = '';
      for (const name of people) row.append(filmCreditChip(name, onClick && (() => onClick(name))));
      row.hidden = !people.length;
      row.previousElementSibling.hidden = !people.length;
    };

    /* The director's name is a way through the library, the same as a genre
       chip: everything of theirs the box has read the credits for. */
    fillRow(directorRow, names(info?.director), (name) => {
      location.hash = `#/movies/by/${encodeURIComponent(name)}`;
    });
    fillRow(writersRow, names(info?.writer), null);
    fillRow(genresRow, names(info?.genre), (name) => {
      // The genre chips are how you get from one film to the rest of its kind,
      // which is the same move the category bar makes and lands in the same
      // place: the movies grid, filtered.
      state.query = name;
      location.hash = '#/movies';
    });

    providerRow.innerHTML = '';
    const source = el('span', 'film-mono');
    source.textContent = item.archivePath ? 'ARCHIVE DRIVE'
      : (category?.name || 'VOD').toUpperCase();
    providerRow.append(source);
    const dot = () => {
      const mark = el('span', 'film-dot');
      mark.textContent = '·';
      return mark;
    };
    if (item.added) {
      const days = Math.max(0, Math.round((Date.now() - item.added * 1000) / 86400000));
      const added = el('span');
      added.textContent = days === 0 ? 'Added today'
        : `Added ${days} day${days === 1 ? '' : 's'} ago`;
      providerRow.append(dot(), added);
    }
    const through = el('span');
    through.textContent = item.archivePath ? 'Read from the drive' : 'Proxied through the Pi';
    providerRow.append(dot(), through);

    /* ---- cast ---- */
    const people = String(info?.cast || '').split(',').map((s) => s.trim()).filter(Boolean);
    const crew = String(info?.director || '').split(',').map((s) => s.trim()).filter(Boolean);
    /* Cast, then crew, in the order the provider lists them — and labelled
       with what it actually said they are. The second line used to read
       'Lead', 'Featured' or 'Supporting' off the position in the list, which
       is a claim about a film nobody made: an Xtream cast string is a list of
       names and nothing else. */
    const everyone = [
      ...people.map((name) => ({ name, role: 'Cast' })),
      ...crew.map((name) => ({ name, role: 'Director' })),
    ];
    cast.track.innerHTML = '';
    cast.rail.hidden = everyone.length === 0;
    cast.rail.querySelector('.film-rail-count').textContent = String(everyone.length);
    for (const person of everyone) {
      /* A button, because it goes somewhere: everything else in the library
         with this person in it. */
      const tile = el('button', 'film-person');
      tile.type = 'button';
      tile.addEventListener('click', () => {
        location.hash = `#/movies/by/${encodeURIComponent(person.name)}`;
      });
      const face = el('div', 'film-face');
      // Initials until a portrait arrives, and for ever if none does. The
      // provider has no cast art; the box asks IMDb, and somebody without a
      // page there keeps their initials rather than a grey silhouette.
      face.textContent = person.name.split(/\s+/).slice(0, 2)
        .map((word) => word[0] || '').join('').toUpperCase();
      const name = el('div', 'film-person-name');
      name.textContent = person.name;
      const role = el('div', 'film-person-role');
      role.textContent = person.role;
      tile.append(face, name, role);
      tile._face = face;
      cast.track.append(tile);
    }

    /* The portraits, once the names are on screen. One request for the whole
       rail, answered from the box's cache after the first time, and a failure
       anywhere in it leaves the initials exactly as they are. */
    if (everyone.length) {
      api('/api/people/portraits', { names: everyone.map((p) => p.name).join('|') })
        .then((answer) => {
          if (!cast.track.isConnected) return;
          const faces = new Map((answer.people || [])
            .filter((row) => row.image).map((row) => [row.name, row.image]));
          for (const tile of cast.track.children) {
            const who = tile.querySelector('.film-person-name')?.textContent || '';
            const src = faces.get(who);
            if (!src || !tile._face) continue;
            const portrait = el('img', 'film-portrait');
            portrait.alt = '';
            portrait.loading = 'lazy';
            // Through the box's own image proxy, like every other outside
            // picture: a browser on the tailnet cannot always reach Amazon's
            // CDN, and the Pi can.
            portrait.src = img(src);
            portrait.addEventListener('load', () => tile._face.classList.add('has-portrait'));
            portrait.addEventListener('error', () => portrait.remove());
            tile._face.append(portrait);
          }
        })
        .catch(() => { /* initials stay, which is the honest fallback */ });
    }

    /* ---- what the file is ----
     * Real, where the provider bothers: get_vod_info carries the ffprobe
     * blocks for both streams, which is where the codec, the frame rate and
     * the channel count come from. A title it says nothing about says so
     * rather than making something up. */
    const video = info?.video || {};
    const audio = info?.audio || {};
    const height = Number(video.height) || 0;
    const unknown = '—';

    /* 2160 is 4K however the provider tagged it; below that, say the height
       the file actually has. Unknown stays hidden rather than guessing. */
    if (height) {
      quality.textContent = height >= 2000 ? '4K' : `${height}P`;
      quality.hidden = false;
    }

    specCells.Video.value.textContent = [
      height ? `${height}p` : '',
      String(video.codec_name || '').toUpperCase(),
    ].filter(Boolean).join(' · ') || unknown;
    const fps = String(video.r_frame_rate || '').split('/');
    const rate = fps.length === 2 && Number(fps[1])
      ? (Number(fps[0]) / Number(fps[1])).toFixed(3).replace(/\.?0+$/, '')
      : '';
    specCells.Video.note.textContent = [
      rate ? `${rate} fps` : '',
      video.display_aspect_ratio || '',
    ].filter(Boolean).join(' · ');

    specCells.Audio.value.textContent = [
      String(audio.codec_name || '').toUpperCase(),
      audio.channel_layout || (audio.channels ? `${audio.channels}ch` : ''),
    ].filter(Boolean).join(' · ') || unknown;
    specCells.Audio.note.textContent = audio.tags?.language
      ? `Language: ${audio.tags.language}` : '';

    const ext = (info?.movie_data?.container_extension || item.ext || '').toLowerCase();
    specCells.Container.value.textContent = ext
      ? needsRemux(ext) ? `${ext.toUpperCase()} → MP4 on save` : ext.toUpperCase()
      : unknown;
    specCells.Container.note.textContent = ext
      ? needsRemux(ext)
        ? 'Converted on the way out — the browser will not open it as it is'
        : 'Plays straight through'
      : '';

    const kbps = Number(info?.bitrate) || 0;
    specCells.Size.value.textContent = [
      bytes ? formatBytes(bytes) : '',
      kbps ? `~${(kbps / 1000).toFixed(1)} Mbps` : '',
    ].filter(Boolean).join(' · ') || unknown;
    specCells.Size.note.textContent = item.archivePath
      ? item.archivePath : `movie:${item.id}`;
    specCells.Size.note.classList.add('film-mono');
  };

  // Nothing is known yet, but the shape is: run it once so every node on the
  // page has its "not answered" state rather than being empty until it is.
  describe(state.vodCache[item.id] || null);

  return { describe };
}

/**
 * A film's page, fetched and painted. Where a show has its seasons and
 * episodes, a film has one decision and everything the box knows about it.
 */
/**
 * Everything in the library with one person in it.
 *
 * The provider cannot be asked this — a category listing carries titles and
 * ids, and the cast lives in a per-film call — so the box builds the answer
 * up over time and this reads it. Which is why the line under the heading is
 * not decoration: "78 of 9,412 films looked at so far" is the difference
 * between a short answer and a wrong one, and somebody looking at three
 * cards deserves to know which they are seeing.
 */
async function renderPersonView() {
  const person = state.person;
  $('#grid').hidden = false;
  $('#rowsView').hidden = true;
  $('#emptyState').hidden = true;
  $('#loadMore').hidden = true;
  $('#contentTitle').textContent = person;
  $('#contentMeta').textContent = '';

  const grid = $('#grid');
  grid.className = 'grid';
  grid.innerHTML = '';

  const back = el('button', 'btn btn-ghost folder-back');
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  back.append(document.createTextNode(' All movies'));
  back.addEventListener('click', () => { location.hash = '#/movies'; });
  grid.before(back);

  const note = el('p', 'person-note');
  note.textContent = 'Looking…';
  grid.before(note);

  let answer;
  try {
    answer = await api('/api/people/films', { name: person });
  } catch (err) {
    note.textContent = `The box could not answer: ${err.message}`;
    return;
  }
  if (state.person !== person) return; // moved on while that was in flight

  const lib = await loadTab('movies');
  const byId = new Map((lib.items || []).map((movie) => [String(movie.id), movie]));
  const found = answer.ids.map((id) => byId.get(String(id))).filter(Boolean)
    .filter((movie) => !profiles.isDeleted(movie));
  // One card per film rather than one per copy, the same as the grid.
  const shown = groupVariants(found);
  const directed = new Set((answer.directed || []).map(String));

  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const movie of shown) frag.append(cardFor(movie));
  grid.append(frag);
  state.filtered = shown;

  const asDirector = shown.filter((movie) => directed.has(String(movie.id))).length;
  const parts = [];
  parts.push(`${shown.length.toLocaleString()} film${shown.length === 1 ? '' : 's'}`);
  if (asDirector) parts.push(`${asDirector} as director`);
  $('#contentMeta').textContent = parts.join(' · ');

  /* How much of the library this answer actually covers. The box fills its
     credits index in the background while nothing is playing, so early on
     this is a small number and the answer is a small answer. */
  const seen = Number(answer.indexed) || 0;
  const total = Number(answer.total) || 0;
  if (total && seen < total) {
    note.textContent = `From the ${seen.toLocaleString()} of ${total.toLocaleString()} films `
      + 'the box has read the credits for so far. It reads more whenever nothing is playing, '
      + 'so this list grows.';
  } else if (total) {
    note.textContent = `Every one of the ${total.toLocaleString()} films in the library has been read.`;
  } else {
    note.textContent = 'The box has not read any credits yet — it does that while nothing is playing.';
  }

  if (!shown.length) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = seen < total
      ? `Nothing with ${person} among the films read so far.`
      : `Nothing in the library with ${person}.`;
  }
}

async function renderMovieCard() {
  $('#contentTitle').textContent = 'Movies';
  const wanted = state.movieId;
  let item;
  try {
    item = await findTitle('movies', wanted);
  } catch (err) {
    if (state.movieId !== wanted) return;
    return missingTitle(`Couldn't load the film list — ${err.message}`);
  }
  if (state.movieId !== wanted) return;
  if (!item) return missingTitle('That film is no longer in the library.');

  const { describe } = filmCard(item);

  // Asked for here rather than at playback: the provider answers a metadata
  // call while its one connection is free, and returns nothing once ffmpeg is
  // streaming through it. Cached so pressing play does not ask again.
  let info = state.vodCache[item.id];
  if (info === undefined) {
    info = await fetchVodInfo(item);
    state.vodCache[item.id] = info;
    // Left the page while that was in flight.
    if (state.tab !== 'movies' || String(state.movieId) !== String(item.id)) return;
  }
  describe(info);
}

/** Shared miss: the library moved on, or the link is old. */
function missingTitle(message) {
  const view = $('#seriesView');
  $('#grid').hidden = true;
  $('#rowsView').hidden = true;
  $('#homeView').hidden = true;
  $('#archiveView').hidden = true;
  view.hidden = false;
  view.innerHTML = '';
  const note = el('p', 'show-note');
  note.textContent = message;
  view.append(note);
}

/* ------------------------------------------------------ live categories ---

 * Live opens on its categories rather than every station at once. A provider
 * carries a few thousand channels, and one flat wall of them is not something
 * anyone browses — the categories are the only usable way in. Tapping one
 * drills into just its stations, and the back button returns here.
 */

/** The provider's own URL behind a logo, which may or may not be proxied. */
function logoSource(logo) {
  const proxied = /^\/img\?u=(.*)$/.exec(logo || '');
  return proxied ? decodeURIComponent(proxied[1]) : logo || '';
}

/**
 * Providers hand out plenty of animated logos — spinning idents and promo
 * loops. Nothing in the URL says so outright, but the format is the giveaway
 * in practice: nobody ships a still station logo as a GIF or an APNG. WebP is
 * left out on purpose, since most of those are ordinary still images.
 */
function looksAnimated(logo) {
  const file = logoSource(logo).split('?')[0].toLowerCase();
  return file.endsWith('.gif') || file.endsWith('.apng');
}

function renderLiveCategories() {
  const source = state.library.live;

  // Counts and cover art in one pass. The item list runs to thousands, so
  // walking it once per category would be visible on the Pi.
  const counts = new Map();
  const covers = new Map();
  for (const item of source.items) {
    const id = String(item.categoryId);
    counts.set(id, (counts.get(id) || 0) + 1);
    // First still logo in the category wins. An animated one is never taken as
    // a substitute — the tile falls back to the category's name instead, which
    // is quieter than a looping ident.
    if (item.logo && !covers.has(id) && !looksAnimated(item.logo)) {
      covers.set(id, item.logo);
    }
  }

  const grid = $('#grid');
  grid.className = 'grid is-cats';
  grid.innerHTML = '';

  // Providers ship plenty of categories with nothing in them.
  const stocked = source.categories.filter((cat) => counts.get(String(cat.id)));
  const hidden = stocked.filter((cat) => profiles.isDeletedCategory(cat.id));
  const showingHidden = state.category === DELETED_CATS;

  const live = showingHidden
    ? hidden
    : stocked.filter((cat) => !profiles.isDeletedCategory(cat.id));

  // Before the order is worked out, not after: the starter pins are what the
  // order is. Writing them is fire-and-forget, exactly as pinning by hand is.
  if (!showingHidden) seedLivePins(stocked);

  // Pins lead, and in the order they were dragged into — the same sequence the
  // sidebar shows. Taking them in the provider's order instead meant dragging a
  // pin rearranged the list but left these tiles exactly where they were.
  const order = profiles.pinOrder('live');
  const ordered = [
    ...live
      .filter((cat) => profiles.isPinned('live', cat.id))
      .sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id))),
    ...live.filter((cat) => !profiles.isPinned('live', cat.id)),
  ];

  // In the hidden view, a way back out — the tiles here are the only place the
  // hidden ones can be restored from.
  if (showingHidden) {
    const back = el('button', 'btn btn-ghost folder-back');
    back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
    back.append(document.createTextNode(' All categories'));
    back.addEventListener('click', () => {
      state.category = null;
      render();
    });
    grid.before(back);
  }

  const frag = document.createDocumentFragment();
  for (const cat of ordered) {
    const id = String(cat.id);
    const card = liveCategoryCard(cat, counts.get(id) || 0, covers.get(id) || '');
    // Marked so the note explaining the starter pins can box them as a group.
    if (!showingHidden && profiles.isPinned('live', id)) card.classList.add('is-pinned');
    frag.append(card);
  }

  // A way in to the hidden ones, at the end and only once there are some.
  //
  // Counted across BOTH kinds. It used to appear only when a whole CATEGORY
  // had been hidden, so hiding channels one at a time — which is the common
  // way to use this — put them somewhere with no door on it.
  const goneChans = profiles.deletedItems('live');
  if (!showingHidden && (hidden.length || goneChans.length)) {
    const tile = el('button', 'card cat-card cat-card-bin');
    const art = el('div', 'card-art');
    const mark = el('div', 'fallback');
    mark.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
    art.append(mark);
    const title = el('h3', 'card-title');
    title.textContent = 'Deleted';
    const sub = el('p', 'card-sub');
    const bits = [];
    if (hidden.length) bits.push(`${hidden.length.toLocaleString()} categor${hidden.length === 1 ? 'y' : 'ies'}`);
    if (goneChans.length) bits.push(`${goneChans.length.toLocaleString()} channel${goneChans.length === 1 ? '' : 's'}`);
    sub.textContent = bits.join(' · ');
    tile.append(art, title, sub);
    tile.addEventListener('click', () => {
      state.category = DELETED_CATS;
      render();
    });
    frag.append(tile);
  }

  /* Hidden channels live in here as well as hidden categories.
   *
   * Both were described as collecting under Deleted and only the categories
   * ever did, so a channel hidden from a grid had nowhere to be restored
   * from. Their bins read as restore arrows in here and are always visible,
   * since this is the only way back and hover is not a gesture a phone has. */
  let restorable = 0;
  if (showingHidden) {
    const goneHere = profiles.deletedItems('live');
    restorable = goneHere.length;
    if (goneHere.length) {
      const head = el('h3', 'grid-split');
      head.textContent = `Hidden channels (${goneHere.length.toLocaleString()})`;
      frag.append(head);
      for (const item of goneHere) frag.append(cardFor(item));
    }
  }

  grid.append(frag);

  const empty = $('#emptyState');
  empty.hidden = ordered.length + restorable > 0;
  if (!ordered.length && !restorable) {
    empty.textContent = showingHidden ? 'Nothing hidden.' : 'No live categories.';
  }

  const meta = [];
  if (ordered.length) {
    meta.push(`${ordered.length.toLocaleString()} categor${ordered.length === 1 ? 'y' : 'ies'}`
      + (showingHidden ? ' hidden' : ''));
  }
  if (restorable) meta.push(`${restorable.toLocaleString()} channel${restorable === 1 ? '' : 's'} hidden`);
  $('#contentMeta').textContent = meta.join(' · ');
  $('#loadMore').hidden = true;

  if (!showingHidden) maybeExplainLivePins();
}

/**
 * The Live TV note, once per profile, and only with something to point at.
 *
 * Deliberately not part of the opening tour: the pins it is about are three
 * clicks away from where that tour runs, and a step pointing at a screen you
 * are not on explains nothing.
 */
function maybeExplainLivePins() {
  if (!profiles.current || profiles.data.liveTourDone) return;
  if (!$('#tour').hidden) return;   // the opening tour is still running

  // Whichever layout is up decides what the note points at, and there is
  // nothing to say until that thing is actually on the page.
  const steps = document.documentElement.classList.contains('desk')
    ? LIVE_TOUR_DESK
    : LIVE_TOUR;
  if (!$(steps[0].target)) return;

  // After the pins have been laid out, or the highlight is drawn around
  // where they were about to be.
  requestAnimationFrame(() => {
    if ($('#tour').hidden) tour.start(steps, 'liveTourDone');
  });
}

/** One square standing for a category, opening its stations when tapped. */
/**
 * One category tile.
 *
 * `onOpen` and `bin` exist so multi-view's picker can put the very same tile on
 * screen — the ask was that picking a channel look like Live TV, and the way to
 * be sure of that is for it to be the same function rather than a copy that
 * drifts. The picker passes its own action and leaves the bin off: hiding a
 * category from inside a modal re-renders the page behind it, which is not
 * what anybody pressing it there means.
 */
/**
 * A category name with the provider's shouting taken off.
 *
 * Categories arrive as "US| FOX ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ ⁸ᴷ" — the superscripts say how
 * the stream is encoded, which is not what anyone is scanning a list of
 * categories for. Stripped for DISPLAY only: what is stored, matched and
 * counted stays exactly what the provider said, so nothing downstream has to
 * know this happened.
 */
const SUPERSCRIPTS = /[\u02B0-\u02FF\u1D2C-\u1D6B\u1DA0-\u1DBF\u2070-\u209F]+/g;

function cleanCatName(raw) {
  const name = String(raw || '');
  if (!SUPERSCRIPTS.test(name)) return name.trim();
  SUPERSCRIPTS.lastIndex = 0;
  const cut = name
    .replace(SUPERSCRIPTS, ' ')
    // "ᴴᴰ/ᴿᴬᵂ" leaves a slash with nothing either side of it. Only touched
    // when something was actually removed, so "SPORTS/NEWS" keeps its slash.
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cut || name.trim();
}

function liveCategoryCard(cat, count, cover, {
  onOpen = null, bin: withBin = true, pin: withPin = true, tab = 'live',
} = {}) {
  const card = el('button', 'card cat-card');

  const art = el('div', 'card-art');
  const nameOnly = () => {
    const fb = el('div', 'fallback');
    fb.textContent = cat.name;
    art.append(fb);
  };

  if (cover) {
    const image = el('img');
    image.loading = 'lazy';
    image.alt = '';
    image.src = cover;
    // A logo the provider links but no longer serves should read as a named
    // tile, not a broken-image glyph.
    image.addEventListener('error', () => {
      image.remove();
      nameOnly();
    });
    art.append(image);
  } else {
    nameOnly();
  }

  // Hides the whole category from this grid. The channels inside keep their
  // own bins, and are still reachable by search either way.
  const gone = profiles.isDeletedCategory(cat.id);
  const bin = withBin ? el('button', `icon-btn card-bin${gone ? ' is-restore' : ''}`) : null;
  if (bin) {
    bin.title = gone ? 'Put this category back' : 'Hide this category';
    bin.setAttribute('aria-label', bin.title);
    bin.innerHTML = gone
      ? '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M3 4v5h5"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
    bin.addEventListener('click', (event) => {
      // The tile underneath opens the category.
      event.stopPropagation();
      const nowGone = profiles.toggleDeletedCategory(cat.id);
      toast(nowGone ? `Hid “${cat.name}”.` : `Restored “${cat.name}”.`);
      render();
    });
    art.append(bin);
  }

  /* Pinning lived only in the sidebar rows, which is the one place a phone
     never sees and the tiles are the main way in on every layout. Left of the
     bin, and it stays visible once it is on — a pin you cannot see is a
     setting you forget you made. */
  if (withPin) {
    const on = profiles.isPinned(tab, cat.id);
    const pin = el('button', `icon-btn card-pin${on ? ' is-on' : ''}`);
    pin.title = on ? 'Unpin' : 'Pin to the top';
    pin.setAttribute('aria-label', pin.title);
    pin.innerHTML = on
      ? '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z" fill="currentColor" stroke="none"/><path d="M12 15v5"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 15v5"/></svg>';
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      const nowPinned = profiles.togglePin(tab, cat.id);
      toast(nowPinned ? `Pinned “${cleanCatName(cat.name)}”.` : `Unpinned “${cleanCatName(cat.name)}”.`);
      render();
    });
    art.append(pin);
  }

  const title = el('h3', 'card-title');
  title.textContent = cleanCatName(cat.name);

  // Under the title rather than badged over the art — the logo is the whole
  // point of the tile, and a badge sits on top of it.
  const sub = el('p', 'card-sub');
  sub.textContent = `${count.toLocaleString()} channel${count === 1 ? '' : 's'}`;

  card.append(art, title, sub);

  card.addEventListener('click', onOpen || (() => {
    state.category = cat.id;
    state.visible = PAGE_SIZE;
    render();
  }));
  return card;
}

/**
 * Take the stage: every view off, grid included, ready for whoever renders
 * next to show only their own. Shared by render() and the skeleton page,
 * because the two are the only ways a tab change reaches the screen — and
 * when each caller kept its own hide-list, every list was missing something.
 */
function clearStage() {
  // A search leaves three sections' worth of cards in the grid. Whatever
  // draws next may not touch the grid at all — the shelves live in their own
  // view — so those cards would sit there hidden, holding memory and ready
  // to flash back into sight the next time anything unhid it.
  const grid = $('#grid');
  if (grid.querySelector('.search-section')) grid.innerHTML = '';
  $('#homeView').hidden = true;
  $('#seriesView').hidden = true;
  // A show and a film share the view and not the layout. Left on, the film
  // page's rules would lay out a show's card, which is a different shape.
  $('#seriesView').classList.remove('film-page');
  $('#downloadList').hidden = true;
  $('#archiveView').hidden = true;
  $('#rowsView').hidden = true;
  $('#grid').hidden = true;
  $('#emptyState').hidden = true;
  $('#loadMore').hidden = true;
  // The back button lives outside #grid, so clearing the grid alone leaves
  // it behind. A film's backdrop lives outside the wrap for the same kind of
  // reason — it is the width of the window — and goes the same way.
  document.querySelectorAll('.folder-back').forEach((b) => b.remove());
  document.querySelectorAll('.film-hero').forEach((b) => b.remove());
  // The line under a person's name lives outside the grid for the same
  // reason the back button does, and would otherwise stack up one per visit
  // — each one still saying what was true two people ago.
  document.querySelectorAll('.person-note').forEach((b) => b.remove());
}

function renderSkeletons() {
  // A real page, not just a paint: while a library loads, this IS what is on
  // screen — so it takes the stage like any other view. Without this, the
  // page you left (the archive's folders, say) sat visible beneath the
  // shimmer for the whole load, and for ever if the load failed.
  clearStage();
  const grid = $('#grid');
  grid.hidden = false;
  grid.innerHTML = '';
  grid.classList.toggle('is-live', state.tab === 'live');
  grid.classList.remove('is-cats', 'is-listings');
  for (let i = 0; i < 18; i += 1) grid.append(el('div', 'skeleton'));
}

function render() {
  const titles = {
    home: 'Home',
    live: 'Live TV',
    movies: 'Movies',
    series: 'Series',
    favorites: 'Favorites',
    favlive: 'Favorite channels',
    archive: 'Archive',
    downloads: 'Downloads',
  };
  $('#contentTitle').textContent = titles[state.tab];
  // Cleared here and set again by renderHome alone. render() returns early for
  // several tabs, so a removal per branch would be a branch waiting to be
  // forgotten.
  document.querySelector('.app-shell').classList.remove('is-home', 'is-film');

  syncTabs();
  // The multi-view button belongs to Live TV, so it is settled per render
  // rather than once at startup. Kept out of syncTabs, which device.init()
  // reaches before this module has been initialised at all.
  applyMultiviewButton();
  applyListingsButton();
  applyWideSearchButton();

  // EVERY tab's furniture goes away here, before the per-tab branches — not
  // inside them. Each branch used to hide its neighbours for itself, and
  // every branch that forgot one taught the same lesson again: Home left
  // showing under Downloads, then the Archive's folders bleeding into
  // whatever page came after it. Hiding the lot up front means a branch can
  // only forget to SHOW its own view — which is a bug you see instantly —
  // never to hide somebody else's, which is one you meet weeks later.
  clearStage();

  if (state.tab === 'downloads') return renderDownloads();
  if (state.tab === 'archive') return renderArchive();
  // Before Home's own branch, not after: a search typed from the landing
  // page is a search, and painting the landing page again is what made it
  // look like the box did nothing.
  if (state.query && SEARCH_TABS.includes(state.tab)) return renderSearchAll();

  // A schedule for whatever is on this page. After the search branch, so a
  // search still searches; before the grid, because it replaces it.
  if (state.tab === 'live' && state.listings) return renderListings();

  if (state.tab === 'home') return renderHome();
  if (state.tab === 'series' && state.seriesId) return renderShowCard();
  if (state.tab === 'movies' && state.person) return renderPersonView();
  if (state.tab === 'movies' && state.movieId) return renderMovieCard();

  $('#grid').hidden = false;

  // Movies browse as named shelves. A search collapses back to a flat grid,
  // since rows make no sense when you're looking for one specific title.
  const rowsMode =
    (state.tab === 'movies' || state.tab === 'series') && !state.query && state.category === null;
  // Live opens on its categories rather than every station at once. The hidden
  // ones are the same grid with a different set in it.
  const liveCatsMode =
    state.tab === 'live' && !state.query &&
    (state.category === null || state.category === DELETED_CATS);
  const isFavorites = state.tab === 'favorites' || state.tab === 'favlive';
  document.querySelector('.app-shell')
    .classList.toggle('no-sidebar', isFavorites || rowsMode || liveCatsMode);

  if (rowsMode && state.library[state.tab]) {
    /* Asked for once the film library is actually here, since the box builds
       its answer out of the same catalogue. It re-renders when it lands, and
       does nothing at all for five minutes afterwards. */
    if (state.tab === 'movies' || state.tab === 'series') loadForYou({ tab: state.tab });
    return state.shelf ? renderShelf() : renderRows();
  }
  if (liveCatsMode && state.library.live) return renderLiveCategories();

  const source = isFavorites
    ? {
        categories: [],
        // favlive is the channels on their own; favorites stays everything.
        items: state.tab === 'favlive'
          ? profiles.favItems().filter((i) => i.kind === 'live')
          : profiles.favItems(),
      }
    : state.library[state.tab] || { categories: [], items: [] };

  if (!isFavorites) {
    // Count what the grid will actually show. Leaving hidden titles in the
    // tally means a category reads 6 and then opens with 5 in it.
    // The counts and the category list are built from the same pool the grid
    // draws from, or a category reads "412 titles" and opens on nothing.
    const listed = browsable(source.items);
    renderCategories(
      source.categories,
      canDelete(state.tab) ? listed.filter((i) => !profiles.isDeleted(i)) : listed
    );
  }

  const inBin = state.category === DELETED_CATEGORY;
  let items = inBin ? profiles.deletedItems(state.tab) : browsable(source.items);

  if (!inBin) {
    if (state.category !== null && !isFavorites) {
      items = items.filter((i) => String(i.categoryId) === String(state.category));
    }
    // Deleted titles are gone from the grids and from search alike — hiding
    // them from one and not the other is worse than not hiding them at all.
    if (canDelete(state.tab)) items = items.filter((i) => !profiles.isDeleted(i));
  }

  if (state.query) {
    // Word by word and ranked, the same as the cross-library search — a tab
    // that answered a query differently from the search above it would be a
    // small madness of its own.
    items = rankedMatches(items, state.query);
  }
  // One card per title, whatever the provider's filing says. Done after the
  // filtering above so a category page groups only what is on it.
  if (state.tab === 'movies' || state.tab === 'series') items = groupVariants(items);
  state.filtered = items;

  const grid = $('#grid');
  grid.innerHTML = '';
  grid.classList.toggle('is-live', state.tab === 'live');
  /* Both mode classes, not just the one.
   *
   * `is-listings` turns the grid into a block so the schedule can lay itself
   * out, and only `is-cats` was ever being cleared — so coming back from
   * Listings left the channel grid as a single column of mismatched cards.
   * The two are the same kind of thing and go together. */
  grid.classList.remove('is-cats', 'is-listings');

  // Inside one live category — offer the way back out to the squares.
  if (state.tab === 'live' && state.category !== null) {
    const back = el('button', 'btn btn-ghost folder-back');
    back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
    back.append(document.createTextNode(' All categories'));
    back.addEventListener('click', () => {
      state.category = null;
      state.visible = PAGE_SIZE;
      render();
    });
    grid.before(back);
  }

  const slice = items.slice(0, state.visible);
  const frag = document.createDocumentFragment();
  for (const item of slice) frag.append(cardFor(item));
  grid.append(frag);

  const empty = $('#emptyState');
  if (!items.length) {
    empty.hidden = false;
    empty.textContent = state.query
      ? `Nothing matches “${state.query}”.`
      : isFavorites
        ? 'No favorites yet. Tap the heart while watching something.'
        : 'Nothing here.';
  } else {
    empty.hidden = true;
  }

  $('#contentMeta').textContent = items.length
    ? `${slice.length.toLocaleString()} of ${items.length.toLocaleString()}`
    : '';
  $('#loadMore').hidden = items.length <= state.visible;
}

/* -------------------------------------------------------------- downloads */

function formatBytes(n) {
  if (!n) return '0 MB';
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(n / 1024 ** 2).toFixed(0)} MB`;
}

async function refreshDownloads({ rerender = false } = {}) {
  const was = new Map((state.downloads.items || []).map((j) => [j.id, j]));
  try {
    state.downloads = await api('/api/downloads');
  } catch {
    return;
  }
  offerDeviceSave(was, state.downloads.items || []);
  const busy = state.downloads.items.filter(
    (j) => j.status === 'downloading' || j.status === 'queued'
  ).length;
  // Both navs carry the badge; only one of them is on screen at a time.
  for (const badge of [$('#dlCount'), $('#tabDlCount')]) {
    badge.textContent = busy;
    badge.hidden = !busy;
  }

  // Only rebuild the grid when the data actually moved. The 2s poll used to
  // recreate every card each tick — flickering posters and yanking buttons
  // out from under a click even when nothing was downloading.
  const sig = JSON.stringify(state.downloads.items);
  const changed = sig !== refreshDownloads._sig;
  refreshDownloads._sig = sig;
  if (rerender && changed && state.tab === 'downloads') renderDownloads();
}

/**
 * Offer the device copy the moment there is one to offer.
 *
 * A download only becomes useful without wifi once it is off the Pi, and the
 * button that does that was buried in a list somebody had to remember to go
 * back to. This is the prompt at the moment it can be acted on — while whoever
 * asked for it is still here.
 *
 * It waits for the MP4, not merely for the bytes. The provider sends .mkv and
 * the Pi converts every finished download; offering the file while `preparing`
 * is still true would hand out the one container a phone cannot open, which is
 * the exact dead end this whole change is about.
 */
function offerDeviceSave(before, after) {
  for (const job of after) {
    if (job.status !== 'done' || job.preparing) continue;
    const prev = before.get(job.id);
    // Newly finished, or newly converted. Nothing on the first poll of a
    // session, when everything already on the box would look new.
    if (!prev || (prev.status === 'done' && !prev.preparing)) continue;
    if (savedOffers.has(job.id)) continue;
    savedOffers.add(job.id);

    toast(`${job.name} is on the box. Save it to this device?`, {
      action: {
        label: 'Save to device',
        run: () => saveToDevice(job),
      },
    });
  }
}

/** Offered once per download per session; a nag is not an offer. */
const savedOffers = new Set();

/**
 * Is this the home-screen app rather than a browser tab?
 *
 * It decides only one thing now: whether there is any chrome to come back
 * from when a hand-over cannot be done inside the app.
 */
const isStandalone = () =>
  Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator.standalone === true);

/**
 * Start the transfer with a link, the way every browser but iOS wants.
 *
 * Four attempts have now been made at this and each broke the one before
 * it, so all of them are written down here.
 *
 *   * A plain same-window link SAVES reliably — and installed to the home
 *     screen on iOS it replaces the entire app with the system's file
 *     viewer, which has no way back short of force-quitting.
 *   * A link with target=_blank leaves the app standing — and clicked from
 *     script rather than by a finger it is a popup, which gets blocked, and
 *     then nothing is saved at all.
 *   * window.open() from the home-screen app is not blocked, but it does not
 *     download either: it opens iOS's own little browser view, on the raw
 *     tailnet address, showing a blank page with a close button that does
 *     not close. That is the screen somebody photographed, and it is worse
 *     than either of the first two because nothing is saved AND the app is
 *     covered.
 *
 * So window.open is gone for good, and iOS never comes through here at all
 * — it is handed the file itself (see handOverFile). Everywhere else the
 * plain download link is the one thing that has always worked, installed or
 * in a tab, so that is all this does now.
 */
function startTransfer(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  return true;
}

/**
 * Can this device be handed an actual file, rather than a link to one?
 *
 * On iOS it can, and that is the whole answer to the trap: the share sheet
 * has "Save to Files" in it, it is a system panel that closes, and nothing
 * ever navigates away from the app.
 */
function canShareFiles() {
  try {
    const probe = new File([new Blob(['x'])], 'probe.mp4', { type: 'video/mp4' });
    return Boolean(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch {
    return false;
  }
}

/**
 * Why the share sheet is not on offer here — which is never the viewer's
 * fault and should never be reported as their device being too old.
 *
 * Almost always it is the ADDRESS. Handing over a file is one of the
 * browser powers gated behind a secure context, like the clipboard further
 * up this file, and most of the household reaches this over plain http on
 * the tailnet — `http://100.68.175.115:8420`, added to a home screen months
 * ago and never thought about again. Same app, same iPad, same everything;
 * the sheet is missing because of the scheme in front of it.
 *
 * That is worth saying exactly, because the fix is a one-off — add it to
 * the home screen from the https address instead — and "this version of iOS
 * can't" sends somebody looking for a software update that will not help.
 */
function whyNoShare() {
  if (!window.isSecureContext) return 'address';
  return 'ios';
}

/**
 * Past this size, warn that the hand-over will take a while and may fail.
 *
 * It is NOT a cut-off. A cut-off was tried, at 900MB, and all it did was
 * send big films down the browser road that does not work on iOS anyway —
 * so a large file failed twice: no save, and the app buried under a dead
 * browser page. Better to attempt it, say honestly that it is a lot to
 * carry, and deal with a failure if one comes.
 */
const SHARE_WARN_BYTES = 900 * 1024 * 1024;

/**
 * Send a file to the device, by whatever road that device actually has.
 *
 * iOS has exactly one that works — take the file into this page and hand
 * the file itself to the share sheet. Every road that involves pointing a
 * browser at a URL ends somewhere the viewer cannot get out of. Everywhere
 * else, a download link, which has never once misbehaved.
 */
function handOverFile({ url, filename, bytes, name }) {
  // The id the box counts against. The browser will not tell this page how
  // its download is going, so the page asks the box how much it has sent —
  // which also means the page can tell when the browser never asked at all.
  const track = `sv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const href = `${url}${url.includes('?') ? '&' : '?'}track=${track}`;

  /* Every way this can fail ends in a button that runs it again.
   *
   * A save that stops half way is not rare — a phone sleeps, wifi drops in
   * a doorway — and up to now the answer was a line of text saying "press
   * save again", which means finding the card again, on a page that may
   * have moved on. The retry starts from scratch on purpose: a fresh
   * tracking id, so the bar counts this attempt rather than adding to the
   * ruins of the last one. */
  const again = () => handOverFile({ url, filename, bytes, name });

  /* On iOS, never point a browser at the file. Not this window, not a new
   * one, not a link — every one of those ends somewhere the viewer cannot
   * get out of, and two of them do not even save.
   *
   * The file is fetched HERE instead, which also means the progress bar is
   * measuring our own transfer rather than asking the box about somebody
   * else's, and then the file itself goes to the system share sheet — where
   * "Save to Files" is, and which closes like any other panel.
   *
   * No size limit on the attempt: a limit only decides which failure the
   * viewer gets, and this one at least has a chance of working. */
  if (isIOS()) {
    if (canShareFiles()) {
      return saveBar.fetchThenShare({ href, filename, name, bytes, again });
    }
    // No share sheet. In Safari a download link is still fine — there is
    // chrome to come back from, and Safari's own downloads take it.
    // Installed to the home screen it is not fine, but it is not nothing
    // either: it does save, it just leaves iOS's file page over the app
    // afterwards. So say why, say what fixes it for good, and let the save
    // happen anyway for somebody who wants the film now.
    if (isStandalone()) {
      return saveBar.noShareHere({
        name,
        bytes,
        why: whyNoShare(),
        anyway: () => {
          const took = startTransfer(href, filename);
          saveBar.watch({ id: track, name, bytes, href, filename,
            blocked: !took, again, preview: true });
        },
      });
    }
  }

  const took = startTransfer(href, filename);
  saveBar.watch({ id: track, name, bytes, href, filename, blocked: !took, again });
}

/**
 * The bar that shows a save actually happening.
 *
 * Every other way of doing this fails on this box. Pulling the file through
 * fetch to count it needs the whole film in memory. A service worker needs a
 * secure context, and half the household reaches this over plain http on the
 * tailnet. So the honest measure is the one the SENDER has: the box counts
 * the bytes it writes, and this asks it, twice a second.
 *
 * It survives navigation — a save outlives whatever page somebody wanders to
 * while it runs — and closing it only hides it, because there is no way to
 * cancel a download the browser owns.
 */
const saveBar = {
  timer: null,
  id: '',
  /** How to start this same save over, for the button on every failure. */
  again: null,

  /**
   * Fetch the file here, then hand the file itself to the system.
   *
   * The transfer is ours, so the bar is measuring what it claims to be
   * measuring rather than asking the box about somebody else's download.
   * And the share sheet is offered on a fresh tap on purpose: a share has
   * to come from a gesture, and by the time a film has been fetched the
   * gesture that started it is long spent.
   */
  async fetchThenShare({ href, filename, name, bytes, again }) {
    const mine = `share-${Date.now()}`;
    this.id = mine;
    this.again = again || null;
    clearInterval(this.timer);
    this.timer = null;
    this.clearTap();

    $('#saveBarName').textContent = name;
    $('#saveBarPct').textContent = '';
    $('#saveBarFill').style.width = '0%';
    $('#saveBarNote').textContent = bytes
      ? `${formatBytes(bytes)} — fetching from the box…`
      : 'Fetching from the box…';
    if (bytes > SHARE_WARN_BYTES) {
      $('#saveBarNote').textContent =
        `${formatBytes(bytes)} — a big one. Keep this open while it comes across.`;
    }
    $('#saveBar').hidden = false;

    try {
      const res = await fetch(href, { cache: 'no-store' });
      if (!res.ok) throw new Error(`the box answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || bytes || 0;

      let blob;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        const started = performance.now();
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          if (this.id !== mine) return reader.cancel();   // superseded
          chunks.push(value);
          got += value.length;
          const secs = (performance.now() - started) / 1000;
          const rate = secs > 0 ? got / secs : 0;
          const pct = total ? Math.min(100, (got / total) * 100) : 0;
          $('#saveBarFill').style.width = `${pct.toFixed(1)}%`;
          $('#saveBarPct').textContent = total ? `${Math.floor(pct)}%` : '';
          $('#saveBarNote').textContent =
            `${formatBytes(got)}${total ? ` of ${formatBytes(total)}` : ''}`
            + (rate > 0 ? ` · ${(rate / 1048576).toFixed(1)} MB/s` : '')
            + (rate > 0 && total > got ? ` · about ${etaText((total - got) / rate)} left` : '');
        }
        blob = new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' });
        chunks.length = 0;
      } else {
        // No streaming to read: still worth doing, just without a bar that
        // moves. Never navigating is the point.
        blob = await res.blob();
      }
      if (this.id !== mine) return;

      const file = new File([blob], filename, { type: blob.type || 'video/mp4' });
      $('#saveBarFill').style.width = '100%';
      $('#saveBarPct').textContent = '100%';

      // Offered again after a dismissal rather than thrown away: the file is
      // already here, and making somebody fetch a gigabyte twice because
      // they closed a sheet would be absurd.
      const offer = (note) => this.offerAction(note, 'Save to device', async () => {
        try {
          await navigator.share({ files: [file] });
          $('#saveBarNote').textContent = 'Saved to this device.';
          this.finish(5000);
        } catch (err) {
          if (err && err.name === 'AbortError') {
            return offer('Not saved. The file is still here — tap again.');
          }
          toast(`Couldn't hand it over: ${err.message}`);
          offer(`Ready — ${formatBytes(blob.size)}.`);
        }
      });
      offer(`Ready — ${formatBytes(blob.size)}. Choose “Save to Files”.`);
    } catch (err) {
      if (this.id !== mine) return;
      // Running out of room to hold the film is the one failure worth
      // naming, because the answer to it is a different one: fetch a
      // smaller copy rather than try the same thing again.
      const outOfRoom = err && (err.name === 'RangeError'
        || /allocat|memory|quota/i.test(err.message || ''));
      const note = outOfRoom
        ? `Too large for this device to hold — ${formatBytes(bytes || 0)}. `
          + 'Download it to the box first, which makes a smaller copy, then save that.'
        : `Couldn't fetch it — ${err.message}.`;
      // Out of room will fail again the same way, so retrying it is a lie.
      // Anything else — a doorway, a sleeping phone, the box busy — is worth
      // one press.
      if (again && !outOfRoom) return this.offerAction(note, 'Try again', again);
      $('#saveBarNote').textContent = note;
      this.finish(12_000);
    }
  },

  /**
   * No share sheet here — say why, and still offer the save.
   *
   * The first version of this refused outright and blamed the iPad, which
   * was both wrong and useless: the sheet is missing because the app was
   * added to the home screen from the plain-http tailnet address, not
   * because of anything about the device. So this names the real cause,
   * names the one-off fix, and puts the save on a button anyway — it does
   * work, it just leaves iOS's own file page over the app when it is done,
   * and that is the viewer's call to make rather than mine.
   */
  noShareHere({ name, bytes, why, anyway }) {
    this.id = '';
    this.again = null;
    clearInterval(this.timer);
    this.timer = null;
    this.clearTap();
    $('#saveBarName').textContent = name;
    $('#saveBarPct').textContent = '';
    $('#saveBarFill').style.width = '0%';
    $('#saveBar').hidden = false;

    const size = bytes ? `${formatBytes(bytes)}. ` : '';
    this.offerAction(
      why === 'address'
        ? `${size}Handing over a file needs the secure address. This one was `
          + 'added to your home screen from the plain http:// one, so iOS holds '
          + 'the share sheet back. Add it again from the https:// address and '
          + 'this works properly from then on.'
        : `${size}This iPad can't be handed a file from inside the app.`,
      'Save anyway',
      anyway,
    );
  },

  watch({ id, name, bytes, href, filename, blocked, again, preview }) {
    this.id = id;
    this.again = again || null;
    clearInterval(this.timer);
    this.clearTap();

    $('#saveBarName').textContent = name;
    $('#saveBarPct').textContent = '';
    $('#saveBarFill').style.width = '0%';
    $('#saveBarNote').textContent = bytes
      ? `${formatBytes(bytes)} — starting…`
      : 'Starting…';
    $('#saveBar').hidden = false;

    // Taken with eyes open: this save works, and iOS puts its own file page
    // over the app at the end of it. Say how to get back before it happens,
    // rather than leaving somebody to work it out from a screen with no
    // buttons on it.
    if (preview) {
      $('#saveBarNote').textContent =
        `${bytes ? `${formatBytes(bytes)} — ` : ''}saving. iOS will show its own file `
        + 'page when it lands; swipe up from the bottom, or reopen the app, to come back.';
    }

    // The browser said outright that it would not start the download.
    if (blocked) return this.offerTap(href, filename,
      'Your browser blocked the download window.');

    // Otherwise wait and see. The box knows whether the file was ever asked
    // for, so a save that silently never began is detectable rather than a
    // bar sitting at nothing for ever — which is exactly what it did.
    let misses = 0;
    this.timer = setInterval(async () => {
      let s;
      try {
        s = await api('/api/save-progress', { id });
      } catch {
        misses += 1;
        // Eight seconds with the box never asked for a single byte: the
        // browser did not take it. Hand it over to a finger instead.
        if (misses === 16) {
          this.offerTap(href, filename, 'The browser did not start it.');
        }
        return;
      }
      if (this.id !== id) return;    // a newer save took the bar
      misses = 0;
      this.clearTap();
      this.paint(s);
    }, 500);
  },

  /**
   * When the browser refuses to start a download from script, ask the
   * viewer to start it themselves.
   *
   * A real link, tapped by a finger, is never treated as a popup and never
   * blocked — which is the whole reason this exists. It is offered rather
   * than done silently, because it is the one case where the app genuinely
   * cannot act on somebody's behalf.
   */
  /** A button in the bar that runs something when tapped. */
  offerAction(note, label, run) {
    clearInterval(this.timer);
    this.timer = null;
    this.clearTap();
    $('#saveBarNote').textContent = note;
    const button = el('button', 'btn btn-primary btn-sm save-bar-tap');
    button.id = 'saveBarTap';
    button.textContent = label;
    button.addEventListener('click', run);
    $('#saveBar').append(button);
  },

  offerTap(href, filename, why) {
    clearInterval(this.timer);
    this.timer = null;
    this.clearTap();
    $('#saveBarNote').textContent = `${why} Tap below to start it.`;

    const link = el('a', 'btn btn-primary btn-sm save-bar-tap');
    link.id = 'saveBarTap';
    link.href = href;
    link.textContent = 'Start the download';
    // The download attribute and nothing else. A target of _blank was here
    // once; installed to the home screen it is the same new-window road
    // that produced a browser page with no way out, and it is not worth a
    // second try on a link the viewer taps themselves either.
    link.download = filename;
    link.addEventListener('click', () => {
      $('#saveBarNote').textContent = 'Started — watching it now…';
      link.remove();
      // Back to watching: the bytes will start arriving in a moment.
      setTimeout(() => this.watch({ id: this.id, name: $('#saveBarName').textContent,
        bytes: 0, href, filename, blocked: false }), 1200);
    });
    $('#saveBar').append(link);
  },

  clearTap() {
    document.querySelector('#saveBarTap')?.remove();
  },

  paint(s) {
    const pct = s.total ? Math.min(100, (s.sent / s.total) * 100) : 0;
    $('#saveBarFill').style.width = `${pct.toFixed(1)}%`;
    $('#saveBarPct').textContent = `${Math.floor(pct)}%`;

    if (s.done) {
      $('#saveBarNote').textContent =
        `Saved — ${formatBytes(s.total)}. It is on this device now.`;
      $('#saveBarFill').style.width = '100%';
      $('#saveBarPct').textContent = '100%';
      this.finish(6000);
      return;
    }

    // Ended with bytes still owing is NOT the same as stopped. A browser
    // pulling a large file fetches it in ranges — one connection closes, the
    // next opens — so this is an ordinary moment in the middle of a healthy
    // download, and calling it stopped there would be a lie told every few
    // seconds on every phone. Only a connection that closed AND has stayed
    // quiet has really given up.
    if (s.ended && s.idleMs > 6000) {
      const note = `Stopped at ${formatBytes(s.sent)} of ${formatBytes(s.total)}.`;
      // The old text said "press save again", which meant finding the card
      // again on a page that has probably moved on since. Put the retry
      // where the bad news is.
      if (this.again) return this.offerAction(note, 'Try again', this.again);
      $('#saveBarNote').textContent = `${note} Press save again to retry.`;
      this.finish(9000);
      return;
    }

    const rate = s.bytesPerSec || 0;
    const left = rate > 0 ? (s.total - s.sent) / rate : 0;
    $('#saveBarNote').textContent =
      `${formatBytes(s.sent)} of ${formatBytes(s.total)}`
      + (rate > 0 ? ` · ${(rate / 1048576).toFixed(1)} MB/s` : '')
      + (left > 1 && !s.stalled ? ` · about ${etaText(left)} left` : '')
      + (s.stalled ? ' · paused or stopped' : '');
  },

  /** Stop asking, then clear the bar after a moment so the result is read. */
  finish(after) {
    clearInterval(this.timer);
    this.timer = null;
    setTimeout(() => {
      if (!this.timer) this.stop();
    }, after);
  },

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.id = '';
    this.again = null;
    this.clearTap();
    $('#saveBar').hidden = true;
  },
};

$('#saveBarClose').addEventListener('click', () => {
  // When the page is doing the fetching it can genuinely stop — the reader
  // loop notices the bar has been taken and cancels. When the browser owns
  // the download it cannot, and saying otherwise would be a lie.
  const ours = saveBar.id.startsWith('share-');
  saveBar.stop();
  toast(ours ? 'Stopped.' : 'Hidden — the save carries on in the browser.');
});

function saveToDevice(job) {
  handOverFile({
    url: `/api/downloads/${job.id}/save`,
    filename: `${job.name}.${job.ext}`,
    bytes: job.total || job.bytes || 0,
    name: job.name,
  });
}


/** Poster for a download: stored at save time, else matched from the library. */
function downloadPoster(job) {
  if (job.poster) return img(job.poster);
  const lib = state.library[job.kind === 'series' ? 'series' : 'movies'];
  const hit = (lib?.items || []).find((i) => String(i.id) === String(job.streamId));
  return hit ? hit.logo : '';
}

/**
 * The two steps, said once at the top of the page.
 *
 * Dismissible and remembered, because it is an explanation rather than a
 * warning — worth reading once and worth being able to put away.
 */
function downloadsExplainer() {
  const box = el('div', 'dl-explain');
  if (profiles.data?.dlExplainSeen) box.classList.add('is-brief');

  const line = el('p', 'dl-explain-line');
  line.innerHTML = '<strong>On the box</strong> plays instantly and costs no '
    + 'provider connection, so two of you can watch the same thing at once — '
    + 'but it still needs the Pi, so it is no use with the wifi down. '
    + '<strong>Save to device</strong> is the copy that lives on your phone.';
  box.append(line);

  const why = el('p', 'dl-explain-why');
  why.textContent = 'It goes to the Pi first because your phone never gets the '
    + 'provider password, and because the provider sends .mkv, which no phone '
    + 'will play. The Pi converts every finished download to MP4 — that is the '
    + 'file Save to device hands you.';
  box.append(why);

  const dismiss = el('button', 'dl-explain-x');
  dismiss.type = 'button';
  dismiss.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  dismiss.title = 'Got it';
  dismiss.setAttribute('aria-label', 'Got it');
  dismiss.addEventListener('click', async () => {
    box.classList.add('is-brief');
    if (profiles.current && !profiles.data.dlExplainSeen) {
      profiles.data.dlExplainSeen = true;
      await profiles.save();
    }
  });
  box.append(dismiss);
  return box;
}

function renderDownloads() {
  // render() hides everything before its branches now, but the download poll
  // re-renders this page directly; the list stays so those repaints stay
  // self-contained.
  $('#downloadList').hidden = true;
  $('#rowsView').hidden = true;
  $('#archiveView').hidden = true;
  $('#homeView').hidden = true;
  $('#seriesView').hidden = true;
  $('#loadMore').hidden = true;
  document.querySelector('.app-shell').classList.add('no-sidebar');

  const grid = $('#grid');
  grid.hidden = false;
  grid.className = 'grid';
  grid.innerHTML = '';
  // This lives outside #grid, so clearing the grid doesn't remove it — without
  // this, going in and out of a show stacks up back buttons.
  document.querySelectorAll('.folder-back').forEach((b) => b.remove());

  const items = state.downloads.items || [];
  const empty = $('#emptyState');

  if (!items.length) {
    empty.hidden = false;
    empty.textContent =
      'Nothing saved yet. Open a movie or episode and press the download arrow.';
    $('#contentMeta').textContent = '';
    openSeriesFolder = null;
    return;
  }
  empty.hidden = true;

  // What the two steps are for.
  //
  // This page used to call itself offline viewing, which was a lie: reaching
  // the player means reaching the Pi, so a file on the Pi is exactly as
  // unreachable as the stream when the wifi is out. What is on the Pi is a
  // cache — no provider connection, no waiting, and several people at once —
  // and the copy that is genuinely yours is the one Save to device makes.
  //
  // It cannot skip the Pi, and that is worth saying rather than leaving people
  // to wonder: the Pi holds the provider password so your phone never has it,
  // and the provider ships .mkv, which no phone will play. The Pi converts
  // every finished download to MP4 and it is that file Save to device hands
  // over.
  grid.append(downloadsExplainer());

  // Drilled into one show? Render just its episodes, with a way back out.
  if (openSeriesFolder) {
    const episodes = items
      .filter((j) => seriesKeyOf(j) === openSeriesFolder)
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

    if (!episodes.length) {
      openSeriesFolder = null; // last episode removed while we were inside
    } else {
      const back = el('button', 'btn btn-ghost folder-back');
      back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
      back.append(document.createTextNode(' All downloads'));
      back.addEventListener('click', () => {
        openSeriesFolder = null;
        renderDownloads();
      });
      grid.before(back);
      grid.dataset.folderBack = '1';

      const show = episodes[0].seriesName || episodes[0].name;
      $('#contentMeta').textContent = `${show} · ${episodes.length} episode${
        episodes.length === 1 ? '' : 's'
      }`;
      for (const job of episodes) grid.append(downloadCard(job));
      return;
    }
  }

  const done = items.filter((j) => j.status === 'done').length;
  $('#contentMeta').textContent =
    `${done} ready${state.downloads.queued ? ` · ${state.downloads.queued} queued` : ''}`;

  // Paused work gets one button back to running, not a hunt through the
  // cards. Paused only: failed jobs have a Retry of their own, and sweeping
  // them into this would re-run known-broken downloads on every press.
  const paused = items.filter((j) => j.status === 'paused');
  if (paused.length) {
    const all = el('button', 'btn btn-ghost resume-all');
    all.textContent = `Resume all (${paused.length})`;
    all.addEventListener('click', async () => {
      all.disabled = true;
      let woke = 0;
      for (const job of paused) {
        // Sequential on purpose: the queue runs one at a time anyway, and
        // this keeps its order the order the cards show.
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`/api/downloads/${job.id}/retry`, { method: 'POST' });
        if (res.ok) woke += 1;
      }
      await refreshDownloads({ rerender: true });
      toast(woke === paused.length
        ? `Resumed ${woke} download${woke === 1 ? '' : 's'}.`
        : `Resumed ${woke} of ${paused.length} — the rest had already moved on.`);
    });
    grid.append(all);
  }

  const frag = document.createDocumentFragment();

  // Episodes collapse into one card per show; films stay as they are.
  const shows = new Map();
  const loose = [];
  for (const job of items) {
    const key = seriesKeyOf(job);
    if (!key) {
      loose.push(job);
      continue;
    }
    if (!shows.has(key)) shows.set(key, []);
    shows.get(key).push(job);
  }

  for (const [key, episodes] of shows) frag.append(seriesFolderCard(key, episodes));
  for (const job of loose) frag.append(downloadCard(job));

  grid.append(frag);
}

/**
 * Play a finished download, and line up whatever follows it.
 *
 * A downloaded episode opens as a plain local file — the provider is out of
 * the loop entirely — so "next" here means the next episode of the same show
 * that is also on disk, not the next one that exists. Offering an episode that
 * has to be fetched would turn an offline watch into a stalled one.
 */
async function playDownload(job) {
  const poster = downloadPoster(job);
  await openPlayer({
    kind: 'movie',
    id: `dl-${job.id}`,
    name: job.name,
    logo: poster,
    directUrl: `/api/downloads/${job.id}/file`,
    sourceUrl: `x.${job.ext}`,
    localOnly: true,
    downloadId: job.id,
    // Shares its watch position with the streamed version.
    resumeKey: job.resumeKey || '',
  });

  // Closed, or moved on to something else, while this was buffering.
  if ($('#playerOverlay').hidden || film.item?.downloadId !== job.id) return;

  const after = nextDownloadedEpisode(job);
  upNext.arm(after && {
    label: after.season && after.episode
      ? `S${after.season} · E${after.episode} — ${after.name}`
      : after.name,
    start: () => playDownload(after),
  });
}

/** The next episode of the same show that is also finished downloading. */
function nextDownloadedEpisode(job) {
  const key = seriesKeyOf(job);
  if (!key || !job.season || !job.episode) return null;
  const order = (j) => Number(j.season) * 10000 + Number(j.episode);
  const mine = order(job);
  return (state.downloads.items || [])
    .filter((j) => j.status === 'done' && seriesKeyOf(j) === key && j.season && j.episode)
    .sort((a, b) => order(a) - order(b))
    .find((j) => order(j) > mine) || null;
}

/** Identity a download groups under, or '' for anything that isn't an episode. */
/**
 * How far through a download is, as a percentage.
 *
 * Two different questions wearing the same word. A provider download knows
 * how many bytes it is expecting, so bytes-of-bytes is the real fraction. A
 * title being converted off the archive drive has no such number — the mp4
 * an old .avi becomes is usually a fraction of the source's size, so
 * measuring the growing file against the source shows a bar creeping to a
 * third and then leaping to done, which reads as stuck. For those, ffmpeg
 * reports its own position and the index knows the runtime: minutes
 * converted out of minutes total, which is what somebody watching the card
 * actually wants to know.
 */
function downloadPercent(job) {
  if (job.convertDuration > 0 && job.convertSeconds >= 0) {
    return Math.max(0, Math.min(100,
      Math.floor((job.convertSeconds / job.convertDuration) * 100)));
  }
  return job.total ? Math.max(0, Math.min(100,
    Math.floor((job.bytes / job.total) * 100))) : 0;
}

function seriesKeyOf(job) {
  if (job.kind !== 'series') return '';
  if (job.seriesId) return `s${job.seriesId}`;
  // Downloads made before series fields were stored still carry a resume key
  // shaped `series:<id>:s1e2` — enough to group them.
  const m = /^series:([^:]+):/.exec(job.resumeKey || '');
  return m ? `s${m[1]}` : '';
}

/** One card standing for a whole show, opening its episode list when tapped. */
function seriesFolderCard(key, episodes) {
  const card = el('div', 'card dl-card dl-folder');
  const ready = episodes.filter((j) => j.status === 'done').length;
  const busy = episodes.filter((j) => j.status === 'downloading' || j.status === 'queued').length;
  const cover = episodes.find((j) => downloadPoster(j));

  const art = el('div', 'card-art');
  const poster = cover ? downloadPoster(cover) : '';
  if (poster) {
    const image = el('img');
    image.loading = 'lazy';
    image.alt = '';
    image.src = poster;
    art.append(image);
  } else {
    const fb = el('div', 'fallback');
    fb.textContent = episodes[0].seriesName || episodes[0].name;
    art.append(fb);
  }

  const badge = el('div', 'badge');
  badge.textContent = busy ? `${busy} DOWNLOADING` : `${episodes.length} EPISODES`;
  art.append(badge);

  // Stack edge, so it reads as a folder rather than a single episode.
  art.append(el('div', 'folder-edge'));

  const title = el('h3', 'card-title');
  title.textContent = episodes[0].seriesName || episodes[0].name;

  const sub = el('p', 'card-sub');
  const seasons = [...new Set(episodes.map((j) => j.season).filter(Boolean))];
  sub.textContent =
    (seasons.length === 1 ? `Season ${seasons[0]} · ` : seasons.length ? `${seasons.length} seasons · ` : '') +
    `${ready} of ${episodes.length} ready`;

  // Deletes the whole show. The episodes each keep their own X inside the
  // folder, so removing one of those leaves the rest alone.
  const remove = el('button', 'icon-btn dl-remove');
  remove.title = 'Delete this show';
  remove.setAttribute('aria-label', 'Delete this show');
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  remove.addEventListener('click', async (event) => {
    // Without this the same click opens the folder underneath it.
    event.stopPropagation();
    const show = episodes[0].seriesName || episodes[0].name;
    const count = episodes.length;
    if (!confirm(`Delete all ${count} episode${count === 1 ? '' : 's'} of “${show}”?`)) return;

    remove.disabled = true;
    // One at a time: every removal rewrites the download index, and firing
    // them together races that write.
    for (const episode of episodes) {
      await fetch(`/api/downloads/${episode.id}`, { method: 'DELETE' });
    }
    toast(`Deleted ${count} episode${count === 1 ? '' : 's'} of “${show}”.`);
    await refreshDownloads({ rerender: true });
  });
  art.append(remove);

  card.append(art, title, sub);
  card.addEventListener('click', () => {
    openSeriesFolder = key;
    renderDownloads();
  });
  return card;
}

/** Which show's episode list is open, or null at the top level. */
let openSeriesFolder = null;

function downloadCard(job) {
  {
    const card = el('div', `card dl-card dl-${job.status}`);

    const art = el('div', 'card-art');
    const poster = downloadPoster(job);
    if (poster) {
      const image = el('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = poster;
      image.addEventListener('error', () => {
        image.remove();
        const fb = el('div', 'fallback');
        fb.textContent = job.name;
        art.append(fb);
      });
      art.append(image);
    } else {
      const fb = el('div', 'fallback');
      fb.textContent = job.name;
      art.append(fb);
    }

    // Status badge
    const badge = el('div', 'badge dl-badge');
    const pct = downloadPercent(job);
    badge.textContent =
      job.status === 'done'
        ? 'READY'
        : job.status === 'downloading'
          ? `${pct}%`
          : job.status === 'queued'
            ? 'QUEUED'
            : job.status === 'paused'
              ? job.autoPaused
                ? 'WAITING'
                : 'PAUSED'
              : 'FAILED';
    art.append(badge);

    // Progress across the foot of the poster while it's still coming down.
    if (job.status === 'downloading' || job.status === 'paused') {
      const bar = el('div', 'dl-artbar');
      const fill = el('div', 'dl-artfill');
      fill.style.width = job.total ? `${(job.bytes / job.total) * 100}%` : '4%';
      bar.append(fill);
      art.append(bar);
    }

    if (job.status === 'done') {
      art.style.cursor = 'pointer';
      art.addEventListener('click', () => playDownload(job));
    }

    const title = el('h3', 'card-title');
    title.textContent = job.name;

    // Still in its original container after downloading? Then it plays via
    // on-the-fly conversion, which is the slow path this whole feature exists
    // to avoid — say so plainly instead of letting it look finished.
    const unoptimized =
      job.status === 'done' && !job.preparing && !NATIVE_CONTAINERS.includes(String(job.ext || '').toLowerCase());

    // Optimizing is not a decision anybody would ever make differently, so
    // there is no longer a button for it — the box converts every finished
    // download on its own and keeps trying if something is in the way. The
    // card only reports where that has got to. Same for a failed download:
    // it retries itself rather than waiting to be asked.
    const sub = el('p', 'card-sub');
    sub.textContent =
      job.status === 'done'
        ? job.preparing
          ? 'Optimizing for instant playback…'
          : unoptimized
            ? job.prepareError
              ? `Optimizing shortly — ${job.prepareError}`
              : 'Optimizing shortly…'
            : formatBytes(job.total)
        : job.status === 'error'
          ? job.permanent || (job.tries || 0) >= 8
            ? job.error || 'Failed'
            : `${job.error || 'Failed'} — trying again shortly`
          : job.status === 'downloading'
            // A conversion off the drive is not fetching anything, so "X of
            // Y megabytes" would be describing the wrong thing entirely.
            // Minutes converted, and how big it has become so far.
            ? (job.convertDuration > 0
              ? `Converting — ${hms(Math.floor(job.convertSeconds || 0))} of `
                + `${hms(Math.floor(job.convertDuration))}`
                + `${job.bytes ? ` · ${formatBytes(job.bytes)} so far` : ''}`
              : `${formatBytes(job.bytes)} of ${formatBytes(job.total)}`)
            : job.status === 'paused'
              ? job.autoPaused
                ? 'Paused while you watch — resumes on its own'
                : `${formatBytes(job.bytes)} saved`
              // A queued archive title is waiting for the encoder's turn, not
              // for a connection it never needed — saying "the connection"
              // there sent somebody looking for a network fault.
              : job.archivePath ? 'Waiting its turn to convert'
                : 'Waiting for the connection';

    const actions = el('div', 'dl-actions');

    if (job.status === 'done') {
      // A button rather than a bare link, so it goes through the one place
      // that opens the file in a new context and says what is happening.
      // As a plain same-window link it replaced the whole app with the
      // system's video viewer, which on a home-screen install has no way
      // back out of it at all.
      const save = el('button', 'btn btn-ghost btn-sm');
      save.textContent = 'Save to device';
      save.addEventListener('click', (event) => {
        event.stopPropagation();
        saveToDevice(job);
      });
      actions.append(save);
    }

    if (job.status === 'downloading' || job.status === 'queued') {
      const pause = el('button', 'btn btn-ghost btn-sm');
      pause.textContent = 'Pause';
      pause.title = 'Frees your single provider connection so you can watch';
      pause.addEventListener('click', async () => {
        pause.disabled = true;
        await fetch(`/api/downloads/${job.id}/pause`, { method: 'POST' });
        await refreshDownloads({ rerender: true });
      });
      actions.append(pause);
    }

    // Resume stays: a download paused by hand is waiting on a decision, and
    // that decision is yours. A FAILED one is not — it retries itself, so
    // the Retry button that used to sit here is gone.
    if (job.status === 'paused') {
      const resume = el('button', 'btn btn-ghost btn-sm');
      resume.textContent = 'Resume';
      resume.addEventListener('click', async () => {
        resume.disabled = true;
        await fetch(`/api/downloads/${job.id}/retry`, { method: 'POST' });
        await refreshDownloads({ rerender: true });
      });
      actions.append(resume);
    }

    const remove = el('button', 'icon-btn dl-remove');
    remove.title = 'Remove';
    remove.setAttribute('aria-label', 'Remove download');
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      const verb = job.status === 'done' ? 'Delete' : 'Cancel';
      if (!confirm(`${verb} “${job.name}”?`)) return;
      await fetch(`/api/downloads/${job.id}`, { method: 'DELETE' });
      await refreshDownloads({ rerender: true });
    });
    art.append(remove);

    card.append(art, title, sub, actions);
    return card;
  }
}


/** Queue the thing currently open in the player. */
/** Whichever season the episode sheet is currently showing. */
let currentSeason = null;

/**
 * Queue every episode of the season on screen, skipping any already on disk
 * or already queued. They run one at a time — the provider allows a single
 * connection — so this is a queue, not a parallel burst.
 */
/**
 * The download that already covers this title, in any state that still
 * counts — a failed one does not, because failing is exactly when asking
 * again should work.
 */
function downloadJobFor(kind, streamId) {
  const want = kind === 'series' ? 'series' : 'movie';
  return (state.downloads.items || []).find(
    (j) => j.kind === want && String(j.streamId) === String(streamId) && j.status !== 'error'
  );
}

async function requestSeasonDownload() {
  if (!currentSeason || !currentSeason.episodes.length) {
    return toast('No season is open.');
  }
  const { item, season, episodes } = currentSeason;

  await refreshDownloads();
  // Anything already saved or on its way is skipped; a failed attempt is
  // not, since asking again is the whole point after a failure.
  const pending = episodes.filter((e) => !downloadJobFor('series', e.id));

  if (!pending.length) {
    return toast(`Season ${season} is already downloaded.`);
  }

  // This can be many gigabytes on a Pi, so make the size of it explicit
  // rather than silently queueing twenty episodes.
  const skipped = episodes.length - pending.length;
  const ok = confirm(
    `Download ${pending.length} episode${pending.length === 1 ? '' : 's'} ` +
      `of ${item.name} — Season ${season}?` +
      (skipped ? `\n\n${skipped} already downloaded and will be skipped.` : '') +
      `\n\nThey download one at a time and pause automatically while you watch.`
  );
  if (!ok) return;

  let queued = 0;
  let refused = '';
  for (const episode of pending) {
    // Sequential: each POST is cheap, and this keeps queue order predictable.
    // eslint-disable-next-line no-await-in-loop
    const done = await requestDownload(item, { ...episode, season }, { quiet: true });
    if (done.ok) queued += 1;
    else if (!refused) refused = done.error;
  }

  await refreshDownloads({ rerender: true });
  // "Queued 0 episodes" is not an answer. If the server turned them down —
  // most likely the download allowance — say what it said.
  if (refused && !queued) toast(refused);
  else if (refused) {
    toast(`Queued ${queued} of ${pending.length} — ${refused}`);
  } else {
    toast(`Queued ${queued} episode${queued === 1 ? '' : 's'} of Season ${season}.`);
  }
}

async function requestDownload(item, episode, { quiet = false } = {}) {
  // Never twice. The server refuses duplicates too; catching it here makes
  // the answer instant and phrased for the button that was pressed.
  const dup = downloadJobFor(episode ? 'series' : item.kind, episode ? episode.id : item.id);
  if (dup) {
    const said = dup.status === 'done'
      ? 'Already downloaded — it\'s in Downloads.'
      : 'Already in the download queue.';
    if (!quiet) toast(said);
    return { ok: false, error: said };
  }
  // Keep the artwork with the job so the Downloads grid has a poster even
  // before the library has been loaded in this session.
  const poster = item.logo && item.logo.startsWith('/img?u=')
    ? decodeURIComponent(item.logo.slice('/img?u='.length))
    : item.logo || '';

  const payload = episode
    ? {
        kind: 'series',
        streamId: episode.id,
        ext: episode.container_extension || 'mp4',
        poster,
        // Stored so the offline copy resumes at the same point as the stream.
        resumeKey: `series:${item.id}:s${episode.season}e${episode.episode_num}`,
        // Lets Downloads group episodes under their show.
        seriesId: item.id,
        seriesName: item.name,
        season: episode.season,
        episode: episode.episode_num,
        name: `${item.name} S${episode.season}E${episode.episode_num} ${episode.title || ''}`.trim(),
      }
    : {
        kind: 'movie',
        streamId: item.id,
        ext: item.ext || 'mp4',
        poster,
        resumeKey: `movie:${item.id}`,
        name: item.name,
        sourceUrl: item.localOnly ? '' : undefined,
      };

  if (item.directUrl && !item.localOnly) {
    payload.sourceUrl = item.sourceUrl;
    payload.streamId = '';
  }

  // Whose allowance this comes out of. The server decides what that allowance
  // is and whether there is room; this only says who is asking.
  payload.profileId = profiles.current?.id || '';

  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not queue that download.');
    // A season download reports once at the end rather than per episode.
    if (quiet) return { ok: true, error: '' };
    await refreshDownloads({ rerender: true });
    toast(
      state.downloads.queued > 1
        ? `Queued “${payload.name}”. It starts when the current one finishes.`
        : `Downloading “${payload.name}”. Watch progress in Downloads.`
    );
    return { ok: true, error: '' };
  } catch (err) {
    if (!quiet) toast(err.message);
    return { ok: false, error: err.message };
  }
}

/* ---------------------------------------------------------------- router */

/* --------------------------------------------------------------- archive ---

 * The external drive. Unlike the provider tabs there is no catalogue to fetch
 * and cache — the server holds a pre-built index, so browsing is one cheap
 * request per folder and search is instant across all of it.
 */

/** Containers a phone opens as they arrive. Everything else needs converting. */
const ARCHIVE_NATIVE = new Set(['mp4', 'm4v', 'mov']);

/** The identity an archive title carries through the downloads machinery. */
const archiveStreamId = (entry) => `archive:${entry.path}`;

/**
 * Put an archive title on the device you are holding.
 *
 * Two roads, because the drive holds two kinds of file and pretending
 * otherwise would either waste the box's disk or hand you something your
 * phone will not open:
 *
 *   * **mp4, m4v, mov** — already exactly what you want. The bytes come
 *     straight off the drive with a filename on them: instant, and it costs
 *     the box nothing at all. No queue, no copy, no allowance spent.
 *   * **everything else** — .avi and .mkv are most of the drive and no phone
 *     opens either. The box converts it once into Downloads, and from there
 *     the same button hands it over. That costs time and some of the
 *     allowance, which is why it is not done for files that never needed it.
 *
 * The drive itself is only ever read. Nothing here writes to it.
 */
function saveArchiveToDevice(entry) {
  handOverFile({
    url: `/archive/file?path=${encodeURIComponent(entry.path)}&save=1`,
    filename: `${entry.title || 'video'}.${entry.container || 'mp4'}`,
    bytes: Number(entry.size) || 0,
    name: entry.title || 'this',
  });
}

async function requestArchiveDownload(entry) {
  const payload = {
    kind: 'movie',
    archivePath: entry.path,
    name: entry.title || entry.path,
    resumeKey: `archive:${entry.path}`,
    profileId: profiles.current?.id || '',
  };
  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not queue that.');
    await refreshDownloads({ rerender: true });
    toast(`Converting “${payload.name}” — it appears in Downloads, ready to save.`);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

/**
 * The button on an archive card. What it does depends on where the file
 * already is, and it says so rather than looking the same in every state.
 */
function archiveSaveButton(entry) {
  const btn = el('button', 'icon-btn archive-dl');
  const native = ARCHIVE_NATIVE.has(String(entry.container || '').toLowerCase());
  const job = downloadJobFor('movie', archiveStreamId(entry));
  const arrow = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>';

  const say = (title) => {
    btn.title = title;
    btn.setAttribute('aria-label', title);
  };

  if (job && job.status === 'done') {
    btn.classList.add('is-saved');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-10"/></svg>';
    say('Converted and ready — save it to this device');
    btn.onclick = (event) => {
      event.stopPropagation();
      saveToDevice(job);
      toast(`Saving “${job.name}” to this device.`);
    };
  } else if (job) {
    btn.classList.add('is-queued');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>';
    say('Being converted on the box — watch it in Downloads');
    btn.onclick = (event) => {
      event.stopPropagation();
      toast('Already converting. It shows up in Downloads when it is ready.');
    };
  } else if (native) {
    btn.innerHTML = arrow;
    say('Save to this device');
    btn.onclick = (event) => {
      event.stopPropagation();
      saveArchiveToDevice(entry);
      toast(`Saving “${entry.title}” to this device.`);
    };
  } else {
    btn.innerHTML = arrow;
    say(`Convert this ${String(entry.container || '').toUpperCase()} on the box, then save it`);
    btn.onclick = async (event) => {
      event.stopPropagation();
      btn.disabled = true;
      const ok = await requestArchiveDownload(entry);
      btn.disabled = false;
      // Repaint the grid so the mark on this card reflects what just happened.
      if (ok && state.tab === 'archive') renderArchive();
    };
  }
  return btn;
}

const ARCHIVE_MODE_LABEL = {
  direct: '',                    // plays as-is; nothing worth saying
  remux: '',                     // ~1s of ffmpeg; not worth a badge either
  transcode: 'Converts on play',
};

/** The card's face: a frame from a quarter of the way in, made on the Pi. */
function archiveThumbUrl(relPath) {
  return `/api/archive/thumb?path=${encodeURIComponent(relPath)}`
    + `&profileId=${encodeURIComponent(profiles.current?.id || '')}`;
}

function archiveItemToPlayable(entry) {
  // Shape an index record into something openPlayer already understands.
  return {
    kind: 'movie',
    id: `archive:${entry.path}`,
    name: entry.title,
    archivePath: entry.path,
    archiveMode: entry.playback,
    localOnly: true,
    resumeKey: `archive:${entry.path}`,
    duration: entry.duration,
    // The history row stores this as the poster, which is what puts a face on
    // the home screen's Continue watching card for an archive title.
    logo: archiveThumbUrl(entry.path),
    plot: [
      entry.date ? entry.date.replace(/-/g, '.') : '',
      entry.tags && entry.tags.length ? entry.tags.join(' · ') : '',
      entry.width ? `${entry.width}×${entry.height}` : '',
      entry.size ? `${(entry.size / 1024 / 1024 / 1024).toFixed(2)} GB` : '',
    ]
      .filter(Boolean)
      .join('  ·  '),
  };
}

function archiveCard(entry) {
  const card = document.createElement('button');
  card.className = 'card archive-card';
  card.type = 'button';

  const mins = entry.duration ? `${Math.round(entry.duration / 60)} min` : '';
  const badge = ARCHIVE_MODE_LABEL[entry.playback] || '';

  card.innerHTML = `
    <span class="archive-card-art"></span>
    <span class="archive-card-date">${entry.date ? entry.date.replace(/-/g, '.') : ''}</span>
    <span class="archive-card-title"></span>
    <span class="archive-card-meta">${[mins, entry.tags?.[entry.tags.length - 1] || '']
      .filter(Boolean)
      .join(' · ')}</span>
    ${badge ? `<span class="archive-card-badge">${badge}</span>` : ''}
  `;
  // Titles come from filenames on a drive of unknown provenance — set as text
  // so a stray angle bracket in a filename can never become markup.
  card.querySelector('.archive-card-title').textContent = entry.title;
  // A frame from the file itself, made lazily as the card scrolls into view.
  // If the drive is unplugged or the frame cannot be cut, the image goes and
  // the card is the typographic face it always was — never a broken glyph.
  const face = el('img');
  face.loading = 'lazy';
  face.alt = '';
  face.src = archiveThumbUrl(entry.path);
  face.addEventListener('error', () => card.querySelector('.archive-card-art')?.remove());
  card.querySelector('.archive-card-art').append(face);

  // A child of the CARD, not of the artwork: a frame that cannot be cut
  // removes the art box entirely, and the way to save a file must not
  // disappear along with its thumbnail. Its own click never reaches the card
  // underneath — saving a film and playing it are different intentions.
  card.append(archiveSaveButton(entry));

  card.onclick = () => openPlayer(archiveItemToPlayable(entry));
  return card;
}

async function loadArchive(dir = '') {
  state.archive.dir = dir;
  state.archive.visible = PAGE_SIZE;
  state.archive.searching = false;
  state.archive.data = await api('/api/archive/browse', {
    dir,
    profileId: profiles.current?.id || '',
  });
}

async function searchArchive(q) {
  state.archive.searching = true;
  state.archive.visible = PAGE_SIZE;
  const res = await api('/api/archive/search', {
    q,
    profileId: profiles.current?.id || '',
  });
  state.archive.data = { dir: state.archive.dir, subdirs: [], items: res.items, total: res.total };
}

function renderArchive() {
  $('#grid').hidden = true;
  $('#rowsView').hidden = true;
  $('#downloadList').hidden = true;
  $('#homeView').hidden = true;
  $('#seriesView').hidden = true;
  $('#loadMore').hidden = true;
  $('#archiveView').hidden = false;
  document.querySelector('.app-shell').classList.add('no-sidebar');

  const st = state.archive.status;
  const statusEl = $('#archiveStatus');
  if (st && st.error) {
    statusEl.textContent = st.error;
    statusEl.className = 'archive-status is-warn';
  } else if (st && !st.mounted) {
    statusEl.textContent = 'Drive not mounted — nothing will play until it is plugged in.';
    statusEl.className = 'archive-status is-warn';
  } else if (st) {
    statusEl.textContent = `${st.indexed.toLocaleString()} files`;
    statusEl.className = 'archive-status';
  }

  // Breadcrumbs
  const crumbs = $('#archiveCrumbs');
  crumbs.innerHTML = '';
  const mk = (label, dir) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'crumb';
    b.textContent = label;
    b.onclick = async () => {
      await loadArchive(dir);
      render();
    };
    return b;
  };
  crumbs.append(mk('Archive', ''));
  if (!state.archive.searching) {
    const parts = state.archive.dir ? state.archive.dir.split('/') : [];
    parts.forEach((part, i) => {
      crumbs.append(Object.assign(document.createElement('span'), {
        className: 'crumb-sep',
        textContent: '›',
      }));
      crumbs.append(mk(part, parts.slice(0, i + 1).join('/')));
    });
  } else {
    crumbs.append(Object.assign(document.createElement('span'), {
      className: 'crumb-sep',
      textContent: '›',
    }));
    crumbs.append(Object.assign(document.createElement('span'), {
      className: 'crumb is-static',
      textContent: `Search results (${state.archive.data?.total ?? 0})`,
    }));
  }

  const data = state.archive.data || { subdirs: [], items: [], total: 0 };

  // Folders
  const folders = $('#archiveFolders');
  folders.innerHTML = '';
  for (const sub of data.subdirs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'folder-chip';
    b.innerHTML = `<span class="folder-name"></span><span class="folder-count">${sub.count.toLocaleString()}</span>`;
    b.querySelector('.folder-name').textContent = sub.name;
    b.onclick = async () => {
      await loadArchive(sub.dir);
      render();
    };
    folders.append(b);
  }

  // Items
  const grid = $('#archiveGrid');
  grid.innerHTML = '';
  const slice = data.items.slice(0, state.archive.visible);
  const frag = document.createDocumentFragment();
  for (const entry of slice) frag.append(archiveCard(entry));
  grid.append(frag);

  const more = $('#archiveMore');
  more.hidden = data.items.length <= state.archive.visible;
  more.onclick = () => {
    state.archive.visible += PAGE_SIZE;
    renderArchive();
  };

  const empty = $('#emptyState');
  if (!data.subdirs.length && !data.items.length) {
    empty.hidden = false;
    empty.textContent = state.archive.searching
      ? 'Nothing in the archive matches that.'
      : 'This folder is empty.';
  } else {
    empty.hidden = true;
  }
}

async function goTo(tab) {
  state.tab = tab;
  // Leave home the moment the tab changes rather than once the new tab has
  // drawn. A tab whose library fails to load returns before render() ever
  // runs, which left the whole home screen sitting there underneath the error.
  if (tab !== 'home') $('#homeView').hidden = true;
  if (tab !== 'series' && tab !== 'movies') $('#seriesView').hidden = true;
  // Same reason as the two lines above: a tab whose library fails to load
  // returns before render(), and a Live TV button left sitting on Movies is
  // the kind of thing that only shows up when something else is broken.
  applyMultiviewButton();
  // Leaving Live TV leaves the listings behind with it — coming back to a
  // schedule you opened twenty minutes ago is not what anyone means by
  // going to Live TV.
  if (tab !== 'live') state.listings = false;
  applyListingsButton();
  applyWideSearchButton();
  state.category = null;
  state.shelf = null;
  state.visible = PAGE_SIZE;
  state.catQuery = '';
  state.query = '';
  $('#catSearch').value = '';
  $('#searchInput').value = '';

  if (tab === 'downloads') {
    await refreshDownloads();
    return render();
  }
  if (tab === 'archive') {
    // Hidden tabs can still be typed into the address bar. Not this one.
    if (!reporter.isOwner()) {
      location.hash = '#/home';
      return;
    }
    renderSkeletons();
    try {
      // Status is cheap and says up front whether the drive is actually
      // there, so a missing mount reads as a clear message rather than an
      // empty grid the user has to interpret.
      state.archive.status = await api('/api/archive/status', {
        profileId: profiles.current?.id || '',
      });
      await loadArchive(state.archive.dir || '');
    } catch (err) {
      $('#grid').innerHTML = '';
      const empty = $('#emptyState');
      empty.hidden = false;
      empty.textContent = `Couldn't read the archive: ${err.message}`;
      return;
    } finally {
      loader.hide();
    }
    return render();
  }
  if (tab === 'home') {
    // Draw first, refresh after. Awaiting the history call before rendering
    // anything meant the badge did nothing at all until it came back, and over
    // a slow link to the box that is long enough to look broken.
    render();
    profiles.loadTaste().then(() => {
      if (state.tab === 'home') render();
    });
    return;
  }
  if (tab === 'favorites' || tab === 'favlive') return render();

  // For You reflects what's been watched since the page was last opened.
  if (tab === 'movies' || tab === 'series') await profiles.loadTaste();

  if (!state.library[tab]) {
    renderSkeletons();
    try {
      await loadTab(tab);
    } catch (err) {
      $('#grid').innerHTML = '';
      const empty = $('#emptyState');
      empty.hidden = false;
      empty.textContent = `Couldn't load ${tab}: ${err.message}`;
      return;
    } finally {
      loader.hide();
    }
  }
  render();
}

const TABS = ['home', 'live', 'movies', 'series', 'favorites', 'favlive', 'archive', 'downloads'];

/**
 * The tab, and for a series the show that is open.
 *
 * `#/series/1234` is a real route rather than internal state so the browser's
 * own back button leaves a show the way you would expect, and so the player
 * has somewhere to return to by name.
 *
 * Home is the landing page and the badge is the way back to it, but it is
 * deliberately not a tab — favlive is likewise reachable only from there.
 */
function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const parts = raw.split('/');
  const tab = parts[0].toLowerCase();
  return {
    tab: TABS.includes(tab) ? tab : 'home',
    // Ids are numbers and the one word this takes is 'by', so lowercasing is
    // safe here — but NOT for what follows it, which is somebody's name.
    param: (parts[1] || '').toLowerCase(),
    rest: parts.slice(2).join('/'),
  };
}

function applyRoute() {
  const { tab, param, rest } = routeFromHash();
  state.seriesId = tab === 'series' ? param : '';
  /* #/movies/by/<name> is a person's films; anything else after #/movies is a
     film's own id. The name keeps its capitals and its accents — it is shown
     as a heading, and it is what the box is asked about. */
  const byPerson = tab === 'movies' && param === 'by' && rest;
  state.person = byPerson ? decodeURIComponent(rest) : '';
  state.movieId = tab === 'movies' && !byPerson ? param : '';
  return goTo(tab);
}

window.addEventListener('hashchange', applyRoute);

/* ---------------------------------------------------------------- player */

let engine = null;
/** Which decoder is driving playback, for the diagnostics report. */
let engineKind = null;

function teardown() {
  const video = $('#video');
  // Whatever the old stream was waiting for, it is not coming now.
  stopCushionWait();
  if (engine) {
    try {
      engine.destroy();
    } catch {
      /* engine already gone */
    }
    engine = null;
  }
  video.removeAttribute('src');
  video.load();
}

function status(message) {
  const node = $('#videoStatus');
  if (!message) {
    node.hidden = true;
    // Clear it rather than just hiding it: a stale line left in the DOM comes
    // back the next time something unhides this without setting it.
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

/**
 * Pick a playback engine. Our proxy URLs carry no file extension, so the
 * format has to be passed in explicitly.
 */
function attach(url, format, opts = {}) {
  const video = $('#video');

  teardown();
  // Overridden below if a library takes over; otherwise the element itself is
  // doing the decoding.
  engineKind = 'native';
  status(format === 'ts' ? 'Tuning in — skipping the provider backlog…' : 'Connecting to stream…');

  // Always start at normal speed.
  //
  // This used to carry the previous rate across an attach, so a speed-control
  // extension would keep its setting. That turned out to be a ratchet: if the
  // rate was ever wrong — the extension's own hotkeys sit on plain letter keys
  // and fire while the player has focus — every later seek copied the bad value
  // forward and it could never recover. Normalising here means a seek or a
  // reopen always clears it, and an extension is free to re-apply its own rate.
  video.playbackRate = 1;
  video.defaultPlaybackRate = 1;
  // Assigning a value it already holds fires no ratechange, so repaint by hand
  // or the warning badge lingers after the rate is back to normal.
  paintSpeed();

  // A natively-played file seeks itself; a remux was already started at the
  // right offset server-side, so this only applies to the direct-file path.
  if (opts.seekTo > 0) {
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (Number.isFinite(video.duration) && opts.seekTo < video.duration) {
          video.currentTime = opts.seekTo;
        }
      },
      { once: true }
    );
  }

  const clearOnPlay = () => status('');
  video.addEventListener('playing', clearOnPlay, { once: true });

  // Every path that resolves a stream sets `lastRemux` first — to the response
  // for a conversion, or to `{}` for anything that plays directly — so hanging
  // the subtitle tracks here catches all of them, including a seek, which is a
  // whole new session with a whole new set of files.
  captions.attach(lastRemux);

  if (format === 'ts') {
    if (window.mpegts && mpegts.isSupported()) {
      // mpegts.js does its fetching inside a Web Worker, which has no document
      // base URL — a relative path throws "Failed to parse URL". Absolutise it.
      const absolute = new URL(url, location.href).href;
      engineKind = 'mpegts.js';
      engine = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url: absolute },
        {
          enableWorker: true,
          // The provider delivers in lumpy 4-5s chunks. mpegts.js's built-in
          // chaser fires above 1.5s of buffer, so it would seek on every lump —
          // that's the "skips to the end" behaviour. We manage the live edge
          // ourselves instead, and only when it's genuinely drifted.
          liveBufferLatencyChasing: false,
          // Don't hold data back before handing it to the decoder.
          enableStashBuffer: false,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 30,
          autoCleanupMinBackwardDuration: 10,
        }
      );
      engine.attachMediaElement(video);
      engine.load();
      engine.play().catch(() => {});
      engine.on(mpegts.Events.ERROR, (type, detail) =>
        status(`Stream error (${type}: ${detail}). Try switching this provider to HLS in settings.`)
      );
      return;
    }
    status('MPEG-TS playback is unavailable in this browser. Switch to HLS in settings.');
    return;
  }

  if (format === 'm3u8') {
    if (window.Hls && Hls.isSupported()) {
      // VOD is a remux we deliberately ran ahead of the player, so let hls.js
      // pull as much of that cushion into memory as it can. Live keeps the
      // tight settings — a big forward buffer there is just added latency.
      const live = format === 'ts' || currentLiveItem;
      engineKind = 'hls.js';
      engine = new Hls(
        live
          ? { ...LIVE_HLS, ...(opts.dvr ? { liveSyncDuration: LIVE_DVR_SEAT } : {}),
            ...(lowMode() ? LOW_PATIENCE : {}) }
          : {
              ...(lowMode() ? LOW_PATIENCE : {}),
              lowLatencyMode: false,
              // Keep everything behind the playhead. While a conversion is
              // still running the playlist has no end marker, so hls.js reads
              // it as live — and with a back buffer being evicted the playhead
              // can fall outside the window and get dragged forward to the
              // "live edge", i.e. the conversion frontier. Never evicting means
              // the window always starts at zero and nothing yanks playback.
              backBufferLength: Infinity,
              // Don't let it hunt for a live edge that is really just ffmpeg
              // running ahead of us.
              liveSyncDuration: 1e9,
              liveMaxLatencyDuration: 2e9,
              liveDurationInfinity: false,
              maxBufferLength: 120,
              maxMaxBufferLength: 300,
              maxBufferSize: 200 * 1000 * 1000,
              // Drawing captions is the captions module's job, never hls.js's.
              subtitleDisplay: false,
              // A remux in progress has no ENDLIST yet, so hls.js reads it as
              // live and would join at the edge — i.e. however many seconds we
              // prebuffered into the film. Films start at the beginning —
              // except an archive resume, where the conversion always runs
              // from the top and the resume point is a place INSIDE the
              // output, handed here to start playback at.
              startPosition: opts.seekTo > 0 ? opts.seekTo : 0,
            }
      );
      engine.loadSource(url);
      engine.attachMedia(video);
      if (live) waitForCushion(video);
      engine.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) engine.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) engine.recoverMediaError();
        else status(`Playback failed: ${data.details}`);
      });
      return;
    }
    // Safari plays HLS natively. Same live-edge trap applies on iOS, so pin a
    // remuxed film to the start once metadata lands — unless this attach
    // carries a resume point, in which case the seekTo listener above has
    // already moved the playhead on purpose and pinning would undo it.
    video.src = url;
    if (!currentLiveItem && !(opts.seekTo > 0)) {
      video.addEventListener(
        'loadedmetadata',
        () => {
          if (video.currentTime > 1) video.currentTime = 0;
        },
        { once: true }
      );
    }
    video.play().catch(() => {});
    return;
  }

  video.src = url;
  video.play().catch(() => status('Press play to start.'));
  video.addEventListener(
    'error',
    () => status('This file format may not be supported by the browser (MKV and AVI usually are not).'),
    { once: true }
  );
}

/* --------------------------------------------------------- live edge UI */

let liveTimer = null;

/** How far behind the live edge we currently are, in seconds. */
function currentLag() {
  // The distance that matters is to the LIVE EDGE — the newest moment the
  // playlist publishes — and hls.js can say it directly. The old measure was
  // to the end of the DOWNLOADED buffer, which is a different number that
  // lies in exactly the worst moment: on a starved link the buffer runs dry,
  // the gap to it reads zero, and the pill said "LIVE" to a viewer who was
  // half a minute behind with no cushion at all. The delay is deliberate;
  // the pill's job is to show it, not to hide it behind the buffer state.
  if (engineKind === 'hls.js' && engine) {
    try {
      const edge = engine.latency;
      if (Number.isFinite(edge) && edge > 0) return edge;
    } catch {
      /* fall through to the buffered measure */
    }
  }
  const video = $('#video');
  if (!video.buffered.length) return null;
  return video.buffered.end(video.buffered.length - 1) - video.currentTime;
}

function startLiveTracking() {
  stopLiveTracking();
  const pill = $('#livePill');
  const lag = $('#liveLag');
  pill.hidden = false;
  reservePlayerActions();

  liveTimer = setInterval(() => {
    const behind = currentLag();
    if (behind === null) return;
    // The seat is 30-45 seconds back BY DESIGN, so "behind" is the normal,
    // healthy state and is shown as a plain fact rather than a warning. The
    // word LIVE is reserved for genuinely riding the edge, which the seat
    // means should essentially never be claimed.
    const atEdge = behind < 5;
    pill.classList.toggle('is-behind', !atEdge);
    lag.textContent = atEdge ? 'LIVE' : `${Math.round(behind)}s delay`;
  }, 1000);
}

let cushionTimer = null;

/**
 * Don't start a live channel until there is something in hand to play.
 *
 * The video element starts as soon as it has one frame it can show, which on a
 * slow link means starting with a single segment and stalling the moment it is
 * spent. From a measured session:
 *
 *     +13s  first segment lands (10s of media, 13s to arrive)  play starts
 *     +20s  playhead reaches the end of it
 *     +21s  stalled
 *     +28s  second segment lands (10s of media, 15s to arrive)
 *
 * It played the 7.1 seconds it had and then had nothing, which is not a stall
 * in any interesting sense — it is starting before there was anything to start
 * with. Meanwhile 33 seconds of playlist was published and simply not fetched
 * yet, so the material was there; only the head start was missing.
 *
 * So live waits. It is the "delay it a few more seconds" fix, spent once at the
 * join instead of a stall a few seconds later, and it is spent visibly — the
 * number counts up, because a picture that does not appear is otherwise
 * indistinguishable from a broken one.
 *
 * The wait is capped both ways. A link fast enough to fill it never notices;
 * a link too slow to fill it starts anyway at `LIVE_WAIT_MAX`, because a stall
 * you can see the reason for still beats a spinner that never ends.
 */
const LIVE_WAIT_MAX = 10000;

function waitForCushion(video) {
  stopCushionWait();
  const until = Date.now() + LIVE_WAIT_MAX;
  // Fall back to the join distance when no window has been published yet;
  // whichever is known, the target is a few segments rather than a guess.
  let want = Math.min(LIVE_HLS.liveSyncDuration * LIVE_PREROLL, LIVE_PREROLL_CAP);

  const ahead = () => {
    if (!video.buffered.length) return 0;
    const from = Math.max(video.currentTime, video.buffered.start(0));
    return Math.max(0, video.buffered.end(video.buffered.length - 1) - from);
  };

  const tick = () => {
    if (!currentLiveItem) return stopCushionWait();
    try {
      const w = engine?.levels?.[engine.currentLevel]?.details?.totalduration;
      if (Number.isFinite(w) && w > 0) want = Math.min(w * LIVE_PREROLL, LIVE_PREROLL_CAP);
    } catch {
      /* no window published yet — the fallback above stands */
    }
    const have = ahead();
    if (have >= want || Date.now() >= until) {
      stopCushionWait();
      status('');
      video.play().catch(() => {});
      return;
    }
    // Keep it held. `autoplay` will start it the instant it can, so this has
    // to actively hold rather than just decline to call play().
    if (!video.paused) video.pause();
    status(`Building a buffer — ${Math.round(have)}s of ${Math.round(want)}s`);
  };

  cushionTimer = setInterval(tick, 250);
  tick();
}

function stopCushionWait() {
  if (cushionTimer) clearInterval(cushionTimer);
  cushionTimer = null;
}

/*
 * There is no catch-up here, on purpose.
 *
 * There was, for two versions, and it was wrong twice in opposite directions:
 * first a `liveMaxLatencyDuration` pitched past the end of the playlist so it
 * could never fire, then a correction of our own that fired and jumped the
 * picture forward with a message saying so. Both were built on the assumption
 * that being far behind live is a fault worth interrupting the picture to fix.
 *
 * It is not. On a slow link the sequence is: the buffer runs dry, playback
 * stalls, and the gap to the live edge grows by however long the stall lasted.
 * Seeking forward to close that gap throws away the only thing that was
 * keeping the picture up — the video already downloaded — and buys a position
 * nearer an edge the link cannot keep up with anyway, which starves again
 * within seconds. It converts one stall into a stall plus a jump.
 *
 * What is actually wanted from a channel is that it keeps playing. Being
 * thirty or fifty seconds behind costs nothing on anything but a live score,
 * and nothing about it is worth a jump or a message. So nothing here moves the
 * playhead. `liveMaxLatencyDuration` stays parked so hls.js does not do it
 * either, and the `LIVE` pill still shows the gap and still jumps to the edge
 * when it is pressed — deliberately, by a person who wanted it.
 *
 * hls.js's own stall and gap recovery is left alone, and that is a different
 * thing: it steps over a hole in the media, which is the difference between a
 * picture that continues and one that is frozen for good. It is not latency
 * chasing and switching it off would freeze the stream, not steady it.
 */

function stopLiveTracking() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  $('#livePill').hidden = true;
  reservePlayerActions();
}

/* ------------------------------------------------------ playback watchdog ---
 *
 * The useful number when playback "goes slow" is not the one the player
 * reports, it is how fast the media clock actually advances against the wall
 * clock. That single measurement splits the problem in two:
 *
 *   measured ≈ playbackRate    the rate is wrong — something set it
 *   measured < playbackRate    the rate is fine and the stream is not keeping
 *                              up: either decoding slowly, or stalling, which
 *                              the waiting count then tells apart
 *
 * Sampling runs whenever something is playing, so the report covers the minute
 * before the problem was noticed rather than starting when someone thinks to
 * look.
 *
 * There is a half of this it cannot reach. Every number below describes the
 * timeline the player was handed. If the conversion wrote a timeline that does
 * not match its own contents, all of them read as perfectly healthy while what
 * you watch is wrong — so the server is asked to inspect its own output too,
 * and the answer is folded into the report.
 */
const playback = {
  samples: [],
  events: { waiting: 0, stalled: 0, error: 0, ratechange: 0, seeked: 0 },
  startedAt: 0,
  // The low point of this viewing, kept with the full report from that moment.
  //
  // Held across reset(), unlike everything above it. Reloading the stream or
  // seeking starts a fresh session, and the first thing anyone does about bad
  // playback is reload — so a record that reset with the session would be
  // wiped by the very act of reacting to the problem, and the report would
  // describe the recovery every time.
  worstRate: null,
  worstAt: 0,
  worstReport: '',
  // The last report rendered while something was actually playing. The health
  // panel sits behind the player overlay, so the report has to outlive the
  // player: hit the bug, close the player, open the panel, and the numbers
  // from a second ago are still there.
  last: null,
  // A row a second for the last two minutes — see record().
  history: [],
  pendingNotes: [],
  // What the server says about the conversion feeding this playback — see the
  // note above. Timestamped, because it describes the moment it was taken and
  // an hour-old reading of how much had been written reads as alarming next to
  // a current one.
  probe: null,
  probedAt: 0,
  probedSession: '',

  /** New title: throw away the previous one's evidence, worst moment included. */
  resetViewing() {
    this.reset();
    this.worstRate = null;
    this.worstAt = 0;
    this.worstReport = '';
    this.last = null;
    this.history = [];
    this.pendingNotes = [];
    this.probe = null;
    this.probedAt = 0;
    this.probedSession = '';
    this.rescues = 0;
    this.lastRescueAt = 0;
  },

  reset() {
    this.samples = [];
    this.events = { waiting: 0, stalled: 0, error: 0, ratechange: 0, seeked: 0 };
    this.startedAt = Date.now();
  },

  /** One second of the watchdog: measure, then bank a readable snapshot. */
  tick() {
    this.record();
    this.sample();
    this.askServer();
    if ($('#video').paused || !$('#video').currentSrc) return;
    this.last = { at: Date.now(), verdict: this.verdict(), report: this.reportWithWorst() };
  },

  /**
   * One row per second of wall clock, kept for two minutes.
   *
   * Averages hide short faults. A ten-second window that includes four bad
   * seconds and six good ones reads as mildly slow, and `worst measured` will
   * not record it at all until the window has six seconds of history behind
   * it — which is precisely the moment after a seek, where the fault being
   * chased is reported to start. A row a second hides nothing: whatever
   * happened is in here with its shape and its position intact.
   *
   * Kept across reset() for the same reason the worst moment is: seeking and
   * reloading are what we most need to see either side of.
   */
  record() {
    const video = $('#video');
    const now = performance.now();
    const prev = this.history[this.history.length - 1];
    const q = this.quality();
    const notes = this.pendingNotes.join(' ');
    this.pendingNotes = [];

    // Media seconds per wall second since the row before. Skipped across a
    // pause, a seek or a gap, where the media clock jumps for honest reasons
    // and the difference would be meaningless.
    let step = null;
    const continuous = prev && !prev.paused && !prev.seeking && !video.paused && !video.seeking
      && !/seek|loadstart/.test(notes);
    if (continuous) {
      const wall = (now - prev.at) / 1000;
      if (wall > 0.2 && wall < 4) step = (video.currentTime - prev.t) / wall;
    }

    this.history.push({
      at: now,
      t: video.currentTime,
      pos: filmPosition(),
      step,
      paused: video.paused,
      seeking: video.seeking,
      rs: video.readyState,
      nw: video.networkState,
      buf: video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0,
      f: q ? q.total : 0,
      notes,
    });
    if (this.history.length > 120) this.history.shift();
  },

  /**
   * Stretches in the timeline where the media clock fell behind for at least
   * two seconds running. This is what catches a fault too short for the
   * ten-second average to admit to.
   */
  slowSpells() {
    const spells = [];
    let run = null;
    for (const row of this.history) {
      if (row.step !== null && row.step < 0.6) {
        if (!run) run = { start: row, end: row, worst: row.step };
        else { run.end = row; run.worst = Math.min(run.worst, row.step); }
      } else if (run) {
        if (run.end.at - run.start.at >= 1500) spells.push(run);
        run = null;
      }
    }
    if (run && run.end.at - run.start.at >= 1500) spells.push(run);
    return spells;
  },

  /** The rolling log itself, laid out to be read down a column. */
  timelineLines() {
    if (this.history.length < 2) return [];
    const base = this.history[0].at;
    const rows = this.history.slice(-90).map((r) => {
      const secs = Math.round((r.at - base) / 1000);
      const rate = r.step !== null ? `${r.step.toFixed(2)}x`
        : r.paused ? 'paused' : r.seeking ? 'seeking' : '-';
      // The buffer in FILM time, not session time.
      //
      // These two columns used to be on different clocks: position counted
      // from the start of the film, the buffer from the start of the
      // conversion. Resume a film at 102s and every row read "position 314,
      // buffered to 235" — as though the buffer were eighty seconds BEHIND
      // the playhead, which is impossible and sent a whole evening chasing
      // it. Same clock now, and the cushion beside it, which is the number
      // anybody reading this column actually wants.
      const bufFilm = r.buf + (r.pos - r.t);
      const cushion = r.buf - r.t;
      return `  +${String(secs).padStart(3)}s ${r.pos.toFixed(1).padStart(8)} ` +
        `${rate.padStart(7)}  rs${r.rs}/${r.nw} buf${String(Math.round(bufFilm)).padStart(5)}` +
        ` +${String(Math.round(cushion)).padStart(3)}s` +
        (r.notes ? `  ${r.notes}` : '');
    });
    return ['',
      'timeline  (film position, rate, readyState/networkState, buffered to, cushion)',
      ...rows];
  },

  /**
   * How fast the media is ARRIVING, as a multiple of how fast it is played.
   *
   * The measured rate says how fast the clock advanced; this says whether
   * there was anything to advance through. Below 1.0 the cushion is being
   * spent and a stall is only a matter of when, however healthy the last ten
   * seconds looked — which is precisely the case that reads as fine right up
   * until it isn't.
   *
   * Taken from the growth of the buffer's far end, and only since the last
   * time a source was attached: a swap restarts that clock at zero and would
   * otherwise read as an enormous negative.
   */
  deliveryRate() {
    let rows = this.history;
    const lastLoad = rows.map((r) => /loadstart/.test(r.notes || '')).lastIndexOf(true);
    if (lastLoad >= 0) rows = rows.slice(lastLoad + 1);
    rows = rows.filter((r) => !r.paused);
    if (rows.length < 10) return null;
    const a = rows[0];
    const b = rows[rows.length - 1];
    const wall = (b.at - a.at) / 1000;
    if (wall < 10) return null;
    return (b.buf - a.buf) / wall;
  },

  sample() {
    const video = $('#video');
    if (video.paused || video.seeking) return;
    const q = this.quality();
    // performance.now() rather than Date.now(): immune to the clock being set.
    this.samples.push({ at: performance.now(), t: video.currentTime, f: q ? q.total : 0 });
    if (this.samples.length > 20) this.samples.shift();

    const rate = this.measuredRate();
    // Only once there is a real window behind it, or the first second or two
    // of start-up reads as a stall.
    if (rate !== null && this.span() > 6 && (this.worstRate === null || rate < this.worstRate)) {
      this.worstRate = rate;
      this.worstAt = Date.now();
      // Captured now, in full. By the time anyone reads it the session that
      // produced it may be long gone.
      this.worstReport = this.report();
    }
  },

  /**
   * Ask the server what its conversion actually wrote, once per session.
   *
   * Done unprompted rather than when the panel is opened, because the panel
   * cannot be reached from inside the player — by the time anyone looks, the
   * session in question has usually been closed or replaced. Held back for a
   * few seconds so there is enough written to be worth measuring.
   */
  askServer() {
    const session = lastRemux.session;
    if (!session) return;
    // Re-asked as the session grows. The first answer is taken twelve seconds
    // in, when only a few segments exist, and how much had been written by
    // then reads as alarmingly little beside a figure from a minute later.
    //
    // Often at first, then rarely. The early answers are what audioRescue()
    // acts on, and a minute of unwatchable audio before the first usable
    // reading is a minute too long; after two minutes nothing new is being
    // learned and this is ffprobe running twice on a Pi that is also encoding.
    const young = Date.now() - this.startedAt < 120_000;
    const every = young ? 20_000 : 60_000;
    const fresh = session === this.probedSession && Date.now() - this.probedAt < every;
    if (fresh || Date.now() - this.startedAt < 12_000) return;
    this.probedSession = session;
    this.probedAt = Date.now();
    api('/api/remux/probe', { id: session })
      .then((data) => {
        this.probe = data;
        this.probedAt = Date.now();
        this.audioRescue();
      })
      .catch((err) => { this.probe = { error: err.message }; });
  },

  /** Sessions already rebuilt once, so a bad one cannot start a loop. */
  rescued: new Set(),
  rescues: 0,
  lastRescueAt: 0,

  /**
   * Rebuild the stream when the audio has fallen behind the picture.
   *
   * This is the fix the user found by hand — back out of the show and start it
   * again — done automatically, because by the time it is noticeable a scene
   * has already been ruined and the alternative is asking someone to diagnose
   * a conversion from the sofa.
   *
   * Once per session, and only on a real conversion. Both the rate AND the
   * standing gap have to be past their thresholds: a rate on its own can be
   * two close-together segments and a rounding error, and a gap on its own can
   * be the ragged edge where the muxer cut on a keyframe.
   */
  audioRescue() {
    const p = this.probe;
    if (!p || p.error || !film.active) return;
    const rate = p.drift?.rate;
    const gap = p.drift?.gap;
    if (!Number.isFinite(rate) || !Number.isFinite(gap)) return;

    /* Two shapes of fault, and until now only one of them was caught.
     *
     * DRIFT is the audio pulling away a little at a time — a rate and a gap
     * that grow together, which is what these thresholds were written for.
     * 10ms per second is a second of lip-sync every minute and forty, well
     * clear of anything healthy and far below the 220 that prompted them.
     *
     * A STEP is what seeking produces, and it looks nothing like drift: the
     * gap opens in the first few seconds and then stops, so by the time the
     * measurement settles the rate reads near zero beside a gap of seconds.
     * The old test demanded both, so the exact fault the viewer kept hitting
     * — "only when I am resuming or have been seeking" — was the one shape
     * it could not see. A second and a half is far past any keyframe-edge
     * raggedness and unmistakably a real offset. */
    const drifting = Math.abs(rate) >= 0.01 && Math.abs(gap) >= 0.5;
    const stepped = Math.abs(gap) >= 1.5;
    if (!drifting && !stepped) return;

    const session = lastRemux.session;
    if (!session || this.rescued.has(session)) return;
    // A rebuild makes a NEW session, which would be eligible all over again —
    // so the session set alone cannot stop a loop. Twice per viewing, and not
    // within ninety seconds of the last one: if a second rebuild has not fixed
    // it, a third will not either, and repeatedly restarting the picture is
    // worse than bad audio somebody can decide about themselves.
    if (this.rescues >= 2 || Date.now() - this.lastRescueAt < 90_000) return;
    this.rescued.add(session);
    this.rescues += 1;
    this.lastRescueAt = Date.now();

    /* Rebuild WITH the correction, not without it.
     *
     * This used to re-run the identical command — same `-ss`, same flags —
     * which on a seeked conversion reproduced the identical offset, so the
     * rescue announced itself twice and then gave up while the audio stayed
     * exactly where it was. Measuring a fault and then not using the
     * measurement is worse than not measuring it.
     *
     * A negative gap is audio ending before the picture: it is running
     * ahead, so it is held back by that much. The correction accumulates,
     * because the next reading is taken against the corrected stream and
     * describes whatever is still left over. */
    film.audioDelayMs = Math.max(0, Math.min(10_000,
      film.audioDelayMs + (gap < 0 ? Math.abs(gap) * 1000 : 0)));

    const behind = gap < 0 ? 'behind' : 'ahead of';
    toast(`Audio ran ${Math.abs(gap).toFixed(1)}s ${behind} the picture — rebuilding.`);
    reloadStream();
  },

  /**
   * Which browser this came from, and what it can do.
   *
   * Several rounds of this were spent reasoning about engine behaviour — how
   * hls.js buffers, whether Web Audio can take the element's output, which
   * fullscreen call applies — without the report ever saying which engine was
   * running. The raw string rather than a parsed name on purpose: a name is a
   * guess about what the string means, and the guess is the part that has
   * been wrong.
   *
   * Note for anyone reading a report from a phone: every browser on iOS is
   * WebKit underneath, Chrome included, because Apple requires it. "Chrome on
   * the iPhone" and "Safari on the iPhone" are the same engine, and the iOS
   * branches in this file apply to both.
   */
  /**
   * What hls.js knows and the timeline cannot show.
   *
   * A report can say the buffer ran out; it cannot say why, and the two
   * candidates want opposite fixes. Either the link is not delivering the
   * stream faster than it plays — in which case no amount of tuning invents
   * bandwidth — or it is, and the player is sitting too close to the live edge
   * to have anything in hand. Guessing between those is how this got tuned
   * twice in the wrong direction.
   *
   * Four numbers settle it:
   *
   *   link vs stream   what the player measured against what the feed needs.
   *                    Below 1.0x, nothing else matters.
   *   window           how much of the playlist is published and therefore
   *                    fetchable. It is the ceiling on any cushion: you cannot
   *                    buffer past the live edge, so a short window means a
   *                    small cushion however it is configured.
   *   latency          how far behind the edge we actually are, against where
   *                    we asked to be. If those disagree, the setting is not
   *                    doing what it says.
   */
  /**
   * What the player reckons the connection is worth, in bits per second.
   *
   * hls.js measures this from segments it has already fetched, so it is the
   * real path — Pi, tunnel, wifi and all — rather than a speed test against
   * something else.
   */
  linkBits() {
    if (engineKind !== 'hls.js' || !engine) return 0;
    return Number(engine.bandwidthEstimate) || 0;
  },

  /**
   * Is this simply a bigger stream than the connection can carry?
   *
   * Worth asking before anything else, because when the answer is yes every
   * other reading in the report is a red herring. A 4K HEVC master copied
   * verbatim is twenty-odd megabits; a household connection is whatever it
   * is; and if the first number is near the second, the film cannot arrive
   * in time no matter how healthy the timestamps are or how far ahead the
   * box has run.
   *
   * The box's own conversion speed is what separates the two failures. If
   * it is writing several times faster than realtime and the viewer is
   * still starving, nothing is wrong with the box: the wire is the wall.
   *
   * Returns the sentence to say, or '' when this is not the problem.
   */
  tooFatForTheLink() {
    const p = this.probe;
    const stream = p && !p.error ? Number(p.bitrate) || 0 : 0;
    const link = this.linkBits();
    if (!stream || !link) return '';
    // Below about four fifths there is real headroom and the stalls are
    // something else; a stream at or over the link is hopeless.
    if (stream < link * 0.8) return '';

    const mb = (bits) => `${(bits / 1e6).toFixed(1)} Mbit/s`;
    const speed = Number(p.speed) || 0;
    const boxFine = speed >= 1.2;
    // What is actually arriving, which is the claim rather than the estimate.
    // hls.js's own figure is what it managed on the segments it fetched, and
    // it reads high on a link that is fine in bursts and short over a minute.
    const delivered = this.deliveryRate();

    return `this copy is ${mb(stream)} and the connection measured ${mb(link)}`
      + `${stream >= link ? ' — more than the link can carry' : ', which leaves no headroom'}. `
      + (boxFine
        ? `The box is fine: it is writing ${speed.toFixed(1)}× faster than realtime. `
        : '')
      + (delivered !== null && delivered < 0.98
        ? `The picture is arriving at ${delivered.toFixed(2)}× the speed it is watched, `
          + 'so the cushion is being spent and will run out. '
        : '')
      // Said here rather than left to be worked out, because starving looks
      // exactly like lip-sync going off and the reflex is to go hunting
      // through the drift figures for a fault that is not there.
      + (this.muxedBuffer()
        ? 'Sound and picture are in one buffer here, so they cannot come apart — '
          + 'what this looks like is stuttering, not drift. '
        : '')
      + 'Pick a smaller copy of the same title, watch it over the local address '
      + 'rather than the tunnel if you are in the house, or turn on Low bandwidth mode. '
      + 'Seeking makes it worse for the rest of the film: every jump throws away '
      + 'the buffer, and at this bitrate it never gets a cushion back.';
  },

  hlsLines() {
    if (engineKind !== 'hls.js' || !engine) return [];
    const out = [];
    try {
      const level = engine.levels?.[engine.currentLevel];
      const bits = engine.bandwidthEstimate;
      const need = level?.bitrate;
      if (bits && need) {
        out.push(`link vs stream  ${(bits / 1e6).toFixed(1)} Mbit/s measured, `
          + `${(need / 1e6).toFixed(1)} Mbit/s needed  →  `
          + `${(bits / need).toFixed(2)}x headroom`);
      } else if (bits) {
        out.push(`link            ${(bits / 1e6).toFixed(1)} Mbit/s measured`);
      }

      const d = level?.details;
      if (d) {
        out.push(`playlist        ${d.live ? 'live' : 'vod'}, `
          + `${(d.fragments || []).length} segments of ~${d.targetduration}s `
          + `= ${Math.round(d.totalduration)}s window`);
      }
      if (Number.isFinite(engine.latency)) {
        out.push(`latency         ${engine.latency.toFixed(1)}s behind the edge, `
          + `asked for ${Number(engine.targetLatency ?? LIVE_HLS.liveSyncDuration).toFixed(1)}s`);
      }
    } catch {
      // A report that cannot read the engine is still a report.
    }
    return out;
  },

  browserLines() {
    const ua = navigator.userAgent || 'unknown';
    const video = $('#video');
    return [
      `browser         ${ua.slice(0, 150)}`,
      `                iOS ${isIOS()}, MSE ${Boolean(window.MediaSource)}, ` +
        `native HLS ${Boolean(video.canPlayType('application/vnd.apple.mpegurl'))}, ` +
        `hls.js ${Boolean(window.Hls && window.Hls.isSupported())}`,
    ];
  },

  /**
   * Where hls.js actually put each track.
   *
   * The conversion can hand over a file whose audio legitimately starts later
   * than its video — after a seek the copied video begins at the keyframe
   * before the mark while the audio begins at the mark — and the file is right
   * to say so. What matters is whether the player honours it. hls.js buffers
   * audio and video into separate SourceBuffers and applies a timestampOffset
   * to each; if it slides the audio back to meet the video, every frame of
   * sound plays against the wrong picture for the rest of the session, and
   * nothing else in this report would show it.
   *
   * Internal API, so guarded and read-only. It tells us which of the two is
   * true, which is the question five rounds of encoder changes could not
   * answer.
   */
  /**
   * Are sound and picture in ONE buffer, or two?
   *
   * It settles an argument that keeps coming back. The box writes muxed
   * segments, so hls.js gives the browser a single `audiovideo` buffer with
   * both tracks inside it — and two tracks in one buffer cannot come apart:
   * they are fetched together, appended together, starve together and
   * resume together. Whatever a stuttering picture sounds like, it is not
   * the sound sliding away from it.
   *
   * Worth stating outright, because "the audio and video are out of sync" is
   * what repeated starvation actually feels like to watch, and chasing that
   * ghost through drift figures is a whole evening.
   */
  muxedBuffer() {
    try {
      const sb = engine?.bufferController?.sourceBuffer;
      const kinds = sb ? Object.keys(sb) : [];
      return kinds.length === 1 && kinds[0] === 'audiovideo';
    } catch {
      return false;
    }
  },

  buffers() {
    try {
      const sb = engine?.bufferController?.sourceBuffer;
      if (!sb) return [];
      return Object.keys(sb).map((kind) => {
        const buf = sb[kind];
        const ranges = [];
        for (let i = 0; i < (buf?.buffered?.length || 0); i += 1) {
          ranges.push(`${buf.buffered.start(i).toFixed(2)}-${buf.buffered.end(i).toFixed(2)}`);
        }
        return `${kind}: ${ranges.join(', ') || 'empty'}` +
          ` (offset ${Number(buf?.timestampOffset ?? 0).toFixed(3)})`;
      });
    } catch {
      return [];
    }
  },

  /**
   * The sample rate this machine's audio hardware runs at.
   *
   * Worth having next to the rate in the file: a mismatch between the two has
   * to be resampled somewhere, and audio played at the wrong rate is heard as
   * a pitch shift rather than as anything the video clock would notice. The
   * context is created suspended and never connected to anything, so it reads
   * the setting without touching playback.
   */
  deviceSampleRate() {
    if (this.deviceRate !== undefined) return this.deviceRate;
    this.deviceRate = 0;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        this.deviceRate = ctx.sampleRate;
        ctx.close?.();
      }
    } catch {
      /* not available; the line just reads unknown */
    }
    return this.deviceRate;
  },

  /** Frames actually put on screen, per wall second and per media second. */
  frameRate() {
    const w = this.window();
    if (w.length < 2) return null;
    const first = w[0];
    const last = w[w.length - 1];
    const wall = (last.at - first.at) / 1000;
    const media = last.t - first.t;
    const frames = last.f - first.f;
    if (wall < 1 || frames <= 0) return null;
    return { perWall: frames / wall, perMedia: media > 0.5 ? frames / media : null };
  },

  /**
   * The samples the rate is measured over: the last ten seconds, not the whole
   * buffer. Averaged over a longer history a fresh slowdown is diluted by the
   * good playback in front of it and takes most of a minute to show up — which
   * is exactly the moment someone is staring at the panel waiting for it to
   * say something.
   */
  window() {
    if (this.samples.length < 2) return [];
    const cutoff = this.samples[this.samples.length - 1].at - 10_000;
    const recent = this.samples.filter((s) => s.at >= cutoff);
    return recent.length >= 2 ? recent : this.samples.slice(-2);
  },

  span() {
    const w = this.window();
    if (w.length < 2) return 0;
    return (w[w.length - 1].at - w[0].at) / 1000;
  },

  /** Media seconds per wall-clock second. 1 is normal; 0.1 is the reported bug. */
  measuredRate() {
    const w = this.window();
    if (w.length < 2) return null;
    const first = w[0];
    const last = w[w.length - 1];
    const wall = (last.at - first.at) / 1000;
    if (wall < 1) return null;
    return (last.t - first.t) / wall;
  },

  quality() {
    const video = $('#video');
    if (typeof video.getVideoPlaybackQuality !== 'function') return null;
    const q = video.getVideoPlaybackQuality();
    return { dropped: q.droppedVideoFrames, total: q.totalVideoFrames };
  },

  report() {
    const video = $('#video');
    const rate = this.measuredRate();
    const q = this.quality();
    const fps = this.frameRate();
    const spells = this.slowSpells();
    const buffered = [];
    for (let i = 0; i < video.buffered.length; i += 1) {
      buffered.push(`${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}`);
    }
    const lines = [
      `when            ${new Date().toISOString()}`,
      `version         v${VERSION}`,
      `measured rate   ${rate === null ? 'n/a' : `${rate.toFixed(3)}x over ${this.span().toFixed(0)}s`}`,
      `worst measured  ${this.worstRate === null ? 'n/a' : `${this.worstRate.toFixed(3)}x`}`,
      // Arriving, not playing. Under 1.0 the cushion is being spent, and the
      // stall is only a question of when — which is exactly the state that
      // reads as perfectly healthy in every other line here.
      `delivery        ${(() => {
        const d = this.deliveryRate();
        return d === null ? 'n/a'
          : `${d.toFixed(2)}x of playback${d < 1 ? ' — the cushion is being spent' : ''}`;
      })()}`,
      `playbackRate    ${video.playbackRate}`,
      `paused/seeking  ${video.paused} / ${video.seeking}`,
      `readyState      ${video.readyState}   networkState ${video.networkState}`,
      `currentTime     ${video.currentTime.toFixed(2)} of ${Number.isFinite(video.duration) ? video.duration.toFixed(2) : 'unknown'}`,
      `buffered        ${buffered.join(', ') || 'none'}`,
      `frames          ${q ? `${q.dropped} dropped of ${q.total}` : 'n/a'}`,
      `frame rate      ${fps
        ? `${fps.perWall.toFixed(1)}/s on screen` +
          (fps.perMedia ? `, ${fps.perMedia.toFixed(1)} per media second` : '')
        : 'n/a'}`,
      `events          waiting ${this.events.waiting}, stalled ${this.events.stalled}, ` +
        `error ${this.events.error}, ratechange ${this.events.ratechange}, seeked ${this.events.seeked}`,
      `engine          ${engineKind || 'none'}`,
      ...this.hlsLines(),
      ...this.browserLines(),
      `audio device    ${this.deviceSampleRate() || 'unknown'}Hz output`,
      ...this.buffers().map((line, i) => `${i === 0 ? 'buffers' : ''}`.padEnd(16) + line),
      `source          ${(video.currentSrc || '').slice(0, 120) || 'none'}`,
      `film            active ${film.active}, offset ${Math.round(film.offset)}, ` +
        `ready ${Math.round(film.ready)}, duration ${film.duration}`,
      `remux session   ${lastRemux.session || 'none (playing directly)'}`,
      `watching since  ${Math.round((Date.now() - this.startedAt) / 1000)}s ago`,
      `slow spells     ${spells.length
        ? spells.map((sp) => `${Math.round((sp.end.at - sp.start.at) / 1000) + 1}s from ` +
            `${sp.start.pos.toFixed(0)}, down to ${sp.worst.toFixed(2)}x`).join('; ')
        : `none in the last ${this.history.length}s`}`,
      ...this.serverLines(),
      ...this.timelineLines(),
    ];
    return lines.join('\n');
  },

  /**
   * What the conversion actually wrote, as opposed to what it told the player.
   * `timeline` is the one that matters: the playlist's claimed running time
   * divided by the running time the segments really hold. 1.00 is honest.
   */
  serverLines() {
    const p = this.probe;
    if (!p) return ['conversion      not asked yet'];
    if (p.error) return [`conversion      couldn't check — ${p.error}`];
    const seg = p.segment || {};
    const age = Math.round((Date.now() - this.probedAt) / 1000);
    return [
      // Redacted server-side — the provider embeds the account in the URL and
      // these reports get pasted into chats.
      ...(p.input || []).map((line, i) =>
        `${i === 0 ? 'source' : ''}`.padEnd(16) + line),
      `conversion      wrote ${Number(p.declaredTotal || 0).toFixed(1)}s across the playlist ` +
        `(measured ${age}s ago)`
        + (p.speed ? `, at ${p.speed.toFixed(1)}× realtime` : ''),
      // The two numbers that settle "is it the box or the wire". A stream
      // running fatter than the link measured cannot arrive in time however
      // healthy everything else looks, and nothing else in this report says
      // so — it was all timestamps and drift, which are the wrong questions
      // when the answer is simply that the film is too big for the pipe.
      `  bitrate       ${p.bitrate ? `${(p.bitrate / 1e6).toFixed(1)} Mbit/s of stream` : 'n/a'}`
        + (p.bitrate && this.linkBits()
          ? ` against ${(this.linkBits() / 1e6).toFixed(1)} Mbit/s of link  → ${
            (p.bitrate / this.linkBits()).toFixed(2)}× the connection`
          : ''),
      `  a segment     claims ${Number(seg.declared || 0).toFixed(3)}s, holds ` +
        `${Number(seg.real || 0).toFixed(3)}s  → timeline ${seg.ratio ? seg.ratio.toFixed(3) : 'n/a'}`,
      `  a/v start     video ${Number.isFinite(p.start?.video) ? p.start.video.toFixed(3) : '?'}s, ` +
        `audio ${Number.isFinite(p.start?.audio) ? p.start.audio.toFixed(3) : '?'}s  → offset ` +
        `${Number.isFinite(p.start?.sync) ? `${(p.start.sync * 1000).toFixed(0)}ms` : 'n/a'}`,
      `  a/v gap       video ends ${Number.isFinite(p.drift?.video) ? p.drift.video.toFixed(3) : '?'}s, ` +
        `audio ends ${Number.isFinite(p.drift?.audio) ? p.drift.audio.toFixed(3) : '?'}s  → ` +
        `${Number.isFinite(p.drift?.gap) ? `${(p.drift.gap * 1000).toFixed(0)}ms apart` : 'n/a'}`,
      // Both gaps, because one of them means nothing on its own. Some gap at
      // the end of a segment is normal — the muxer cuts on a video keyframe
      // and the audio frames do not land there. Only the CHANGE is drift.
      `  the same gap  ${Number.isFinite(p.drift?.firstGap)
        ? `${(p.drift.firstGap * 1000).toFixed(0)}ms in the first segment`
        : 'not measured — only one segment so far'}`,
      // Both halves, because the pair is what decides whether the rate is a
      // fault or a reading — and only a straight line is ever corrected.
      `  each half     ${Number.isFinite(p.drift?.halfEarly) && Number.isFinite(p.drift?.halfLate)
        ? `${(p.drift.halfEarly * 1000).toFixed(1)}ms/s then `
          + `${(p.drift.halfLate * 1000).toFixed(1)}ms/s  → `
          + `${p.drift.linear ? 'a straight line, so it is corrected'
            : 'not a straight line, so nothing is changed'}`
        : 'not enough of the conversion yet to say'}`,
      `  drift rate    ${Number.isFinite(p.drift?.rate)
        ? `${(p.drift.rate * 1000).toFixed(1)}ms per second (${(p.drift.rate * 100).toFixed(2)}%)`
          + ` measured over ${Number(p.drift.span || 0).toFixed(1)}s`
        : 'not enough apart to divide yet'}`,
      `  video         ${p.video?.codec || '?'} ${p.video?.fps || '?'}fps tb ${p.video?.timeBase || '?'}`,
      `  audio         ${p.audio?.codec || '?'} ${p.audio?.profile || 'profile?'} ` +
        `${p.audio?.sampleRate || '?'}Hz ${p.audio?.channels || '?'}ch tb ${p.audio?.timeBase || '?'}`,
      `  ffmpeg        exited ${p.exited} code ${p.exitCode}${p.lastError ? ` — ${p.lastError}` : ''}`,
      `  command       ${p.args || 'unknown'}`,
    ];
  },

  /**
   * The current report, followed by the worst moment of this viewing when that
   * was worse than now — which is the usual case by the time anyone looks,
   * since the reflex on bad playback is to reload it away.
   */
  reportWithWorst() {
    const now = this.report();
    const worthKeeping = this.worstRate !== null && this.worstRate < 0.9
      && this.worstReport && this.worstReport !== now;
    if (!worthKeeping) return now;
    const ago = Math.round((Date.now() - this.worstAt) / 1000);
    return `${now}\n\n--- worst moment of this viewing, ${ago}s ago ---\n${this.worstReport}`;
  },

  /** Verdict and report as one block, for the clipboard. */
  fullText() {
    return `${this.verdict()}\n\n${this.reportWithWorst()}`;
  },

  /** The one-line read on what the numbers mean, so the report needs no expert. */
  verdict() {
    const video = $('#video');
    const p = this.probe;
    // Checked before anything else. A conversion that wrote a timeline out of
    // step with its own contents looks flawless from in here — 1x, no stalls,
    // nothing dropped — and wrong on the screen, so every measurement below
    // would agree that all is well.
    // Audio and video starting at different points is heard as lip-sync drift
    // and shows up in nothing the player reports — the clock, the frame rate
    // and the buffering are all correct, the two tracks are simply offset.
    const sync = p && !p.error ? p.start?.sync : null;
    if (Number.isFinite(sync) && Math.abs(sync) > 0.12) {
      return `Audio and video start ${Math.abs(sync * 1000).toFixed(0)}ms apart — the audio ` +
        `begins ${sync > 0 ? 'after' : 'before'} the picture. A fixed offset, the same at the ` +
        'end as at the start, as opposed to drift that grows as it plays.';
    }
    // Drift, as opposed to a fixed offset. The two start together and pull
    // apart, so it is inaudible at the head and unwatchable a few minutes in —
    // which is exactly the "worse the deeper you go" symptom. 5ms per second
    // is a second of lip-sync every three minutes.
    const driftRate = p && !p.error ? p.drift?.rate : null;
    if (Number.isFinite(driftRate) && Math.abs(driftRate) > 0.005) {
      const ms = Math.abs(driftRate * 1000);
      const gap = Math.abs(p.drift?.gap || 0);
      return `Audio is DRIFTING, not merely offset: ${ms.toFixed(0)}ms per second ` +
        `(${Math.abs(driftRate * 100).toFixed(1)}%), the audio falling ` +
        `${driftRate < 0 ? 'behind' : 'ahead of'} the picture as it goes — ` +
        `${gap.toFixed(1)}s apart by the last segment measured. ` +
        'The player rebuilds the stream by itself when it sees this, which is ' +
        'the same thing as backing out and starting the episode again.';
    }

    const ratio = p && !p.error ? p.segment?.ratio : 0;
    if (ratio && (ratio > 1.2 || ratio < 0.85)) {
      return `The CONVERSION is out of step: a segment claims ${p.segment.declared.toFixed(2)}s ` +
        `but holds ${p.segment.real.toFixed(2)}s of content (${ratio.toFixed(2)}×). ` +
        'That plays at the wrong speed however healthy the player looks.';
    }

    const rate = this.worstRate ?? this.measuredRate();
    if (rate !== null && rate <= 0.9) {
      if (Math.abs(video.playbackRate - rate) < 0.15 && video.playbackRate < 0.9) {
        return `Playback RATE is ${video.playbackRate}× — something set it, this is not the stream.`;
      }
      if (this.events.waiting > 3) {
        const starved = this.tooFatForTheLink();
        return `Running at ${rate.toFixed(2)}× with ${this.events.waiting} stalls — `
          + (starved || 'the stream is not arriving fast enough.');
      }
      return `Running at ${rate.toFixed(2)}× with the rate at ${video.playbackRate} and few stalls — ` +
        'the media itself is decoding slowly, which points at the conversion rather than the network.';
    }

    // Before the all-clear, and before giving up for want of a window.
    //
    // Seeking clears the sample window, and a worst reading is only recorded
    // once six seconds have rebuilt behind it — so someone seeking repeatedly
    // to shake off bad playback keeps resetting the very measurement meant to
    // catch it, and the averages above have nothing to say. The timeline is
    // recorded a row a second regardless, so it still does.
    const spells = this.slowSpells();
    if (spells.length) {
      const worst = spells.reduce((a, b) => (a.worst < b.worst ? a : b));
      return `The averages ${rate === null ? 'have no window to work with' : 'look fine'}, but ` +
        `the clock fell behind ${spells.length} time${spells.length === 1 ? '' : 's'} — worst ` +
        `${worst.worst.toFixed(2)}× for about ${Math.round((worst.end.at - worst.start.at) / 1000) + 1}s ` +
        `at ${worst.start.pos.toFixed(0)}s into the film. See the timeline below.`;
    }

    if (rate === null) return 'Not enough playback yet to judge.';
    return 'Normal from the player\'s side — the media clock keeps up, nothing stalls, ' +
      'no frames dropped. If it still looked or sounded wrong, the fault is in what the ' +
      'conversion produced rather than in how it is being played.';
  },
};

for (const name of ['waiting', 'stalled', 'error', 'ratechange', 'seeked']) {
  $('#video').addEventListener(name, () => {
    playback.events[name] += 1;
    if (name === 'waiting') noteStall();
  });
}

/**
 * Offer the weak-Wi-Fi switch at the moment it would help.
 *
 * A setting nobody can find while the picture is freezing is a setting that
 * does not exist. Four stalls in one sitting is not bad luck, it is a link
 * that cannot carry this stream — so say so, once, with the fix attached,
 * and never nag: declined, it stays declined for the rest of the session.
 */
let lowOffered = false;
const LOW_OFFER_STALLS = 4;
/** Stalls older than this are somebody else's evening. */
const LOW_OFFER_WINDOW_MS = 90_000;
let stallsAt = [];

/**
 * A `waiting` that is really a stall, rather than something normal.
 *
 * The offer was firing while somebody scrolled through titles with nothing
 * wrong, and the count is why: EVERY seek raises `waiting`, so opening four
 * things, or scrubbing four times, was indistinguishable from four buffer
 * stalls. It also counted for the whole session, so four scattered over an
 * hour arrived together as a verdict.
 *
 * A stall is a `waiting` that happens while the picture is meant to be
 * moving — not paused, not seeking — and it only counts alongside others
 * from the same minute and a half.
 */
function noteStall() {
  const video = $('#video');
  if (video.paused || video.seeking) return;
  const now = Date.now();
  stallsAt = stallsAt.filter((at) => now - at < LOW_OFFER_WINDOW_MS);
  stallsAt.push(now);
  offerLowMode();
}

function offerLowMode() {
  if (lowOffered || lowMode()) return;
  if (stallsAt.length < LOW_OFFER_STALLS) return;
  if ($('#playerOverlay').hidden) return;
  /* And the clock really is behind.
   *
   * The events say something happened; the measurement says whether it
   * mattered. A link that recovers between stalls is not one worth telling
   * somebody to shrink their picture over, and this is the difference
   * between a warning and a nag.
   */
  const rate = playback.measuredRate();
  const delivery = playback.deliveryRate();
  const struggling = (rate !== null && rate < 0.9)
    || (delivery !== null && delivery < 0.9);
  if (!struggling) return;
  lowOffered = true;
  toast('This keeps stopping to buffer — your connection is struggling.', {
    action: {
      label: 'Send it smaller',
      run: async () => {
        prefs.data.lowBandwidth = true;
        await prefs.save();
        $('#lowMode').checked = true;
        // Already playing, so this one is restarted to shrink it — which is
        // what was just asked for, unlike doing it to a film unprompted.
        toast('Low bandwidth mode on — reloading this at a smaller size.');
        reloadStream();
      },
    },
  });
}
// Everything that could explain a kink in the timeline gets written onto the
// row it happened in, so the log reads as a story rather than a column of
// numbers with no cause attached.
for (const name of ['waiting', 'stalled', 'error', 'seeking', 'seeked', 'loadstart',
  'ratechange', 'play', 'pause', 'canplay']) {
  $('#video').addEventListener(name, () => {
    if (playback.pendingNotes.length < 6) playback.pendingNotes.push(name);
  });
}
$('#video').addEventListener('loadstart', () => {
  // A new source starts a new argument about whether it is arriving.
  stallsAt = [];
  playback.reset();
});
// Seeking jumps the media clock, so the window either side of it is meaningless.
$('#video').addEventListener('seeking', () => {
  playback.samples = [];
});
setInterval(() => {
  playback.tick();
  upNext.tick();
}, 1000);

/* --------------------------------------------------------------- up next ---
 *
 * A "Next episode" button, offered 45 seconds before an episode runs out.
 *
 * A fixed mark rather than anything cleverer. This started out reading the
 * picture to find where the credits began — brightness against the episode's
 * own average, held for several seconds — but a detector that fires on what is
 * on screen fires at a different point in every episode, and sometimes during
 * a dark scene that was not the credits at all. A mark you can predict is
 * worth more than one that is occasionally earlier.
 *
 * The end of the file is a second trigger, for anything whose runtime is not
 * known well enough to count backwards from.
 */
const UP_NEXT = {
  mark: 45,          // seconds left when the offer appears
  minRuntime: 120,   // below this the mark would land almost immediately
};

const upNext = {
  candidate: null,   // { label, start() } for the episode after this one
  shown: false,
  dismissed: false,

  /** Called when an episode starts, with whatever follows it. */
  arm(candidate) {
    this.clear();
    this.candidate = candidate || null;
  },

  clear() {
    this.candidate = null;
    this.shown = false;
    this.dismissed = false;
    $('#upNext').hidden = true;
  },

  /**
   * A runtime we can subtract from, or 0 when there isn't one.
   *
   * Metadata first. Failing that, the player's own duration — but only when
   * nothing is being remuxed, because mid-remux it reports the length
   * converted so far, which trails just behind the play head. Treating that as
   * the runtime would put the button on screen in the opening titles. With
   * neither, this stays quiet and the `ended` event is the only way through.
   */
  runtime() {
    if (film.active && film.runtimeKnown) return film.duration;
    if (lastRemux.session) return 0;
    return $('#video').duration;
  },

  tick() {
    if (!this.candidate || this.dismissed || this.shown) return;
    const video = $('#video');
    if (video.paused || video.seeking) return;

    const total = this.runtime();
    if (!Number.isFinite(total) || total < UP_NEXT.minRuntime) return;
    const left = total - filmPosition();
    if (!Number.isFinite(left) || left < 0) return;
    if (left <= UP_NEXT.mark) this.reveal();
  },

  reveal() {
    if (!this.candidate || this.shown || this.dismissed) return;
    this.shown = true;
    $('#upNextTitle').textContent = this.candidate.label;
    $('#upNext').hidden = false;
    // The card rides in the transport bar, which fades out once you stop
    // moving. Bring the chrome back and hold it — an offer that vanished three
    // seconds after appearing would be worse than no offer.
    showChrome();
  },
};

$('#upNextGo').addEventListener('click', () => {
  const next = upNext.candidate;
  if (!next) return;
  $('#upNext').hidden = true;
  next.start();
});

$('#upNextDismiss').addEventListener('click', () => {
  upNext.dismissed = true;
  $('#upNext').hidden = true;
});

// The end of the file is the one moment the offer is certainly wanted, and a
// short episode or a stream with no usable runtime never reaches the floor.
$('#video').addEventListener('ended', () => upNext.reveal());

/**
 * Rebuild whatever is playing, from where it currently is.
 *
 * Playback can end up wrong in ways that pausing will not clear — a stream
 * running at a fraction of speed after a seek is the one that prompted this.
 * Rather than guess at the cause from a phone, this throws the current
 * connection away and starts a fresh one at the same spot: a new remux session
 * for a converted film, a re-resolve for live, a re-attach for a local file.
 */
async function reloadStream() {
  const video = $('#video');
  const button = $('#reloadBtn');
  if (button.disabled) return;
  button.disabled = true;

  try {
    // Live has no film bar and nothing to seek back to; re-resolving is the
    // whole job, and it lands at the live edge by design.
    if (!film.active) {
      if (!currentLiveItem) return toast('Nothing to reload.');
      toast('Reloading the channel…');
      const { url, format } = await resolveStream(currentLiveItem);
      attach(url, format);
      return;
    }

    const at = filmPosition();

    // Playing straight from a file — there is no remux to restart, so re-attach
    // the same source and drop back to where it was.
    //
    // Unless the box has just been asked to send things smaller: re-attaching
    // the same file would hand over the same full-size bytes, which is
    // precisely what could not get through. Resolving it again routes it
    // through a conversion instead.
    if (!lastRemux.session) {
      if (lowMode() && film.item) {
        toast(`Reloading from ${hms(at)}…`);
        const { url, format, seekTo } = await resolveStream(film.item,
          { ...(film.override || {}), startAt: at });
        attach(url, format, { seekTo });
        return;
      }
      const src = video.currentSrc || video.src;
      if (!src) return toast('Nothing to reload.');
      toast(`Reloading from ${hms(at)}…`);
      attach(src, 'file', { seekTo: at });
      return;
    }

    toast(`Reloading from ${hms(at)}…`);
    // force, or a position already inside the converted window would be treated
    // as an ordinary seek and reuse the very session being reloaded.
    await seekFilm(at, { force: true });
  } catch (err) {
    toast(`Couldn't reload: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

$('#reloadBtn').addEventListener('click', reloadStream);

/** Manual catch-up. Deliberately never automatic — surprise seeks are the bug. */
$('#livePill').addEventListener('click', () => {
  const video = $('#video');
  if (!video.buffered.length) return;
  const edge = video.buffered.end(video.buffered.length - 1);
  video.currentTime = Math.max(0, edge - 1.5);
  video.play().catch(() => {});
});

let currentLiveItem = null;

/* ------------------------------------------------------ film scrubber ---

 * A remux in progress only knows about the part it has written, so the native
 * scrubber can never be longer than that. This bar works in real film time
 * instead: total runtime comes from the provider's metadata, and the position
 * shown is the session's offset plus wherever the video element is.
 *
 * Seeking inside what's already remuxed is an ordinary seek. Landing outside
 * it restarts the remux at that point, which becomes the new offset.
 */

const film = {
  active: false,
  duration: 0,   // true runtime in seconds
  // Whether that duration came from metadata or is just the high-water mark
  // paintFilmBar keeps pushing up. Anything reasoning about how much is LEFT
  // has to know the difference: the high-water mark is always about equal to
  // the current position, so "seconds remaining" from it is always near zero.
  runtimeKnown: false,
  offset: 0,     // where this remux session begins within the film
  ready: 0,      // seconds remuxed in this session
  item: null,
  override: null,
  seeking: false,
  /* A correction to hand the box on the NEXT conversion of this title.
   *
   * Seeking is the only thing that has ever put this app's audio out, and
   * the reason it stayed out was that the rescue rebuilt the stream with
   * the identical command — same `-ss`, same everything — so it landed on
   * the identical offset and gave up after two tries. Measuring the gap and
   * then not using it was the whole flaw. This carries it. */
  audioDelayMs: 0,
};

/**
 * Work out a title's true runtime in seconds.
 *
 * `duration_secs` cannot be trusted — this provider stores seconds for some
 * titles (6000 for a 01:40:00 film) and minutes for others (173 for one
 * running 02:53:44). The formatted `duration` string is unambiguous, so it
 * wins; duration_secs is only a fallback, and then only if it's sane.
 */
function parseRuntime(info) {
  const text = String(info?.duration || '').trim();

  const hhmmss = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(text);
  if (hhmmss) return +hhmmss[1] * 3600 + +hhmmss[2] * 60 + +hhmmss[3];

  const mmss = /^(\d+):([0-5]\d)$/.exec(text);
  if (mmss) return +mmss[1] * 60 + +mmss[2];

  const secs = Number(info?.duration_secs);
  return Number.isFinite(secs) && secs > 0 ? secs : 0;
}

function hms(total) {
  if (!Number.isFinite(total) || total < 0) return '0:00';
  const s = Math.floor(total % 60);
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/** Where we are in the film, not in the session. */
function filmPosition() {
  return film.offset + ($('#video').currentTime || 0);
}

/* ---------------------------------------------------------- cinema mode

 * Films and episodes take the whole viewport. The chrome floats over the
 * picture and fades out once you stop moving the mouse, the way a streaming
 * app does — the back button returns to whichever section the title came from.
 */

let chromeTimer = null;
const CHROME_IDLE = 3000;
// A finger has no hover, so the only way to bring the controls back is a tap.
// Give them noticeably longer to live on a touch device.
const CHROME_IDLE_TOUCH = 7000;

function showChrome() {
  const overlay = $('#playerOverlay');
  if (!overlay.classList.contains('cinema')) return;
  overlay.classList.remove('chrome-hidden');
  clearTimeout(chromeTimer);
  // Only get out of the way while something is actually playing.
  chromeTimer = setTimeout(
    () => {
      // An unanswered next-episode offer keeps the chrome up: it lives in the
      // bar, and fading it out would hide the one control being waited on.
      if (upNext.shown) return;
      if (!$('#video').paused && !film.seeking) overlay.classList.add('chrome-hidden');
    },
    device.phone ? CHROME_IDLE_TOUCH : CHROME_IDLE
  );
}

/** Where the back button lands; remembered because film.item is live-agnostic. */
let cinemaReturnHash = '#/movies';

function enterCinema(item) {
  const overlay = $('#playerOverlay');
  overlay.classList.add('cinema');
  overlay.classList.remove('chrome-hidden');

  // Launched from the Downloads grid? Back returns there, not to Movies. Same
  // for the archive — an archive title is a 'movie' to the player, so without
  // this the exit drops you into the provider's film grid.
  const fromDownloads = Boolean(item.downloadId && item.localOnly);
  const fromArchive = Boolean(item.archivePath);
  const labels = { series: 'Series', live: 'Live TV', movie: 'Movies' };
  cinemaReturnHash = fromArchive
    ? '#/archive'
    : fromDownloads
      ? '#/downloads'
      : item.kind === 'series' ? `#/series/${item.id}`
        : item.kind === 'live' ? '#/live' : `#/movies/${item.id}`;

  $('#cinemaTop').hidden = false;
  // Live only: multi-view is four live channels, and there is nothing to put
  // in a second cell when the thing on screen is a film.
  $('#cinemaMultiview').hidden = item.kind !== 'live';
  // A film has its own fullscreen button in the film bar; this is live's.
  $('#liveFull').hidden = item.kind !== 'live';
  // The bottom strip — play/pause and captions — exists exactly where the
  // native control strip does not.
  $('#liveBar').hidden = !(item.kind === 'live' && isIOS());
  reservePlayerActions();
  $('#cinemaTitle').textContent = item.name || '';
  $('#cinemaSub').textContent = '';
  $('#cinemaBackLabel').textContent = fromArchive
    ? 'Archive'
    : fromDownloads ? 'Downloads' : labels[item.kind] || 'Back';
  document.body.style.overflow = 'hidden';
  showChrome();
}

function exitCinema() {
  const overlay = $('#playerOverlay');
  overlay.classList.remove('cinema', 'chrome-hidden');
  $('#cinemaTop').hidden = true;
  clearTimeout(chromeTimer);
  chromeTimer = null;
}

/** Back out of the player and land on the section this title belongs to. */
function leaveCinema() {
  const back = cinemaReturnHash;
  closePlayer();
  if (location.hash !== back) location.hash = back;
}

$('#cinemaBack').addEventListener('click', leaveCinema);

/**
 * Carry the channel being watched into multi-view rather than making somebody
 * find it again in there. It lands in the first free cell — or the first cell
 * if they are all busy, since the one you just asked for is the one you want.
 */
$('#cinemaMultiview').addEventListener('click', () => {
  const item = currentLiveItem;
  if (!item) return;
  multiview.open();          // closes the player, and with it its connection
  const free = multiview.cells.findIndex((c, i) => i < multiview.count && !c.item);
  multiview.start(free >= 0 ? free : 0, item);
});

for (const evt of ['mousemove', 'touchstart', 'click']) {
  $('#playerOverlay').addEventListener(evt, showChrome, { passive: true });
}

// A paused film should keep its controls up rather than fading them away.
$('#video').addEventListener('pause', showChrome);

document.addEventListener('keydown', (event) => {
  const overlay = $('#playerOverlay');
  if (overlay.hidden || !overlay.classList.contains('cinema')) return;
  if (event.target.matches('input, textarea, select')) return;

  if (event.code === 'Space' || event.key === 'k') {
    event.preventDefault();
    $('#vodPlay').click();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    seekFilm(filmPosition() - 10);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    seekFilm(filmPosition() + 10);
  } else if (event.key === 'f') {
    $('#vodFull').click();
  }
  showChrome();
});

function showFilmBar(item, duration, override) {
  film.active = true;
  film.duration = duration || 0;
  film.runtimeKnown = Boolean(duration);
  // Resuming starts the conversion partway into the title, and resolveStream
  // has already recorded where. Zeroing it here would make the scrubber read
  // session time instead of real running time.
  film.offset = lastRemux.offset || 0;
  film.ready = 0;
  // A correction belongs to the title it was measured on. Carrying one into
  // the next film would push its audio out by seconds for no reason.
  if (film.item?.id !== item?.id) film.audioDelayMs = 0;
  film.item = item;
  film.override = override || null;

  const video = $('#video');
  video.controls = false;           // ours replaces it
  $('#vodBar').hidden = false;
  $('#vodTotal').textContent = hms(film.duration);
  enterCinema(item);
  paintFilmBar();
  // The CC button lives in this bar, so it can only appear once the bar has.
  captions.paint();
}

function hideFilmBar() {
  // Note: does NOT exit cinema — live TV runs full screen with no film bar.
  film.active = false;
  film.item = null;
  $('#vodBar').hidden = true;
  // On Apple touch devices a live channel runs on OUR chrome alone. The
  // native strip draws its fullscreen and captions buttons in the top-left
  // corner of the picture — directly under our back button, which eats the
  // tap — and everything it offers is already in the top bar: play/pause,
  // captions, PiP, fullscreen, the LIVE pill. Everywhere else it stays.
  $('#video').controls = !(currentLiveItem && isIOS());
  // The button moves up to the live player's top bar rather than going away
  // with the film bar — a channel can carry captions too.
  captions.close();
  captions.paint();
}

function paintFilmBar() {
  if (!film.active) return;
  const pos = filmPosition();

  // Never let the advertised runtime be shorter than what we've already
  // remuxed or played — bad metadata shouldn't strand the knob off the end.
  const floor = Math.max(pos, film.offset + film.ready);
  if (floor > film.duration) {
    film.duration = Math.ceil(floor);
    $('#vodTotal').textContent = hms(film.duration);
  }

  const total = film.duration || pos;
  const pct = total ? Math.max(0, Math.min(100, (pos / total) * 100)) : 0;

  $('#vodPlayed').style.width = `${pct}%`;
  $('#vodKnob').style.left = `${pct}%`;
  $('#vodElapsed').textContent = hms(pos);

  // Lighter band showing the span already remuxed — instant to seek within.
  if (total) {
    const readyStart = (film.offset / total) * 100;
    const readyWidth = Math.min(100 - readyStart, (film.ready / total) * 100);
    $('#vodReady').style.left = `${readyStart}%`;
    $('#vodReady').style.width = `${Math.max(0, readyWidth)}%`;
  }

  const icon = $('#vodPlayIcon');
  icon.innerHTML = $('#video').paused
    ? '<path d="M7 5l12 7-12 7z"/>'
    : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
}

/** Seek to an absolute point in the film, remuxing again if we must. */
async function seekFilm(target, { force = false } = {}) {
  if (!film.active || film.seeking) return;
  const video = $('#video');

  // A seek inside the converted window never re-attaches, so this is the only
  // place an odd rate would otherwise survive a scrubber click.
  normalizeRate();
  // Runtime may not have arrived yet; don't let an unknown duration collapse
  // every seek onto zero.
  const ceiling = film.duration > 0 ? film.duration - 2 : Number.MAX_SAFE_INTEGER;
  const clamped = Math.max(0, Math.min(ceiling, target));

  // A title playing natively (mp4, or a local file) has a real duration and
  // Range support — an ordinary seek works. Restarting a remux for it would
  // spend a provider connection to do what the video element does for free.
  if (!force && !lastRemux.session && Number.isFinite(video.duration) && clamped < video.duration) {
    video.currentTime = clamped;
    paintFilmBar();
    return;
  }

  // Inside the current session's remuxed span? Then it's just a normal seek.
  const withinStart = film.offset;
  const withinEnd = film.offset + film.ready;
  if (!force && clamped >= withinStart && clamped < withinEnd - 1) {
    video.currentTime = clamped - film.offset;
    paintFilmBar();
    return;
  }

  film.seeking = true;
  stopLeadWatch();

  // Stop the outgoing stream before the loading screen goes up.
  //
  // Nothing here replaces the source until the new conversion has banked
  // enough to play through, which is tens of seconds. Left alone the old
  // stream carries on for all of it — a black loading screen with the previous
  // scene still talking behind it, from a part of the film you have already
  // decided to leave.
  const resumeOnFailure = !video.paused;
  video.pause();

  loader.show(`Jumping to ${hms(clamped)}…`, '');

  try {
    if (film.item?.archivePath) {
      // An archive conversion is the WHOLE episode, running from the top —
      // the only arrangement these rips hold sync in. Seeking never restarts
      // it: ask the server for the file's session (the one already running
      // comes straight back), wait for the conversion to pass the mark, and
      // jump there inside the same output.
      const remux = await api('/api/archive/play', {
        path: film.item.archivePath,
        profileId: profiles.current?.id || '',
        ...lowParam(),
      });
      const sameSession = Boolean(remux.session) && lastRemux.session === remux.session;
      if (remux.mode === 'direct') {
        // The drive's file plays natively; the browser seeks it itself.
        lastRemux = { sourceDuration: remux.sourceDuration || 0 };
        film.offset = 0;
        attach(remux.url, 'file', { seekTo: clamped });
      } else {
        lastRemux = remux;
        await waitForConversionSpan(remux, clamped);
        film.offset = 0;
        if (sameSession) {
          // Same growing playlist the player is already attached to; the
          // jump is nothing more than a currentTime.
          video.currentTime = clamped;
          video.play().catch(() => {});
        } else {
          // The old session lapsed — another title took the encoder, or the
          // server restarted — so a fresh one is running from the top, and
          // this attach starts playback at the mark inside it.
          film.ready = 0;
          attach(remux.url, 'm3u8', { seekTo: clamped });
        }
      }
      startLeadWatch();
    } else {
      // A downloads-backed title seeks against the file on disk — fast, and
      // no provider connection spent. Everything else restarts the provider
      // remux at the mark.
      // This seek supersedes the conversion it is seeking within, and says
      // so: the server no longer guesses by clearing every conversion on the
      // box, which is what used to cut off a multiview cell.
      const replaces = lastRemux.session || '';
      const remux = await api(
        '/api/remux',
        film.item?.downloadId
          ? {
            download: film.item.downloadId,
            start: Math.floor(clamped),
            replaces,
            ...delayParam(),
            ...lowParam(),
          }
          : {
            kind: film.override?.kind || (film.item.kind === 'movie' ? 'movie' : film.item.kind),
            id: film.override?.id ?? film.item.id,
            ext: film.override?.ext ?? film.item.ext ?? '',
            vcodec: film.override?.vcodec || film.item.vcodec || '',
            start: Math.floor(clamped),
            replaces,
            ...delayParam(),
            ...lowParam(),
          }
      );
      lastRemux = remux;

      await waitForPrebuffer(remux);
      // Swapped in together, and not before now. Setting the offset when the
      // request came back left it describing the incoming session while the
      // outgoing one played on through the whole buffering wait — the scrubber
      // jumped forward by the distance of the seek several seconds early, and
      // any position saved in that window was wrong by the same amount.
      film.offset = remux.offset || 0;
      film.ready = 0;
      attach(remux.url, 'm3u8');
      startLeadWatch();
    }
  } catch (err) {
    toast(`Couldn't jump there: ${err.message}`);
    // The jump failed, so the old stream is still the one loaded and still
    // where it was. Put it back the way it was found rather than leaving the
    // film silently stopped somewhere nobody asked for.
    if (resumeOnFailure) video.play().catch(() => {});
  } finally {
    film.seeking = false;
    loader.hide();
    paintFilmBar();
  }
}

/* ---- scrubber interaction ---- */

function trackFraction(event) {
  const rect = $('#vodTrack').getBoundingClientRect();
  const x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
  return Math.max(0, Math.min(1, x / rect.width));
}

$('#vodTrack').addEventListener('click', (event) => {
  if (!film.duration) return;
  seekFilm(trackFraction(event) * film.duration);
});

$('#vodTrack').addEventListener('mousemove', (event) => {
  if (!film.duration) return;
  const hover = $('#vodHover');
  hover.hidden = false;
  hover.textContent = hms(trackFraction(event) * film.duration);
  hover.style.left = `${trackFraction(event) * 100}%`;
});

$('#vodTrack').addEventListener('mouseleave', () => ($('#vodHover').hidden = true));

$('#vodTrack').addEventListener('keydown', (event) => {
  const step = event.shiftKey ? 300 : 30;
  if (event.key === 'ArrowRight') seekFilm(filmPosition() + step);
  else if (event.key === 'ArrowLeft') seekFilm(filmPosition() - step);
  else return;
  event.preventDefault();
  // The document-level handler seeks on these keys too. Without this, one
  // arrow press fired both — two different jumps, and on a remuxed title two
  // competing conversions.
  event.stopPropagation();
});

/* ------------------------------------------------------------- captions ---
 *
 * Subtitles come from two completely different places, and the menu deliberately
 * does not distinguish them, because a viewer has no reason to care:
 *
 *   * **Sidecar tracks.** A conversion writes its text subtitle streams out as
 *     WebVTT beside the video segments, and those are added as `<track>`
 *     children. This is where a film's subtitles come from.
 *   * **In-band tracks.** Captions carried inside the stream itself — CEA-608
 *     on a live channel, a text track in a downloaded MP4 — which hls.js and
 *     the browser surface on their own.
 *
 * Both land in `video.textTracks`, so that list is the single source of truth
 * and the menu is built from it rather than from what we think we added.
 *
 * The one thing that needs care is that a sidecar is being WRITTEN while it is
 * being read. A `<track>` fetches once and keeps whatever it got, so a track
 * turned on two minutes into a conversion would hold two minutes of subtitles
 * and then stop for ever. While the conversion is still running the element is
 * replaced on a timer, which re-fetches the file as it has grown.
 */
const captions = {
  /** Sidecar descriptors from the last /api/remux response. */
  sidecars: [],
  /**
   * The chosen track's label, or '' for off. Survives a track being replaced,
   * and is seeded from the profile so a film opens with the same subtitles as
   * the last one.
   */
  get chosen() {
    return prefs.data.captionTrack || '';
  },
  set chosen(value) {
    prefs.data.captionTrack = value || '';
  },
  timer: null,
  /** Whether any fetch has yet returned actual cues — decides the cadence. */
  gotWords: false,
  /** True while iOS native fullscreen legitimately holds a track showing. */
  native: false,

  /** A film or channel is starting: forget the last one's tracks entirely. */
  reset() {
    this.sidecars = [];
    this.gotWords = false;
    clearInterval(this.timer);
    this.timer = null;
    for (const el of [...$('#video').querySelectorAll('track')]) el.remove();
    // Anything the engine put there is the engine's to remove, but it must not
    // be left showing over the next title.
    for (const track of $('#video').textTracks) track.mode = 'disabled';
    this.drawCues(null);
    this.close();
    this.paint();
  },

  /**
   * Draw the chosen track's active cues into our own overlay.
   *
   * The browser can render cues itself, and for a long time it was left to —
   * which worked on desktop Chrome and produced NOTHING on an iPad, for live
   * and films alike. WebKit's cue painting differs by device and disappears
   * entirely behind some of its player chrome. So the chosen track runs in
   * 'hidden' mode — cues load, cuechange fires, the browser draws nothing —
   * and the words are painted here, the same way on every platform.
   *
   * The one place the browser is better placed than us is iOS native
   * fullscreen, where the DOM overlay cannot be seen at all; nativeMode()
   * flips the chosen track to 'showing' for the duration and back after.
   */
  drawCues(track) {
    const box = $('#ccOverlay');
    box.innerHTML = '';
    const cues = track?.activeCues;
    if (!cues || !cues.length || track.mode === 'disabled') {
      box.hidden = true;
      return;
    }
    for (const cue of [...cues]) {
      const line = el('span', 'cc-line');
      // getCueAsHTML understands VTT markup (<i>, <b>, voice tags) and yields
      // nodes, never raw markup from the stream.
      if (typeof cue.getCueAsHTML === 'function') line.append(cue.getCueAsHTML());
      else line.textContent = cue.text || '';
      box.append(line);
    }
    box.hidden = box.childElementCount === 0;
  },

  /** Follow one track's cues; unhooks whatever was followed before. */
  follow(track) {
    if (this.followed && this.followed !== track) this.followed.oncuechange = null;
    this.followed = track || null;
    if (track) track.oncuechange = () => this.drawCues(track);
    this.drawCues(track);
  },

  /**
   * iOS native fullscreen cannot show our overlay, so hand the cues to the
   * platform for the duration: 'showing' on the way in, 'hidden' on the way
   * out, the overlay parked while the platform draws.
   */
  nativeMode(on) {
    // Flagged before any mode is touched, so enforce() knows these flips are
    // sanctioned rather than something to undo.
    this.native = on;
    const track = this.followed;
    if (track) {
      track.mode = on ? 'showing' : 'hidden';
      if (on) this.lift(track);
    }
    if (on) $('#ccOverlay').hidden = true;
    else this.drawCues(track);
  },

  /**
   * Our menu is the only authority on caption state. The browser and the
   * engines flip TextTrack modes on their own — hls.js manages its in-band
   * tracks as renditions load, and WebKit surfaces its own caption picker —
   * and any of those flips used to bring captions back after Off, from a
   * place no button press had touched. Every mode change anywhere lands
   * here, and anything that disagrees with the menu is put back on the
   * spot. iOS native fullscreen is the one sanctioned exception: nativeMode
   * deliberately holds the chosen track in 'showing' while the platform
   * draws it.
   */
  enforce() {
    if (this.native) return;
    for (const track of this.list()) {
      const want = this.chosen && track.label === this.chosen ? 'hidden' : 'disabled';
      if (track.mode !== want) track.mode = want;
    }
    if (!this.chosen && this.followed) this.follow(null);
  },

  /**
   * Attach the tracks a conversion is writing.
   *
   * `remux.subs` is what the server found in the source and is extracting; an
   * empty list means this title has no text subtitles, which is a real answer
   * and is said as one.
   */
  attach(remux) {
    this.sidecars = (remux?.subs || []).filter((s) => s && s.url);
    // A new title means new files: whatever the LAST film's tracks held says
    // nothing about whether this one's have words yet.
    this.gotWords = false;
    if (!this.sidecars.length) return this.paint();
    this.build();
    this.armRefresh();
  },

  /**
   * Re-read the files while the conversion is still writing them. Stops as
   * soon as it finishes, with one last pass to pick up the tail.
   *
   * The cadence answers a real complaint. At the start of a conversion the
   * subtitle file exists but is still EMPTY — ffmpeg has not reached the
   * first line of dialogue — so captions turned on in that window fetch a
   * file with nothing in it, and on a flat 20-second interval the words
   * arrived up to half a minute after the menu said they were on. Until a
   * fetch comes back with actual cues in it the re-read runs quick; from
   * then on it relaxes to the slow beat.
   */
  armRefresh() {
    clearInterval(this.timer);
    // Quick only while somebody is WAITING on words: a track chosen and no
    // cues yet. With captions off there is nothing to hurry for.
    const eager = this.chosen && !this.gotWords;
    this.timer = setTimeout(async () => {
      if (!lastRemux.session) return this.stopRefreshing();
      let done = false;
      try {
        const status = await api('/api/remux/status', { id: lastRemux.session });
        done = Boolean(status.complete);
      } catch {
        return this.stopRefreshing();   // session gone; what we have is all there is
      }
      // Never yank the file out from under its own fetch. Replacing a
      // <track> aborts its load, and on a slow link the quick cadence
      // aborted every attempt — the viewer reported captions arriving only
      // when the conversion FINISHED, minutes in, because that is when the
      // churn stopped. If the last swap is still loading, let it land.
      const loading = [...$('#video').querySelectorAll('track')]
        .some((t) => t.readyState === 1);
      if (!loading) this.build();
      if (!done || loading) this.armRefresh();
    }, eager ? CC_REFRESH_EAGER : CC_REFRESH);
  },

  stopRefreshing() {
    clearInterval(this.timer);
    this.timer = null;
  },

  /**
   * (Re)create the sidecar `<track>` elements.
   *
   * The URL carries a changing query so the browser fetches the grown file
   * rather than answering from cache, and the chosen track is turned back on
   * afterwards — replacing the element is invisible to the viewer, and it has
   * to stay that way or captions would blink off every refresh.
   */
  build() {
    const video = $('#video');
    const stamp = Date.now();
    for (const el of [...video.querySelectorAll('track')]) el.remove();
    for (const sub of this.sidecars) {
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = sub.label || 'Subtitles';
      if (sub.lang) el.srclang = sub.lang;
      el.src = `${sub.url}?t=${stamp}`;
      // Cues only exist once the file has been fetched, so this is the moment
      // they can be moved off the control bar — and the first fetch that
      // brings real cues back is the signal to relax the refresh cadence.
      el.addEventListener('load', () => {
        this.lift(el.track);
        if (el.track?.cues?.length) this.gotWords = true;
      });
      video.append(el);
    }
    this.restore();
    this.paint();
  },

  /**
   * Move cues up off the bottom of the frame.
   *
   * A browser puts subtitles at the very bottom of the video, which here is
   * exactly where the scrubber, the clock and these buttons are — a caption
   * behind the seek bar is a caption you cannot read. `::cue` can colour text
   * but cannot place it; the position lives on the cue itself.
   *
   * Only cues that never asked for a position are moved. A source that
   * positioned its own — a sign on a wall, a caption dodging a burned-in
   * subtitle — meant it, and is left where it put itself.
   */
  lift(track) {
    if (!track?.cues) return;
    for (const cue of track.cues) {
      if (cue.line === 'auto' || cue.line === undefined) {
        cue.snapToLines = true;
        cue.line = -3;      // three lines up from the bottom, clear of the bar
      }
    }
  },

  /** Every track the player has, in menu order. */
  list() {
    return [...$('#video').textTracks].filter(
      (t) => t.kind === 'subtitles' || t.kind === 'captions'
    );
  },

  /** Turn on the one that matches what was chosen, if it is there. */
  restore() {
    if (!this.chosen) return;
    // A newly added track starts disabled, and setting a mode is what makes a
    // browser load its cues at all. 'hidden', not 'showing': the cues load
    // and fire, and drawCues is what puts them on screen.
    for (const track of this.list()) {
      track.mode = track.label === this.chosen ? 'hidden' : 'disabled';
      if (track.mode === 'hidden') this.follow(track);
    }
  },

  /** Choose a track by label, or '' to turn captions off. */
  choose(label) {
    this.chosen = label || '';
    let followed = null;
    for (const track of this.list()) {
      track.mode = track.label === this.chosen ? 'hidden' : 'disabled';
      if (track.mode === 'hidden') followed = track;
    }
    this.follow(followed);
    // hls.js keeps its own idea of which subtitle rendition is loading, and
    // for an in-band track that is the switch that matters. Display stays off
    // always — drawing is ours.
    if (engine && engineKind === 'hls.js' && Array.isArray(engine.subtitleTracks)) {
      const at = engine.subtitleTracks.findIndex((t) => t.name === this.chosen);
      engine.subtitleTrack = at;
      engine.subtitleDisplay = false;
    }
    prefs.save();
    // Turning captions on mid-conversion re-paces the refresher: the beat in
    // flight was armed at the relaxed cadence when nothing was chosen.
    if (this.timer) this.armRefresh();
    this.close();
    this.paint();
  },

  /**
   * The button is there whenever a player is, in whichever bar that player
   * has: the bottom one for a film, the top one for live, which has no bottom
   * bar of its own.
   *
   * It is NOT hidden when a title turns out to have no subtitles. Hiding it
   * was the first try and it was wrong twice over — you cannot tell a title
   * with no captions from a build that never shipped the feature, and a
   * control that comes and goes by title is one you stop looking for. It says
   * so in the menu instead.
   */
  paint() {
    const wrap = $('#ccWrap');
    const playing = !$('#playerOverlay').hidden;
    wrap.hidden = !playing;
    if (playing) {
      // Moving the node keeps its listeners, its menu and its state — only its
      // parent changes. The menu has to flip which way it opens with it.
      //
      // Three homes now, not two. A film's CC sits in its bottom bar. Live on
      // Apple touch docks it bottom-right in the live strip — the top row was
      // carrying eight controls on a phone, crowded to the point of the CC
      // badge overlapping the back button. Live everywhere else keeps the top
      // bar, which has the room.
      const liveTouch = !film.active && Boolean(currentLiveItem) && isIOS();
      const top = !film.active && !liveTouch;
      const home = film.active ? $('#vodBar') : liveTouch ? $('#liveBar') : $('.player-bar-actions');
      // Ahead of the heart in the top bar, not against the edge: multi-view and
      // close are the two ways OUT of the player and they keep the corner. In
      // the live strip it goes last, which the layout pins to the right edge.
      const before = film.active ? $('#vodMute') : top ? $('#favBtn') : null;
      if (wrap.parentElement !== home || wrap.nextElementSibling !== before) {
        home.insertBefore(wrap, before);
      }
      wrap.classList.toggle('cc-top', top);
      $('#ccBtn').classList.toggle('icon-btn', top || liveTouch);
      $('#ccBtn').classList.toggle('vod-btn', film.active);
    }
    const on = Boolean(this.chosen) && this.list().some((t) => t.label === this.chosen);
    $('#ccBtn').classList.toggle('is-on', on);
    $('#ccBtn').title = on ? `Subtitles: ${this.chosen}` : 'Subtitles';
    if (!$('#ccMenu').hidden) this.renderMenu();
  },

  renderMenu() {
    const menu = $('#ccMenu');
    menu.innerHTML = '';
    const tracks = this.list();

    if (!tracks.length) {
      const note = el('p', 'cc-none');
      // Three different reasons a title has none, and which one it is decides
      // whether there is anything to be done about it — so say which.
      note.textContent = film.active
        ? (lastRemux.session
          ? 'No subtitles in this film. The provider ships none this can use — '
            + 'picture subtitles from a disc would need OCR, not a conversion.'
          : 'No subtitles in this file.')
        : 'No subtitles on this channel. Live captions only appear if the '
          + 'broadcaster sends them in the stream.';
      menu.append(note);
      return;
    }

    const row = (label, value) => {
      const b = el('button', 'cc-item');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.textContent = label;
      const on = (value || '') === this.chosen;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
      b.addEventListener('click', () => this.choose(value));
      menu.append(b);
    };
    row('Off', '');
    for (const track of tracks) row(track.label || 'Subtitles', track.label);
  },

  toggleMenu() {
    if ($('#ccMenu').hidden) {
      this.renderMenu();
      $('#ccMenu').hidden = false;
      $('#ccBtn').setAttribute('aria-expanded', 'true');
    } else {
      this.close();
    }
  },

  close() {
    $('#ccMenu').hidden = true;
    $('#ccBtn')?.setAttribute('aria-expanded', 'false');
  },
};

// Every TextTrack mode flip on the player — ours, hls.js's, the browser's
// own caption picker — fires this one event, so the menu's choice is
// re-asserted at the very moment something else overrides it. This is what
// keeps captions OFF meaning off: they used to come back on their own when
// an engine re-enabled a track long after the button was pressed.
$('#video').textTracks.addEventListener('change', () => captions.enforce());

/** How often a still-converting subtitle file is re-read. */
const CC_REFRESH = 20000;
/** Until the first words arrive, the growing file is re-read this often. */
const CC_REFRESH_EAGER = 2500;

$('#ccBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  captions.toggleMenu();
  showChrome();
});
document.addEventListener('click', (event) => {
  if (!$('#ccWrap').contains(event.target)) captions.close();
});

// A track can arrive after the menu was drawn — hls.js adds in-band ones when
// it reaches them, and a sidecar's cues load asynchronously.
$('#video').textTracks.addEventListener?.('addtrack', () => {
  captions.restore();
  captions.paint();
});
$('#video').textTracks.addEventListener?.('removetrack', () => captions.paint());

/**
 * Surface an altered playback rate. Nothing here ever sets a rate other than
 * 1 — but an extension can, and a video quietly running at a fraction of speed
 * is baffling without something on screen saying so.
 *
 * This used to be said twice: a pill in the bar, and a second one parked over
 * the picture outside the fading chrome. The floating one is gone. It was
 * there because the bar fades — but it sat in the middle of the frame on every
 * title whether or not anything was wrong with it, and one badge in the bar,
 * on the rare occasion an extension has meddled, is enough.
 */
function paintSpeed() {
  const rate = $('#video').playbackRate;
  const off = Math.abs(rate - 1) > 0.01;
  $('#vodSpeed').hidden = !off;
  if (off) $('#vodSpeedLabel').textContent = `${Number(rate.toFixed(2))}×`;
}

/** Put playback back to normal speed. */
function normalizeRate() {
  const video = $('#video');
  if (Math.abs(video.playbackRate - 1) > 0.01) {
    video.playbackRate = 1;
    video.defaultPlaybackRate = 1;
  }
  paintSpeed();
}

$('#video').addEventListener('ratechange', paintSpeed);

$('#vodSpeed').addEventListener('click', () => {
  normalizeRate();
  toast('Playback speed reset to normal.');
});

/**
 * Record who last changed the rate. Nothing in this app sets a rate other than
 * 1, so if it drifts the culprit is outside — a speed-control extension, most
 * likely — and the captured stack is what tells us which.
 */
let lastRateChange = null;

$('#video').addEventListener('ratechange', () => {
  const rate = $('#video').playbackRate;
  if (Math.abs(rate - 1) > 0.01) {
    lastRateChange = { rate, at: new Date().toISOString(), stack: new Error().stack || '' };
  }
});
window.portalDiagnostics = () => ({
  playbackRate: $('#video').playbackRate,
  lastRateChange,
  filmOffset: film.offset,
  filmReady: Math.round(film.ready),
  remuxSession: lastRemux.session || null,
  videoDuration: $('#video').duration,
  currentTime: $('#video').currentTime,
});

$('#vodBack10').addEventListener('click', () => seekFilm(filmPosition() - 10));
$('#vodFwd10').addEventListener('click', () => seekFilm(filmPosition() + 10));

$('#vodPlay').addEventListener('click', () => {
  const video = $('#video');
  if (video.paused) video.play().catch(() => {});
  else video.pause();
  paintFilmBar();
});

$('#vodMute').addEventListener('click', () => {
  const video = $('#video');
  video.muted = !video.muted;
  $('#vodMute').style.color = video.muted ? 'var(--live)' : '';
});

/**
 * iPhone and iPad — including iPadOS 13+, which reports itself as a Mac and can
 * only be told apart by the fact that it has touch points.
 */
const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Hand iOS its own full-screen player. webkitEnterFullscreen is the video
 * element's entry point and is what produces the standard view — the same one
 * every iOS video app shows, with Apple's controls at Apple's sizes.
 *
 * It refuses to open before the media has metadata, which is reachable here:
 * the bar appears as soon as the remux starts, so the button can be hit before
 * the first frame lands. Wait for metadata rather than no-op on the tap.
 */
function enterNativeFullscreen(video) {
  if (video.readyState < 1) {
    video.addEventListener('loadedmetadata', () => video.webkitEnterFullscreen(), { once: true });
    return;
  }
  video.webkitEnterFullscreen();
}

/**
 * Full screen, from whichever button asked for it.
 *
 * Two buttons, one behaviour: the film bar's, and the live player's — which
 * exists because live keeps the browser's own controls and iOS puts its
 * fullscreen button in the one corner our chrome already occupies.
 */
function goFullscreen() {
  const video = $('#video');

  // On iPhone the element Fullscreen API does not exist at all, so fullscreening
  // the shell was a silent no-op; on iPad it worked but kept our chrome instead
  // of the player the platform already has.
  if (isIOS() && typeof video.webkitEnterFullscreen === 'function') {
    enterNativeFullscreen(video);
    return;
  }

  // Everywhere else, fullscreen the shell, not the video element — that keeps
  // our controls in frame instead of handing over to the browser's own overlay.
  const target = document.querySelector('.player-shell') || document.querySelector('.video-frame');
  if (document.fullscreenElement) document.exitFullscreen();
  else target.requestFullscreen?.();
}

$('#vodFull').addEventListener('click', goFullscreen);
$('#liveFull').addEventListener('click', goFullscreen);

/* ------------------------------------------------------ picture in picture ---
 *
 * One button, two APIs. Desktop Chrome speaks the standard —
 * requestPictureInPicture on the element, pictureInPictureElement on the
 * document. iOS (and therefore every browser on iOS, Chrome included — they
 * are all WebKit) speaks presentation modes instead:
 * webkitSetPresentationMode('picture-in-picture'). Same floating window,
 * different spelling, so the difference lives here and nowhere else.
 *
 * The button only exists when one of the two dialects is spoken at all;
 * everything else — starting, ending, and the pressed state — funnels through
 * this one object so the two APIs cannot drift apart in behaviour.
 */
const pip = {
  supported() {
    const video = $('#video');
    if (document.pictureInPictureEnabled && !video.disablePictureInPicture) return true;
    return typeof video.webkitSetPresentationMode === 'function'
      && video.webkitSupportsPresentationMode?.('picture-in-picture') === true;
  },

  active() {
    const video = $('#video');
    return document.pictureInPictureElement === video
      || video.webkitPresentationMode === 'picture-in-picture';
  },

  async toggle() {
    const video = $('#video');
    if (this.active()) {
      try {
        if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
        else video.webkitSetPresentationMode('inline');
      } catch {
        /* already back inline */
      }
      return;
    }
    // An iPad advertises BOTH dialects and then refuses the standard one —
    // "the video element does not support the Picture-in-Picture mode",
    // measured — so on Apple hardware Apple's own dialect goes first, and
    // either dialect is the other's fallback rather than a dead end. Only
    // when both have refused is the failure worth words.
    const webkitFirst = isIOS() && typeof video.webkitSetPresentationMode === 'function';
    const standard = async () => {
      if (!document.pictureInPictureEnabled
        || typeof video.requestPictureInPicture !== 'function') {
        throw new Error('no standard API');
      }
      await video.requestPictureInPicture();
    };
    const webkit = async () => {
      if (typeof video.webkitSetPresentationMode !== 'function') {
        throw new Error('no webkit API');
      }
      video.webkitSetPresentationMode('picture-in-picture');
    };
    const [first, second] = webkitFirst ? [webkit, standard] : [standard, webkit];
    try {
      await first();
    } catch (firstErr) {
      try {
        await second();
      } catch {
        // Most commonly: no video loaded yet, or the browser wants a fresher
        // gesture. The honest answer is words, not a dead button.
        toast(`Couldn't pop the picture out — ${firstErr.message}`);
      }
    }
  },

  /** The button reflects the floating window, whichever API opened it. */
  paint() {
    $('#pipBtn').classList.toggle('is-on', this.active());
  },
};

$('#livePlay').addEventListener('click', () => {
  const video = $('#video');
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});
// The icon follows the element, not the click — a stall or an ended stream
// moves it too.
const paintLivePlay = () => {
  const paused = $('#video').paused;
  $('#livePlay').innerHTML = paused
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
  $('#livePlay').title = paused ? 'Play' : 'Pause';
  $('#livePlay').setAttribute('aria-label', paused ? 'Play' : 'Pause');
};
for (const evt of ['play', 'pause']) $('#video').addEventListener(evt, paintLivePlay);

$('#pipBtn').addEventListener('click', () => pip.toggle());
for (const evt of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) {
  $('#video').addEventListener(evt, () => pip.paint());
}

/* Apple's player is the only thing on screen while it is up, so our bar just
 * sits behind it competing for the same taps on the way out. Stand down for the
 * duration and take the film back on exit.
 *
 * This is the one place a remuxed film shows the native scrubber, which spans
 * only what has been remuxed so far rather than the whole runtime — the reason
 * the custom bar exists in the first place. */
$('#video').addEventListener('webkitbeginfullscreen', () => {
  $('#video').controls = true;
  if (film.active) $('#vodBar').hidden = true;
  // Our caption overlay is DOM and the native player cannot show it; hand the
  // cues to the platform for the duration.
  captions.nativeMode(true);
});

$('#video').addEventListener('webkitendfullscreen', () => {
  if (film.active) {
    $('#video').controls = false;
    $('#vodBar').hidden = false;
    paintFilmBar();
  } else {
    // Back inline on live: on Apple touch devices the native strip stays off
    // (its buttons render under our back button), everywhere else it returns.
    $('#video').controls = !(currentLiveItem && isIOS());
  }
  captions.nativeMode(false);
  showChrome();
});

$('#video').addEventListener('timeupdate', paintFilmBar);
$('#video').addEventListener('play', paintFilmBar);
$('#video').addEventListener('pause', paintFilmBar);

// A natively-played file (local mp4) has no remux and no probe, so the only
// source of its runtime is the media itself.
$('#video').addEventListener('loadedmetadata', () => {
  const video = $('#video');
  if (!film.active || film.duration > 0) return;
  if (Number.isFinite(video.duration) && video.duration > 0) {
    film.duration = Math.floor(video.duration);
    $('#vodTotal').textContent = hms(film.duration);
    paintFilmBar();
  }
});

/* ------------------------------------------------------- remux lead ---

 * ffmpeg produces only as fast as the provider serves it. For a high-bitrate
 * title that can be slower than playback, so the cushion drains and the film
 * stalls mid-scene — which is why it happens on some films and not others.
 *
 * Rather than let the video stutter, watch how far ahead the remux is and take
 * a single deliberate pause when it gets thin, showing the same loading screen
 * with real progress. One honest wait beats repeated stuttering.
 */

let activeRemux = null;
let leadTimer = null;
let recovering = false;

const LEAD_FLOOR = 12;   // seconds of runway before we step in
const LEAD_RESUME = 40;  // rebuild to this before playing again

/**
 * Bumped whenever the watcher is stopped or restarted. The recovery loop below
 * is async and outlives clearInterval, so it checks this before touching the
 * video or the loader — otherwise a seek that happened mid-recovery would find
 * the old loop pausing, resuming and relabelling its brand-new stream.
 */
let leadGen = 0;

function startLeadWatch() {
  stopLeadWatch();
  if (!activeRemux) return;
  const gen = ++leadGen;

  leadTimer = setInterval(async () => {
    const video = $('#video');
    if (gen !== leadGen) return;
    if (!activeRemux || recovering || video.paused || !video.duration) return;

    let status;
    try {
      status = await api('/api/remux/status', { id: activeRemux.session });
    } catch {
      return stopLeadWatch(); // session gone; nothing left to guard
    }
    if (gen !== leadGen) return; // superseded while the request was in flight

    film.ready = status.seconds;

    // Once ffmpeg has written the whole file there's no runway to run out of.
    // Mark the entire remainder seekable before the polling stops, or the
    // ready band freezes at whatever the last poll happened to see.
    if (status.complete) {
      if (film.duration) film.ready = Math.max(film.ready, film.duration - film.offset);
      paintFilmBar();
      return stopLeadWatch();
    }
    paintFilmBar();

    const lead = status.seconds - video.currentTime;
    if (lead > LEAD_FLOOR) return;

    recovering = true;
    const wasPlaying = !video.paused;
    video.pause();
    loader.show('Buffering ahead — the provider is feeding this one slowly', '');
    const pausedAt = Date.now();
    let firstGained = null;

    while (recovering && gen === leadGen) {
      let s;
      try {
        s = await api('/api/remux/status', { id: activeRemux.session });
      } catch {
        break;
      }
      if (gen !== leadGen) break;
      const gained = s.seconds - video.currentTime;
      if (firstGained === null) firstGained = gained;
      const eta = bankingEta(
        gained - firstGained,
        (Date.now() - pausedAt) / 1000,
        LEAD_RESUME - gained
      );
      loader.set(
        Math.max(0, Math.min(1, gained / LEAD_RESUME)),
        `${Math.max(0, Math.floor(gained))}s of ${LEAD_RESUME}s runway${eta}`
      );
      if (s.complete || gained >= LEAD_RESUME) break;
      await new Promise((r) => setTimeout(r, 700));
    }

    // Only clean up if we still own playback. A seek during recovery has
    // already attached a new stream and is running its own loader.
    if (gen === leadGen) {
      loader.hide();
      recovering = false;
      if (wasPlaying) video.play().catch(() => {});
    }
  }, 3000);
}

function stopLeadWatch() {
  leadGen += 1;       // invalidates any in-flight recovery loop
  recovering = false; // and releases the flag it spins on
  clearInterval(leadTimer);
  leadTimer = null;
}

/**
 * Hold playback until the server has banked enough video. ffmpeg can only remux
 * as fast as the provider serves, so starting on the first segment means the
 * player repeatedly catches up to the encoder and stalls. Waiting here is what
 * buys uninterrupted playback afterwards.
 */
/** "about 1m 20s" from a seconds count. */
function etaText(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * Wall-clock estimate of how long a banking wait has left, from the observed
 * rate: video-seconds gained per real second since the wait began.
 */
function bankingEta(gained, elapsed, remaining) {
  if (elapsed < 2.5 || gained <= 0) return '';
  const rate = gained / elapsed;
  if (rate < 0.05) return '';
  const eta = remaining / rate;
  return eta > 2 ? ` · about ${etaText(eta)} left` : '';
}

async function waitForPrebuffer(remux) {
  if (!remux.session) return;
  // A deeper cushion on a weak link: the stream is small by then, so a
  // minute of it is cheap to hold and is what rides out the gaps.
  const target = lowMode()
    ? Math.max(remux.prebuffer || 45, 60)
    : (remux.prebuffer || 45);
  activeRemux = { session: remux.session, target };

  loader.show('Buffering — this plays through without stopping', '');
  const startedAt = Date.now();
  let firstSeconds = null;

  for (;;) {
    let status;
    try {
      status = await api('/api/remux/status', { id: remux.session });
    } catch {
      return; // Session vanished; let the player try regardless.
    }

    if (status.failed) throw new Error(status.error || 'Conversion failed');

    // Deliberately does not touch `film`. This is the INCOMING session's
    // progress, and during a seek the outgoing one is still on screen — writing
    // it here made the scrubber and the saved position describe a stream that
    // was not playing yet. The caller applies it at the moment it attaches.
    if (firstSeconds === null) firstSeconds = status.seconds;
    const ready = Math.min(status.seconds, target);
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = bankingEta(status.seconds - firstSeconds, elapsed, target - status.seconds);
    loader.set(ready / target, `${Math.floor(ready)}s of ${target}s buffered${eta}`);

    // Short files finish before reaching the target — that's still enough.
    if (status.seconds >= target || status.complete) break;

    await new Promise((r) => setTimeout(r, 600));
  }

  loader.set(1, 'Ready');
  loader.hide();
}

/**
 * Wait until the conversion has run PAST a point in the episode.
 *
 * An archive title converts whole, from the top — the one path these old rips
 * have never drifted on — so a resume or a deep seek is not a new conversion
 * at an offset, it is a wait for the one conversion to reach the mark, and
 * then a plain jump inside its output. A file already converted this session
 * sails through here instantly; a deep first resume honestly costs minutes,
 * and the loader says which minute it is on.
 */
async function waitForConversionSpan(remux, wantSeconds) {
  if (!remux.session) return;
  // A cushion past the mark, so playback lands on written segments rather
  // than on the conversion frontier itself.
  const target = wantSeconds + 8;
  activeRemux = { session: remux.session, target };

  loader.show('Loading the whole episode so nothing falls out of sync', '');
  const startedAt = Date.now();
  let firstSeconds = null;

  for (;;) {
    let status;
    try {
      status = await api('/api/remux/status', { id: remux.session });
    } catch {
      return; // Session vanished; let the player try regardless.
    }

    if (status.failed) throw new Error(status.error || 'Conversion failed');
    if (status.seconds >= target || status.complete) break;

    if (firstSeconds === null) firstSeconds = status.seconds;
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = bankingEta(status.seconds - firstSeconds, elapsed, target - status.seconds);
    loader.set(Math.min(1, status.seconds / target),
      `${hms(Math.floor(status.seconds))} of ${hms(Math.floor(target))} ready${eta}`);

    await new Promise((r) => setTimeout(r, 600));
  }

  loader.set(1, 'Ready');
  loader.hide();
}

/* ------------------------------------------------------------- resume ---

 * Playback already reports its position against the active profile, so the
 * only thing missing was reading it back. A title is worth resuming when it
 * was left more than a minute in and short of the end.
 */

const RESUME_MIN = 60;      // ignore a position from the opening minute
const RESUME_MAX_RATIO = 0.95; // past this it counts as finished

/**
 * One identity per title, whatever route it's played by. A film streamed from
 * the provider and the same film opened from Downloads share this key, so the
 * position carries between them.
 */
function resumeKeyFor(item, episode, season) {
  if (item.resumeKey) return item.resumeKey; // downloads carry theirs
  if (episode) return `series:${item.id}:s${season}e${episode.episode_num}`;
  return `${item.kind}:${item.id}`;
}

async function fetchProgress(key) {
  if (!profiles.current || !key) return null;
  try {
    const row = await api(`/api/profiles/${profiles.current.id}/progress`, { key });
    if (!row.found || row.completed) return null;
    if (row.position < RESUME_MIN) return null;
    if (row.duration && row.position / row.duration > RESUME_MAX_RATIO) return null;
    return row;
  } catch {
    return null;
  }
}

/**
 * An explicit thumb, which is the strongest signal For You has: the server
 * weighs it at double a completed watch. Zero clears it.
 *
 * Fire and forget on purpose. The caller has already redrawn — the press has
 * to land now rather than when a round trip over Tailscale does — and a rating
 * that fails to save is worth a line in the console and nothing louder.
 */
/**
 * Like or not-for-me, for tuning what gets suggested.
 *
 * One pair of buttons, built here rather than twice, because a film's page
 * and a show's page have to mean exactly the same thing by them. They were
 * on the film page only; a show could be watched, favourited and finished
 * and never told the box whether it was any good.
 *
 * A RATING IS NOT A WATCH, and that is the point of it. "Sometimes I have
 * already watched a show or movie and want to use it as an example of
 * something I like, but dont want to watch it again right now" — so pressing
 * this writes a rating and nothing else. It does not begin a history row, it
 * does not put the title in Continue watching, and it does not mark it seen.
 * What it does is take the title out of the suggestions (a row answering
 * "you like this thing you told me you like" has answered nothing) and lean
 * the rest of the row toward or away from what it is made of.
 */
function ratingButtons(item) {
  const thumbs = el('div', 'film-thumbs');
  const key = resumeKeyFor(item);
  const shows = item.kind === 'series';
  const up = el('button', 'film-thumb is-up');
  up.type = 'button';
  up.textContent = 'Good';
  up.title = `Use this as an example of what you like. It won't be marked watched.`;
  const down = el('button', 'film-thumb is-down');
  down.type = 'button';
  down.textContent = 'Not for me';
  down.title = `Steer suggestions away from ${shows ? 'shows' : 'films'} like this.`;
  const paintThumbs = () => {
    const value = state.ratings[key] || 0;
    up.classList.toggle('on', value > 0);
    down.classList.toggle('on', value < 0);
  };
  const rate = async (wanted) => {
    const value = state.ratings[key] === wanted ? 0 : wanted;
    // Painted first. The box is on the other side of a Tailscale link and the
    // press has to land now, not when the round trip does.
    if (value) state.ratings[key] = value; else delete state.ratings[key];
    paintThumbs();
    await saveRating(key, value);
    /* A thumb is the strongest thing anybody says to this box, so For You is
       worked out again rather than waiting out its five minutes — the row for
       whichever half of the catalogue was just rated. */
    loadForYou({ force: true, tab: shows ? 'series' : 'movies' });
    /* Said out loud, because the whole worry this answers is that marking
       something as liked is the same as queueing it up. */
    toast(value > 0
      ? `Noted — more like this. Nothing was marked as watched.`
      : value < 0 ? 'Noted — and nothing like it either.'
        : 'Rating cleared.');
  };
  up.addEventListener('click', () => rate(1));
  down.addEventListener('click', () => rate(-1));
  paintThumbs();
  thumbs.append(up, down);
  return thumbs;
}

async function saveRating(key, value) {
  if (!profiles.current || !key) return;
  try {
    const res = await fetch(`/api/profiles/${profiles.current.id}/rating`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ratings) state.ratings = data.ratings;
  } catch (err) {
    console.warn('rating not saved', err);
  }
}

/**
 * Show the resume choice and settle on a start position. Resolves to the saved
 * seconds, or 0 to start from the top.
 */
function askResume(name, row) {
  return new Promise((resolve) => {
    const ask = $('#resumeAsk');
    $('#resumeTitle').textContent = name;
    $('#resumeMeta').textContent = row.duration
      ? `${hms(row.position)} of ${hms(row.duration)}`
      : `Stopped at ${hms(row.position)}`;
    $('#resumeFill').style.width = row.duration
      ? `${Math.min(100, (row.position / row.duration) * 100)}%`
      : '0%';
    $('#resumeGo').textContent = `Resume from ${hms(row.position)}`;
    ask.hidden = false;

    const finish = (value) => {
      ask.hidden = true;
      $('#resumeGo').onclick = null;
      $('#resumeRestart').onclick = null;
      resolve(value);
    };

    $('#resumeGo').onclick = () => finish(row.position);
    $('#resumeRestart').onclick = () => finish(0);
  });
}

/** Containers a browser opens directly. .mkv is the one that breaks iOS. */
const NATIVE_CONTAINERS = ['mp4', 'm4v', 'mov'];

/**
 * Is the box being asked to shrink everything before it crosses the link?
 *
 * Read at the moment each stream is resolved rather than captured once, so
 * turning it on mid-film applies to the very next thing that is asked for.
 */
const lowMode = () => prefs.data.lowBandwidth === true;

/**
 * The standing audio correction for this title, if one has been measured.
 *
 * Sent with every conversion of it from then on, so a seek that would have
 * repeated the fault comes back already corrected rather than being noticed
 * and rebuilt all over again.
 */
function delayParam() {
  return film.audioDelayMs ? { adelay: Math.round(film.audioDelayMs) } : {};
}

/** What every playback request carries when it is on, and nothing when not. */
const lowParam = () => (lowMode() ? { low: '1' } : {});

/** Last /api/remux response — carries the ffprobe duration fallback. */
let lastRemux = {};

/**
 * Has this title already been pulled to disk? If so it plays from there:
 * instantly, with no buffering, and without spending the provider's single
 * connection. Downloads record the same stream id the library uses.
 */
function findLocalCopy(kind, id) {
  const want = kind === 'series' ? 'series' : 'movie';
  return (state.downloads.items || []).find(
    (job) => job.status === 'done' && job.kind === want && String(job.streamId) === String(id)
  );
}

/** Play a completed download, remuxing off local disk if the container needs it. */
async function playLocalCopy(job, startAt = 0) {
  // A file already on the box still has to cross the Wi-Fi, and optimizing
  // it never made it smaller — only the container changed. On a weak link
  // it goes through a conversion like everything else, which is the whole
  // point: fewer bits over the air.
  if (lowMode()) {
    const remuxed = await api('/api/remux', {
      download: job.id,
      start: startAt || '',
      replaces: lastRemux.session || '',
      ...lowParam(),
    });
    lastRemux = remuxed;
    await waitForPrebuffer(remuxed);
    film.offset = remuxed.offset || 0;
    return { url: remuxed.url, format: 'm3u8', local: true };
  }
  if (needsRemux(job.ext)) {
    // The file is on disk but still in its original container, so it has to be
    // converted as it plays — the exact stop-start this feature exists to
    // avoid. Say so, rather than letting it look like a network problem.
    // No longer "fix it from Downloads": there is nothing to press. The box
    // is already converting this one, or shortly will be.
    toast('Still being optimized — playback may stall until that finishes.');
    const remuxed = await api('/api/remux', {
      download: job.id,
      start: startAt || '',
    });
    lastRemux = remuxed;
    await waitForPrebuffer(remuxed);
    film.offset = remuxed.offset || 0;
    return { url: remuxed.url, format: 'm3u8', local: true };
  }
  lastRemux = {};
  // Plays natively, so the file seeks itself once metadata is in.
  return { url: `/api/downloads/${job.id}/file`, format: 'file', local: true, seekTo: startAt };
}

function needsRemux(ext) {
  if (!ext) return false;
  return !NATIVE_CONTAINERS.includes(String(ext).toLowerCase());
}

async function resolveStream(item, override) {
  const startAt = Math.floor(override?.startAt || 0);

  /* A file on the archive drive. The server decides between serving the bytes
   * and running it through ffmpeg — the client only honours what comes back.
   * Direct play seeks itself. A conversion always runs the WHOLE file from
   * the top (the only arrangement these rips hold sync in), so a resume is a
   * wait for the conversion to pass the mark and then a player-side seek —
   * never a second conversion started at an offset. */
  if (item.archivePath) {
    const data = await api('/api/archive/play', {
      path: item.archivePath,
      profileId: profiles.current?.id || '',
      ...lowParam(),
    });

    if (data.mode === 'direct') {
      // The index's runtime rides along so the film bar has a length even
      // when the item was rebuilt from a history row that carries none.
      lastRemux = { sourceDuration: data.sourceDuration || 0 };
      return { url: data.url, format: 'file', seekTo: startAt };
    }

    lastRemux = data;
    film.offset = 0;
    if (startAt > 3) {
      await waitForConversionSpan(data, startAt);
      return { url: data.url, format: 'm3u8', seekTo: startAt };
    }
    await waitForPrebuffer(data);
    return { url: data.url, format: 'm3u8' };
  }

  if (item.directUrl) {
    const source = item.sourceUrl || '';
    const localExt = (source.split('.').pop() || '').toLowerCase();

    // A downloaded .mkv is just as unplayable as a streamed one. Remux it from
    // local disk, which is fast and costs no provider connection.
    if (item.localOnly && item.downloadId && needsRemux(localExt)) {
      const data = await api('/api/remux', {
        download: item.downloadId,
        ...lowParam(),
        });
      // Keep the response — sourceDuration is the scrubber's runtime, and
      // session is what marks this as remux-backed for seeking.
      lastRemux = data;
      await waitForPrebuffer(data);
      return { url: data.url, format: 'm3u8' };
    }

    const format = /\.m3u8(\?|$)/i.test(source)
      ? 'm3u8'
      : /\.ts(\?|$)/i.test(source)
        ? 'ts'
        : 'file';
    // A native local file honours a resume point by seeking itself.
    return { url: item.directUrl, format, seekTo: format === 'file' ? startAt : 0 };
  }
  const kind = override?.kind || (item.kind === 'movie' ? 'movie' : item.kind);
  const id = override?.id ?? item.id;
  const ext = override?.ext ?? item.ext ?? '';

  // Already on disk? Then never touch the provider for it.
  if (kind !== 'live') {
    const local = findLocalCopy(kind, id);
    if (local) return playLocalCopy(local, startAt);
  }
  // VOD arrives as .mkv from this provider, which no browser will open — send
  // it through the remuxer instead of handing the player a dead file.
  if (kind !== 'live' && needsRemux(ext)) {
    // Pass the codec when we have it — it decides TS vs fMP4 packaging and
    // saves the server an ffprobe round trip against the provider.
    const remuxed = await api('/api/remux', {
      kind,
      id,
      ext,
      vcodec: override?.vcodec || item.vcodec || '',
      start: startAt || '',
      // Whatever this player was showing before is finished with.
      replaces: lastRemux.session || '',
      ...lowParam(),
    });
    lastRemux = remuxed;
    await waitForPrebuffer(remuxed);
    film.offset = remuxed.offset || 0;
    return { url: remuxed.url, format: 'm3u8' };
  }

  const data = await api('/api/play', {
    kind,
    id,
    ext,
    ...lowParam(),
  });
  const format =
    kind === 'live' ? data.format : /^(m3u8|ts)$/.test(data.format) ? data.format : 'file';
  // dvr means the Pi's own live buffer is serving this channel, which earns a
  // deeper seat than the provider's short window could hold.
  return { url: data.url, format, dvr: Boolean(data.dvr) };
}

function updateFavButton(item) {
  $('#favBtn').classList.toggle('is-on', profiles.hasFav(item));
}

/**
 * Guards the long await chain in openPlayer (metadata fetch, then up to 45s of
 * prebuffer). Closing the player bumps the token, so a stale open resolves to
 * nothing instead of attaching a stream to a hidden overlay — which kept the
 * provider's single connection burning behind the user's back.
 */
let playToken = 0;

/**
 * Everything the player needs on screen before a source is resolved: the
 * overlay itself, the title, the buttons that belong to this title, and a
 * fresh token so anything still buffering for the last one gives up.
 *
 * Shared with the episode path, which comes in from a show's card rather than
 * through openPlayer and would otherwise have to keep its own copy of this in
 * step — an episode used to be picked from inside an already-open player, so
 * it never had to raise the overlay at all.
 */
function preparePlayer(item) {
  const myToken = ++playToken;
  $('#playerOverlay').hidden = false;
  // Whatever was queued up behind the last title is not what follows this one,
  // and the previous title's playback evidence is not about this one either.
  upNext.clear();
  playback.resetViewing();
  document.body.style.overflow = 'hidden';

  // Full screen from the first frame — the windowed shell used to flash up
  // for the whole buffering wait before cinema mode finally engaged.
  enterCinema(item);

  $('#playerTitle').textContent = item.name;
  $('#playerSub').textContent = '';
  $('#playerDetail').hidden = true;
  $('#playerDetail').innerHTML = '';
  updateFavButton(item);
  $('#favBtn').onclick = () => {
    const added = profiles.toggleFav(item);
    updateFavButton(item);
    toast(added ? 'Added to favorites.' : 'Removed from favorites.');
    if (state.tab === 'favorites') render();
  };

  // Live TV can't be downloaded, and neither can something already on disk.
  const downloadBtn = $('#downloadBtn');
  const downloadable = item.kind === 'movie' && !item.localOnly;
  downloadBtn.hidden = !downloadable && item.kind !== 'series';
  downloadBtn.onclick = downloadable ? () => requestDownload(item) : null;
  if (item.kind === 'series') {
    downloadBtn.title = 'Save the whole season to the box';
    downloadBtn.onclick = () => requestSeasonDownload();
  } else {
    downloadBtn.title = 'Save to the box';
  }
  // A film that is already on the box says so on the button itself; pressing
  // it explains rather than queueing a copy (requestDownload guards too).
  downloadBtn.classList.toggle('is-saved',
    downloadable && Boolean(downloadJobFor('movie', item.id)?.status === 'done'));
  if (downloadBtn.classList.contains('is-saved')) downloadBtn.title = 'Already downloaded';

  // Picture in picture, when this browser can do it at all. Decided per open
  // rather than once at startup for the same reason as the buttons above: the
  // answer belongs to the element, and the bar reserves width from what shows.
  $('#pipBtn').hidden = !pip.supported();
  pip.paint();
  reservePlayerActions();

  // A previous title's remux must not leak its duration into this one — that
  // put the wrong runtime on the scrubber for anything that plays natively.
  lastRemux = {};
  currentLiveItem = null;
  // Nor its subtitles. The last film's tracks left attached would show its
  // dialogue over this one, which is the worst kind of wrong.
  captions.reset();
  return myToken;
}

/**
 * Open something.
 *
 * `resume` is how the start position gets settled: 'ask' puts the resume
 * choice up, which is right when the press carried no opinion — a poster, a
 * search hit, a history row. A film's own page has already asked, out loud,
 * with two buttons on it; 'resume' and 'restart' are those two buttons saying
 * so, and putting the modal up on top of them would be the same question
 * twice. Anything that does not pass one gets the modal, as before.
 */
async function openPlayer(item, { resume = 'ask' } = {}) {
  // A show is browsed on its own card now, not inside the player. Anything
  // still asking the player to open one — an old bookmark, a stale history
  // row — is sent there rather than left looking at an empty picture.
  if (item.kind === 'series') return openSeries(item);

  const myToken = preparePlayer(item);

  currentLiveItem = item.kind === 'live' ? item : null;

  // Know what's on disk before deciding how to play it. Live never has a
  // local copy, so don't spend a round trip on it before tuning the channel.
  if (item.kind !== 'live') await refreshDownloads();
  const localCopy = item.kind === 'live' || item.localOnly ? null : findLocalCopy(item.kind, item.id);

  // Pick up where this profile left off, if it did. Asked before anything is
  // fetched so a resume starts the conversion at the right point rather than
  // converting from zero and then jumping.
  let startAt = 0;
  if (item.kind === 'movie' && (!item.localOnly || item.resumeKey) && resume !== 'restart') {
    const saved = await fetchProgress(resumeKeyFor(item));
    if (saved) {
      if (myToken !== playToken) return;
      startAt = resume === 'resume' ? saved.position : await askResume(item.name, saved);
      if (myToken !== playToken) return;
    }
  }

  // Ask for the details while the provider connection is still free — once
  // ffmpeg is streaming, this call comes back empty. Skipped for a local copy:
  // a downloaded film should play with the provider entirely out of the loop.
  let vodInfo = null;
  if (item.kind === 'movie' && !item.localOnly && !localCopy && state.config.mode === 'xtream') {
    // The film's own page has usually just asked for this, and asking again
    // spends the provider's one connection on an answer already in hand.
    if (state.vodCache[item.id] !== undefined) {
      vodInfo = state.vodCache[item.id];
    } else {
      loader.show('Fetching film details…');
      vodInfo = await fetchVodInfo(item);
      state.vodCache[item.id] = vodInfo;
    }
  }

  try {
    if (localCopy) {
      status('Playing your downloaded copy…');
    } else if (item.kind !== 'live' && needsRemux(item.ext || (item.sourceUrl || '').split('.').pop())) {
      status('Converting for playback — this takes a few seconds…');
    } else if (item.kind === 'live') {
      // The answer can take a few seconds while the Pi opens its live buffer
      // for this channel. A blank player is indistinguishable from a broken
      // one, which a measured session spent 15 silent seconds proving.
      status('Tuning in — preparing the channel…');
    }
    const { url, format, seekTo, dvr } = await resolveStream(item, { startAt });
    if (myToken !== playToken) return; // player closed while we were buffering
    attach(url, format, { seekTo, dvr });
    if (item.kind === 'live') {
      stopLeadWatch();
      hideFilmBar();
    } else {
      startLeadWatch();
      // Films get the real-runtime scrubber; a local file already has a
      // correct duration of its own, so the native controls are fine there.
      if (item.kind === 'movie') {
        // Provider metadata first, ffprobe's reading of the source second.
        // Local files get it too — the probe runs against the file on disk,
        // so the runtime is there without touching the provider.
        // item.duration is the archive index's own reading, which is the only
        // runtime available when a drive file plays directly — there is no
        // remux session to report one and no provider metadata to ask.
        const runtime = parseRuntime(vodInfo) || lastRemux.sourceDuration || item.duration || 0;
        showFilmBar(item, runtime);
        applyVodInfo(vodInfo);
        if (item.archivePath) {
          $('#cinemaSub').textContent =
            item.archiveMode === 'transcode'
              ? 'Playing from the archive drive — converting as it plays'
              : 'Playing from the archive drive';
        } else if (localCopy || item.localOnly) {
          $('#cinemaSub').textContent = 'Playing from your downloads';
        }
      }
    }
    if (item.kind === 'live') startLiveTracking();
    else stopLiveTracking();
    // Watching offline still counts — it's the same title, and the position
    // is keyed the same way, so the two routes share one resume point.
    if (!item.localOnly || item.resumeKey) beginHistory(item);
  } catch (err) {
    status(`Couldn't start playback: ${err.message}`);
  } finally {
    loader.hide();
  }

  if (item.kind === 'live' && state.config.mode === 'xtream') renderEpg(item);
}

async function renderEpg(item) {
  try {
    const data = await api('/api/xtream', {
      action: 'get_short_epg',
      stream_id: item.id,
      limit: 8,
    });
    const listings = data.epg_listings || [];
    if (!listings.length) return;

    const detail = $('#playerDetail');
    detail.innerHTML = '';
    const heading = el('h3');
    heading.textContent = 'Up next';
    detail.append(heading);

    const now = Date.now() / 1000;
    listings.forEach((listing) => {
      const row = el('div', 'epg-row');
      const start = Number(listing.start_timestamp);
      const stop = Number(listing.stop_timestamp);
      if (start <= now && now < stop) row.classList.add('is-now');
      const time = el('div', 'epg-time');
      time.textContent = `${clockFromTimestamp(start)} – ${clockFromTimestamp(stop)}`;
      const title = el('div', 'epg-title');
      title.textContent = listing.title || 'No listing';
      row.append(time, title);
      detail.append(row);
    });

    const current = listings.find(
      (l) => Number(l.start_timestamp) <= now && now < Number(l.stop_timestamp)
    );
    if (current) {
      $('#playerSub').textContent = `Now: ${current.title}`;
      $('#cinemaSub').textContent = `Now: ${current.title}`;
    }
    detail.hidden = false;
  } catch {
    /* EPG is a nicety, not a requirement */
  }
}

/**
 * Pull a film's details. Must happen BEFORE the remux starts: this provider
 * allows one connection, and while ffmpeg is streaming it answers metadata
 * calls with `{"error":""}`. Asking first is the only reliable order.
 */
async function fetchVodInfo(item) {
  try {
    const data = await api('/api/xtream', { action: 'get_vod_info', vod_id: item.id });
    return data && data.info ? data.info : null;
  } catch {
    return null;
  }
}

/**
 * How many bytes a title is, from whatever the provider bothered to say.
 *
 * Panels are inconsistent about this: some give a `size` outright, in bytes
 * and sometimes as a string; most give only a bitrate, in kilobits, next to
 * a duration. Bitrate times runtime is not the file size to the byte, but it
 * is the right order of magnitude and it is the number somebody is actually
 * asking for — whether this will fit, and how long it will take.
 *
 * Returns 0 when there is nothing to go on, which reads as "no size shown"
 * rather than a confident zero.
 */
function mediaBytes(info) {
  if (!info) return 0;
  const stated = Number(info.size ?? info.filesize ?? info.file_size);
  if (Number.isFinite(stated) && stated > 1024) return stated;

  const kbps = Number(info.bitrate);
  const secs = Number(info.duration_secs) || hmsToSeconds(info.duration);
  if (kbps > 0 && secs > 0) return (kbps * 1000 * secs) / 8;
  return 0;
}

/** An episode's size, which panels hang off the episode or its info block. */
const episodeBytes = (episode) => mediaBytes(episode?.info) || mediaBytes(episode);

/** "01:53:20" to seconds. Returns 0 for anything that is not that. */
function hmsToSeconds(text) {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function applyVodInfo(info) {
  if (!info) return;
  const bits = [info.releasedate, info.genre, info.duration].filter(Boolean);
  if (bits.length) {
    $('#playerSub').textContent = bits.join(' · ');
    $('#cinemaSub').textContent = bits.join(' · ');
  }
  if (!info.plot) return;

  const detail = $('#playerDetail');
  detail.innerHTML = '';
  const heading = el('h3');
  heading.textContent = 'Synopsis';
  const plot = el('p');
  plot.textContent = info.plot;
  detail.append(heading, plot);
  detail.hidden = false;
}


/**
 * The seasons bar and episode list for one show, mounted wherever it is asked
 * for.
 *
 * This used to render straight into the player's detail pane, because picking
 * an episode happened inside the player. It now belongs to the show's own card
 * instead, so the mount is a parameter and everything player-shaped is left to
 * the caller.
 */
async function renderSeries(item, mount, onInfo) {
  mount.innerHTML = '';
  const loading = el('p', 'show-note');
  loading.textContent = 'Loading episodes…';
  mount.append(loading);

  // Claimed up front and cleared immediately: a request that cannot be met
  // must not sit in the state waiting to fire at the next show someone opens.
  const resume = state.resumeEpisode
    && String(state.resumeEpisode.seriesId) === String(item.id)
    ? state.resumeEpisode
    : null;
  if (resume) state.resumeEpisode = null;
  /** Nothing to resume into — take the empty player back off the page. */
  const giveUp = (why) => {
    if (!resume) return;
    closePlayer();
    toast(why);
  };

  let data = state.seriesCache[item.id];
  if (!data) {
    try {
      data = await api('/api/xtream', { action: 'get_series_info', series_id: item.id });
      state.seriesCache[item.id] = data;
    } catch (err) {
      mount.innerHTML = '';
      const note = el('p', 'show-note');
      note.textContent = `Couldn't load episodes: ${err.message}`;
      mount.append(note);
      return giveUp(`Couldn't load episodes: ${err.message}`);
    }
  }

  const episodes = data.episodes || {};
  const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
  if (!seasons.length) {
    mount.innerHTML = '';
    const note = el('p', 'show-note');
    note.textContent = 'No episodes listed for this series.';
    mount.append(note);
    return giveUp('No episodes listed for this series.');
  }

  onInfo?.(data.info || {});

  mount.innerHTML = '';
  const picker = el('div', 'season-picker');
  const list = el('div', 'ep-list');
  mount.append(picker, list);

  /** What follows an episode, rolling into the next season at the end of one. */
  const episodeAfter = (season, index) => {
    const here = episodes[season] || [];
    if (index + 1 < here.length) return { season, index: index + 1, episode: here[index + 1] };
    const later = seasons[seasons.indexOf(season) + 1];
    const there = later ? episodes[later] || [] : [];
    return there.length ? { season: later, index: 0, episode: there[0] } : null;
  };

  const episodeLabel = (season, episode) =>
    `S${season} · E${episode.episode_num} — ${episode.title || `Episode ${episode.episode_num}`}`;

  // Where you left the show. The newest history row for this series names
  // the exact episode, so the card can say so out loud instead of making
  // you reconstruct it from the home screen: a strip up top with a Resume
  // button, the list opening on that season, and the episode row itself
  // wearing a mark.
  const lastRow = (state.recentlyWatched || []).find(
    (r) => r.kind === 'series'
      && String(r.seriesId ?? r.id) === String(item.id)
      && r.season != null && r.episode != null
  );
  let lastMark = null;   // { season, episode } — what showSeason points out
  if (lastRow) {
    const season = String(lastRow.season);
    const eps = episodes[season] || [];
    const index = eps.findIndex((ep) => Number(ep.episode_num) === Number(lastRow.episode));
    if (index >= 0) {
      lastMark = { season, episode: Number(lastRow.episode) };
      const finished = Boolean(lastRow.completed)
        || (lastRow.duration && lastRow.position
          && lastRow.position / lastRow.duration > RESUME_MAX_RATIO);

      const strip = el('div', 'last-watched');
      const words = el('div', 'last-watched-words');
      const label = el('span', 'last-watched-label');
      label.textContent = finished ? 'Last watched' : 'You are on';
      const title = el('span', 'last-watched-title');
      title.textContent = episodeLabel(season, eps[index]);
      words.append(label, title);
      const note = el('span', 'last-watched-note');
      if (finished) note.textContent = 'Finished';
      else if (lastRow.duration && lastRow.position) {
        note.textContent = `${hms(Math.max(0, Math.round(lastRow.duration - lastRow.position)))} left`;
      }
      if (note.textContent) words.append(note);

      const go = el('button', 'btn btn-primary btn-sm last-watched-go');
      go.textContent = finished ? 'Play the next one' : 'Resume';
      go.addEventListener('click', () => {
        if (finished) {
          const after = episodeAfter(season, index);
          if (after) return startEpisode(after.season, after.index);
        }
        startEpisode(season, index);
      });

      strip.append(words, go);
      mount.insertBefore(strip, picker);
    }
  }

  /**
   * Play one episode of the open series. A named function rather than the
   * click handler it used to be, because the up-next button has to start an
   * episode nobody clicked on — including the first of the following season.
   */
  const startEpisode = async (season, index) => {
    const episode = (episodes[season] || [])[index];
    if (!episode) return;

    // Raise the player before anything is fetched. This used to be picking an
    // episode from inside an already-open player, so nothing here opened it —
    // the episode played into a hidden overlay, correctly and invisibly.
    const myToken = preparePlayer(item);

    // Offer to pick up where this episode was left, before converting.
    let startAt = 0;
    const saved = await fetchProgress(resumeKeyFor(item, episode, season));
    if (saved) {
      if (myToken !== playToken) return;
      startAt = await askResume(`${item.name} — S${season}E${episode.episode_num}`, saved);
      if (myToken !== playToken) return;
    }

    // Following on into another season leaves the wrong list on screen, so
    // switch it before marking a row as playing.
    if (!currentSeason || currentSeason.season !== season) showSeason(season);
    const rows = [...list.querySelectorAll('.ep')];
    rows.forEach((r) => r.classList.remove('is-playing'));
    rows[index]?.classList.add('is-playing');

    const sub = episodeLabel(season, episode);
    $('#playerSub').textContent = sub;
    $('#cinemaSub').textContent = sub;

    const override = {
      kind: 'series',
      id: episode.id,
      ext: episode.container_extension || 'mp4',
      vcodec: episode.info?.video?.codec_name || '',
    };
    try {
      const { url, format, seekTo } = await resolveStream(item, { ...override, startAt });
      if (myToken !== playToken) return;
      attach(url, format, { seekTo });
      showFilmBar(item, parseRuntime(episode.info), override);
      // After showFilmBar — enterCinema clears the subtitle line.
      $('#cinemaSub').textContent = sub;
      startLeadWatch();
      beginHistory(item, {
        key: `series:${item.id}:s${season}e${episode.episode_num}`,
        name: `${item.name} — S${season}E${episode.episode_num}`,
        seriesId: item.id,
        season: Number(season),
        episode: Number(episode.episode_num),
      });
      // Armed only once this episode is really playing. Arming earlier would
      // leave an offer up after a start that failed.
      const after = episodeAfter(season, index);
      upNext.arm(after && {
        label: episodeLabel(after.season, after.episode),
        start: () => startEpisode(after.season, after.index),
      });
    } catch (err) {
      status(`Couldn't start episode: ${err.message}`);
    }
  };

  const showSeason = (season) => {
    // Remembered so the header download button knows which season to take.
    currentSeason = { item, season, episodes: episodes[season] || [] };
    picker.querySelectorAll('.season-chip').forEach((chip) => {
      chip.classList.toggle('is-active', chip.dataset.season === season);
    });
    list.innerHTML = '';
    (episodes[season] || []).forEach((episode, index) => {
      const row = el('div', 'ep');
      const num = el('span', 'ep-num');
      num.textContent = String(episode.episode_num).padStart(2, '0');
      const name = el('span', 'ep-name');
      name.textContent = episode.title || `Episode ${episode.episode_num}`;
      if (lastMark && lastMark.season === season
          && Number(episode.episode_num) === lastMark.episode) {
        row.classList.add('is-last');
        const mark = el('span', 'ep-last');
        mark.textContent = 'Last watched';
        name.append(mark);
      }

      // How big this one is, from whatever the provider chose to say. Sat
      // beside the download button because that is the only moment the
      // number matters — it is the difference between pressing it and not.
      const bytes = episodeBytes(episode);
      const size = el('span', 'ep-size');
      size.textContent = bytes ? formatBytes(bytes) : '';

      const grab = el('button', 'ep-dl');
      // Say what is already true before it is asked for again: a saved
      // episode shows a check, one on its way shows so, and pressing either
      // explains instead of queueing a second copy.
      const have = downloadJobFor('series', episode.id);
      if (have && have.status === 'done') {
        grab.classList.add('is-saved');
        grab.title = 'Already downloaded';
        grab.setAttribute('aria-label', 'Already downloaded');
        grab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-10"/></svg>';
      } else if (have) {
        grab.classList.add('is-queued');
        grab.title = 'Already in the download queue';
        grab.setAttribute('aria-label', 'Already in the download queue');
        grab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>';
      } else {
        grab.title = 'Download this episode';
        grab.setAttribute('aria-label', 'Download this episode');
        grab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>';
      }
      grab.addEventListener('click', async (event) => {
        event.stopPropagation();
        const done = await requestDownload(item, { ...episode, season });
        // Repaint so the row's mark reflects what just happened.
        if (done.ok) showSeason(season);
      });

      row.append(num, name, size, grab);
      row.addEventListener('click', () => startEpisode(season, index));
      list.append(row);
    });
  };

  seasons.forEach((season) => {
    const chip = el('button', 'season-chip');
    chip.dataset.season = season;
    chip.textContent = `Season ${season}`;
    chip.addEventListener('click', () => showSeason(season));
    picker.append(chip);
  });

  // The whole open season, one press. requestSeasonDownload reads
  // currentSeason, skips anything already saved or queued, and asks before
  // committing the Pi to twenty episodes.
  const seasonDl = el('button', 'season-chip season-dl');
  seasonDl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>'
    + '<span>Download season</span>';
  seasonDl.title = 'Save every episode of the open season to the box';
  seasonDl.addEventListener('click', async () => {
    await requestSeasonDownload();
    // Repaint the rows so fresh queue marks show without leaving the page.
    if (currentSeason) showSeason(currentSeason.season);
  });
  picker.append(seasonDl);

  // Open on the season you are actually in, when the show knows it.
  showSeason(lastMark ? lastMark.season : seasons[0]);

  // The Continue watching hand-off. It has to be here, at the bottom of the
  // one function that has both the episode list and the machinery to play
  // from it — resume prompt, next-episode arming, the playing row — none of
  // which is worth duplicating for one entry point.
  if (resume) {
    const list = episodes[resume.season] || [];
    const index = list.findIndex((ep) => Number(ep.episode_num) === Number(resume.episode));
    if (index >= 0) return startEpisode(resume.season, index);
    // The provider has stopped listing it. The show's page is right here and
    // already drawn, so drop onto that rather than an error.
    giveUp(`S${resume.season}E${resume.episode} is no longer listed — here is the show.`);
  }
}

function closePlayer() {
  playToken += 1; // cancel any open/episode pick still awaiting its stream
  // The floating window shows the stream this close is about to tear down, so
  // it goes too. Both dialects, same as the button.
  if (pip.active()) {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else $('#video').webkitSetPresentationMode?.('inline');
  }
  upNext.clear();
  endHistory();
  hideFilmBar();
  exitCinema();
  stopLeadWatch();
  recovering = false;
  activeRemux = null;
  teardown();
  stopLiveTracking();
  currentLiveItem = null;
  status('');
  // Stop any remux so ffmpeg isn't holding the single provider connection.
  fetch('/api/remux/stop', { method: 'GET' }).catch(() => {});
  $('#playerOverlay').hidden = true;
  document.body.style.overflow = '';
}

$('#playerClose').addEventListener('click', closePlayer);
$('#playerOverlay').addEventListener('click', (event) => {
  if (event.target === $('#playerOverlay')) closePlayer();
});
document.addEventListener('keydown', (event) => {
  // Providers sits on top of health, so it is the one Escape closes first.
  if (event.key === 'Escape' && !$('#providerModal').hidden) return providerPanel.close();
  if (event.key === 'Escape' && !$('#progModal').hidden) return programmePanel.close();
  if (event.key === 'Escape' && !$('#seedModal').hidden) return seedPicker.close();
  if (event.key === 'Escape' && !$('#healthModal').hidden) return health.close();
  if (event.key === 'Escape' && !$('#deviceModal').hidden) {
    $('#deviceModal').hidden = true;
    return;
  }
  if (event.key === 'Escape' && !$('#playerOverlay').hidden) closePlayer();
  // The picker sits over multi-view, so it goes first.
  if (event.key === 'Escape' && !$('#mvPicker').hidden) {
    $('#mvPicker').hidden = true;
    return;
  }
  // Backing out of a blown-up cell returns to the grid. Only the second
  // Escape leaves multi-view — otherwise pressing it once to shrink a cell
  // would take the whole screen down with it.
  if (event.key === 'Escape' && multiview.solo >= 0) {
    multiview.unexpand();
    return;
  }
  if (event.key === 'Escape' && !$('#multiview').hidden) multiview.close();
});

/* --------------------------------------------------------------- chrome */

$('#loadMore').addEventListener('click', () => {
  state.visible += PAGE_SIZE;
  render();
});

/**
 * The weak-Wi-Fi switch.
 *
 * Takes effect on the next thing that is played rather than reaching into
 * what is already running: a stream mid-flight would have to be torn down
 * and rebuilt from a fresh conversion, and doing that to a film somebody is
 * watching, without being asked, is worse than the stall it is trying to
 * fix. Saying so plainly is better than a switch that appears to do nothing.
 */
$('#lowMode').addEventListener('change', async (event) => {
  prefs.data.lowBandwidth = event.target.checked;
  await prefs.save();
  const playing = !$('#playerOverlay').hidden;
  const note = $('#lowModeNote');
  note.hidden = false;
  note.textContent = event.target.checked
    ? (playing
      ? 'On. Reopen what you are watching to shrink it — everything you start from now on is already small.'
      : 'On. Everything the box sends from now on is shrunk to fit a weak connection.')
    : 'Off. Full quality again — best on a good connection.';
  toast(event.target.checked
    ? 'Low bandwidth mode on.'
    : 'Low bandwidth mode off.');
});

$('#filterToggle').addEventListener('change', async (event) => {
  prefs.data.filtersEnabled = event.target.checked;
  await prefs.save();
  // The server caches per filter setting, so the unfiltered fetch is slow the
  // first time on a library this size.
  state.library = { live: null, movies: null, series: null };
  toast(
    event.target.checked
      ? 'Showing English/US categories only.'
      : 'Showing every category — the full library takes a while to load.'
  );
  await goTo(state.tab);
});

let catSearchTimer;
$('#catSearch').addEventListener('input', (event) => {
  clearTimeout(catSearchTimer);
  const value = event.target.value.trim();
  catSearchTimer = setTimeout(() => {
    state.catQuery = value;
    render();
  }, 140);
});

let searchTimer;
$('#searchInput').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value.trim();
  searchTimer = setTimeout(async () => {
    // The archive is indexed server-side, so its search is a request rather
    // than a filter over an already-loaded page. Clearing the box returns to
    // whatever folder was being browsed.
    if (state.tab === 'archive') {
      try {
        if (value.length >= 2) await searchArchive(value);
        else await loadArchive(state.archive.dir);
      } catch (err) {
        toast(err.message);
        return;
      }
      return renderArchive();
    }
    state.query = value;
    state.visible = PAGE_SIZE;
    render();
  }, 180);
});

$('#navToggle').addEventListener('click', () => $('#mainNav').classList.toggle('is-open'));
$('#catToggle').addEventListener('click', () => $('#sidebar').classList.add('is-open'));
$('#sidebarClose').addEventListener('click', () => $('#sidebar').classList.remove('is-open'));
document.querySelectorAll('.nav a').forEach((a) =>
  a.addEventListener('click', () => $('#mainNav').classList.remove('is-open'))
);

/* ------------------------------------------------------- profile gate UI */

let managing = false;
let editingProfile = null;

function renderProfileGate() {
  const grid = $('#profileGrid');
  grid.innerHTML = '';

  /* Its place in the queue, which is what staggers the arrival — see the
     profiles section of styles.css. Set on every tile including Add, so the
     row fills left to right and nothing lands out of order. */
  let seat = 0;

  for (const profile of profiles.all) {
    const tile = el('button', 'profile-tile');
    tile.style.setProperty('--i', seat++);
    const avatar = el('span', 'profile-avatar');
    avatar.textContent = profile.emoji;
    avatar.style.background = profile.color;
    const name = el('span', 'profile-name');
    name.textContent = profile.name;
    tile.append(avatar, name);
    tile.addEventListener('click', async () => {
      if (managing) return openProfileModal(profile);
      await profiles.select(profile);
      $('#profileGate').hidden = true;
      await startApp();
    });
    grid.append(tile);
  }

  const add = el('button', 'profile-tile profile-add');
  add.style.setProperty('--i', seat);
  const plus = el('span', 'profile-avatar');
  plus.textContent = '+';
  const addLabel = el('span', 'profile-name');
  addLabel.textContent = 'Add profile';
  add.append(plus, addLabel);
  add.addEventListener('click', () => openProfileModal(null));
  grid.append(add);

  $('#manageBtn').hidden = profiles.all.length === 0;
  $('#manageBtn').textContent = managing ? 'Done' : 'Manage profiles';
  $('#profileGate').classList.toggle('is-managing', managing);

  const lock = $('#lockBtn');
  lock.hidden = !managing;
  lock.textContent = profiles.locked
    ? 'Profile lock is on — a password is needed to add or remove one'
    : 'Profile lock is off — anyone can add or remove a profile';
}

/**
 * Turning the lock on or off, which needs the password either way.
 *
 * On→off obviously does. Off→on does too, or anyone could lock everyone else
 * out of a switch they had no way to flip back.
 */
$('#lockBtn').addEventListener('click', async () => {
  const wanted = !profiles.locked;
  const password = prompt(
    (wanted
      ? 'Turn the profile lock ON? Adding or deleting a profile will need the password.'
      : 'Turn the profile lock OFF? Anyone will be able to add or delete a profile.')
    + '\n\nEnter the profile password:'
  );
  if (password === null) return;

  try {
    const res = await fetch('/api/profiles/lock', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locked: wanted, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not change the lock.');
    profiles.locked = data.locked;
    renderProfileGate();
    toast(profiles.locked ? 'Profile lock on.' : 'Profile lock off.');
  } catch (err) {
    alert(err.message);
  }
});

/*
 * How long the opening runs for. The last thing to move is the Manage button
 * at 1.7s + 0.7s; a little past that the class comes off, so pressing Manage
 * profiles re-renders the tiles without replaying the lamp.
 */
const GATE_ARRIVAL_MS = 2600;
let gateArrival = null;

function showProfileGate() {
  $('#setupView').hidden = true;
  $('#siteHeader').hidden = true;
  $('#appView').hidden = true;
  const gate = $('#profileGate');
  gate.hidden = false;
  gate.classList.add('is-arriving');
  clearTimeout(gateArrival);
  gateArrival = setTimeout(() => gate.classList.remove('is-arriving'), GATE_ARRIVAL_MS);
  renderProfileGate();
}

$('#manageBtn').addEventListener('click', () => {
  managing = !managing;
  renderProfileGate();
});

$('#profileChip').addEventListener('click', () => {
  managing = false;
  showProfileGate();
});

/* ---- add / edit modal ---- */

function buildPickers(selectedEmoji, selectedColor) {
  const emojiWrap = $('#emojiPicker');
  const colorWrap = $('#colorPicker');
  emojiWrap.innerHTML = '';
  colorWrap.innerHTML = '';

  let emoji = selectedEmoji;
  let color = selectedColor;

  for (const choice of AVATARS) {
    const btn = el('button');
    btn.type = 'button';
    btn.textContent = choice;
    btn.classList.toggle('is-on', choice === emoji);
    btn.addEventListener('click', () => {
      emoji = choice;
      emojiWrap.querySelectorAll('button').forEach((b) => b.classList.remove('is-on'));
      btn.classList.add('is-on');
    });
    emojiWrap.append(btn);
  }

  for (const choice of SWATCHES) {
    const btn = el('button');
    btn.type = 'button';
    btn.style.background = choice;
    btn.classList.toggle('is-on', choice === color);
    btn.addEventListener('click', () => {
      color = choice;
      colorWrap.querySelectorAll('button').forEach((b) => b.classList.remove('is-on'));
      btn.classList.add('is-on');
    });
    colorWrap.append(btn);
  }

  return {
    emoji: () => emoji,
    color: () => color,
  };
}

let pickers = null;

function openProfileModal(profile) {
  editingProfile = profile;
  const form = $('#profileForm');
  form.reset();
  $('#profileError').hidden = true;

  $('#profileModalTitle').textContent = profile ? 'Edit profile' : 'Add a profile';
  $('#profileSubmit').textContent = profile ? 'Save' : 'Create profile';
  form.elements.name.value = profile ? profile.name : '';
  // Editing name and icon is always open. Creating asks for the password only
  // when the lock has been turned on, which by default it has not.
  $('#passwordField').hidden = Boolean(profile) || !profiles.locked;
  $('#profileDelete').hidden = !profile;

  pickers = buildPickers(profile ? profile.emoji : AVATARS[0], profile ? profile.color : SWATCHES[0]);
  $('#profileModal').hidden = false;
  form.elements.name.focus();
}

function closeProfileModal() {
  $('#profileModal').hidden = true;
  editingProfile = null;
}

$('#profileCancel').addEventListener('click', closeProfileModal);
$('#profileModal').addEventListener('click', (event) => {
  if (event.target === $('#profileModal')) closeProfileModal();
});

$('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const error = $('#profileError');
  const submit = $('#profileSubmit');
  error.hidden = true;
  submit.disabled = true;

  const body = {
    name: form.elements.name.value.trim(),
    emoji: pickers.emoji(),
    color: pickers.color(),
  };

  try {
    let res;
    if (editingProfile) {
      res = await fetch(`/api/profiles/${editingProfile.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      if (profiles.locked) body.password = form.elements.password.value;
      res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save that profile.');

    closeProfileModal();
    await profiles.load();
    // Re-selecting keeps the header chip in step with a rename or new icon.
    if (profiles.current) {
      const refreshed = profiles.all.find((p) => p.id === profiles.current.id);
      if (refreshed) await profiles.select(refreshed, { silent: true });
    }
    renderProfileGate();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

$('#profileDelete').addEventListener('click', async () => {
  if (!editingProfile) return;
  const warning =
    `Delete “${editingProfile.name}”? This removes its favorites and watch history.`;
  // With the lock off this is one confirmation rather than a password. It is
  // still a confirmation: the history it takes with it does not come back.
  let password = '';
  if (profiles.locked) {
    password = prompt(`${warning}\n\nEnter the profile password:`);
    if (password === null) return;
  } else if (!confirm(warning)) {
    return;
  }

  try {
    const res = await fetch(`/api/profiles/${editingProfile.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete that profile.');

    if (profiles.current && profiles.current.id === editingProfile.id) {
      profiles.current = null;
      localStorage.removeItem('portal.profile');
      $('#profileChip').hidden = true;
    }
    closeProfileModal();
    await profiles.load();
    renderProfileGate();
    toast('Profile deleted.');
  } catch (err) {
    alert(err.message);
  }
});

/* ------------------------------------------------------- watch history --

 * Every play is reported against the active profile. This is the raw signal
 * the personalization layer reads back through /api/profiles/:id/taste, so
 * it records what was watched, how far, and in which category.
 */

let historyTarget = null;
let historyTimer = null;

function beginHistory(item, extra = {}) {
  if (!profiles.current) return;
  const source = state.library[item.kind === 'movie' ? 'movies' : item.kind] || {};
  const category = (source.categories || []).find(
    (c) => String(c.id) === String(item.categoryId)
  );

  historyTarget = {
    key: extra.key || resumeKeyFor(item),
    kind: item.kind,
    id: item.id,
    name: extra.name || item.name,
    categoryId: item.categoryId || '',
    categoryName: category ? category.name : '',
    poster: item.logo || '',
    seriesId: extra.seriesId,
    season: extra.season,
    episode: extra.episode,
    newPlay: true,
  };

  reportHistory();
  clearInterval(historyTimer);
  historyTimer = setInterval(reportHistory, 15000);
}

function reportHistory() {
  if (!historyTarget || !profiles.current) return;
  const video = $('#video');
  const isLive = historyTarget.kind === 'live';
  // After a seek the video element restarts at zero, so record where we are in
  // the film — otherwise resume points would be wrong for anything scrubbed.
  const position = Math.floor(film.active ? filmPosition() : video.currentTime || 0);

  // A live stream reports the length of its buffered window as `duration`
  // (often just seconds), which would make a channel look finished the moment
  // you watched past it. Live is explicitly durationless and never complete.
  // Prefer the provider's real runtime; the remux only knows its own progress.
  const duration = isLive
    ? 0
    : film.active && film.duration
      ? Math.floor(film.duration)
      : Number.isFinite(video.duration)
        ? Math.floor(video.duration)
        : 0;

  const payload = {
    ...historyTarget,
    position,
    duration,
    completed: !isLive && duration > 0 && position / duration > 0.95,
  };
  historyTarget.newPlay = false;

  navigator.sendBeacon?.(
    `/api/profiles/${profiles.current.id}/history`,
    new Blob([JSON.stringify(payload)], { type: 'application/json' })
  );
}

function endHistory() {
  reportHistory();
  clearInterval(historyTimer);
  historyTimer = null;
  historyTarget = null;
}

window.addEventListener('pagehide', () => reportHistory());

/* ------------------------------------------------------------------ boot */

async function startApp() {
  $('#setupView').hidden = true;
  $('#siteHeader').hidden = false;
  $('#appView').hidden = false;
  $('#profileGate').hidden = true;
  $('#filterToggle').checked = prefs.data.filtersEnabled !== false;
  $('#lowMode').checked = prefs.data.lowBandwidth === true;
  await refreshDownloads();
  await applyRoute();

  // After the first page has drawn, or the tour would be pointing at things
  // that are not there yet.
  reporter.applyButtons();
  if (profiles.current && profiles.data && !profiles.data.tourDone) {
    // A new profile gets the report button explained by the tour, pointing at
    // it. Nothing else to say afterwards, so the notice is marked seen rather
    // than queued up behind it.
    if (profiles.current) {
      profiles.data.reportNoticeSeen = true;
      profiles.save();
    }
    tour.start();
  } else {
    // Everyone who was already here. The button changed under them.
    notice.maybeShow();
  }

  // Keep the progress bars and the nav badge honest while anything is running.
  setInterval(() => {
    const busy =
      state.downloads.active ||
      (state.downloads.items || []).some((j) => j.status === 'downloading' || j.status === 'queued');
    if (busy || state.tab === 'downloads') refreshDownloads({ rerender: true });
  }, 2000);
}

(async function boot() {
  // Before anything renders, so controls are the right size on first paint.
  device.init();
  applyMultiviewButton();
  applyListingsButton();
  applyWideSearchButton();
  try {
    const config = await api('/api/config');
    if (!config.configured) return showSetup();
    state.config = config;
    await prefs.load();
    await profiles.load();
    // No profile picked on this device yet — ask before showing the library.
    if (!profiles.current) return showProfileGate();
    await startApp();
  } catch (err) {
    showSetup();
    toast(`Startup problem: ${err.message}`);
  }
})();
