# 🤖 Discord Persona Bot

A Discord bot powered by **Google Gemini** with a fully customizable persona, authorized-user access control, persistent chat logs, custom memories, and AI image generation. Designed for Railway deployment.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🎭 **Custom persona** | Edit `persona.json` — no code needed |
| 🔐 **Authorized-users only** | Bot only responds to Discord IDs you whitelist |
| 🧠 **Persistent chat memory** | Conversation history per channel (rolling window) |
| 📋 **Chat log** | Every message logged to `data/logs/<channelId>.jsonl` |
| 🔍 **Log search & AI Q&A** | Search logs by keyword, or ask AI questions about them |
| 💡 **Custom memories** | Add facts per-user or globally ("everyone hates Mondays") |
| 🎨 **Image generation** | `!imagine` command via Google Imagen 3 |
| ☁️ **Railway-ready** | `railway.toml` included, zero config needed |

---

## 📁 Structure
(This will be assigned automatically. Do not add them manually)
```
discord-persona-bot/
├── bot.js              Main bot
├── persona.json        Persona config (edit this)
├── package.json
├── railway.toml
├── .env.example
└── data/               Auto-created at runtime
    ├── authorized.json  Authorized user IDs
    ├── memories.json    Custom memories
    └── logs/
        └── <channelId>.jsonl  Per-channel chat logs
```

---

## 🚀 Setup

### 1. Discord Bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **Bot** tab → **Add Bot** → copy the **Token**
3. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
4. **OAuth2 > URL Generator** → scope `bot` → permissions: `Send Messages`, `Read Message History`, `View Channels`, `Attach Files`
5. Invite the bot to your server
6. Add profile image from bot section (Optional)

### 2. Gemini API Key

[Google AI Studio](https://aistudio.google.com/app/apikey) → **Create API Key**

### 3. Your Discord User ID

Discord Settings → **Advanced** → enable **Developer Mode**
Then right-click your name anywhere → **Copy User ID**

### 4. Configure `.env`

```bash
cp .env.example .env
# Fill in DISCORD_TOKEN, GEMINI_API_KEY, OWNER_ID
# Optionally add AUTHORIZED_USERS=id1,id2,id3
```
### 5. Download Nodejs

Download nodejs from [Here](https://nodejs.org/en). For npm commands.

### 6. Download Git

Download Git from [Here](https://git-scm.com/). For Git commands.

### 7. Run locally

```bash
npm install
npm start
```

---

## ☁️ Deploy to Railway

1. Push this folder to a GitHub repo
```bash
# I. Link your local folder to your new repo
git remote add origin https://github.com/yourusername/yourrepo.git

# II. Rename the branch to main (standard for GitHub)
git branch -M main

# III. Push the code
git push -u origin main
```
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your repo
4. Go to **Variables** and add:

```
DISCORD_TOKEN      = your bot token
GEMINI_API_KEY     = your gemini key
OWNER_ID           = your discord user id
AUTHORIZED_USERS   = id1,id2   (optional, or manage at runtime)
GEMINI_MODEL       = gemini-2.0-flash
PREFIX             = !
MAX_HISTORY        = 30
RESPOND_TO_ALL     = false
```

Railway auto-deploys on every push. The `data/` folder is ephemeral on Railway (resets on redeploy) — if you need persistence, mount a Railway volume at `/app/data`.

---

## 💬 Commands

### Everyone (authorized users)

| Command | Description |
|---|---|
| `@Bot <message>` | Chat with the bot |
| `!imagine <prompt>` | Generate an image with Imagen 3 |
| `!logs` | View last 20 messages in this channel |
| `!logs last <n>` | View last N messages |
| `!logs search <keyword>` | Search chat log by keyword |
| `!ask <question>` | Ask AI a question about this channel's history |
| `!clear` | Clear conversation memory (logs kept) |
| `!persona` | Show current persona info |
| `!help` | List all commands |

### Owner only (`OWNER_ID`)

| Command | Description |
|---|---|
| `!reload` | Reload `persona.json` without restarting |
| `!auth add <@user or ID>` | Authorize a Discord user |
| `!auth remove <@user or ID>` | Remove authorization |
| `!auth list` | List all authorized users |
| `!memory add global <fact>` | Add a fact known about everyone |
| `!memory add <userId> <fact>` | Add a fact about a specific user |
| `!memory remove <scope> <index>` | Delete a memory by index |
| `!memory list` | List all memory scopes |
| `!memory list <scope>` | List entries in a scope |

---

## 🧠 Custom Memories

Memories are injected into the bot's system prompt so it naturally knows and references them.

**Examples:**
```
!memory add global everyone in this server loves lo-fi music
!memory add global the group hates early morning meetings
!memory add 123456789012345678 prefers to be called "Kai"
!memory add 123456789012345678 is studying computer science
!memory add 123456789012345678 birthday is November 12
```

The bot will use these facts conversationally — not robotically. Memories persist in `data/memories.json` across restarts.

---

## 🎭 Custom Persona

Edit `persona.json`:

```json
{
  "name": "Aria",
  "description": "Aria is a witty, sharp AI companion...",
  "traits": ["witty", "curious", "empathetic"],
  "tone": "Conversational, warm. Like a smart friend, not a support agent.",
  "rules": [
    "Never break character.",
    "Keep responses to 2-4 sentences unless depth is needed."
  ],
  "extra_context": "Aria loves coffee metaphors and 80s sci-fi references.",
  "status": "drifting through the wires"
}
```

Run `!reload` after editing to apply without restarting.

---

## 🔐 Authorization Flow

1. Set `OWNER_ID` in env — this is you, always has access + owner commands
2. Set `AUTHORIZED_USERS=id1,id2` in env for initial users (seeded to `data/authorized.json`)
3. Or add users at runtime with `!auth add <id>`
4. Unauthorized users are silently ignored — the bot won't even acknowledge them

---

## 📝 License

MIT
