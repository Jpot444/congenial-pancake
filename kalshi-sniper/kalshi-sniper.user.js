// ==UserScript==
// @name         Kalshi Sniper
// @namespace    ts-capital
// @version      9.0
// @description  One-tap YES sweeps on Kalshi event markets — built for iPhone and iPad
// @author       TS Capital
// @match        https://kalshi.com/*
// @match        https://www.kalshi.com/*
// @match        http://kalshi.com/*
// @match        http://www.kalshi.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      external-api.kalshi.com
// @connect      api.elections.kalshi.com
// @connect      *.workers.dev
// @run-at       document-idle
// ==/UserScript==

/* Kalshi Sniper — an overlay over Kalshi's own market pages that turns "buy
 * every YES contract offered under my price" into one tap.
 *
 * Three things about Kalshi's API changed under version 8 and all three are
 * load-bearing here:
 *
 *   1. The production host is now external-api.kalshi.com. api.elections.
 *      kalshi.com still answers and is kept as a fallback, but new
 *      integrations are pointed at the former.
 *   2. Integer-cent price fields are gone. Money arrives as fixed-point
 *      dollar strings ("0.6500") in fields suffixed _dollars, and contract
 *      counts as fixed-point strings ("13.00") in fields suffixed _fp.
 *      Reading market.yes_ask now yields undefined, not a price.
 *   3. Orders are written through POST /portfolio/events/orders, which takes
 *      a single book side ("bid"/"ask") and one decimal price, rather than
 *      the old side:"yes" + action:"buy" + yes_price:<cents> shape.
 *
 * Authentication did not change: RSA-PSS over SHA-256, salt length 32, over
 * the string <timestamp_ms><METHOD><path>, where path carries the /trade-api/v2
 * prefix and drops the query string.
 */

