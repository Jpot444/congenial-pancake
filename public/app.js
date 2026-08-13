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
const VERSION = '13.5';

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
  /** Per-tab cache: { categories: [], items: [] } */
  library: { live: null, movies: null, series: null },
  visible: PAGE_SIZE,
  filtered: [],
  downloads: { items: [], active: null, queued: 0 },
  recentlyWatched: [],
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
    liveLatency: 'balanced',
    filtersEnabled: true,
    filters: {},
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
  data: { favorites: [], pinnedCategories: [] },

  async load() {
    const res = await api('/api/profiles');
    this.all = res.profiles || [];
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

/* ----------------------------------------------------------- this device

 * A phone and a desktop are far enough apart to be two layouts rather than one
 * that stretches between them. Phone gets the sections as a bottom bar and a
 * fixed number of posters to a row; desktop keeps the hamburger and fits as
 * many as there is room for.
 *
 * Kept per-device in localStorage rather than in the profile: the same profile
 * is used from both, and only one of them wants any of this.
 */

const device = {
  phone: false,
  cols: 2,

  init() {
    const saved = localStorage.getItem('portal.touch');
    // No stored choice? Take the hint from the hardware — a coarse pointer
    // means a finger, which is every iPhone and iPad.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    this.phone = saved === null ? Boolean(coarse) : saved === '1';

    const cols = Number(localStorage.getItem('portal.cols'));
    this.cols = [2, 3, 4].includes(cols) ? cols : 2;
    this.apply();
  },

  apply() {
    const root = document.documentElement;
    // Still called `touch`: every sizing rule in the stylesheet hangs off it,
    // and phone layout is what it has always meant.
    root.classList.toggle('touch', this.phone);
    root.style.setProperty('--poster-cols', String(this.cols));

    const btn = $('#touchToggle');
    btn.classList.toggle('is-on', this.phone);
    btn.setAttribute('aria-pressed', String(this.phone));

    $('#tabBar').hidden = !this.phone;
    // The bar covers the foot of the page, so the page has to stop above it.
    document.body.classList.toggle('has-tabbar', this.phone);

    for (const b of document.querySelectorAll('#layoutSeg button')) {
      b.classList.toggle('is-on', (b.dataset.phone === '1') === this.phone);
    }
    for (const b of document.querySelectorAll('#colsSeg button')) {
      b.classList.toggle('is-on', Number(b.dataset.cols) === this.cols);
    }
    // Nothing to choose on a desktop, where the grid fits what it can.
    $('#colsField').hidden = !this.phone;

    syncTabs();
  },

  setPhone(on) {
    this.phone = on;
    localStorage.setItem('portal.touch', on ? '1' : '0');
    this.apply();
  },

  setCols(n) {
    this.cols = n;
    localStorage.setItem('portal.cols', String(n));
    this.apply();
  },
};

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

$('#colsSeg').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  device.setCols(Number(button.dataset.cols));
});

/* ----------------------------------------------------------- pi health */

/**
 * A read-only look at the box. It exists because the portal ate itself once
 * when the card filled up silently — storage is the headline, and the panel
 * polls while open so the bar moves as downloads land and get deleted.
 */
const health = {
  timer: null,
  lastBad: false,

  async open() {
    $('#healthModal').hidden = false;
    this.paintPlayback();
    await this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.refresh();
      this.paintPlayback();
    }, 4000);
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

/* ---------------------------------------------------------------- loader */

const loader = {
  show(label, detail = '') {
    $('#loaderLabel').textContent = label;
    $('#loaderDetail').textContent = detail;
    this.set(0);
    $('#loader').hidden = false;
  },
  set(fraction, detail) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    $('#loaderFill').style.width = `${pct}%`;
    $('#loaderPct').textContent = `${pct}%`;
    if (detail !== undefined) $('#loaderDetail').textContent = detail;
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

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (node.hidden = true), 2600);
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

