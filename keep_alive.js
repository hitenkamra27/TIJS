// keep_alive.js — Tiny HTTP server that prevents free-tier hosts from sleeping
//
// Free hosting platforms (Render free tier, Replit, etc.) shut your process
// down after ~15 minutes of no incoming HTTP traffic.
// This file starts a lightweight web server on port 3000 so an external
// uptime monitor (UptimeRobot, BetterUptime, etc.) can ping it every 5 minutes
// to keep the bot alive.
//
// HOW TO USE:
//   1. Add  require('./keep_alive');  at the TOP of index.js  (before anything else)
//   2. Deploy to your host
//   3. Go to https://uptimerobot.com (free), create a Monitor → HTTP(s)
//      URL: https://<your-app-name>.onrender.com  (or whatever your host gives you)
//      Interval: every 5 minutes
//   4. That's it — UptimeRobot will ping your bot and keep it awake 24/7
//
// NOTE: If you're running on a VPS (DigitalOcean, AWS, etc.) or using PM2
// you do NOT need this file — PM2 keeps the process alive by itself.

const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive!');
});

server.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

module.exports = server;
