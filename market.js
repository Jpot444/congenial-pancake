/*
 * Something to read while the box is buffering.
 *
 * "During the buffering screens where it says 'buffering ahead' I want that
 *  replaced with a prediction market specific joke or a real fact from my
 *  prediction market firm."
 *
 * A prebuffer is fifteen to sixty seconds of a progress bar and a sentence
 * explaining a technical decision the viewer did not make. The bar earns its
 * place — it says the wait is finite and how finite — but the sentence had one
 * reader, once, and it is the same sentence every time. So the sentence is now
 * the interesting part of the screen and the mechanics moved into the small
 * print beside the numbers, where they are still true and no longer the
 * headline.
 *
 * TWO KINDS OF LINE, and the difference matters:
 *
 *   jokes — written here, shipped in the repo, true of prediction markets in
 *   general. They need nothing, never fail and are what the screen falls back
 *   to when everything else does.
 *
 *   facts — real numbers out of the firm's own book, refreshed once a day.
 *   They need a source, and a source can be missing, refuse, or change shape
 *   underneath us. Every one of those has to end with the screen showing a
 *   joke rather than an error: a buffering screen is the worst possible place
 *   to report that a portfolio API returned 403.
 *
 * WHO SEES WHAT. The house has profiles and one of them is the owner's. The
 * facts are the same facts for everybody — "the best call this week was X, up
 * 34%" is a story anyone can enjoy — but the dollar figures are the owner's
 * alone. So every fact is written twice, once with money in it and once as a
 * percentage, and the choice between them is made HERE, on the box, against
 * the profile that asked. A browser is never sent a number it is not allowed
 * to show and then trusted to hide it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'market-facts.json';

/** Nothing is refreshed more often than this, however often it is asked for. */
const REFRESH_MS = 6 * 60 * 60 * 1000;
/** How long a fetched snapshot is worth showing before it is called stale. */
const STALE_MS = 36 * 60 * 60 * 1000;

const store = {
  dir: __dirname,
  log: () => {},
  fetchJson: null,
  /** Reads the box config, which is where a key would be. */
  config: () => null,
  /** { at, day, source, error, firm } */
  snap: null,
  /** Lines typed in by hand, which work with no key and no venue at all. */
  typed: [],
  running: null,
  lastTry: 0,
};

/* ------------------------------------------------------------- the jokes ── */

/*
 * Written rather than generated, because the joke is the product here and a
 * template with a noun slot in it reads like one. Kept true: every one of
 * these is a real thing about prediction markets, said sideways.
 *
 * The ids are stable and never reused — the rotation on each device remembers
 * what it has shown by id, so renaming one is showing it again to everybody.
 */
const JOKES = [
  ['j-odds', 'The market says this finishes. The market has been wrong before.'],
  ['j-oneineight', 'A 12% chance comes in about one time in eight. This is that one time.'],
  ['j-wording', 'In prediction markets, "it depends on the wording" is the whole game.'],
  ['j-longshot', 'Longshot bias: everyone overpays for 3% and underpays for 97%. Including here.'],
  ['j-twosides', 'Every market has two sides. This one is buffering and not buffering.'],
  ['j-resolution', 'Somewhere a resolution source is being argued about. Not this one.'],
  ['j-spread', 'The spread on this progress bar is wide and the volume is thin.'],
  ['j-early', 'You are not early. You are just waiting.'],
  ['j-noshares', 'Nobody ever brags about the NO shares. They pay the same.'],
  ['j-kalshi', 'The box you are watching this on is named after an exchange. It is doing its best.'],
  ['j-consensus', 'The consensus was 97%. The consensus is a crowd, and crowds queue.'],
  ['j-priceit', 'If you can define it, you can price it. Defining it is the hard part.'],
  ['j-settle', 'Being right early and being right are settled at different prices.'],
  ['j-liquidity', 'A market with one buyer is a conversation, not a price.'],
  ['j-hedge', 'This is hedged. Something else in the house is also buffering.'],
  ['j-tails', 'The tails are where the money is and where the arguing is.'],
  ['j-modelled', 'Every model is wrong. Some of them are wrong slowly enough to trade.'],
  ['j-vig', 'No vig on this wait. It is free and it is nearly over.'],
  ['j-limit', 'A limit order is patience with a number attached.'],
  ['j-marketmaker', 'Somebody is making a market in how long this takes.'],
  ['j-basis', 'The basis between "loading" and "loaded" is closing.'],
  ['j-informed', 'The informed money moved before the news. The news is that this is buffering.'],
  ['j-brier', 'Confidence is cheap. Calibration is the expensive kind.'],
  ['j-fade', 'Fading the crowd works right up until it does not.'],
  ['j-carry', 'Holding a position overnight is just buffering with money in it.'],
  ['j-ambiguous', 'The most dangerous words on a contract are "or equivalent".'],
  ['j-priors', 'Update on the evidence. The evidence is a progress bar.'],
  ['j-thin', 'Thin book, wide spread, strong opinions. As usual.'],
  ['j-exit', 'Everyone has an exit plan until the market gaps.'],
  ['j-mispriced', 'If it looks mispriced and you cannot say why, you are the reason.'],
  ['j-tape', 'Reading the tape is mostly reading the same number again.'],
  ['j-arb', 'There is no arbitrage here. There is only the buffer.'],
  ['j-conviction', 'Conviction is a position you have not had to defend yet.'],
  ['j-tailrisk', 'The risk you hedged is not the one that shows up.'],
  ['j-marktomarket', 'Marked to market. The mark is the bar below.'],
  ['j-sizing', 'Being right is a third of it. Sizing it is the rest.'],
  ['j-slippage', 'This is slippage. It is the only kind that costs nothing.'],
  ['j-resolve', 'Everything resolves eventually. Including this.'],
  ['j-blowout', 'Landslides look obvious afterwards and never beforehand.'],
  ['j-var', 'Value at risk on this wait: about forty seconds.'],
];

