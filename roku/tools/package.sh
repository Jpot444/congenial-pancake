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

echo "Checking the channel…"
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
  read -r -s -p "Developer password for $ROKU_IP: " ROKU_DEV_PASSWORD
  echo
fi

echo "Uploading to $ROKU_IP…"
# The installer speaks multipart/form-data and digest auth; -f turns an HTTP
# error into a non-zero exit instead of a page of HTML.
curl -f -s --digest -u "rokudev:$ROKU_DEV_PASSWORD" \
  -F "mysubmit=Install" \
  -F "archive=@$ZIP_PATH" \
  -F "passwd=" \
  "http://$ROKU_IP/plugin_install" > /dev/null

echo "Installed. The channel should be launching on the TV now."
