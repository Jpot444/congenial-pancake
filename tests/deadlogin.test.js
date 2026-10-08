/**
 * An expired login is never handed out.
 *
 * "I am getting a second provider to replace the expired one" — "It will be
 *  the same provider not a different one"
 *
 * So for a while the box will hold a dead login beside a live one, and nothing
 * used to tell them apart: an expired login with no streams on it read as the
 * EMPTIEST account in the house, so pick() handed it out first. The billboard,
 * a channel, a download — all opened on a login that refuses them — and it was
 * still counted in "how many can the house watch at once".
 *
 * Driven against providers.js itself: the pool is a plain module, and what is
 * claimed here is entirely what it decides.
 */
const path = require('path');
const PATHS = require('./paths.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const providers = require(path.join(PATHS.ROOT, 'providers.js'));
const HOST = 'http://provider.example:8080';
const cfg = {
  mode: 'xtream', host: HOST, username: 'old', password: 'x',
  accounts: [
    { id: 'old', host: HOST, username: 'old', password: 'x' },
    { id: 'new', host: HOST, username: 'new', password: 'y' },
  ],
};
const day = 86400;
const now = Math.floor(Date.now() / 1000);

/* What the panel says about each: the old one ran out yesterday, the new one
   has a year. Both allow one connection. */
providers.note('old', { status: 'Expired', exp_date: String(now - day), max_connections: '1' });
providers.note('new', { status: 'Active', exp_date: String(now + 365 * day), max_connections: '1' });

console.log('\n  an expired login beside a fresh one');
check('the expired one is known to be dead', providers.dead('old') === true);
check('the fresh one is not', providers.dead('new') === false);

const first = providers.pick(cfg, { reserve: true });
console.log('    pick() →', first && first.id);
check('a stream is opened on the fresh login', first && first.id === 'new', first && first.id);
check('capacity counts only the live login', providers.capacity(cfg) === 1,
  String(providers.capacity(cfg)));
/* The live one is now reserved: the house is full. It must SAY full rather
   than offer the dead login as the spare. */
check('with that one in use the house is full — not "one free, on the dead login"',
  providers.pick(cfg) === null, JSON.stringify(providers.pick(cfg)));
check('and the free count agrees', providers.free(cfg) === 0, String(providers.free(cfg)));
const fb = providers.fallback(cfg);
check('the fallback for a full house is the live login, not the first in the list',
  fb && fb.id === 'new', fb && fb.id);
check('as is the login for a metadata call', providers.forMeta(cfg).id === 'new',
  providers.forMeta(cfg).id);
if (first && first.ticket) providers.claim(first.id, first.ticket);

console.log('\n  a login nobody has asked about yet');
/* The conservative guess, the same one DEFAULT_SLOTS makes: unknown is NOT
   dead. Otherwise a box that has just booted would refuse everything until
   the panel answered. */
const fresh = { mode: 'xtream', accounts: [{ id: 'unasked', host: HOST, username: 'u', password: 'p' }] };
check('is trusted until the provider says otherwise', providers.dead('unasked') === false);
check('and handed out', (providers.pick(fresh) || {}).id === 'unasked');

console.log('\n  a status that says so without a date');
providers.note('banned', { status: 'Banned', exp_date: String(now + day), max_connections: '2' });
providers.note('disabled', { status: 'Disabled', exp_date: null, max_connections: '1' });
check('banned is dead', providers.dead('banned') === true);
check('disabled is dead', providers.dead('disabled') === true);

console.log('\n  and every one dead');
const allDead = { mode: 'xtream', accounts: [{ id: 'old', host: HOST, username: 'old', password: 'x' }] };
check('nothing is offered as free', providers.pick(allDead) === null);
/* But the box still has something to try, so the provider refuses in its own
   words rather than the box going quiet. */
const last = providers.fallback(allDead);
check('the fallback is still the login there is', last && last.id === 'old', last && last.id);

console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
process.exit(fails.length ? 1 : 0);
