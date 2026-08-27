/*
 * The shell: what screen is up, what the remote does, and the chrome that
 * stays put across all of it.
 *
 * A screen module exports { render, activate?, onKey?, onFocus?, back?, leave?,
 * fullbleed? }. It paints into the host it is handed and numbers its own rows;
 * everything else — focus, scrolling, the nav, the loading screen — is here.
 */

import { focus } from './focus.js';
import { state, loadProfile, loadTaste, refreshHealth } from './state.js';
import { el, clear, toast } from './ui.js';

import * as live from './screens/live.js';
import * as movies from './screens/movies.js';
import * as series from './screens/series.js';
import * as show from './screens/show.js';
import * as favorites from './screens/favorites.js';
import * as archive from './screens/archive.js';
import * as downloads from './screens/downloads.js';
import * as search from './screens/search.js';
import * as player from './screens/player.js';
import * as vod from './screens/vod.js';
import * as multi from './screens/multi.js';

const SCREENS = {
  live, movies, series, show, favorites, archive, downloads, search, player, vod, multi,
};

/** Which nav pill lights up for a screen that has no pill of its own. */
const NAV_FOR = {
  live: 'live', movies: 'movies', series: 'series', show: 'series',
  favorites: 'favorites', archive: 'archive', downloads: 'downloads',
  search: 'search', multi: 'multi', player: 'live', vod: 'movies',
};

const NAV_INDEX = {
  live: 0, movies: 1, series: 2, favorites: 3, archive: 4, downloads: 5, search: 6, multi: 7,
};

const dom = {};
let current = null;
let params = {};
let rendering = false;

export const app = {
  get screen() { return state.screen; },

  /** Move to a screen. `next` is handed to the screen's render(). */
  go(name, next = {}) {
    if (!SCREENS[name]) return;
    if (current && current !== SCREENS[name] && current.leave) current.leave();
    state.screen = name;
    params = next;
    focus.reset(next.focusRow ?? 1, next.focusCol ?? 0);
    if (NAV_INDEX[NAV_FOR[name]] !== undefined) focus.memory[0] = NAV_INDEX[NAV_FOR[name]];
    render();
  },

  /** Re-paint the screen that is up, keeping the cursor where it is. */
  refresh() {
    render({ keepFocus: true });
  },

  toast,

  /* The loading screen between choosing something and watching it. The bison
     and the brand field are the portal's own, so the wait looks like the app
     rather than like nothing happening. */
  tune({ eyebrow = 'TUNING IN', name = '', sub = '', hints = [], badge = null }) {
    const host = clear(dom.tuning);
    const wrap = el('div', 'tuning');
    const bison = el('img');
    bison.src = '/bison.png';
    bison.alt = '';
    bison.onerror = () => { bison.src = 'assets/bison.png'; bison.onerror = null; };
    wrap.append(bison, el('div', 'tune-eyebrow', eyebrow), el('div', 'tune-name', name));
    if (sub) wrap.append(el('div', 'tune-sub', sub));
    if (badge) {
      const pill = el('span', 'tune-badge');
      if (badge.dot) pill.append(el('span', 'live-dot'));
      pill.append(badge.text);
      wrap.append(pill);
    }
    if (hints.length) {
      const row = el('div', 'tune-hints');
      for (const [key, label] of hints) {
        const span = el('span');
        span.append(el('b', null, key), ` ${label}`);
        row.append(span);
      }
      wrap.append(row);
    }
    host.append(wrap);
    state.tuning = true;
  },

  /** The same screen, saying what went wrong instead of what is loading. */
  tuneError(name, message) {
    this.tune({ eyebrow: 'CANNOT PLAY', name, hints: [['BACK', 'Go back']] });
    dom.tuning.querySelector('.tuning').append(el('div', 'tune-error', message));
  },

  clearTune() {
    clear(dom.tuning);
    state.tuning = false;
  },
};

/* ------------------------------------------------------------- painting ── */

async function render({ keepFocus = false } = {}) {
  const screen = SCREENS[state.screen];
  if (!screen) return;
  current = screen;
  rendering = true;

  const full = Boolean(screen.fullbleed);
  dom.nav.hidden = full;
  dom.scroller.hidden = full;
  dom.header.hidden = full;
  dom.hints.hidden = full;

  paintNav();

  const host = full ? dom.overlay : dom.screen;
  if (full) clear(dom.screen); else clear(dom.overlay);
  clear(host);

  try {
    await screen.render(host, app, params);
  } catch (err) {
    clear(host).append(el('div', 'empty', `That screen did not load: ${err.message}`));
  }

  rendering = false;
  const keptRow = focus.pos.r;
  const keptCol = focus.pos.c;
  focus.collect();
  if (keepFocus) focus.pos = { r: keptRow, c: keptCol };
  focus.el = null;
  focus.apply();
}

