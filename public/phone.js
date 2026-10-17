/* ==========================================================================
   Treasureflix — the phone's own home screen and chrome.

   "I don't like that the Home Screen for iPhone Iptv is almost the same as the
    desktop one. It doesn't look like an intuitive UI"

   The desktop design was made the design everywhere, and on a phone that meant
   a billboard headline two lines tall, a paragraph about seeking, a nine-row
   listings grid whose every title was cut to "Live: ...", and five round
   buttons across a header a thumb has to reach over. This layer gives the
   phone what a phone app has instead:

     - a header with the mark and your profile, and nothing else;
     - one featured card — the thing you were last watching, with Resume;
     - swipeable rows: Continue watching, On now, Your favorites, Recently
       added, For You;
     - a bottom bar of Home · Live · Movies · Series · Search, with the rest
       (downloads, the control panel, this device) in a sheet off the profile.

   Like desktop.js it decorates rather than forks: app.js still owns the data
   and every action (play, resume, open a title), and this only lays out the
   home page and the chrome around it. It is inert unless the phone shell is
   on (`body.has-tabbar`), so the desktop, the television and the car never
   see any of it. Every entry point is guarded: a fault here paints a plainer
   page, it never stops app.js.
   ========================================================================== */

(function () {
  'use strict';

  const phone = () => document.body.classList.contains('has-tabbar');
  const guard = (label, fn) => function () {
    try {
      return fn.apply(this, arguments);
    } catch (err) {
      console.error(`[phone] ${label}:`, err);
      return undefined;
    }
  };
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* "EN - The West Wing (US)" and "A+ - Ted Lasso (2020)": the provider's
     shelf codes, which mean something in its catalogue and nothing on a card. */
  const tidy = (name) => String(name || '').replace(/^[A-Z0-9+]{1,4}\s*[-|:]\s+/, '').trim();

  /* --------------------------------------------------------------- rows */
  function rail(title, cards, onMore) {
    const section = make('section', 'ph-row');
    const head = make('div', 'ph-row-head');
    head.append(make('h2', 'ph-row-title', title));
    if (onMore) {
      const more = make('button', 'ph-row-more', 'See all');
      more.type = 'button';
      more.addEventListener('click', onMore);
      head.append(more);
    }
    const track = make('div', 'ph-track');
    for (const card of cards) track.append(card);
    section.append(head, track);
    return section;
  }

  /** A library item as a poster, through app.js so a press does what it always does. */
  function poster(item) {
    const card = cardFor(item);
    card.classList.add('ph-poster');
    const title = card.querySelector('.card-title');
    if (title) title.textContent = tidy(title.textContent);
    return card;
  }

  /** A history row as a poster with its progress stripe. */
  function resumeCard(row) {
    const card = homeCard(row, 'ph-poster');
    const title = card.querySelector('.card-title');
    if (title) title.textContent = tidy(title.textContent);
    return card;
  }

  /* ------------------------------------------------------- the featured */
  function featured(row) {
    const face = historyFace(row);
    const card = make('section', 'ph-feature');
    if (face.art) card.style.setProperty('--ph-art', `url("${String(face.art).replace(/"/g, '%22')}")`);

    const art = make('div', 'ph-feature-poster');
    if (face.art) {
      const img = make('img');
      img.alt = '';
      img.src = face.art;
      img.addEventListener('error', () => img.remove());
      art.append(img);
    }

    const copy = make('div', 'ph-feature-copy');
    copy.append(make('span', 'ph-eyebrow', 'Continue watching'));
    // The episode is said on the line below, so not twice.
    copy.append(make('h1', 'ph-feature-title', tidy(face.name).replace(/\s+[—-]\s+S\d+\s*E\d+$/i, '')));

    const ratio = row.duration && row.position ? row.position / row.duration : 0;
    const bits = [];
    if (row.season && row.episode) bits.push(`S${row.season} · E${row.episode}`);
    if (row.duration && row.position && ratio < RESUME_MAX_RATIO) {
      bits.push(`${hms(Math.max(0, Math.round(row.duration - row.position)))} left`);
    }
    if (bits.length) copy.append(make('p', 'ph-feature-meta', bits.join('  ·  ')));

    if (ratio > 0.01 && ratio < RESUME_MAX_RATIO) {
      const bar = make('div', 'ph-feature-bar');
      const fill = make('i');
      fill.style.width = `${Math.min(100, ratio * 100)}%`;
      bar.append(fill);
      copy.append(bar);
    }

    const go = make('button', 'ph-resume');
    go.type = 'button';
    go.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>';
    go.append(document.createTextNode(ratio > 0.01 && ratio < RESUME_MAX_RATIO ? 'Resume' : 'Play'));
    go.addEventListener('click', () => playFromHistory(row));
    copy.append(go);

    card.append(art, copy);
    return card;
  }

  /* ------------------------------------------------------------ on now */
  /* What is on the favourite channels right now, a card each. The listings
     come from the provider and the page does not wait for them: the cards
     go up with the channel names and fill in as the answer arrives. */
  function onNow(channels) {
    const cards = channels.map((item) => {
      const card = make('button', 'ph-chan');
      card.type = 'button';
      card.dataset.id = item.id;
      const logo = make('div', 'ph-chan-logo');
      if (item.logo) {
        const img = make('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = item.logo;
        img.addEventListener('error', () => { img.remove(); logo.textContent = tidy(item.name).slice(0, 3); });
        logo.append(img);
      } else {
        logo.textContent = tidy(item.name).slice(0, 3);
      }
      const words = make('div', 'ph-chan-words');
      words.append(make('span', 'ph-chan-name', tidy(item.name)));
      words.append(make('span', 'ph-chan-show', ''));
      const bar = make('div', 'ph-chan-bar');
      bar.append(make('i'));
      card.append(logo, words, bar);
      card.addEventListener('click', () => openPlayer(item));
      return card;
    });
    const section = rail('On now', cards, () => { location.hash = '#/favlive'; });
    section.classList.add('ph-onnow');
    section.querySelector('.ph-row-more').textContent = 'Full guide';
    fillOnNow(section, channels);
    return section;
  }

  async function fillOnNow(section, channels) {
    const ids = channels.map((c) => c.id).join(',');
    let data;
    try {
      data = await api('/api/epg/now', { ids });
    } catch {
      return;
    }
    if (!section.isConnected) return;
    const now = Date.now() / 1000;
    for (const channel of data.channels || []) {
      const card = section.querySelector(`.ph-chan[data-id="${CSS.escape(String(channel.id))}"]`);
      if (!card) continue;
      const on = (channel.listings || []).find((l) => l.start <= now && l.stop > now);
      if (!on) continue;
      card.querySelector('.ph-chan-show').textContent = on.title || '';
      const span = Math.max(1, on.stop - on.start);
      card.querySelector('.ph-chan-bar i').style.width = `${Math.min(100, ((now - on.start) / span) * 100)}%`;
    }
  }

  /* ---------------------------------------------------------- the page */
  const buildHome = guard('home', function buildHome() {
    const view = document.getElementById('homeView');
    if (!view || view.hidden) return;
    const stamp = view.querySelector('.home-version');
    view.innerHTML = '';
    view.classList.add('ph-home');

    const seen = new Set();
    const recent = [];
    for (const row of state.recentlyWatched || []) {
      // Channels are On now's business; this is films and episodes.
      if (row.kind === 'live') continue;
      const key = historyKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      recent.push(row);
      if (recent.length === 13) break;
    }

    if (recent.length) view.append(featured(recent[0]));
    if (recent.length > 1) view.append(rail('Continue watching', recent.slice(1).map(resumeCard)));

    const favs = profiles.favItems();
    const channels = favs.filter((i) => i.kind === 'live');
    const titles = favs.filter((i) => i.kind !== 'live');
    if (channels.length) view.append(onNow(channels.slice(0, 12)));
    if (titles.length) {
      view.append(rail('Your favorites', titles.slice(0, 20).map(poster),
        () => { location.hash = '#/favorites'; }));
    }

    for (const tab of ['movies', 'series']) {
      const rows = buildShelves(tab);
      const forYou = rows.find((r) => r.title === 'For You');
      const newest = rows.find((r) => r.title !== 'For You');
      if (newest?.items.length) {
        view.append(rail(tab === 'movies' ? 'Recently added movies' : 'New episodes',
          newest.items.slice(0, 20).map(poster), () => { location.hash = `#/${tab}`; }));
      }
      if (forYou?.items.length) {
        view.append(rail(tab === 'movies' ? 'Movies for you' : 'Shows for you',
          forYou.items.slice(0, 20).map(poster), () => { location.hash = `#/${tab}`; }));
      }
    }

    if (!view.children.length) {
      view.append(make('p', 'ph-empty', 'Nothing here yet. Watch something and it will show up on this page.'));
    }
    if (stamp) view.append(stamp);
  });

  /* ------------------------------------------------------------ chrome */
  /* The profile sheet: everything the header used to carry as icons. */
  function closeSheet() {
    document.getElementById('phSheet')?.remove();
  }

  const openSheet = guard('sheet', function openSheet() {
    closeSheet();
    const sheet = make('div', 'ph-sheet');
    sheet.id = 'phSheet';
    const card = make('div', 'ph-sheet-card');
    const who = make('div', 'ph-sheet-who');
    who.append(make('span', 'ph-sheet-avatar', document.getElementById('chipAvatar')?.textContent || ''));
    who.append(make('span', 'ph-sheet-name', profiles.current?.name || ''));
    card.append(make('div', 'ph-sheet-grip'), who);

    const item = (label, run, note) => {
      const b = make('button', 'ph-sheet-item');
      b.type = 'button';
      b.append(make('span', '', label));
      if (note) b.append(make('span', 'ph-sheet-note', note));
      b.addEventListener('click', () => { closeSheet(); run(); });
      card.append(b);
    };
    const press = (id) => () => document.getElementById(id)?.click();
    const shown = (id) => {
      const n = document.getElementById(id);
      return n && !n.hidden;
    };

    item('Favorites', () => { location.hash = '#/favorites'; });
    const dl = document.getElementById('tabDlCount');
    item('Downloads', () => { location.hash = '#/downloads'; }, dl && !dl.hidden ? dl.textContent : '');
    if (reporter.isOwner()) item('Archive', () => { location.hash = '#/archive'; });
    item('Wrapped', () => { location.hash = '#/wrapped'; });
    if (shown('healthBtn')) item('Control panel', press('healthBtn'));
    if (shown('reportBtn')) item('Report a problem', press('reportBtn'));
    item('This device', press('touchToggle'));
    item('Switch profile', () => { switching = true; document.getElementById('profileChip').click(); });

    sheet.append(card);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
    document.body.append(sheet);
  });

  /* The chip opens the sheet on a phone; the sheet's own Switch profile lets
     the original handler through. */
  let switching = false;
  document.getElementById('profileChip')?.addEventListener('click', (e) => {
    if (!phone() || switching) { switching = false; return; }
    e.stopImmediatePropagation();
    e.preventDefault();
    openSheet();
  }, true);

  /* Search as a tab: the header's own field, brought down over the bar. */
  const searching = (on) => {
    document.body.classList.toggle('ph-searching', on);
    const input = document.getElementById('searchInput');
    if (on && input) input.focus();
  };

  const fitTabBar = guard('tabbar', function fitTabBar() {
    const bar = document.getElementById('tabBar');
    if (!bar || bar.dataset.ph) return;
    bar.dataset.ph = '1';
    const home = make('a');
    home.href = '#/home';
    home.dataset.tab = 'home';
    home.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg><span>Home</span>';
    bar.prepend(home);
    const find = make('a');
    find.href = '#';
    find.dataset.tab = 'search';
    find.className = 'ph-search-tab';
    find.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><span>Search</span>';
    find.addEventListener('click', (e) => { e.preventDefault(); searching(true); });
    bar.append(find);
    // Any other tab closes the search field, keeping whatever it found only
    // until somewhere else is chosen.
    for (const link of bar.querySelectorAll('a:not(.ph-search-tab)')) {
      link.addEventListener('click', () => searching(false));
    }

    const cancel = make('button', 'ph-search-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      const input = document.getElementById('searchInput');
      if (input && input.value) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      searching(false);
    });
    document.querySelector('.header-actions')?.append(cancel);
  });

  /* ------------------------------------------------------------- hooks */
  /* After desktop.js has had its turn, so this is the last word on home. */
  const after = guard('after', function after() {
    fitTabBar();
    if (!phone()) {
      document.getElementById('homeView')?.classList.remove('ph-home');
      return;
    }
    if (state.tab === 'home') buildHome();
    else document.getElementById('homeView')?.classList.remove('ph-home');
  });

  const appRender = window.render;
  window.render = function () {
    const out = appRender.apply(this, arguments);
    after();
    return out;
  };
  const appRenderHome = window.renderHome;
  window.renderHome = function () {
    const out = appRenderHome.apply(this, arguments);
    after();
    return out;
  };

  /* desktop.js asks this before drawing its own home, so the phone never
     builds a billboard (and never opens its muted stream) only to throw it
     away. */
  window.phoneHome = { on: phone };
  fitTabBar();
})();
