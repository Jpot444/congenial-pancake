/*
 * When two records are the same title.
 *
 * This is the portal's definition of "that film, under another number", and it
 * is now needed on BOTH sides. The browser uses it to rescue a watch-history
 * row whose id the provider has renumbered; the box uses it to answer the same
 * question against the whole catalogue, which is the part the browser cannot
 * see. Two copies of a rule like this drift — one gains a word on the stop
 * list, the other does not, and a title matches in one place and not the other
 * for reasons nobody can find. So there is one copy, loaded by the page as an
 * ordinary script and required by the server as an ordinary module.
 *
 * Nothing here touches the DOM, fetches anything, or knows what a library is.
 * It takes names and rows of `{ name }` and answers questions about them.
 */
(function (root, factory) {
  const api = factory();
  /* eslint-disable no-undef */
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
  /* eslint-enable no-undef */
}(typeof self !== 'undefined' ? self : globalThis, function () {
  /*
   * The provider's filing prefix: "EN - ", "US| ", "AR - ".
   *
   * Up to five characters and a separator, repeated — some rows carry two.
   * "XXX" is left alone deliberately: it is the adult marker and stripping it
   * would fold an adult title onto an ordinary one of the same name.
   */
  const TRIM_TAG = /^([A-Za-z0-9+&]{1,5})\s*[-|:–•]\s*/;

  function trimTag(raw) {
    let name = String(raw || '').trim();
    for (let i = 0; i < 4; i += 1) {
      const m = TRIM_TAG.exec(name);
      if (!m) break;
      const token = m[1].toUpperCase();
      if (token === 'XXX') break;
      if (!/^[A-Z0-9][A-Z0-9+&]*$/.test(m[1])) break;
      name = name.slice(m[0].length).trimStart();
    }
    return name || String(raw || '').trim();
  }

  /*
   * Words that describe the FILE, not the programme.
   *
   * A provider stamps these on and takes them off between ingests, so two
   * records of the same show disagree about them constantly. The report that
   * forced this was one line long and contained both halves of the problem:
   *
   *   the history said   Breaking Bad US
   *   the library said   AR - Breaking Bad 4K
   *
   * The filing prefix comes off already. "4K" is this list. "US" is why an
   * equality test is not enough on its own — see byName below.
   */
  const NOT_THE_TITLE = new Set([
    '4k', 'uhd', 'fhd', 'hd', 'sd', 'hq', 'hevc', 'h264', 'h265', 'x264', 'x265',
    '1080p', '1080', '720p', '720', '2160p', '2160', 'hdr', 'dv', 'dolby',
    'multi', 'vip', 'raw', 'dub', 'dubbed', 'sub', 'subbed', 'vost', 'vf',
  ]);

  /**
   * A title reduced to what a person would call it, for matching one record
   * against another. The provider's filing prefix, the year, the punctuation
   * and the case all come off — everything that can differ between two
   * listings of the same film.
   */
  function foldName(raw) {
    const bare = trimTag(raw)
      .toLowerCase()
      .replace(/\(\s*\d{4}\s*\)/g, ' ')
      // S01E02, S1 E2, 1x02 — an episode tag on a name that is meant to name
      // the SHOW, which is what a history row's own title often carries.
      .replace(/\bs\d{1,2}\s*[ex]\d{1,3}\b/g, ' ')
      .replace(/\b\d{1,2}x\d{1,3}\b/g, ' ')
      .replace(/[^\w\d]+/g, ' ')
      .trim();
    const kept = bare.split(' ').filter((w) => w && !NOT_THE_TITLE.has(w)).join(' ');
    // A title made only of those words is a title made of those words.
    return kept || bare;
  }

  const titleWords = (raw) => new Set(foldName(raw).split(' ').filter(Boolean));
  const covers = (big, small) => [...small].every((w) => big.has(w));

  /**
   * The one item whose name is this name, or nothing.
   *
   * Equality first. When that finds nothing, the same title spelled with a
   * word the other side does not have — "Breaking Bad US" against "Breaking
   * Bad" — is accepted, but ONLY when exactly one item could be meant. Two
   * candidates is not a near miss, it is a question this cannot answer: The
   * Office US and The Office UK are different programmes, and quietly playing
   * the wrong one is worse than saying so. Ambiguity gives up.
   *
   * One-word names are never matched loosely. "Dune" inside "Dune Part Two" is
   * the kind of match that looks clever and starts the wrong film.
   */
  function byName(items, name) {
    const want = foldName(name);
    if (!want) return null;
    const exact = (items || []).filter((i) => foldName(i.name) === want);
    if (exact.length) return exact[0];

    const wanted = new Set(want.split(' ').filter(Boolean));
    if (wanted.size < 2) return null;
    const near = (items || []).filter((i) => {
      const has = titleWords(i.name);
      if (has.size < 2) return false;
      return covers(wanted, has) || covers(has, wanted);
    });
    return near.length === 1 ? near[0] : null;
  }

  return { TRIM_TAG, trimTag, NOT_THE_TITLE, foldName, titleWords, covers, byName };
}));
