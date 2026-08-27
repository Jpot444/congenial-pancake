/*
 * The D-pad.
 *
 * Every focusable thing on every screen carries data-r (row) and data-c
 * (column). The engine keeps one cursor, remembers the column PER ROW — so
 * coming back down to a row you were in lands where you left it rather than at
 * the start — and does the two kinds of scrolling a TV needs: the row itself
 * slides horizontally, the page slides vertically, and both keep a 64px lead
 * so the focused thing is never flush against an edge.
 *
 * Everything measures through the stage scale: the stage is 1920 wide and the
 * screen usually is not, so getBoundingClientRect() answers in scaled pixels
 * and every distance has to be divided back out before it means anything.
 */

const LEAD = 64;

export const focus = {
  pos: { r: 1, c: 0 },
  memory: {},
  rows: {},
  scale: 1,
  el: null,
  onFocus: null,

  setScale(scale) {
    this.scale = scale || 1;
  },

  /** Re-read the DOM. Called after every render. */
  collect() {
    this.rows = {};
    document.querySelectorAll('[data-r]').forEach((node) => {
      if (node.closest('[hidden]')) return;
      const r = Number(node.dataset.r);
      (this.rows[r] = this.rows[r] || []).push(node);
    });
    for (const key of Object.keys(this.rows)) {
      this.rows[key].sort((a, b) => Number(a.dataset.c) - Number(b.dataset.c));
    }
  },

  rowKeys() {
    return Object.keys(this.rows).map(Number).sort((a, b) => a - b);
  },

  current() {
    const row = this.rows[this.pos.r];
    return row ? row[this.pos.c] || null : null;
  },

  /** Put the cursor somewhere specific and forget where it had been. */
  reset(r = 1, c = 0) {
    this.pos = { r, c };
    this.memory = { [r]: c };
    if (this.el) this.el.classList.remove('f');
    this.el = null;
  },

  set(r, c) {
    this.pos = { r, c };
    this.memory[r] = c;
    this.apply();
  },

  /**
   * Move. Vertical movement skips rows that do not exist, so a screen can
   * number its rows loosely (1, 2, 3 … 30) without every number being live.
   */
  move(dr, dc) {
    if (dc) {
      const row = this.rows[this.pos.r];
      if (!row) return;
      const next = Math.max(0, Math.min(this.pos.c + dc, row.length - 1));
      if (next === this.pos.c) return;
      this.pos.c = next;
      this.memory[this.pos.r] = next;
      this.apply();
      return;
    }
    if (!dr) return;
    const keys = this.rowKeys();
    const at = keys.indexOf(this.pos.r);
    const target = keys[at + (dr > 0 ? 1 : -1)];
    if (target === undefined) return;
    this.pos = { r: target, c: this.memory[target] ?? 0 };
    this.apply();
  },

  /** Paint the cursor and bring it into view. */
  apply() {
    const keys = this.rowKeys();
    if (!keys.length) return;
    if (!this.rows[this.pos.r]) this.pos.r = keys[0];
    const row = this.rows[this.pos.r];
    this.pos.c = Math.max(0, Math.min(this.pos.c, row.length - 1));
    this.memory[this.pos.r] = this.pos.c;

    const node = row[this.pos.c];
    if (!node) return;
    if (this.el && this.el !== node) this.el.classList.remove('f');
    node.classList.add('f');
    this.el = node;

    this.scrollStrip(node);
    this.scrollPage(node);
    if (this.onFocus) this.onFocus(node);
  },

  scrollStrip(node) {
    const strip = node.closest('.strip');
    if (!strip) return;
    const s = this.scale;
    const sr = strip.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    const over = (nr.right - (sr.right - LEAD * s)) / s;
    const under = ((sr.left + LEAD * s) - nr.left) / s;
    if (over > 0) strip.scrollLeft += over;
    else if (under > 0) strip.scrollLeft -= under;
  },

  scrollPage(node) {
    /* An overlay with its own scroller (the guide) scrolls itself; everything
       else scrolls the page under the header. */
    const own = node.closest('[data-scroller]');
    const scroller = own || document.getElementById('scroller');
    if (!scroller) return;
    const s = this.scale;
    const block = node.closest('.rowblock') || node;

    /* The top row is the nav: there is nothing above it, so the page goes home
       rather than nudging by a few pixels. */
    if (!own && this.pos.r === 0) {
      scroller.scrollTop = 0;
      return;
    }

    const cr = scroller.getBoundingClientRect();
    const br = block.getBoundingClientRect();
    const hints = own ? null : document.getElementById('hints');
    const inset = hints && !hints.hidden ? hints.offsetHeight * s : 0;
    const limit = cr.bottom - inset;
    if (br.bottom > limit) scroller.scrollTop += (br.bottom - limit) / s + 12;
    else if (br.top < cr.top) scroller.scrollTop -= (cr.top - br.top) / s + 12;
  },
};
