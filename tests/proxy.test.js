/**
 * The stream/image proxy, playlist parsing, and what /api/config is allowed
 * to say out loud.
 *
 * /stream?u= and /img?u= fetch an address of the client's choosing and hand
 * the body back. That is an open proxy unless the address is guarded the same
 * way the EPG probe already was: public internet is fine (HLS CDNs are not
 * the panel), private addresses only when they are the configured provider
 * or playlist origin. Cloud metadata and the router at 192.168.1.1 are not.
 *
 * The M3U parser used to store relative URLs as-is, so a playlist of
 * `channel.ts` never played. And GET /api/config used to echo the playlist
 * URL with the password still in the query string — the same class of leak
 * redactUrl exists to stop on ffmpeg lines.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PATHS = require('./paths.js');

const ROOT = PATHS.ROOT;
const SRC = PATHS.SERVER;
const DIR = '/tmp/portal-proxy';
const PORT = 8498;
const PANEL = 9494;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const lift = (name) => {
  const source = fs.readFileSync(SRC, 'utf8');
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no ${name}`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return source.slice(start, end);
};

const privateAddress = new Function(
  `${lift('mappedIpv4')}\n${lift('privateAddress')}; return privateAddress;`
)();
const parseM3U = new Function(`${lift('parseM3U')}; return parseM3U;`)();
const publicPlaylistUrl = new Function(`${lift('publicPlaylistUrl')}; return publicPlaylistUrl;`)();

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const streamPath = (url) => `/stream?u=${encodeURIComponent(b64url(url))}`;

/* ═══ 1. the address guard ═══════════════════════════════════════════════ */
console.log('\n  private addresses, including the spellings Node does not fold');
check('loopback is refused', Boolean(privateAddress('http://127.0.0.1/')));
check('RFC1918 is refused', Boolean(privateAddress('http://192.168.1.1/admin')));
check('link-local / cloud metadata is refused',
  Boolean(privateAddress('http://169.254.169.254/latest/meta-data/')));
check('a public host is allowed', privateAddress('https://cdn.example.com/seg.ts') === '');
check('IPv4-mapped IPv6 loopback is refused — [::ffff:127.0.0.1] used to pass',
  Boolean(privateAddress('http://[::ffff:127.0.0.1]/')));
check('and so is mapped link-local',
  Boolean(privateAddress('http://[::ffff:169.254.169.254]/')));
check('a trailing dot on localhost is refused',
  Boolean(privateAddress('http://localhost./')));
check('decimal and hex loopback are refused — Node already folds them',
  Boolean(privateAddress('http://2130706433/'))
  && Boolean(privateAddress('http://0x7f000001/')));

/* ═══ 2. playlist URLs must not carry the password off the box ═══════════ */
console.log('\n  playlist URLs in GET /api/config');
const secret = 'http://x.tv/get.php?username=hunter&password=s3cret&type=m3u_plus';
const shown = publicPlaylistUrl(secret);
check('the password is gone', !shown.includes('s3cret') && !/password=/i.test(shown), shown);
check('the username query is gone too', !shown.includes('hunter') && !/username=/i.test(shown), shown);
check('the host and the rest of the query stay, so the screen still identifies it',
  shown.includes('x.tv') && shown.includes('type=m3u_plus'), shown);
check('userinfo credentials are stripped too',
  !publicPlaylistUrl('http://be2a:626f@x.tv/list.m3u').includes('626f'));
check('a URL with nothing to hide is unchanged',
  publicPlaylistUrl('http://nas.lan/tv.m3u') === 'http://nas.lan/tv.m3u');

/* ═══ 3. relative M3U entries resolve against the playlist ═══════════════ */
console.log('\n  M3U relative URLs');
const m3u = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-name="One",One',
  'channel.ts',
  '#EXTINF:-1,Two',
  '/live/two.ts',
  '#EXTINF:-1,Three',
  'https://cdn.example.com/abs.ts',
].join('\n');
const parsed = parseM3U(m3u, 'http://provider.example/list/index.m3u');
check('a relative path is resolved against the playlist',
  parsed[0] && parsed[0].url === 'http://provider.example/list/channel.ts',
  parsed[0] && parsed[0].url);
check('a root-relative path stays on the playlist host',
  parsed[1] && parsed[1].url === 'http://provider.example/live/two.ts',
  parsed[1] && parsed[1].url);
check('an already-absolute URL is left alone',
  parsed[2] && parsed[2].url === 'https://cdn.example.com/abs.ts',
  parsed[2] && parsed[2].url);