/* ---------------------------------------------------------- what is known ── */

/**
 * A fact, in the two forms it might be shown in.
 *
 * `money` is the owner's copy and may name dollars. `pct` is everybody's, and
 * must not — it is the one that goes out to a profile that is not the owner's,
 * so a fact with nothing sensible to say without a dollar figure has no `pct`
 * and is simply not sent to anyone else.
 */
const fact = (id, money, pct) => ({ id, kind: 'fact', money, pct: pct || null });

const money = (n) => {
  const abs = Math.abs(Math.round(n));
  return `$${abs.toLocaleString('en-US')}`;
};
/* A magnitude, never a signed number: the direction is carried by the words
   around it, and "down -1.8%" is two negatives saying one thing. */
const pct = (n) => {
  const size = Math.abs(n);
  return `${size >= 10 ? Math.round(size) : Math.round(size * 10) / 10}%`;
};
const upDown = (n) => (n >= 0 ? 'up' : 'down');

/**
 * The lines a snapshot is worth.
 *
 * Everything here is optional. A source that answers half of this produces
 * half of these and no error — the alternative is a screen that says nothing
 * because one field was missing.
 */
function factsFrom(firm) {
  if (!firm || typeof firm !== 'object') return [];
  const out = [];
  const name = String(firm.name || 'Treasure State');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  const window = (key, label) => {
    const p = num(firm[`${key}Pct`]);
    const d = num(firm[`${key}Pnl`]);
    if (p === null && d === null) return;
    const dir = upDown(p === null ? d : p);
    if (p !== null && d !== null) {
      out.push(fact(`f-${key}`,
        `${name} is ${dir} ${money(d)} ${label}. That is ${pct(p)} on what was staked.`,
        `${name} is ${dir} ${pct(p)} ${label}.`));
    } else if (p !== null) {
      out.push(fact(`f-${key}`, `${name} is ${dir} ${pct(p)} ${label}.`,
        `${name} is ${dir} ${pct(p)} ${label}.`));
    } else {
      // Dollars and nothing else: the owner's line only, since the percentage
      // form would be a percentage of nothing.
      out.push(fact(`f-${key}`, `${name} is ${dir} ${money(d)} ${label}.`, null));
    }
  };

  window('day', 'today');
  window('week', 'this week');
  window('month', 'this month');
  window('year', 'this year');

  const best = firm.best;
  if (best && best.title) {
    const p = num(best.pct);
    const d = num(best.pnl);
    if (p !== null) {
      out.push(fact('f-best',
        d === null ? `The best call this week: ${best.title}, up ${pct(p)}.`
          : `The best call this week: ${best.title}, up ${pct(p)} and ${money(d)}.`,
        `The best call this week: ${best.title}, up ${pct(p)}.`));
    }
  }

  const worst = firm.worst;
  if (worst && worst.title && num(worst.pct) !== null) {
    out.push(fact('f-worst',
      `Not every one lands. ${worst.title} went the other way, ${pct(num(worst.pct))} of it.`,
      `Not every one lands. ${worst.title} went the other way, ${pct(num(worst.pct))} of it.`));
  }

  const win = firm.settled;
  if (win && num(win.won) !== null && num(win.total) > 0) {
    const rate = (num(win.won) / num(win.total)) * 100;
    out.push(fact('f-winrate',
      `${win.won} of ${win.total} contracts settled in the money this month — ${pct(rate)}.`,
      `${win.won} of ${win.total} contracts settled in the money this month — ${pct(rate)}.`));
  }

  const open = num(firm.openPositions);
  if (open !== null && open > 0) {
    out.push(fact('f-open',
      `${open} position${open === 1 ? '' : 's'} open on the book right now.`,
      `${open} position${open === 1 ? '' : 's'} open on the book right now.`));
  }

  if (firm.biggest && firm.biggest.title) {
    const share = num(firm.biggest.share);
    out.push(fact('f-biggest',
      share === null ? `The biggest position on the book: ${firm.biggest.title}.`
        : `The biggest position on the book: ${firm.biggest.title}, ${pct(share)} of it.`,
      share === null ? `The biggest position on the book: ${firm.biggest.title}.`
        : `The biggest position on the book: ${firm.biggest.title}, ${pct(share)} of it.`));
  }

  const streak = num(firm.streak);
  if (streak !== null && Math.abs(streak) >= 3) {
    out.push(fact('f-streak', streak > 0
      ? `${streak} settled in a row in the money. It does not last.`
      : `${Math.abs(streak)} settled against in a row. It does not last either.`,
    streak > 0
      ? `${streak} settled in a row in the money. It does not last.`
      : `${Math.abs(streak)} settled against in a row. It does not last either.`));
  }

  const traded = num(firm.contractsWeek);
  if (traded !== null && traded > 0) {
    out.push(fact('f-volume',
      `${traded.toLocaleString('en-US')} contracts traded this week.`,
      `${traded.toLocaleString('en-US')} contracts traded this week.`));
  }

  const busiest = firm.busiest;
  if (busiest && busiest.title) {
    out.push(fact('f-busiest',
      `Most-traded market this week: ${busiest.title}.`,
      `Most-traded market this week: ${busiest.title}.`));
  }

  return out;
}

