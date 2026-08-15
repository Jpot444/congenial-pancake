#!/usr/bin/env node
/*
 * Walk a media root, probe every video file, and write one JSON object per
 * line to an index file.
 *
 *   node scripts/scan-library.js --root "/Volumes/Hunters Harddrive" \
 *                                --out  library-index.ndjson
 *
 * NDJSON rather than a JSON array so the run is resumable: a scan of ~6k
 * files across USB takes long enough that losing it to a disconnect is a
 * real cost. Re-running skips anything already in the output file.
 *
 * The `playback` field is the whole point of this script. It answers, per
 * file, what the portal has to do to get it on screen:
 *
 *   direct    — H.264 + AAC in mp4/mov. Serve the bytes, browser handles it.
 *   remux     — H.264, but wrong container or wrong audio. ffmpeg copies the
 *               video untouched and re-encodes only audio. ~1s startup.
 *   transcode — video codec no browser decodes (MPEG-4 ASP, AV1, MPEG-2).
 *               Needs a real re-encode; convert-library.js handles these.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.mpg', '.mpeg', '.asf', '.wmv', '.ts']);

// Containers a browser will open directly.
const NATIVE_CONTAINERS = new Set(['.mp4', '.m4v', '.mov']);
// Audio a browser will decode inside those containers.
const NATIVE_AUDIO = new Set(['aac', 'mp4a', 'alac']);
// Video every current browser decodes. H.264 is the only safe universal.
const NATIVE_VIDEO = new Set(['h264']);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1];
  }
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    // Skip dotfiles: .Trashes, .Spotlight-V100, and the .getxfer.* turds
    // left behind by interrupted MEGA transfers.
    if (e.name.startsWith('.')) continue;
    // A parking spot for source files that have been superseded by a
    // converted version. Kept on the drive, kept out of the portal, so
    // replacing a file never means deleting the original.
    if (e.name === '_originals') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

function ffprobe(file) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,bit_rate',
      '-of', 'json',
      file,
    ];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try { resolve(JSON.parse(buf)); } catch { resolve(null); }
    });
  });
}

/*
 * Filenames on this drive are overwhelmingly:
 *   "1994.06.20 Eric Roberts (E!).avi"
 *   "2009.08.12 Howard doesn't hate Gange (720p) (HTV).mkv"
 * Pull the date and the trailing source tag out so the UI can sort and group
 * without the user reading raw filenames. Anything that doesn't match keeps
 * its basename as the title, which is the honest fallback.
 */
function parseName(base) {
  const stem = base.replace(/\.[^.]+$/, '');

  let date = null;
  let year = null;
  let rest = stem;

  /* Dates on this drive are mostly YYYY.MM.DD, but a good few files cover more
   * than one broadcast and stack the extra dates on with +, -, & or commas:
   *   1994.07.22+07.25+08.17 Freds Bachelor Party
   *   1995.01.27+02-10 Ralph Loses Superbowl Bet
   * The first date is the one worth sorting on, so take it and let the rest
   * fall into the title where it still reads correctly. Some are vaguer still
   * — 1994.xx.xx, or just a year — and those get a year with no exact date. */
  let m = /^(\d{4})\.(\d{2})\.(\d{2})(?:[+\-,&]\S*)*\s+(.*)$/.exec(stem);
  if (m) {
    date = `${m[1]}-${m[2]}-${m[3]}`;
    year = Number(m[1]);
    // The extra fragments are dropped rather than pushed into the title: a
    // title reading "29 Dance Party" is worse than one reading "Dance Party",
    // and the date column already carries the day this is filed under.
    rest = m[4];
  } else if ((m = /^(\d{4})\.(\d{2})\s+(.*)$/.exec(stem))) {
    date = `${m[1]}-${m[2]}-01`;
    year = Number(m[1]);
    rest = m[3];
  } else if ((m = /^(\d{4})(?:\.(?:xx|XX|\d{2}))*[.\s]+(.*)$/.exec(stem))) {
    // 1994.xx.xx — the year is known, the day never was.
    year = Number(m[1]);
    rest = m[2];
  } else if ((m = /^(\d{4})\s+(.*)$/.exec(stem))) {
    year = Number(m[1]);
    rest = m[2];
  }

  const tags = [];
  rest = rest.replace(/\s*\(([^)]+)\)\s*$/g, (_, t) => { tags.unshift(t); return ''; }).trim();
  // A second trailing tag, e.g. "... (720p) (HTV)".
  rest = rest.replace(/\s*\(([^)]+)\)\s*$/g, (_, t) => { tags.unshift(t); return ''; }).trim();

  return {
    title: rest || stem,
    date,
    year: year || (date ? Number(date.slice(0, 4)) : null),
    tags,
  };
}

