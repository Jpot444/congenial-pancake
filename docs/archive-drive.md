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

## The writable partition

Done, August 2026. The drive is two partitions now.

```
sda1  1.7 TB   hfs+   Hunters Harddrive   ro   /mnt/archive
sda2  275 GB   ext4   store               rw   /mnt/store
```

The archive keeps 162 GB of headroom inside it; the new partition has 272 GB
free. `DOWNLOADS_ROOT` in `ecosystem.config.js` points at
`/mnt/store/downloads`, and every space gate, the per-profile allowance and
the health panel follow it.

### How it was done

macOS is the only thing that can shrink HFS+ — Linux has read-only support and
no working `resize_hfs`, which is the same reason the archive is mounted `ro`
in the first place. So the drive came off the Pi for the resize and went back
afterwards.

1. On the Pi, with the portal stopped: `umount /mnt/archive`, then
   `systemctl stop mnt-archive.automount`. The mount is `x-systemd.automount`,
   so anything touching the path brings it straight back — including the
   portal's own health panel reading free space.

   `pm2 stop iptv-updater` does NOT hold: it carries `--cron-restart */2`, so
   it returns within two minutes and restarts the portal. It has to be
   `pm2 delete iptv-updater` for the duration, and put back afterwards.

2. On the Mac: `diskutil verifyVolume` first and do not continue past a bad
   report — a resize over a damaged catalog is the specific way this loses
   1.4 TB. Then `diskutil resizeVolume /dev/disk4s1 limits` to read the floor,
   which came back at 1.53 TB, and
   `caffeinate -i diskutil resizeVolume /dev/disk4s1 1.7T`.

   `caffeinate` because a Mac that sleeps partway through a partition-map
   rewrite is the one avoidable way to lose the drive.

3. Back on the Pi:

   ```bash
   parted -a optimal /dev/sda mkpart primary ext4 1700GB 100%
   mkfs.ext4 -m 1 -L store /dev/sda2
   ```

   `-m 1` rather than the default 5% reserved blocks: that reservation exists
   to keep a root filesystem usable when full and is worth 12 GB here.

   Mounted by UUID with `nofail`, so a drive that does not come up cannot hold
   the Pi at boot.

### What it is not, yet

`HLS_DIR` is still `<repo>/hls` and is not configurable — the live window and
every film conversion are written to the SD card. That is the largest source
of card wear on the box and the obvious next thing to move.

And there is no recording. The live DVR is a ~2 minute rolling window per
channel, deleted continuously, which exists so a viewer can pause and rewind a
little. Space makes recording possible; it does not make it exist.

