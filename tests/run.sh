#!/usr/bin/env bash
#
# Run the portal's test suites.
#
#   ./tests/run.sh                 every suite
#   ./tests/run.sh home titles     just those (name or filename, both work)
#
#   JOBS=1 ./tests/run.sh               one at a time, the old way
#   SUITE_TIMEOUT=300 ./tests/run.sh    longer leash for a slow machine
#
# THREE AT ONCE.
#
# "Why are your sweeps taking so long"
#
# A sweep was 128 suites in a single file: about 22 minutes of suites, most of
# it a browser waiting real seconds for something to animate or play, on a
# machine with four cores using one. The suites are not slow so much as
# patient, and patience parallelises.
#
# What stopped it was sharing. Two kinds of suite, and they share differently:
#
#   SHARED-BOX suites drive a browser against one portal this script starts.
#   They are safe side by side as long as each LANE has a portal of its own:
#   lane N starts its box on its own port out of its own directory, and every
#   suite reads which one from PORTAL_PORT (falling back to 8481, so running
#   one by hand is unchanged).
#
#   OWN-BOX suites stand up boxes of their own on fixed ports — and those
#   ports overlap: 8487 is three different suites' box, 8488 four. Giving each
#   one a unique port would mean editing thirty suites and keeping them apart
#   for ever after. Instead they all run in lane 0, one after another, exactly
#   as before. Nothing else ever listens on those ports, so nothing collides.
#   An own-box suite is any that calls listen(), spawn(), fork() or
#   createServer() — see OWN_BOX below.
#
# Lane 0 starts on the own-box suites (they include the slowest), and every
# lane takes shared-box suites from one queue whenever it is free, so the
# lanes finish together rather than one of them carrying the tail.
#
# NO SUITE MAY HANG THE RUN.
#
# "the sweeps that go on for hours never finish I always have to cancel them"
#
# A hang is a result: the suite is killed after SUITE_TIMEOUT, reported as
# TIMEOUT, and the run carries on. Leaked processes — boxes killed with SIGKILL
# leave their ffmpeg behind — are swept up before the run, after each own-box
# suite, and after the run, only ever under the test scratch directories,
# which nothing but these suites writes to.
#
# Nothing here touches the live box or its data.
#
# Needs playwright with chromium:
#   npm install --no-save playwright && npx playwright install chromium
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BASE_PORT="${PORT:-8481}"
BASE_DIR="${TEST_DIR:-${TMPDIR:-/tmp}/portal-test}"
JOBS="${JOBS:-3}"
[ "$JOBS" -ge 1 ] 2>/dev/null || JOBS=1
# Long enough for the slowest honest suite with room to spare, and short
# enough that a hung one costs the run three minutes rather than the evening.
SUITE_TIMEOUT="${SUITE_TIMEOUT:-180}"

# Lane N's portal: lane 0 is the one every suite has always known (8481 out of
# portal-test), the rest step up by a hundred, clear of every fixed port a
# suite uses (8473-8494, 9000s).
lane_port() { echo $(( BASE_PORT + 100 * $1 )); }
lane_dir() { if [ "$1" -eq 0 ]; then echo "$BASE_DIR"; else echo "$BASE_DIR-lane$1"; fi; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-tests.XXXXXX")"
LOCK="$WORK/lock"
: >"$LOCK"
RESULTS="$WORK/results"
: >"$RESULTS"

# --- anything left over from a previous run --------------------------------
#
# Scoped to the scratch directories these suites create. Every lane's box
# lives under BASE_DIR (portal-test, portal-test-lane1, …) and is spared by
# that prefix: a pattern broad enough to catch a suite's leftovers is broad
# enough to shoot the portals the other lanes are testing against. Matched on
# the command line AND the working directory, because a box started as
# `node server.js` from its own directory carries its path in only the second.
sweep_strays() {
  local pid where
  for pid in $(pgrep -f '/portal-[a-z]' 2>/dev/null) $(pgrep -x node 2>/dev/null) $(pgrep -x ffmpeg 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    where="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) $(readlink "/proc/$pid/cwd" 2>/dev/null)"
    case "$where" in *"/portal-"[a-z]*) ;; *) continue ;; esac
    case "$where" in *"$BASE_DIR"*) continue ;; esac
    kill -9 "$pid" 2>/dev/null
  done
  return 0
}
sweep_strays

