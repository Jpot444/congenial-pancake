/*
 * Letting the house in, for a while.
 *
 * "sometimes I am at a friends house and want to use it without the hassle of
 *  cloudflair login, it always says the email code doesnt work and it isnt
 *  easy and fast like i want it to be. I want to be able to turn off the
 *  cloudflair protection if I'm using it at a friends, and turn it back on
 *  again when I leave."
 *
 * The site sits behind Cloudflare Access, which asks for an email and posts
 * back a one-time PIN. On your own phone that is a nuisance; on somebody
 * else's television it is a wall, because the code goes to a phone in your
 * pocket and the television has no keyboard worth the name.
 *
 * So this opens the door and — the part that matters — SHUTS IT AGAIN.
 *
 * HOW IT OPENS. An Access application is a list of policies evaluated in
 * precedence order. Opening adds one policy at the front: decision `bypass`,
 * matching `everyone`. Closing DELETES that policy. The off state is the
 * absence of the thing rather than a flag saying it is off, which is the only
 * arrangement where a half-finished write leaves the door shut rather than
 * open.
 *
 * WHAT IT NEVER DOES. It does not touch the policies that were already there.
 * It knows its own policy by name and will not delete one it did not create,
 * so a mistyped application id costs an error rather than somebody's access
 * rules.
 *
 * The caller supplies `fetchJson`, so the box's own HTTP is used and this file
 * can be driven by a test against a stand-in Cloudflare.
 */

const API = 'https://api.cloudflare.com/client/v4';

/* The name this module's own policy goes by. Recognised rather than
   remembered: an id written to disk would go stale the moment somebody
   removed the policy by hand in the dashboard, and then the box would think
   the door was open when it was shut, or worse, the other way round. */
const POLICY_NAME = 'Treasureflix — open house';

/* What the policy was called before the rename. Still recognised, so a door
   opened under the old name the evening of the rename is still a door this
   box can see and shut. Never created under it. */
const OLD_NAMES = ['Treasure Theater — open house'];
const ours = (p) => p && (p.name === POLICY_NAME || OLD_NAMES.includes(p.name));

/** Nothing here is worth a long wait; a door that will not open says so. */
const TIMEOUT_MS = 15000;

const store = {
  fetchJson: null,
  log: () => {},
};

function configure({ fetchJson, log }) {
  store.fetchJson = fetchJson;
  if (log) store.log = log;
}

/** The three things that have to be set before any of this can work. */
function ready(cf) {
  return Boolean(cf && cf.token && cf.accountId && cf.appId);
}

