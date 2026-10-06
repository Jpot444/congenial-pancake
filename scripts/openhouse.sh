#!/usr/bin/env bash
#
# Open the front door for a while, from a phone.
#
#   ./scripts/openhouse.sh                 how things stand
#   ./scripts/openhouse.sh on              open it for 4 hours
#   ./scripts/openhouse.sh on 2            open it for 2 hours
#   ./scripts/openhouse.sh off             shut it now
#   ./scripts/openhouse.sh apps            list the Access applications
#
# "could we use something in treasuretermius if needed?"
#
# Yes — this is that. It talks to the portal on this box rather than to
# Cloudflare, so there is ONE place that knows how to open the door, one place
# that writes the deadline down, and one place that closes it again. A script
# that called Cloudflare directly would be a second way in that the box knew
# nothing about, and the box is the thing that remembers to shut it.
#
# Everything it needs is already in config.json. Nothing is passed on the
# command line, so an API token never lands in a shell history.
set -uo pipefail

PORT="${PORT:-8420}"
HOST="${HOST:-127.0.0.1}"
BASE="http://$HOST:$PORT"

# The owner profile, which is the only one allowed to do this. Read from the
# box rather than hardcoded: these ids are per-installation.
owner() {
  curl -fsS "$BASE/api/profiles" 2>/dev/null \
    | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        try {
          const data = JSON.parse(raw);
          const list = data.profiles || [];
          /* The box decides who the owner is; this only has to find them, and
             the first profile is the owner on every box this ships to. */
          const me = list.find((p) => (p.name || "").toLowerCase() === "hunter") || list[0];
          process.stdout.write(me ? me.id : "");
        } catch { process.stdout.write(""); }
      });
    ' 2>/dev/null
}

say() { printf '  %s\n' "$*"; }

ID="$(owner)"
if [ -z "$ID" ]; then
  say "Could not reach the portal on $BASE — is it running? (pm2 list)"
  exit 1
fi

# Pretty-print whatever the portal answered, in words rather than JSON.
report() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let d = {};
      try { d = JSON.parse(raw); } catch { console.log("  the portal said something unreadable"); process.exit(1); }
      if (d.error) { console.log(`  ${d.error}`); process.exit(1); }
      if (d.configured === false) {
        console.log("  Cloudflare is not set up on this box yet. Open the portal →");
        console.log("  health panel → Front door → Cloudflare setup, and add the token there.");
        process.exit(1);
      }
      if (d.open) {
        const left = d.until ? Math.round((d.until - Date.now()) / 60000) : null;
        console.log(left !== null
          ? `  OPEN — anyone with the address is in. ${left} minute(s) left.`
          : "  OPEN — and with no deadline, which should not happen. Run: openhouse.sh off");
      } else {
        console.log("  SHUT — the Cloudflare login is in front of it, as usual.");
      }
    });
  '
}

case "${1:-status}" in
  on)
    HOURS="${2:-4}"
    say "opening for ${HOURS}h…"
    curl -sS -X POST -H 'content-type: application/json' \
      -d "{\"hours\":$HOURS}" \
      "$BASE/api/openhouse?profileId=$ID" | report
    ;;
  off)
    say "shutting it…"
    curl -sS -X DELETE "$BASE/api/openhouse?profileId=$ID" | report
    ;;
  apps)
    curl -sS "$BASE/api/cloudflare/apps?profileId=$ID" \
      | node -e '
        let raw = "";
        process.stdin.on("data", (c) => (raw += c));
        process.stdin.on("end", () => {
          let d = {};
          try { d = JSON.parse(raw); } catch { console.log("  unreadable answer"); return; }
          if (d.error) { console.log(`  ${d.error}`); return; }
          for (const a of d.apps || []) console.log(`  ${a.id}  ${a.domain}  ${a.name}`);
          if (!(d.apps || []).length) console.log("  no Access applications on that account");
        });
      '
    ;;
  status|"")
    curl -sS "$BASE/api/openhouse?profileId=$ID" | report
    ;;
  *)
    say "usage: openhouse.sh [status|on [hours]|off|apps]"
    exit 1
    ;;
esac
