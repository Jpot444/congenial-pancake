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
# How long a busy box may defer an update before it is applied regardless.
HOLD_LIMIT="${HOLD_LIMIT:-1800}"

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

BLOCKED_FLAG="$REPO_DIR/.auto-update-blocked"

# A dead network is transient and shouldn't fill the log every two minutes. An
# authentication failure is not — the repo went private, a token expired, a
# deploy key was removed — and swallowing it the same way stops updates for
# good while everything still looks fine. Say so once, then stay quiet until it
# recovers.
if ! fetch_err=$(git fetch --quiet origin "$BRANCH" 2>&1); then
  if printf '%s' "$fetch_err" |
       grep -qiE 'authentication|could not read username|repository not found|403|permission denied'; then
    if [[ ! -f "$BLOCKED_FLAG" ]]; then
      log "BLOCKED: $(printf '%s' "$fetch_err" | tr '\n' ' ' | cut -c1-160)"
      log "BLOCKED: updates have stopped until this is fixed — see scripts/README.md"
      : >"$BLOCKED_FLAG"
    fi
  fi
  exit 0
fi
rm -f "$BLOCKED_FLAG"

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

HELD_FLAG="$REPO_DIR/.auto-update-held"

# Deferring exists to avoid cutting off a film, not to defer for ever. Any busy
# signal that stops clearing — a download wedged in `downloading`, a stream
# count that never comes back down — would otherwise stall every deploy
# silently and indefinitely, which is exactly what it did. Hold, but only up to
# a limit, then go anyway.
if [[ "$FORCE" != "1" ]] && portal_busy; then
  now=$(date +%s)
  since=$(cat "$HELD_FLAG" 2>/dev/null || true)

  if [[ -z "${since:-}" ]]; then
    printf '%s' "$now" >"$HELD_FLAG"
    # Logged once, not every couple of minutes for as long as it lasts.
    log "holding ${remote_sha:0:7} — portal in use"
    exit 0
  fi

  if (( now - since < HOLD_LIMIT )); then
    exit 0
  fi

  log "held ${remote_sha:0:7} for $(( (now - since) / 60 ))m — applying anyway"
fi
rm -f "$HELD_FLAG"

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
