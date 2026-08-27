'use strict';

/**
 * Listings from XMLTV feeds.
 *
 * The provider answers `get_short_epg` one channel at a time, and for a great
 * many channels it answers with nothing at all. That leaves the guide mostly
 * blank, and no amount of asking harder fixes it: the listings are not there.
 *
 * XMLTV is the way round it. It is the format every guide in this world is
 * published in, and there are three kinds of source worth having:
 *
 *   1. The provider's own `xmltv.php`. Same listings as `get_short_epg`, but
 *      the whole account in ONE request instead of one request per channel —
 *      and, in practice, populated for channels the per-channel call refuses.
 *   2. Open guides — epgshare01 and the like — which cover the channels the
 *      provider never bothered to fill in. These are the coverage win.
 *   3. Nothing else. If a channel is in neither, it has no listings, and the
 *      guide says so rather than pretending.
 *
 * The reason this is its own file: the scan has to be careful in a way the
 * rest of the box does not. A country-wide guide is a few hundred megabytes
 * of XML, the Pi has a 1G ceiling, and the naive version — download it, parse
 * it, then pick out the channels we own — dies on the first one. So it is
 * done the other way round. The set of channels we own is known BEFORE the
 * fetch starts, the document is scanned as it arrives, and a programme that
 * belongs to nobody is dropped without ever being kept. What lands on disk is
 * a few hundred kilobytes: our channels, a day and a half of listings, and
 * nothing else.
 *
 * Nothing here touches the provider's one connection except the provider's
 * own feed, which the caller gates. The open guides are ordinary web
 * downloads and can run while somebody is watching something.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');
const { StringDecoder } = require('string_decoder');

/* ------------------------------------------------------------------ limits */

/** How far back a programme may start and still be worth keeping. */
const WINDOW_BACK_MS = 3 * 60 * 60 * 1000;
/** And how far ahead. A day and a half covers "tonight" from any hour. */
const WINDOW_FWD_MS = 36 * 60 * 60 * 1000;
/** Per channel, in that window. Bounds the index no matter what arrives. */
const MAX_PER_CHANNEL = 64;
/**
 * How many of the guides' own channels to remember the names of.
 *
 * Not needed to build the index — needed to explain it. When a channel comes
 * back with no listings the only useful question is "what DID the guide call
 * it", and without this the box cannot answer, which leaves the viewer
 * ticking boxes at random. A national guide declares a few thousand channels,
 * so this holds all of them with room to spare.
 */
const MAX_OFFERED = 40000;
/**
 * Decompressed bytes one source may spend before we stop reading it.
 *
 * This is a limit on TIME, not on memory — the scan holds one chunk and the
 * handful of programmes it kept, so a feed twice this size would cost no more
 * RAM than a small one. It is set well above the biggest guide anybody
 * publishes because the failure it prevents is a feed that has gone wrong,
 * and stopping early on a feed that is merely large costs real listings:
 * whatever is past the cut is silently missing, and the channels at the end
 * of the alphabet are the ones that lose.
 */
const MAX_BYTES = 1536 * 1024 * 1024;
/** Guides are published a few times a day. Six hours is plenty. */
const REFRESH_MS = 6 * 60 * 60 * 1000;
/** A slow feed should not hold the refresh open forever. */
const FETCH_TIMEOUT_MS = 120000;

const UA = 'Mozilla/5.0 (compatible; TreasureTheater/1.0)';

/* ------------------------------------------------------------------- state */

const store = {
  dir: __dirname,
  log: () => {},
  sources: [],
  /** ourChannelId -> [{ title, start, stop }] */
  byChannel: new Map(),
  /** ourChannelId -> which tier of spelling made the match. */
  matchedBy: new Map(),
  /** Every channel the guides declared: flattened key -> what they called it. */
  offered: new Map(),
  /** ourChannelId -> the feed its listings came from, so a failed feed's
   *  channels can be carried forward instead of vanishing. */
  fromSource: new Map(),
  channels: [],
  at: 0,
  running: false,
  lastRun: null,
};

