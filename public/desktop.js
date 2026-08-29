/* ==========================================================================
   Treasure Theater — the desktop portal's own behaviour.

   Loaded after app.js and layered on top of it. Nothing in here replaces a
   render function: app.js still owns what is on the page and where the data
   came from, and this decorates the result afterwards. That is deliberate —
   a redesign that forks the rendering is a second copy of the library logic
   to keep in step, and the first provider change would put the two out of it.

   Every entry point is wrapped in a guard. A fault in here paints a worse
   page; it must never take the portal down with it, so a throw is logged and
   swallowed rather than left to stop app.js mid-render.

   The whole layer is inert unless `html.desk` is set, which happens only in
   desktop layout on a window wide enough to hold the design. The phone and
   iPad keep the layout they have.
   ========================================================================== */

(function () {
  'use strict';

  const root = document.documentElement;
  const $$ = (sel, host) => Array.from((host || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  /* Superscript encoding marks off a category name, for display only. app.js
     owns the rule; this reads it rather than keeping a second copy of it. */
  const catName = (n) => (window.cleanCatName ? window.cleanCatName(n) : String(n || ''));

  /* Anything that touches the DOM goes through this. See the note above. */
  const guard = (label, fn) => function () {
    try {
      return fn.apply(this, arguments);
    } catch (err) {
      console.error(`[desktop] ${label}:`, err);
      return undefined;
    }
  };

  /* ---------------------------------------------------------------- icons */
  /* The portal's own glyphs, on the terms the whole set is drawn on: a 24
     box, 1.7 stroke, round caps and joins. They are also on disk as files in
     /icons, which is where anything outside this file should take them from.
     Inline here because these are written into markup strings. */
  const ICON = {
    play: '<svg class="solid" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.9l6.1-.8z"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
    sort: '<svg viewBox="0 0 24 24"><path d="M4 7h13M4 12h9M4 17h5M17 12v7M17 19l3-3M17 19l-3-3"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-10"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6z"/><path d="M12 14v7"/></svg>',
    pinF: '<svg viewBox="0 0 24 24"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6z" fill="currentColor" stroke="none"/><path d="M12 14v7"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.9-9.3-9.2C1.3 8.4 3.2 5 6.6 5c2 0 3.5 1.2 4.4 2.4l1 1.3 1-1.3C13.9 6.2 15.4 5 17.4 5c3.4 0 5.3 3.4 3.9 6.8C19.5 16.1 12 21 12 21z"/></svg>',
    heartF: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.9-9.3-9.2C1.3 8.4 3.2 5 6.6 5c2 0 3.5 1.2 4.4 2.4l1 1.3 1-1.3C13.9 6.2 15.4 5 17.4 5c3.4 0 5.3 3.4 3.9 6.8C19.5 16.1 12 21 12 21z" fill="currentColor" stroke="none"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.1"/></svg>',
    bin: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
    /* The two live-only controls, drawn the same as their originals in the
       content header so moving them into the bar does not also restyle them. */
    listings: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1.5"/>'
      + '<path d="M3 9h18M9 9v11M14 9v11"/></svg>',
    /* The two sports, as the shapes of their balls — which is the whole of
       what the switch has to say and needs no words to say it. */
    football: '<svg viewBox="0 0 24 24"><path d="M4.4 19.6c-1.6-4.6.3-10.6 4-14.2 3.6-3.7 9.6-5.6 '
      + '14.2-4 1.6 4.6-.3 10.6-4 14.2-3.6 3.7-9.6 5.6-14.2 4z"/><path d="M9 15l6-6M11 12.5l1.5 '
      + '1.5M12.5 11l1.5 1.5"/></svg>',
    baseball: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/>'
      + '<path d="M6.2 5.5C8.4 7.6 9.6 10.4 9.6 12s-1.2 4.4-3.4 6.5M17.8 5.5c-2.2 2.1-3.4 '
      + '4.9-3.4 6.5s1.2 4.4 3.4 6.5"/></svg>',
    /* College. A cap rather than a third ball, because it is the same ball. */
    cap: '<svg viewBox="0 0 24 24"><path d="M12 4L2 9l10 5 10-5-10-5z"/>'
      + '<path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5M20 10v5"/></svg>',
  };


  /* ================================================================= gate */
  /* Whether this layer has started. Everything below asks it rather than
     re-deriving anything from the window; it goes true once and stays true.
   *
   * It used to be a real gate — `!touch && innerWidth >= 1100` — and it asked
   * two wrong questions. `!touch` disqualified an iPad for being TOUCHED rather
   * than for being small. The width disqualified a phone outright, which left
   * the phone on a design this one had moved on from: the same library and the
   * same facts, drawn a second way and kept in step by hand.
   *
   * The portal design is the design now, on a phone as much as on a desktop.
   * What varies by screen is chrome — `body.has-tabbar` puts the sections in a
   * bottom bar, and the breakpoints in desktop.css take the header from 1440
   * down to a phone. Both are questions about width and both are answered in
   * the stylesheet, which is where a question about width belongs. Nothing
   * here needs to know, and there is no longer a way back out: the teardown
   * that used to hand the page back to app.js went with the gate.
   */
  let on = false;

  const applyGate = guard('gate', function applyGate() {
    if (on) return;
    on = true;
    root.classList.add('desk');
    liftHeader();
    decorate();
  });


  /* =============================================================== header */
  /* Dark glass, always.
   *
   * This used to be two bars: a crimson plate at the top of the page that
   * turned to glass as soon as anything scrolled. Two bars is one too many —
   * the wordmark changed colour and size, the selected tab changed fill, and
   * the whole thing moved every time somebody nudged the page. The glass one
   * is the one worth keeping, so it is simply the bar now, and `lifted` is
   * set once when the layer comes up rather than being toggled by a scroll
   * position. The phone shell overrides it back to a solid field — see the
   * has-tabbar block in desktop.css — because glass is for a bar with a
   * picture running underneath it, and there it is a row in a column with
   * nothing behind it. */
  function liftHeader() {
    const hdr = document.querySelector('.site-header');
    if (hdr) hdr.classList.toggle('lifted', on);
  }

  addEventListener('scroll', () => {
    if (!on) return;
    spyCategories();
  }, { passive: true });

  addEventListener('resize', () => {
    applyGate();
    if (on) syncArrows();
  });


  /* ================================================================ cards */
  /* app.js builds the card; this adds the three things the design puts on a
     poster that a grid of static posters cannot have — the sheen, the hover
     actions, and the rating line under it.

     The item itself is stashed on the element by the cardFor wrapper at the
     bottom of this file, so the actions here act on the real title rather
     than on whatever its name could be looked up as. */
  function decorateCard(card) {
    if (card.dataset.dk) return;
    card.dataset.dk = '1';

    const art = card.querySelector('.card-art');
    if (!art) return;

    const sheen = document.createElement('span');
    sheen.className = 'card-sheen';
    sheen.dataset.dkOwned = '1';
    art.append(sheen);

    const item = card.__ttItem;
    /* A channel tunes straight in and there is nothing to queue or save, so
       it gets no overlay: three buttons that all mean "play" is worse than
       none. */
    if (!item || item.kind === 'live') return;

    const over = document.createElement('span');
    over.className = 'card-over';
    over.dataset.dkOwned = '1';

    const act = (label, html, ghost, fn) => {
      const b = document.createElement('span');
      b.setAttribute('role', 'button');
      b.setAttribute('tabindex', '0');
      b.setAttribute('aria-label', label);
      b.title = label;
      if (ghost) b.className = 'ghost';
      b.innerHTML = html;
      const run = (event) => {
        event.stopPropagation();
        event.preventDefault();
        fn();
      };
      b.addEventListener('click', run);
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') run(e);
      });
      over.append(b);
    };

    act('Play', ICON.play, false, () => openTitle(item));

    const favLabel = profiles.hasFav(item) ? 'Remove from favorites' : 'Add to favorites';
    act(favLabel, ICON.plus, true, () => {
      const added = profiles.toggleFav(item);
      toast(added ? 'Added to favorites.' : 'Removed from favorites.');
    });

    /* Films only. A show is saved an episode or a season at a time, from its
       own page, and the archive is already on the box. */
    if (item.kind === 'movie' && !item.archivePath && !item.localOnly) {
      act('Save to the box', ICON.down, true, () => requestDownload(item));
    }

    art.append(over);

    /* The rating sits under the poster with the year, set as the kit draws
       it — a filled star in the warm tone, tabular figures. app.js writes a
       plain "★ 7.4" into .card-sub, which is the same fact in a shape the
       design does not use. */
    const year = yearOf(item);
    const sub = card.querySelector('.card-sub');
    if (sub && item.rating) {
      sub.innerHTML = `<span class="rate">${ICON.star}${esc(item.rating)}</span>`
        + (year ? `<span>${year}</span>` : '');
    } else if (!sub && year) {
      /* app.js writes no sub-line at all without a rating, but the year on
         its own is still worth the line — it is most of what tells two
         prints of the same film apart. */
      const line = document.createElement('p');
      line.className = 'card-sub';
      line.dataset.dkOwned = '1';
      line.innerHTML = `<span>${year}</span>`;
      card.append(line);
    }
  }

  function decorateCards() {
    for (const card of $$('#appView .card')) decorateCard(card);
    const slabs = onSeriesBrowse();
    if (slabs) for (const card of $$('#rowsView .card, #grid .card')) slab(card);
    /* A slab is more than twice a poster's width, so the grid that holds them
       has to be told; posters and slabs in the same track sizing is what
       makes a mixed page look broken. */
    $('#grid')?.classList.toggle('is-series-slabs', slabs);
  }

  const onSeriesBrowse = () =>
    state.tab === 'series' && !state.query && !state.seriesId;

  /* ---------------------------------------------------------- show slabs */
  /* A show is not a film, so it does not get a film's card. A poster tells
     you nothing you need about a series you are three seasons into — what
     matters is how many seasons there are, which one you are in, and what
     plays next. So the artwork shrinks to a thumbnail and the row carries
     the facts instead.

     Built by rearranging the card app.js already made rather than by
     replacing it, so .card, .card-art and .card-title still mean what every
     other part of the portal expects them to mean. */
  function slab(card) {
    if (card.dataset.dkSlab) return;
    const item = card.__ttItem;
    if (!item || item.kind !== 'series') return;
    card.dataset.dkSlab = '1';
    card.classList.add('show-slab');

    const info = document.createElement('span');
    info.className = 'slab-info';
    info.dataset.dkOwned = '1';
    for (const node of [card.querySelector('.card-title'), card.querySelector('.card-sub')]) {
      if (node) info.append(node);
    }

    const watching = (state.recentlyWatched || [])
      .find((r) => String(r.seriesId ?? r.id) === String(item.id));

    /* Season counts come from the provider a show at a time. Whatever the
       portal has already fetched is used; nothing is fetched to draw a card,
       because that would be one provider call per slab on a page of forty
       and the box has one connection to spend. */
    const cached = state.seriesCache?.[item.id];
    const seasons = cached?.seasons?.length
      || (Array.isArray(cached) ? new Set(cached.map((e) => e.season)).size : 0)
      || (watching?.season || 0);

    if (seasons > 1) {
      const here = watching?.season || 0;
      const pips = document.createElement('span');
      pips.className = 'slab-pips';
      pips.innerHTML = Array.from({ length: Math.min(seasons, 9) }, (_, i) =>
        `<i class="${i + 1 < here ? 'seen' : i + 1 === here ? 'here' : ''}"></i>`).join('');
      info.append(pips);
    }

    const up = document.createElement('span');
    up.className = 'slab-up';
    up.innerHTML = watching
      ? `<b>NEXT</b><span>S${watching.season} E${watching.episode}`
        + `${watching.name ? ' · ' + esc(watching.name) : ''}</span>`
      : '<b>START</b><span>Season 1, episode 1</span>';
    info.append(up);

    const tags = [item.genre, item.uhd ? '4K' : null].filter(Boolean);
    if (tags.length) {
      const strip = document.createElement('span');
      strip.className = 'slab-tags';
      strip.innerHTML = tags.map((t) =>
        `<u class="${t === '4K' ? 'uhd' : ''}">${esc(t)}</u>`).join('');
      info.append(strip);
    }

    card.append(info);
  }


  /* ================================================================ rails */
  /* app.js already tweens the rails and dims their arrows; the design only
     changes when the arrows are visible, which is CSS. This keeps the dimmed
     state honest after anything re-lays a rail out. */
  function syncArrows() {
    for (const rail of $$('#appView .rail')) {
      const track = rail.querySelector('.rail-track');
      if (!track) continue;
      const max = track.scrollWidth - track.clientWidth - 8;
      rail.querySelector('.rail-nav.prev')?.classList.toggle('is-off', track.scrollLeft < 8);
      rail.querySelector('.rail-nav.next')?.classList.toggle('is-off', track.scrollLeft >= max);
    }
  }


  /* ======================================================== category bar */
  /* The sticky bar that is the whole point of a library this size. It is a
     direct child of <body>, not of the page: a sticky element can only
     travel inside its own parent, and a wrapper exactly as tall as the bar
     has no slack to travel in — it leaves with the content. */

  let catbar = null;
  let sheet = null;
  /* Which category the page is showing as a grid, or null on the rows. This
     is the desktop layer's own view state; app.js keeps its own idea of the
     open category and the two are kept in step through it, never around it. */
  let openCat = null;

  function catId(name) {
    return 'dkcat-' + String(name).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }

  function ensureCatbar() {
    if (catbar && document.body.contains(catbar)) return catbar;
    catbar = document.createElement('div');
    catbar.id = 'dkCatbar';
    catbar.dataset.dkOwned = '1';
    catbar.innerHTML = `<div class="inner">
      <div class="strip"><div class="chips" id="dkChips"></div><span class="fade"></span></div>
      <div class="ctrl">
        <button type="button" class="dk-allbtn" id="dkAllBtn">${ICON.grid}All categories</button>
        <label class="dk-sel">${ICON.sort}<select id="dkSortSel"></select></label>
        <div class="dk-seg" id="dkViewSeg">
          <button type="button" class="on" data-v="rows">Rows</button>
          <button type="button" data-v="grid">Grid</button>
        </div>
        <!-- Live TV's two controls, standing where the sort and the view
             toggle stand on the catalogue pages. Neither is a new feature:
             both are the buttons app.js already draws in the content header,
             pressed from here instead, because the header is where the scores
             row lives now. The originals stay in the markup and keep their
             handlers — this bar borrows them rather than reimplementing
             them. -->
        <button type="button" class="dk-ctrl" id="dkMvBtn" hidden>${ICON.grid}Multi-view</button>
        <button type="button" class="dk-ctrl" id="dkListingsBtn" hidden>${ICON.listings}<span>Listings</span></button>
        <!-- Which slate the head is showing. Two sports, one band: a row that
             tried to carry both would be a dozen baseball games with two
             football ones lost in the middle of them. -->
        <div class="dk-seg dk-sport" id="dkSportSeg" hidden>
          <button type="button" data-sport="nfl" title="Football" aria-label="Football">${ICON.football}</button>
          <button type="button" data-sport="mlb" title="Baseball" aria-label="Baseball">${ICON.baseball}</button>
          <button type="button" data-sport="ncaaf" title="College football"
                  aria-label="College football">${ICON.cap}</button>
        </div>
      </div>
    </div>`;
    document.querySelector('.site-header').after(catbar);
    return catbar;
  }

  function ensureSheet() {
    if (sheet && document.body.contains(sheet)) return sheet;
    sheet = document.createElement('div');
    sheet.id = 'dkSheet';
    sheet.dataset.dkOwned = '1';
    sheet.innerHTML = `<div class="sheet-card">
      <h2>All categories</h2>
      <p class="lead" id="dkSheetLead"></p>
      <label class="field">${ICON.search}<input id="dkCatQ" placeholder="Filter categories…" autocomplete="off"></label>
      <div class="list" id="dkCatList"></div>
    </div>`;
    document.body.append(sheet);

    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) closeSheet();
    });
    sheet.querySelector('#dkCatQ').addEventListener('input', fillSheet);
    return sheet;
  }

  function closeSheet() {
    sheet?.classList.remove('open');
  }

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  /* Rails mode: the bar marks whichever category you have scrolled into, and
     scrolls itself so that mark stays where it can be read. */
  const spyCategories = guard('scroll-spy', function spyCategories() {
    if (!on || !catbar || openCat) return;
    const chips = catbar.querySelector('#dkChips');
    if (!chips) return;

    let best = null;
    let bestDistance = Infinity;
    for (const shelf of $$('#appView .shelf')) {
      const d = Math.abs(shelf.getBoundingClientRect().top - 130);
      if (d < bestDistance) { bestDistance = d; best = shelf; }
    }
    if (!best) return;

    const name = best.dataset.dkCat;
    for (const chip of chips.children) {
      const active = !!name && chip.dataset.c === name;
      chip.classList.toggle('on', active);
      if (active && chip.offsetParent) {
        const cb = chip.getBoundingClientRect();
        const sb = chips.getBoundingClientRect();
        if (cb.left < sb.left + 8 || cb.right > sb.right - 8) {
          chips.scrollTo({ left: chips.scrollLeft + (cb.left - sb.left) - 60, behavior: 'smooth' });
        }
      }
    }
  });


  /* ------------------------------------------------------------ sorting */
  /* The provider ships no release year of its own, but it is in the title on
     nearly everything — "Heat (1995)", "95.The.Hunt.2012" — which is where
     the sort takes it from. A title without one sorts last rather than as
     year zero, so an unparsed name does not lead "newest first". */
  function yearOf(item) {
    if (item.__ttYear !== undefined) return item.__ttYear;
    const hit = String(item.name || '').match(/(?:^|[^\d])((?:19|20)\d\d)(?:[^\d]|$)/);
    item.__ttYear = hit ? Number(hit[1]) : 0;
    return item.__ttYear;
  }

  /* The kit's sort control, with one option in front of it that the kit had
     no need for. Its rows were a provider dump and "Recently added" was as
     good a default as any; the portal's rows are built — New Releases is
     already in date order, the rest are shuffled per visit precisely so that
     a capped shelf is not the same forty posters forever, and Continue
     watching is in the order things were watched. Sorting all of that by
     date on arrival throws away work the box did on purpose. So the default
     leaves the rows as the box built them, and every sort below is a choice
     the viewer makes. */
  const SORTS = {
    Recommended: null,
    'Recently added': (a, b) => (b.added || 0) - (a.added || 0),
    'Rating, high to low': (a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0),
    'Title, A to Z': (a, b) => String(a.name).localeCompare(String(b.name)),
    'Year, newest first': (a, b) => (yearOf(b) || -Infinity) - (yearOf(a) || -Infinity),
    'Year, oldest first': (a, b) => (yearOf(a) || Infinity) - (yearOf(b) || Infinity),
  };

  let sortBy = 'Recommended';

  /* Sorting is done to the data, not to the cards, so that opening a row out
     into its full grid keeps the order the row was in. app.js builds the
     shelves; this reorders what it built. */
  const appBuildShelves = window.buildShelves;
  window.buildShelves = function () {
    const rows = appBuildShelves.apply(this, arguments);
    const sorter = SORTS[sortBy];
    if (!on || !sorter) return rows;
    return rows.map((row) => ({ ...row, items: [...row.items].sort(sorter) }));
  };


  /* ------------------------------------------------- the bar, per page */
  /* cfg: { cats:[{name,count,onOpen,pinned,catId}], lead, allLabel, sorts,
            sortValue, onSort, onView, view, pinnable } */
  let barConfig = null;

  function buildCatbar(cfg) {
    barConfig = cfg;
    barTab = state.tab;
    const bar = ensureCatbar();
    ensureSheet();
    bar.hidden = false;
    const shell = document.querySelector('.app-shell');
    shell?.classList.add('has-catbar');
    /* The bar replaced the sidebar, and two ways to pick a category is one
       too many. app.js drops the column by itself on the pages that browse
       as rows; opening one category is where it puts the column back, and on
       this layout that is the moment the bar is being used to move between
       them. */
    shell?.classList.add('no-sidebar');

    /* Two sets of controls in one bar, and a page gets one of them.
     *
     * The catalogue pages sort and switch between rows and a grid. Live TV
     * does neither — a channel has no year, no rating and no date it was
     * added, so its "sort" was two options one of which was the provider's
     * own order, and its view toggle duplicated what opening a category
     * already does. Both are gone from that page, and the space they held is
     * where multi-view and the listings live now. */
    const live = Boolean(cfg.live);
    bar.querySelector('.dk-sel').hidden = live;
    bar.querySelector('#dkViewSeg').hidden = live;
    bar.querySelector('#dkMvBtn').hidden = !live;
    const listings = bar.querySelector('#dkListingsBtn');
    listings.hidden = !live;
    const sports = bar.querySelector('#dkSportSeg');
    sports.hidden = !live;
    for (const b of sports.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.sport === scoreSport());
    }

    if (!live) {
      const sel = bar.querySelector('#dkSortSel');
      const wantSorts = cfg.sorts.join('|');
      if (sel.dataset.dkSorts !== wantSorts) {
        sel.dataset.dkSorts = wantSorts;
        sel.innerHTML = cfg.sorts.map((s) => `<option>${esc(s)}</option>`).join('');
      }
      sel.value = cfg.sortValue;
      for (const b of bar.querySelectorAll('#dkViewSeg button')) {
        b.classList.toggle('on', b.dataset.v === cfg.view);
      }
    } else {
      /* The listings button says whether they are on, and the original is
         the thing that knows. Read rather than tracked, so this cannot drift
         out of step with the button it presses. */
      const source = document.querySelector('#listingsLabel');
      listings.querySelector('span').textContent = source ? source.textContent : 'Listings';
      listings.classList.toggle('on',
        document.querySelector('#listingsBtn')?.classList.contains('is-on') || false);
    }

    bar.querySelector('#dkAllBtn').lastChild.textContent = cfg.allLabel;

    drawChips();
  }

  function drawChips() {
    if (!barConfig) return;
    const chips = catbar?.querySelector('#dkChips');
    if (!chips) return;
    chips.innerHTML = barConfig.cats.map((c) => {
      /* Every chip gets a pin, not just the pinned ones.
         The mark was only ever shown once a category WAS pinned, which left
         no way to pin one from the bar — the only place it could be done was
         a shelf heading you had to scroll to, or a sidebar this layout does
         not have. */
      const can = c.catId != null;
      const mark = can
        ? `<span class="chip-pin${c.pinned ? ' on' : ''}" role="button" tabindex="-1"
            title="${c.pinned ? 'Unpin' : 'Pin to the front'}"
            aria-label="${c.pinned ? 'Unpin' : 'Pin to the front'}">${c.pinned ? ICON.pinF : ICON.pin}</span>`
        : '';
      return `<button type="button" class="catchip${c.pinned ? ' pinned' : ''}"`
        + ` data-c="${esc(c.name)}"${can ? ` data-cat-id="${esc(c.catId)}"` : ''}`
        + ` title="${c.pinned ? 'Pinned — drag to reorder' : ''}">`
        + `${mark}${esc(catName(c.name))}<b>${num(c.count)}</b></button>`;
    }).join('');
  }

  function hideCatbar() {
    barConfig = null;
    if (catbar) catbar.hidden = true;
    document.querySelector('.app-shell')?.classList.remove('has-catbar');
    closeSheet();
  }

  /*
   * The bar belongs to the page it was built for.
   *
   * It is rebuilt on every render, which is almost always immediate — but a
   * tab whose library has to be fetched first renders late, and until it does
   * the previous page's bar is still standing. That was survivable while every
   * page's bar held the same three controls: a sort and a view toggle on a
   * page that had not drawn yet is furniture. It stopped being survivable when
   * Live TV's bar started carrying multi-view and the listings, because those
   * two mean nothing on Movies and offering them there is a button that lies.
   *
   * So the bar is taken down the moment the page changes, and the render that
   * follows puts up the right one. Cheaper than making it correct, and there
   * is nothing on the bar worth looking at for a page that is not there yet.
   */
  let barTab = '';
  /* Read off the hash rather than off state.tab: both app.js and this file
     listen for the same event, and which of them runs first is a question
     about script order that this does not need to have an opinion about. */
  const tabFromHash = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'home');
  addEventListener('hashchange', () => {
    if (!on || !catbar || catbar.hidden) return;
    if (tabFromHash() !== barTab) hideCatbar();
  });

  /*
   * Every category, with a pin on it and a place in the order.
   *
   * The sheet used to be a way to JUMP to a category and nothing else: the
   * only place a category could be pinned was a chip in the bar, which shows
   * the pinned ones and whichever few fit after them, or a shelf heading you
   * had to scroll to. With ninety categories that means the pinning happens
   * where the categories aren't.
   *
   * Dragging writes the pin order, which is the order the bar and the rows are
   * drawn in — and dragging a category that is not pinned PINS it where it was
   * dropped, because dragging something into your arrangement is the same
   * sentence as wanting it there. Unpinned categories keep the provider's own
   * order behind the pinned run; there is nothing else to sort a channel
   * category by that the provider gives us.
   */
  function fillSheet() {
    if (!barConfig || !sheet) return;
    const q = sheet.querySelector('#dkCatQ').value.trim().toLowerCase();
    const hits = barConfig.cats.filter((c) => c.name.toLowerCase().includes(q));
    sheet.querySelector('#dkSheetLead').textContent = barConfig.lead;

    const list = sheet.querySelector('#dkCatList');
    list.classList.toggle('pinnable', Boolean(barConfig.pinnable));
    if (!hits.length) {
      list.innerHTML = '<p class="none">No category matches that.</p>';
      return;
    }
    list.innerHTML = hits.map((c) => {
      const can = barConfig.pinnable && c.catId != null;
      const mark = can
        ? `<span class="row-pin${c.pinned ? ' on' : ''}" role="button" tabindex="-1"
            title="${c.pinned ? 'Unpin' : 'Pin to the front'}"
            aria-label="${c.pinned ? 'Unpin' : 'Pin to the front'}"
            >${c.pinned ? ICON.pinF : ICON.pin}</span>`
        : '';
      return `<button type="button" class="cat-row${c.pinned ? ' pinned' : ''}"`
        + ` data-c="${esc(c.name)}"${can ? ` data-cat-id="${esc(c.catId)}"` : ''}>`
        + `${mark}<span class="cat-row-name">${esc(catName(c.name))}</span>`
        + `<b>${num(c.count)}</b></button>`;
    }).join('');
  }

  /* ------------------------------------------- dragging the sheet's grid */
  /*
   * The same gesture as the chips, in two dimensions: the sheet lays its rows
   * out as a wrapping grid, so the neighbour a row belongs before is decided
   * by the pointer's position against each box's CENTRE — both axes, not just
   * the horizontal one the bar can get away with.
   *
   * Pointer events rather than HTML5 drag-and-drop, for the reason the chips
   * give: iOS Safari does not implement drag-and-drop, and this layer runs the
   * phone shell too.
   */
  let sheetDrag = null;
  let sheetPointer = null;
  let sheetFrom = { x: 0, y: 0 };
  let sheetMoved = false;

  const sheetRows = () => $$('#dkCatList .cat-row');

  const onSheetMove = guard('sheetdrag', (e) => {
    if (sheetPointer !== e.pointerId || !sheetDrag) return;
    if (!sheetMoved) {
      if (Math.hypot(e.clientX - sheetFrom.x, e.clientY - sheetFrom.y) < 6) return;
      sheetMoved = true;
      sheetDrag.classList.add('ghosting');
      document.body.classList.add('is-reordering');
    }

    const others = sheetRows().filter((r) => r !== sheetDrag);
    if (!others.length) return;

    /* The row whose centre the pointer has passed, reading the grid the way
       it is laid out — down the rows, then across each one. */
    let at = others.findIndex((other) => {
      const box = other.getBoundingClientRect();
      if (e.clientY < box.top) return true;
      if (e.clientY > box.bottom) return false;
      return e.clientX < box.left + box.width / 2;
    });
    if (at === -1) at = others.length;

    const before = others[at] || null;
    if (before) {
      if (sheetDrag.nextElementSibling !== before) before.before(sheetDrag);
    } else {
      const last = others[others.length - 1];
      if (last.nextElementSibling !== sheetDrag) last.after(sheetDrag);
    }
  });

  const endSheetDrag = guard('sheetdrag', (e) => {
    if (sheetPointer !== e.pointerId) return;
    sheetPointer = null;
    window.removeEventListener('pointermove', onSheetMove);
    window.removeEventListener('pointerup', endSheetDrag);
    window.removeEventListener('pointercancel', endSheetDrag);

    const row = sheetDrag;
    sheetDrag = null;
    if (!sheetMoved || !row) return;         // a tap: the click handler has it
    sheetMoved = false;
    row.classList.remove('ghosting');
    document.body.classList.remove('is-reordering');
    draggedAt = Date.now();

    /* Everything above the last pinned row is now pinned, in this order.
       Dropping an unpinned category into the arrangement is what pins it —
       and a pinned one dragged below the run is what takes it out. */
    const rows = sheetRows();
    const lastPinned = rows.reduce(
      (at, r, i) => (r.classList.contains('pinned') ? i : at), -1
    );
    const order = rows.slice(0, lastPinned + 1)
      .map((r) => r.dataset.catId).filter(Boolean);

    const tab = state.tab;
    const wanted = new Set(order);
    for (const id of order) if (!profiles.isPinned(tab, id)) profiles.togglePin(tab, id);
    for (const id of profiles.pinOrder(tab)) {
      if (!wanted.has(String(id))) profiles.togglePin(tab, id);
    }
    if (order.length) profiles.setPinOrder(tab, order);
    render();
    fillSheet();
  });

  document.addEventListener('pointerdown', guard('sheetdrag', (e) => {
    if (!on || !barConfig?.pinnable || e.button > 0) return;
    const row = e.target.closest?.('#dkCatList .cat-row');
    if (!row) return;
    // The pin is a control, not a handle: pressing it must toggle, not drag.
    if (e.target.closest('.row-pin')) return;
    sheetDrag = row;
    sheetPointer = e.pointerId;
    sheetFrom = { x: e.clientX, y: e.clientY };
    sheetMoved = false;
    try { row.setPointerCapture(e.pointerId); } catch { /* the window
      listeners below are a working drag without it */ }
    window.addEventListener('pointermove', onSheetMove);
    window.addEventListener('pointerup', endSheetDrag);
    window.addEventListener('pointercancel', endSheetDrag);
  }));

  /* One delegated handler for the bar and the sheet alike. */
  document.addEventListener('click', guard('bar-click', (e) => {
    if (!on || !barConfig) return;

    if (e.target.closest('#dkAllBtn')) {
      ensureSheet().classList.add('open');
      fillSheet();
      sheet.querySelector('#dkCatQ').focus();
      return;
    }

    const seg = e.target.closest('#dkViewSeg button');
    if (seg && barConfig.onView) return barConfig.onView(seg.dataset.v);

    /* The two borrowed buttons. Pressed here, handled there — app.js owns
       what multi-view and the listings actually do, and a second copy of
       either would be a second thing to keep in step. */
    if (e.target.closest('#dkMvBtn')) {
      document.querySelector('#multiviewBtn')?.click();
      return undefined;
    }
    if (e.target.closest('#dkListingsBtn')) {
      document.querySelector('#listingsBtn')?.click();
      return undefined;
    }
    const sport = e.target.closest('#dkSportSeg button');
    if (sport) {
      setScoreSport(sport.dataset.sport);
      return undefined;
    }

    const chip = e.target.closest('.catchip');
    if (chip) {
      // The pin sits inside the chip, so it has to claim the click before the
      // chip reads it as "open this category".
      if (e.target.closest('.chip-pin') && chip.dataset.catId != null) {
        e.stopPropagation();
        e.preventDefault();
        profiles.togglePin(state.tab, chip.dataset.catId);
        render();
        return undefined;
      }
      return pickCategory(chip.dataset.c);
    }

    const row = e.target.closest('#dkCatList button[data-c]');
    if (row) {
      // The pin sits inside the row, so it has to claim the click before the
      // row reads it as "open this category".
      if (e.target.closest('.row-pin') && row.dataset.catId != null) {
        e.stopPropagation();
        e.preventDefault();
        profiles.togglePin(state.tab, row.dataset.catId);
        render();
        fillSheet();
        return undefined;
      }
      closeSheet();
      return pickCategory(row.dataset.c, true);
    }
  }));

  document.addEventListener('change', guard('bar-sort', (e) => {
    if (!on || !barConfig) return;
    if (e.target.id === 'dkSortSel') barConfig.onSort(e.target.value);
  }));

  /* In rows mode a chip is a way down the page; in grid mode it is a way
     into a category. Same chip, and which one it is is never ambiguous
     because the page is only ever in one of the two. */
  function pickCategory(name, force) {
    const cat = barConfig?.cats.find((c) => c.name === name);
    if (!cat) return;
    if (barConfig.view === 'grid' || force) return cat.onOpen();
    const row = document.getElementById(catId(name));
    if (row) scrollTo({ top: row.offsetTop - 118, behavior: 'smooth' });
    else cat.onOpen();
  }


  /* --------------------------------------------- pinned chips, dragged */
  /* Reordering happens in the bar, where the pins are read, rather than on a
     management screen somewhere else.

     Pointer events rather than HTML5 drag-and-drop, for the reason the README
     already gives about the sidebar's pins: iOS Safari does not implement
     drag-and-drop at all. This layer is desktop-only, but "desktop" here means
     the layout, not the hardware — an iPad in landscape is wide enough for it
     and can be set to it by hand, and there the whole gesture would silently
     do nothing. The three details that carry it are the same three: a
     threshold before a drag starts so a tap still works, the click at the end
     of a drag swallowed, and neighbours swapped at their midpoint rather than
     their edge so a chip settles instead of flickering on the boundary. */
  const CHIPS_SEL = '#dkChips .catchip.pinned';

  let dragChip = null;
  let dragPointer = null;
  let dragFrom = 0;
  let dragged = false;
  let draggedAt = 0;

  const pinnedChips = () => $$(CHIPS_SEL);

  document.addEventListener('pointerdown', guard('drag', (e) => {
    if (!on || !barConfig?.pinnable || e.button > 0) return;
    const chip = e.target.closest?.('.catchip.pinned');
    if (!chip || !chip.closest('#dkChips')) return;
    dragChip = chip;
    dragPointer = e.pointerId;
    dragFrom = e.clientX;
    dragged = false;
    try { chip.setPointerCapture(e.pointerId); } catch { /* a refused capture
      still leaves the window listeners below, which is a working drag */ }
    window.addEventListener('pointermove', onChipMove);
    window.addEventListener('pointerup', endChipDrag);
    window.addEventListener('pointercancel', endChipDrag);
  }));

  const onChipMove = guard('drag', (e) => {
    if (dragPointer !== e.pointerId || !dragChip) return;

    if (!dragged) {
      if (Math.abs(e.clientX - dragFrom) < 6) return;   // still a tap
      dragged = true;
      dragChip.classList.add('ghosting');
      document.body.classList.add('is-reordering');
    }

    // Put the chip where the pointer actually is, in one move: stepping past
    // one neighbour per event drops a quick drag short of where it was let go.
    const others = pinnedChips().filter((c) => c !== dragChip);
    if (!others.length) return;

    let at = others.findIndex((other) => {
      const box = other.getBoundingClientRect();
      return e.clientX < box.left + box.width / 2;
    });
    if (at === -1) at = others.length;

    const before = others[at] || null;
    if (before) {
      if (dragChip.nextElementSibling !== before) before.before(dragChip);
    } else {
      const last = others[others.length - 1];
      if (last.nextElementSibling !== dragChip) last.after(dragChip);
    }
  });

  const endChipDrag = guard('drag', (e) => {
    if (dragPointer !== e.pointerId) return;
    dragPointer = null;
    window.removeEventListener('pointermove', onChipMove);
    window.removeEventListener('pointerup', endChipDrag);
    window.removeEventListener('pointercancel', endChipDrag);

    const chip = dragChip;
    dragChip = null;
    if (!dragged || !chip) return;   // a tap: leave it to the click handler
    dragged = false;
    chip.classList.remove('ghosting');
    document.body.classList.remove('is-reordering');
    draggedAt = Date.now();

    /* Only the pinned run is reordered. The rest of the bar is the provider's
       own order and is not the user's to arrange. */
    const order = pinnedChips().map((c) => c.dataset.catId).filter(Boolean);
    if (order.length) profiles.setPinOrder('live', order);
    render();
  });

  /* Letting go fires a click on the chip, which would scroll the page to a
     category nobody asked for. A timestamp expires on its own; a one-shot
     listener would sit unused whenever a drag ended somewhere else and then
     eat the next genuine tap. */
  document.addEventListener('click', (e) => {
    if (Date.now() - draggedAt > 300) return;
    // A chip would scroll to a category nobody asked for; a channel card
    // would open the channel that happened to be under the finger when it
    // was let go, which is worse.
    if (!e.target.closest?.('.catchip, .cht, .cat-row')) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);


  /* ---------------------------------------------- dragging your channels */
  /*
   * The channel row is the one part of this library the viewer arranges
   * themselves, so it can be arranged: pick a card up and put it where you
   * want it. Modelled on the category chips above — the pointer decides the
   * position in one move rather than stepping past one neighbour per event,
   * because a quick drag delivers a handful of moves and stepping drops the
   * card one place from where it started however far the hand travelled.
   *
   * The order is stored as the favourites' own order, on the box, so a row
   * arranged on the desktop is the same row on the phone and on the Shield.
   */
  function makeReorderable(track) {
    if (!track) return;
    const cards = () => $$('.cht', track);

    let held = null;
    let pointer = null;
    let from = 0;
    let moved = false;

    const onMove = guard('chandrag', (e) => {
      if (pointer !== e.pointerId || !held) return;
      if (!moved) {
        if (Math.abs(e.clientX - from) < 6) return; // still a tap
        moved = true;
        held.classList.add('ghosting');
        document.body.classList.add('is-reordering');
      }
      const others = cards().filter((c) => c !== held);
      if (!others.length) return;
      let at = others.findIndex((other) => {
        const box = other.getBoundingClientRect();
        return e.clientX < box.left + box.width / 2;
      });
      if (at === -1) at = others.length;
      const before = others[at] || null;
      if (before) {
        if (held.nextElementSibling !== before) before.before(held);
      } else {
        const last = others[others.length - 1];
        if (last.nextElementSibling !== held) last.after(held);
      }
    });

    const finish = guard('chandrag', (e) => {
      if (pointer !== e.pointerId) return;
      pointer = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const card = held;
      held = null;
      if (!moved || !card) return;      // a tap: the click handler has it
      moved = false;
      card.classList.remove('ghosting');
      document.body.classList.remove('is-reordering');
      draggedAt = Date.now();
      profiles.setFavOrder(cards().map((c) => profiles.favKey(c.__ttItem)).filter(Boolean));
    });

    track.addEventListener('pointerdown', (e) => {
      const card = e.target.closest?.('.cht');
      if (!card || !track.contains(card)) return;
      /* The heart and the bin are buttons of their own; a press that starts on
         one of them is that button being pressed. The play badge is not — it
         is the card's own hover affordance, it sits over the middle of the
         plate, and excluding it would make most of the card undraggable. */
      if (e.target.closest('.fav, .dk-bin')) return;
      held = card;
      pointer = e.pointerId;
      from = e.clientX;
      moved = false;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
  }

  /* =================================================== movies and series */
  /* The shelves app.js already builds are the categories: they are the rows
     the page is made of, and a second list of "real" categories beside them
     would be two answers to the same question. */
  function buildCatalogueChrome(tab) {
    const rows = window.buildShelves(tab);
    if (!rows.length) return hideCatbar();

    const grid = state.shelf !== null;

    buildCatbar({
      view: grid ? 'grid' : 'rows',
      sorts: Object.keys(SORTS),
      sortValue: sortBy,
      allLabel: `All ${rows.length}`,
      lead: `${rows.length} in ${tab} — pick one to open it as a grid.`,
      pinnable: false,
      cats: rows.map((row) => ({
        name: row.title,
        count: row.items.length,
        onOpen: () => {
          state.shelf = row.title;
          state.visible = 60;
          render();
          scrollTo({ top: 0, behavior: 'smooth' });
        },
      })),
      onSort: (value) => { sortBy = value; render(); },
      onView: (v) => {
        if (v === 'grid') {
          state.shelf = state.shelf ?? rows[0].title;
        } else {
          state.shelf = null;
        }
        render();
        scrollTo({ top: 0, behavior: 'smooth' });
      },
    });

    if (tab === 'series' && !grid) buildUpNext();

    /* The scroll-spy needs to know which row is which, and the chip needs
       somewhere to scroll to. Both come off the same id. */
    for (const shelf of $$('#rowsView .shelf')) {
      if (shelf.id === 'dkUpNext') continue;   // a lane, not a category
      const name = shelf.querySelector('.shelf-title')?.textContent || '';
      shelf.dataset.dkCat = name;
      shelf.id = catId(name);
    }
    spyCategories();
  }


  /* The one thing a series library owes you on arrival: the next episode.
     Above the categories, because it is the answer to the question most
     visits to this page are actually asking. */
  function buildUpNext() {
    const rows = (state.recentlyWatched || []).filter((r) => r.kind === 'series');
    if (!rows.length) return;

    const lane = document.createElement('section');
    lane.className = 'shelf';
    lane.id = 'dkUpNext';
    lane.dataset.dkOwned = '1';
    lane.innerHTML = `
      <div class="shelf-head" role="presentation">
        <h2 class="shelf-title">Up next</h2>
        <span class="shelf-count">${rows.length} show${rows.length === 1 ? '' : 's'} in progress</span>
      </div>
      <div class="rail">
        <button type="button" class="rail-nav prev" aria-label="Scroll Up next left">${ICON.left}</button>
        <div class="rail-track"></div>
        <button type="button" class="rail-nav next" aria-label="Scroll Up next right">${ICON.chev}</button>
      </div>`;

    const track = lane.querySelector('.rail-track');
    rows.forEach((row, i) => {
      const pct = row.duration && row.position
        ? Math.min(100, Math.round((row.position / row.duration) * 100)) : 0;
      const left = row.duration && row.position
        ? Math.max(1, Math.round((row.duration - row.position) / 60)) : null;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'dk-ep';
      card.style.setProperty('--field', FIELDS[i % FIELDS.length]);
      card.innerHTML = `
        <span class="still">
          ${row.season && row.episode ? `<span class="se">S${row.season} E${row.episode}</span>` : ''}
          <span class="go"><span>${ICON.play}</span></span>
          <span class="nm">${esc(row.seriesName || row.name || '')}</span>
          ${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}
        </span>
        <span class="cap">${row.name ? `<span>${esc(row.name)}</span>` : ''}
          ${left ? `<s>${left} min left</s>` : ''}</span>`;
      card.addEventListener('click', () => playFromHistory(row));
      track.append(card);
    });

    $('#rowsView').prepend(lane);
    railPaging(lane);
  }


  /* ============================================================= Live TV */
  /* A wall of category squares is the thing this page was redesigned away
     from. The two ways this library actually gets navigated when nobody is
     searching are the structure instead: pinned categories ARE the bar, and
     favourited channels are the first row on the page. */
  function buildLivePage(rows) {
    const source = state.library.live;
    if (!source) return;

    const counts = new Map();
    for (const item of source.items) {
      const id = String(item.categoryId);
      counts.set(id, (counts.get(id) || 0) + 1);
    }

    const stocked = source.categories.filter((c) => counts.get(String(c.id)));
    seedLivePins(stocked);
    const live = stocked.filter((c) => !profiles.isDeletedCategory(c.id));

    const order = profiles.pinOrder('live');
    const pinned = live
      .filter((c) => profiles.isPinned('live', c.id))
      .sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
    const ordered = [...pinned, ...live.filter((c) => !profiles.isPinned('live', c.id))];

    const byCat = new Map();
    for (const item of source.items) {
      if (profiles.isDeleted(item)) continue;
      const id = String(item.categoryId);
      if (!byCat.has(id)) byCat.set(id, []);
      byCat.get(id).push(item);
    }

    /* The bar stays on both views. Opening a category is not leaving the
       page — the pins are still how you get to the next one, and taking them
       away at exactly the moment you are moving between categories is taking
       away the thing being used. */
    const open = ordered.find((c) => String(c.id) === String(state.category));
    buildCatbar({
      live: true,
      view: rows ? 'rows' : 'grid',
      sorts: [],
      allLabel: `All ${ordered.length}`,
      lead: `${ordered.length} categories. Pin the ones you use and drag them into `
        + 'the order you want — that is the order they lead the bar above in.',
      pinnable: true,
      cats: ordered.map((c) => ({
        name: c.name,
        catId: c.id,
        count: counts.get(String(c.id)) || 0,
        pinned: profiles.isPinned('live', c.id),
        onOpen: () => { state.category = String(c.id); render(); scrollTo({ top: 0, behavior: 'smooth' }); },
      })),
    });

    /* In grid mode app.js draws the channels itself, into the grid the
       category chose. Everything below here is the rows view. */
    if (!rows) {
      for (const chip of $$('#dkChips .catchip')) {
        chip.classList.toggle('active', !!open && chip.dataset.c === open.name);
      }
      return;
    }

    const grid = $('#grid');
    $('#emptyState').hidden = ordered.length > 0;
    $('#loadMore').hidden = true;

    /* The page's own head is the scores row now.
     *
     * "Live TV", set at 34px, over "24 pinned · 92 categories · 11,764
     * channels" — a title naming the page you just pressed to get to, and a
     * count of things nobody is going to act on. The band across the top of a
     * television page is worth more than that, and what it is worth is what
     * is on right now. */
    scoreboard();

    const host = document.createElement('div');
    host.id = 'dkLive';
    host.dataset.dkOwned = '1';
    grid.after(host);

    /* The provider's own order. There is nothing else to offer: a channel has
       no year, no rating and no date it was added, so the sort this page used
       to carry was a choice between the order the numbers came in and the
       alphabet — and the alphabet is what the bar and the sheet are for. */
    const favourites = profiles.favItems().filter((i) => i.kind === 'live');

    if (favourites.length) {
      /* The one the viewer built, in the order they put it in. */
      const mine = liveRail('Your channels',
        `${favourites.length} favorites · drag to reorder`, favourites, null);
      makeReorderable(mine.querySelector('.rail-track'));
      host.append(mine);
    }

    /* Nine rows, because past that the page is a scroll rather than a way in
       — the bar and the sheet are how you reach the rest. */
    for (const cat of ordered.slice(0, 9)) {
      const items = byCat.get(String(cat.id)) || [];
      if (!items.length) continue;
      host.append(liveRail(catName(cat.name), num(counts.get(String(cat.id)) || 0),
        items.slice(0, 14), cat));
    }

    /* The note about the starter pins fires from here rather than from
       renderLiveCategories, which no longer draws anything on this layout —
       and it has to come after the chips exist, since they are what it
       points at. */
    maybeExplainLivePins();
  }

  /* ============================================== what is on right now ===
   *
   * The same slate the television draws, in the band the page title used to
   * hold. The Pi reads the leagues and hands back one shape for both sports
   * (see /api/scores), so nothing here knows anything about ESPN or the MLB
   * stats API — it asks the box and lays out what comes back.
   *
   * Two things carry over from the Shield, because they are what make the row
   * worth having rather than decoration:
   *
   *   A card is a way IN. Every game is matched against the live library by
   *   the two teams first and the network second, so on a night when the
   *   provider carries a channel per game — 'MLB 01 | Rockies x Nationals' —
   *   pressing the card opens THAT broadcast rather than the network showing
   *   it. A game with no channel says so instead of pretending.
   *
   *   An empty row explains itself. Nothing on and nobody-could-be-asked look
   *   identical from across the room, and for as long as the row said nothing
   *   they were indistinguishable — so it says which, and names the address to
   *   open when the answer is the second one.
   */
  /* app.js's el() takes a tag and a class and nothing else; a scoreboard is
     mostly short pieces of text, so this is the same thing with the words. */
  const bit = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
    return n;
  };

  const SLATE_ORDER = { live: 0, upcoming: 1, final: 2 };
  const GAMES_IN_ROW = 16;
  /* The grid holds more because it can be read at a glance rather than
     scrolled through, and a college Saturday needs it to. */
  const GAMES_IN_GRID = 48;

  /*
   * Which sport the band is showing.
   *
   * One band, one sport, chosen with the switch in the bar. Both slates come
   * down in the same answer — the box asks both leagues either way — so this
   * is only ever a filter, and switching costs nothing and asks nobody
   * anything.
   *
   * Kept on the profile rather than in this browser: somebody who follows
   * football in October follows it on the phone too, and a per-device setting
   * would have to be set on each of them.
   */
  const SPORTS = ['nfl', 'mlb', 'ncaaf'];
  const scoreSport = () => (SPORTS.includes(profiles.data.scoreSport)
    ? profiles.data.scoreSport : 'mlb');

  function setScoreSport(sport) {
    if (!SPORTS.includes(sport) || sport === scoreSport()) return;
    profiles.data.scoreSport = sport;
    profiles.save();
    render();
    /* The guide is asked per sport — college needs it, the other two do not —
       so switching has to go and get it rather than drawing college against
       whatever was in hand for baseball. */
    askGuide().then(() => {
      const band = document.querySelector('#dkScores');
      if (band) paintScores(band);
    });
  }

  /* Held across renders so the row does not blink out and back on every
     repaint of the page while the box is being asked again. */
  let slate = { games: [], at: 0, trouble: '', asked: false, epg: new Map(), feeds: [] };
  let slateInFlight = null;

  function scoreboard() {
    const head = document.querySelector('.content-head');
    if (!head) return;

    /* The words this replaces. The pair is hidden by its own wrapper rather
       than emptied: app.js writes into both of them on every render and would
       find nothing to write into, and hiding them one at a time leaves the
       gap they stood in. */
    const title = document.querySelector('#contentTitle');
    if (title?.parentElement) title.parentElement.hidden = true;
    head.classList.add('has-scores');

    let band = document.querySelector('#dkScores');
    if (!band) {
      band = document.createElement('div');
      band.id = 'dkScores';
      band.dataset.dkOwned = '1';
      head.append(band);
    }
    paintScores(band);

    /* Asked once a minute at most. A score changes, but not on the timescale
       a page redraw happens on — and every ask is a call the box has to make
       out to a league. */
    if (!slateInFlight && Date.now() - slate.at > 60000) {
      slateInFlight = fetch('/api/scores', { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the box answered ${r.status}`))))
        .then((data) => {
          const rows = Array.isArray(data) ? data : (data.games || []);
          slate = {
            ...slate,
            games: rows.filter((g) => g && g.id),
            at: Date.now(),
            asked: true,
            /* An empty slate is an ANSWER, not a failure — it is Tuesday.
               An empty slate the BOX is unhappy about is a different thing,
               and it travels back in `error`. */
            trouble: rows.length ? '' : String((data && data.error) || ''),
            /* Per feed, because `trouble` above is about the whole answer and
               the band is about one sport. Baseball answering is what makes
               `rows.length` true, and without this the college band reads a
               refused ESPN as "the feed answered, with an empty slate" — the
               one sentence that rules out the thing that actually happened. */
            feeds: Array.isArray(data && data.feeds) ? data.feeds : [],
          };
        })
        .catch((err) => {
          slate = { ...slate, games: [], at: Date.now(), asked: true, feeds: [],
            trouble: err.message || 'the box could not be reached' };
        })
        .then(() => askGuide())
        .finally(() => {
          slateInFlight = null;
          const still = document.querySelector('#dkScores');
          if (still) paintScores(still);
        });
    }
  }

  /*
   * What is actually on the sports channels right now.
   *
   * Asked only for college, and only because college is the case that cannot
   * be solved any other way: on a Saturday the same channel number carries a
   * different game in a different market, and the channel's name says 'ESPN'
   * either way. The guide is the only thing on this box that knows which game
   * that is.
   *
   * Bounded hard. Forty channels is the box's own ceiling for one of these
   * calls, and the candidates are narrowed to the shelves this sport lives on
   * plus whatever networks the slate actually named — so a library of twelve
   * thousand channels is not walked over for a scoreboard. Answers the box
   * already holds come back immediately; the rest fill in over later visits
   * rather than queueing provider calls behind whoever is watching, which is
   * why the accuracy of this improves the second time you look at it.
   */
  const GUIDE_CHANNELS = 40;

  async function askGuide() {
    if (scoreSport() !== 'ncaaf') {
      slate.epg = new Map();
      return;
    }
    const channels = (state.library.live?.items || []).filter((c) => !profiles.isDeleted(c));
    const cats = new Map((state.library.live?.categories || [])
      .map((c) => [String(c.id), c.name || '']));

    /* Every network the slate named, so a game on a channel that is not on a
       football shelf is still asked about. */
    const networks = new Set(slate.games
      .filter((g) => g.sport === 'ncaaf')
      .map((g) => String(g.channelMatch || '').toUpperCase().trim())
      .filter((n) => n && !NOT_A_CHANNEL.test(n)));

    const wanted = channels.filter((c) => {
      if (DATED_EVENT.test(String(c.name || ''))) return false;
      if (onShelf(c, cats, 'ncaaf')) return true;
      const name = String(c.name || '').toUpperCase();
      return [...networks].some((n) => name.includes(n));
    })
      /* Most obviously college first, because only forty of these get asked
         about and the library's own order has nothing to do with football. */
      .sort((a, b) => collegeRank(a, cats) - collegeRank(b, cats))
      .slice(0, GUIDE_CHANNELS);

    if (!wanted.length) {
      slate.epg = new Map();
      return;
    }
    try {
      const ids = wanted.map((c) => String(c.epgId || c.id));
      const answer = await api('/api/epg/now', { ids: ids.join(',') });
      const now = Math.floor(Date.now() / 1000);
      const found = new Map();
      for (const row of answer.channels || []) {
        if (!row || !row.known) continue;
        const on = (row.listings || []).find((l) => l.start <= now && l.stop > now);
        if (on && on.title) found.set(String(row.id), on.title);
      }
      slate.epg = found;
    } catch {
      /* No guide is not a failure — the passes below it still run. */
      slate.epg = new Map();
    }
  }

  function paintScores(band) {
    /* Starred games lead, whatever they are doing — that is what starring one
       is for. Everything else falls in behind by state: what is on now, then
       what is about to start, then what is over. */
    const sport = scoreSport();
    /* A game with a network against its name, ahead of one without.
     *
     * Only for college, and only because the college slate may not be an FBS
     * one: the box asks for FBS first, but if ESPN refuses that address it
     * settles for all of Division I, which is a hundred and something games
     * against a grid that holds forty-eight. A televised game is the one this
     * house could actually watch, so it is the one worth the space. A
     * tie-break rather than a filter — nothing is dropped, it is ordered. */
    const televised = (g) => (String(g.channelMatch || g.channelName || '') ? 1 : 0);
    const games = slate.games.filter((g) => (g.sport || 'nfl') === sport)
      .sort((a, b) => (pinnedGame(b) - pinnedGame(a))
        || (SLATE_ORDER[a.status] ?? 3) - (SLATE_ORDER[b.status] ?? 3)
        || (sport === 'ncaaf' ? televised(b) - televised(a) : 0)
        /* A game with no announced kickoff goes to the END of the day, not
           the front of it. Zero is the earliest number there is and it is not
           an early kickoff, it is no kickoff. */
        || (a.kickoff || Number.MAX_SAFE_INTEGER) - (b.kickoff || Number.MAX_SAFE_INTEGER))
      .slice(0, sport === 'ncaaf' ? GAMES_IN_GRID : GAMES_IN_ROW);

    const playing = games.filter((g) => g.status === 'live').length;
    band.innerHTML = `
      <div class="sc-head">
        <span class="sc-title">Live now</span>
        <span class="sc-meta"></span>
      </div>
      <div class="sc-strip"></div>`;

    band.querySelector('.sc-meta').textContent = !slate.asked ? 'Asking…'
      : games.length ? `${playing} game${playing === 1 ? '' : 's'} on now`
        : '';

    const strip = band.querySelector('.sc-strip');
    if (!games.length) {
      const note = document.createElement('p');
      note.className = 'sc-empty';
      const named = { nfl: 'football', ncaaf: 'college football', mlb: 'baseball' }[scoreSport()];
      /* This sport's own feed, which is the only one this band is about. */
      const feed = (slate.feeds || []).find((f) => f && f.sport === sport);
      if (!slate.asked) note.textContent = 'Reading the slate…';
      else if (feed && feed.error) {
        /* The probe rather than the plain report: /api/scores says what the
           addresses BEFORE the winner said and nothing about the ones after,
           which is the right report for a scoreboard and the wrong one for
           working out why there is no scoreboard. */
        note.textContent = `No ${named}: the feed did not answer — ${feed.error}. `
          + `${location.origin}/api/scores/probe asks every address and says what each replied.`;
      } else if (slate.trouble) {
        note.textContent = `No scores: ${slate.trouble}. `
          + `${location.origin}/api/scores shows what was asked.`;
      } else if (feed && feed.quiet) {
        /* "The feed answered" was true and useless: it said one address had
           replied, not that the box had looked properly. The number is the
           claim worth making — and if it is wrong, the probe says which
           address answered with what. */
        note.textContent = `No ${named} on right now — ${feed.quiet} `
          + `address${feed.quiet === 1 ? '' : 'es'} answered and none of them had a game. `
          + `${location.origin}/api/scores/probe shows what each replied.`;
      } else {
        /* Which sport is empty matters: out of season is a different fact
           from nothing on tonight, and both are different from a feed that
           did not answer. */
        note.textContent = `No ${named} on right now — the feed answered, `
          + 'with an empty slate. The other sport is one press away.';
      }
      strip.append(note);
      return;
    }

    const channels = (state.library.live?.items || []).filter((c) => !profiles.isDeleted(c));
    const cats = state.library.live?.categories || [];
    /* A Saturday is sixty games. A row you scroll along is right for a dozen
       and useless for sixty — you cannot see what is on without dragging
       through it, which is the opposite of what a slate is for. */
    strip.classList.toggle('is-grid', sport === 'ncaaf');
    for (const game of games) {
      strip.append(scoreCard(game, matchChannel(game, channels, cats, slate.epg)));
    }
  }

  /*
   * One game, drawn the way a scoreboard draws one.
   *
   * Marks rather than initials — the club's own logo either side of the score,
   * which is how anybody actually reads a slate at a glance. The mark comes
   * from the league (mlbstatic.com, one address per team id) through the box's
   * image proxy, and a team the feed did not identify falls back to the
   * abbreviation it did send, because a card with a hole where a badge should
   * be is worse than a card with 'COL' on it.
   *
   * Three states, three layouts:
   *
   *   LIVE      score between the marks, the half-inning under it, and the
   *             diamond and the count along the bottom — the bases lit as they
   *             are and the balls, strikes and outs as dots, because that is
   *             the shape the information has.
   *   UPCOMING  the start time between the marks, and under the rule the two
   *             probable pitchers with their record and ERA. WARMUP replaces
   *             the time's caption the moment the league says the broadcast is
   *             up, which is the moment tuning to it is worth doing.
   *   FINAL     the score, greyed, with no dot claiming it is still on.
   */
  function scoreCard(game, channel) {
    const card = document.createElement('div');
    card.className = `sc-card is-${esc(game.status || 'live')} is-${esc(game.sport || 'mlb')}`;
    if (game.warmup) card.classList.add('is-warmup');
    if (pinnedGame(game)) card.classList.add('is-pinned');
    card.dataset.game = game.id;

    /* The ribbon, in the corner, exactly as a starred game carries one. It is
       a control as well as a mark: press it and the game leads the row. */
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'sc-star';
    star.title = pinnedGame(game) ? 'Unpin this game' : 'Pin this game to the front';
    star.setAttribute('aria-label', star.title);
    star.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.7 5.6 '
      + '6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.9l6.1-.8z"/></svg>';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePinnedGame(game);
    });
    card.append(star);

    const tune = document.createElement('button');
    tune.type = 'button';
    tune.className = 'sc-tune';
    tune.disabled = !channel;
    tune.title = channel ? `Watch on ${channel.name}` : 'No channel on this box carries it';

    tune.append(scoreLine(game));
    tune.append(game.status === 'upcoming' ? pregameFoot(game) : livingFoot(game, channel));
    if (channel) tune.addEventListener('click', () => openPlayer(channel));
    card.append(tune);
    return card;
  }

  /** A mark either side, and whatever belongs between them. */
  function scoreLine(game) {
    const row = document.createElement('div');
    row.className = 'sc-line';
    row.append(teamMark(game.away), middle(game), teamMark(game.home));
    return row;
  }

  function teamMark(team) {
    const box = document.createElement('span');
    box.className = 'sc-mark';
    if (team && team.logo) {
      const badge = document.createElement('img');
      badge.src = `/img?u=${encodeURIComponent(team.logo)}`;
      badge.alt = team.abbr || '';
      badge.loading = 'lazy';
      /* A mark that will not load leaves the abbreviation showing rather than
         a broken picture — the box may be offline, and the league's server is
         not this box's to promise. */
      badge.addEventListener('error', () => {
        badge.remove();
        box.classList.add('no-mark');
      });
      box.append(badge);
    } else {
      box.classList.add('no-mark');
    }
    box.append(bit('span', 'sc-fallback', team ? (team.abbr || '') : ''));
    return box;
  }

  /*
   * When a game starts, said where somebody is sitting.
   *
   * Drawn here, from the instant, rather than taken from whatever the box
   * formatted into `clock`. The box is one machine in one timezone and the
   * screens are wherever anybody happens to be — a start time formatted on
   * the server is the SERVER's evening, which is how a slate of Eastern
   * kickoffs came to be printed as local ones on a television in Montana.
   *
   * The box still fills `clock` in, and it is still what is used when there
   * is no instant to draw from: a game whose kickoff has not been announced
   * has no time to say in any zone.
   */
  const startsAt = (game) => (game.kickoff
    ? new Date(game.kickoff).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : (game.clock || 'TBA'));

  function middle(game) {
    const mid = document.createElement('div');
    mid.className = 'sc-mid';

    if (game.status === 'upcoming') {
      mid.append(bit('div', 'sc-at', '@'));
      mid.append(bit('div', 'sc-time', startsAt(game)));
      /* The one caption worth having under a start time: the league saying the
         broadcast is on. Anything else it says — Pre-Game, Delayed: Rain — is
         worth printing too, in the same place, in its own colour. */
      if (game.warmup) mid.append(bit('div', 'sc-warmup', 'Warmup'));
      else if (game.detailedState && !/scheduled|pre-game/i.test(game.detailedState)) {
        mid.append(bit('div', 'sc-state', game.detailedState));
      }
      return mid;
    }

    const away = game.away && game.away.score;
    const home = game.home && game.home.score;
    mid.append(bit('div', 'sc-score',
      `${away === null || away === undefined ? '—' : away} - `
      + `${home === null || home === undefined ? '—' : home}`));
    mid.append(bit('div', game.status === 'final' ? 'sc-final' : 'sc-half',
      game.status === 'final' ? 'Final' : (game.clock || '')));
    return mid;
  }

  /** What is happening in the game, under the score. One shape per sport. */
  function livingFoot(game, channel) {
    const foot = document.createElement('div');
    foot.className = 'sc-under';
    if (game.status !== 'live') {
      foot.append(bit('span', 'sc-where',
        channel ? cleanChannel(channel.name) : 'No channel matched'));
      return foot;
    }
    if (game.sport === 'nfl' || game.sport === 'ncaaf') return gridiron(game, foot);

    const on = game.onBase || {};
    const diamond = document.createElement('span');
    diamond.className = 'sc-diamond';
    /* Second at the top, third to the left, first to the right — the diamond
       as it is seen from behind the plate, which is how every scoreboard in
       the sport draws it. */
    for (const base of ['second', 'third', 'first']) {
      const b = bit('i', `b-${base}${on[base] ? ' on' : ''}`);
      diamond.append(b);
    }
    foot.append(diamond);

    const count = game.count || {};
    const dots = document.createElement('span');
    dots.className = 'sc-count';
    for (const [label, had, of] of [['B', count.balls, 4], ['S', count.strikes, 3],
      ['O', count.outs, 3]]) {
      const line = bit('span', 'sc-countrow');
      line.append(bit('b', null, label));
      for (let i = 0; i < of; i += 1) {
        line.append(bit('i', Number(had) > i ? 'on' : null));
      }
      dots.append(line);
    }
    foot.append(dots);
    return foot;
  }

  /**
   * The field, with the ball on it.
   *
   * Baseball's state is a diamond and a count; football's is one ball on one
   * line, and the three things worth knowing about it are where it is, which
   * way the offence is going, and what down it is. A sentence — "3rd & 7 · GB
   * 41" — carries all three and makes you assemble the picture yourself. A
   * hundred yards of field with a mark on it does not.
   *
   * Laid out the way the card is: the away side's end zone on the left, the
   * home side's on the right, so the arrow points at the end zone the team
   * with the ball is actually trying to reach.
   */
  function gridiron(game, foot) {
    const drive = game.drive;
    if (!drive) {
      /* Between drives, at a timeout, or a feed that did not send a
         situation. Better to say the game is on than to draw an empty field
         with the ball on the goal line. */
      foot.append(bit('span', 'sc-where', game.situation || 'Ball not spotted'));
      return foot;
    }

    const field = document.createElement('div');
    field.className = 'sc-field';
    if (drive.redZone) field.classList.add('is-redzone');
    field.append(bit('i', 'ez ez-l'), bit('i', 'ez ez-r'));
    for (const at of [25, 50, 75]) {
      const tick = bit('i', `tick${at === 50 ? ' mid' : ''}`);
      tick.style.left = `${at}%`;
      field.append(tick);
    }

    if (Number.isFinite(drive.yardLine)) {
      const ball = bit('i', `ball${drive.driving ? ` go-${drive.driving}` : ''}`);
      /* Kept off the very ends so the mark is never half outside the field. */
      ball.style.left = `${Math.min(97, Math.max(3, drive.yardLine))}%`;
      field.append(ball);
    }
    foot.append(field);

    const line = bit('div', 'sc-drive');
    line.append(bit('b', null, drive.text || (drive.down ? `${drive.down}` : '')));
    line.append(bit('span', null, drive.spot || ''));
    foot.append(line);
    return foot;
  }

  /**
   * The two probables, as a scoreboard lists them: the club, the surname, and
   * the season line in brackets. A club that has not named its starter yet
   * gets its own row with nothing after it rather than being left out, so the
   * card keeps its shape whichever way round it is.
   */
  function pregameFoot(game) {
    const foot = document.createElement('div');
    foot.className = 'sc-pitchers';

    /* Football has no probable starters to list, so the same strip carries
       the thing a football card would say instead: what each side's season
       looks like going in. */
    if (game.sport === 'nfl' || game.sport === 'ncaaf') {
      for (const side of ['away', 'home']) {
        const team = game[side];
        if (!team) continue;
        const row = bit('div', 'sc-pitcher');
        row.append(bit('b', null, team.abbr || ''));
        row.append(bit('span', null, team.record ? `${team.record}` : '—'));
        foot.append(row);
      }
      if (!foot.children.length) foot.append(bit('div', 'sc-tba', 'Teams not announced'));
      return foot;
    }

    for (const side of ['away', 'home']) {
      const team = game[side];
      if (!team) continue;
      const row = bit('div', 'sc-pitcher');
      row.append(bit('b', null, team.abbr || ''));
      const p = team.pitcher;
      if (!p) {
        row.append(bit('span', 'sc-tba', 'TBA'));
      } else {
        const line = [];
        if (p.wins !== null && p.losses !== null) line.push(`${p.wins}-${p.losses}`);
        if (p.era) line.push(p.era);
        row.append(bit('span', null,
          line.length ? `${p.last} (${line.join(', ')})` : p.last));
      }
      foot.append(row);
    }
    if (!foot.children.length) foot.append(bit('div', 'sc-tba', 'Starters not announced'));
    return foot;
  }

  /* ------------------------------------------------------- starred games ── */
  /*
   * The ribbon in the corner, and what it does.
   *
   * A slate is a dozen games and two of them are yours. Pinning is per game
   * rather than per team on purpose: the reason to star a game is usually the
   * game — a rivalry, a pitcher, the one that decides the division — and a
   * team rule would either miss those or drag in every other night of a
   * hundred-and-sixty-two.
   *
   * Stored on the box, so a game starred on the desktop leads the row on the
   * phone. Ids are good for one day, so the list is pruned as it is written:
   * anything older than three days is somebody else's game by now.
   */
  const PIN_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

  const pinnedGames = () => (profiles.data.pinnedGames || [])
    .filter((p) => p && p.id && Date.now() - (p.at || 0) < PIN_KEEP_MS);

  const pinnedGame = (game) => pinnedGames().some((p) => String(p.id) === String(game.id));

  function togglePinnedGame(game) {
    const id = String(game.id);
    const kept = pinnedGames().filter((p) => String(p.id) !== id);
    profiles.data.pinnedGames = pinnedGame(game)
      ? kept
      : [...kept, { id, at: Date.now() }];
    profiles.save();
    const band = document.querySelector('#dkScores');
    if (band) paintScores(band);
  }

  function firstPitch(game) {
    const start = game.sport === 'mlb' ? 'First pitch' : 'Kicks off';
    if (!game.kickoff) return game.clock ? `${start} ${game.clock}` : 'Later today';
    const mins = Math.round((game.kickoff - Date.now()) / 60000);
    if (mins <= 0) return 'Starting now';
    if (mins < 60) return `${start} in ${mins} min`;
    return `${start} at ${new Date(game.kickoff)
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  /* The provider writes 'US| FOX ᴴᴰ'; a card has room for 'FOX'. */
  function cleanChannel(name) {
    return String(name || '')
      .replace(/^[A-Z]{2,3}\s*\|\s*/i, '')
      .replace(/[ᴴᴰᵁᴴᴰᴿᴬᵂᶠᴾˢ⁴ᴷ⁶⁰]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Tie a game to a channel in the real live library.
   *
   * The game's OWN channel first: on a baseball night this provider carries a
   * row per game — 'MLB 01 | Rockies x Nationals' — and that is the broadcast
   * itself rather than the network that happens to be showing it, so a channel
   * naming both teams beats anything the network match could find. Then the
   * network, loosely, because a feed says 'FOX' and the provider says
   * 'US| FOX ᴴᴰ'. Shortest match wins so 'NFL' does not answer for
   * 'NFL NETWORK'.
   */
  /* A channel entry that is a SCHEDULED EVENT rather than a channel.
   *
   * This provider carries rows like "US (Peacock 023) | Marlins at Nationals
   * (2026-08-30 12:00:00)" — a placeholder for a broadcast at a stated time,
   * with nothing on it. They are the best possible match by name, which is
   * exactly the problem: a game card pointed at one opens a channel that is
   * not playing. The stamped time in the name is what identifies them, and it
   * is a far more reliable signal than the words around it. */
  const DATED_EVENT = /\(\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

  /* Which of the provider's shelves a sport's own rows live on. */
  const BASEBALL_SHELF = /\bMLB\b|BASEBALL/i;

  /* The word FOOTBALL is the problem, not the solution.
   *
   * On this provider — on every provider — a shelf called FOOTBALL is soccer,
   * and there are hundreds of rows on it. The old test was
   * `NCAA|COLLEGE|CFB|FOOTBALL`, which matched every one of them.
   *
   * It costs the by-row pass nothing: no soccer row names two American
   * schools. It costs the guide pass everything. askGuide asks about at most
   * forty channels, and if four hundred soccer rows come first in library
   * order then the forty are all soccer — so the one pass that can tell two
   * regional feeds of the same network apart never sees a college game at
   * all. Which is precisely the pass college football cannot do without.
   *
   * So: an explicit gridiron word admits a row outright. A bare FOOTBALL
   * admits one only in an American context, because that is the only place
   * the word means this sport. And an unmistakably soccer shelf is refused
   * whatever else it says. */
  const GRIDIRON_SHELF = /\bNFL\b|NCAA|\bCFB\b|COLLEGE|AMERICAN FOOTBALL|GRIDIRON/i;
  const AMERICAN = /\bUSA?\b|\bNFL\b|NCAA|\bCFB\b|COLLEGE/i;
  const SOCCER_SHELF = new RegExp([
    'SOCCER', 'FUTBOL', 'FUSSBALL', 'CALCIO',
    '\\bEPL\\b', 'PREMIER LEAGUE', '\\bEFL\\b', '\\bFA CUP\\b',
    '\\bUEFA\\b', 'CHAMPIONS LEAGUE', 'EUROPA', 'CONFERENCE LEAGUE',
    'LA ?LIGA', 'SERIE ?A', 'BUNDESLIGA', 'LIGUE ?1', 'EREDIVISIE',
    '\\bMLS\\b', 'LIGA MX', '\\bFIFA\\b', 'CONCACAF', 'CONMEBOL',
    'WORLD CUP', '\\bCOPA\\b',
  ].join('|'), 'i');

  /**
   * Is this channel on the shelf this sport's own rows live on?
   *
   * The channel name and its category read together, because either can carry
   * the signal: "US| NCAAF 07 | ALABAMA X GEORGIA" says it in the name, and
   * "US| ESPN" says it only by sitting on a shelf called USA NCAAF.
   */
  function onShelf(channel, catNames, sport) {
    const where = `${channel.name || ''} ${catNames.get(String(channel.categoryId)) || ''}`;
    if (sport === 'mlb') return BASEBALL_SHELF.test(where);
    if (SOCCER_SHELF.test(where)) return false;
    if (GRIDIRON_SHELF.test(where)) return true;
    return /FOOTBALL/i.test(where) && AMERICAN.test(where);
  }

  /* How well a channel answers to "this is where college football lives".
   *
   * Only used to decide which forty channels the guide is asked about, and
   * only because that budget is real: a row named for the sport outright is
   * worth asking about before a row that merely sits on a shelf that mentions
   * it, and both are worth asking about before a network the slate happened
   * to name. Without an order the forty are whatever the library listed
   * first, which is nothing to do with football. */
  function collegeRank(channel, catNames) {
    const name = String(channel.name || '').toUpperCase();
    const shelf = String(catNames.get(String(channel.categoryId)) || '').toUpperCase();
    if (/NCAA|\bCFB\b|COLLEGE/.test(name)) return 0;
    if (/NCAA|\bCFB\b|COLLEGE/.test(shelf)) return 1;
    if (/\bESPN\b|\bABC\b|\bFOX\b|\bCBS\b|\bBTN\b|BIG TEN|\bSEC\b|\bACC\b/.test(name)) return 2;
    return 3;
  }

  /* Comparing a school to a channel name.
   *
   * Whole words, not substrings, and this is not pedantry: 'OHIO' sits inside
   * 'OHIO STATE', 'MIAMI' inside 'MIAMI OH', and college football has both of
   * every such pair playing on the same afternoon. A word test does not fix
   * that on its own — 'OHIO STATE' still contains the word OHIO — so the
   * tie-break below prefers the shortest title, which is the one with the
   * least else in it. */
  const words = (text) => ` ${String(text || '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim()} `;
  const hasName = (haystack, name) => {
    const needle = words(name).trim();
    return Boolean(needle) && haystack.includes(` ${needle} `);
  };

  /** Every spelling of the two sides, best first. */
  const namePairs = (game) => [game.teamMatch, game.teamAlt, game.teamShort]
    .filter((pair) => Array.isArray(pair) && pair.length >= 2 && pair.every(Boolean));

  /**
   * Tie a game to a channel in the real live library.
   *
   * Three passes, narrowest and most trustworthy first. College football is
   * why there are three: a Saturday puts sixty games on a few dozen channels,
   * the same channel number carries a different game in a different market,
   * and the channel's NAME is often just 'ESPN' whichever game it is showing.
   *
   *   BY WHAT IS ON. If the guide says the programme on that channel right
   *   now names both schools, that is not a guess — it is the answer, and it
   *   is the only pass that can tell two regional feeds of the same network
   *   apart. Only as good as the guide's coverage, which is why it is a pass
   *   rather than the whole thing.
   *
   *   BY THE ROW. A provider that carries a row per game — 'NCAAF 07 |
   *   ALABAMA X GEORGIA' — has already done the work. Restricted to the shelf
   *   the sport's rows live on, because naming two schools is something a
   *   highlights channel does too.
   *
   *   BY THE NETWORK. Last, because on a college Saturday it is the weakest:
   *   eight games can all say 'ESPN'. It is still right for the one game that
   *   is actually on ESPN in this market, and better than nothing for the
   *   rest, but it is the pass that produces a card pointed at the wrong
   *   game — so a network that is not a television channel at all is refused
   *   outright below.
   *
   * Dated event rows are excluded from all three.
   */
  const NOT_A_CHANNEL = /^(ESPN\+|ESPN3|PEACOCK|PARAMOUNT\+|FUBO|MAX|NETFLIX|PRIME)/i;

  function matchChannel(game, channels, categories, epg) {
    const catNames = new Map((categories || []).map((c) => [String(c.id), c.name || '']));
    const live = channels.filter((c) => !DATED_EVENT.test(String(c.name || '')));
    const sport = game.sport || 'mlb';
    const pairs = namePairs(game);

    /* ---- what is on ---- */
    if (epg && epg.size && pairs.length) {
      let best = null;
      for (const channel of live) {
        const title = epg.get(String(channel.epgId || channel.id));
        if (!title) continue;
        const hay = words(title);
        if (!pairs.some((pair) => pair.every((team) => hasName(hay, team)))) continue;
        if (!best || title.length < best.title.length) best = { channel, title };
      }
      if (best) return best.channel;
    }

    /* ---- the provider's own row for this game ---- */
    for (const pair of pairs) {
      let best = null;
      for (const channel of live) {
        if (!onShelf(channel, catNames, sport)) continue;
        const hay = words(channel.name);
        if (!pair.every((team) => hasName(hay, team))) continue;
        if (!best || String(channel.name).length < String(best.name).length) best = channel;
      }
      if (best) return best;
    }

    /* ---- the network ---- */
    const needle = String(game.channelMatch || game.channelName || '').toUpperCase().trim();
    if (!needle || NOT_A_CHANNEL.test(needle)) return null;
    let best = null;
    for (const channel of live) {
      const name = String(channel.name || '').toUpperCase();
      if (!name.includes(needle)) continue;
      if (!best || name.length < String(best.name).length) best = channel;
    }
    return best;
  }


  function liveRail(title, count, items, cat) {
    const section = document.createElement('section');
    section.className = 'shelf';
    section.dataset.dkCat = title;
    section.id = catId(title);

    const pinned = cat ? profiles.isPinned('live', cat.id) : false;
    section.innerHTML = `
      <div class="shelf-head" role="${cat ? 'button' : 'presentation'}"${cat ? ' tabindex="0"' : ''}>
        <h2 class="shelf-title">${esc(title)}</h2>
        <span class="shelf-count">${esc(count)}</span>
        ${cat ? `<span class="dk-hpin${pinned ? ' on' : ''}" role="button" tabindex="0"
          title="${pinned ? 'Unpin' : 'Pin to the top'}"
          aria-label="${pinned ? 'Unpin' : 'Pin to the top'}">${pinned ? ICON.pinF : ICON.pin}</span>` : ''}
        ${cat ? `<span class="shelf-more">${ICON.chev}</span>` : ''}
      </div>
      <div class="rail">
        <button type="button" class="rail-nav prev" aria-label="Scroll ${esc(title)} left">${ICON.left}</button>
        <div class="rail-track"></div>
        <button type="button" class="rail-nav next" aria-label="Scroll ${esc(title)} right">${ICON.chev}</button>
      </div>`;

    const track = section.querySelector('.rail-track');
    for (const item of items) track.append(channelCard(item));

    if (cat) {
      section.querySelector('.dk-hpin').addEventListener('click', (e) => {
        e.stopPropagation();
        profiles.togglePin('live', cat.id);
        render();
      });
      section.querySelector('.shelf-head').addEventListener('click', (e) => {
        if (e.target.closest('.dk-hpin')) return;
        state.category = String(cat.id);
        render();
        scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    railPaging(section);
    return section;
  }

  /* The plate carries a mark, the line under it carries the name. Providers
     ship channels as "US| ESPN ᴴᴰ/ᴿᴬᵂ" — the country prefix and the format
     suffixes are filing, not identity, and set at 26px they crowd out the
     one word you are actually looking for. Stripped down to nothing, the
     original stands. */
  function shortMark(name) {
    const short = String(name || '')
      .replace(/^[A-Z]{2}\|\s*/, '')
      .replace(/\s*[ᴴᴰᴿᴬᵂ⁶⁰ᶠᵖˢ⁽⁸ᴷ⁾].*$/, '')
      .replace(/\s*\/.*$/, '')
      .trim();
    return short || String(name || '');
  }

  /* A channel is a 16:9 plate with the provider's mark on it, not a poster:
     there is no artwork for a channel and a 2:3 box of nothing is worse than
     a name set well. The heart is the other way this library is navigated,
     so it lives on the card and stays visible once it is on. */
  function channelCard(item) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card cht';
    card.dataset.dk = '1';
    card.__ttItem = item;

    const fav = profiles.hasFav(item);
    card.innerHTML = `
      <span class="card-art">
        <span class="lv"><span class="d"></span>LIVE</span>
        ${item.uhd ? '<span class="uhd">4K</span>' : ''}
        <span class="mk">${esc(shortMark(item.name))}</span>
        ${item.num ? `<span class="no">${esc(item.num)}</span>` : ''}
        <span class="dk-bin" role="button" tabindex="0"
          title="Hide this channel — it stops showing in lists and search"
          aria-label="Hide this channel">${ICON.bin}</span>
        <span class="go"><span>${ICON.play}</span></span>
        <span class="fav${fav ? ' on' : ''}" role="button" tabindex="0"
          title="${fav ? 'Remove from your channels' : 'Add to your channels'}"
          aria-label="${fav ? 'Remove from your channels' : 'Add to your channels'}">${fav ? ICON.heartF : ICON.heart}</span>
      </span>
      <span class="card-title">${esc(item.name)}</span>`;

    /* Real artwork when the provider sent some, contained rather than
       cropped — a cropped logo is unreadable. An animated ident is left out
       on purpose; it loops in the corner of the eye and says nothing. */
    if (item.logo && !looksAnimated(item.logo)) {
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = logoSource(item.logo);
      image.addEventListener('error', () => image.remove());
      card.querySelector('.mk').replaceWith(image);
    }

    card.querySelector('.fav').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      profiles.toggleFav(item);
      render();
    });

    /* Sits exactly where the channel number is, and takes its place on hover.
       The number is reference information you read once; the bin is the thing
       you reach for, and the corner it wants is already spoken for by the
       heart. */
    card.querySelector('.dk-bin').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      profiles.toggleDeleted(item);
      render();
    });
    card.addEventListener('click', () => openPlayer(item));
    return card;
  }

  /* The rails app.js builds carry their own paging; the ones built here need
     it too, and it is the same tween so they behave identically. */
  function railPaging(section) {
    const track = section.querySelector('.rail-track');
    const prev = section.querySelector('.rail-nav.prev');
    const next = section.querySelector('.rail-nav.next');
    if (!track) return;

    const page = (dir) => {
      const step = Math.max(track.clientWidth * 0.82, 400);
      const from = track.scrollLeft;
      const to = Math.max(0, Math.min(track.scrollWidth - track.clientWidth, from + dir * step));
      if (to === from) return;
      const started = performance.now();
      const glide = (now) => {
        const t = Math.min(1, (now - started) / 320);
        track.scrollLeft = from + (to - from) * (1 - (1 - t) * (1 - t));
        if (t < 1) requestAnimationFrame(glide);
      };
      requestAnimationFrame(glide);
    };
    prev.addEventListener('click', () => page(-1));
    next.addEventListener('click', () => page(1));
    track.addEventListener('scroll', syncArrows, { passive: true });
  }


  /* ================================================================ home */
  /* A billboard, then what is on, then the shelves. The three features are
     taken from what the box actually holds rather than curated: whatever is
     live and favourited, whatever was left half-watched, and whatever landed
     most recently. If one of the three has nothing behind it, it is not
     offered — a billboard advertising an empty library is worse than a
     shorter billboard. */

  let heroAt = 0;

  function heroFeatures() {
    const out = [];

    const channel = profiles.favItems().find((i) => i.kind === 'live');
    if (channel) {
      out.push({
        kind: 'live',
        item: channel,
        eyebrow: `<span class="plive"><span class="d"></span>LIVE</span>`
          + `<span class="caps">${esc(channel.name)}</span>`,
        tags: [channel.uhd ? '4K' : 'HD', 'Direct play'].filter(Boolean),
        /* The mark reads as a name at 100px; the provider's full string, with
           its country prefix and format suffix, does not — and it is already
           spelled out in the eyebrow directly above. */
        title: shortMark(channel.name),
        meta: ['On now'],
        blurb: 'One of your channels, straight from the provider — no transcode '
          + 'and nothing to wait for.',
        cta: 'Watch live',
        go: () => openPlayer(channel),
      });
    }

    const resume = (state.recentlyWatched || []).find((r) => r.duration && r.position);
    if (resume) {
      const pct = Math.round((resume.position / resume.duration) * 100);
      /* A history row remembers what you watched, not what it looked like —
         no poster, no logo — so the billboard for Continue watching came up
         as bare gradient. The library still has the title; this is the same
         record, looked up for its artwork only. */
      const shelf = state.library[resume.kind === 'series' ? 'series' : 'movies'];
      const art = (shelf?.items || []).find(
        (i) => String(i.id) === String(resume.seriesId ?? resume.id)
      );
      out.push({
        kind: 'resume',
        art,
        eyebrow: '<span class="caps">Continue watching</span>',
        tags: [resume.season && resume.episode ? `S${resume.season} E${resume.episode}` : 'Resume'],
        title: resume.seriesName || resume.name || '',
        meta: [`${pct}% in`],
        blurb: 'Already on the box, so seeking is instant anywhere in it. '
          + 'Picks up where you stopped.',
        progress: pct,
        cta: 'Resume',
        go: () => playFromHistory(resume),
      });
    }

    const fresh = newestTitle();
    if (fresh) {
      out.push({
        kind: 'new',
        item: fresh,
        eyebrow: '<span class="caps">New in the archive</span>',
        tags: ['Just indexed', fresh.uhd ? '4K' : null].filter(Boolean),
        title: fresh.name,
        meta: [fresh.kind === 'series' ? 'Series' : 'Film'],
        blurb: 'The newest thing the box has indexed.',
        cta: fresh.kind === 'series' ? 'Start watching' : 'Play',
        go: () => openTitle(fresh),
      });
    }

    return out;
  }

  function newestTitle() {
    let best = null;
    for (const tab of ['movies', 'series']) {
      for (const item of state.library[tab]?.items || []) {
        if (profiles.isDeleted(item)) continue;
        if (!best || (item.added || 0) > (best.added || 0)) best = item;
      }
    }
    return best && best.added ? best : null;
  }

  function buildHero(features) {
    heroShowing = features;
    const hero = document.createElement('section');
    hero.id = 'dkHero';
    hero.dataset.dkOwned = '1';
    hero.setAttribute('aria-label', 'Featured');

    hero.innerHTML = `
      <div class="slides">${features.map((f, i) => `
        <div class="slide${i ? '' : ' on'}" data-i="${i}"><div class="art"></div></div>`).join('')}</div>
      <div class="veil"></div><div class="glow"></div>
      <div class="inner wrap"><div class="stage">${features.map((f, i) => `
        <div class="copy${i ? '' : ' on'}" data-i="${i}">
          <div class="eyebrow">${f.eyebrow}${f.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          <h1 class="big">${esc(f.title)}</h1>
          <div class="meta">${f.meta.map((m, j) => (j ? '<s>·</s>' : '') + esc(m)).join('')}</div>
          <p class="blurb">${esc(f.blurb)}</p>
          ${f.progress ? `<div class="resume"><div class="track"><i style="width:${f.progress}%"></i></div>
            <span>${f.progress}% in</span></div>` : ''}
          <div class="cta">
            <button type="button" class="dk-btn dk-btn-p" data-go="${i}">${ICON.play}${esc(f.cta)}</button>
            ${f.item ? `<button type="button" class="dk-btn dk-btn-g" data-info="${i}">${ICON.info}More info</button>` : ''}
          </div>
        </div>`).join('')}</div></div>
      ${features.length > 1 ? `<div class="picker">${features.map((f, i) => `
        <button type="button" class="${i ? '' : 'on'}" data-i="${i}" aria-label="Show ${esc(f.title)}">
          <span class="bg"></span><span class="lbl">${esc(f.title)}</span>
        </button>`).join('')}</div>` : ''}`;

    /* Real artwork where the provider sent some. The tinted field underneath
       is not a placeholder waiting to be replaced — it is what an empty
       portal is supposed to look like. */
    features.forEach((f, i) => {
      const art = hero.querySelectorAll('.slide .art')[i];
      art.style.setProperty('--field', FIELDS[i % FIELDS.length]);
      const source = f.item || f.art;
      const logo = source?.logo;
      if (logo && !looksAnimated(logo)) {
        const image = document.createElement('img');
        image.alt = '';
        image.src = logoSource(logo);
        image.addEventListener('error', () => image.remove());
        art.append(image);
        /* A channel has a MARK, not a backdrop. Filling a 1900px billboard
           with a 400px station logo blows it up to six times its size and
           crops it, which is the giant half-an-abc. Marked so the styling
           can centre it at its own size instead of covering with it. */
        if (source.kind === 'live') art.closest('.slide')?.classList.add('is-mark');
      }
      const chip = hero.querySelector(`.picker button[data-i="${i}"] .bg`);
      if (chip) chip.style.setProperty('--field', FIELDS[i % FIELDS.length]);
    });

    hero.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) return features[Number(go.dataset.go)]?.go();
      const info = e.target.closest('[data-info]');
      if (info) {
        const f = features[Number(info.dataset.info)];
        return f?.item && openTitle(f.item);
      }
      const pick = e.target.closest('.picker button');
      if (pick) showFeature(hero, Number(pick.dataset.i), features.length);
    });

    return hero;
  }

  /* --------------------------------------------- the billboard, and why
   * it is a picture rather than the stream
   *
   * This used to play the channel in the slide, muted, behind the words. It
   * looked wonderful and it cost a provider connection for as long as the
   * home page was open — the ingest it started is kept alive by its own
   * fetching, so it never went idle and never gave the slot back. On a
   * one-account box that is the whole subscription spent on a page nobody is
   * watching yet; on a two-account box it quietly ate the second login, which
   * is the opposite of what the second login was bought for.
   *
   * The billboard is a still now. Watch live opens the channel properly, with
   * sound, and that is the only thing on this page that touches the provider.
   */

  /* The billboard never rotates on its own. Three features are offered and
     the choice is the viewer's — a page that changes under you while you are
     reading it is a page you have to fight. */
  function showFeature(hero, i, count) {
    heroAt = ((i % count) + count) % count;
    for (const el of hero.querySelectorAll('.slide, .copy, .picker button')) {
      el.classList.toggle('on', Number(el.dataset.i) === heroAt);
    }
  }

  /* What the billboard is currently offering, so showFeature can ask the
     picked one what it is. buildHero is the only writer. */
  let heroShowing = [];

  const FIELDS = [
    'radial-gradient(120% 110% at 22% 18%,#3c2a24,#1a1210 62%,#100b0a)',
    'radial-gradient(120% 110% at 74% 26%,#243440,#141b20 60%,#0d1115)',
    'radial-gradient(120% 110% at 34% 22%,#4a2a22,#20120f 62%,#120a09)',
    'radial-gradient(120% 110% at 60% 30%,#2c3a2c,#161e17 60%,#0d120e)',
    'radial-gradient(120% 110% at 40% 20%,#3a2c40,#1a151f 60%,#100d13)',
    'radial-gradient(120% 110% at 66% 24%,#40382a,#1e1a13 60%,#12100b)',
  ];

  addEventListener('keydown', (e) => {
    if (!on || state.tab !== 'home') return;
    if (e.target.matches?.('input, textarea, select')) return;
    const hero = document.getElementById('dkHero');
    const count = hero?.querySelectorAll('.slide').length || 0;
    if (count < 2) return;
    if (e.key === 'ArrowRight') showFeature(hero, heroAt + 1, count);
    if (e.key === 'ArrowLeft') showFeature(hero, heroAt - 1, count);
  });

  /* A rail of whatever it is handed, built out of app.js's own cards so a
     poster on the landing page and a poster in a category are the same
     poster. */
  function shelfOf(title, count, items, onOpen) {
    const section = document.createElement('section');
    section.className = 'shelf';
    section.innerHTML = `
      <div class="shelf-head" role="${onOpen ? 'button' : 'presentation'}"${onOpen ? ' tabindex="0"' : ''}>
        <h2 class="shelf-title">${esc(title)}</h2>
        <span class="shelf-count">${esc(count)}</span>
        ${onOpen ? `<span class="shelf-more">${ICON.chev}</span>` : ''}
      </div>
      <div class="rail">
        <button type="button" class="rail-nav prev" aria-label="Scroll ${esc(title)} left">${ICON.left}</button>
        <div class="rail-track"></div>
        <button type="button" class="rail-nav next" aria-label="Scroll ${esc(title)} right">${ICON.chev}</button>
      </div>`;

    const track = section.querySelector('.rail-track');
    for (const item of items) {
      const card = cardFor(item);
      card.classList.add('rail-card');
      track.append(card);
    }
    if (onOpen) section.querySelector('.shelf-head').addEventListener('click', onOpen);
    railPaging(section);
    return section;
  }

  const buildHome = guard('home', function buildHome() {
    const view = $('#homeView');
    if (!view || view.hidden) return;

    const features = heroFeatures();
    if (features.length) {
      const hero = buildHero(features);
      $('#appView').prepend(hero);
      showFeature(hero, Math.min(heroAt, features.length - 1), features.length);
    }

    /* app.js has already drawn its own Continue watching and favourites; the
       design puts the same facts in a different order, so its markup goes and
       these take its place. The version stamp is not part of that — it is the
       browser saying which build it is running, which is the same question
       whatever the page looks like — so it is kept and put back at the end. */
    const stamp = view.querySelector('.home-version');
    /* Kept for the same reason as the stamp, and for one more: what is on is
       a fact about the provider rather than a piece of this layout, it costs
       a call to a single-connection box to get, and throwing it away here
       would mean fetching it again the moment the page is redrawn. Anything
       app.js adds to home in future will need a line like this one, which is
       the price of rebuilding a page somebody else drew. */
    const guide = view.querySelector('.home-guide');
    view.innerHTML = '';

    const channels = profiles.favItems().filter((i) => i.kind === 'live');
    if (channels.length) {
      const lane = shelfOf('On now', `${channels.length} channels`, [], () => { location.hash = '#/favlive'; });
      lane.id = 'dkLane';
      const track = lane.querySelector('.rail-track');
      for (const channel of channels) track.append(channelCard(channel));
      view.append(lane);
    }

    const seen = new Set();
    const recent = [];
    for (const row of state.recentlyWatched || []) {
      const key = `${row.kind}:${row.seriesId ?? row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recent.push(row);
      if (recent.length === 12) break;
    }
    if (recent.length) {
      const section = shelfOf('Continue watching',
        `${recent.length} title${recent.length === 1 ? '' : 's'}`, [], null);
      /* The design lays this out as a rail rather than a hero with four
         alongside, but it is still the same region holding the same thing —
         so it keeps the name the rest of the portal knows it by. */
      section.classList.add('home-recent');
      const track = section.querySelector('.rail-track');
      for (const row of recent) {
        const card = homeCard(row, 'rail-card home-resume');
        track.append(card);
      }
      view.append(section);
    }

    for (const tab of ['movies', 'series']) {
      const rows = window.buildShelves(tab);
      const row = rows[0];
      if (!row?.items.length) continue;
      view.append(shelfOf(
        tab === 'movies' ? 'Recently added' : 'Series, continuing',
        num(row.items.length),
        row.items.slice(0, 20),
        () => { location.hash = `#/${tab}`; }
      ));
    }

    const titles = profiles.favItems().filter((i) => i.kind !== 'live');
    if (titles.length) {
      const favs = shelfOf('Your favorites', num(titles.length), titles.slice(0, 20),
        () => { location.hash = '#/favorites'; });
      favs.classList.add('home-favs');
      view.append(favs);
    }

    /* Worked out before the stamp goes back, or the version in the corner
       counts as content and a profile with nothing watched and nothing
       starred gets a blank page instead of a sentence telling it why. */
    const bare = !features.length && !view.querySelector('.shelf');
    if (guide) view.append(guide);
    if (stamp) view.append(stamp);
    $('#appView').append(buildFooter());
    $('#emptyState').hidden = !bare;
  });


  /* ------------------------------------------------------------- footer */
  /* What the box is doing, under the page rather than behind a button. The
     numbers are the box's own, read once per home render and then left
     alone — a footer that polls is a footer that keeps the Pi awake. */
  let healthCache = null;

  function buildFooter() {
    const foot = document.createElement('footer');
    foot.id = 'dkFoot';
    foot.dataset.dkOwned = '1';
    foot.innerHTML = `<div class="inner wrap">
      <div class="stat"><span class="k">Portal</span><span class="v" id="dkUptime">—</span></div>
      <div class="stat"><span class="k">Provider</span><span class="v" id="dkProvider">—</span></div>
      <div class="stat"><span class="k">Network</span><span class="v" id="dkNetwork">—</span></div>
      <div class="stat"><span class="k">Storage</span><span class="v" id="dkDisk">—</span>
        <span class="bar"><i id="dkDiskBar" style="width:0%"></i></span></div>
      <div class="stat"><span class="k">Archive</span><span class="v" id="dkArchive">—</span></div>
      <span class="ver">v${esc(typeof VERSION === 'string' ? VERSION : '')}</span>
    </div>`;

    if (healthCache) paintFooter(foot, healthCache);
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        healthCache = data;
        paintFooter(document.getElementById('dkFoot'), data);
      })
      .catch(() => { /* the footer is a nicety; a box that will not answer is
                        already saying so louder elsewhere */ });
    return foot;
  }

  const gb = (bytes) => `${(bytes / 1073741824).toFixed(0)} GB`;

  function paintFooter(foot, h) {
    if (!foot) return;
    const dot = (tone) => `<span class="d" style="background:var(--${tone})"></span>`;
    const set = (id, html) => {
      const node = foot.querySelector('#' + id);
      if (node) node.innerHTML = html;
    };

    const up = Math.max(0, Math.round(h.uptime?.server || 0));
    const days = Math.floor(up / 86400);
    const pad = (n) => String(n).padStart(2, '0');
    set('dkUptime', dot('ok') + `up ${days}d ${pad(Math.floor(up % 86400 / 3600))}`
      + `:${pad(Math.floor(up % 3600 / 60))}:${pad(up % 60)}`);

    const rate = h.provider?.bytesPerSec;
    set('dkProvider', dot(h.provider?.streaming ? 'ok' : 'muted-dim')
      + (h.provider?.streaming
        ? `Streaming · ${((rate || 0) * 8 / 1e6).toFixed(1)} Mbit/s`
        : 'Idle'));

    set('dkNetwork', dot(h.network?.level === 'good' ? 'ok' : 'warn')
      + esc(h.network?.kind === 'wired' ? 'Wired' : 'Wi-Fi')
      + (h.network?.level ? ` · ${esc(h.network.level)}` : ''));

    if (h.disk?.total) {
      set('dkDisk', `${gb(h.disk.free)} free of ${gb(h.disk.total)}`);
      const bar = foot.querySelector('#dkDiskBar');
      if (bar) bar.style.width = `${Math.round((1 - h.disk.free / h.disk.total) * 100)}%`;
    }

    set('dkArchive', h.archive?.mounted
      ? (h.archive.total ? `${gb(h.archive.free)} free of ${gb(h.archive.total)}` : 'Mounted')
      : 'Not mounted');
  }


  /* ====================================================== startup screen */
  /* The projector-lamp startup sequence used to be built here, injected into
     the loading overlay and gated on the desktop layout being on — which meant
     no phone and no iPad ever saw it. It has moved into the markup, styles.css
     and the loader object in app.js, so it is the same startup on every device
     and does not depend on this layer being loaded. Nothing is left to do here. */

  /* =========================================================== dispatch */
  function buildBrowseChrome() {
    for (const node of $$('#dkLive, #dkHero, #dkFoot, #dkScores')) node.remove();

    /* The page title, back. Live TV puts the scores where it stands and takes
       it down again; every other page wants it, and a page that inherits the
       last one's missing heading is the kind of bug that only shows up in the
       order somebody happens to browse in. */
    const title = document.querySelector('#contentTitle');
    if (title?.parentElement) title.parentElement.hidden = false;
    document.querySelector('.content-head')?.classList.remove('has-scores');

    const tab = state.tab;

    if (tab === 'home') { hideCatbar(); buildHome(); return; }

    /* app.js hides the home view rather than emptying it, so the lane of
       channel cards would sit there off-screen holding its listeners until
       somebody came back. Nothing on this page is going to look at it. */
    const home = $('#homeView');
    if (home && home.querySelector('#dkLane')) home.innerHTML = '';

    /* A film's own page is not a browse page, and the bar is browse chrome.
       The way off it is the back pill on the backdrop, which names the
       category it came from; leaving the bar up put a second and louder way
       back directly over the picture the page is built on. A show's page
       keeps its bar — that layout has not been redrawn and the bar is still
       the only way out of it. */
    const catalogue = (tab === 'movies' || tab === 'series')
      && !state.query && state.category === null && state.library[tab]
      && !(tab === 'movies' && state.movieId);
    if (catalogue) return buildCatalogueChrome(tab);

    /* Live keeps its bar whether it is showing rows or one category as a
       grid; the bin and the search are app.js's own views and keep theirs. */
    if (tab === 'live' && !state.query && state.library.live
      && state.category !== DELETED_CATS && state.category !== DELETED_CATEGORY) {
      return buildLivePage(state.category === null);
    }

    hideCatbar();
  }

  /* A handle on the layer from the console, for the box this runs on: there
     is no build step and no dev server here, so being able to ask a live
     portal whether the design is on, and to redraw a piece of it, is the
     whole of the tooling. Nothing in the portal reads this. */
  window.__ttDesktop = { ICON, esc, num, guard, $$, catId, ensureCatbar, ensureSheet,
    closeSheet, fillSheet, syncArrows, decorateCards,
    get on() { return on; } };


  /* ============================================================ decorate */
  /* Run after every app.js render. Nothing here assumes what the last render
     left behind: each page decides its own furniture from scratch, because
     the alternative is a page that inherits the previous one's bar. */
  const decorate = guard('decorate', function decorate() {
    if (!on) return;
    decorateCards();
    buildBrowseChrome();
    requestAnimationFrame(syncArrows);
  });


  /* --------------------------------------------------------------- boot */
  applyGate();

  /* device.apply() is what turns phone layout on and off, and it is also the
     only thing that knows a preference changed. Wrapping it keeps the gate
     in step with the user's own choice rather than only with the window.

     `device` is a top-level const in app.js, so it is a global lexical
     binding rather than a property of window — reached by name, not through
     the object. The same is true of `state` and `profiles` below. */
  const deviceApply = device.apply.bind(device);
  device.apply = function () {
    const out = deviceApply();
    applyGate();
    return out;
  };

  /* The render hook. app.js calls render() by name, which resolves through
     the global object, so replacing the property is enough for its own
     internal calls to come through here too. */
  const appRender = window.render;
  window.render = function () {
    const out = appRender.apply(this, arguments);
    decorate();
    return out;
  };

  const appRenderHome = window.renderHome;
  window.renderHome = function () {
    const out = appRenderHome.apply(this, arguments);
    decorate();
    return out;
  };

  /* Stash the item on its card so the hover actions have something real to
     act on. app.js closes over it and never puts it anywhere reachable. */
  const appCardFor = window.cardFor;
  window.cardFor = function (item) {
    const card = appCardFor.apply(this, arguments);
    card.__ttItem = item;
    return card;
  };

  /* The wall of category squares is the thing this page was redesigned away
     from, so on the desktop it is not drawn at all rather than drawn and
     hidden: building several hundred tiles to cover them up costs the Pi the
     same as showing them, and a tour pointing at an invisible tile points at
     nothing. The bin — the hidden categories — keeps its grid, since that is
     app.js's own view and the redesign says nothing about it. */
  const appRenderLiveCategories = window.renderLiveCategories;
  window.renderLiveCategories = function () {
    if (!on || state.category !== null) {
      return appRenderLiveCategories.apply(this, arguments);
    }
    $('#grid').hidden = true;
    return undefined;
  };

})();
