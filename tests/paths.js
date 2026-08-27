/**
 * Where the repo is, worked out rather than written down.
 *
 * The suites read the shipped source directly — app.js and server.js are
 * lifted and evaluated in places, so the thing under test is the thing that
 * ships rather than a copy of it. That only works if they can find it, and
 * an absolute path baked in at authoring time finds it on exactly one
 * machine.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  ROOT,
  APP: path.join(ROOT, 'public', 'app.js'),
  INDEX: path.join(ROOT, 'public', 'index.html'),
  SERVER: path.join(ROOT, 'server.js'),
  GUIDE: path.join(ROOT, 'epg-guide.js'),
  PUBLIC: path.join(ROOT, 'public'),
};
