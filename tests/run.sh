#!/usr/bin/env bash
#
# Run the portal's test suites.
#
#   ./tests/run.sh                 every suite
#   ./tests/run.sh home titles     just those (name or filename, both work)
#
#   SUITE_TIMEOUT=300 ./tests/run.sh    longer leash for a slow machine
#
# NO SUITE MAY HANG THE RUN.
#
# "the sweeps that go on for hours never finish I always have to cancel them"
#
# Every suite used to be run as a bare `node suite.js` with nothing watching
# it, so one that never exited — a browser that would not close, a box that
# never answered, a promise that never settled — stopped the sweep dead. From
# outside that is indistinguishable from a slow test, so the whole run got
# cancelled and NOTHING was learned, including from the ninety suites that had
# already passed. A hang is now a result: the suite is killed, reported as
# TIMEOUT, and the run carries on.
#
# The other half is leaked processes. Suites spawn boxes, and boxes spawn
# ffmpeg; a box killed with SIGKILL does not take its grandchildren with it,
# and those survivors hold ports the next run needs. A sweep found eleven of
# them from a single suite, and others still running twelve hours later. They
# are swept up before the run and after it — only ever under the test scratch
# directories, which nothing but these suites ever writes to.
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
# Long enough for the slowest honest suite with room to spare — the slowest
# measured is around half a minute — and short enough that a hung one costs
# the run three minutes rather than the evening.
SUITE_TIMEOUT="${SUITE_TIMEOUT:-180}"

# --- anything left over from a previous run --------------------------------
#
# Scoped to the scratch directories these suites create and nothing else: the
# pattern is the path a test box was started from, so this can only ever match
# a process one of these suites spawned.
# The shared box lives under one of these paths too, so it is spared by name:
# a pattern broad enough to catch a suite's leftovers is broad enough to shoot
# the portal every other suite is testing against.
sweep_strays() {
  local pid
  for pid in $(pgrep -f '/portal-[a-z]' 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    # Read the real argv rather than matching ps output, so this cannot match
    # itself through the pattern it is searching for.
    if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$DIR"; then
      continue
    fi
    kill -9 "$pid" 2>/dev/null
  done
  return 0
}
sweep_strays

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
# Every module the box requires at boot. A new one added to server.js has to
# be added HERE and in the handful of suites that stand up a second box of
# their own (grep the tests for 'recommend.js') — a box missing one does not
# fail loudly, it simply never answers, and the suite reports "did not come up".
cp -R "$ROOT/public" "$DIR/public"
cp "$ROOT/server.js" "$ROOT/local-library.js" "$ROOT/epg-guide.js" "$ROOT/people.js" "$ROOT/providers.js" "$ROOT/recordings.js" "$ROOT/recommend.js" "$ROOT/market.js" "$DIR/"
# Data the box reads at boot, not code — but it is required like code, and a
# box without it draws college cards with no club marks on them.
cp "$ROOT/college-teams.json" "$DIR/"
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

pass=0; fail=0; failed=(); times=()
for suite in "${SUITES[@]}"; do
  [ -f "$suite" ] || { echo "no such suite: $suite"; fail=$((fail+1)); continue; }

  # Every suite starts as Hunter, walkthroughs seen, scores on baseball.
  #
  # All of this lives on the BOX and one box is shared by every suite, so
  # anything a suite changes is still there for the next one. That was always
  # true of the profile's own settings — livehead.test.js presses the NFL
  # button, which really does save the choice, and a suite further down the
  # alphabet then drew the wrong sport and failed for a reason that had nothing
  # to do with what it was testing. Who is watching joined them when that moved
  # onto the box too: reports.test.js signs in as Dad to see what a non-owner
  # gets, and every suite after it booted as Dad.
  #
  # Set before each suite rather than once at the start, so the order they run
  # in stops mattering.
  curl -fs -o /dev/null -X PUT \
    -H 'content-type: application/json' -d '{"id":"own1"}' \
    "http://127.0.0.1:$PORT/api/profiles/current" || true
  curl -fs -o /dev/null -X PUT \
    -H 'content-type: application/json' \
    -d '{"tourDone":true,"liveTourDone":true,"reportNoticeSeen":true,"dlExplainSeen":true,"scoreSport":"mlb"}' \
    "http://127.0.0.1:$PORT/api/profiles/own1/prefs" || true

  printf '%-24s ' "$suite"
  started=$SECONDS
  # `timeout` returns 124 when it had to kill the suite. That is reported as
  # its own outcome rather than as a failing assertion, because it is a
  # different thing to go and look at: nothing was disproved, something stopped
  # answering.
  out=$(timeout "$SUITE_TIMEOUT" node "$suite" 2>&1); code=$?
  took=$(( SECONDS - started ))
  times+=("$(printf '%5ds  %s' "$took" "$suite")")
  if [ "$code" -eq 0 ]; then
    printf 'PASS  %3ds\n' "$took"; pass=$((pass+1))
  elif [ "$code" -eq 124 ]; then
    printf 'TIMEOUT after %ds\n' "$SUITE_TIMEOUT"; fail=$((fail+1)); failed+=("$suite (timed out)")
    echo "$out" | tail -4 | sed 's/^/    /'
  else
    printf 'FAIL  %3ds\n' "$took"; fail=$((fail+1)); failed+=("$suite")
    echo "$out" | grep -E '^[[:space:]]*FAIL|FAILED|Error' | head -8 | sed 's/^/    /'
  fi
  # Whatever this suite spawned and did not clean up dies here rather than
  # holding a port the next one needs.
  sweep_strays
done

echo
echo "$pass passed, $fail failed   (${SECONDS}s total)"
[ "$fail" -eq 0 ] || printf '  %s\n' "${failed[@]}"
# The five slowest, always — a sweep that is creeping towards the timeout is
# worth seeing before it starts tripping it.
echo
echo 'slowest:'
printf '%s\n' "${times[@]}" | sort -rn | head -5 | sed 's/^/  /'
exit $(( fail > 0 ))
