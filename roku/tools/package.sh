#!/usr/bin/env bash
# Build the sideloadable channel zip.
#
# Roku expects manifest, source/, components/ and images/ at the *root* of the
# archive, so this zips from inside roku/ rather than from the repo root.
#
#   ./roku/tools/package.sh                 -> roku/build/portal-roku.zip
#   ./roku/tools/package.sh 192.168.1.44    -> also uploads it to that Roku
#
# Uploading needs the developer password you set when you enabled Developer
# Mode. Pass it in ROKU_DEV_PASSWORD, or you'll be prompted.

set -euo pipefail

CHANNEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$CHANNEL_DIR/build"
ZIP_PATH="$BUILD_DIR/portal-roku.zip"
ROKU_IP="${1:-}"

# Print what is actually being built. A failed "git pull" is silent by the time
# you are reading compiler output, and building a stale checkout looks exactly
# like a fix that did not work.
if command -v git > /dev/null && git -C "$CHANNEL_DIR" rev-parse --git-dir > /dev/null 2>&1; then
  echo "Building $(git -C "$CHANNEL_DIR" log -1 --format='%h %s' 2>/dev/null)"
  if ! git -C "$CHANNEL_DIR" diff --quiet 2>/dev/null; then
    echo "  (with uncommitted local changes)"
  fi
  echo
fi

echo "Checking the channel..."
python3 "$CHANNEL_DIR/tools/check.py"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

cd "$CHANNEL_DIR"
zip -r -q "$ZIP_PATH" manifest source components images

echo
echo "Built $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"

if [ -z "$ROKU_IP" ]; then
  echo "Sideload it at http://<roku-ip>  (Developer Application Installer)"
  exit 0
fi

if [ -z "${ROKU_DEV_PASSWORD:-}" ]; then
  read -r -s -p "Developer password for ${ROKU_IP}: " ROKU_DEV_PASSWORD
  echo
fi

echo "Uploading to ${ROKU_IP}..."
# The installer speaks multipart/form-data behind digest auth. Leave curl's
# "Expect: 100-continue" alone: under --digest the first request is an
# unauthenticated probe for the nonce, and the handshake is what lets curl hold
# the zip back until the 401 comes. Suppressing it pushes the whole body at an
# unauthenticated endpoint, which the Roku answers with 400.
#
# -f turns an HTTP error into a non-zero exit instead of a page of HTML.
if ! curl -f -sS --digest -u "rokudev:${ROKU_DEV_PASSWORD}" \
  -F "mysubmit=Install" \
  -F "archive=@${ZIP_PATH}" \
  -F "passwd=" \
  "http://${ROKU_IP}/plugin_install" > /dev/null; then
  echo
  echo "Upload failed. Most often that is one of:" >&2
  echo "  - wrong developer password (disable and re-enable Developer Mode to reset it)" >&2
  echo "  - Developer Mode not enabled, so nothing is listening on port 80" >&2
  echo "  - ${ROKU_IP} is not this Roku any more (check Settings > Network > About)" >&2
  echo >&2
  echo "The browser upload at http://${ROKU_IP} does the same job if this keeps failing." >&2
  exit 1
fi

echo "Installed. The channel should be launching on the TV now."
echo "Watch its console with:  nc ${ROKU_IP} 8085"
