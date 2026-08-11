#!/usr/bin/env bash
#
# Run exactly what startRemux() hands ffmpeg for a live channel, with the
# verbosity turned up — so a conversion that fails silently inside the server
# fails visibly here, with ffmpeg's own reasons attached.
#
# The server runs ffmpeg at -v error and swallows everything else, which is
# right in production and useless when a conversion produces nothing at all.
#
#   bash scripts/live-remux-test.sh 1820474
#
# Run it on the Pi: it reads config.json for the provider credentials, and
# they never reach the terminal.

set -uo pipefail

STREAM_ID="${1:-}"
if [ -z "$STREAM_ID" ]; then
  echo "usage: $0 <live stream id>" >&2
  echo "  the id is in the channel's console line: [play] live id=1820474 ..." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [ ! -f config.json ]; then
  echo "no config.json here — run this from the deployed copy on the Pi" >&2
  exit 1
fi

# Built in node so the URL is assembled the same way buildStreamUrl() does it.
# Kept in a variable: it carries the account's username and password.
URL=$(node -e '
  const c = require("./config.json");
  let base = String(c.host || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = "http://" + base;
  const user = encodeURIComponent(c.username);
  const pass = encodeURIComponent(c.password);
  const ext = c.preferredFormat || "m3u8";
  console.log(`${base}/live/${user}/${pass}/${process.argv[1]}.${ext}`);
' "$STREAM_ID")

OUT="/tmp/live-remux-test"
rm -rf "$OUT"
mkdir -p "$OUT"

# Matches UA in server.js.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

echo "stream id : ${STREAM_ID}"
echo "host      : $(printf '%s' "$URL" | sed -E 's#(https?://[^/]+)/.*#\1#')"
echo "output    : ${OUT}"
echo "running ffmpeg for up to 70s — segments should appear within a few seconds"
echo

# Every flag below is what ffmpegArgs() produces for a live source with no
# codec hints, except -v info in place of -v error.
timeout 70 ffmpeg -hide_banner -v info -stats -y \
  -user_agent "$UA" \
  -reconnect 1 \
  -reconnect_streamed 1 \
  -reconnect_at_eof 1 \
  -reconnect_on_network_error 1 \
  -reconnect_on_http_error 4xx,5xx \
  -reconnect_delay_max 2 \
  -rw_timeout 15000000 \
  -i "$URL" \
  -avoid_negative_ts make_zero \
  -map 0:v:0 \
  -map '0:a:0?' \
  -c:v copy \
  -c:a aac -ac 2 -b:a 160k -af 'aresample=async=1' \
  -hls_segment_filename "${OUT}/seg%05d.ts" \
  -f hls \
  -hls_time 6 \
  -hls_list_size 10 \
  -hls_flags independent_segments+delete_segments \
  "${OUT}/index.m3u8" 2>&1 | tail -40

echo
echo "--- what landed in ${OUT} ---"
ls -la "$OUT" 2>/dev/null || echo "(directory is gone)"

if [ -f "${OUT}/index.m3u8" ]; then
  echo
  echo "--- index.m3u8 ---"
  cat "${OUT}/index.m3u8"
else
  echo
  echo "No index.m3u8 was written. startRemux() waits for that file and for a"
  echo "segment inside it, so this is precisely the case that times out."
fi
