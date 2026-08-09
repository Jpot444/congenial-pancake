# scripts

`extract-bison.js` regenerates `public/bison.png` from the Treasure State logo
plate. Only needed if the mark itself changes.

    sips -s format png "/path/to/Treasure state_back.jpg" --out /tmp/logo.png
    node scripts/extract-bison.js /tmp/logo.png public/bison.png 0.39

The final argument is how far across the plate to look for the emblem, as a
fraction of width. 0.39 stops just before the vertical rule that divides the
bison from the wordmark; raising it pulls that rule into the crop.

## diagnose.sh

Answers the question the health panel cannot: *where* the bottleneck is when
something will not play. Run it on the Pi while the problem is happening —
everything it does is read-only.

    ./scripts/diagnose.sh

It reports whether the portal is up and in use, how many times pm2 has
restarted it, whether Tailscale has a direct path or is relaying through DERP,
the wifi signal and negotiated bitrate, how fast a real download reads and
serves over loopback, and whether the provider answers.

The loopback figure is the one that splits the problem in two. It takes the
network out entirely, so:

- **Fast over loopback but stuttering on the phone** — the link, not the box.
  Look at the relay line and the wifi signal.
- **Slow over loopback too** — the SD card or the Pi itself.

It also flags downloads still sitting in a non-MP4 container. Those are
converted while they play, which a Pi cannot always keep up with; they stall
for their own reasons and no amount of bandwidth fixes them. Re-optimize from
the Downloads tab.

## auto-update.sh

Deploys whatever is on `main` and restarts the portal, so a `git push` is the
whole deploy. Runs on the Pi every couple of minutes.

It polls rather than being pushed to. The Pi has no public address — it is
behind NAT, reachable only over Tailscale — so a GitHub webhook has nothing to
connect to. Asking every two minutes costs one request and needs no inbound
hole.

Nothing happens unless `origin/main` has moved. When it has, the script asks
`/api/activity` first and holds the update if a film is playing, a stream is
open or a download is running; it tries again on the next tick. `FORCE=1`
skips that check.

### One-time setup on the Pi

`~/iptv-portal/` is an rsync target today, with no `.git` in it — `deploy.sh`
excludes it. Turn it into a checkout:

    cd ~/iptv-portal
    tar czf ~/portal-state-backup.tgz config.json prefs.json profiles.json

    git init -b main
    git remote add origin https://github.com/Jpot444/congenial-pancake
    git fetch origin main
    git reset --hard origin/main
    git branch --set-upstream-to=origin/main main

The reset only rewrites tracked files. `config.json`, `prefs.json`,
`profiles.json`, `library-cache.json`, `downloads/` and `hls/` are all
gitignored, so the provider setup, the profiles and the saved library are never
in its reach. The backup above is belt and braces for the one destructive step.

Then schedule it:

    pm2 start scripts/auto-update.sh --name iptv-updater \
        --cron-restart "*/2 * * * *" --no-autorestart
    pm2 save

pm2 rather than cron on purpose: cron runs with a threadbare `PATH` and would
not find `node` or `pm2` itself, which is the usual reason a setup like this
looks installed and silently never runs. pm2 passes on the environment it was
started with, and `pm2 logs iptv-updater` is in the same place as everything
else. If you would rather use cron, copy a real `PATH` into the crontab:

    PATH=/usr/local/bin:/usr/bin:/bin:/home/hunter/.nvm/versions/node/v20.11.0/bin
    */2 * * * * /home/hunter/iptv-portal/scripts/auto-update.sh

### Checking on it

    tail -f ~/iptv-portal/auto-update.log

Quiet is normal — it only writes when it does something, holds an update or
hits a fault. A run that finds nothing new says nothing at all.

### Once this is on, push instead of running deploy.sh

Both still work, but they fight: `deploy.sh` rsyncs over the checkout, which
leaves the tracked files modified, and the next update has to clear them before
it can fast-forward. It stashes them rather than discarding them — `git stash
list` on the Pi, and the log says when it happened — but the change still
disappears from the running site at the next push. Use one or the other.