# --- the portals to test against -------------------------------------------
#
# Every module the box requires at boot. A new one added to server.js has to
# be added HERE and in the suites that stand up a box of their own (grep the
# tests for 'recommend.js') — a box missing one does not fail loudly, it
# simply never answers, and the suite reports "did not come up".
start_box() {
  local port="$1" dir="$2"
  if curl -fs -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
    echo "something is already serving on port $port."
    echo "Stop it, or run with a different one:  PORT=8499 ./tests/run.sh"
    return 1
  fi
  rm -rf "$dir"
  mkdir -p "$dir/downloads"
  cp -R "$ROOT/public" "$dir/public"
  cp "$ROOT/server.js" "$ROOT/local-library.js" "$ROOT/epg-guide.js" "$ROOT/people.js" \
     "$ROOT/providers.js" "$ROOT/recordings.js" "$ROOT/recommend.js" "$ROOT/cloudflare.js" "$dir/"
  # Data the box reads at boot, not code — but it is required like code, and a
  # box without it draws college cards with no club marks on them.
  cp "$ROOT/college-teams.json" "$dir/"
  [ -f "$ROOT/library-index.ndjson" ] && cp "$ROOT/library-index.ndjson" "$dir/"
  # An m3u pointed at nothing: every suite stubs the library calls it needs,
  # and a real provider here would make them slow and non-deterministic.
  cat >"$dir/config.json" <<'JSON'
{ "mode": "m3u", "playlistUrl": "http://127.0.0.1:9/none.m3u",
  "host": "", "username": "", "password": "" }
JSON
  cat >"$dir/profiles.json" <<'JSON'
{ "profiles": [ { "id": "own1", "name": "Hunter", "emoji": "", "color": "",
  "prefs": {}, "history": [] } ] }
JSON
  PORT="$port" HOST=127.0.0.1 node "$dir/server.js" >"$dir/server.log" 2>&1 &
  echo $! >"$WORK/box-$port.pid"
  for _ in $(seq 1 40); do
    curl -fs -o /dev/null "http://127.0.0.1:$port/" && return 0
    sleep 0.25
  done
  echo "the test portal on $port did not come up — see $dir/server.log"
  tail -20 "$dir/server.log"
  return 1
}

stop_boxes() {
  local f
  for f in "$WORK"/box-*.pid; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
  done
}
trap 'stop_boxes; rm -rf "$WORK"' EXIT

# --- which suites ------------------------------------------------------------
cd "$ROOT/tests"
if [ "$#" -gt 0 ]; then
  SUITES=()
  for name in "$@"; do SUITES+=("${name%.test.js}.test.js"); done
else
  SUITES=(*.test.js)
fi

# A suite that stands up anything of its own on a fixed port.
OWN_BOX='\.listen\(|spawn\(|fork\(|createServer\('
: >"$WORK/own"; : >"$WORK/shared"
missing=0
for suite in "${SUITES[@]}"; do
  if [ ! -f "$suite" ]; then echo "no such suite: $suite"; missing=$((missing+1)); continue; fi
  if grep -qE "$OWN_BOX" "$suite"; then echo "$suite" >>"$WORK/own"; else echo "$suite" >>"$WORK/shared"; fi
done

# No more lanes than there are suites to share between them.
total=$(( $(wc -l <"$WORK/own") + $(wc -l <"$WORK/shared") ))
[ "$total" -lt "$JOBS" ] && JOBS=$(( total > 0 ? total : 1 ))

for lane in $(seq 0 $(( JOBS - 1 ))); do
  start_box "$(lane_port "$lane")" "$(lane_dir "$lane")" || exit 1
done

# Take the next suite off a queue, under the lock, so two lanes never get the
# same one.
pop() {
  local queue="$1" next
  exec 9>>"$LOCK"
  flock 9
  next="$(head -n 1 "$queue")"
  [ -n "$next" ] && sed -i '1d' "$queue"
  flock -u 9
  echo "$next"
}

