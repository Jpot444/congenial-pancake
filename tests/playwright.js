/**
 * Playwright, from wherever this machine keeps it.
 *
 * Every suite used to require it by absolute path — the one place it lives
 * inside the container these were written in. That is fine until somebody
 * runs them on a laptop, at which point all fifty fail identically on line
 * one and none of them are telling you anything about the portal.
 *
 * Tried in the order most likely to be right: a local install beside the
 * repo, whatever the module resolver finds, then the container's own path.
 */
const CANDIDATES = [
  'playwright',
  '@playwright/test',
  '/opt/node22/lib/node_modules/playwright',
  '/usr/lib/node_modules/playwright',
  '/usr/local/lib/node_modules/playwright',
];

let loaded = null;
const tried = [];
for (const name of CANDIDATES) {
  try {
    loaded = require(name);
    break;
  } catch (err) {
    tried.push(`${name}: ${err.code || err.message}`);
  }
}

if (!loaded) {
  console.error(
    '\nPlaywright is not installed on this machine, so none of these suites\n'
    + 'can run. From the repo root:\n\n'
    + '    npm install --no-save playwright && npx playwright install chromium\n\n'
    + 'Tried:\n  ' + tried.join('\n  ') + '\n'
  );
  process.exit(2);
}

module.exports = loaded;
