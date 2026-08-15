# The archive drive

The 2 TB WD easystore, plugged into the Pi, browsable and playable from the
portal's **Archive** tab.

## What's on it

Indexed 2026-08-15 by `scripts/scan-library.js`. 5,853 video files, 1.20 TB,
**3,203 hours** of runtime, dated 1987–2020. Zero files failed to probe.

| Folder | Files | Notes |
|---|---:|---|
| HTVOD By Year | 5,582 | Year folders, 1994–2020 |
| Howard Stern Video | 270 | E! shows, movies, specials, interviews |
| _(root)_ | 1 | |

The 3,944 MP3s in `Audio Archive` and the 1,264 PDFs in `MarksFriggin Archive`
are deliberately **not** indexed — the scanner only walks video extensions.

## How playback works

Every file falls into one of three modes, decided once at scan time and stored
in the index. The portal never guesses at play time.

| Mode | Files | What happens | Startup |
|---|---:|---|---|
| `direct` | 519 | H.264 + AAC already. The browser fetches byte ranges straight off the disk. | Immediate |
| `remux` | 3,573 | H.264, but in `.mkv` or with MP3/Opus audio. ffmpeg copies the video untouched and re-encodes only the audio. | ~1–2 s |
| `transcode` | 1,761 | MPEG-4 ASP (DivX/XviD in `.avi`), plus a few AV1 and MPEG-2. No browser decodes these, so the video is genuinely re-encoded to H.264. | ~2–4 s |

The `transcode` tier is why nothing needed converting up front. Encoding this
material is cheap: measured at **14.5× realtime on a single core** of an
M-series Mac at 640×480, which leaves a Pi 5 core around 4–6× and the whole
chip far ahead of playback. Files convert as they're watched and nothing is
stored.

The alternative — batch-converting all 1,761 files first — was rejected because
the 1,583 `.avi` files alone total **441.6 GB** against 441 GB of free space on
the drive. It could only have been done by deleting the originals.

### If you'd rather have them pre-converted

Nothing here stops that later. Converting the `transcode` tier to H.264 would
make every file `direct`, at the cost of either ~250 GB of space or the
original DivX files. Worth doing only if on-demand startup annoys you in
practice — and it should be run on the Mac, which has hardware encoding, not
on the Pi.

## Setup on the Pi

```bash
sudo ./scripts/setup-pi-archive.sh
```

Installs `hfsprogs` and `ffmpeg`, checks the filesystem, and mounts the drive
**read-only** at `/mnt/archive` with an fstab entry so it survives a reboot.

Read-only is correct, not a compromise. The drive is Journaled HFS+, and
Linux's HFS+ *write* support is old, barely maintained, and known to corrupt
filesystems. Playback never writes. Do not add `rw` to that fstab line.

Two details the script handles that are easy to get wrong by hand:

- **`nls=utf8`** — 232 filenames carry accented characters (`toupée`,
  `Chauncé`, `Ménage à Trois`). Without this they mount mangled and those files
  cannot be opened at all. The script verifies this explicitly after mounting.
- **`x-systemd.automount`** — the drive spins up slower than boot, so a plain
  fstab entry can fail the boot sequence.

Then point the portal at it, once:

```bash
pm2 delete iptv-portal && pm2 start ecosystem.config.js && pm2 save
```

`ARCHIVE_ROOT` lives in `ecosystem.config.js` because setting it by hand does
not survive the `pm2 restart` that `deploy.sh` runs on every push.

Confirm with `pm2 logs iptv-portal --lines 20`. You want:

```
Archive: 5853 files indexed at /mnt/archive (mounted) — 519 direct, 3573 remux, 1761 transcode
```

`NOT MOUNTED` there means the drive isn't visible; the Archive tab will say so
too rather than showing an empty grid.

## Using the drive for downloads

**This part is not done, and it needs a decision from you.**

The drive is read-only on the Pi, so downloads cannot go to it as things
stand. Making that work means adding a second, Linux-native partition — and
that means repartitioning a drive holding 1.4 TB of material that is, in
several cases, genuinely hard to re-source. So it's left for you to trigger.

The operation is non-destructive in principle: macOS shrinks HFS+ volumes
without touching the data, and this drive has 473 GB free at the end. But
"non-destructive in principle" and "a partition table rewrite on your only
copy" belong in the same sentence, so:

1. **Have a copy of anything irreplaceable first.** Not negotiable.
2. On the Mac, with the drive attached and `diskutil list` confirming the disk
   number is still `disk4`:

   ```bash
   diskutil resizeVolume disk4s1 1.7T
   ```

   Leaves ~300 GB of free space after the HFS+ volume, and ~170 GB of
   headroom inside it.
3. On the Pi, create and format the new partition in that free space, then
   mount it read-write and point `DOWNLOAD_DIR` at it.

If you'd rather not touch the partition table at all, the alternative is to
leave downloads on the Pi's own storage. The portal already guards against
filling the disk (`SPACE_RESERVE`, 2 GB) and the health panel shows free space,
so this is a perfectly reasonable place to stop.

## Re-scanning

The index is a snapshot. Add or remove files on the drive and it goes stale —
missing files return a clear error rather than a broken player, but new files
won't appear until you re-scan.

From the Mac, with the drive attached:

```bash
node scripts/scan-library.js --root "/Volumes/Hunters Harddrive" --out library-index.ndjson
```

Resumable: it skips anything already indexed, so an interrupted run costs
nothing. A full cold scan of 5,853 files takes roughly 25 minutes over USB.

To re-derive titles and dates from filenames without re-probing — after
improving the filename parser, for instance:

```bash
node scripts/scan-library.js --out library-index.ndjson --reparse
```

Then `./deploy.sh` to push the index to the Pi.

## Filename parsing

Titles and dates come from the filenames, which are consistent enough to parse:
`1994.06.20 Eric Roberts (E!).avi` → date `1994-06-20`, title `Eric Roberts`,
tag `E!`.

Handled: plain `YYYY.MM.DD`, multi-date forms like `1994.10.14+18` and
`1995.01.27+02-10` (first date wins, extra fragments dropped from the title),
`YYYY.MM`, `1994.xx.xx`, and bare years.

**5,739 files get an exact date, 5,764 get at least a year, 89 get neither**
and sort by title at the end of their folder. Those 89 are files whose names
never carried a date.

## Known rough edges

- `HTVOD By Year/1997`, `2007`, `2008` and `2010` each contain a *second*
  folder of the same name, so browsing them takes an extra click. The counts on
  the folder chips are recursive and correct; only the navigation is awkward.
  Fixing it means renaming folders on the drive.
- One viewer at a time. `startRemux` kills any existing session before starting
  a new one, which is the pre-existing behaviour for provider streams — the
  account allows a single connection. It applies to archive playback too, where
  the constraint doesn't technically exist. Two people on two devices will
  interrupt each other.
- Playback position is saved per profile for archive files, keyed
  `archive:<relative path>`. Rename a file on the drive and its resume point is
  orphaned.
