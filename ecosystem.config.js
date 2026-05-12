// PM2 Ecosystem Config — keeps your bot running 24/7
// Usage:
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup   ← run the command it prints so bot auto-starts on reboot

module.exports = {
  apps: [
    {
      name        : 'discord-bot',       // name shown in `pm2 list`
      script      : 'index.js',
      watch       : false,               // set true only in dev (restarts on file change)
      max_restarts: 10,                  // stop restarting after 10 crashes to avoid a crash loop
      restart_delay: 5000,              // wait 5s before restarting after a crash
      exp_backoff_restart_delay: 100,   // exponential back-off so repeated crashes don't hammer Discord
      env: {
        NODE_ENV: 'production',
      },
      // Log files (inside ~/.pm2/logs/ by default, or set paths below)
      // error_file : './logs/error.log',
      // out_file   : './logs/out.log',
      // merge_logs : true,
    },
  ],
};