/* -------------------------------------------------------------- text tools */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function unescapeXml(raw) {
  return String(raw || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const hit = ENTITIES[name.toLowerCase()];
      return hit === undefined ? m : hit;
    })
    .trim();
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * The join key between a channel we have and a channel a guide publishes.
 *
 * Providers and guides name the same channel a dozen ways: "US: ESPN HD",
 * "ESPN", "ESPN.us", "ESPN ᴴᴰ". This flattens all of them to `espn`. It is
 * deliberately aggressive, because the alternative — matching only what is
 * spelled identically — matches almost nothing.
 */
function nameTokens(raw) {
  let s = String(raw || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  // "us: espn", "uk | sky one", "en - bbc"
  s = s.replace(/^[a-z]{2,3}\s*[:|—–-]\s*/, '');
  // The country suffix an XMLTV id carries: "espn.us"
  s = s.replace(/\.[a-z]{2}$/, '');
  // Quality and feed words, wherever they appear.
  s = s.replace(/\b(fhd|uhd|hd|sd|4k|8k|hevc|h265|h264|raw|backup|alt|feed|plus|channel|tv)\b/g, ' ');
  // Superscript markings — ᴴᴰ, ᴿᴬᵂ — are not letters, so they fall out with
  // the punctuation below; these are the ones that would otherwise survive.
  s = s.replace(/[ᴴᴰⁱ]/g, ' ');
  return s.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function chanKey(raw) {
  return nameTokens(raw).join('');
}

/**
 * The name with the network taken off the front.
 *
 * This provider files a channel under its network and then says it again:
 * CNBC is sold as "NBC CNBC ᴿᴬᵂ", MSNBC as "NBC MSNBC". Flattened that is
 * `nbccnbc`, and every guide in the world publishes `cnbc`, so the exact keys
 * can never meet however many feeds you tick.
 *
 * Dropping a leading word is obviously dangerous — "BBC ONE" must not become
 * "one" and start matching anything called One — so it happens in only two
 * cases. Either the network is spelled inside the channel that follows it
 * (`nbc` inside `cnbc`), which is as close to proof as this gets, or it is a
 * short abbreviation and what remains is long enough to be a station name
 * rather than an English word.
 */
function withoutNetwork(tokens) {
  if (!tokens || tokens.length < 2) return '';
  const [first, ...rest] = tokens;
  const tail = rest.join('');
  if (!tail) return '';
  // "NBC EAST" must not reduce to "east" and go looking for a channel called
  // East. What is left has to be a name, not a marking.
  if (rest.every((t) => FEED_WORD.test(t))) return '';
  if (tail.includes(first)) return tail;
  if (first.length >= 2 && first.length <= 4 && /^[a-z]+$/.test(first) && tail.length >= 4) {
    return tail;
  }
  return '';
}

/**
 * The same key with a regional feed marking taken off the end.
 *
 * Providers sell "NBC EAST" and "NBC WEST"; a national guide publishes one
 * "NBC". Neither side is wrong and the exact keys will never meet, so this is
 * the second thing tried — and only the second, because it is a genuine
 * compromise: an east-coast schedule shown against a west-coast feed is three
 * hours out. A loose match is recorded as loose, counted separately, and said
 * out loud on the screen.
 */
const FEED_TAIL = /(east|west|pacific|atlantic|mountain|central|national|network|usa|us)$/;
const FEED_WORD = /^(east|west|pacific|atlantic|mountain|central|national|network|usa|us)$/;

/**
 * The tokens worth matching on, with the noise taken out.
 *
 * Trimming the END of the joined key is the obvious version and it is not
 * enough: this provider sells Bravo as "NBC BRAVO (EAST) (D) ᴿᴬᵂ", where the
 * feed marking is in the MIDDLE and a stray "(D)" sits behind it. Working on
 * tokens instead removes both wherever they are.
 *
 * Single letters go; single DIGITS stay. "(D)" is a marking, but the 2 in
 * "MTV 2" is the whole difference between two channels, and dropping it would
 * quietly file MTV 2's listings under MTV.
 */
function coreTokens(tokens) {
  return tokens.filter((t) => !FEED_WORD.test(t) && !/^[a-z]$/.test(t));
}

function coreKey(key) {
  let s = String(key || '');
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(FEED_TAIL, '');
    if (next === s) break;
    s = next;
  }
  // Two letters is not a channel, it is a coincidence waiting to happen.
  return s.length >= 3 ? s : '';
}

/**
 * Call signs hiding inside a channel name.
 *
 * Local stations are sold as "NBC (WNBC) NEW YORK" and published as "WNBC",
 * or the other way about. The call sign is the reliable part of both.
 */
function callSigns(name) {
  const out = [];
  const re = /\b([KW][A-Z]{2,3})\b/g;
  let m;
  while ((m = re.exec(String(name || '')))) {
    const sign = m[1].toLowerCase();
    // "NBC WEST" is a feed marking, not a station in Seattle. Real call signs
    // that read as words — WAVE, WOOD, KING — are all still fine; only the
    // handful this file already knows to be feed markings are refused.
    if (FEED_TAIL.test(sign) && sign.replace(FEED_TAIL, '') === '') continue;
    out.push(sign);
  }
  return out;
}

/** Strongest first — which tier of match beats which. */
const TIERS = ['id', 'name', 'callsign', 'loose'];
const rank = (how) => {
  const at = TIERS.indexOf(how);
  return at === -1 ? TIERS.length : at;
};

/* ------------------------------------------------------------------- times */

/**
 * XMLTV stamps look like `20260827180000 +0000`, and sometimes the offset is
 * missing. Absent an offset the spec says local time; in practice a feed that
 * omits it is nearly always publishing UTC, so that is what we assume — and
 * being an hour out on a guide is a smaller sin than showing nothing.
 */
function parseStamp(raw) {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(raw || ''));
  if (!m) return 0;
  const [, y, mo, d, h, mi, se, off] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
  if (off) {
    const sign = off[0] === '-' ? -1 : 1;
    t -= sign * ((+off.slice(1, 3)) * 60 + (+off.slice(3, 5))) * 60000;
  }
  return Math.floor(t / 1000);
}

