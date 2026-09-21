#!/usr/bin/env bash
#
# Bring the portal back after a reboot, from cron, with no root anywhere.
#
#   @reboot /home/hunter/iptv-portal/scripts/boot-resurrect.sh >> ~/.iptv-boot.log 2>&1
#
# WHY THIS EXISTS ALONGSIDE `pm2 startup`.
#
# `pm2 startup` is the proper answer and it installs a systemd unit — which
# needs root. It does not even install the unit itself; it PRINTS a sudo line
# for a person to run. So the box cannot make itself survive a reboot, and the
# health panel could only ever nag:
#
#   Survives a reboot
#   NO — it would stay down
#   pm2 has no boot service (`pm2 startup`) — run scripts/ensure-boot.sh on the Pi
#
# Which is a true sentence that requires an SSH session to act on, and the
# reboot it is warning about is exactly the event nobody is watching for.
#
# A user crontab needs no privilege at all. `@reboot` fires once when cron
# starts, running as the user who owns the entry, which is the user that owns
# the portal. That is all "survives a reboot" actually requires.
#
# CRON'S ENVIRONMENT IS THE WHOLE DIFFICULTY. It gets a threadbare PATH, no
# nvm, no profile, and no PM2_HOME — and pm2 keyed by the wrong PM2_HOME is a
# pm2 that cannot see the saved list, which fails in the least obvious way
# available: it reports success and resurrects nothing. So everything this
# needs is established here rather than inherited.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# The user's own home, not whatever cron thinks: HOME is usually set, but a
# crontab installed by one path and run by another has surprised people.
export HOME="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
export PM2_HOME="${PM2_HOME:-$HOME/.pm2}"

# Somewhere to find pm2 and node. The first four are where a system or distro
# install lands; the globs are nvm and n, which is how pm2 usually arrives on
# a Pi and is precisely what cron's PATH is missing.
for dir in /usr/local/bin /usr/bin /bin /usr/local/sbin \
  "$HOME/.npm-global/bin" "$HOME/.local/bin" \
  "$HOME"/.nvm/versions/node/*/bin /usr/local/n/versions/node/*/bin; do
  [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH

say() { printf '[%s] %s\n' "$(date -Is)" "$*"; }

say "boot-resurrect starting (PATH=$PATH, PM2_HOME=$PM2_HOME)"

if ! command -v pm2 >/dev/null 2>&1; then
  say "FAIL pm2 is not on PATH — nothing can be resurrected"
  say "     add its directory to the loop at the top of this script"
  exit 1
fi

# Cron fires @reboot the moment cron starts, which on a Pi can be before the
# network, the clock, or the archive mount. The portal copes with a missing
# mount, but starting into a box that is still assembling itself is how a
# first attempt fails and then nothing tries again.
sleep "${BOOT_DELAY:-20}"

# --- 1. the saved list ----------------------------------------------------
say "resurrecting the saved process list"
pm2 resurrect || say "resurrect did not succeed — falling back to the file"

# --- 2. and whether that actually produced the portal ---------------------
#
# Checked rather than assumed. `pm2 resurrect` exits 0 on a dump that does not
# contain the portal, and a script that trusted it would report a healthy boot
# into a log nobody reads while the box sat there empty — which is the fault
# this whole file exists to end.
if pm2 describe iptv-portal >/dev/null 2>&1; then
  say "ok   iptv-portal is running"
else
  say "iptv-portal is not running — starting it from ecosystem.config.js"
  pm2 startOrRestart "$ROOT/ecosystem.config.js" --update-env \
    || say "FAIL could not start the portal from ecosystem.config.js"
fi

# The updater is what pulls main, so a box that comes back without it comes
# back frozen at whatever it was when it went down.
if pm2 describe iptv-updater >/dev/null 2>&1; then
  say "ok   iptv-updater is running"
else
  say "iptv-updater is not running — starting it"
  pm2 start "$ROOT/scripts/auto-update.sh" --name iptv-updater \
    --cron-restart "*/2 * * * *" --no-autorestart \
    || say "FAIL could not start iptv-updater"
fi

# Whatever shape the box ended up in is the shape to come back to next time.
pm2 save >/dev/null 2>&1 || say "pm2 save failed"
say "boot-resurrect done"
