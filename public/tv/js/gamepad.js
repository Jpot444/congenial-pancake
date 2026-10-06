/*
 * The controller, read directly.
 *
 * "add the gamepad support"
 *
 * This app was written for a Shield remote, so it listens for arrow keys,
 * Enter and Escape and nothing else. On an Xbox that works only when Edge is
 * in its d-pad mode — the one that turns the pad into arrow keys — and Edge
 * opens in CURSOR mode, where the left stick drives a mouse pointer and the
 * app receives nothing at all. The first thing anybody does is press a
 * direction, watch nothing happen, and conclude the box is broken.
 *
 * The Gamepad API is in Edge on Xbox and in every browser that matters, and it
 * reports the pad whatever mode the browser is in. So the pad is read here and
 * turned into the same key names the rest of the app already understands,
 * which means no screen has to learn about controllers.
 *
 * WHAT IT IS NOT: a second set of controls. Every button below maps onto a key
 * this app already handles — four directions, OK and BACK. A control that
 * exists only on a pad would be a control nobody holding a remote can reach,
 * and this app is used with both.
 */

/* The standard mapping, which is what a browser reports an Xbox pad as. Only
   the six that mean something here; the rest are deliberately unmapped —
   a button that does nothing surprising is better than one that does something
   nobody asked for. */
const BUTTONS = {
  0: 'Enter',       // A
  1: 'Escape',      // B — the app already treats Escape as BACK
  12: 'ArrowUp',
  13: 'ArrowDown',
  14: 'ArrowLeft',
  15: 'ArrowRight',
};

/* Left stick, for anybody who reaches for it instead of the d-pad. Far enough
   over to be deliberate: a resting stick reads a little off centre on most
   pads, and a drifting one would walk the focus across the screen on its own. */
const STICK = 0.6;

/* How a held direction repeats. The first wait is long enough that a single
   push moves exactly one card; the second is the speed it then walks at.
   Without this, holding a direction moves one place and stops, which feels
   like a dropped input rather than a deliberate limit. */
const FIRST_REPEAT_MS = 420;
const NEXT_REPEAT_MS = 110;

/* OK and BACK never repeat. Holding A through a list of channels, opening
   each in turn, is nobody's intention. */
const REPEATS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/**
 * Watch any connected pad and call `press(key)` with the key names the app's
 * own handler takes.
 *
 * Polled rather than evented because the Gamepad API has no button events —
 * the spec only offers a snapshot — and polled ONLY while a pad is connected,
 * so a television with no controller anywhere near it does no work at all.
 */
export function watchGamepad(press) {
  if (!navigator.getGamepads) return;

  /* key → when it may next fire. Holds the repeat schedule and doubles as the
     "is it still down" record, so a button released and pressed again inside
     the repeat window still fires immediately. */
  const held = new Map();
  let running = false;

  const down = (key, now) => {
    const due = held.get(key);
    if (due === undefined) {
      held.set(key, now + FIRST_REPEAT_MS);
      press(key);
      return;
    }
    if (!REPEATS.has(key)) return;
    if (now >= due) {
      held.set(key, now + NEXT_REPEAT_MS);
      press(key);
    }
  };

  const tick = () => {
    /* Re-read every frame rather than keeping a reference: in Chromium the
       Gamepad objects are snapshots and a held one never changes. */
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = performance.now();
    const seen = new Set();

    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      for (const [index, key] of Object.entries(BUTTONS)) {
        const button = pad.buttons[index];
        /* `.pressed` rather than `.value`, so a trigger-style analogue button
           is read the same way a digital one is. */
        if (button && button.pressed) seen.add(key);
      }
      const [x = 0, y = 0] = pad.axes || [];
      if (x <= -STICK) seen.add('ArrowLeft');
      else if (x >= STICK) seen.add('ArrowRight');
      if (y <= -STICK) seen.add('ArrowUp');
      else if (y >= STICK) seen.add('ArrowDown');
    }

    for (const key of seen) down(key, now);
    /* Anything no longer held forgets its schedule, so the next push is
       immediate rather than waiting out a repeat it is not part of. */
    for (const key of [...held.keys()]) if (!seen.has(key)) held.delete(key);

    if (running) requestAnimationFrame(tick);
  };

  const start = () => {
    if (running) return;
    running = true;
    requestAnimationFrame(tick);
  };
  const stop = () => {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    if (pads.some((p) => p && p.connected)) return;   // another one is still on
    running = false;
    held.clear();
  };

  window.addEventListener('gamepadconnected', start);
  window.addEventListener('gamepaddisconnected', stop);
  /* A pad connected before this page loaded raises no event, and on Xbox that
     is the normal case: the controller was on before the browser opened. The
     spec hides pads until a gesture, so this also runs once after the first
     one — by which time the pad is visible and `start` is idempotent. */
  if ([...(navigator.getGamepads() || [])].some((p) => p && p.connected)) start();
  window.addEventListener('keydown', start, { once: true });
  window.addEventListener('pointerdown', start, { once: true });
}