/* ----------------------------------------------------------------- fetching */

function open(target, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch {
      return reject(new Error('That does not look like a URL.'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      /* `gzip`, and not `identity`.
       *
       * Asking for identity looks tidier — these files are already gzip, so
       * why invite a second layer — and it broke two of the three US feeds
       * with a 404. A host that serves `file.xml.gz` through content
       * negotiation treats the `.gz` as an ENCODING rather than as part of
       * the name, and when you refuse that encoding there is no variant left
       * to send, so it says the file does not exist.
       *
       * There is nothing to gain by refusing anyway: `unwrap` peels off as
       * many layers as it finds, so gzip-around-gzip costs one more pass and
       * nothing else. */
      headers: { 'user-agent': UA, 'accept-encoding': 'gzip', accept: '*/*' },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc && redirectsLeft > 0) {
        res.resume();
        return resolve(open(new URL(loc, u).toString(), redirectsLeft - 1));
      }
      if (status >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Hand back a stream of plain XML, whatever the far end sent.
 *
 * Content-encoding cannot be trusted here: the open guides are served as
 * `.xml.gz` FILES, which is not the same thing as a gzip-encoded response,
 * and some hosts label it both ways or neither. So the first bytes decide —
 * gzip's magic number is unambiguous where the headers are not.
 */
function plainXml(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  let stream = res;
  if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
  else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
  return unwrap(stream, 0);
}

/**
 * Peel gzip off a stream until what is left is not gzip.
 *
 * Once is the obvious number and it is wrong. `epg_ripper_US1.xml.gz` is a
 * gzip FILE; ask for it with `accept-encoding: gzip` and a server may gzip the
 * transfer as well, so the response is gzip wrapped around gzip wrapped around
 * XML. Unwrapping only the layer the header mentions leaves binary, and binary
 * contains no `<channel>` elements — so the feed reports HTTP 200, contributes
 * nothing, and says nothing about it. That is a silent empty guide, which is
 * the worst way for this to fail.
 */
function unwrap(stream, depth) {
  if (depth >= 3) return Promise.resolve(stream);
  return new Promise((resolve) => {
    let settled = false;
    const done = (s) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    const decide = () => {
      if (settled) return;
      const head = stream.read() || Buffer.alloc(0);
      const out = new PassThrough();
      if (head.length) out.write(head);
      stream.pipe(out);
      if (head.length > 1 && head[0] === 0x1f && head[1] === 0x8b) {
        settled = true;
        resolve(unwrap(out.pipe(zlib.createGunzip()), depth + 1));
        return;
      }
      done(out);
    };
    stream.once('readable', decide);
    stream.once('end', () => done(new PassThrough().end()));
    stream.once('error', () => done(new PassThrough().end()));
  });
}

/* ------------------------------------------------------------------ the scan */

/**
 * Either kind of element we care about, whole. Self-closing forms are ignored
 * on purpose: a `<channel/>` has no name and a `<programme/>` has no title, so
 * neither can tell us anything.
 */
const OPEN = /<(channel|programme)\b([^>]*)>/gi;

/**
 * The four attributes we read, compiled once.
 *
 * This looks like premature tuning and is not: `attr()` runs four times per
 * programme against a feed with a million of them, and building a RegExp each
 * time was measurably the most expensive thing in the scan.
 */
const ATTRS = {
  id: /\bid=(["'])([\s\S]*?)\1/i,
  channel: /\bchannel=(["'])([\s\S]*?)\1/i,
  start: /\bstart=(["'])([\s\S]*?)\1/i,
  stop: /\bstop=(["'])([\s\S]*?)\1/i,
};
const attr = (attrs, name) => {
  const m = ATTRS[name].exec(attrs);
  return m ? unescapeXml(m[2]) : '';
};

/**
 * Read one XMLTV document, keeping only what belongs to us.
 *
 * `want` maps a channel key to the ids of our channels that answer to it, and
 * is built before a byte is downloaded — that is the whole trick. A programme
 * whose channel is not in there is dropped where it is read, so the peak cost
 * of scanning a 400MB guide is one chunk plus what we chose to keep.
 */
function scan(stream, want, into, stats) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const from = Math.floor((now - WINDOW_BACK_MS) / 1000);
    const to = Math.floor((now + WINDOW_FWD_MS) / 1000);

    /** Guide's channel id -> [our channel ids], for ids it declared. */
    const declared = new Map();
    /* A chunk boundary lands wherever the network put it, which is regularly
     * in the middle of a multi-byte character — and `chunk.toString('utf8')`
     * turns each half into a replacement character. On an English feed you
     * would never notice; on a Dutch or Turkish one it corrupts a title every
     * few hundred kilobytes. The decoder holds the split bytes back until the
     * rest of the character arrives. */
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let bytes = 0;
    let stopped = false;

    /* Which of our channels a guide's channel id belongs to, remembered.
     *
     * The same id appears on every one of a channel's programmes — tens of
     * thousands of times across a national guide — and answering it means
     * running `chanKey`, which is half a dozen regex replaces. Working it out
     * once per id rather than once per programme is the difference between a
     * scan that takes twenty seconds and one that takes three minutes. */
    const resolved = new Map();
    const ours = (guideId) => {
      if (resolved.has(guideId)) return resolved.get(guideId);
      // Declared in a <channel> block, or — plenty of feeds skip those — a
      // bare id we can still recognise on its own.
      let hit = declared.get(guideId) || null;
      if (!hit) {
        const ids = want.get(guideId.toLowerCase()) || want.get(chanKey(guideId));
        if (ids) hit = { ids };
      }
      resolved.set(guideId, hit);
      return hit;
    };

    const takeChannel = (attrs, body) => {
      const id = attr(attrs, 'id');
      if (!id) return;
      const names = [];
      const re = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi;
      let m;
      while ((m = re.exec(body))) names.push(unescapeXml(m[1]));

      stats.seen += 1;

      /* Remembered whether we want it or not. This is the only record of what
       * the guides actually contain, and it is what lets the box answer "you
       * have NBC EAST, the guide has NBC" instead of shrugging. */
      if (stats.offered.size < MAX_OFFERED) {
        const label = names[0] || id;
        for (const key of new Set([chanKey(id), ...names.map(chanKey)])) {
          if (key && !stats.offered.has(key)) stats.offered.set(key, label);
        }
      }

      // Strongest spelling wins outright: "ESPN2.us" must not be captured by
      // the channel that happens to call itself "ESPN".
      let best = null;
      for (const key of [id.toLowerCase(), chanKey(id), ...names.map(chanKey)]) {
        for (const entry of want.get(key) || []) {
          if (!best || rank(entry.how) < rank(best.how)) best = entry;
        }
      }
      if (!best) return;
      const ids = [];
      for (const key of [id.toLowerCase(), chanKey(id), ...names.map(chanKey)]) {
        for (const entry of want.get(key) || []) {
          if (!ids.some((e) => e.id === entry.id)) ids.push(entry);
        }
      }
      declared.set(id, { ids });
    };

    const takeProgramme = (attrs, body, hit) => {
      const start = parseStamp(attr(attrs, 'start'));
      const stop = parseStamp(attr(attrs, 'stop'));
      if (!start || !stop || stop <= start) return;
      if (stop < from || start > to) return;
      const tm = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body);
      const title = unescapeXml(tm ? tm[1] : '');
      if (!title) return;

      /* Filed under the tier that claimed it, not merged.
       *
       * One of our channels can legitimately be matched by two of the guide's
       * — "NBC EAST" meets both "NBC East" by name and "NBC" once the feed
       * marking is dropped — and pouring both into one list interleaves two
       * different schedules into a guide that is wrong in a way nobody can
       * see. They are kept apart and the best tier is chosen at the end. */
      for (const entry of hit.ids) {
        let tiers = into.get(entry.id);
        if (!tiers) into.set(entry.id, (tiers = new Map()));
        let slot = tiers.get(entry.how);
        // Which feed this came from is remembered so that a feed which fails
        // NEXT time can have its channels carried forward rather than lost.
        if (!slot) tiers.set(entry.how, (slot = { src: stats.source, list: [] }));
        if (slot.list.length >= MAX_PER_CHANNEL) continue;
        slot.list.push({ title, start, stop });
      }
      stats.kept += 1;
    };

    /*
     * Match the OPENING TAG only, then decide whether to look at the body.
     *
     * The obvious version matches whole elements — open tag, body, close tag —
     * in one regex, and it is why the first draft of this file peaked at
     * 800MB on a 450MB feed. Capturing the body allocates a string for every
     * programme in the document, and in a national guide upwards of 99% of
     * them belong to channels nobody here has. Reading the `channel`
     * attribute out of the small opening tag first, and slicing the body only
     * for the handful that survive, keeps the scan flat: the ones we discard
     * are stepped over with indexOf and never become strings at all.
     */
    const onChunk = (chunk) => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        stopped = true;
        stream.destroy();
        stats.truncated = true;
        return;
      }
      buf += decoder.write(chunk);

      let pos = 0;
      OPEN.lastIndex = 0;
      let m;
      while ((m = OPEN.exec(buf))) {
        const kind = m[1].toLowerCase();
        const attrs = m[2];
        const bodyStart = OPEN.lastIndex;
        // <programme ... /> — no body, so no title, so nothing to learn.
        if (attrs.endsWith('/')) {
          pos = bodyStart;
          continue;
        }
        const close = kind === 'channel' ? '</channel>' : '</programme>';
        const end = buf.indexOf(close, bodyStart);
        if (end === -1) {
          // The element runs past what has arrived. Leave it in the buffer
          // and pick it up when the rest of it turns up.
          pos = m.index;
          break;
        }
        if (kind === 'programme') {
          const chan = attr(attrs, 'channel');
          const hit = chan && ours(chan);
          if (hit) takeProgramme(attrs, buf.slice(bodyStart, end), hit);
        } else {
          takeChannel(attrs, buf.slice(bodyStart, end));
        }
        pos = end + close.length;
        OPEN.lastIndex = pos;
      }
      if (pos) buf = buf.slice(pos);
      // A tail that never closes — a truncated download, a feed with a stray
      // "<" — must not be allowed to grow into the whole file. Only ever
      // trimmed when nothing at all was consumed, so a legitimately large
      // element still gets to finish arriving.
      if (!pos && buf.length > 4 << 20) buf = buf.slice(-4096);
    };

    stream.on('data', onChunk);
    stream.on('error', (err) => (stopped ? resolve(stats) : reject(err)));
    stream.on('end', () => resolve(stats));
    stream.on('close', () => resolve(stats));
  });
}

/* --------------------------------------------------------------- the index */

/**
 * Every spelling one of our channels answers to, in order of how much it is
 * worth trusting.
 *
 * `id` is something the provider asserted about its own channel. `name` is
 * the two names flattening to the same thing. `callsign` and `loose` are
 * guesses — good ones, but guesses, and they are labelled so the screen can
 * pass that on rather than presenting all four as equally true.
 */
function channelKeys(ch) {
  const out = [];
  const add = (key, how) => {
    if (key && key.length >= 2 && !out.some((k) => k.key === key)) out.push({ key, how });
  };
  if (ch.epgId) {
    add(String(ch.epgId).toLowerCase(), 'id');
    add(chanKey(ch.epgId), 'id');
  }
  const tokens = nameTokens(ch.name);
  add(tokens.join(''), 'name');
  for (const sign of callSigns(ch.name)) add(sign, 'callsign');

  // The same name with feed markings and stray single letters taken out, then
  // that again with the network off the front. "NBC BRAVO (EAST) (D)" becomes
  // "nbcbravo" and then "bravo", which is what every guide calls it.
  const core = coreTokens(tokens);
  add(core.join(''), 'loose');
  add(withoutNetwork(core), 'loose');
  add(withoutNetwork(tokens), 'loose');
  add(coreKey(tokens.join('')), 'loose');
  return out;
}

/** Those keys, inverted: key -> the channels of ours that answer to it. */
function wantedKeys(channels) {
  const want = new Map();
  for (const ch of channels) {
    const id = String(ch.id);
    for (const { key, how } of channelKeys(ch)) {
      let set = want.get(key);
      if (!set) want.set(key, (set = []));
      if (!set.some((e) => e.id === id)) set.push({ id, how });
    }
  }
  return want;
}

function tidy(list) {
  const seen = new Set();
  return list
    .filter((p) => {
      const key = `${p.start}:${p.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_PER_CHANNEL);
}

/* -------------------------------------------------------------------- disk */

const filePath = () => path.join(store.dir, 'epg-guide.json');

function save() {
  const rows = {};
  for (const [id, list] of store.byChannel) rows[id] = list;
  const body = {
    at: store.at,
    matchedBy: Object.fromEntries(store.matchedBy),
    channels: rows,
    fromSource: Object.fromEntries(store.fromSource),
    offered: Object.fromEntries(store.offered),
    lastRun: store.lastRun,
  };
  try {
    fs.writeFileSync(filePath(), JSON.stringify(body), { mode: 0o600 });
  } catch (err) {
    store.log(`guide: could not save the index (${err.message})`);
  }
}

function load() {
  /* Cleared first, so a missing file means "nothing" rather than "whatever
   * was in memory". It only matters to the suites, which point the module at
   * a fresh directory several times in one process — but a load that leaves
   * the previous index standing made a broken feed look like a working one
   * for a whole afternoon of testing, so it is worth not doing. */
  store.at = 0;
  store.lastRun = null;
  store.byChannel = new Map();
  store.matchedBy = new Map();
  store.offered = new Map();
  store.fromSource = new Map();
  try {
    const body = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    store.at = Number(body.at) || 0;
    store.lastRun = body.lastRun || null;
    store.byChannel = new Map(Object.entries(body.channels || {}));
    store.matchedBy = new Map(Object.entries(body.matchedBy || {}));
    store.offered = new Map(Object.entries(body.offered || {}));
    store.fromSource = new Map(Object.entries(body.fromSource || {}));
  } catch {
    /* no index yet, which is the normal state on a new box */
  }
}

/* ---------------------------------------------------------------- the work */

function configure(opts = {}) {
  if (opts.dir) store.dir = opts.dir;
  if (opts.log) store.log = opts.log;
  load();
}

function setSources(urls) {
  store.sources = (Array.isArray(urls) ? urls : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function setChannels(channels) {
  store.channels = (Array.isArray(channels) ? channels : []).map((c) => ({
    id: String(c.id), epgId: c.epgId || '', name: c.name || '',
  }));
}

const due = () => !store.at || Date.now() - store.at > REFRESH_MS;

/**
 * Fetch every source and rebuild the index.
 *
 * Sources are read in order and merged, first answer winning per channel, so
 * the list is a preference order: put the provider's own feed first if you
 * trust it most, an open guide first if you do not.
 */
async function refresh({ force = false, sources = null } = {}) {
  if (store.running) return status();
  const list = sources || store.sources;
  if (!list.length) return status();
  if (!force && !due()) return status();
  if (!store.channels.length) return status();

  store.running = true;
  const started = Date.now();
  const want = wantedKeys(store.channels);
  const into = new Map();
  const stats = { kept: 0, seen: 0, offered: new Map(), truncated: false };
  const report = [];

  for (const source of list) {
    const label = source.label || source;
    const url = source.url || source;
    const keptBefore = stats.kept;
    const seenBefore = stats.seen;
    stats.source = label;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await open(url);
      // eslint-disable-next-line no-await-in-loop
      const xml = await plainXml(res);
      // eslint-disable-next-line no-await-in-loop
      await scan(xml, want, into, stats);
      const channels = stats.seen - seenBefore;
      report.push({
        label,
        ok: true,
        channels,
        programmes: stats.kept - keptBefore,
        /* A feed that answered 200 and declared no channels at all is not a
         * feed with nothing on it — it is something that was not XMLTV: a
         * login page, an error in HTML, or a gzip layer that never came off.
         * Reported as its own thing, because "0 channels" and "0 matched"
         * need completely different fixes. */
        notXmltv: channels === 0,
      });
      if (!channels) store.log(`guide: ${label} — answered, but no XMLTV channels in it`);
    } catch (err) {
      report.push({ label, ok: false, error: err.message });
      store.log(`guide: ${label} — ${err.message}`);
    }
  }

  /* One tier per channel — the strongest that produced anything.
   *
   * A channel matched on the id the provider gave it does not also want the
   * schedule of whatever happened to share its name with the feed marking
   * removed. Deciding here rather than during the scan is what makes that
   * possible: the strongest tier is not knowable until every source has been
   * read. */
  const tidied = new Map();
  const matchedBy = new Map();
  const fromSource = new Map();
  for (const [id, tiers] of into) {
    const best = TIERS.find((how) => (tiers.get(how)?.list || []).length);
    if (!best) continue;
    const slot = tiers.get(best);
    const listings = tidy(slot.list);
    if (!listings.length) continue;
    tidied.set(id, listings);
    matchedBy.set(id, best);
    fromSource.set(id, slot.src);
  }

  /* A feed that failed keeps what it gave us last time.
   *
   * The index is rebuilt from scratch on every refresh, so without this a
   * single 404 on one of three feeds throws away every channel that feed was
   * covering — the guide goes half-blank because a server had a bad minute.
   * Only for a day, though: carrying week-old listings forward would be
   * worse than admitting there are none.
   */
  const failed = new Set(report.filter((r) => !r.ok).map((r) => r.label));
  let carried = 0;
  if (failed.size && store.at && Date.now() - store.at < 24 * 60 * 60 * 1000) {
    for (const [id, listings] of store.byChannel) {
      if (tidied.has(id) || !failed.has(store.fromSource.get(id))) continue;
      tidied.set(id, listings);
      matchedBy.set(id, store.matchedBy.get(id) || 'name');
      fromSource.set(id, store.fromSource.get(id));
      carried += 1;
    }
  }

  // An index that came back empty never replaces one that did not. A feed
  // that is down for an afternoon should cost nothing at all.
  if (tidied.size || !store.byChannel.size) {
    store.byChannel = tidied;
    store.matchedBy = matchedBy;
    store.fromSource = fromSource;
    store.at = Date.now();
  }
  // What the guides contain is worth keeping even when nothing matched — that
  // is exactly the case where somebody needs to see it.
  if (stats.offered.size) store.offered = stats.offered;
  store.lastRun = {
    at: Date.now(),
    took: Date.now() - started,
    sources: report,
    channels: tidied.size,
    truncated: stats.truncated,
    carried,
  };
  store.running = false;
  save();
  store.log(`guide: ${tidied.size} channels covered, ${stats.kept} programmes, ${Math.round((Date.now() - started) / 1000)}s`);
  return status();
}

/** What is on this channel — or null if we have nothing for it at all. */
function lookup(ourId) {
  const list = store.byChannel.get(String(ourId));
  return list && list.length ? list : null;
}

function status() {
  let programmes = 0;
  for (const list of store.byChannel.values()) programmes += list.length;
  let byId = 0;
  let byName = 0;
  let byGuess = 0;
  for (const how of store.matchedBy.values()) {
    if (how === 'id') byId += 1;
    else if (how === 'name') byName += 1;
    else byGuess += 1;
  }
  return {
    at: store.at,
    running: store.running,
    covered: store.byChannel.size,
    channels: store.channels.length,
    programmes,
    byId,
    byName,
    byGuess,
    offered: store.offered.size,
    sources: store.sources,
    lastRun: store.lastRun,
    stale: due(),
  };
}

/**
 * Why a channel has no listings.
 *
 * The one question this feature generates, and until now the box could not
 * answer it — which left ticking guide boxes at random as the only way
 * forward. It puts the two sides next to each other: what we call the
 * channel, what it flattens to, and what the guides are offering that is
 * anywhere near it. Nine times out of ten the answer is visible immediately —
 * ours says `nbceast`, theirs says `nbc`.
 */
function explain(query) {
  const q = String(query || '').trim();
  if (!q) return { query: q, channels: [], near: [] };
  const qk = chanKey(q);
  const low = q.toLowerCase();

  /* What the guides have that is nearly this channel.
   *
   * Worked out per channel from that channel's own keys, not from what was
   * typed: searching "NBC" and being shown things near the word "NBC" is
   * useless, whereas being shown that the guide publishes `cnbc` while our
   * key is `nbccnbc` is the entire answer. Containment either way, because
   * the interesting near-misses are exactly the ones where one side carries
   * something the other does not. */
  const nearFor = (keys) => {
    const hits = [];
    for (const [key, label] of store.offered) {
      for (const k of keys) {
        if (k.length < 3) continue;
        if (key === k || key.includes(k) || k.includes(key)) {
          hits.push({ key, name: label, exact: key === k });
          break;
        }
      }
      if (hits.length >= 40) break;
    }
    return hits
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.key.length - b.key.length)
      .slice(0, 8);
  };

  const channels = store.channels
    .filter((c) => String(c.name).toLowerCase().includes(low)
      || (qk && chanKey(c.name).includes(qk))
      || String(c.epgId || '').toLowerCase().includes(low))
    .slice(0, 15)
    .map((c) => {
      const listings = store.byChannel.get(String(c.id));
      const keys = channelKeys(c);
      return {
        id: c.id,
        name: c.name,
        epgId: c.epgId || '',
        keys,
        covered: Boolean(listings && listings.length),
        programmes: listings ? listings.length : 0,
        matchedBy: store.matchedBy.get(String(c.id)) || null,
        near: nearFor(keys.map((k) => k.key)),
      };
    });

  return { query: q, channels, offered: store.offered.size };
}

module.exports = {
  configure, setSources, setChannels, refresh, lookup, status, explain, save, load,
  // Exported for the suites, which check the joining rather than the network.
  chanKey, coreKey, callSigns, parseStamp, wantedKeys, channelKeys, unescapeXml,
};
