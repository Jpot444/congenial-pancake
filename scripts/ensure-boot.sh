#!/usr/bin/env bash
#
# Make the portal come back by itself after a reboot.
#
#   ./scripts/ensure-boot.sh
#
# WHAT WENT WRONG, so the next person does not have to work it out:
#
# The Pi rebooted and pm2 came back with an EMPTY process list. Not a crash —
# `pm2 list` printed headers and no rows — so the portal was never restarted,
# and neither was iptv-updater, which meant nothing was pulling main either.
# The box was simply absent until somebody noticed and started it by hand.
#
# pm2 restores a process list only when BOTH of these exist:
#
#   * a saved list          `pm2 save`     → ~/.pm2/dump.pm2
#   * a boot service        `pm2 startup`  → a systemd unit, enabled
#
# Miss either one and everything looks perfectly healthy right up until the
# next reboot. Nothing in the box can self-heal it either: the updater that
# would fix a bad deploy is itself a pm2 app, so when the list is gone the
# repair mechanism is gone with it.
#
# So this script is the whole fix, and it is idempotent — run it as often as
# you like. The portal's own health panel nags until it passes.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
WANT_PORTAL='iptv-portal'
WANT_UPDATER='iptv-updater'

say() { printf '\n  %s\n' "$*"; }
have() { pm2 describe "$1" >/dev/null 2>&1; }

if ! command -v pm2 >/dev/null 2>&1; then
  say "pm2 is not on PATH here. Run this as the user that owns the portal"
  echo "  (hunter), in a login shell — not from cron, which has a threadbare PATH."
  exit 1
fi

# --- 1. both apps running -------------------------------------------------
#
# startOrRestart, and through the FILE, because `pm2 restart` does not re-read
# ecosystem.config.js — it reuses the environment pm2 captured when the app was
# first started. See the note at the top of that file; it cost an afternoon.
say "making sure both apps are running"
pm2 startOrRestart "$ROOT/ecosystem.config.js" --update-env || {
  say "could not start the portal from ecosystem.config.js"
  exit 1
}

if have "$WANT_UPDATER"; then
  echo "  $WANT_UPDATER already registered"
else
  # --no-autorestart with a cron restart: this is a script that runs, does its
  # job and exits. Without it pm2 would treat every clean exit as a crash and
  # restart it in a tight loop.
  pm2 start "$ROOT/scripts/auto-update.sh" --name "$WANT_UPDATER" \
    --cron-restart "*/2 * * * *" --no-autorestart || {
    say "could not start $WANT_UPDATER"
    exit 1
  }
fi

# --- 2. the list, written down -------------------------------------------
say "saving the process list"
pm2 save || { say "pm2 save failed — a reboot would come back empty"; exit 1; }

# --- 3. the boot service -------------------------------------------------
#
# `pm2 startup` does not install anything itself: it PRINTS a sudo command for
# you to run. Unattended, that prints advice into a log nobody reads and the
# reboot problem stays exactly as it was — so the command is captured and run,
# and if that needs a password the operator is told plainly rather than the
# script claiming success.
ENABLED=0
if ls /etc/systemd/system/multi-user.target.wants 2>/dev/null | grep -q '^pm2-'; then
  ENABLED=1
fi

if [ "$ENABLED" = 1 ]; then
  say "boot service already installed"
else
  say "installing the boot service"
  CMD="$(pm2 startup systemd -u "$(id -un)" --hp "$HOME" 2>/dev/null \
    | grep -E '^\s*sudo ' | tail -1)"
  # And when it cannot be had, take the route that needs nobody's password.
  #
  # This used to exit 1 with advice, which meant the commonest outcome of
  # running this script — sudo wants a password, because nobody sets up
  # passwordless sudo on a Pi — left the box exactly as un-survivable as it
  # was, having printed a paragraph about it. A user crontab needs no
  # privilege, and `@reboot` running as the user who owns the portal is the
  # whole of what is being asked for here.
  install_cron() {
    local script="$ROOT/scripts/boot-resurrect.sh"
    if [ ! -f "$script" ]; then
      say "scripts/boot-resurrect.sh is missing from this checkout"
      return 1
    fi
    chmod +x "$script" 2>/dev/null || true
    if ! command -v crontab >/dev/null 2>&1; then
      say "no crontab on this box either — nothing here can make it survive a reboot"
      return 1
    fi
    if crontab -l 2>/dev/null | grep -qE '^[^#]*@reboot.*boot-resurrect\.sh'; then
      echo "  @reboot entry already installed"
      return 0
    fi
    # Appended, never replaced: `crontab -` overwrites the whole file, so
    # writing only our line would silently delete every other job on the box.
    { crontab -l 2>/dev/null
      echo "# Treasure Theater: bring the portal back after a reboot."
      echo "@reboot /bin/bash $script >> \$HOME/.iptv-boot.log 2>&1"
    } | crontab - || { say "crontab would not take the entry"; return 1; }
    echo "  installed an @reboot entry"
  }

  if [ -z "$CMD" ]; then
    say "pm2 would not tell us the command — using an @reboot crontab entry instead"
    install_cron || exit 1
  else
    echo "  $CMD"
    if eval "$CMD"; then
      pm2 save || true
    else
      say "that needed a password, or sudo refused — using an @reboot crontab entry instead"
      echo "  (to use the systemd unit instead, run the line above by hand, then: pm2 save)"
      install_cron || exit 1
    fi
  fi
fi

# --- 4. say whether it actually holds ------------------------------------
#
# Checked rather than assumed: every step above can report success and still
# leave a box that comes back empty, which is the whole failure being fixed.
say 'checking'
DUMP="${PM2_HOME:-$HOME/.pm2}/dump.pm2"
FAIL=0
for app in "$WANT_PORTAL" "$WANT_UPDATER"; do
  if grep -q "\"name\":\"$app\"" "$DUMP" 2>/dev/null \
    || grep -q "\"name\": *\"$app\"" "$DUMP" 2>/dev/null; then
    echo "  ok    $app is in the saved list"
  else
    echo "  FAIL  $app is NOT in the saved list"
    FAIL=1
  fi
done
# Either mechanism counts, the same way the health panel counts them. Asking
# for both would fail a box that is genuinely going to come back, and a false
# FAIL here sends somebody to fix what is not broken.
if ls /etc/systemd/system/multi-user.target.wants 2>/dev/null | grep -q '^pm2-'; then
  echo "  ok    pm2 starts at boot (systemd unit)"
elif crontab -l 2>/dev/null | grep -qE '^[^#]*@reboot.*boot-resurrect\.sh'; then
  echo "  ok    pm2 starts at boot (@reboot crontab entry)"
else
  echo "  FAIL  nothing starts pm2 at boot — a reboot comes back empty"
  FAIL=1
fi

if [ "$FAIL" = 0 ]; then
  say "this box will come back on its own after a reboot."
  echo "  The portal's health panel says so too — 'Survives a reboot: Yes'."
else
  say "NOT fixed yet. The lines marked FAIL above are what is missing."
  exit 1
fi
