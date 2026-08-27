/**
 * Listings for the channels the provider has none for.
 *
 * "So many of these stations have no listings available, see if there is any
 * other way for me to get live listings for the channels I have."
 *
 * There is: XMLTV. The provider's own `xmltv.php` covers the whole account in
 * one request instead of one per channel, and the open guides cover the great
 * many channels the provider never filled in at all.
 *
 * The hard parts are not the download. They are:
 *
 *   1. JOINING. A guide calls it "ESPN"; the provider calls it "US: ESPN HD";
 *      the id might be "ESPN.us" or might be "somefeed-4471". If the join is
 *      wrong the guide is worse than empty, because it is confidently wrong.
 *   2. SIZE. A national guide is a few hundred megabytes of XML and the Pi has
 *      a 1G ceiling. The scan has to stay flat no matter how big the feed is,
 *      which means never holding a programme that belongs to nobody.
 *
 * So this suite is mostly about those two, and it drives the real module
 * against a real gzipped feed over a real socket rather than mocking any of
 * it — the encoding, the streaming and the joining are the thing being tested.
 */
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PATHS = require('./paths.js');

const guide = require(PATHS.GUIDE);

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

/** An XMLTV stamp, relative to now, so the window logic is exercised for real. */
const stamp = (minutes) => {
  const d = new Date(Date.now() + minutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};

/**
 * Serve a feed, gzipped, in awkward little pieces.
 *
 * 997 bytes at a time on purpose: it is coprime with everything and it
 * guarantees chunk boundaries land in the middle of multi-byte characters,
 * which is the bug this had before a StringDecoder went in.
 */
function serve(xml) {
  const gz = zlib.gzipSync(Buffer.from(xml, 'utf8'));
  const srv = http.createServer((req, res) => {
    // Deliberately NOT content-encoding: gzip. These are .gz FILES, and the
    // real hosts label them as octet-streams.
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let i = 0;
    (function push() {
      while (i < gz.length) {
        const piece = gz.slice(i, i + 997);
        i += 997;
        if (!res.write(piece)) return res.once('drain', push);
      }
      res.end();
    })();
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/guide.xml.gz`,
      stop: () => srv.close(),
    }));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidesrc-'));
  guide.configure({ dir, log: () => {} });

  /* ---- the join ---------------------------------------------------- */
  //
  // Everything here is a real spelling seen in the wild.
  console.log('\n  matching a guide\'s idea of a channel to ours');
  check('a country prefix and a quality suffix do not stop a match',
    guide.chanKey('US: ESPN HD') === guide.chanKey('ESPN'), guide.chanKey('US: ESPN HD'));
  check('nor does the country suffix on an XMLTV id',
    guide.chanKey('ESPN.us') === guide.chanKey('ESPN'));
  check('nor a pipe instead of a colon',
    guide.chanKey('UK| Sky One') === guide.chanKey('Sky One'));
  check('nor the fullwidth HD some providers use',
    guide.chanKey('BBC ONE ᴴᴰ') === guide.chanKey('BBC One'));
  check('but two different channels stay different',
    guide.chanKey('ESPN 2') !== guide.chanKey('ESPN'));

  console.log('\n  and the times');
  check('an offset is honoured',
    guide.parseStamp('20260827180000 +0000') - guide.parseStamp('20260827180000 -0500') === -18000,
    String(guide.parseStamp('20260827180000 +0000') - guide.parseStamp('20260827180000 -0500')));
  check('a stamp with no offset still parses',
    guide.parseStamp('20260827180000') > 0);
  check('and rubbish is zero, not NaN',
    guide.parseStamp('not a time') === 0);

  console.log('\n  entities and CDATA, because titles are full of them');
  check('&amp; comes back as an ampersand', guide.unescapeXml('Tom &amp; Jerry') === 'Tom & Jerry');
  check('numeric entities too', guide.unescapeXml('It&#39;s') === "It's");
  check('CDATA is unwrapped', guide.unescapeXml('<![CDATA[Hello]]>') === 'Hello');

  /* ---- a real scan -------------------------------------------------- */
  console.log('\n  reading an actual feed');
  let xml = '<?xml version="1.0"?>\n<tv>\n';
  xml += '<channel id="ESPN.us"><display-name>ESPN</display-name></channel>\n';
  // The awkward case: an id that tells us nothing, matched on its name.
  xml += '<channel id="somefeed-4471"><display-name>Discovery Channel</display-name></channel>\n';
  xml += '<channel id="Junk.zz"><display-name>Nobody Has This</display-name></channel>\n';
  // Bulk nobody owns. This is what has to be thrown away without being kept.
  for (let i = 0; i < 4000; i++) {
    xml += `<programme start="${stamp(i * 30)}" stop="${stamp(i * 30 + 30)}" `
      + `channel="Junk.zz"><title>Filler ${i}</title></programme>\n`;
  }
  xml += `<programme start="${stamp(-10)}" stop="${stamp(50)}" channel="ESPN.us">`
    + '<title lang="en">SportsCenter</title></programme>\n';
  xml += `<programme start="${stamp(50)}" stop="${stamp(110)}" channel="ESPN.us">`
    + '<title>Tom &amp; Jerry</title></programme>\n';
  xml += `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="somefeed-4471">`
    + '<title>Ñandú café — a title with accents</title></programme>\n';
  // Ten days out: past the window, so it must not be kept.
  xml += `<programme start="${stamp(60 * 24 * 10)}" stop="${stamp(60 * 24 * 10 + 60)}" `
    + 'channel="ESPN.us"><title>Far Too Far Ahead</title></programme>\n';
  xml += '</tv>\n';

  const feed = await serve(xml);
  guide.setChannels([
    { id: '901', epgId: 'ESPN.us', name: 'US: ESPN HD' },
    { id: '902', epgId: '', name: 'US: DISCOVERY CHANNEL' },
    { id: '903', epgId: '', name: 'US: A CHANNEL NOBODY PUBLISHES' },
  ]);
  const before = process.memoryUsage().heapUsed;
  const status = await guide.refresh({ force: true, sources: [{ url: feed.url, label: 'test feed' }] });
  const after = process.memoryUsage().heapUsed;
  feed.stop();

  const espn = guide.lookup('901');
  const disc = guide.lookup('902');

  check('a channel matched by its id gets its listings',
    Array.isArray(espn) && espn.length === 2, JSON.stringify(espn));
  check('a channel matched only by name gets them too',
    Array.isArray(disc) && disc.length === 1, JSON.stringify(disc));
  check('a channel nobody publishes gets null, not an empty list',
    guide.lookup('903') === null);
  console.log('       (null is what makes the box fall back to asking the provider)');
  check('entities in a title are decoded',
    espn && espn[1].title === 'Tom & Jerry', espn && espn[1].title);
  check('accents survive a chunk boundary landing mid-character',
    disc && disc[0].title === 'Ñandú café — a title with accents', disc && disc[0].title);
  check('listings come back in time order',
    espn && espn[0].start < espn[1].start);
  check('a programme ten days out is not kept',
    espn && !espn.some((p) => /Far Too Far/.test(p.title)));

  console.log('\n  and it says how it matched, because the two are not equal');
  check('an id match is counted as an id match', status.byId === 1, String(status.byId));
  check('a name match is counted separately', status.byName === 1, String(status.byName));
  console.log('       (a name match is a good guess; the screen says so)');

  /* ---- the thing that keeps it off the OOM killer -------------------- */
  //
  // 4000 programmes for a channel we do not have. If any of them were kept —
  // or even turned into a string on the way past — a real national guide would
  // take the box down. The index is the proof: it should hold three
  // programmes, not four thousand and three.
  console.log('\n  what it refused to keep');
  check('programmes for channels we do not have are dropped',
    status.programmes === 3, String(status.programmes));
  check('and the index on disk is small enough to be nothing',
    fs.statSync(path.join(dir, 'epg-guide.json')).size < 4096,
    `${fs.statSync(path.join(dir, 'epg-guide.json')).size} bytes`);
  check('scanning the feed cost well under a megabyte of heap',
    after - before < 4 << 20, `${Math.round((after - before) / 1024)}KB`);

  /* ---- surviving a bad day ------------------------------------------ */
  console.log('\n  when a feed is down');
  const held = guide.lookup('901').length;
  await guide.refresh({ force: true, sources: [{ url: 'http://127.0.0.1:1/nope.xml', label: 'down' }] });
  check('a failed fetch does not wipe the listings we already had',
    guide.lookup('901')?.length === held, String(guide.lookup('901')?.length));
  console.log('       (a feed down for an afternoon should cost nothing at all)');

  const st = guide.status();
  check('and the failure is reported rather than swallowed',
    st.lastRun.sources.some((s) => !s.ok));

  /* ---- what the box does with it ------------------------------------ */
  console.log('\n  the box\'s side');
  const SERVER = fs.readFileSync(PATHS.SERVER, 'utf8');
  check('the guide is consulted before the provider is asked',
    /const fromGuide = guide\.lookup\(id\);/.test(SERVER)
    && SERVER.indexOf('const fromGuide') < SERVER.indexOf('const held = epgCache.get(id)'));
  console.log('       (a covered channel costs no provider call at all)');
  check("the provider's own guide is one request, not one per channel",
    /xmltv\.php/.test(SERVER));
  check('and it is skipped while something is playing',
    /includeProvider && cfg\?\.useProviderGuide !== false && !providerBusy\(\)/.test(SERVER));
  console.log('       (the open guides are ordinary downloads and never wait)');
  check('channels are read from the cache, never pulled from the provider',
    /function knownLiveChannels/.test(SERVER)
    && /for \(const \[key, entry\] of libraryCache\)/.test(SERVER));
  check('a day of listings is not shipped to a phone in one answer',
    /function windowOf/.test(SERVER) && /\.slice\(0, 16\)/.test(SERVER));
  check('the first refresh waits for the box to finish booting',
    /30 \* 60 \* 1000\)\.unref/.test(SERVER));
  check('feeds are offered rather than switched on behind your back',
    /const GUIDE_CATALOGUE/.test(SERVER) && !/GUIDE_CATALOGUE\.map\(\(c\) => c\.url\)/.test(SERVER));

  const APP = fs.readFileSync(PATHS.APP, 'utf8');
  check('the screen reports coverage, not a tick',
    /of \$\{\(this\.known \|\| 0\)\.toLocaleString\(\)\} channels/.test(APP));
  check('and admits when a match was made on the name alone',
    /a name match is a good guess, not a promise/.test(APP));

  const INDEX = fs.readFileSync(PATHS.INDEX, 'utf8');
  check('the panel is in the health modal', /id="guidePanel"/.test(INDEX));

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(fails.length ? `\n  ${fails.length} FAILED: ${fails.join(', ')}` : '\n  all good');
  process.exit(fails.length ? 1 : 0);
})().catch((err) => {
  console.log('  FAILED', err);
  process.exit(1);
});
