/**
 * The home-screen icon.
 *
 * This suite used to pin the opposite of what it pins now — "the icon is the
 * raw logo file itself" and "it carries transparency" — and the iPad
 * disproved both: public/bison.png is 219x148 with a transparent background,
 * which an iPhone quietly pads and fills but iPadOS renders as a blank white
 * tile. What iOS actually wants is boring, and boring is what is checked:
 *
 *   * square, 180x180, opaque in every pixel;
 *   * the bison on the app's own dark background, not on white;
 *   * margin around the mark, so the rounded-corner mask cannot clip it;
 *   * manufactured FROM the logo by scripts/make-app-icon.js — the logo stays
 *     the logo, and regenerating is one command when it changes;
 *   * also present at the bare /apple-touch-icon.png paths iPadOS requests on
 *     its own when it ignores the link tags, byte-identical.
 */
const fs = require('fs');
const PATHS = require('./paths.js');
const zlib = require('zlib');
const path = require('path');
const BASE = 'http://127.0.0.1:8481';
const ROOT = PATHS.ROOT;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

// Lifted by name from the script under test, as the other suites lift server
// functions — it is a command, not a module, and exporting from it so a test
// can reach inside would be reshaping shipped code for the test's convenience.
const decoder = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/make-app-icon.js'), 'utf8');
  const start = src.indexOf('function readPng(file) {');
  if (start < 0) throw new Error('readPng not found in make-app-icon.js');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return new Function('fs', 'zlib', `${src.slice(start, i + 1)}; return readPng;`);
      }
    }
  }
  throw new Error('unbalanced readPng');
})();
const readPng = decoder(fs, zlib);

(async () => {
  // --- the page asks for the manufactured icon -----------------------------
  console.log('\n  what the page declares');
  const html = await (await fetch(BASE)).text();
  const head = html.slice(0, html.indexOf('</head>'));

  const link = /<link[^>]+rel="apple-touch-icon"[^>]*>/.exec(head)?.[0] || '';
  check('the head asks for an apple-touch-icon', Boolean(link), 'no such link tag');
  const href = /href="([^"]+)"/.exec(link)?.[1] || '';
  check('pointing at the manufactured icon, not the raw logo',
    href === '/app-icon.png', href);
  check('with its size declared', /sizes="180x180"/.test(link), link);

  const name = /<meta[^>]+name="apple-mobile-web-app-title"[^>]+content="([^"]+)"/.exec(head)?.[1];
  check('the icon is named, so it is not labelled from the document title',
    name === 'Treasure Theater', String(name));
  check('while the raw bison is still the favicon and the profile gate',
    /rel="icon"[^>]+href="\/bison\.png"/.test(head) && /src="\/bison\.png"/.test(html));

  // --- and the server serves it -------------------------------------------
  console.log('\n  what the server sends back');
  const res = await fetch(BASE + href);
  check('it is actually there', res.status === 200, String(res.status));
  check('sent as a PNG', res.headers.get('content-type') === 'image/png',
    String(res.headers.get('content-type')));

  const bytes = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(__dirname, 'icon-fetched.png');
  fs.writeFileSync(tmp, bytes);
  const img = readPng(tmp);
  console.log(`   ${img.width}x${img.height}, ${(bytes.length / 1024).toFixed(1)} KB`);

  // --- the two facts the iPad taught --------------------------------------
  console.log('\n  what the iPad demanded');
  check('square', img.width === img.height, `${img.width}x${img.height}`);
  check('180x180 — the size iOS scales everything else from', img.width === 180,
    String(img.width));

  const px = (x, y) => {
    const o = (y * img.width + x) * 4;
    return [img.px[o], img.px[o + 1], img.px[o + 2], img.px[o + 3]];
  };

  let transparent = 0;
  let white = 0;
  let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b, a] = px(x, y);
      if (a < 255) transparent += 1;
      if (r > 200 && g > 200 && b > 200) {
        white += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(`   ${transparent} transparent px, mark x ${minX}-${maxX}, y ${minY}-${maxY}`);
  check('opaque in every pixel — transparency is the white iPad tile',
    transparent === 0, `${transparent} transparent pixels`);
  check('there is a bison in it', white > 1500, `${white} white pixels`);

  const [br, bgc, bb] = px(2, 2);
  check('on the app\'s own dark background, not on white',
    br < 60 && bgc < 60 && bb < 60, `corner is rgb(${br},${bgc},${bb})`);
  const margin = Math.min(minX, minY, img.width - 1 - maxX, img.height - 1 - maxY);
  check('with margin, so the rounded-corner mask cannot clip the mark',
    margin >= 12, `${margin}px`);

  // --- the paths iPadOS asks for by itself ---------------------------------
  //
  // When it ignores or misses the link tags, iPadOS requests these two names
  // from the site root directly. Byte-identical copies, made by the same
  // script in the same run.
  console.log('\n  the bare paths iPadOS requests on its own');
  for (const bare of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
    const alt = await fetch(BASE + bare);
    const altBytes = Buffer.from(await alt.arrayBuffer());
    check(`${bare} answers with the same icon`,
      alt.status === 200 && altBytes.equals(bytes),
      `${alt.status}, ${altBytes.length} vs ${bytes.length} bytes`);
  }

  // --- regenerating is one command -----------------------------------------
  //
  // The icon is a build product of the logo. Running the script again must
  // reproduce exactly what is committed, or the two have drifted.
  console.log('\n  the script reproduces what is committed');
  const before = fs.readFileSync(path.join(ROOT, 'public/app-icon.png'));
  require('child_process').execFileSync('node', [path.join(ROOT, 'scripts/make-app-icon.js')]);
  const after = fs.readFileSync(path.join(ROOT, 'public/app-icon.png'));
  check('byte for byte', before.equals(after), 'the committed icon is stale — rerun the script');

  fs.unlinkSync(tmp);
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
