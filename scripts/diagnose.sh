#!/usr/bin/env bash
#
# Why won't it play? Answers the one question the health panel cannot: where
# the bottleneck is between the disk, the box, the network and the provider.
#
#   ./scripts/diagnose.sh
#
# Run it on the Pi while the problem is happening. Everything is read-only.

set -uo pipefail   # deliberately not -e: a probe that fails is a result

PORT="${PORT:-8420}"
PM2_APP="${PM2_APP:-iptv-portal}"
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
line() { printf '  %-34s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }

human() {  # bytes/sec -> something readable, and a verdict
  awk -v b="${1:-0}" 'BEGIN{
    mbit = b*8/1000000;
    printf "%.1f MB/s  (%.1f Mbit/s)  %s\n", b/1048576, mbit,
      (mbit >= 12 ? "plenty" : mbit >= 6 ? "ok for 1080p" : mbit >= 3 ? "marginal — expect stalls" : "TOO SLOW")
  }'
}

say "Portal"
if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/activity" >/dev/null 2>&1; then
  line "responding on 127.0.0.1:$PORT" "yes"
  line "in use right now" "$(curl -fsS "http://127.0.0.1:$PORT/api/activity")"
else
  line "responding on 127.0.0.1:$PORT" "NO — the server is down or wedged"
fi

if have pm2; then
  # Restarts climbing while you watch means something is cutting playback off.
  pm2 jlist 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let apps = [];
      try { apps = JSON.parse(raw); } catch { return; }
      for (const a of apps) {
        const up = a.pm2_env?.pm_uptime ? Math.round((Date.now() - a.pm2_env.pm_uptime) / 1000) : 0;
        const mins = up > 90 ? `${Math.round(up / 60)}m` : `${up}s`;
        console.log(`  ${(a.name + " ").padEnd(35)}${a.pm2_env?.status}, up ${mins}, ${a.pm2_env?.restart_time ?? 0} restarts`);
      }
    });
  '
fi

say "Link to the Pi"
if have tailscale; then
  # A relayed connection goes through a public DERP server and is the single
  # most common reason video stalls while the wifi itself looks fine.
  peers=$(tailscale status 2>/dev/null | grep -v '^#' | grep -c 'relay' || true)
  line "tailscale" "$(tailscale status 2>/dev/null | head -1 | cut -c1-60)"
  if [[ "${peers:-0}" -gt 0 ]]; then
    line "RELAYED peers" "$peers — traffic is going via DERP, not direct"
    tailscale status 2>/dev/null | grep 'relay' | sed 's/^/    /'
  else
    line "relayed peers" "none — connections are direct"
  fi
else
  line "tailscale" "not on PATH"
fi

if have iw; then
  IFACE=$(iw dev 2>/dev/null | awk '/Interface/ {print $2; exit}')
  if [[ -n "${IFACE:-}" ]]; then
    line "wifi interface" "$IFACE"
    iw dev "$IFACE" link 2>/dev/null | grep -Ei 'ssid|signal|tx bitrate|rx bitrate' | sed 's/^[[:space:]]*/    /'
  else
    line "wifi" "no wireless interface — wired?"
  fi
fi

say "Serving a download over loopback"
# Loopback takes the network out of it entirely. Fast here + slow on the phone
# means the problem is the link, not the Pi or the card.
probe=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/downloads" 2>/dev/null | node -e '
  const NATIVE = new Set(["mp4", "m4v", "mov"]);
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const done = (JSON.parse(raw).items || []).filter((j) => j.status === "done");
      // Anything not already MP4 is converted while it plays, which a Pi cannot
      // always keep up with — it is its own stall, unrelated to the network.
      const stale = done.filter((j) => !NATIVE.has(String(j.ext || "").toLowerCase()));
      const pick = done.find((j) => NATIVE.has(String(j.ext || "").toLowerCase())) || done[0];
      console.log([pick ? pick.id : "", pick ? pick.name : "", done.length,
                   stale.length, stale.map((j) => j.name).slice(0, 5).join("; ")].join("\t"));
    } catch { /* no downloads */ }
  });
')
IFS=$'\t' read -r id pick_name done_count stale_count stale_names <<<"${probe:-}"

if [[ -n "${stale_count:-}" && "${stale_count:-0}" -gt 0 ]]; then
  line "NOT optimized (converts on play)" "$stale_count of $done_count"
  printf '    %s\n' "$stale_names"
  printf '    %s\n' "These stall by design — re-optimize from the Downloads tab."
elif [[ -n "${done_count:-}" ]]; then
  line "all downloads optimized" "$done_count of $done_count"
fi

if [[ -n "${id:-}" ]]; then
  line "test file" "$pick_name"
  speed=$(curl -s -o /dev/null --max-time 12 -r 0-25000000 \
          -w '%{speed_download}' "http://127.0.0.1:$PORT/api/downloads/$id/file" 2>/dev/null)
  line "read+serve speed" "$(human "${speed%%.*}")"
else
  line "test file" "no finished download to test with"
fi

say "Provider (this is what Live TV needs)"
if [[ -f config.json ]]; then
  host=$(node -e 'try{console.log((require("./config.json").host||"").replace(/\/+$/,""))}catch{}' 2>/dev/null)
  if [[ -n "${host:-}" ]]; then
    line "configured host" "$host"
    code=$(curl -s -o /dev/null --max-time 8 -w '%{http_code} in %{time_total}s' "$host" 2>/dev/null)
    line "reachable" "${code:-no answer}"
  else
    line "configured host" "could not read it from config.json"
  fi
else
  line "config.json" "missing — portal not set up?"
fi

say "What the numbers mean"
cat <<'TXT'
  Loopback fast but playback stuttering  -> the link, not the Pi. Check the
                                            relay line and the wifi signal.
  Loopback slow too                      -> the SD card or the Pi itself.
  Relayed peers listed                   -> Tailscale could not open a direct
                                            path; everything is going the long
                                            way round. Usually fixed by getting
                                            both ends off restrictive networks.
  Restart count climbing while watching  -> something is bouncing the server
                                            under you; check auto-update.log.
TXT
echo