(function () {
  'use strict';

  if (location.pathname.split('/')[1] !== 'markets') return;

  /* ========================================================== constants === */

  const HOST = 'https://external-api.kalshi.com';
  const HOST_LEGACY = 'https://api.elections.kalshi.com';
  const PREFIX = '/trade-api/v2';

  /* Wide enough for two market cards side by side. Below this we are on a
     phone, or an iPad in a narrow Split View pane, and the overlay goes
     full-bleed single column. */
  const WIDE = 760;

  const KEY_ALG = { name: 'RSA-PSS', hash: 'SHA-256' };
  const SIGN_ALG = { name: 'RSA-PSS', saltLength: 32 };

  /* ============================================================ storage === */

  const store = {
    get: (k, d) => {
      try { const v = localStorage.getItem('ks_' + k); return v === null ? d : v; }
      catch (e) { return d; }
    },
    set: (k, v) => { try { localStorage.setItem('ks_' + k, v); } catch (e) {} },
    del: (k) => { try { localStorage.removeItem('ks_' + k); } catch (e) {} },
  };

  const cfg = {
    proxy: store.get('proxy', ''),
    host: store.get('host', HOST),
    keyId: store.get('keyid', ''),
    pem: store.get('pem', ''),
    qty: parseInt(store.get('qty', '100'), 10) || 100,
    cap: store.get('cap', ''),          // max price per YES contract, in cents
    poll: parseInt(store.get('poll', '5'), 10) || 5,
    confirm: store.get('confirm', '0') === '1',
  };

  let cryptoKey = null;

  /* ======================================================== fixed point === */

  /* Prices cross the wire as dollar strings and are held here as integer
     cents, which is the unit the whole book is quoted in and the only one
     where 100 - price is exact. Sub-penny markets round to the cent for
     display only — the string we were handed is what gets sent back. */

  const centsOf = (dollars) => {
    const n = parseFloat(dollars);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  const countOf = (fp) => {
    const n = parseFloat(fp);
    return Number.isFinite(n) ? n : 0;
  };

  /* Kalshi accepts up to four decimal places on a limit price. */
  const dollarsOf = (cents) => (cents / 100).toFixed(4);

  const priceLabel = (cents) => (cents == null ? '––' : cents + '¢');

  const money = (cents) =>
    '$' + (cents / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ============================================================== crypto === */

  const bytesToStr = (arr) => {
    let s = '';
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return s;
  };

  const b64url = (arr) =>
    btoa(bytesToStr(arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  /* Kalshi hands out PKCS#8 keys, but a key that has been round-tripped
     through openssl rsa is often PKCS#1, which WebCrypto will not import.
     Unpack that DER by hand into a JWK rather than making the user convert
     the file on a device that has no openssl. */
  function parsePKCS1(bytes) {
    let pos = 0;
    const readLen = () => {
      const b = bytes[pos++];
      if (b < 0x80) return b;
      let n = b & 0x7f, len = 0;
      while (n--) len = (len << 8) | bytes[pos++];
      return len;
    };
    const readInt = () => {
      if (bytes[pos++] !== 0x02) throw new Error('Expected INTEGER tag');
      const len = readLen();
      let val = bytes.slice(pos, pos + len);
      pos += len;
      if (val[0] === 0 && val.length > 1) val = val.slice(1);
      return val;
    };
    if (bytes[pos++] !== 0x30) throw new Error('Expected SEQUENCE');
    readLen();
    readInt();                       // version
    return {
      kty: 'RSA',
      n: b64url(readInt()), e: b64url(readInt()), d: b64url(readInt()),
      p: b64url(readInt()), q: b64url(readInt()),
      dp: b64url(readInt()), dq: b64url(readInt()), qi: b64url(readInt()),
    };
  }

  function importPEM(pem) {
    const b64 = pem.replace(/-+BEGIN[^-]*-+|-+END[^-]*-+|\s/g, '');
    let raw;
    try { raw = atob(b64); }
    catch (e) { return Promise.reject(new Error('Private key is not valid base64')); }
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return crypto.subtle.importKey('pkcs8', bytes.buffer, KEY_ALG, false, ['sign'])
      .catch(() => crypto.subtle.importKey('jwk', parsePKCS1(bytes), KEY_ALG, false, ['sign']))
      .catch(() => { throw new Error('Could not read that private key (need RSA PKCS#8 or PKCS#1 PEM)'); });
  }

  /* ================================================================ http === */

  const gmFetch =
    typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest :
    (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) :
    null;

  /* A Worker proxy, if configured, stands in for the API host and mirrors the
     same /trade-api/v2 path underneath it. The signature is over the Kalshi
     path either way — the proxy is transport, not identity. */
  const origin = () => (cfg.proxy ? cfg.proxy : cfg.host).replace(/\/+$/, '');

  function sign(method, path) {
    const ts = String(Date.now());
    const msg = ts + method.toUpperCase() + path.split('?')[0];
    return crypto.subtle
      .sign(SIGN_ALG, cryptoKey, new TextEncoder().encode(msg))
      .then((buf) => ({ ts, sig: btoa(bytesToStr(new Uint8Array(buf))) }));
  }

  function httpError(status, text) {
    const err = new Error('HTTP ' + status + ': ' + (text || '(empty)').slice(0, 200));
    err.status = status;
    return err;
  }

  function apiRequest(method, path, body) {
    if (!cryptoKey) return Promise.reject(new Error('No key loaded'));

    return sign(method, PREFIX + path).then((s) => {
      const url = origin() + PREFIX + path;
      const headers = {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': cfg.keyId,
        'KALSHI-ACCESS-SIGNATURE': s.sig,
        'KALSHI-ACCESS-TIMESTAMP': s.ts,
      };
      const payload = body ? JSON.stringify(body) : undefined;

      /* Straight to Kalshi the page's own origin is wrong for CORS, so the
         userscript engine's cross-origin fetch does the work when there is no
         proxy in front. Through a proxy, plain fetch is both allowed and
         faster. */
      if (!cfg.proxy && gmFetch) {
        return new Promise((resolve, reject) => {
          gmFetch({
            method, url, headers, data: payload,
            onload: (resp) => {
              if (resp.status >= 400) return reject(httpError(resp.status, resp.responseText));
              try { resolve(resp.responseText ? JSON.parse(resp.responseText) : {}); }
              catch (e) { reject(new Error('Could not parse response')); }
            },
            onerror: () => reject(new Error('Network error reaching ' + origin())),
            ontimeout: () => reject(new Error('Request timed out')),
          });
        });
      }

      const opts = { method, headers };
      if (payload) opts.body = payload;
      return fetch(url, opts).then((r) => {
        if (!r.ok) return r.text().then((t) => { throw httpError(r.status, t); });
        return r.text().then((t) => (t ? JSON.parse(t) : {}));
      });
    });
  }

  /* ============================================================ the book === */

  /* Kalshi publishes bids only, on both sides. The YES offers we are lifting
     are the mirror of the NO book: a NO bid at 7¢ is a YES ask at 93¢. */

  function levels(raw, asDollars) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((lvl) => ({
        cents: asDollars ? centsOf(lvl[0]) : Math.round(parseFloat(lvl[0])),
        size: asDollars ? countOf(lvl[1]) : parseFloat(lvl[1]),
      }))
      .filter((l) => l.cents != null && Number.isFinite(l.cents) && l.size > 0);
  }

  function readBook(resp) {
    const fp = resp.orderbook_fp;
    const legacy = resp.orderbook;
    let noBids = [];
    if (fp) noBids = levels(fp.no_dollars || fp.no, true);
    else if (legacy) noBids = levels(legacy.no, false);

    /* Cheapest YES first — the order we want to eat them in. */
    const asks = noBids
      .map((l) => ({ cents: 100 - l.cents, size: l.size }))
      .filter((a) => a.cents > 0 && a.cents < 100)
      .sort((a, b) => a.cents - b.cents);

    const depth = asks.reduce((n, a) => n + a.size, 0);
    return { asks, best: asks.length ? asks[0].cents : null, depth, at: Date.now() };
  }

  const getBook = (ticker) =>
    apiRequest('GET', '/markets/' + encodeURIComponent(ticker) + '/orderbook').then(readBook);

  /* Walk the ladder cheapest-first, stopping at the size we want or the price
     we refuse to cross, whichever comes first. The limit we send is the worst
     level we actually intend to touch, so an immediate-or-cancel order takes
     everything down to it and nothing above it. */
  function plan(asks, want, capCents) {
    let count = 0, limit = null, cost = 0;
    for (const a of asks) {
      if (capCents != null && a.cents > capCents) break;
      /* Whole contracts only. A level can rest a fractional size, and taking
         part of one would make the count we send and the cost we quote
         disagree with each other. */
      const take = Math.floor(Math.min(a.size, want - count));
      if (take <= 0) break;
      count += take;
      cost += take * a.cents;
      limit = a.cents;
      if (count >= want) break;
    }
    return { count, limit, cost: Math.round(cost) };
  }

  /* ============================================================== orders === */

  const orderId = () =>
    'ks-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  function buyYes(ticker, count, limitCents) {
    return apiRequest('POST', '/portfolio/events/orders', {
      ticker,
      client_order_id: orderId(),
      side: 'bid',                      // the YES book's bid side; V2 has no "yes"
      count: String(count),
      price: dollarsOf(limitCents),
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
    }).catch((e) => {
      /* An exchange still on the pre-V2 surface 404s that path. Nothing was
         placed, so the old cents-based endpoint is safe to try. */
      if (e.status !== 404) throw e;
      return apiRequest('POST', '/portfolio/orders', {
        ticker, side: 'yes', action: 'buy',
        count, yes_price: limitCents,
        client_order_id: orderId(),
        time_in_force: 'immediate_or_cancel',
      });
    });
  }

  const filledFrom = (resp) => {
    const o = resp.order || resp;
    const v = o.fill_count != null ? o.fill_count : o.fill_count_fp;
    return Math.round(countOf(v));
  };

  const balanceFrom = (resp) =>
    resp.balance_dollars != null ? centsOf(resp.balance_dollars)
    : resp.balance != null ? Math.round(resp.balance)
    : null;

  /* ================================================================= css === */

  const CSS = `
#ks-fab{position:fixed;z-index:2147483646;bottom:calc(96px + env(safe-area-inset-bottom));right:calc(16px + env(safe-area-inset-right));background:#30d158;color:#00250d;font:800 14px/1 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.6px;padding:14px 20px;border:none;border-radius:50px;box-shadow:0 6px 24px rgba(48,209,88,.45);cursor:pointer;touch-action:none;-webkit-tap-highlight-color:transparent;transition:opacity .15s}
#ks-fab.on{opacity:.35}
#ks-fab:active{transform:scale(.96)}

#ks-wrap{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:stretch;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;color:#fff}
#ks-panel{position:relative;display:flex;flex-direction:column;width:100%;background:#0a0a0b;overflow:hidden;padding-bottom:env(safe-area-inset-bottom)}

/* On an iPad the overlay is a card, not a takeover — the market page stays
   visible behind it and the sniper never gets wider than it can use. */
@media (min-width:${WIDE}px){
  #ks-wrap{align-items:center;padding:24px}
  #ks-panel{max-width:1100px;max-height:min(880px,92vh);border-radius:22px;border:1px solid #26262a;box-shadow:0 30px 90px rgba(0,0,0,.7)}
}

#ks-head{flex-shrink:0;background:#111114;border-bottom:1px solid #1f1f23;padding:12px 14px;padding-top:calc(12px + env(safe-area-inset-top))}
@media (min-width:${WIDE}px){#ks-head{padding-top:12px}}
#ks-row1{display:flex;align-items:center;gap:10px}
#ks-title{flex:1;min-width:0;font-size:15px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ks-sub{font-size:11px;color:#7d7d85;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ks-icon{flex-shrink:0;width:38px;height:38px;border:none;border-radius:12px;background:#1f1f24;color:#9a9aa2;font-size:17px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ks-icon:active{background:#2c2c33}
@media (hover:hover){.ks-icon:hover{background:#2c2c33;color:#fff}}

#ks-row2{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.ks-field{display:flex;align-items:center;gap:6px;background:#1a1a1e;border:1px solid #26262c;border-radius:11px;padding:6px 10px}
.ks-field label{font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:#6e6e77}
.ks-field input{width:62px;background:none;border:none;color:#fff;font:600 15px/1 inherit;text-align:right;outline:none;-webkit-appearance:none;padding:0}
.ks-field input::-webkit-outer-spin-button,.ks-field input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
#ks-search{flex:1;min-width:120px;background:#1a1a1e;border:1px solid #26262c;border-radius:11px;padding:9px 12px;color:#fff;font:400 14px/1 inherit;outline:none;-webkit-appearance:none}
#ks-search:focus,.ks-field:focus-within{border-color:#30d158}

.ks-chips{display:flex;gap:6px}
.ks-chip{background:#1a1a1e;border:1px solid #26262c;color:#9a9aa2;font:700 12px/1 inherit;padding:9px 11px;border-radius:10px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ks-chip.on{background:#30d158;border-color:#30d158;color:#00250d}

#ks-body{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:12px 14px}
#ks-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}

.ksc{display:flex;align-items:center;gap:12px;background:#151518;border:1px solid #212127;border-radius:16px;padding:12px 12px 12px 14px}
.ksc.hot{border-color:#30d158}
.ks-i{flex:1;min-width:0}
.ks-n{font-size:16px;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ks-p{display:flex;align-items:baseline;gap:8px;margin-top:4px}
.ks-ask{font-size:19px;font-weight:800;color:#30d158;font-variant-numeric:tabular-nums}
.ks-ask.none{color:#4a4a52}
.ks-meta{font-size:11px;color:#6e6e77;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ks-key{flex-shrink:0;display:none;align-self:flex-start;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#5a5a63;background:#1c1c21;border-radius:5px;padding:3px 5px}
@media (min-width:${WIDE}px){.ks-key{display:block}}

.ks-b{flex-shrink:0;min-width:88px;background:#30d158;border:none;border-radius:13px;color:#00250d;font:800 15px/1.15 inherit;padding:15px 14px;cursor:pointer;-webkit-tap-highlight-color:transparent;font-variant-numeric:tabular-nums}
.ks-b small{display:block;font-size:10px;font-weight:700;opacity:.62;margin-top:3px}
.ks-b:active{transform:scale(.97)}
.ks-b.busy{background:#2a2a30;color:#7d7d85}
.ks-b.dead{background:#2a2a30;color:#55555e}
.ks-b.err{background:#ff453a;color:#fff}
.ks-b.ok{background:#0b8c37;color:#fff}
.ks-b.confirm{background:#ff9f0a;color:#241300}

#ks-empty{text-align:center;padding:56px 20px;color:#4a4a52;font-size:14px}
#ks-foot{flex-shrink:0;border-top:1px solid #1f1f23;background:#111114;padding:9px 14px;font-size:12px;color:#5a5a63;min-height:36px;display:flex;align-items:center;gap:8px}
#ks-foot b{font-weight:700}

#ks-set{padding:16px;max-width:560px;margin:0 auto;width:100%}
#ks-set p{font-size:13px;color:#8a8a92;line-height:1.55;margin:0 0 4px}
#ks-set label{display:block;font-size:10px;font-weight:600;letter-spacing:.9px;text-transform:uppercase;color:#6e6e77;margin:16px 0 5px}
#ks-set input,#ks-set textarea{width:100%;box-sizing:border-box;background:#151518;border:1px solid #26262c;border-radius:11px;color:#fff;font:400 14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:11px;outline:none;-webkit-appearance:none}
#ks-set textarea{height:130px;resize:vertical;font-size:11px}
#ks-set input:focus,#ks-set textarea:focus{border-color:#30d158}
.ks-note{font-size:11px;color:#6e6e77;margin-top:5px;line-height:1.5}
.ks-toggle{display:flex;align-items:center;gap:10px;margin-top:16px;font-size:14px;color:#c8c8d0}
.ks-toggle input{width:auto;-webkit-appearance:auto;accent-color:#30d158;flex-shrink:0}
.ks-go{width:100%;background:#30d158;border:none;border-radius:13px;color:#00250d;font:800 16px/1 inherit;padding:16px;margin-top:20px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ks-go:active{opacity:.8}
.ks-flat{background:none;border:none;color:#ff453a;font:600 13px/1 inherit;padding:12px 0;margin-top:10px;cursor:pointer}

@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

  /* ================================================================= app === */

  let panel = null, styleEl = null, timer = null;
  let markets = [], books = {}, filter = '', eventTicker = '', eventTitle = '';
  let pending = null;   // ticker awaiting a second tap, when confirm is on

  /* What a row's button is currently saying, keyed by ticker. Held here rather
     than on the element because the board re-renders under you — on the poll,
     and again the moment a fill lands — and a result you cannot read because
     the next refresh painted over it may as well not have been shown. */
  const badges = {};

  const $ = (id) => document.getElementById(id);

  function status(msg, color) {
    const f = $('ks-foot');
    if (f) f.innerHTML = '<span style="color:' + (color || '#5a5a63') + '">' + esc(msg) + '</span>';
  }

  /* The subtitle is where you check that the sniper is pointed at the event you
     think it is, and that the prices under your thumb are seconds old. */
  let balanceCents = null;
  function setSub() {
    const el = $('ks-sub');
    if (!el) return;
    const bits = [eventTicker || 'no event ticker'];
    if (balanceCents != null) bits.push(money(balanceCents));
    bits.push(new Date().toLocaleTimeString());
    el.textContent = bits.join('  ·  ');
  }

  /* Kalshi's routes are not one shape: a series page carries the event in the
     hash, deep links put it in the path, and some pages pass it as a query
     param. An event ticker almost always carries a digit (a year or a date —
     KXHIGHNY-25AUG18), while the human slug beside it almost never does, so
     that is the tell worth leaning on. Whatever this resolves to is printed
     in the header, and settings has an override for the day it is wrong. */
  function tickerFromUrl() {
    const override = store.get('event', '');
    if (override) return override.toUpperCase();

    const hash = location.hash.replace(/^#/, '').split('?')[0];
    if (hash && /^[a-z0-9._-]+$/i.test(hash) && /\d/.test(hash)) return hash.toUpperCase();

    const q = new URLSearchParams(location.search);
    const qEvent = q.get('event') || q.get('event_ticker') || q.get('ticker');
    if (qEvent) return qEvent.toUpperCase();

    const segs = location.pathname.split('/').filter(Boolean).slice(1)
      .filter((s) => /^[a-z0-9._-]+$/i.test(s));
    if (!segs.length) return '';

    /* Last segment holding a digit wins. Failing that the route is the plain
       /markets/<series>/<slug> shape, where the first segment is the series
       ticker and the second is prose — so take the first, and let the series
       fallback in refresh() turn it into a market list. */
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/\d/.test(segs[i])) return segs[i].toUpperCase();
    }
    return segs[0].toUpperCase();
  }

  /* --------------------------------------------------------- the button --- */

  const fab = document.createElement('button');
  fab.id = 'ks-fab';
  fab.type = 'button';
  fab.textContent = 'SNIPE';

  /* The FAB is parked wherever it was last dropped: bottom-right covers
     Kalshi's own trade ticket on an iPad, and that is exactly where you need
     to see through it. */
  const parked = store.get('fab', '');
  if (parked) {
    try {
      const p = JSON.parse(parked);
      fab.style.left = p.x + 'px';
      fab.style.top = p.y + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    } catch (e) {}
  }

  let drag = null;
  fab.addEventListener('pointerdown', (e) => {
    const r = fab.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = e.clientX - drag.dx, y = e.clientY - drag.dy;
    if (!drag.moved && Math.abs(x - fab.offsetLeft) + Math.abs(y - fab.offsetTop) < 6) return;
    drag.moved = true;
    const maxX = window.innerWidth - fab.offsetWidth;
    const maxY = window.innerHeight - fab.offsetHeight;
    fab.style.left = Math.max(0, Math.min(maxX, x)) + 'px';
    fab.style.top = Math.max(0, Math.min(maxY, y)) + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  });
  fab.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.moved) store.set('fab', JSON.stringify({ x: fab.offsetLeft, y: fab.offsetTop }));
    else toggle();
    drag = null;
  });

  document.body.appendChild(fab);

  function toggle() { panel ? close() : open(); }

  /* ------------------------------------------------------------ overlay --- */

  function open() {
    styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    panel = document.createElement('div');
    panel.id = 'ks-wrap';
    panel.innerHTML = '<div id="ks-panel"></div>';
    panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
    document.body.appendChild(panel);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    fab.classList.add('on');

    eventTicker = tickerFromUrl();
    if (cfg.keyId && cfg.pem) ready(); else showSettings();
  }

  function close() {
    if (timer) { clearInterval(timer); timer = null; }
    document.removeEventListener('keydown', onKey, true);
    if (panel) panel.remove();
    if (styleEl) styleEl.remove();
    panel = styleEl = null;
    pending = null;
    Object.keys(badges).forEach((k) => delete badges[k]);
    books = {};
    document.body.style.overflow = '';
    fab.classList.remove('on');
  }

  /* ------------------------------------------------------------ keyboard -- */

  /* An iPad with a keyboard attached should never need the screen. 1–9 fire
     the visible rows, / searches, R refreshes, Esc backs out. */
  function onKey(e) {
    if (!panel) return;
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target.tagName || ''));

    if (e.key === 'Escape') {
      e.preventDefault();
      if (typing) { e.target.blur(); return; }
      close();
      return;
    }
    if (typing) return;

    if (e.key === '/') { e.preventDefault(); const s = $('ks-search'); if (s) s.focus(); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refresh(true); return; }
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const btn = panel.querySelectorAll('#ks-grid .ks-b')[parseInt(e.key, 10) - 1];
      if (btn) btn.click();
    }
  }

  /* ------------------------------------------------------------ settings -- */

  function showSettings() {
    const hasKey = !!cfg.pem;
    $('ks-panel').innerHTML =
      '<div id="ks-head"><div id="ks-row1">' +
        '<div class="ks-i"><div id="ks-title">Settings</div>' +
        '<div id="ks-sub">Kalshi API credentials and limits</div></div>' +
        '<button class="ks-icon" id="ks-close" title="Close">&#x2715;</button>' +
      '</div></div>' +
      '<div id="ks-body"><div id="ks-set">' +
        '<p>Keys come from Kalshi under Account → API Keys. They are held in this ' +
        'browser\'s local storage on this device only, and never leave it except ' +
        'as a signature.</p>' +

        '<label>API Key ID</label>' +
        '<input type="text" id="f-keyid" autocomplete="off" autocapitalize="off" ' +
          'spellcheck="false" placeholder="a952bcbe-ec3b-…" value="' + esc(cfg.keyId) + '">' +

        '<label>RSA Private Key (PEM)</label>' +
        '<textarea id="f-pem" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
          'placeholder="' + (hasKey ? 'A key is stored — leave blank to keep it' :
            '-----BEGIN PRIVATE KEY-----') + '"></textarea>' +
        (hasKey ? '<div class="ks-note">A key is already stored. Paste a new one only to replace it.</div>' : '') +

        '<label>Worker Proxy URL <span style="text-transform:none;letter-spacing:0">(optional)</span></label>' +
        '<input type="url" id="f-proxy" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
          'placeholder="https://kalshi-proxy.you.workers.dev" value="' + esc(cfg.proxy) + '">' +
        '<div class="ks-note">Leave empty to talk to Kalshi directly through the userscript ' +
          'engine. Set it if your engine has no cross-origin fetch, or if you would rather ' +
          'the signing traffic went through your own Worker.</div>' +

        '<label>API Host</label>' +
        '<input type="url" id="f-host" autocomplete="off" spellcheck="false" value="' + esc(cfg.host) + '">' +
        '<div class="ks-note">Production is ' + esc(HOST) + '. The older ' +
          esc(HOST_LEGACY) + ' still answers if you need it.</div>' +

        '<label>Event Ticker Override <span style="text-transform:none;letter-spacing:0">(optional)</span></label>' +
        '<input type="text" id="f-event" autocomplete="off" autocapitalize="characters" ' +
          'spellcheck="false" placeholder="read from the URL: ' + esc(tickerFromUrl() || '—') + '" ' +
          'value="' + esc(store.get('event', '')) + '">' +

        '<label>Price Refresh (seconds)</label>' +
        '<input type="number" id="f-poll" min="2" max="60" inputmode="numeric" value="' + cfg.poll + '">' +

        '<div class="ks-toggle"><input type="checkbox" id="f-confirm"' + (cfg.confirm ? ' checked' : '') +
          '><label for="f-confirm" style="margin:0;text-transform:none;letter-spacing:0;font-size:14px;color:inherit">' +
          'Require a second tap to fire</label></div>' +

        '<button class="ks-go" id="f-save">Connect</button>' +
        (hasKey ? '<button class="ks-flat" id="f-forget">Forget stored key</button>' : '') +
      '</div></div>' +
      '<div id="ks-foot"></div>';

    $('ks-close').addEventListener('click', close);

    const forget = $('f-forget');
    if (forget) forget.addEventListener('click', () => {
      ['keyid', 'pem'].forEach(store.del);
      cfg.keyId = cfg.pem = ''; cryptoKey = null;
      showSettings();
      status('Stored key erased', '#ff9f0a');
    });

    $('f-save').addEventListener('click', () => {
      const keyId = $('f-keyid').value.trim();
      const pem = $('f-pem').value.trim() || cfg.pem;
      if (!keyId || !pem) { status('Key ID and private key are both required', '#ff453a'); return; }

      cfg.proxy = $('f-proxy').value.trim().replace(/\/+$/, '');
      cfg.host = $('f-host').value.trim().replace(/\/+$/, '') || HOST;
      cfg.poll = Math.max(2, Math.min(60, parseInt($('f-poll').value, 10) || 5));
      cfg.confirm = $('f-confirm').checked;
      const ev = $('f-event').value.trim().toUpperCase();

      store.set('proxy', cfg.proxy);
      store.set('host', cfg.host);
      store.set('poll', String(cfg.poll));
      store.set('confirm', cfg.confirm ? '1' : '0');
      if (ev) store.set('event', ev); else store.del('event');

      status('Reading key…');
      importPEM(pem)
        .then((k) => {
          cryptoKey = k;
          cfg.keyId = keyId; cfg.pem = pem;
          store.set('keyid', keyId); store.set('pem', pem);
          status('Key loaded. Checking balance…');
          return apiRequest('GET', '/portfolio/balance');
        })
        .then((d) => {
          const bal = balanceFrom(d);
          status('Connected' + (bal != null ? ' — ' + money(bal) + ' available' : ''), '#30d158');
          eventTicker = tickerFromUrl();
          setTimeout(ready, 700);
        })
        .catch((e) => {
          const hint = !cfg.proxy && /Network error/.test(e.message)
            ? ' — your userscript engine may not allow cross-origin requests; set a Worker proxy'
            : '';
          status(e.message + hint, '#ff453a');
        });
    });
  }

  /* -------------------------------------------------------------- board --- */

  function ready() {
    const keyReady = cryptoKey
      ? Promise.resolve()
      : importPEM(cfg.pem).then((k) => { cryptoKey = k; });

    showBoard();
    keyReady
      .then(() => {
        /* Buying power is worth a glance before the first tap, but it must
           never hold the board up — the markets load either way. */
        apiRequest('GET', '/portfolio/balance')
          .then((d) => { balanceCents = balanceFrom(d); setSub(); })
          .catch(() => {});
        return refresh(true);
      })
      .catch((e) => status(e.message + ' — open settings to re-enter it', '#ff453a'));
  }

  function showBoard() {
    const qtyChips = [25, 50, 100, 250, 500];
    $('ks-panel').innerHTML =
      '<div id="ks-head">' +
        '<div id="ks-row1">' +
          '<div class="ks-i"><div id="ks-title">' + esc(eventTitle || eventTicker || 'Markets') + '</div>' +
          '<div id="ks-sub">Loading…</div></div>' +
          '<button class="ks-icon" id="ks-refresh" title="Refresh (R)">&#x21bb;</button>' +
          '<button class="ks-icon" id="ks-gear" title="Settings">&#x2699;</button>' +
          '<button class="ks-icon" id="ks-close" title="Close (Esc)">&#x2715;</button>' +
        '</div>' +
        '<div id="ks-row2">' +
          '<div class="ks-field"><label for="ks-qty">Size</label>' +
            '<input id="ks-qty" type="number" min="1" inputmode="numeric" value="' + cfg.qty + '"></div>' +
          '<div class="ks-chips">' +
            qtyChips.map((q) => '<button class="ks-chip' + (q === cfg.qty ? ' on' : '') +
              '" data-qty="' + q + '">' + q + '</button>').join('') +
          '</div>' +
          '<div class="ks-field"><label for="ks-cap">Max ¢</label>' +
            '<input id="ks-cap" type="number" min="1" max="99" inputmode="numeric" ' +
            'placeholder="any" value="' + esc(cfg.cap) + '"></div>' +
          '<input id="ks-search" type="search" placeholder="Filter markets  ( / )" ' +
            'autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(filter) + '">' +
        '</div>' +
      '</div>' +
      '<div id="ks-body"><div id="ks-grid"></div><div id="ks-empty">Fetching markets…</div></div>' +
      '<div id="ks-foot"></div>';

    $('ks-close').addEventListener('click', close);
    $('ks-gear').addEventListener('click', showSettings);
    $('ks-refresh').addEventListener('click', () => refresh(true));

    const qty = $('ks-qty');
    qty.addEventListener('input', () => {
      cfg.qty = Math.max(1, parseInt(qty.value, 10) || 1);
      store.set('qty', String(cfg.qty));
      syncChips();
      render();
    });
    panel.querySelectorAll('.ks-chip').forEach((c) => {
      c.addEventListener('click', () => {
        cfg.qty = parseInt(c.dataset.qty, 10);
        store.set('qty', String(cfg.qty));
        qty.value = cfg.qty;
        syncChips();
        render();
      });
    });

    const cap = $('ks-cap');
    cap.addEventListener('input', () => {
      cfg.cap = cap.value.trim();
      store.set('cap', cfg.cap);
      render();
    });

    const search = $('ks-search');
    search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); render(); });

    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden && panel && $('ks-grid')) refresh(false);
    }, cfg.poll * 1000);
  }

  function syncChips() {
    panel.querySelectorAll('.ks-chip').forEach((c) =>
      c.classList.toggle('on', parseInt(c.dataset.qty, 10) === cfg.qty));
  }

  const capCents = () => {
    const n = parseInt(cfg.cap, 10);
    return Number.isFinite(n) && n > 0 && n < 100 ? n : null;
  };

  const isOpen = (m) => {
    const s = (m.status || '').toLowerCase();
    return !s || s === 'open' || s === 'active';
  };

  /* One request paints the whole board. Market objects carry yes_ask_dollars
     and volume_fp, so the per-market orderbook calls that version 8 fired on
     every load — one per row, on a phone connection — are only needed at the
     moment of a buy, where depth actually matters. */
  function refresh(loud) {
    if (!eventTicker) {
      status('No event ticker in this URL — set one in settings', '#ff9f0a');
      return Promise.resolve();
    }
    if (loud) status('Loading markets…');

    const byEvent = () =>
      apiRequest('GET', '/markets?event_ticker=' + encodeURIComponent(eventTicker) + '&limit=200')
        .then((d) => d.markets || [], () => []);

    const bySeries = () =>
      apiRequest('GET', '/markets?series_ticker=' + encodeURIComponent(eventTicker) + '&status=open&limit=200')
        .then((d) => d.markets || [], () => []);

    /* Three ways in, tried in order of how specific they are. A URL that named
       an event resolves on the first; a series landing page, which has no
       event ticker in it at all, falls through to the third. Only a genuine
       failure — auth, network — escapes to the handler at the bottom. */
    return apiRequest('GET', '/events/' + encodeURIComponent(eventTicker) + '?with_nested_markets=true')
      .then(
        (d) => {
          const ev = d.event || {};
          if (ev.title) eventTitle = ev.title;
          return ev.markets || [];
        },
        (e) => {
          if (e.status !== 404 && e.status !== 400) throw e;
          return [];
        })
      .then((list) => (list.length ? list : byEvent()))
      .then((list) => (list.length ? list : bySeries()))
      .then((list) => {
        markets = list.filter(isOpen);
        const t = $('ks-title'); if (t) t.textContent = eventTitle || eventTicker;
        setSub();
        render();
        if (loud) {
          status(markets.length
            ? markets.length + ' open market' + (markets.length === 1 ? '' : 's') +
              ' — tap YES to sweep' + (capCents() ? ' up to ' + capCents() + '¢' : '')
            : 'No open markets in ' + eventTicker, markets.length ? '#5a5a63' : '#ff9f0a');
        }
      })
      .catch((e) => { if (loud) status(e.message, '#ff453a'); });
  }

  /* A book fetched at the moment of a buy is fresher than the polled market
     object for a few seconds, and staler than it forever after — so it is
     only allowed to speak for as long as one poll interval. Without the
     expiry, the first buy on a row freezes that row's price for good. */
  const freshBook = (ticker) => {
    const b = books[ticker];
    return b && Date.now() - b.at < cfg.poll * 1000 ? b : null;
  };

  function askOf(m) {
    /* Integer-cent fields are gone; _dollars is the only price on a current
       market object. */
    const b = freshBook(m.ticker);
    if (b && b.best != null) return b.best;
    return centsOf(m.yes_ask_dollars != null ? m.yes_ask_dollars : m.yes_ask / 100);
  }

  function render() {
    const grid = $('ks-grid'), empty = $('ks-empty');
    if (!grid) return;

    const shown = markets.filter((m) => {
      if (!filter) return true;
      return (label(m) + ' ' + m.ticker).toLowerCase().includes(filter);
    });

    grid.innerHTML = '';
    if (!shown.length) {
      empty.style.display = '';
      empty.textContent = markets.length ? 'Nothing matches “' + filter + '”' : 'No open markets';
      return;
    }
    empty.style.display = 'none';

    const cap = capCents();
    shown.forEach((m, i) => {
      const ask = askOf(m);
      const book = freshBook(m.ticker);
      const badge = badges[m.ticker];
      const blocked = cap != null && ask != null && ask > cap;

      const bits = [];
      if (book) bits.push(Math.floor(book.depth).toLocaleString() + ' offered');
      else if (m.volume_fp != null || m.volume != null)
        bits.push(Math.round(countOf(m.volume_fp != null ? m.volume_fp : m.volume)).toLocaleString() + ' vol');
      if (ask != null) bits.push('~' + money(ask * cfg.qty) + ' for ' + cfg.qty);
      if (blocked) bits.push('over your ' + cap + '¢ cap');

      const card = document.createElement('div');
      card.className = 'ksc' + (!blocked && ask != null && cap != null ? ' hot' : '');
      card.innerHTML =
        '<div class="ks-i">' +
          '<div class="ks-n">' + esc(label(m)) + '</div>' +
          '<div class="ks-p">' +
            '<span class="ks-ask' + (ask == null ? ' none' : '') + '">' + priceLabel(ask) + '</span>' +
            '<span class="ks-meta">' + esc(bits.join(' · ')) + '</span>' +
          '</div>' +
        '</div>' +
        (i < 9 ? '<span class="ks-key">' + (i + 1) + '</span>' : '') +
        '<button class="ks-b' + (badge ? ' ' + badge.cls : '') + '" type="button">' +
          (badge ? badge.html : 'YES<small>' + cfg.qty + '</small>') + '</button>';

      card.querySelector('.ks-b').addEventListener('click', () => fire(m));
      grid.appendChild(card);
    });
  }

  const label = (m) => m.yes_sub_title || m.subtitle || m.title || m.ticker;

  /* --------------------------------------------------------------- fire --- */

  /* A badge outlives the re-render that follows it: set it, repaint, and let
     it expire on its own clock. The guard on expiry stops a stale timer from
     clearing a newer badge that replaced it. */
  function setBadge(ticker, cls, html, ms) {
    const b = { cls, html };
    badges[ticker] = b;
    render();
    if (ms) setTimeout(() => {
      if (badges[ticker] === b) { delete badges[ticker]; render(); }
    }, ms);
  }

  function fire(m) {
    const live = badges[m.ticker];
    if (live && live.cls === 'busy') return;

    if (cfg.confirm && pending !== m.ticker) {
      pending = m.ticker;
      setBadge(m.ticker, 'confirm', 'SURE?<small>tap again</small>', 2500);
      setTimeout(() => { if (pending === m.ticker) pending = null; }, 2500);
      return;
    }
    pending = null;

    const want = cfg.qty, cap = capCents();
    setBadge(m.ticker, 'busy', '&hellip;');

    /* The board's price is a snapshot; the book is read fresh at the instant
       of the buy so the limit we send reflects what is actually resting. */
    getBook(m.ticker)
      .then((book) => {
        books[m.ticker] = book;
        const p = plan(book.asks, want, cap);

        if (!p.count) {
          const overCap = book.asks.length > 0;
          setBadge(m.ticker, 'dead',
            overCap ? 'ABOVE<small>your cap</small>' : 'NO BID<small>empty</small>', 2200);
          status(overCap
            ? 'Cheapest YES on ' + label(m) + ' is ' + priceLabel(book.best) +
              ', over your ' + cap + '¢ cap'
            : 'Nothing offered on ' + label(m), '#ff9f0a');
          return;
        }

        return buyYes(m.ticker, p.count, p.limit).then((resp) => {
          const filled = filledFrom(resp);
          setBadge(m.ticker, filled > 0 ? 'ok' : 'err',
            filled > 0 ? '&#x2713;<small>' + filled + '</small>' : '0<small>no fill</small>', 3000);
          status(filled > 0
            ? 'Bought ' + filled + ' YES on ' + label(m) + ' at up to ' + priceLabel(p.limit) +
              ' — about ' + money(p.cost)
            : 'Nothing filled on ' + label(m) + ' at ' + priceLabel(p.limit) + ' (the book moved)',
            filled > 0 ? '#30d158' : '#ff9f0a');
          refresh(false);
          if (filled > 0) {
            apiRequest('GET', '/portfolio/balance')
              .then((d) => { balanceCents = balanceFrom(d); setSub(); })
              .catch(() => {});
          }
        });
      })
      .catch((e) => {
        setBadge(m.ticker, 'err', 'ERR', 3000);
        status(e.message, '#ff453a');
      });
  }
})();
