#!/usr/bin/env bash
#
# Mount the archive drive on the Pi, read-only, and check that everything the
# portal needs to play from it is present.
#
#   sudo ./scripts/setup-pi-archive.sh
#
# Read-only is not a limitation to work around here — it is the correct and
# only safe way to mount this drive. It is Journaled HFS+, and Linux's HFS+
# write support is old, barely maintained, and corrupts filesystems. Playback
# never needs to write, so the archive is mounted ro and left that way.
#
# Downloads go somewhere else entirely; see docs/archive-drive.md.

set -euo pipefail

MOUNT_POINT="${MOUNT_POINT:-/mnt/archive}"

if [[ $EUID -ne 0 ]]; then
  echo "This needs root (mount, fstab, apt). Re-run with sudo." >&2
  exit 1
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

say "1. Packages"
# hfsprogs gives us fsck.hfsplus; without it the kernel can mount the volume
# but nothing can check it. ffmpeg is what converts the ~1,760 DivX files as
# they play.
missing=()
for pkg in hfsprogs ffmpeg; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if ((${#missing[@]})); then
  echo "  installing: ${missing[*]}"
  apt-get update -qq
  apt-get install -y "${missing[@]}"
else
  ok "hfsprogs and ffmpeg already installed"
fi

say "2. HFS+ kernel support"
if modprobe hfsplus 2>/dev/null; then
  ok "hfsplus module loaded"
else
  bad "the hfsplus module is unavailable — this kernel cannot read the drive"
  echo "     Try: apt-get install --reinstall linux-image-\$(uname -r)"
  exit 1
fi

say "3. Finding the drive"
# The volume is a 2 TB Apple_HFS partition. Match on filesystem type rather
# than a device node, because /dev/sdaN depends on what else is plugged in.
DEV=""
while read -r name fstype label; do
  [[ "$fstype" == "hfsplus" ]] || continue
  DEV="/dev/$name"
  echo "  found $DEV  (label: ${label:-none})"
  break
done < <(lsblk -rno NAME,FSTYPE,LABEL)

if [[ -z "$DEV" ]]; then
  bad "no HFS+ partition found. Is the drive plugged in and powered?"
  echo "     lsblk output:"
  lsblk -o NAME,SIZE,FSTYPE,LABEL | sed 's/^/       /'
  exit 1
fi

UUID=$(blkid -s UUID -o value "$DEV" || true)
[[ -n "$UUID" ]] && ok "UUID $UUID" || bad "no UUID; will mount by device path"

say "4. Checking the filesystem"
# A drive moved off a Mac mid-write can carry a dirty journal. Checking is
# read-only and fast, and a dirty volume is worth knowing about before the
# portal starts streaming from it.
if fsck.hfsplus -q "$DEV" >/dev/null 2>&1; then
  ok "clean"
else
  bad "the volume is dirty or was not unmounted cleanly"
  echo "     Plug it back into the Mac, eject it properly, and re-run this."
  echo "     Continuing anyway — read-only mounts of a dirty volume are safe,"
  echo "     but some recent files may not be visible."
fi

say "5. Mounting at $MOUNT_POINT"
mkdir -p "$MOUNT_POINT"

# nls=utf8 is not optional: 232 filenames on this drive carry accented
# characters (toupée, Chauncé, Ménage à Trois). Without it they come back
# mangled and those files cannot be opened at all.
OPTS="ro,nls=utf8,uid=1000,gid=1000,umask=022,noauto,x-systemd.automount,x-systemd.device-timeout=30"
SRC=$([[ -n "$UUID" ]] && echo "UUID=$UUID" || echo "$DEV")
LINE="$SRC  $MOUNT_POINT  hfsplus  $OPTS  0  0"

if grep -q "[[:space:]]$MOUNT_POINT[[:space:]]" /etc/fstab; then
  ok "fstab entry already present"
else
  cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
  echo "$LINE" >> /etc/fstab
  ok "added to fstab (backup saved)"
fi

systemctl daemon-reload
mountpoint -q "$MOUNT_POINT" || mount "$MOUNT_POINT"

if mountpoint -q "$MOUNT_POINT"; then
  ok "mounted"
else
  bad "mount failed"
  exit 1
fi

say "6. Verifying"
COUNT=$(find "$MOUNT_POINT" -maxdepth 3 -type f \
          \( -iname '*.mp4' -o -iname '*.mkv' -o -iname '*.avi' \) 2>/dev/null | head -2000 | wc -l)
echo "  video files visible (first 2000): $COUNT"

# Prove the accented filenames survived the mount. If nls=utf8 were missing
# or wrong, this count would be zero while everything else still looked fine.
ACCENTED=$(find "$MOUNT_POINT" -maxdepth 3 -type f 2>/dev/null | grep -cP '[^\x00-\x7F]' || true)
if (( ACCENTED > 0 )); then
  ok "$ACCENTED files with accented names read correctly"
else
  bad "no accented filenames found — check that nls=utf8 applied"
fi

df -h "$MOUNT_POINT" | tail -1 | sed 's/^/  /'

say "Done."
cat <<EOF
  The portal reads ARCHIVE_ROOT from its environment. If you mounted somewhere
  other than /mnt/archive, update ecosystem.config.js to match, then:

    pm2 delete iptv-portal && pm2 start ecosystem.config.js && pm2 save

  Check it took:  pm2 logs iptv-portal --lines 20
  You want a line reading "Archive: 5853 files indexed ... (mounted)".
EOF
