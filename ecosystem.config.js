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
        // Uncomment to move downloads onto a writable partition once one
        // exists (docs/archive-drive.md, "Using the drive for downloads").
        // Copy the old downloads folder there first, then restart with
        // --update-env. Everything follows this path automatically.
        // DOWNLOADS_ROOT: '/mnt/downloads',
      },
      // The transcoder is a child process, so the portal's own memory stays
      // small; a ceiling this high only trips on a genuine leak.
      max_memory_restart: '512M',
      autorestart: true,
    },
  ],
};
