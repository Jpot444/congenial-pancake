/** min-width:0 on .modal-card stops it growing. Check nothing now spills out. */
const { chromium } = require('./playwright.js');
const fs = require('fs');
const SHOTS = __dirname + '/shots';
const fails = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto('http://127.0.0.1:8481', { waitUntil: 'networkidle' });
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('.modal')].map((m) => m.id));
    for (const id of ids) {
      const r = await page.evaluate((mid) => {
        document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
        const modal = document.getElementById(mid);
        modal.hidden = false;
        const card = modal.querySelector('.modal-card');
        if (!card) return null;
        const b = card.getBoundingClientRect();
        let worst = 0, culprit = '';
        for (const el of card.querySelectorAll('*')) {
          const c = el.getBoundingClientRect();
          if (c.width && c.right - b.right > worst) {
            worst = c.right - b.right;
            culprit = el.id || el.className || el.tagName;
          }
        }
        return { left: b.left, right: b.right, win: window.innerWidth, worst, culprit };
      }, id);
      if (!r) continue;
      const ok = r.right <= r.win + 1 && r.left >= -1 && r.worst <= 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${tag} ${id} ${JSON.stringify(r)}`);
      if (!ok) fails.push(`${tag}/${id}`);
      await page.screenshot({ path: `${SHOTS}/modal-${tag}-${id}.png` });
    }
    await page.close();
  }
  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall modals fit');
  process.exit(fails.length ? 1 : 0);
})();
