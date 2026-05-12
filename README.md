# 🤖 Discord Multipurpose Bot

A powerful all-in-one Discord bot with moderation, welcoming, DM tools, info commands, and fun utilities.

---

## 🚀 Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Copy `.env.example` to `.env` and fill in your token:
```bash
cp .env.example .env
```

**.env contents:**
```
DISCORD_TOKEN=your_bot_token_here
PREFIX=!
```

### 3. Required Bot Permissions (Discord Developer Portal)
Enable these **Privileged Gateway Intents**:
- ✅ **Server Members Intent**
- ✅ **Message Content Intent**

Bot permissions to invite with:
- Kick Members, Ban Members, Moderate Members (timeout)
- Manage Messages, Manage Channels, Manage Guild
- Send Messages, Embed Links, Read Message History
- Add Reactions, View Channels

### 4. Start the bot
```bash
npm start
# or for development (auto-restart):
npm run dev
```

---

## 📚 Commands

### 🛡️ Moderation
| Command | Description |
|---|---|
| `!kick @user [reason]` | Kick a member |
| `!ban @user [reason]` | Ban a member |
| `!unban <userID>` | Unban a user by ID |
| `!mute @user [duration] [reason]` | Timeout a member (e.g. `10m`, `2h`, `1d`) |
| `!unmute @user` | Remove a member's timeout |
| `!warn @user <reason>` | Warn a member (also DMs them) |
| `!warnings [@user]` | View warnings for a member |
| `!clearwarnings @user` | Clear all warnings (Admin only) |
| `!slowmode <seconds>` | Set channel slowmode (0 to disable) |
| `!lock` | Lock the current channel |
| `!unlock` | Unlock the current channel |

### 🗑️ Message Management
| Command | Description |
|---|---|
| `!purge <amount>` | Delete up to 100 messages |
| `!purgeuser @user <amount>` | Delete messages from a specific user |

### 📩 DM & Announcements
| Command | Description |
|---|---|
| `!dm @user <message>` | Send a DM to a user |
| `!dmall <message>` | DM all server members (Admin only) |
| `!announce #channel <message>` | Send an announcement embed to a channel |

### 📊 Info
| Command | Description |
|---|---|
| `!userinfo [@user]` | Detailed info about a user |
| `!serverinfo` | Detailed info about the server |
| `!botinfo` | Bot stats (uptime, ping, etc.) |
| `!ping` | Check bot latency |
| `!avatar [@user]` | Get a user's full avatar |
| `!roleinfo <rolename>` | Info about a role |

### 🎉 Fun / Utility
| Command | Description |
|---|---|
| `!say <message>` | Make the bot say something |
| `!embed Title \| Description` | Send a custom embed |
| `!poll <question>` | Create a yes/no poll |
| `!roll [sides]` | Roll a dice |
| `!coinflip` | Flip a coin |

---

## 👋 Auto Welcome

The bot automatically welcomes new members in a channel named `welcome`, `general`, or `lobby`. It also logs member leaves in `logs`, `audit-log`, or `mod-log` channels if they exist.

---

## ⚠️ Notes

- Warnings are stored **in memory** and reset when the bot restarts. For persistent warnings, integrate a database like SQLite or MongoDB.
- `!dmall` may be rate-limited by Discord for large servers.
- The bot needs a **higher role** than the target member to kick/ban/mute them.
