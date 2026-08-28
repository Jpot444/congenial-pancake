/**
 * Multi-view, opened the way a person opens it.
 *
 * There are two buttons for one feature and only ever one of them on screen.
 * `#multiviewBtn` is the original, in the content header, and it is still the
 * one that HANDLES the press — but on Live TV the desktop layer draws the
 * control in the category bar instead, standing where the sort used to, and
 * hides the original so the page does not offer the same thing twice.
 *
 * Six suites open multi-view on their way to testing something else — the
 * cells, the streams, the episode picker — and none of them is about where
 * the button is. So they ask here, and this presses whichever one the page is
 * actually showing. A suite that pinned itself to one of the two would fail
 * the next time the control moved, which is exactly what happened when it
 * did.
 */

/** The multi-view control a viewer can actually see, or null.
 *
 * getClientRects() rather than the element's own `hidden` and `display`: the
 * bar button sits inside the category bar, and a bar that is hidden as a whole
 * leaves its children computing a perfectly ordinary `display: flex`. Asking
 * whether the element occupies any space on the page is the question actually
 * being asked, and it is the only form of it that reads the ancestors too. */
const VISIBLE = () => {
  const shown = (sel) => {
    const node = document.querySelector(sel);
    return node && node.getClientRects().length ? node : null;
  };
  return shown('#dkMvBtn') || shown('#multiviewBtn');
};

/** Press it. Throws rather than passing quietly if the page offers neither. */
async function openMultiview(page) {
  const pressed = await page.evaluate(
    `(() => { const b = (${VISIBLE})(); if (!b) return false; b.click(); return true; })()`
  );
  if (!pressed) throw new Error('no multi-view button is visible on this page');
  return pressed;
}

/** Whether a viewer is being offered multi-view at all, either way round. */
function multiviewOffered(page) {
  return page.evaluate(`Boolean((${VISIBLE})())`);
}

module.exports = { openMultiview, multiviewOffered };