/* --------------------------------------------------------------- storage ── */

const filePath = () => path.join(store.dir, FILE);

function load() {
  try {
    const held = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    store.snap = held.snap && typeof held.snap === 'object' ? held.snap : null;
    store.typed = Array.isArray(held.typed) ? held.typed.slice(0, 60) : [];
  } catch {
    store.snap = null;
    store.typed = [];
  }
}

function save() {
  try {
    fs.writeFileSync(filePath(), JSON.stringify({ snap: store.snap, typed: store.typed }, null, 2),
      { mode: 0o600 });
    fs.chmodSync(filePath(), 0o600);
  } catch (err) {
    store.log(`market: could not save facts — ${err.message}`);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------- the venue ── */

/**
 * Kalshi, signed the way Kalshi asks for.
 *
 * A read-only API key is an id and an RSA private key; every request carries
 * the id, a millisecond timestamp and an RSA-PSS signature over
 * `timestamp + METHOD + path`, path being the part after the host and before
 * the query string. Nothing here writes: two GETs against the portfolio and a
 * handful of public market lookups to turn tickers into titles.
 *
 * No query strings, deliberately. Whether the signature covers them is the one
 * detail of this scheme different clients disagree about, and a page of
 * settlements is plenty for a week's story — so the question is not asked.
 *
 * Written against the documented v2 shape and NOT yet run against a live key —
 * so every field is read defensively and any failure at all ends as "no facts
 * today", which the screen already knows how to handle.
 */
const KALSHI_BASE = 'https://api.elections.kalshi.com';
const KALSHI_PREFIX = '/trade-api/v2';

function kalshiHeaders(keyId, privateKey, method, routePath) {
  const stamp = String(Date.now());
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${stamp}${method}${routePath}`);
  signer.end();
  const signature = signer.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, 'base64');
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': stamp,
    accept: 'application/json',
  };
}

async function kalshiGet(key, route) {
  const routePath = `${KALSHI_PREFIX}${route}`;
  const headers = kalshiHeaders(key.keyId, key.privateKey, 'GET', routePath);
  return store.fetchJson(`${KALSHI_BASE}${routePath}`, headers);
}

/** Public, unsigned: a ticker is not a sentence and a title is. */
async function kalshiTitle(ticker) {
  try {
    const body = await store.fetchJson(
      `${KALSHI_BASE}${KALSHI_PREFIX}/markets/${encodeURIComponent(ticker)}`,
      { accept: 'application/json' }
    );
    const m = body.market || {};
    const title = String(m.title || '').trim();
    const sub = String(m.yes_sub_title || m.subtitle || '').trim();
    if (!title) return '';
    return sub && !title.includes(sub) ? `${title} — ${sub}` : title;
  } catch {
    return '';
  }
}

const cents = (v) => (Number.isFinite(Number(v)) ? Number(v) / 100 : 0);

/**
 * The book, as far as settled positions can describe it.
 *
 * Realised profit is the honest number to build a percentage on: revenue less
 * what the contracts cost, over what they cost. Open positions are counted but
 * not marked — an unrealised number that moves all day would make "up 12% this
 * week" mean something different every time it was read.
 */
async function readKalshi(key) {
  const firm = { name: 'Treasure State' };

  const settlements = await kalshiGet(key, '/portfolio/settlements');
  const rows = Array.isArray(settlements.settlements) ? settlements.settlements : [];

  const at = (row) => {
    const t = Date.parse(row.settled_time || row.settledTime || '');
    return Number.isFinite(t) ? t : 0;
  };
  const cost = (row) => cents(row.yes_total_cost) + cents(row.no_total_cost)
    + cents(row.total_cost);
  const gain = (row) => cents(row.revenue) - cost(row);

  const now = Date.now();
  const windows = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };
  for (const [name, span] of Object.entries(windows)) {
    const inside = rows.filter((r) => at(r) && now - at(r) <= span);
    if (!inside.length) continue;
    const staked = inside.reduce((sum, r) => sum + cost(r), 0);
    const made = inside.reduce((sum, r) => sum + gain(r), 0);
    firm[`${name}Pnl`] = Math.round(made);
    if (staked > 0) firm[`${name}Pct`] = (made / staked) * 100;
  }

  const week = rows.filter((r) => at(r) && now - at(r) <= windows.week);
  const month = rows.filter((r) => at(r) && now - at(r) <= windows.month);

  if (month.length) {
    firm.settled = { won: month.filter((r) => gain(r) > 0).length, total: month.length };
  }
  if (week.length) {
    firm.contractsWeek = week.reduce(
      (sum, r) => sum + (Number(r.yes_count) || 0) + (Number(r.no_count) || 0), 0
    );
    const scored = week
      .filter((r) => cost(r) > 0)
      .map((r) => ({ ticker: r.ticker, pct: (gain(r) / cost(r)) * 100, pnl: gain(r) }))
      .sort((a, b) => b.pct - a.pct);
    if (scored.length) {
      const top = scored[0];
      const title = await kalshiTitle(top.ticker);
      if (title) firm.best = { title, pct: top.pct, pnl: Math.round(top.pnl) };
      const tail = scored[scored.length - 1];
      if (tail !== top && tail.pct < 0) {
        const other = await kalshiTitle(tail.ticker);
        if (other) firm.worst = { title: other, pct: tail.pct };
      }
    }
  }

  /* The streak, newest first: how many in a row came in one way. */
  const ordered = rows.filter((r) => at(r)).sort((a, b) => at(b) - at(a));
  if (ordered.length) {
    const winning = gain(ordered[0]) > 0;
    let run = 0;
    for (const row of ordered) {
      if (gain(row) > 0 !== winning) break;
      run += 1;
    }
    firm.streak = winning ? run : -run;
  }

  try {
    const held = await kalshiGet(key, '/portfolio/positions');
    const positions = (Array.isArray(held.market_positions) ? held.market_positions : [])
      .filter((p) => Number(p.position) !== 0);
    if (positions.length) {
      firm.openPositions = positions.length;
      const exposure = positions.reduce((sum, p) => sum + Math.abs(cents(p.market_exposure)), 0);
      const biggest = positions
        .slice()
        .sort((a, b) => Math.abs(cents(b.market_exposure)) - Math.abs(cents(a.market_exposure)))[0];
      const title = await kalshiTitle(biggest.ticker);
      if (title) {
        firm.biggest = {
          title,
          share: exposure > 0
            ? (Math.abs(cents(biggest.market_exposure)) / exposure) * 100 : null,
        };
      }
    }
  } catch (err) {
    // Positions are a bonus; the settled history is the story.
    store.log(`market: positions unavailable — ${err.message}`);
  }

  return firm;
}

/* ------------------------------------------------------------- refreshing ── */

/** The key, or null. Read fresh each time so pasting one takes effect at once. */
function sourceOf() {
  const cfg = store.config() || {};
  const m = cfg.market || {};
  const source = String(m.source || '').trim().toLowerCase();
  if (source === 'kalshi') {
    const keyId = String(m.keyId || '').trim();
    const privateKey = String(m.privateKey || '').trim();
    if (!keyId || !privateKey) return { source: 'kalshi', ready: false };
    return { source: 'kalshi', ready: true, key: { keyId, privateKey } };
  }
  return { source: source || 'none', ready: false };
}

/**
 * Once a day, at most, and never twice at once.
 *
 * Called at boot, on a slow timer, and lazily by the endpoint — all three of
 * which can land together on a box that has just come up, which is what the
 * `running` promise is for.
 */
async function refresh({ force = false } = {}) {
  const where = sourceOf();
  if (!where.ready) {
    if (store.snap && store.snap.source && store.snap.source !== where.source) {
      // The venue was changed or the key removed; last night's numbers are no
      // longer this box's numbers.
      store.snap = null;
      save();
    }
    return { ok: false, reason: 'no source' };
  }
  if (store.running) return store.running;
  if (!force && store.snap && store.snap.day === today()) return { ok: true, reason: 'today' };
  if (!force && Date.now() - store.lastTry < 10 * 60 * 1000) return { ok: false, reason: 'waiting' };

  store.lastTry = Date.now();
  store.running = (async () => {
    try {
      const firm = await readKalshi(where.key);
      store.snap = { at: Date.now(), day: today(), source: 'kalshi', error: '', firm };
      save();
      store.log(`market: ${factsFrom(firm).length} facts from kalshi`);
      return { ok: true };
    } catch (err) {
      /* Kept, not cleared: yesterday's true numbers beat no numbers, up to the
         staleness limit, and the error is recorded for the settings screen
         rather than shown to anybody mid-buffer. */
      const message = String(err.message || err).slice(0, 300);
      if (store.snap) store.snap.error = message;
      else store.snap = { at: 0, day: '', source: 'kalshi', error: message, firm: null };
      save();
      store.log(`market: refresh failed — ${message}`);
      return { ok: false, reason: message };
    } finally {
      store.running = null;
    }
  })();
  return store.running;
}

/* ----------------------------------------------------------------- lines ── */

/**
 * Everything this profile may be shown, jokes and facts together.
 *
 * The redaction is here and only here. `owner` decides which of a fact's two
 * forms is written into the answer; the other one never leaves the box.
 */
function lines({ owner = false } = {}) {
  const out = JOKES.map(([id, text]) => ({ id, kind: 'joke', text }));

  const fresh = store.snap && store.snap.firm
    && store.snap.at && Date.now() - store.snap.at < STALE_MS;
  if (fresh) {
    for (const f of factsFrom(store.snap.firm)) {
      const text = owner ? (f.money || f.pct) : f.pct;
      if (text) out.push({ id: f.id, kind: 'fact', text });
    }
  }

  store.typed.forEach((line, i) => {
    const text = String(line && line.text ? line.text : line || '').trim();
    if (!text) return;
    const ownerOnly = Boolean(line && line.ownerOnly);
    if (ownerOnly && !owner) return;
    out.push({ id: `t-${i}-${hash(text)}`, kind: 'fact', text: text.slice(0, 220) });
  });

  return out;
}

/** Stable enough to key a rotation on, short enough to travel. */
function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

/** For the settings screen: what the source is doing, never the key itself. */
function status() {
  const where = sourceOf();
  const snap = store.snap || {};
  return {
    source: where.source,
    set: Boolean(where.ready),
    day: snap.day || '',
    at: snap.at || 0,
    error: snap.error || '',
    facts: snap.firm ? factsFrom(snap.firm).length : 0,
    jokes: JOKES.length,
    typed: store.typed.length,
    stale: Boolean(snap.at) && Date.now() - snap.at >= STALE_MS,
  };
}

/** Lines typed in by hand — the source that works with no venue and no key. */
function setTyped(list) {
  store.typed = (Array.isArray(list) ? list : [])
    .map((row) => (typeof row === 'string'
      ? { text: row.trim(), ownerOnly: /\$\s?\d/.test(row) }
      : { text: String(row?.text || '').trim(), ownerOnly: Boolean(row?.ownerOnly) }))
    .filter((row) => row.text)
    .slice(0, 60);
  save();
  return store.typed;
}

function typed() {
  return store.typed.slice();
}

function configure(opts = {}) {
  if (opts.dir) store.dir = opts.dir;
  if (opts.log) store.log = opts.log;
  if (opts.fetchJson) store.fetchJson = opts.fetchJson;
  if (opts.config) store.config = opts.config;
  load();
  /* Slowly, and never on the boot path: the library, the guide and whatever is
     being watched all come first, and a joke is available the whole time. */
  if (store.timer) clearInterval(store.timer);
  store.timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
  if (store.timer.unref) store.timer.unref();
}

module.exports = {
  configure, refresh, lines, status, setTyped, typed,
  // Exported for the suites, which check the shaping rather than the network.
  factsFrom, JOKES,
};