# One suite, with its result printed in one piece so lanes do not interleave.
run_one() {
  local suite="$1" port="$2" dir="$3" out code took started line detail=''
  # Every suite starts as Hunter, walkthroughs seen, scores on baseball —
  # set before each suite rather than once, so the order they run in stops
  # mattering. All of it lives on the BOX, and a lane's box is shared by every
  # suite that lane runs: livehead.test.js really does save the NFL button,
  # reports.test.js really does sign in as Dad.
  curl -fs -o /dev/null -X PUT \
    -H 'content-type: application/json' -d '{"id":"own1"}' \
    "http://127.0.0.1:$port/api/profiles/current" || true
  curl -fs -o /dev/null -X PUT \
    -H 'content-type: application/json' \
    -d '{"tourDone":true,"liveTourDone":true,"startersDone":true,"reportNoticeSeen":true,"dlExplainSeen":true,"scoreSport":"mlb"}' \
    "http://127.0.0.1:$port/api/profiles/own1/prefs" || true
  # And the box-wide switches a suite can throw, back to how a box ships.
  curl -fs -o /dev/null -X PUT \
    -H 'content-type: application/json' -d '{"homeAutoplay":true,"lowBandwidth":false}' \
    "http://127.0.0.1:$port/api/prefs" || true

  started=$SECONDS
  # `timeout` returns 124 when it had to kill the suite — reported as its own
  # outcome, because nothing was disproved: something stopped answering.
  out=$(PORTAL_PORT="$port" TEST_DIR="$dir" timeout "$SUITE_TIMEOUT" node "$suite" 2>&1); code=$?
  took=$(( SECONDS - started ))
  if [ "$code" -eq 0 ]; then
    line="$(printf '%-24s PASS  %3ds' "$suite" "$took")"
    echo "PASS $took $suite" >>"$RESULTS"
  elif [ "$code" -eq 124 ]; then
    line="$(printf '%-24s TIMEOUT after %ds' "$suite" "$SUITE_TIMEOUT")"
    detail="$(echo "$out" | tail -4 | sed 's/^/    /')"
    echo "TIMEOUT $took $suite" >>"$RESULTS"
  else
    line="$(printf '%-24s FAIL  %3ds' "$suite" "$took")"
    detail="$(echo "$out" | grep -E '^[[:space:]]*FAIL|FAILED|Error' | head -8 | sed 's/^/    /')"
    echo "FAIL $took $suite" >>"$RESULTS"
  fi
  exec 9>>"$LOCK"
  flock 9
  echo "$line"
  [ -n "$detail" ] && echo "$detail"
  flock -u 9
}

lane() {
  local n="$1" port dir suite
  port="$(lane_port "$n")"; dir="$(lane_dir "$n")"
  if [ "$n" -eq 0 ]; then
    while suite="$(pop "$WORK/own")"; [ -n "$suite" ]; do
      run_one "$suite" "$port" "$dir"
      # Whatever an own-box suite spawned and did not clean up dies here,
      # rather than holding a port the next one needs. Only lane 0 runs
      # these, so nothing in another lane can be caught by it.
      sweep_strays
    done
  fi
  while suite="$(pop "$WORK/shared")"; [ -n "$suite" ]; do
    run_one "$suite" "$port" "$dir"
  done
}

# Waited on by pid: a bare `wait` would also wait for the boxes started above,
# which never exit.
LANES=()
for n in $(seq 0 $(( JOBS - 1 ))); do lane "$n" & LANES+=($!); done
wait "${LANES[@]}"
sweep_strays

pass=$(grep -c '^PASS ' "$RESULTS")
fail=$(( $(grep -vc '^PASS ' "$RESULTS") + missing ))
echo
echo "$pass passed, $fail failed   (${SECONDS}s total, $JOBS at once)"
if [ "$fail" -gt 0 ]; then
  grep -v '^PASS ' "$RESULTS" | awk '{print "  " $3 ($1 == "TIMEOUT" ? " (timed out)" : "")}'
fi
# The five slowest, always — a sweep that is creeping towards the timeout is
# worth seeing before it starts tripping it.
echo
echo 'slowest:'
sort -k2 -rn "$RESULTS" | head -5 | awk '{printf "  %5ds  %s\n", $2, $3}'
exit $(( fail > 0 ))
