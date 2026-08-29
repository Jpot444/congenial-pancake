/*
 * pm2 config for the Pi.
 *
 * The reason this file exists rather than a plain `pm2 start server.js`:
 * ARCHIVE_ROOT has to be set in the process environment, and setting it by
 * hand doesn't survive `pm2 restart` — which is exactly what deploy.sh runs
 * on every push. Keeping it here means the setting is deployed with the code.
 *
 * One-time setup on the Pi, after the first deploy that includes this file:
 *
 *   pm2 delete iptv-portal
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * After that, deploy.sh's `pm2 restart iptv-portal` keeps the env.
 */

module.exports = {
  apps: [
    {
      name: 'iptv-portal',
      script: 'server.js',
      cwd: '/home/hunter/iptv-portal',
      env: {
        PORT: '8420',
        // Bind to all interfaces so the portal is reachable from the TV and
        // phone, not just from the Pi itself.
        HOST: '0.0.0.0',
        // Where the archive drive mounts. Must match the fstab entry.
        ARCHIVE_ROOT: '/mnt/archive',
        /* Downloads live on the drive's own writable partition, not on the
           SD card. That partition was carved out of the archive drive in
           August 2026 — see docs/archive-drive.md — and everything that
           cares about space follows this one path: the allowance, the
           free-space gates, the health panel. */
        DOWNLOADS_ROOT: '/mnt/store/downloads',
        // Allowance for finished archive conversions kept on disk (GB).
        // Whatever this says, the cache always yields before the card's
        // free space floor — the setting caps the best case, it cannot
        // crowd the disk. Default 10.
        // ARCHIVE_CACHE_GB: '6',
      },
      // The transcoder is a child process, so the portal itself is mostly
      // the library catalog held in memory — and that legitimately spikes
      // past 512M during a refresh: pm2's log shows kills at 596-651M, and
      // those kills are SILENT (nothing in the app's error log), which made
      // an August 2026 outage look like a mystery crash. The box has 4GB and
      // runs nothing else, so give the portal an honest gigabyte; this
      // ceiling now only trips on a genuine runaway.
      max_memory_restart: '1G',
      autorestart: true,
    },
  ],
};
