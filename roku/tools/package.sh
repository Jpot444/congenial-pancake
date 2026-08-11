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
zip -r -q "$ZIP_PATH" manifest source components images fonts

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
# -f turns a genuine HTTP error into a non-zero exit instead of a page of HTML.
RESPONSE="$(mktemp)"
trap 'rm -f "${RESPONSE}"' EXIT

if ! curl -f -sS --digest -u "rokudev:${ROKU_DEV_PASSWORD}" \
  -F "mysubmit=Install" \
  -F "archive=@${ZIP_PATH}" \
  -F "passwd=" \
  "http://${ROKU_IP}/plugin_install" -o "${RESPONSE}"; then
  echo
  echo "Upload failed. Most often that is one of:" >&2
  echo "  - wrong developer password (disable and re-enable Developer Mode to reset it)" >&2
  echo "  - Developer Mode not enabled, so nothing is listening on port 80" >&2
  echo "  - ${ROKU_IP} is not this Roku any more (check Settings > Network > About)" >&2
  echo >&2
  echo "The browser upload at http://${ROKU_IP} does the same job if this keeps failing." >&2
  exit 1
fi

# A 200 here does not mean the channel installed. The Roku answers 200 whether
# it accepted the package or rejected it, and puts the verdict — including the
# compiler's errors — in the HTML body. Reading that is the difference between
# "Installed." and knowing which line failed to compile.
if ! python3 - "${RESPONSE}" <<'PY'
import html, re, sys

raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
text = re.sub(r"<(script|style).*?</\1>", " ", raw, flags=re.S | re.I)
text = html.unescape(re.sub(r"<[^>]+>", "\n", text))

lines, seen = [], set()
for line in (l.strip() for l in text.splitlines()):
    if not line or line in seen:
        continue
    if re.search(r"install|success|fail|error|compil|identical|received", line, re.I):
        seen.add(line)
        lines.append(line)

verdict = " ".join(lines).lower()
failed = re.search(r"failure|failed|error", verdict) is not None
passed = re.search(r"success|identical", verdict) is not None

for line in lines:
    print("  " + line)

if failed or not passed:
    print()
    print("The Roku did NOT install this build.", file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

echo
echo "Installed. The channel should be launching on the TV now."
echo "Watch its console with:  nc ${ROKU_IP} 8085"
