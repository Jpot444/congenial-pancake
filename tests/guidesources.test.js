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

  /* ---- the NBC problem ---------------------------------------------- */
  //
  // "I saved and fetched the US feeds but I am not getting NBC listings."
  //
  // Because the provider sells "NBC EAST" and "NBC WEST" and a national guide
  // publishes one "NBC". Neither is wrong and the exact keys never meet. So
  // there is a second attempt with the feed marking dropped — and it is
  // recorded as the compromise it is, because an east-coast schedule against
  // a west-coast feed is three hours out.
  console.log('\n  the channel the guide spells differently');
  check('a feed marking is dropped for a second attempt',
    guide.coreKey(guide.chanKey('NBC EAST')) === guide.chanKey('NBC'),
    guide.coreKey(guide.chanKey('NBC EAST')));
  check('but the exact spelling is still preferred',
    guide.channelKeys({ id: 1, name: 'NBC EAST' })[0].how === 'name');
  check('and the compromise is labelled as one',
    guide.channelKeys({ id: 1, name: 'NBC EAST' }).some((k) => k.how === 'loose'));
  check('a call sign inside a name is worth trying',
    guide.callSigns('NBC (WNBC) NEW YORK').includes('wnbc'));
  check('but WEST is a feed marking, not a station',
    guide.callSigns('NBC WEST').length === 0, JSON.stringify(guide.callSigns('NBC WEST')));
  check('and two letters is never a key',
    !guide.channelKeys({ id: 1, name: 'AB' }).some((k) => k.key.length < 2));

  console.log('\n  and it does not mix two schedules into one channel');
  let two = '<?xml version="1.0"?>\n<tv>\n';
  two += '<channel id="NBCEast.us"><display-name>NBC East</display-name></channel>\n';
  two += '<channel id="NBC.us"><display-name>NBC</display-name></channel>\n';
  two += `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="NBCEast.us">`
    + '<title>The Right One</title></programme>\n';
  two += `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="NBC.us">`
    + '<title>Three Hours Out</title></programme>\n';
  two += '</tv>\n';
  const twoFeed = await serve(two);
  guide.setChannels([{ id: '910', epgId: '', name: 'US| NBC EAST' }]);
  const twoStatus = await guide.refresh({
    force: true, sources: [{ url: twoFeed.url, label: 'two' }],
  });
  twoFeed.stop();
  const east = guide.lookup('910');
  check('the exact match wins outright',
    east?.length === 1 && east[0].title === 'The Right One', JSON.stringify(east));
  console.log('       (both matched; pouring both in would interleave two schedules)');
  check('and it is recorded as an exact name match, not a guess',
    twoStatus.byGuess === 0 && twoStatus.byName === 1,
    `byName ${twoStatus.byName} byGuess ${twoStatus.byGuess}`);

  // And the other way round: only the loose one exists, so it is used — and
  // owned up to.
  let one = '<?xml version="1.0"?>\n<tv>\n';
  one += '<channel id="NBC.us"><display-name>NBC</display-name></channel>\n';
  one += `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="NBC.us">`
    + '<title>Better Than Nothing</title></programme>\n</tv>\n';
  const oneFeed = await serve(one);
  guide.setChannels([{ id: '911', epgId: '', name: 'US| NBC EAST' }]);
  const oneStatus = await guide.refresh({
    force: true, sources: [{ url: oneFeed.url, label: 'one' }],
  });
  oneFeed.stop();
  check('where only the loose spelling exists, it is used',
    guide.lookup('911')?.[0]?.title === 'Better Than Nothing');
  check('and counted as a guess rather than a match',
    oneStatus.byGuess === 1 && oneStatus.byName === 0,
    `byName ${oneStatus.byName} byGuess ${oneStatus.byGuess}`);

  /* ---- the network said twice --------------------------------------- */
  //
  // Reported from the box, verbatim:
  //
  //     NBC CNBC ᴿᴬᵂ
  //     No listings.
  //     yours: nbccnbc
  //
  // This provider files a channel under its network and then says it again.
  // Flattened that is `nbccnbc`, and every guide on earth publishes `cnbc`,
  // so no number of ticked feeds could ever have matched it.
  console.log('\n  the network said twice');
  check('the superscript RAW marking falls out',
    guide.chanKey('NBC CNBC ᴿᴬᵂ') === 'nbccnbc', guide.chanKey('NBC CNBC ᴿᴬᵂ'));
  check('and the repeated network comes off for a second attempt',
    guide.channelKeys({ id: 1, name: 'NBC CNBC ᴿᴬᵂ' }).some((k) => k.key === 'cnbc'),
    JSON.stringify(guide.channelKeys({ id: 1, name: 'NBC CNBC ᴿᴬᵂ' })));
  check('same for MSNBC', guide.channelKeys({ id: 1, name: 'NBC MSNBC ᴿᴬᵂ' })
    .some((k) => k.key === 'msnbc'));
  check('and for the network on itself',
    guide.channelKeys({ id: 1, name: 'NBC NBC ᴿᴬᵂ' }).some((k) => k.key === 'nbc'));
  // The guard. Dropping a leading word is dangerous and this is the case that
  // shows why: "one" would match anything in the world called One.
  check('but "BBC ONE" does not become "one"',
    !guide.channelKeys({ id: 1, name: 'BBC ONE' }).some((k) => k.key === 'one'),
    JSON.stringify(guide.channelKeys({ id: 1, name: 'BBC ONE' })));
  console.log('       (only when the network is spelled inside what follows it,');
  console.log('        or what is left is too long to be an English word)');

  let cnbc = '<?xml version="1.0"?>\n<tv>\n';
  cnbc += '<channel id="CNBC.us"><display-name>CNBC</display-name></channel>\n';
  cnbc += `<programme start="${stamp(-5)}" stop="${stamp(55)}" channel="CNBC.us">`
    + '<title>Squawk Box</title></programme>\n</tv>\n';
  const cnbcFeed = await serve(cnbc);
  guide.setChannels([{ id: '930', epgId: '', name: 'NBC CNBC ᴿᴬᵂ' }]);
  await guide.refresh({ force: true, sources: [{ url: cnbcFeed.url, label: 'us1' }] });
  cnbcFeed.stop();
  check('so the channel that had nothing now has its listings',
    guide.lookup('930')?.[0]?.title === 'Squawk Box', JSON.stringify(guide.lookup('930')));

  /* ---- markings in the middle of the name ---------------------------- */
  //
  // Reported: "NBC CNBC ᴿᴬᵂ is getting listings, but NBC BRAVO (EAST) (D) ᴿᴬᵂ
  // is not." Trimming the END of the joined key is not enough when the feed
  // marking is in the MIDDLE and a stray "(D)" sits behind it.
  console.log('\n  markings that are not at the end');
  const bravo = guide.channelKeys({ id: 1, name: 'NBC BRAVO (EAST) (D) ᴿᴬᵂ' })
    .map((k) => k.key);
  check('a feed marking mid-name comes out', bravo.includes('nbcbravo'),
    JSON.stringify(bravo));
  check('and with the network off the front it is just the channel',
    bravo.includes('bravo'), JSON.stringify(bravo));
  // The two guards on that, both of which matter.
  check('but a lone digit is kept — MTV 2 is not MTV',
    !guide.channelKeys({ id: 1, name: 'MTV 2' }).some((k) => k.key === 'mtv'),
    JSON.stringify(guide.channelKeys({ id: 1, name: 'MTV 2' })));
  check('and "NBC EAST" never reduces to "east"',
    !guide.channelKeys({ id: 1, name: 'NBC EAST' }).some((k) => k.key === 'east'),
    JSON.stringify(guide.channelKeys({ id: 1, name: 'NBC EAST' })));
  // The pair from the report: one worked, one did not, and the only
  // difference is which local guide happens to carry the call sign.
  check('a call sign is pulled out of a local station name',
    guide.channelKeys({ id: 1, name: 'CBS 2 (KTVN) RENO HD' })
      .some((k) => k.key === 'ktvn' && k.how === 'callsign'));
  check('for both of them, not just the one that worked',
    guide.channelKeys({ id: 1, name: 'CBS 2 (KUTV) SALT LAKE CITY HD' })
      .some((k) => k.key === 'kutv' && k.how === 'callsign'));

  let bravoXml = '<?xml version="1.0"?>\n<tv>\n';
  bravoXml += '<channel id="Bravo.us"><display-name>Bravo</display-name></channel>\n';
  bravoXml += `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="Bravo.us">`
    + '<title>Below Deck</title></programme>\n</tv>\n';
  const bravoFeed = await serve(bravoXml);
  guide.setChannels([{ id: '960', epgId: '', name: 'NBC BRAVO (EAST) (D) ᴿᴬᵂ' }]);
  await guide.refresh({ force: true, sources: [{ url: bravoFeed.url, label: 'us1' }] });
  bravoFeed.stop();
  check('so the channel gets its listings',
    guide.lookup('960')?.[0]?.title === 'Below Deck', JSON.stringify(guide.lookup('960')));

  /* ---- the short name in brackets ------------------------------------ */
  //
  // Reported as still missing: CBS 3 (WCIA) CHAMPAIGN, NBC E! (WEST),
  // NBC SPORTS BOSTON (A), NBC NEW ENGLAND CABLE NEWS (NECN) (D).
  //
  // The brackets carry the meaning. Inside them this provider puts both the
  // short name a guide would use and the marking that qualifies it, and the
  // two have to be told apart.
  console.log('\n  the short name in brackets');
  const keysOf = (name) => guide.channelKeys({ id: 1, name }).map((k) => `${k.key}:${k.how}`);
  check('a bracketed short name becomes a key even without a K or W',
    keysOf('NBC NEW ENGLAND CABLE NEWS (NECN) (D) ᴿᴬᵂ').includes('necn:callsign'),
    JSON.stringify(keysOf('NBC NEW ENGLAND CABLE NEWS (NECN) (D) ᴿᴬᵂ')));
  console.log('       (NECN is not a call sign — it starts with an N)');
  check('and the K/W ones still work',
    keysOf('CBS 3 (WCIA) CHAMPAIGN HD').includes('wcia:callsign'));
  check('a bracketed marking is dropped',
    keysOf('NBC SPORTS BOSTON (A) ᴿᴬᵂ').includes('nbcsportsboston:loose'),
    JSON.stringify(keysOf('NBC SPORTS BOSTON (A) ᴿᴬᵂ')));

  // The one that would have done real damage. E! is a channel whose whole
  // name is one letter; treating it like the "(D)" in Bravo's name leaves
  // `nbc`, and E! quietly inherits the whole of NBC's schedule.
  const eKeys = keysOf('NBC E! (WEST) ᴿᴬᵂ');
  check('an unbracketed lone letter is a name, not a marking',
    !eKeys.some((k) => k.startsWith('nbc:')), JSON.stringify(eKeys));
  console.log('       (else E! is keyed `nbc` and shows NBC\'s listings as its own)');

  let necnXml = '<?xml version="1.0"?>\n<tv>\n';
  necnXml += '<channel id="NECN.us"><display-name>NECN</display-name></channel>\n';
  necnXml += `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="NECN.us">`
    + '<title>The Take</title></programme>\n</tv>\n';
  const necnFeed = await serve(necnXml);
  guide.setChannels([{ id: '980', epgId: '', name: 'NBC NEW ENGLAND CABLE NEWS (NECN) (D) ᴿᴬᵂ' }]);
  await guide.refresh({ force: true, sources: [{ url: necnFeed.url, label: 'locals' }] });
  necnFeed.stop();
  check('so it gets its listings', guide.lookup('980')?.[0]?.title === 'The Take',
    JSON.stringify(guide.lookup('980')));

  /* ---- asking a feed what it actually said --------------------------- */
  //
  // "HTTP 404" is where a diagnosis stops rather than starts — especially
  // when the filename is right, the file is published, and another file from
  // the same host downloads fine. The body of a refusal usually says why.
  console.log('\n  asking a feed what it actually said');
  const rude = http.createServer((rq, rs) => {
    rs.writeHead(404, { 'content-type': 'text/html', server: 'cloudflare' });
    rs.end('<html><body>Rate limited. Try again later.</body></html>');
  });
  const rudePort = await new Promise((r) => rude.listen(0, '127.0.0.1', () => r(rude.address().port)));
  const said = await guide.probe(`http://127.0.0.1:${rudePort}/us1.xml.gz`);
  rude.close();
  check('the status comes back', said.status === 404, String(said.status));
  check('and the body, which is where the reason usually is',
    /Rate limited/.test(said.snippet), said.snippet);
  check('and what the bytes really are, whatever the name said',
    said.looks === 'an HTML page, not a guide', said.looks);
  console.log('       (a name ending .xml.gz proves nothing about the answer)');

  // A gzipped error page is exactly the case where the words matter most, and
  // the first version reported "looks like gzip" and threw the body away.
  const gzRude = http.createServer((rq, rs) => {
    rs.writeHead(404, { 'content-type': 'text/html', server: 'cloudflare' });
    rs.end(zlib.gzipSync(Buffer.from(
      '<html><head><title>404 Not Found</title></head><body>No such file.</body></html>',
    )));
  });
  const gzPort = await new Promise((r) => gzRude.listen(0, '127.0.0.1', () => r(gzRude.address().port)));
  const gzSaid = await guide.probe(`http://127.0.0.1:${gzPort}/us1.xml.gz`);
  gzRude.close();
  check('a gzipped refusal is unwrapped so its words can be read',
    /404 Not Found/.test(gzSaid.snippet), JSON.stringify(gzSaid.snippet));
  check('and named for what is inside it, not just the wrapper',
    gzSaid.looks === 'a gzipped HTML page, not a guide', gzSaid.looks);

  /* ---- asking the host what it publishes today ----------------------- */
  //
  // A list of feed names written down at build time is a guess about somebody
  // else's server, and it goes stale silently — which is what two 404s from a
  // host still serving a third file look like.
  console.log('\n  asking the host what it publishes today');
  const index = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/html' });
    rs.end('<html><body><h1>Index of /epgshare01/</h1><pre>'
      + '<a href="../">../</a>\n'
      + '<a href="epg_ripper_US2.xml.gz">epg_ripper_US2.xml.gz</a>   27-Aug-2026 04:15   41M\n'
      + '<a href="epg_ripper_US_LOCALS3.xml.gz">epg_ripper_US_LOCALS3.xml.gz</a>  27-Aug-2026 04:20   12M\n'
      + '<a href="0_READ_ME_FIRST.html">0_READ_ME_FIRST.html</a>   27-Aug-2026 04:00   2K\n'
      + '</pre></body></html>');
  });
  const idxPort = await new Promise((r) => index.listen(0, '127.0.0.1', () => r(index.address().port)));
  const files = await guide.listing(`http://127.0.0.1:${idxPort}/epgshare01/`);
  index.close();
  check('the guides on the host are listed', files.length === 2, JSON.stringify(files.map((f) => f.name)));
  check('with addresses that can be saved as they are',
    files[0].url.endsWith('/epgshare01/epg_ripper_US2.xml.gz'), files[0].url);
  check('and the size, so a 41M file is not ticked by accident',
    files[0].size === '41M', files[0].size);
  check('anything that is not a guide is left out',
    !files.some((f) => /READ_ME/.test(f.name)));
  console.log('       (so the list on screen is the host\'s, not one written down months ago)');

  // A guide that 404s has nearly always been renamed rather than withdrawn,
  // so the useful part of "not found" is the neighbouring filename.
  console.log('\n  and suggests what it was renamed to');
  const onHost = [
    { name: 'epg_ripper_US2.xml.gz', size: '41M' },
    { name: 'epg_ripper_US_LOCALS3.xml.gz', size: '12M' },
    { name: 'epg_ripper_US_SPORTS1.xml.gz', size: '900K' },
    { name: 'epg_ripper_UK1.xml.gz', size: '20M' },
    { name: 'epg_ripper_CA1.xml.gz', size: '9M' },
  ];
  const forUs1 = guide.nearestNames('https://h/d/epg_ripper_US1.xml.gz', onHost);
  check('the same family of file is offered',
    forUs1.some((f) => f.name === 'epg_ripper_US2.xml.gz'),
    JSON.stringify(forUs1.map((f) => f.name)));
  check('and a different country is not',
    !forUs1.some((f) => /UK1|CA1/.test(f.name)),
    JSON.stringify(forUs1.map((f) => f.name)));
  console.log('       (every file here is called epg_ripper_something, so a fixed');
  console.log('        threshold means nothing — it is measured against that)');
  check('the closest name sorts first',
    guide.nearestNames('https://h/d/epg_ripper_US_LOCALS2.xml.gz', onHost)[0].name
      === 'epg_ripper_US_LOCALS3.xml.gz');
  check('and a file with no relatives gets no suggestions',
    guide.nearestNames('https://h/d/epg_ripper_DE1.xml.gz', onHost).length === 0);

  const SRC = fs.readFileSync(PATHS.SERVER, 'utf8');
  check('a failing feed is asked about only on failure',
    /if \(said\.status >= 400 \|\| said\.error\) \{/.test(SRC));
  check('the box refuses to probe its own network',
    /Only addresses out on the internet can be tested/.test(SRC)
    && /\^192\\\.168\\\./.test(SRC));
  console.log('       (it fetches a URL and shows you the body — that needs a guard)');
  check('and the tailnet counts as its own network too',
    /100\\\.\(6\[4-9\]/.test(SRC));
  check('the listing goes through the same guard as the probe',
    (SRC.match(/privateAddress\(/g) || []).length >= 3);
  check("and never hands back the provider feed's address, which has the password in it",
    /secret: true/.test(SRC) && /source\.secret \? '' : url/.test(fs.readFileSync(PATHS.GUIDE, 'utf8')));

  /* ---- one feed down must not blank the others ----------------------- */
  //
  // The index is rebuilt from scratch every refresh, so without carrying a
  // failed feed's channels forward a single 404 on one of three feeds throws
  // away everything that feed was covering. Which is exactly what a report of
  // "US1 — HTTP 404, US_SPORTS1 — 250 channels" would have done.
  console.log('\n  when one feed of several fails');
  let twoA = '<?xml version="1.0"?>\n<tv>\n'
    + '<channel id="AAA.us"><display-name>Alpha</display-name></channel>\n'
    + `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="AAA.us">`
    + '<title>From Feed A</title></programme>\n</tv>\n';
  let twoB = '<?xml version="1.0"?>\n<tv>\n'
    + '<channel id="BBB.us"><display-name>Beta</display-name></channel>\n'
    + `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="BBB.us">`
    + '<title>From Feed B</title></programme>\n</tv>\n';
  const feedA = await serve(twoA);
  const feedB = await serve(twoB);
  guide.setChannels([
    { id: '970', epgId: 'AAA.us', name: 'Alpha' },
    { id: '971', epgId: 'BBB.us', name: 'Beta' },
  ]);
  await guide.refresh({
    force: true,
    sources: [{ url: feedA.url, label: 'feed A' }, { url: feedB.url, label: 'feed B' }],
  });
  check('both feeds land', Boolean(guide.lookup('970') && guide.lookup('971')));

  // Now A is gone and B still works — the shape of the reported failure.
  feedA.stop();
  const half = await guide.refresh({
    force: true,
    sources: [{ url: feedA.url, label: 'feed A' }, { url: feedB.url, label: 'feed B' }],
  });
  feedB.stop();
  check('the feed that failed keeps what it gave us last time',
    guide.lookup('970')?.[0]?.title === 'From Feed A', JSON.stringify(guide.lookup('970')));
  check('the feed that worked is refreshed as normal',
    guide.lookup('971')?.[0]?.title === 'From Feed B');
  check('and the carry-forward is reported rather than hidden',
    half.lastRun.carried === 1, String(half.lastRun.carried));
  console.log('       (a server having a bad minute should not half-blank the guide)');

  /* ---- and being able to see why ------------------------------------ */
  //
  // The thing that turns "it did not work" into something anybody can act on.
  console.log('\n  explaining a miss');
  // Its own feed and its own channels: these checks are about what the box
  // can SAY, and leaning on whatever an earlier section happened to leave in
  // the index makes them fail for reasons that have nothing to do with that.
  let shelf = '<?xml version="1.0"?>\n<tv>\n';
  shelf += '<channel id="NBC.us"><display-name>NBC</display-name></channel>\n';
  shelf += '<channel id="CNBC.us"><display-name>CNBC</display-name></channel>\n';
  shelf += `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="NBC.us">`
    + '<title>Anything</title></programme>\n</tv>\n';
  const shelfFeed = await serve(shelf);
  guide.setChannels([
    { id: '920', epgId: '', name: 'US| NBC EAST' },
    { id: '921', epgId: '', name: 'US| SOMETHING NOBODY PUBLISHES' },
    { id: '922', epgId: '', name: 'NBC CNBC ᴿᴬᵂ' },
  ]);
  await guide.refresh({ force: true, sources: [{ url: shelfFeed.url, label: 'shelf' }] });
  shelfFeed.stop();

  const why = guide.explain('NBC EAST');
  check('it finds our channel by a partial name',
    why.channels.some((c) => c.name === 'US| NBC EAST'));
  check('and shows the keys it reduced to, which is the actual answer',
    why.channels[0].keys.some((k) => k.key === 'nbceast'),
    JSON.stringify(why.channels[0]?.keys));
  check('and what the guides published that is nearly it',
    why.channels[0].near.some((n) => n.key === 'nbc'),
    JSON.stringify(why.channels[0]?.near?.slice(0, 4)));
  console.log('       ("yours is nbceast, theirs is nbc" is a complete answer)');
  // Worked out from the CHANNEL's keys, not from what was typed. Searching
  // "NBC" and being shown things near the word NBC helps nobody; being shown
  // that the guide has `cnbc` while ours is `nbccnbc` is the whole answer.
  const whyCnbc = guide.explain('CNBC');
  check('near misses are per channel, not per search term',
    whyCnbc.channels[0]?.near?.some((n) => n.key === 'cnbc'),
    JSON.stringify(whyCnbc.channels[0]?.near));
  const nothing = guide.explain('SOMETHING NOBODY PUBLISHES');
  check('a channel with nothing near it says so',
    nothing.channels.length === 1 && !nothing.channels[0].near.length,
    JSON.stringify(nothing.channels[0]?.near));
  check('and asking about nothing at all is not an error',
    guide.explain('').channels.length === 0);

  /* ---- gzip, however many layers of it ------------------------------- */
  //
  // Reported: three ticked US feeds, and "250 channels the guides published"
  // — which is a provider's EPG, not a national guide. All three open feeds
  // were contributing nothing and saying nothing about it.
  //
  // `epg_ripper_US1.xml.gz` is a gzip FILE. Ask for it with
  // `accept-encoding: gzip` and a server may gzip the transfer as well, so
  // the response is gzip around gzip around XML. Unwrapping only the layer
  // the header mentions leaves binary, binary contains no <channel>, and the
  // feed reports HTTP 200 having done nothing whatsoever.
  console.log('\n  gzip, however many layers of it');
  const oneProg = `<?xml version="1.0"?>\n<tv>\n`
    + '<channel id="CNBC.us"><display-name>CNBC</display-name></channel>\n'
    + `<programme start="${stamp(0)}" stop="${stamp(60)}" channel="CNBC.us">`
    + '<title>Squawk Box</title></programme>\n</tv>\n';

  const shapes = [
    ['a .gz file, unlabelled', (r, gz, dbl, raw) => {
      r.writeHead(200, { 'content-type': 'application/octet-stream' }); r.end(gz);
    }],
    ['a .gz file gzipped again on the wire', (r, gz, dbl) => {
      r.writeHead(200, { 'content-encoding': 'gzip' }); r.end(dbl);
    }],
    ['plain XML, no compression at all', (r, gz, dbl, raw) => {
      r.writeHead(200, { 'content-type': 'application/xml' }); r.end(raw);
    }],
  ];
  for (const [what, handler] of shapes) {
    const raw = Buffer.from(oneProg, 'utf8');
    const gz = zlib.gzipSync(raw);
    const dbl = zlib.gzipSync(gz);
    const srv = http.createServer((rq, rs) => handler(rs, gz, dbl, raw));
    // eslint-disable-next-line no-await-in-loop
    const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
    guide.setChannels([{ id: '950', epgId: 'CNBC.us', name: 'NBC CNBC ᴿᴬᵂ' }]);
    // eslint-disable-next-line no-await-in-loop
    const st2 = await guide.refresh({
      force: true, sources: [{ url: `http://127.0.0.1:${port}/e.xml.gz`, label: what }],
    });
    srv.close();
    check(`${what} is read`, guide.lookup('950')?.[0]?.title === 'Squawk Box',
      JSON.stringify(st2.lastRun.sources));
  }

  console.log('\n  and a feed that gives nothing says so');
  const notGuide = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/html' });
    rs.end('<html><body>Please log in to continue</body></html>');
  });
  const notPort = await new Promise((r) => notGuide.listen(0, '127.0.0.1', () => r(notGuide.address().port)));
  const notStatus = await guide.refresh({
    force: true, sources: [{ url: `http://127.0.0.1:${notPort}/x.xml.gz`, label: 'a login page' }],
  });
  notGuide.close();
  const run = notStatus.lastRun.sources[0];
  check('an answer that is not XMLTV is called out, not counted as success',
    run.ok && run.notXmltv && run.channels === 0, JSON.stringify(run));
  console.log('       ("0 channels" and "0 matched" need completely different fixes)');
  check('and every feed gets a line whether it worked or not',
    /paintRuns\(data\.lastRun\)/.test(fs.readFileSync(PATHS.APP, 'utf8')));
  check('with the channels it declared, not just what matched',
    /channels, `\s*\+ `\$\{\(s\.programmes \|\| 0\)\.toLocaleString\(\)\} listings for you/
      .test(fs.readFileSync(PATHS.APP, 'utf8'))
    || /channels, /.test(fs.readFileSync(PATHS.APP, 'utf8')));

  /* ---- surviving a bad day ------------------------------------------ */
  //
  // 950 is what the gzip section above left in the index — and note it has
  // already survived one refresh that found nothing (the login page). This
  // checks the other way of finding nothing: not answering at all.
  console.log('\n  when a feed is down');
  const held = guide.lookup('950').length;
  await guide.refresh({ force: true, sources: [{ url: 'http://127.0.0.1:1/nope.xml', label: 'down' }] });
  check('a failed fetch does not wipe the listings we already had',
    guide.lookup('950')?.length === held, String(guide.lookup('950')?.length));
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
    /good guess, not a promise/.test(APP));
  check('and flags the ones that needed a guess',
    /Worth a spot-check/.test(APP));

  /* ---- the settings screen must hand back what it was given ---------- */
  //
  // This one cost a working setup. The feed list is a FORM FIELD: what comes
  // out of it goes back in. Sending the redacted spelling meant the catalogue
  // tick boxes never matched anything so nothing looked chosen, and a second
  // Save wrote `https://host/…/epg_ripper_US1.xml.gz` in as if it were an
  // address — after which every feed 404s and the guide quietly empties.
  console.log('\n  the feed list survives a round trip');
  check('the settings screen is sent whole URLs, not redacted ones',
    /sources: guideSources\(cfg\),/.test(SERVER)
    && !/sources: guideSources\(cfg\)\.map\(redactUrl\)/.test(SERVER));
  check('and a URL redacted by an older build is dropped, not kept forever',
    /\.filter\(\(u\) => u && !u\.includes\('…'\)\)/.test(SERVER));
  console.log('       (a redacted URL can never resolve; it only fails every six hours)');

  const INDEX = fs.readFileSync(PATHS.INDEX, 'utf8');
  check('the panel is in the health modal', /id="guidePanel"/.test(INDEX));
  check('and can be asked why a channel has none', /id="guideWhy"/.test(INDEX));

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(fails.length ? `\n  ${fails.length} FAILED: ${fails.join(', ')}` : '\n  all good');
  process.exit(fails.length ? 1 : 0);
})().catch((err) => {
  console.log('  FAILED', err);
  process.exit(1);
});