async function call(cf, path, { method = 'GET', body } = {}) {
  if (!store.fetchJson) throw new Error('cloudflare.js was never configured');
  const res = await store.fetchJson(`${API}/accounts/${encodeURIComponent(cf.accountId)}${path}`, {
    method,
    timeout: TIMEOUT_MS,
    headers: {
      authorization: `Bearer ${cf.token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  /* Cloudflare answers 200 with `success: false` as readily as it answers an
     HTTP error, so the body is what decides. Its `errors` carry the only
     sentence worth showing a person — "Invalid access token" rather than
     "request failed". */
  if (!res || res.success !== true) {
    const said = (res && Array.isArray(res.errors) && res.errors.length)
      ? res.errors.map((e) => e.message || e.code).filter(Boolean).join('; ')
      : 'Cloudflare refused that, and said nothing about why';
    throw new Error(said);
  }
  return res.result;
}

/**
 * The applications on this account, so somebody can find the one they mean
 * without reading an id out of a dashboard URL.
 */
async function apps(cf) {
  const list = await call(cf, '/access/apps');
  return (Array.isArray(list) ? list : []).map((app) => ({
    id: app.id,
    name: app.name || '',
    domain: app.domain || '',
  }));
}

/** Every policy on that application. */
async function policies(cf) {
  const list = await call(cf, `/access/apps/${encodeURIComponent(cf.appId)}/policies`);
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

/** This module's own policy on that application, or null. */
async function openPolicy(cf) {
  return (await policies(cf)).find(ours) || null;
}

/** Whether the door is open, asked of Cloudflare rather than of our own notes. */
async function isOpen(cf) {
  return Boolean(await openPolicy(cf));
}

/**
 * Open it. Idempotent: an existing open-house policy is left where it is
 * rather than added a second time.
 */
async function open(cf) {
  const list = await policies(cf);
  if (list.some(ours)) return { changed: false };
  /* AT THE END, NOT THE FRONT. Precedences on an application must be unique,
     and the first try at a real account asked for 1 and was refused —
     "policy precedences must be unique" — because the owner's own login rule
     already held it. Taking 1 would mean renumbering somebody else's
     policies, which this module never does.

     It does not need the front. Cloudflare evaluates every Bypass and Service
     Auth policy before any Allow or Block, wherever it sits in the list
     (developers.cloudflare.com → Access policies → order of enforcement), so
     a bypass at the end still runs first. */
  const last = list.reduce((max, p) => Math.max(max, Number(p.precedence) || 0), 0);
  await call(cf, `/access/apps/${encodeURIComponent(cf.appId)}/policies`, {
    method: 'POST',
    body: {
      name: POLICY_NAME,
      decision: 'bypass',
      include: [{ everyone: {} }],
      precedence: last + 1,
    },
  });
  store.log(`  cloudflare: open house ON — ${POLICY_NAME} added to ${cf.appId}`);
  return { changed: true };
}

/**
 * Shut it. Idempotent in the direction that matters: no policy is success, not
 * an error, because every caller of this is trying to make the door shut and
 * "it already was" is that.
 */
async function close(cf) {
  const policy = await openPolicy(cf);
  if (!policy) return { changed: false };
  await call(cf, `/access/apps/${encodeURIComponent(cf.appId)}/policies/${encodeURIComponent(policy.id)}`,
    { method: 'DELETE' });
  store.log(`  cloudflare: open house OFF — ${POLICY_NAME} removed from ${cf.appId}`);
  return { changed: true };
}

/*
 * THE HOME-SCREEN ICON, let through on its own.
 *
 * "Now it's a small black square with the bull in it surrounded by white"
 *
 * iOS fetches a page's touch icon by itself, outside the page's session —
 * without the Access login cookie — so behind Access it is handed the login
 * page instead of a PNG, gives up, and draws the favicon small on a white
 * tile. Every change to the favicon changed what the phone showed, in exactly
 * that way, which is how this was pinned down.
 *
 * So the three icon files get an Access application of their own, covering
 * those paths and nothing else, with a single policy letting anyone through.
 * Access applies the most specific path, so the icon is reachable and every
 * other path on the site is exactly as protected as it was.
 *
 * Like the open-house policy, it is known by its NAME and nothing else is
 * ever touched: the main application is read only to learn its hostname.
 */
const ICON_APP_NAME = 'Treasureflix — home-screen icon';
const ICON_PATHS = ['/app-icon.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'];

async function letIconThrough(cf) {
  const list = await call(cf, '/access/apps');
  const all = Array.isArray(list) ? list : [];
  const main = all.find((a) => a && a.id === cf.appId);
  if (!main || !main.domain) throw new Error('Could not read the protected application to find its address');
  const host = String(main.domain).replace(/^https?:\/\//, '').split('/')[0];
  const uris = ICON_PATHS.map((p) => `${host}${p}`);

  let app = all.find((a) => a && a.name === ICON_APP_NAME);
  let created = false;
  if (!app) {
    app = await call(cf, '/access/apps', {
      method: 'POST',
      body: {
        name: ICON_APP_NAME,
        type: 'self_hosted',
        domain: uris[0],
        destinations: uris.map((uri) => ({ type: 'public', uri })),
        app_launcher_visible: false,
      },
    });
    created = true;
  }
  const pols = await call(cf, `/access/apps/${encodeURIComponent(app.id)}/policies`);
  if (!(Array.isArray(pols) ? pols : []).some((p) => p && p.decision === 'bypass')) {
    await call(cf, `/access/apps/${encodeURIComponent(app.id)}/policies`, {
      method: 'POST',
      body: { name: 'Anyone — the icon only', decision: 'bypass',
        include: [{ everyone: {} }], precedence: 1 },
    });
    created = true;
  }
  if (created) store.log(`  cloudflare: home-screen icon let through (${uris.join(', ')})`);
  return { created, uris };
}

module.exports = { configure, ready, apps, isOpen, open, close, POLICY_NAME,
  letIconThrough, ICON_APP_NAME, ICON_PATHS };
