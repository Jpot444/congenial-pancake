/**
 * Show more keeps your place.
 *
 * "Clicking show more always returns me to the top, I want to stay on my
 *  location on the page"
 *
 * render() empties the grid and fills it again, and in between the page is
 * short, so the browser clamped the scroll to the top and nothing put it back.
 * Measured here as somebody would notice it: scroll down to the button, press
 * it, and see whether you are still where you were — on the desktop, where the
 * document scrolls, and on the phone shell, where the view does.
 */
const { chromium } = require('./playwright.js');

const BASE = `http://127.0.0.1:${process.env.PORTAL_PORT || 8481}`;
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MOVIES = {
  categories: [{ id: 'a', name: 'EN - ACTION' }],
  items: Array.from({ length: 260 }, (_, i) => ({
    kind: 'movie', id: 5000 + i, name: `Action Film ${String(i).padStart(3, '0')}`,
    logo: '', categoryId: 'a', added: 1700000000 + i, ext: 'mp4', rating: '6',
  })),
  totals: { items: 260 },
};

async function run(browser, layout, viewport) {
  console.log(`\n  ${layout}`);
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails.push('pageerror'); });
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.route('**/api/library**', (r) => {
    const tab = new URL(r.request().url()).searchParams.get('tab');
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(tab === 'movies' ? MOVIES : { categories: [], items: [], totals: { items: 0 } }) });
  });
  await page.addInitScript((l) => {
    localStorage.setItem('portal.profile', 'own1');
    localStorage.setItem('portal.layout', l);
  }, layout);
  await page.goto(`${BASE}/#/movies`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof render === 'function' && state && state.library,
    null, { timeout: 20000 });
  await wait(800);
  /* The shared test box is a playlist box, so the film library is handed to
     the page directly. Then Action, opened as its own grid: the page that has
     the button. */
  await page.evaluate((lib) => {
    document.querySelector('#tour')?.remove();
    state.library.movies = lib;
    location.hash = '#/movies';
    state.tab = 'movies';
    state.shelf = 'Action';
    state.visible = 60;
    render();
  }, MOVIES);
  await page.waitForSelector('#loadMore:not([hidden])', { timeout: 10000 });

  const where = () => page.evaluate(() => {
    const view = document.body.classList.contains('has-tabbar')
      ? document.querySelector('#appView:not([hidden])') : null;
    return {
      y: Math.round(view ? view.scrollTop : window.scrollY),
      cards: document.querySelectorAll('#grid .card').length,
      phone: Boolean(view),
    };
  });
  /* Down to the button, the way a thumb or a wheel would get there. */
  await page.evaluate(() => document.querySelector('#loadMore').scrollIntoView({ block: 'center' }));
  await wait(400);
  const before = await where();
  await page.click('#loadMore');
  await wait(600);
  const after = await where();
  console.log(`    before ${JSON.stringify(before)} · after ${JSON.stringify(after)}`);
  check(`${layout}: there was somewhere to scroll from`, before.y > 1000, String(before.y));
  check(`${layout}: more were shown`, after.cards > before.cards, `${before.cards} → ${after.cards}`);
  check(`${layout}: and you are where you were, not back at the top`,
    Math.abs(after.y - before.y) <= 4, `${before.y} → ${after.y}`);
  await page.close();
}

(async () => {
  const browser = await chromium.launch();
  await run(browser, 'desk', { width: 1440, height: 900 });
  await run(browser, 'phone', { width: 390, height: 844 });
  await browser.close();
  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all passed'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
