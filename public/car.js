/*
 * Treasure Theater, on a dashboard.
 *
 * The look is car.css. This is the one thing the car needs that no amount of
 * styling could produce: a home screen arranged for a glance rather than for a
 * scroll.
 *
 * ── What it does not do ──────────────────────────────────────────────────
 * It does not build a second app. desktop.js has already drawn home — the
 * rails, the cards, the scoreboard, all of it — and this moves those same
 * nodes into a different arrangement. A card in the car is the card the rest
 * of the portal draws, which is why pressing one plays the right thing without
 * this file knowing anything about playback.
 *
 * There was a scrolling ticker along the foot for a while. It is gone: a line
 * of scores sliding across a dashboard is movement in the corner of somebody's
 * eye that they cannot stop reading, and the scoreboard beside it was already
 * answering the question. Removed rather than replaced — the room goes back to
 * the two columns.
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const isCar = () => document.documentElement.classList.contains('car');

  /* Never let a layout fault take the portal down with it. Same reasoning as
     desktop.js's own guard: this layer is chrome, and chrome that throws must
     not stop somebody watching television. */
  const guard = (what, fn) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error(`car: ${what} —`, err);
      return undefined;
    }
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* -------------------------------------------------------- the home screen ── */

  /**
   * Move what desktop.js drew into two columns and a foot.
   *
   * Everything here is a MOVE. Nothing is rebuilt, nothing is cloned — the
   * nodes keep their listeners, so a card that played a film on the desktop
   * plays it here without this file having an opinion about playback.
   */
  /**
   * How tall home may be, measured.
   *
   * The whole promise of this screen is that everything is on it — both
   * columns, no scrolling — and that only holds if the grid is exactly the
   * room left over. Two earlier tries got this wrong by assuming:
   * one guessed the shell's padding and was fifty pixels out, the other turned
   * the shell into a flex column to make it size itself and collapsed the left
   * column to zero, because the shell is a GRID with a sidebar track and
   * taking that away took the width with it.
   *
   * So nothing is assumed. The window, less the header, less this shell's own
   * padding, all read off the page at the moment of laying out.
   */
  const fit = (view) => {
    const shell = view.closest('.app-shell');
    const head = $('#siteHeader');
    if (!shell) return;
    const pad = (n, side) => parseFloat(getComputedStyle(n)[side]) || 0;
    const room = window.innerHeight
      - (head && !head.hidden ? head.getBoundingClientRect().height : 0)
      - pad(shell, 'paddingTop') - pad(shell, 'paddingBottom');
    view.style.setProperty('--car-fit', `${Math.max(320, Math.round(room))}px`);
  };

  const unfit = () => {
    document.querySelector('.app-shell')?.classList.remove('car-fit');
    const view = $('#homeView');
    view?.classList.remove('car-home');
    view?.style.removeProperty('--car-fit');
  };

  const layOut = guard('home', () => {
    const view = $('#homeView');
    /* Any page that is not the car's home gives the shell back its scroll. */
    if (!isCar() || !view || view.hidden) return unfit();

    const watch = el('div', 'car-watch');
    const scores = el('div', 'car-scores');

    /* Everything already on home, in the order it was drawn, minus the pieces
       that get a home of their own below. */
    for (const node of [...view.children]) {
      if (node.classList.contains('car-watch')
        || node.classList.contains('car-scores')) {
        node.remove();
        continue;
      }
      watch.append(node);
    }

    view.classList.add('car-home');
    document.querySelector('.app-shell')?.classList.add('car-fit');
    view.append(watch, scores);
    fit(view);

    /*
     * The scoreboard, asked for rather than copied.
     *
     * On a desktop it is built by the Live TV page and lives across the page
     * head; on home it does not exist at all, because home has never wanted
     * it. desktop.js owns the band, the poll and the slate, so the car asks it
     * to draw into this column instead of carrying a second of each — see
     * scoreboard() over there for what the argument does.
     */
    window.__ttDesktop?.scoreboard?.(scores);
  });

  /* ------------------------------------------------------------- the wiring ── */

  /*
   * desktop.js redraws home on its own schedule, and app.js redraws it on
   * every render. Either puts the page back the way it was, so this has to run
   * again afterwards rather than once.
   *
   * A MutationObserver rather than a hook, because there is no hook: home is
   * rebuilt by two files that do not know this one exists. Watching the node
   * they both rebuild is the only thing that catches both.
   */
  let due = 0;
  const soon = () => {
    if (!isCar()) return;
    clearTimeout(due);
    due = setTimeout(layOut, 60);
  };

  const watchHome = () => {
    const view = $('#homeView');
    if (!view) return;
    new MutationObserver((records) => {
      /* Ignore this file's own work, or laying out would lay out again. */
      const ours = records.every((r) => [...r.addedNodes].every((n) =>
        n.classList && (n.classList.contains('car-watch')
          || n.classList.contains('car-scores'))));
      if (ours) return;
      soon();
    }).observe(view, { childList: true });
  };

  const start = () => {
    watchHome();
    soon();
    /* The room changes when the window does. A Tesla's browser resizes when
       its own chrome comes and goes, so this is not hypothetical. */
    window.addEventListener('resize', () => {
      const view = $('#homeView.car-home');
      if (view && isCar()) fit(view);
    });
    /* Leaving car mode puts home back: the class goes, and the next redraw by
       app.js or desktop.js finds an ordinary page again. */
    new MutationObserver(() => {
      if (!isCar()) unfit();
      else soon();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