$('#settingsBtn').addEventListener('click', async () => {
  if (!confirm('Disconnect this provider and return to setup?')) return;
  await fetch('/api/config', { method: 'DELETE' });
  state.library = { live: null, movies: null, series: null };
  state.config = null;
  showSetup();
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

async function loadTab(tab) {
  if (state.library[tab]) return state.library[tab];

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
  loader.show(`Loading ${titles[tab] || tab}…`);

  const data = await fetchWithProgress(`/api/library?tab=${encodeURIComponent(tab)}`, (f, got, total) =>
    loader.set(f, `${mb(got)} of ${mb(total)}`)
  );

  loader.label('Building the library…');
  loader.set(1, `${(data.items || []).length.toLocaleString()} titles`);

  state.library[tab] = {
    categories: data.categories || [],
    items: (data.items || []).map((row) => ({ ...row, logo: img(row.logo) })),
    totals: data.totals,
  };
  return state.library[tab];
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
  { title: 'New Releases', match: [/^EN\s*-\s*NEW RELEASE/i], sort: 'added' },
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

/** Recently watched, resolved back to full library items so they can play. */
function forYouItems(tab) {
  const lib = state.library[tab];
  if (!lib) return [];
  const byId = new Map(
    lib.items.filter((i) => !profiles.isDeleted(i)).map((i) => [String(i.id), i])
  );
  const seen = new Set();
  const out = [];

  for (const row of state.recentlyWatched || []) {
    // Series history rows are per-episode; seriesId points at the show.
    const wantKind = tab === 'series' ? 'series' : 'movie';
    if (row.kind !== wantKind) continue;
    const key = String(tab === 'series' ? row.seriesId ?? row.id : row.id);
    if (seen.has(key)) continue;
    seen.add(key);
    // Prefer the library record — it carries ext and artwork.
    const item = byId.get(key);
    if (item) out.push(item);
  }
  return out.slice(0, 24);
}

function buildShelves(tab) {
  const lib = state.library[tab];
  if (!lib) return [];

  // Hidden titles are out of the rows too, not just the grids.
  const pool = lib.items.filter((i) => !profiles.isDeleted(i));
  const rows = [];
  for (const def of SHELF_DEFS[tab] || []) {
    if (def.special === 'recent') {
      const items = forYouItems(tab);
      if (items.length) rows.push({ title: def.title, items });
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
    if (def.sort === 'added') items = [...items].sort((a, b) => (b.added || 0) - (a.added || 0));
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
      window.scrollTo({ top: 0 });
    });

    const rail = el('div', 'rail');
    const track = el('div', 'rail-track');
    // Cap each shelf; the full category is still reachable through search.
    for (const item of row.items.slice(0, 40)) {
      const card = cardFor(item);
      card.classList.add('rail-card');
      track.append(card);
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
  for (const item of slice) frag.append(cardFor(item));
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

function cardFor(item) {
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

  // Hide a title you never want to see again, or put it back from the bin.
  // Revealed on hover so it is not sitting on every poster; in the bin it is
  // always there, since that is the only way back and hover is not a thing on
  // a phone.
  if (canDelete(state.tab)) {
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

  card.addEventListener('click', () => openPlayer(item));
  return card;
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
  const tab = row.kind === 'series' ? 'series' : row.kind === 'live' ? 'live' : 'movies';
  try {
    if (!state.library[tab]) await loadTab(tab);
  } catch {
    return toast(`Couldn't load ${tab}.`);
  } finally {
    loader.hide();
  }

  const wantId = String(row.kind === 'series' ? row.seriesId ?? row.id : row.id);
  const item = (state.library[tab]?.items || []).find((i) => String(i.id) === wantId);
  if (!item) return toast('That title is no longer in the library.');
  openPlayer(item);
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
  return card;
}

/** One of the two favorite boxes, previewing what is inside it. */
function homeBox({ title, empty, items, hash, kind }) {
  const box = el('button', `home-box home-box-${kind}`);

  const head = el('div', 'home-box-head');
  const heading = el('h3');
  heading.textContent = title;
  const count = el('span', 'home-box-count');
  count.textContent = items.length ? items.length.toLocaleString() : '';
  head.append(heading, count);

  const art = el('div', 'home-box-art');
  if (items.length) {
    for (const item of items.slice(0, 4)) {
      const cell = el('div', 'home-box-cell');
      if (item.logo) {
        const image = el('img');
        image.loading = 'lazy';
        image.alt = '';
        image.src = item.logo;
        image.addEventListener('error', () => image.remove());
        cell.append(image);
      } else {
        const fb = el('div', 'fallback');
        fb.textContent = item.name || '';
        cell.append(fb);
      }
      art.append(cell);
    }
  } else {
    const none = el('p', 'home-box-empty');
    none.textContent = empty;
    art.append(none);
  }

  box.append(head, art);
  box.addEventListener('click', () => {
    location.hash = hash;
  });
  return box;
}

function renderHome() {
  $('#grid').hidden = true;
  $('#rowsView').hidden = true;
  $('#downloadList').hidden = true;
  $('#emptyState').hidden = true;
  $('#loadMore').hidden = true;
  document.querySelectorAll('.folder-back').forEach((b) => b.remove());
  document.querySelector('.app-shell').classList.add('no-sidebar');

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

  const boxes = el('section', 'home-boxes');
  boxes.append(
    homeBox({
      title: 'Favorite channels',
      empty: 'No favorite channels yet — tap the heart while watching one.',
      items: channels,
      hash: '#/favlive',
      kind: 'live',
    }),
    homeBox({
      title: 'Favorite movies & shows',
      empty: 'No favorites yet — tap the heart while watching something.',
      items: titles,
      hash: '#/favorites',
      kind: 'vod',
    })
  );
  view.append(boxes);

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
    frag.append(liveCategoryCard(cat, counts.get(id) || 0, covers.get(id) || ''));
  }

  // A way in to the hidden ones, at the end and only once there are some.
  if (!showingHidden && hidden.length) {
    const tile = el('button', 'card cat-card cat-card-bin');
    const art = el('div', 'card-art');
    const mark = el('div', 'fallback');
    mark.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
    art.append(mark);
    const title = el('h3', 'card-title');
    title.textContent = 'Deleted';
    const sub = el('p', 'card-sub');
    sub.textContent = `${hidden.length.toLocaleString()} categor${hidden.length === 1 ? 'y' : 'ies'}`;
    tile.append(art, title, sub);
    tile.addEventListener('click', () => {
      state.category = DELETED_CATS;
      render();
    });
    frag.append(tile);
  }

  grid.append(frag);

  const empty = $('#emptyState');
  empty.hidden = ordered.length > 0;
  if (!ordered.length) {
    empty.textContent = showingHidden ? 'Nothing hidden.' : 'No live categories.';
  }

  $('#contentMeta').textContent = ordered.length
    ? `${ordered.length.toLocaleString()} categor${ordered.length === 1 ? 'y' : 'ies'}` +
      (showingHidden ? ' hidden' : '')
    : '';
  $('#loadMore').hidden = true;
}

/** One square standing for a category, opening its stations when tapped. */
function liveCategoryCard(cat, count, cover) {
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
  const bin = el('button', `icon-btn card-bin${gone ? ' is-restore' : ''}`);
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

  const title = el('h3', 'card-title');
  title.textContent = cat.name;

  // Under the title rather than badged over the art — the logo is the whole
  // point of the tile, and a badge sits on top of it.
  const sub = el('p', 'card-sub');
  sub.textContent = `${count.toLocaleString()} channel${count === 1 ? '' : 's'}`;

  card.append(art, title, sub);

  card.addEventListener('click', () => {
    state.category = cat.id;
    state.visible = PAGE_SIZE;
    render();
  });
  return card;
}

function renderSkeletons() {
  const grid = $('#grid');
  grid.innerHTML = '';
  grid.classList.toggle('is-live', state.tab === 'live');
  for (let i = 0; i < 18; i += 1) grid.append(el('div', 'skeleton'));
  $('#emptyState').hidden = true;
  $('#loadMore').hidden = true;
}

function render() {
  const titles = {
    home: 'Home',
    live: 'Live TV',
    movies: 'Movies',
    series: 'Series',
    favorites: 'Favorites',
    favlive: 'Favorite channels',
    downloads: 'Downloads',
  };
  $('#contentTitle').textContent = titles[state.tab];

  syncTabs();

  if (state.tab === 'downloads') return renderDownloads();
  if (state.tab === 'home') return renderHome();
  $('#homeView').hidden = true;

  $('#downloadList').hidden = true;
  $('#rowsView').hidden = true;
  $('#grid').hidden = false;
  // It sits outside #grid, so emptying the grid leaves it behind — including on
  // the way out of a Downloads folder into another tab.
  document.querySelectorAll('.folder-back').forEach((b) => b.remove());

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
    renderCategories(
      source.categories,
      canDelete(state.tab) ? source.items.filter((i) => !profiles.isDeleted(i)) : source.items
    );
  }

  const inBin = state.category === DELETED_CATEGORY;
  let items = inBin ? profiles.deletedItems(state.tab) : source.items;

  if (!inBin) {
    if (state.category !== null && !isFavorites) {
      items = items.filter((i) => String(i.categoryId) === String(state.category));
    }
    // Deleted titles are gone from the grids and from search alike — hiding
    // them from one and not the other is worse than not hiding them at all.
    if (canDelete(state.tab)) items = items.filter((i) => !profiles.isDeleted(i));
  }

  if (state.query) {
    const q = state.query.toLowerCase();
    items = items.filter((i) => i.name.toLowerCase().includes(q));
  }
  state.filtered = items;

  const grid = $('#grid');
  grid.innerHTML = '';
  grid.classList.toggle('is-live', state.tab === 'live');
  grid.classList.remove('is-cats');

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
  try {
    state.downloads = await api('/api/downloads');
  } catch {
    return;
  }
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

/** Poster for a download: stored at save time, else matched from the library. */
function downloadPoster(job) {
  if (job.poster) return img(job.poster);
  const lib = state.library[job.kind === 'series' ? 'series' : 'movies'];
  const hit = (lib?.items || []).find((i) => String(i.id) === String(job.streamId));
  return hit ? hit.logo : '';
}

function renderDownloads() {
  $('#downloadList').hidden = true;
  // render() hides this too, but only after its early return for this tab —
  // so arriving from Movies or Series left their shelves showing underneath.
  $('#rowsView').hidden = true;
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
      'Nothing downloaded yet. Open a movie or episode and press the download arrow.';
    $('#contentMeta').textContent = '';
    openSeriesFolder = null;
    return;
  }
  empty.hidden = true;

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
    const pct = job.total ? Math.floor((job.bytes / job.total) * 100) : 0;
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

    const sub = el('p', 'card-sub');
    sub.textContent =
      job.status === 'done'
        ? job.preparing
          ? 'Optimizing for instant playback…'
          : unoptimized
            ? job.prepareError
              ? `Not optimized — ${job.prepareError}`
              : 'Not optimized yet — playback will be slow'
            : formatBytes(job.total)
        : job.status === 'error'
          ? job.error || 'Failed'
          : job.status === 'downloading'
            ? `${formatBytes(job.bytes)} of ${formatBytes(job.total)}`
            : job.status === 'paused'
              ? job.autoPaused
                ? 'Paused while you watch — resumes on its own'
                : `${formatBytes(job.bytes)} saved`
              : 'Waiting for the connection';

    const actions = el('div', 'dl-actions');

    if (unoptimized) {
      const fix = el('button', 'btn btn-primary btn-sm');
      fix.textContent = job.prepareError ? 'Retry optimize' : 'Optimize';
      fix.title = 'Convert to a plain MP4 so it plays and scrubs instantly';
      fix.addEventListener('click', async (event) => {
        event.stopPropagation();
        fix.disabled = true;
        try {
          const res = await fetch(`/api/downloads/${job.id}/optimize`, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not start optimizing.');
          toast('Optimizing — this runs once, then playback is instant.');
        } catch (err) {
          toast(err.message);
          fix.disabled = false;
        }
        await refreshDownloads({ rerender: true });
      });
      actions.append(fix);
    }

    if (job.status === 'done') {
      const save = el('a', 'btn btn-ghost btn-sm');
      save.href = `/api/downloads/${job.id}/save`;
      save.textContent = 'Save to device';
      save.setAttribute('download', `${job.name}.${job.ext}`);
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

    if (job.status === 'error' || job.status === 'paused') {
      const retry = el('button', 'btn btn-ghost btn-sm');
      retry.textContent = job.status === 'paused' ? 'Resume' : 'Retry';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        await fetch(`/api/downloads/${job.id}/retry`, { method: 'POST' });
        await refreshDownloads({ rerender: true });
      });
      actions.append(retry);
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
async function requestSeasonDownload() {
  if (!currentSeason || !currentSeason.episodes.length) {
    return toast('No season is open.');
  }
  const { item, season, episodes } = currentSeason;

  await refreshDownloads();
  const already = new Set(
    (state.downloads.items || []).map((j) => String(j.streamId))
  );
  const pending = episodes.filter((e) => !already.has(String(e.id)));

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
  for (const episode of pending) {
    // Sequential: each POST is cheap, and this keeps queue order predictable.
    // eslint-disable-next-line no-await-in-loop
    const done = await requestDownload(item, { ...episode, season }, { quiet: true });
    if (done) queued += 1;
  }

  await refreshDownloads({ rerender: true });
  toast(`Queued ${queued} episode${queued === 1 ? '' : 's'} of Season ${season}.`);
}

async function requestDownload(item, episode, { quiet = false } = {}) {
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

  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not queue that download.');
    // A season download reports once at the end rather than per episode.
    if (quiet) return true;
    await refreshDownloads({ rerender: true });
    toast(
      state.downloads.queued > 1
        ? `Queued “${payload.name}”. It starts when the current one finishes.`
        : `Downloading “${payload.name}”. Watch progress in Downloads.`
    );
    return true;
  } catch (err) {
    if (!quiet) toast(err.message);
    return false;
  }
}

/* ---------------------------------------------------------------- router */

async function goTo(tab) {
  state.tab = tab;
  // Leave home the moment the tab changes rather than once the new tab has
  // drawn. A tab whose library fails to load returns before render() ever
  // runs, which left the whole home screen sitting there underneath the error.
  if (tab !== 'home') $('#homeView').hidden = true;
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

function routeFromHash() {
  // Home is the landing page and the badge is the way back to it, but it is
  // deliberately not a tab — favlive is likewise reachable only from there.
  const tab = (location.hash.replace('#/', '') || 'home').toLowerCase();
  return ['home', 'live', 'movies', 'series', 'favorites', 'favlive', 'downloads'].includes(tab)
    ? tab
    : 'home';
}

window.addEventListener('hashchange', () => goTo(routeFromHash()));

/* ---------------------------------------------------------------- player */

let engine = null;
/** Which decoder is driving playback, for the diagnostics report. */
let engineKind = null;

function teardown() {
  const video = $('#video');
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
          ? { lowLatencyMode: true, backBufferLength: 60 }
          : {
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
              // A remux in progress has no ENDLIST yet, so hls.js reads it as
              // live and would join at the edge — i.e. however many seconds we
              // prebuffered into the film. Films start at the beginning.
              startPosition: 0,
            }
      );
      engine.loadSource(url);
      engine.attachMedia(video);
      engine.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) engine.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) engine.recoverMediaError();
        else status(`Playback failed: ${data.details}`);
      });
      return;
    }
    // Safari plays HLS natively. Same live-edge trap applies on iOS, so pin a
    // remuxed film to the start once metadata lands.
    video.src = url;
    if (!currentLiveItem) {
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
  const video = $('#video');
  if (!video.buffered.length) return null;
  return video.buffered.end(video.buffered.length - 1) - video.currentTime;
}

function startLiveTracking() {
  stopLiveTracking();
  const pill = $('#livePill');
  const lag = $('#liveLag');
  pill.hidden = false;
  $('#latencyMode').hidden = false;

  liveTimer = setInterval(() => {
    const behind = currentLag();
    if (behind === null) return;
    // Under ~3s is as live as this provider gets; don't nag about it.
    const atEdge = behind < 3;
    pill.classList.toggle('is-behind', !atEdge);
    lag.textContent = atEdge ? 'LIVE' : `${Math.round(behind)}s behind`;
  }, 1000);
}

function stopLiveTracking() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  $('#livePill').hidden = true;
  $('#latencyMode').hidden = true;
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
      return `  +${String(secs).padStart(3)}s ${r.pos.toFixed(1).padStart(8)} ` +
        `${rate.padStart(7)}  rs${r.rs}/${r.nw} buf${String(Math.round(r.buf)).padStart(4)}` +
        (r.notes ? `  ${r.notes}` : '');
    });
    return ['', 'timeline  (film position, rate, readyState/networkState, buffered to)', ...rows];
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
    const fresh = session === this.probedSession && Date.now() - this.probedAt < 60_000;
    if (fresh || Date.now() - this.startedAt < 12_000) return;
    this.probedSession = session;
    this.probedAt = Date.now();
    api('/api/remux/probe', { id: session })
      .then((data) => { this.probe = data; this.probedAt = Date.now(); })
      .catch((err) => { this.probe = { error: err.message }; });
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
        `(measured ${age}s ago)`,
      `  a segment     claims ${Number(seg.declared || 0).toFixed(3)}s, holds ` +
        `${Number(seg.real || 0).toFixed(3)}s  → timeline ${seg.ratio ? seg.ratio.toFixed(3) : 'n/a'}`,
      `  a/v start     video ${Number.isFinite(p.start?.video) ? p.start.video.toFixed(3) : '?'}s, ` +
        `audio ${Number.isFinite(p.start?.audio) ? p.start.audio.toFixed(3) : '?'}s  → offset ` +
        `${Number.isFinite(p.start?.sync) ? `${(p.start.sync * 1000).toFixed(0)}ms` : 'n/a'}`,
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
        `begins ${sync > 0 ? 'after' : 'before'} the picture, which is heard as lip-sync drift.`;
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
        return `Running at ${rate.toFixed(2)}× with ${this.events.waiting} stalls — the stream is not arriving fast enough.`;
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
$('#video').addEventListener('loadstart', () => playback.reset());
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
    if (!lastRemux.session) {
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

$('#latencyMode').addEventListener('change', async (event) => {
  prefs.data.liveLatency = event.target.value;
  await prefs.save();
  if (currentLiveItem) {
    toast('Reconnecting with the new latency setting…');
    const { url, format } = await resolveStream(currentLiveItem);
    attach(url, format);
  }
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

  // Launched from the Downloads grid? Back returns there, not to Movies.
  const fromDownloads = Boolean(item.downloadId && item.localOnly);
  const labels = { series: 'Series', live: 'Live TV', movie: 'Movies' };
  cinemaReturnHash = fromDownloads
    ? '#/downloads'
    : item.kind === 'series' ? '#/series' : item.kind === 'live' ? '#/live' : '#/movies';

  $('#cinemaTop').hidden = false;
  $('#cinemaTitle').textContent = item.name || '';
  $('#cinemaSub').textContent = '';
  $('#cinemaBackLabel').textContent = fromDownloads ? 'Downloads' : labels[item.kind] || 'Back';
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
  film.item = item;
  film.override = override || null;

  const video = $('#video');
  video.controls = false;           // ours replaces it
  $('#vodBar').hidden = false;
  $('#vodTotal').textContent = hms(film.duration);
  enterCinema(item);
  paintFilmBar();
}

function hideFilmBar() {
  // Note: does NOT exit cinema — live TV runs full screen with no film bar.
  film.active = false;
  film.item = null;
  $('#vodBar').hidden = true;
  $('#video').controls = true;
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
  loader.show(`Jumping to ${hms(clamped)}…`, '');

  try {
    // A downloads-backed title seeks against the file on disk — fast, and no
    // provider connection spent. Everything else restarts the provider remux.
    const remux = await api(
      '/api/remux',
      film.item?.downloadId
        ? { download: film.item.downloadId, start: Math.floor(clamped) }
        : {
            kind: film.override?.kind || (film.item.kind === 'movie' ? 'movie' : film.item.kind),
            id: film.override?.id ?? film.item.id,
            ext: film.override?.ext ?? film.item.ext ?? '',
            vcodec: film.override?.vcodec || film.item.vcodec || '',
            start: Math.floor(clamped),
          }
    );
    lastRemux = remux;

    film.offset = remux.offset || 0;
    film.ready = 0;
    await waitForPrebuffer(remux);
    attach(remux.url, 'm3u8');
    startLeadWatch();
  } catch (err) {
    toast(`Couldn't jump there: ${err.message}`);
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

/**
 * Surface an altered playback rate. Nothing here ever sets a rate other than
 * 1 — but an extension can, and a video quietly running at a fraction of speed
 * is baffling without something on screen saying so.
 */
function paintSpeed() {
  const rate = $('#video').playbackRate;
  const off = Math.abs(rate - 1) > 0.01;
  $('#vodSpeed').hidden = !off;
  if (off) $('#vodSpeedLabel').textContent = `${Number(rate.toFixed(2))}×`;

  // The bar fades after a few idle seconds, so a badge living inside it is
  // invisible exactly when you need it. This warning sits outside the fading
  // chrome and stays put until the speed is normal again.
  const warn = $('#speedWarn');
  warn.hidden = !off;
  if (off) $('#speedWarnLabel').textContent = `Playing at ${Number(rate.toFixed(2))}× — click to reset`;
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

for (const id of ['#vodSpeed', '#speedWarn']) {
  $(id).addEventListener('click', () => {
    normalizeRate();
    toast('Playback speed reset to normal.');
  });
}

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

$('#vodFull').addEventListener('click', () => {
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
});

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
});

$('#video').addEventListener('webkitendfullscreen', () => {
  if (film.active) {
    $('#video').controls = false;
    $('#vodBar').hidden = false;
    paintFilmBar();
  }
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
  const target = remux.prebuffer || 45;
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

    film.ready = status.seconds;
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
  if (needsRemux(job.ext)) {
    // The file is on disk but still in its original container, so it has to be
    // converted as it plays — the exact stop-start this feature exists to
    // avoid. Say so, rather than letting it look like a network problem.
    toast('This download is not optimized yet — playback may stall. Fix it from Downloads.');
    const remuxed = await api('/api/remux', {
      download: job.id,
      start: startAt || '',
    });
    lastRemux = remuxed;
    film.offset = remuxed.offset || 0;
    await waitForPrebuffer(remuxed);
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

  if (item.directUrl) {
    const source = item.sourceUrl || '';
    const localExt = (source.split('.').pop() || '').toLowerCase();

    // A downloaded .mkv is just as unplayable as a streamed one. Remux it from
    // local disk, which is fast and costs no provider connection.
    if (item.localOnly && item.downloadId && needsRemux(localExt)) {
      const data = await api('/api/remux', { download: item.downloadId });
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
    });
    lastRemux = remuxed;
    film.offset = remuxed.offset || 0;
    await waitForPrebuffer(remuxed);
    return { url: remuxed.url, format: 'm3u8' };
  }

  const data = await api('/api/play', {
    kind,
    id,
    ext,
    latency: kind === 'live' ? prefs.data.liveLatency : '',
  });
  const format =
    kind === 'live' ? data.format : /^(m3u8|ts)$/.test(data.format) ? data.format : 'file';
  return { url: data.url, format };
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

async function openPlayer(item) {
  const myToken = ++playToken;
  const overlay = $('#playerOverlay');
  overlay.hidden = false;
  // Whatever was queued up behind the last title is not what follows this one,
  // and the previous title's playback evidence is not about this one either.
  upNext.clear();
  playback.resetViewing();
  document.body.style.overflow = 'hidden';

  // Full screen from the first frame — the windowed shell used to flash up
  // for the whole buffering wait before cinema mode finally engaged.
  enterCinema(item);

  document.querySelector('.player-shell').classList.remove('awaiting-pick');
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
    downloadBtn.title = 'Download the whole season';
    downloadBtn.onclick = () => requestSeasonDownload();
  } else {
    downloadBtn.title = 'Download for offline';
  }

  if (item.kind === 'series') {
    document.querySelector('.player-shell').classList.add('awaiting-pick');
    await renderSeries(item);
    return;
  }

  currentLiveItem = item.kind === 'live' ? item : null;
  $('#latencyMode').value = prefs.data.liveLatency || 'balanced';

  // A previous title's remux must not leak its duration into this one — that
  // put the wrong runtime on the scrubber for anything that plays natively.
  lastRemux = {};

  // Know what's on disk before deciding how to play it. Live never has a
  // local copy, so don't spend a round trip on it before tuning the channel.
  if (item.kind !== 'live') await refreshDownloads();
  const localCopy = item.kind === 'live' || item.localOnly ? null : findLocalCopy(item.kind, item.id);

  // Pick up where this profile left off, if it did. Asked before anything is
  // fetched so a resume starts the conversion at the right point rather than
  // converting from zero and then jumping.
  let startAt = 0;
  if (item.kind === 'movie' && (!item.localOnly || item.resumeKey)) {
    const saved = await fetchProgress(resumeKeyFor(item));
    if (saved) {
      if (myToken !== playToken) return;
      startAt = await askResume(item.name, saved);
      if (myToken !== playToken) return;
    }
  }

  // Ask for the details while the provider connection is still free — once
  // ffmpeg is streaming, this call comes back empty. Skipped for a local copy:
  // a downloaded film should play with the provider entirely out of the loop.
  let vodInfo = null;
  if (item.kind === 'movie' && !item.localOnly && !localCopy && state.config.mode === 'xtream') {
    loader.show('Fetching film details…');
    vodInfo = await fetchVodInfo(item);
  }

  try {
    if (localCopy) {
      status('Playing your downloaded copy…');
    } else if (item.kind !== 'live' && needsRemux(item.ext || (item.sourceUrl || '').split('.').pop())) {
      status('Converting for playback — this takes a few seconds…');
    }
    const { url, format, seekTo } = await resolveStream(item, { startAt });
    if (myToken !== playToken) return; // player closed while we were buffering
    attach(url, format, { seekTo });
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
        const runtime = parseRuntime(vodInfo) || lastRemux.sourceDuration || 0;
        showFilmBar(item, runtime);
        applyVodInfo(vodInfo);
        if (localCopy || item.localOnly) {
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


async function renderSeries(item) {
  const detail = $('#playerDetail');
  detail.hidden = false;
  detail.innerHTML = '<h3>Loading episodes…</h3>';

  let data;
  try {
    data = await api('/api/xtream', { action: 'get_series_info', series_id: item.id });
  } catch (err) {
    detail.innerHTML = '';
    const heading = el('h3');
    heading.textContent = `Couldn't load episodes: ${err.message}`;
    detail.append(heading);
    return;
  }

  const episodes = data.episodes || {};
  const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
  if (!seasons.length) {
    detail.innerHTML = '<h3>No episodes listed for this series.</h3>';
    return;
  }

  const info = data.info || {};
  if (info.genre || info.releaseDate) {
    $('#playerSub').textContent = [info.releaseDate, info.genre].filter(Boolean).join(' · ');
  }

  detail.innerHTML = '';
  const picker = el('div', 'season-picker');
  const list = el('div', 'ep-list');
  detail.append(picker, list);

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

  /**
   * Play one episode of the open series. A named function rather than the
   * click handler it used to be, because the up-next button has to start an
   * episode nobody clicked on — including the first of the following season.
   */
  const startEpisode = async (season, index) => {
    const episode = (episodes[season] || [])[index];
    if (!episode) return;
    const myToken = playToken; // closing the player invalidates this pick

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

    document.querySelector('.player-shell').classList.remove('awaiting-pick');
    const sub = episodeLabel(season, episode);
    $('#playerSub').textContent = sub;
    $('#cinemaSub').textContent = sub;
    // Drop the previous episode's offer now rather than when the new one is
    // playing, or it hangs on screen through the whole conversion wait.
    upNext.clear();
    playback.resetViewing();

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

      const grab = el('button', 'ep-dl');
      grab.title = 'Download this episode';
      grab.setAttribute('aria-label', 'Download this episode');
      grab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>';
      grab.addEventListener('click', (event) => {
        event.stopPropagation();
        requestDownload(item, { ...episode, season });
      });

      row.append(num, name, grab);
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

  showSeason(seasons[0]);
}

function closePlayer() {
  playToken += 1; // cancel any open/episode pick still awaiting its stream
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
  if (event.key === 'Escape' && !$('#healthModal').hidden) return health.close();
  if (event.key === 'Escape' && !$('#deviceModal').hidden) {
    $('#deviceModal').hidden = true;
    return;
  }
  if (event.key === 'Escape' && !$('#playerOverlay').hidden) closePlayer();
});

/* --------------------------------------------------------------- chrome */

$('#loadMore').addEventListener('click', () => {
  state.visible += PAGE_SIZE;
  render();
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
  searchTimer = setTimeout(() => {
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

  for (const profile of profiles.all) {
    const tile = el('button', 'profile-tile');
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
}

function showProfileGate() {
  $('#setupView').hidden = true;
  $('#siteHeader').hidden = true;
  $('#appView').hidden = true;
  $('#profileGate').hidden = false;
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
  // Editing name and icon is open; creating and deleting need the password.
  $('#passwordField').hidden = Boolean(profile);
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
      body.password = form.elements.password.value;
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
  const password = prompt(
    `Delete “${editingProfile.name}”? This removes its favorites and watch history.\n\nEnter the profile password:`
  );
  if (password === null) return;

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
  await refreshDownloads();
  await goTo(routeFromHash());

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