/* ═══ 4. drain/hold and playlist size are capped in the shipped source ═══ */
console.log('\n  the wiring');
const SERVER = fs.readFileSync(SRC, 'utf8');
check('drain is capped so a query cannot hold the pipe draining forever',
  /Math\.min\(30, Math\.max\(0, Number\(query\.get\('drain'\)/.test(SERVER));
check('hold is capped so a query cannot buffer the whole stream in RAM',
  /Math\.min\(15, Math\.max\(0, Number\(query\.get\('hold'\)/.test(SERVER));
check('rewritten HLS playlists have a body cap',
  /readBody\(upstream, 8 \* 1024 \* 1024\)/.test(SERVER));
check('/stream and /img both go through proxyAllowed',
  /proxyAllowed\(target\)/.test(SERVER) && /proxyAllowed\(src\)/.test(SERVER));
check('saving an EPG source is guarded the same way probing one is',
  /privateAddress\(u\)/.test(SERVER.slice(SERVER.indexOf("pathname === '/api/epg/sources'"))));
check('an unconfigured box does not throw on /api/play',
  /const mode = cfg && cfg\.mode/.test(SERVER));

/* ═══ 5. against a real box ══════════════════════════════════════════════ */
(async () => {
  console.log('\n  a running box');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
    mode: 'xtream', host: `http://127.0.0.1:${PANEL}`, username: 'u', password: 'p',
    preferredFormat: 'm3u8',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'profiles.json'), JSON.stringify({
    profiles: [{ id: 'own1', name: 'Hunter', emoji: '', color: '',
      prefs: { tourDone: true }, history: [] }],
  }));

  const panelHits = [];
  const panel = http.createServer((req, res) => {
    panelHits.push(req.url);
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end('TS');
  });
  await new Promise((r) => panel.listen(PANEL, '127.0.0.1', r));

  const server = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const call = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

  for (let i = 0; i < 40; i += 1) {
    try { await call('/'); break; } catch { await wait(250); }
  }

  try {
    const meta = await call(streamPath('http://169.254.169.254/latest/meta-data/'));
    check('the stream proxy refuses cloud metadata',
      meta.status === 400, `${meta.status} ${meta.body.slice(0, 80)}`);

    const router = await call(streamPath('http://192.168.1.1/'));
    check('and refuses a LAN address that is not the provider',
      router.status === 400, `${router.status} ${router.body.slice(0, 80)}`);

    const imgMeta = await call(`/img?u=${encodeURIComponent('http://169.254.169.254/')}`);
    check('the image proxy refuses the same addresses',
      imgMeta.status === 400, `${imgMeta.status} ${imgMeta.body.slice(0, 80)}`);

    const imgFile = await call(`/img?u=${encodeURIComponent('file:///etc/passwd')}`);
    check('and refuses file: URLs',
      imgFile.status === 400 || imgFile.status === 404,
      `${imgFile.status} ${imgFile.body.slice(0, 80)}`);

    const before = panelHits.length;
    const ok = await call(streamPath(`http://127.0.0.1:${PANEL}/live/u/p/1.ts`));
    check('a URL on the configured provider host is still fetched',
      ok.status === 200 && ok.body === 'TS' && panelHits.length > before,
      `${ok.status} hits=${panelHits.length - before}`);

    fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
      mode: 'm3u',
      playlistUrl: 'http://x.tv/get.php?username=hunter&password=s3cret&type=m3u_plus',
      host: '', username: '', password: '',
    }), { mode: 0o600 });
    // The box reads config off disk each request, so no restart.
    const cfg = JSON.parse((await call('/api/config')).body);
    check('GET /api/config does not echo the playlist password',
      !JSON.stringify(cfg).includes('s3cret') && cfg.mode === 'm3u',
      JSON.stringify(cfg));
    check('and still names the playlist so the settings screen can show it',
      String(cfg.playlistUrl || '').includes('x.tv'), cfg.playlistUrl);
  } finally {
    server.kill('SIGKILL');
    panel.close();
  }

  /* Unconfigured: /api/play used to throw on cfg.mode and answer 500. */
  console.log('\n  an unconfigured box');
  const DIR2 = '/tmp/portal-proxy-empty';
  fs.rmSync(DIR2, { recursive: true, force: true });
  fs.mkdirSync(DIR2, { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(DIR2, 'public'), { recursive: true });
  for (const f of ['server.js', 'local-library.js', 'epg-guide.js', 'people.js',
    'providers.js', 'recordings.js', 'recommend.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIR2, f));
  }
  const emptyPort = 8499;
  const empty = spawn('node', ['server.js'], {
    cwd: DIR2,
    env: { ...process.env, PORT: String(emptyPort), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const emptyGet = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: emptyPort, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  for (let i = 0; i < 40; i += 1) {
    try { await emptyGet('/'); break; } catch { await wait(250); }
  }
  try {
    const play = await emptyGet('/api/play?kind=live&id=1');
    check('/api/play on an unconfigured box is 400, not a 500 throw',
      play.status === 400 && /not in xtream/i.test(play.body),
      `${play.status} ${play.body.slice(0, 120)}`);
    const xtream = await emptyGet('/api/xtream?action=get_live_streams');
    check('and so is /api/xtream',
      xtream.status === 400, `${xtream.status} ${xtream.body.slice(0, 80)}`);
  } finally {
    empty.kill('SIGKILL');
  }

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
