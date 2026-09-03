/*
 * Treasure Theater, on a dashboard.
 *
 * The look is car.css. This is the one thing the car needs that no amount of
 * styling could produce: a home screen arranged for a glance rather than for a
 * scroll, and a ticker that does not exist anywhere else in the portal.
 *
 * ── What it does not do ──────────────────────────────────────────────────
 * It does not build a second app. desktop.js has already drawn home — the
 * rails, the cards, the scoreboard, all of it — and this moves those same
 * nodes into a different arrangement. A card in the car is the card the rest
 * of the portal draws, which is why pressing one plays the right thing without
 * this file knowing anything about playback.
 *
 * ── Why a ticker ─────────────────────────────────────────────────────────
 * The scoreboard answers "what is on" for a handful of games in detail. The
 * other question in a car — what is the score in the game I am not watching —
 * is a different shape of answer: every game, one line, no scrolling. It moves
 * because a full slate is longer than any screen; it stops when held, because
 * the one thing somebody does with a ticker is stop it to read one.
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

  /* ------------------------------------------------------------ the ticker ── */

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const side = (team) => (team && team.abbr) || '—';
  const points = (team) => {
    const n = team && team.score;
    return n === null || n === undefined ? '—' : String(n);
  };

  /** What this game is doing, in the fewest words that still say it. */
  function saying(game) {
    if (game.status === 'final') return 'Final';
    if (game.status === 'live') return game.clock || 'Live';
    if (game.warmup) return 'Warmup';
    return game.detailedState || game.clock || '';
  }

  function tickEntry(game) {
    const wrap = el('span', `tick-game is-${game.status || 'live'}`);
    wrap.append(
      el('span', 'tick-team', side(game.away)),
      el('span', 'tick-num', points(game.away)),
      el('span', 'tick-sep', '–'),
      el('span', 'tick-num', points(game.home)),
      el('span', 'tick-team', side(game.home))
    );
    const state = saying(game);
    if (state) wrap.append(el('span', 'tick-state', state));
    return wrap;
  }

  /**
   * Paint the line.
   *
   * The games are laid down TWICE. The animation slides the track exactly half
   * its own width and starts over, so the second copy is what is on screen
   * while the first is being rewound — without it the line runs out and leaves
   * a moving band of nothing until the loop comes round.
   */
  const paintTicker = guard('ticker', (host) => {
    const games = ((window.dkSlate && window.dkSlate.games) || [])
      .filter((g) => g && g.id);
    host.innerHTML = '';
    if (!games.length) {
      const said = window.dkSlate && window.dkSlate.asked
        ? 'No games on right now.'
        : 'Reading the slate…';
      host.append(el('p', 'tick-empty', said));
      return;
    }
    const track = el('div', 'tick-track');
    for (let pass = 0; pass < 2; pass += 1) {
      for (const game of games) track.append(tickEntry(game));
    }
    /* Longer slates take proportionally longer, so the reading speed is the
       same whether there are three games or thirty. */
    track.style.animationDuration = `${Math.max(24, games.length * 6)}s`;
    host.append(track);
  });

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
   * columns and the ticker, no scrolling — and that only holds if the grid is
   * exactly the room left over. Two earlier tries got this wrong by assuming:
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
    const ticker = el('div', 'car-ticker');

    /* Everything already on home, in the order it was drawn, minus the pieces
       that get a home of their own below. */
    for (const node of [...view.children]) {
      if (node.classList.contains('car-watch')
        || node.classList.contains('car-scores')
        || node.classList.contains('car-ticker')) {
        node.remove();
        continue;
      }
      watch.append(node);
    }

    view.classList.add('car-home');
    document.querySelector('.app-shell')?.classList.add('car-fit');
    view.append(watch, scores, ticker);
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
    paintTicker(ticker);
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
          || n.classList.contains('car-scores')
          || n.classList.contains('car-ticker'))));
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
    /* A fresh slate is a fresh ticker, whether or not anything redrew. */
    window.addEventListener('dk:slate', () => {
      const host = $('.car-ticker');
      if (host && isCar()) paintTicker(host);
    });
    /* Holding the line stops it, which is the whole of what a ticker is for.
       Pointer events rather than :active so a press that drifts still holds. */
    document.addEventListener('pointerdown', (e) => {
      const host = e.target.closest?.('.car-ticker');
      if (host) host.classList.add('is-held');
    });
    for (const done of ['pointerup', 'pointercancel', 'pointerleave']) {
      document.addEventListener(done, () => {
        for (const host of document.querySelectorAll('.car-ticker.is-held')) {
          host.classList.remove('is-held');
        }
      });
    }
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