function paintNav() {
  const want = NAV_FOR[state.screen];
  for (const pill of dom.nav.querySelectorAll('[data-screen]')) {
    pill.classList.toggle('active', pill.dataset.screen === want);
  }
}

/* --------------------------------------------------------------- chrome ── */

function paintClock() {
  const now = new Date();
  const day = now.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  dom.clock.textContent = `${day} ${time}`;
}

function paintProfile() {
  if (!state.profile) return;
  dom.profileName.textContent = state.profile.name.toUpperCase();
  dom.profileBadge.textContent = state.profile.emoji || state.profile.name.slice(0, 1).toUpperCase();
  if (state.profile.color) dom.profileBadge.style.background = state.profile.color;
}

/*
 * The box chip. It is not decoration: on this setup the Pi is doing the
 * downloading, the remuxing and the serving, and "why is it stuttering" is
 * nearly always answered by its temperature or its free disk.
 */
function paintHealth() {
  const health = state.health;
  if (!health) {
    dom.boxDot.className = 'box-dot bad';
    dom.boxState.textContent = 'BOX UNREACHABLE';
    return;
  }
  const temp = health.cpu && Number.isFinite(health.cpu.tempC) ? Math.round(health.cpu.tempC) : null;
  const low = health.disk && health.disk.low;
  dom.boxDot.className = `box-dot${low ? ' warn' : ''}`;
  dom.boxState.textContent = low
    ? `DISK LOW${temp === null ? '' : ` · ${temp}°C`}`
    : `BOX OK${temp === null ? '' : ` · ${temp}°C`}`;
}

/** 1920×1080, scaled to the panel. */
function fit() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const dx = Math.round((window.innerWidth - 1920 * scale) / 2);
  const dy = Math.round((window.innerHeight - 1080 * scale) / 2);
  dom.stage.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  focus.setScale(scale);
}

/* ----------------------------------------------------------------- keys ── */

const NAV_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Enter', ' ', 'Escape', 'Backspace', 'BrowserBack', 'GoBack',
]);

function onKey(event) {
  const key = event.key;
  if (!NAV_KEYS.has(key)) return;
  event.preventDefault();
  if (rendering) return;

  const back = key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || key === 'GoBack';
  const ok = key === 'Enter' || key === ' ';

  /* The loading screen owns the remote while it is up: there is nothing to
     move to, and BACK is the way out of a channel that will not open. */
  if (state.tuning) {
    if (back) {
      app.clearTune();
      if (current && current.tuneDismissed) current.tuneDismissed();
    }
    return;
  }

  if (current && current.onKey && current.onKey(key, { back, ok, app })) return;

  if (ok) {
    const node = focus.current();
    if (!node) return;
    if (node.dataset.screen) { app.go(node.dataset.screen); return; }
    if (current && current.activate) current.activate(node, app);
    return;
  }

  if (back) {
    if (current && current.back && current.back(app)) return;
    if (state.screen !== 'live') { app.go('live'); return; }
    /* Already home: BACK goes up to the nav rather than nowhere. */
    focus.set(0, focus.memory[0] ?? 0);
    return;
  }

  if (key === 'ArrowLeft') focus.move(0, -1);
  else if (key === 'ArrowRight') focus.move(0, 1);
  else if (key === 'ArrowUp') focus.move(-1, 0);
  else if (key === 'ArrowDown') focus.move(1, 0);
}

/* ----------------------------------------------------------------- boot ── */

async function boot() {
  for (const id of ['stage', 'nav', 'scroller', 'screen', 'overlay', 'hints', 'tuning',
    'clock', 'profileName', 'profileBadge', 'boxDot', 'boxState', 'header', 'version']) {
    dom[id] = document.getElementById(id);
  }
  dom.header = document.querySelector('.header');

  const bison = document.getElementById('brandBison');
  if (bison) bison.onerror = () => { bison.src = 'assets/bison.png'; bison.onerror = null; };
  dom.version.textContent = 'treasure theater · shield';

  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('keydown', onKey);
  document.addEventListener('click', (event) => {
    const node = event.target.closest && event.target.closest('[data-r]');
    if (!node) return;
    event.preventDefault();
    focus.set(Number(node.dataset.r), Number(node.dataset.c));
  });

  focus.onFocus = (node) => {
    if (current && current.onFocus) current.onFocus(node);
  };

  paintClock();
  setInterval(paintClock, 15000);

  try {
    await loadProfile();
    paintProfile();
  } catch (err) {
    clear(dom.screen).append(el('div', 'empty', err.message));
    return;
  }

  /* Health and taste are wanted by the chrome and by three screens, and
     neither is worth blocking the first paint on. */
  refreshHealth().then(paintHealth);
  loadTaste();
  setInterval(() => {
    /* Never while something is playing: the chip is not worth a stutter. */
    if (state.screen === 'player' || state.screen === 'multi') return;
    refreshHealth().then(paintHealth);
  }, 60000);

  app.go('live');
}

boot();
