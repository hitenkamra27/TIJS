# 🚀 Hosting Your Discord Bot 24/7

Three options, from easiest to most control:

---

## Option 1 — VPS / Your Own Server (Best, Cheapest Long-Term)

Providers: **DigitalOcean** ($4/mo), **Hetzner** (~€4/mo), **Contabo** (~$5/mo), **Oracle Cloud** (free forever tier available)

### Steps

```bash
# 1. SSH into your server
ssh root@YOUR_SERVER_IP

# 2. Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Upload your bot files (from your PC)
scp -r ./discord-bot root@YOUR_SERVER_IP:/home/discord-bot

# 4. Install dependencies
cd /home/discord-bot
npm install

# 5. Create your .env file
cp .env.example .env
nano .env        # fill in DISCORD_TOKEN, PREFIX, OWNER_ID

# 6. Install PM2 (keeps bot alive forever + auto-starts on reboot)
npm install -g pm2

# 7. Start the bot with PM2
pm2 start ecosystem.config.js

# 8. Save PM2 process list
pm2 save

# 9. Auto-start PM2 on server reboot (run the command it prints)
pm2 startup
```

### Useful PM2 Commands

| Command | What it does |
|---|---|
| `pm2 list` | See all running bots |
| `pm2 logs discord-bot` | View live logs |
| `pm2 restart discord-bot` | Restart the bot |
| `pm2 stop discord-bot` | Stop the bot |
| `pm2 delete discord-bot` | Remove from PM2 |
| `pm2 monit` | Live CPU/RAM monitor |

---

## Option 2 — Render.com (Free Tier, Needs Keep-Alive Ping)

> ⚠️ Render free tier sleeps after 15 min of no HTTP traffic.
> You MUST use `keep_alive.js` + UptimeRobot.

### Steps

1. **Add keep_alive to index.js** — add this as the very first line of `index.js`:
   ```js
   require('./keep_alive');
   ```

2. **Push your code to GitHub** (create a private repo)

3. **Go to [render.com](https://render.com)** → New → Web Service → connect your GitHub repo

4. **Configure:**
   - Environment: `Node`
   - Build command: `npm install`
   - Start command: `node index.js`
   - Add environment variables: `DISCORD_TOKEN`, `PREFIX`, `OWNER_ID`

5. **Set up UptimeRobot (free):**
   - Go to [uptimerobot.com](https://uptimerobot.com)
   - New Monitor → HTTP(s)
   - URL: `https://YOUR-APP-NAME.onrender.com`
   - Interval: **every 5 minutes**
   - That's it — UptimeRobot pings your bot to keep it awake

---

## Option 3 — Railway.app (Easy, Small Free Credit)

Railway gives $5/mo free credit which covers a small bot for ~500 hours/month.

### Steps

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo

2. Add environment variables in the Railway dashboard:
   - `DISCORD_TOKEN`
   - `PREFIX`  
   - `OWNER_ID`

3. Railway auto-deploys on every GitHub push. No keep_alive needed — Railway doesn't sleep.

---

## ⚡ Quick Comparison

| | VPS | Render Free | Railway |
|---|---|---|---|
| Cost | ~$4/mo | Free | Free ($5 credit) |
| Sleeps? | Never | Yes (fix with keep_alive) | No |
| Setup difficulty | Medium | Easy | Easiest |
| Recommended? | ✅ Best overall | ✅ Good for testing | ✅ Good free option |

---

## 🔒 Security Tips

- **Never commit your `.env` file** — it's already in `.gitignore`
- **Never share your `DISCORD_TOKEN`** — anyone with it controls your bot
- If your token leaks: go to [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot → **Reset Token** immediately

---

## 🔄 Status Commands Reminder

| Command | Effect |
|---|---|
| `!addstatus playing Minecraft` | Adds a status |
| `!liststatus` | Shows all statuses + current mode |
| `!removestatus 2` | Removes status #2 |
| `!clearstatus` | Removes all statuses |

**1 status** → stays permanently (no rotation)  
**2+ statuses** → rotates every 30s (set `STATUS_DELAY` in `.env` to change)
