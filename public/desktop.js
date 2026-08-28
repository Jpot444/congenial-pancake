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

    const sel = bar.querySelector('#dkSortSel');
    const wantSorts = cfg.sorts.join('|');
    if (sel.dataset.dkSorts !== wantSorts) {
      sel.dataset.dkSorts = wantSorts;
      sel.innerHTML = cfg.sorts.map((s) => `<option>${esc(s)}</option>`).join('');
    }
    sel.value = cfg.sortValue;

    bar.querySelector('#dkAllBtn').lastChild.textContent = cfg.allLabel;
    for (const b of bar.querySelectorAll('#dkViewSeg button')) {
      b.classList.toggle('on', b.dataset.v === cfg.view);
    }

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

  function fillSheet() {
    if (!barConfig || !sheet) return;
    const q = sheet.querySelector('#dkCatQ').value.trim().toLowerCase();
    const hits = barConfig.cats.filter((c) => c.name.toLowerCase().includes(q));
    sheet.querySelector('#dkSheetLead').textContent = barConfig.lead;
    sheet.querySelector('#dkCatList').innerHTML = hits.length
      ? hits.map((c) => `<button type="button" data-c="${esc(c.name)}">`
        + `<span>${esc(catName(c.name))}</span><b>${num(c.count)}</b></button>`).join('')
      : '<p class="none">No category matches that.</p>';
  }

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
    if (seg) return barConfig.onView(seg.dataset.v);

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
    if (!e.target.closest?.('.catchip, .cht')) return;
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
      view: rows ? 'rows' : 'grid',
      sorts: Object.keys(LIVE_SORTS),
      sortValue: liveSort,
      allLabel: `All ${ordered.length}`,
      lead: `${ordered.length} categories. Pin the ones you use — they lead the bar above, in your order.`,
      pinnable: true,
      cats: ordered.map((c) => ({
        name: c.name,
        catId: c.id,
        count: counts.get(String(c.id)) || 0,
        pinned: profiles.isPinned('live', c.id),
        onOpen: () => { state.category = String(c.id); render(); scrollTo({ top: 0, behavior: 'smooth' }); },
      })),
      onSort: (value) => { liveSort = value; render(); },
      onView: (v) => {
        if (v === 'rows') state.category = null;
        else state.category = String((open || ordered[0] || {}).id ?? '');
        render();
        scrollTo({ top: 0, behavior: 'smooth' });
      },
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
    $('#contentMeta').textContent =
      `${num(pinned.length)} pinned · ${num(ordered.length)} categories · ${num(source.items.length)} channels`;

    const host = document.createElement('div');
    host.id = 'dkLive';
    host.dataset.dkOwned = '1';
    grid.after(host);

    const sorter = LIVE_SORTS[liveSort];
    const arrange = (list) => (sorter ? [...list].sort(sorter) : list);
    const favourites = profiles.favItems().filter((i) => i.kind === 'live');

    if (favourites.length) {
      /* Not `arrange`d. The sort above belongs to the provider's categories —
         this row is the one the viewer built, in the order they put it in,
         and re-sorting somebody's own arrangement alphabetically is taking it
         away from them. */
      const mine = liveRail('Your channels',
        `${favourites.length} favorites · drag to reorder`, favourites, null);
      makeReorderable(mine.querySelector('.rail-track'));
      host.append(mine);
    }

    /* Nine rows, because past that the page is a scroll rather than a way in
       — the bar and the sheet are how you reach the rest. */
    for (const cat of ordered.slice(0, 9)) {
      const items = arrange(byCat.get(String(cat.id)) || []);
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

  /* The catalogue's sorts do not transfer: a channel has no release year, no
     rating and no date it was added — the provider sends a name, a category
     and sometimes a logo. Sorting it by anything else would mean inventing
     the field to sort on, so these two are what there is. Provider order is
     first because it is the order the numbers would have been in. */
  let liveSort = 'Provider order';
  const LIVE_SORTS = {
    'Provider order': null,
    'Name, A to Z': (a, b) => String(a.name).localeCompare(String(b.name)),
  };

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
        /* The same channel, full screen, with the sound on — and out of the
           billboard first, so one window is being read rather than two. The
           player joins the DVR session the preview already started, so this
           is the same ingest rather than a second one. */
        go: () => { stopPreview(); openPlayer(channel); },
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

  /* ------------------------------------------------ the billboard, playing */
  /*
   * When the billboard is on a channel, it IS the channel: the stream runs in
   * the slide, muted, behind the words. Not a trailer and not a loop — the
   * thing that is actually on right now, which is the only reason a live
   * billboard is worth having.
   *
   * Two rules keep it from costing anything. It plays ONLY through the Pi's
   * own DVR window (`ext=m3u8`, and the answer has to come back `dvr: true`
   * or the preview does not start at all) — that window is shared, so the
   * billboard and somebody watching the same channel for real are one ingest
   * on the provider's one connection, and pressing Watch live joins the
   * session already running rather than opening a second one. And it stops
   * the moment it is not being looked at: another feature picked, the page
   * left, the player opened, the tab hidden. A billboard that keeps pulling
   * video while nobody is on the page is a bug with a picture on it.
   */
  const preview = { video: null, engine: null, id: '', want: 0 };

  function stopPreview() {
    preview.want += 1;      // anything still in flight is now stale
    preview.id = '';
    if (preview.engine) {
      try { preview.engine.destroy(); } catch { /* already gone */ }
      preview.engine = null;
    }
    if (preview.video) {
      try {
        preview.video.pause();
        preview.video.removeAttribute('src');
        preview.video.load();
      } catch { /* already gone */ }
      preview.video.remove();
      preview.video = null;
    }
  }

  async function startPreview(feature, slide) {
    const channel = feature.item;
    const art = slide?.querySelector('.art');
    if (!channel || !art) return;

    /* Home is redrawn often — a heart pressed, a shelf arriving — and the
       billboard is rebuilt with it. Carrying the same channel's video across
       into the new slide keeps the picture running and, more to the point,
       stops asking the box to open the channel again every time anything on
       the page changes. Moving a media element between parents inside one
       task does not pause it. */
    if (preview.id === String(channel.id)) {
      // Already playing this channel: carry the element across.
      if (preview.video) {
        if (preview.video.parentElement !== art) art.append(preview.video);
        slide.classList.add('is-playing');
        preview.video.play().catch(() => {});
      }
      // Or already on its way. Either way there is nothing to ask for twice.
      return;
    }
    stopPreview();

    /* Somebody who has told the box their link cannot carry the stream did not
       mean "except on the home page". lowMode is a top-level const in app.js —
       a global binding rather than a property of window, which is how every
       other name this layer borrows works too. */
    if (lowMode() || navigator.connection?.saveData) return;

    /* The channel is claimed BEFORE the round trip, not after it. Home is
       redrawn several times while it settles, and an id set only once the
       answer came back meant every one of those redraws asked the box to open
       the channel again — eight calls, measured, for one billboard. */
    const ticket = preview.want;
    preview.id = String(channel.id);
    let stream;
    try {
      stream = await api('/api/play', { kind: 'live', id: channel.id, ext: 'm3u8' });
    } catch {
      if (ticket === preview.want) preview.id = '';
      return;                       // no preview is a fine answer
    }
    if (ticket !== preview.want) return;      // moved on while that was in flight
    // Not through the Pi's window: that is the provider's own connection, and
    // the billboard does not get to spend it.
    if (!stream || !stream.dvr || !stream.url) {
      preview.id = '';
      return;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.className = 'live-preview';
    /* The billboard may have been rebuilt while that was in flight, which
       would leave this playing into a node nobody can see. */
    const home = art.isConnected ? art : document.querySelector('#dkHero .slide.on .art');
    if (!home) {
      preview.id = '';
      return;
    }
    home.append(video);
    preview.video = video;

    if (window.Hls && window.Hls.isSupported()) {
      const engine = new window.Hls({
        lowLatencyMode: false,
        // Seated where the player seats itself in the same window, so the
        // billboard and the full screen are showing the same moment.
        liveSyncDuration: 45,
        liveMaxLatencyDuration: 600,
        backBufferLength: 15,
        maxBufferLength: 20,
      });
      preview.engine = engine;
      engine.loadSource(stream.url);
      engine.attachMedia(video);
      engine.on(window.Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) engine.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) engine.recoverMediaError();
        else stopPreview();
      });
    } else {
      video.src = stream.url;       // Safari plays HLS itself
    }
    video.play().catch(() => { /* a browser that will not start it keeps the mark */ });
    video.addEventListener('playing',
      () => home.closest('.slide')?.classList.add('is-playing'), { once: true });
  }

  /* Nobody is looking at it, so it is not fetching. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPreview();
    else {
      const hero = document.getElementById('dkHero');
      if (hero) showFeature(hero, heroAt, hero.querySelectorAll('.slide').length);
    }
  });

  /* The billboard never rotates on its own. Three features are offered and
     the choice is the viewer's — a page that changes under you while you are
     reading it is a page you have to fight. */
  function showFeature(hero, i, count) {
    heroAt = ((i % count) + count) % count;
    for (const el of hero.querySelectorAll('.slide, .copy, .picker button')) {
      el.classList.toggle('on', Number(el.dataset.i) === heroAt);
    }

    const feature = heroShowing[heroAt];
    if (feature && feature.kind === 'live' && !document.hidden) {
      /* Not stopped first: this is called on every redraw of home as well as
         on a picker press, and tearing the stream down only to ask for the
         same channel again is what turned one billboard into eight calls at
         the box. startPreview carries a running channel across and ignores a
         request for one it is already fetching. */
      startPreview(feature, hero.querySelector(`.slide[data-i="${heroAt}"]`));
    } else {
      // Whatever was playing belongs to a slide nobody is looking at now.
      stopPreview();
      hero.querySelectorAll('.slide.is-playing').forEach((s) => s.classList.remove('is-playing'));
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
    for (const node of $$('#dkLive, #dkHero, #dkFoot')) node.remove();

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
    /* A stream still being fetched into a billboard that has left the page is
       the whole reason this needs a hand rather than a garbage collector. On
       home it is not left behind — buildHome carries it into the new slide —
       so this is the door being closed on the way out. */
    if (state.tab !== 'home') stopPreview();
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
