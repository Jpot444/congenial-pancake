/*
 * The on-disk archive: an external drive of ~5.8k video files that the portal
 * browses and plays alongside the provider catalogue.
 *
 * The index is built offline by scripts/scan-library.js and read here. It is
 * deliberately not built at boot: probing six thousand files across USB takes
 * the better part of an hour, and the portal must come up in seconds.
 *
 * Paths in the index are RELATIVE to the scan root, which is what makes the
 * file portable — scanned on a Mac at /Volumes/Hunters Harddrive, served on
 * the Pi from wherever it gets mounted, same index either way.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let ROOT = null;
let INDEX_PATH = null;
let entries = [];
let byPath = new Map();
let dirs = new Map(); // rel dir -> { files: [], subdirs: Set }
let loadError = '';

function configure(opts = {}) {
  ROOT = opts.root ? path.resolve(opts.root) : null;
  INDEX_PATH = opts.indexPath || null;
  reload();
}

function reload() {
  entries = [];
  byPath = new Map();
  dirs = new Map();
  loadError = '';

  if (!INDEX_PATH || !fs.existsSync(INDEX_PATH)) {
    loadError = 'No library index. Run scripts/scan-library.js.';
    return;
  }

  let text;
  try {
    text = fs.readFileSync(INDEX_PATH, 'utf8');
  } catch (err) {
    loadError = `Could not read the library index: ${err.message}`;
    return;
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn final line from an interrupted scan
    }
    if (!rec || !rec.path) continue;
    // A resumed scan can append a path twice; last write wins. Collecting into
    // the map first and materialising after keeps that de-duplication linear.
    byPath.set(rec.path, rec);
  }
  entries = [...byPath.values()];

  // Build the directory tree once, so browsing is a map lookup rather than a
  // scan of six thousand records per request.
  for (const rec of entries) {
    const dir = rec.dir === '.' ? '' : rec.dir;
    if (!dirs.has(dir)) dirs.set(dir, { files: [], subdirs: new Set() });
    dirs.get(dir).files.push(rec);

    // Register this directory with every ancestor up to the root.
    let cur = dir;
    while (cur) {
      const parent = path.dirname(cur) === '.' ? '' : path.dirname(cur);
      if (!dirs.has(parent)) dirs.set(parent, { files: [], subdirs: new Set() });
      dirs.get(parent).subdirs.add(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  // Newest first within a folder; undated files sort by name at the end.
  for (const d of dirs.values()) {
    d.files.sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return a.title.localeCompare(b.title);
    });
  }
}

/** Is the drive actually present right now? The index outlives the mount. */
function mounted() {
  if (!ROOT) return false;
  try {
    return fs.statSync(ROOT).isDirectory();
  } catch {
    return false;
  }
}

function status() {
  const counts = { direct: 0, remux: 0, transcode: 0, unknown: 0 };
  for (const e of entries) counts[e.playback] = (counts[e.playback] || 0) + 1;
  return {
    root: ROOT,
    mounted: mounted(),
    indexed: entries.length,
    counts,
    error: loadError,
  };
}

/**
 * Turn a client-supplied relative path into an absolute one, or null.
 *
 * This is the security boundary for the whole feature: `path` arrives from a
 * query string, so "../../etc/passwd" and absolute paths must not escape the
 * archive root. Resolving and then re-checking the prefix is what enforces
 * that — a check on the raw string would miss symlinks and encoded traversal.
 */
function resolve(rel) {
  if (!ROOT || typeof rel !== 'string' || !rel) return null;
  if (rel.includes('\0')) return null;

  const abs = path.resolve(ROOT, rel);
  const prefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs !== ROOT && !abs.startsWith(prefix)) return null;

  // Only serve files the index knows about. Beyond traversal, this stops the
  // archive from turning into a general file server for whatever else is on
  // the drive.
  if (!byPath.has(rel)) return null;

  return abs;
}

function entry(rel) {
  return byPath.get(rel) || null;
}

function shape(rec) {
  return {
    path: rec.path,
    title: rec.title,
    date: rec.date,
    year: rec.year,
    tags: rec.tags,
    duration: rec.duration,
    size: rec.size,
    width: rec.width,
    height: rec.height,
    container: rec.container,
    vcodec: rec.vcodec,
    acodec: rec.acodec,
    playback: rec.playback,
  };
}

/** Immediate children of `dir`: subfolders with counts, plus files. */
function browse({ dir = '', page = 0, pageSize = 120 } = {}) {
  const node = dirs.get(dir);
  if (!node) return { dir, subdirs: [], items: [], total: 0, page, pageSize };

  const subdirs = [...node.subdirs]
    .filter((d) => (path.dirname(d) === '.' ? '' : path.dirname(d)) === dir)
    .sort((a, b) => b.localeCompare(a)) // year folders read newest-first
    .map((d) => ({
      dir: d,
      name: path.basename(d),
      count: countUnder(d),
    }));

  const start = page * pageSize;
  return {
    dir,
    subdirs,
    items: node.files.slice(start, start + pageSize).map(shape),
    total: node.files.length,
    page,
    pageSize,
  };
}

function countUnder(dir) {
  const node = dirs.get(dir);
  if (!node) return 0;
  let n = node.files.length;
  for (const sub of node.subdirs) {
    if ((path.dirname(sub) === '.' ? '' : path.dirname(sub)) === dir) n += countUnder(sub);
  }
  return n;
}

/** Substring search across every title, newest first. */
function search(q, { limit = 200 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return { items: [], total: 0 };

  const hits = [];
  for (const rec of entries) {
    if (rec.title.toLowerCase().includes(needle) || rec.path.toLowerCase().includes(needle)) {
      hits.push(rec);
    }
  }
  hits.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return a.title.localeCompare(b.title);
  });
  return { items: hits.slice(0, limit).map(shape), total: hits.length };
}

/** A flat "everything, newest first" view for the home rail. */
function recent(limit = 60) {
  return [...entries]
    .filter((e) => e.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map(shape);
}

module.exports = { configure, reload, status, resolve, entry, browse, search, recent, mounted, shape };
