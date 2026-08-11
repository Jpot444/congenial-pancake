#!/usr/bin/env bash
#
# Push this codebase to the Pi and restart it.
#
#   ./deploy.sh
#
# Everything the Pi generates at runtime stays put — config, prefs, the
# download library, the remux scratch dir and the cached catalogue are all
# excluded, so a deploy never clobbers state that only exists over there.
#
# Override the target without editing this file:
#   DEPLOY_HOST=100.68.175.115 ./deploy.sh

set -euo pipefail

REMOTE_USER="${DEPLOY_USER:-hunter}"
REMOTE_HOST="${DEPLOY_HOST:-192.168.1.18}"
REMOTE_DIR="${DEPLOY_DIR:-~/iptv-portal/}"
PM2_APP="${PM2_APP:-iptv-portal}"

# Run from the script's own directory so the trailing-slash source below is
# always this project, whatever directory the command was invoked from.
cd "$(dirname "$0")"

if [[ ! -f server.js || ! -d public ]]; then
  echo "deploy.sh: this doesn't look like the iptv-portal project root" >&2
  exit 1
fi

echo "→ syncing to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"

# The trailing slash on './' copies the *contents* of this directory into
# REMOTE_DIR. Dropping it would nest the project one level deeper.
rsync -avz --human-readable \
  --exclude 'config.json' \
  --exclude 'prefs.json' \
  --exclude 'profiles.json' \
  --exclude 'index.json' \
  --exclude 'library-cache.json' \
  --exclude 'downloads/' \
  --exclude 'hls/' \
  --exclude 'roku/build/' \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.DS_Store' \
  ./ "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"

echo "→ restarting ${PM2_APP}"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "pm2 restart ${PM2_APP}"

echo "✓ deployed to ${REMOTE_HOST}"