function classify(ext, vcodec, acodec) {
  if (!NATIVE_VIDEO.has(vcodec)) return 'transcode';
  if (!NATIVE_CONTAINERS.has(ext)) return 'remux';
  if (!NATIVE_AUDIO.has(acodec)) return 'remux';
  return 'direct';
}

async function main() {
  const args = parseArgs(process.argv);
  const root = args.root;
  const out = args.out || 'library-index.ndjson';
  const concurrency = Number(args.concurrency || 6);

  /* Re-derive titles and dates from filenames already in the index, without
   * touching the drive. The probe is the expensive half of a scan and codecs
   * don't change; filename parsing gets refined as odd naming turns up. */
  if ('reparse' in args) {
    if (!fs.existsSync(out)) {
      console.error(`scan-library: no index at ${out}`);
      process.exit(1);
    }
    const lines = fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.trim());
    let changed = 0;
    const rewritten = lines.map((line) => {
      const rec = JSON.parse(line);
      const parsed = parseName(path.basename(rec.path));
      if (rec.title !== parsed.title || rec.date !== parsed.date || rec.year !== parsed.year) {
        changed++;
      }
      return JSON.stringify({ ...rec, ...parsed });
    });
    fs.writeFileSync(out, rewritten.join('\n') + '\n');
    process.stderr.write(`scan-library: reparsed ${rewritten.length} records, ${changed} changed\n`);
    return;
  }

  if (!root || !fs.existsSync(root)) {
    console.error('scan-library: --root must be an existing directory');
    process.exit(1);
  }

  // Resume: anything already indexed is skipped.
  const done = new Set();
  if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).path); } catch { /* torn last line */ }
    }
  }

  process.stderr.write(`scan-library: walking ${root}\n`);
  const files = walk(root);
  const todo = files.filter((f) => !done.has(path.relative(root, f)));
  process.stderr.write(
    `scan-library: ${files.length} video files, ${done.size} already indexed, ${todo.length} to probe\n`
  );

  const sink = fs.createWriteStream(out, { flags: 'a' });
  let i = 0;
  let n = 0;

  async function worker() {
    while (i < todo.length) {
      const file = todo[i++];
      const rel = path.relative(root, file);
      const ext = path.extname(file).toLowerCase();

      let stat;
      try { stat = fs.statSync(file); } catch { continue; }

      const probed = await ffprobe(file);
      const streams = (probed && probed.streams) || [];
      const v = streams.find((s) => s.codec_type === 'video') || {};
      const a = streams.find((s) => s.codec_type === 'audio') || {};
      const duration = Number((probed && probed.format && probed.format.duration) || 0);

      const rec = {
        path: rel,
        dir: path.dirname(rel),
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
        container: ext.slice(1),
        vcodec: v.codec_name || null,
        acodec: a.codec_name || null,
        width: v.width || null,
        height: v.height || null,
        duration: Number.isFinite(duration) ? Math.round(duration) : 0,
        probeFailed: !probed,
        ...parseName(path.basename(file)),
      };
      rec.playback = rec.probeFailed ? 'unknown' : classify(ext, rec.vcodec, rec.acodec);

      sink.write(JSON.stringify(rec) + '\n');

      if (++n % 100 === 0) process.stderr.write(`scan-library: ${n}/${todo.length}\n`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  await new Promise((r) => sink.end(r));

  /* Drop entries whose files are no longer on the drive. Without this the
   * index only ever grows: a file that gets renamed, moved to _originals or
   * deleted keeps its record and shows up in the portal as a title that
   * errors when you click it. */
  const live = new Set(files.map((f) => path.relative(root, f)));
  const kept = [];
  let dropped = 0;
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (live.has(rec.path)) kept.push(line);
    else dropped++;
  }
  if (dropped) {
    fs.writeFileSync(out, kept.join('\n') + '\n');
    process.stderr.write(`scan-library: dropped ${dropped} stale record(s)\n`);
  }

  process.stderr.write(`scan-library: done, ${n} newly indexed\n`);
}

main();
