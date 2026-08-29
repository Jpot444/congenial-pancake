#!/usr/bin/env bash
#
# Run the portal's test suites.
#
#   ./tests/run.sh                 every suite
#   ./tests/run.sh home titles     just those (name or filename, both work)
#
# Each suite drives a real browser against a real portal, so this starts one
# on port 8481 out of a scratch directory — a throwaway config, a throwaway
# profile, no provider — and stops it again at the end. Nothing here touches
# the live box or its data.
#
# Needs playwright with chromium:
#   npm install --no-save playwright && npx playwright install chromium
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PORT="${PORT:-8481}"
DIR="${TEST_DIR:-${TMPDIR:-/tmp}/portal-test}"
# Exported because a suite or two reads the box's files directly — a report is
# only really stored if it is on disk — so they need the directory, not just
# the URL.
export TEST_DIR="$DIR"

# --- nothing else on this port --------------------------------------------
#
# A stray server left over from a previous run answers on 8481 just as
# happily as ours does, and the suites cannot tell the difference: they get a
# portal with the wrong config and report failures against a box nobody meant
# to test. Better to refuse.
if curl -fs -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  echo "something is already serving on port $PORT."
  echo "Stop it, or run with a different one:  PORT=8499 ./tests/run.sh"
  exit 1
fi

# --- a portal to test against ---------------------------------------------
rm -rf "$DIR"
mkdir -p "$DIR/downloads"
cp -R "$ROOT/public" "$DIR/public"
cp "$ROOT/server.js" "$ROOT/local-library.js" "$ROOT/epg-guide.js" "$ROOT/people.js" "$ROOT/providers.js" "$ROOT/recordings.js" "$DIR/"
[ -f "$ROOT/library-index.ndjson" ] && cp "$ROOT/library-index.ndjson" "$DIR/"

# An m3u pointed at nothing: every suite stubs the library calls it needs, and
# a real provider here would make them slow and non-deterministic.
cat >"$DIR/config.json" <<'JSON'
{ "mode": "m3u", "playlistUrl": "http://127.0.0.1:9/none.m3u",
  "host": "", "username": "", "password": "" }
JSON
cat >"$DIR/profiles.json" <<'JSON'
{ "profiles": [ { "id": "own1", "name": "Hunter", "emoji": "", "color": "",
  "prefs": {}, "history": [] } ] }
JSON

PORT="$PORT" HOST=127.0.0.1 node "$DIR/server.js" >"$DIR/server.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.25
done
if ! curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "the test portal did not come up — see $DIR/server.log"
  tail -20 "$DIR/server.log"
  exit 1
fi

# The walkthroughs, marked seen.
#
# A brand-new profile gets the one-time tour, and that overlay sits over the
# whole page — so every suite that hovers or clicks anything fails on a fresh
# box while passing on a used one, which is the worst way for a test to be
# wrong. Set through the API rather than written into profiles.json, because
# the box normalises unknown fields straight back out of that file.
curl -fs -o /dev/null -X PUT \
  -H 'content-type: application/json' \
  -d '{"tourDone":true,"liveTourDone":true,"reportNoticeSeen":true,"dlExplainSeen":true}' \
  "http://127.0.0.1:$PORT/api/profiles/own1/prefs" \
  || echo 'note: could not mark the walkthroughs seen; some suites may trip over the tour'

# --- run them --------------------------------------------------------------
cd "$ROOT/tests"
if [ "$#" -gt 0 ]; then
  SUITES=()
  for name in "$@"; do SUITES+=("${name%.test.js}.test.js"); done
else
  SUITES=(*.test.js)
fi

pass=0; fail=0; failed=()
for suite in "${SUITES[@]}"; do
  [ -f "$suite" ] || { echo "no such suite: $suite"; fail=$((fail+1)); continue; }
  printf '%-24s ' "$suite"
  if out=$(node "$suite" 2>&1); then
    echo 'PASS'; pass=$((pass+1))
  else
    echo 'FAIL'; fail=$((fail+1)); failed+=("$suite")
    echo "$out" | grep -E '^[[:space:]]*FAIL|FAILED|Error' | head -8 | sed 's/^/    /'
  fi
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || printf '  %s\n' "${failed[@]}"
exit $(( fail > 0 ))
