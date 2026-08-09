#!/usr/bin/env bash
#
# Pull whatever has been published to GitHub and restart the portal, if there
# is anything new. Meant to run every couple of minutes on the box that serves
# the portal, so a push is the only step in a deploy.
#
# The Pi has no public address — it sits behind NAT on Tailscale — so nothing
# from GitHub can reach in. It asks rather than being told.
#
# Install it under pm2, which already has a working PATH (see scripts/README.md):
#   pm2 start scripts/auto-update.sh --name iptv-updater \
#       --cron-restart "*/2 * * * *" --no-autorestart
#
# Override anything without editing this file:
#   BRANCH=main PM2_APP=iptv-portal PORT=8420 FORCE=1 ./scripts/auto-update.sh

set -euo pipefail

# Which branch is "live". Anything landing here is deployed unattended, so it
# should be the reviewed branch, not wherever work happens to be in progress.
BRANCH="${BRANCH:-main}"
PM2_APP="${PM2_APP:-iptv-portal}"
PORT="${PORT:-8420}"
# Restart even if something is playing. Off by default.
FORCE="${FORCE:-0}"

cd "$(dirname "$0")/.."
REPO_DIR="$PWD"
LOG="${LOG:-$REPO_DIR/auto-update.log}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# A slow fetch can still be running when the next tick fires. One at a time.
exec 9>"$REPO_DIR/.auto-update.lock"
flock -n 9 || exit 0

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  log "FATAL: $1 is not on PATH — see scripts/README.md"
  exit 1
}
need git
need node
need pm2

if [[ ! -d .git ]]; then
  log "FATAL: $REPO_DIR is not a git checkout — see scripts/README.md for the one-time setup"
  exit 1
fi

# A dead network shouldn't fill the log with noise every two minutes.
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  exit 0
fi

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")

if [[ "$local_sha" == "$remote_sha" ]]; then
  exit 0
fi

# Ask the portal whether anyone is mid-film. A server that is down or wedged
# fails the curl, which counts as idle — restarting that is the point.
portal_busy() {
  local body
  body=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/activity" 2>/dev/null) || return 1
  printf '%s' "$body" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try { process.exit(JSON.parse(raw).busy ? 0 : 1); } catch { process.exit(1); }
    });
  '
}

if [[ "$FORCE" != "1" ]] && portal_busy; then
  log "holding ${remote_sha:0:7} — portal in use"
  exit 0
fi

# Anything rsynced over by deploy.sh would be silently destroyed by the reset
# below. Park it in a stash instead: recoverable, and the update still lands.
if ! git diff --quiet HEAD; then
  git stash push --quiet -m "auto-update backup $(date '+%Y-%m-%d %H:%M:%S')"
  log "local edits to tracked files stashed — recover with: git stash list"
fi

# config.json, prefs.json, profiles.json, library-cache.json, downloads/ and
# hls/ are all gitignored, so none of the runtime state is in reach of this.
git reset --hard --quiet "origin/$BRANCH"
log "updated ${local_sha:0:7} -> ${remote_sha:0:7}  $(git log -1 --pretty=%s)"

pm2 restart "$PM2_APP" >/dev/null
log "restarted $PM2_APP"

# Unattended and append-only, so it needs its own ceiling.
if [[ $(wc -l <"$LOG") -gt 500 ]]; then
  tail -n 200 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
