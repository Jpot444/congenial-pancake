/**
 * The credential redactor.
 *
 * These reports are copied out of the health panel and pasted into a chat, and
 * this provider puts the account in the URL path — /series/<user>/<pass>/id.mkv
 * — so anything that prints the URL hands out the subscription. ffmpeg prints
 * the URL it opened, which is how it got into the report in the first place.
 *
 * Lifted from server.js by name so it tests what ships.
 */
const fs = require('fs');
const PATHS = require('./paths.js');
const SRC = PATHS.SERVER;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const source = fs.readFileSync(SRC, 'utf8');
const start = source.indexOf('function redactUrl(text) {');
let depth = 0;
let end = start;
for (let i = source.indexOf('{', start); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const redactUrl = new Function(`${source.slice(start, end)}; return redactUrl;`)();

// The real shape, taken verbatim from a report that had already been shared.
const USER = 'be2a25055a98';
const PASS = '626fb9ac33';
const real = `Input #0, matroska,webm, from 'http://cf.boffworld.com/series/${USER}/${PASS}/2109511.mkv':`;
const out = redactUrl(real);
console.log('  ', out);
check('the account is gone', !out.includes(USER) && !out.includes(PASS), out);
check('the host survives, so it is still identifiable',
  out.includes('cf.boffworld.com'), out);
check('the title survives', out.includes('2109511.mkv'), out);
check('the rest of the line is untouched',
  out.startsWith('Input #0, matroska,webm, from'), out);

// The whole ffmpeg command, which carries the same URL.
const cmd = `-v info -nostats -y -user_agent X -ss 577 -noaccurate_seek ` +
  `-i http://cf.boffworld.com/series/${USER}/${PASS}/2109511.mkv -c:v copy`;
const safe = redactUrl(cmd);
console.log('  ', safe);
check('the command is redacted too', !safe.includes(USER) && !safe.includes(PASS), safe);
check('and its flags are left alone',
  safe.includes('-noaccurate_seek') && safe.includes('-ss 577'), safe);

for (const [label, input, banned] of [
  ['https as well as http', `https://x.tv/live/${USER}/${PASS}/9.ts`, USER],
  ['a query string', `http://x.tv/get.php?username=${USER}&password=${PASS}`, PASS],
  ['a port', `http://x.tv:8080/movie/${USER}/${PASS}/9.mkv`, USER],
  ['two urls on one line', `a http://x.tv/a/${USER}/1.ts b http://y.tv/b/${PASS}/2.ts`, PASS],
  ['a url in quotes', `from 'http://x.tv/series/${USER}/${PASS}/9.mkv':`, USER],
]) {
  const r = redactUrl(input);
  check(`${label} is redacted`, !r.includes(banned), `${input} -> ${r}`);
}

check('a local path is left alone',
  redactUrl('/home/user/downloads/film.mkv') === '/home/user/downloads/film.mkv',
  redactUrl('/home/user/downloads/film.mkv'));
check('text with no url is left alone',
  redactUrl('Stream #0:1(eng): Audio: eac3, 48000 Hz, 5.1(side)')
    === 'Stream #0:1(eng): Audio: eac3, 48000 Hz, 5.1(side)');
// Some providers put the account in userinfo instead of the path.
const userinfo = redactUrl('http://be2a25055a98:626fb9ac33@x.tv/movie/9.mkv');
check('credentials in the userinfo are stripped too',
  !userinfo.includes('626fb9ac33') && !userinfo.includes('be2a25055a98'), userinfo);
check('and the host still survives that', userinfo.includes('x.tv'), userinfo);

// Anything it cannot parse must collapse entirely rather than pass through.
check('an unparseable url collapses rather than passing through',
  redactUrl('http://%zz/secret') === '<url>', redactUrl('http://%zz/secret'));
check('redacting is idempotent, so a re-report does not degrade',
  redactUrl(redactUrl(real)) === redactUrl(real), redactUrl(redactUrl(real)));

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
