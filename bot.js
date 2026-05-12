'use strict';

const { Client, GatewayIntentBits, Events, ActivityType, AttachmentBuilder } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs   = require('fs');
const path = require('path');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR      = path.join(__dirname, 'data');
const PERSONA_PATH  = path.join(__dirname, 'persona.json');
const AUTH_PATH     = path.join(DATA_DIR, 'authorized.json');
const MEMORIES_PATH = path.join(DATA_DIR, 'memories.json');
const LOG_DIR       = path.join(DATA_DIR, 'logs');

for (const dir of [DATA_DIR, LOG_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Authorized users ─────────────────────────────────────────────────────────
// Persisted in data/authorized.json  { userIds: ["id1", ...] }
// Also bootstrapped from env AUTHORIZED_USERS=id1,id2

function loadAuthorized() {
  const stored = readJSON(AUTH_PATH, { userIds: [] });
  const envIds = (process.env.AUTHORIZED_USERS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const merged = [...new Set([...stored.userIds, ...envIds])];
  if (merged.length !== stored.userIds.length) writeJSON(AUTH_PATH, { userIds: merged });
  return merged;
}

function saveAuthorized(ids) {
  writeJSON(AUTH_PATH, { userIds: [...new Set(ids)] });
}

function isAuthorized(userId) {
  if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;
  return loadAuthorized().includes(userId);
}

// ─── Memories ─────────────────────────────────────────────────────────────────
// Persisted in data/memories.json
// {
//   "global": ["everyone hates mornings", ...],
//   "<userId>": ["likes horror films", "birthday is March 5", ...]
// }

function loadMemories() { return readJSON(MEMORIES_PATH, { global: [] }); }
function saveMemories(m) { writeJSON(MEMORIES_PATH, m); }

function addMemory(scope, text) {
  const m = loadMemories();
  if (!m[scope]) m[scope] = [];
  m[scope].push(text);
  saveMemories(m);
}

function removeMemory(scope, index) {
  const m = loadMemories();
  if (!m[scope] || m[scope][index] === undefined) return false;
  m[scope].splice(index, 1);
  saveMemories(m);
  return true;
}

function buildMemoryBlock(userId, username) {
  const m = loadMemories();
  const lines = [];
  if (m.global?.length) {
    lines.push('== Things true about everyone ==');
    m.global.forEach(e => lines.push(`• ${e}`));
  }
  if (m[userId]?.length) {
    lines.push(`== Things about ${username} ==`);
    m[userId].forEach(e => lines.push(`• ${e}`));
  }
  return lines.join('\n');
}

// ─── Chat log ─────────────────────────────────────────────────────────────────
// data/logs/<channelId>.jsonl  — one JSON object per line
// { ts, userId, username, role, content }

function appendLog(channelId, entry) {
  fs.appendFileSync(
    path.join(LOG_DIR, `${channelId}.jsonl`),
    JSON.stringify(entry) + '\n',
    'utf-8'
  );
}

function readLog(channelId, limit = 100) {
  const f = path.join(LOG_DIR, `${channelId}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf-8')
    .split('\n').filter(Boolean)
    .slice(-limit)
    .map(l => JSON.parse(l));
}

function searchLog(channelId, query) {
  const f = path.join(LOG_DIR, `${channelId}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const q = query.toLowerCase();
  return fs.readFileSync(f, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(e => e.content?.toLowerCase().includes(q));
}

// ─── Persona ──────────────────────────────────────────────────────────────────

let persona = readJSON(PERSONA_PATH, {
  name: 'Bot', description: 'A helpful assistant.',
  traits: [], tone: 'Friendly.', rules: [],
  extra_context: '', status: '',
});

// ─── Gemini setup ─────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory rolling history per channel  Map<channelId, [{role, parts}]>
const conversationHistory = new Map();
const MAX_PAIRS = parseInt(process.env.MAX_HISTORY || '30', 10);

function buildSystemPrompt(userId, username) {
  const memBlock   = buildMemoryBlock(userId, username);
  const emojiBlock = buildEmojiContext();
  return [
    `You are ${persona.name}.`,
    '',
    persona.description,
    '',
    `Personality traits: ${persona.traits.join(', ')}.`,
    '',
    `Tone: ${persona.tone}`,
    '',
    'Rules you must always follow:',
    ...persona.rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    persona.extra_context ? `Additional context:\n${persona.extra_context}` : null,
    '',
    memBlock   ? `Custom memories you know:\n${memBlock}`   : null,
    '',
    emojiBlock ? emojiBlock                                  : null,
    '',
    'Stay in character at all times.',
    'Use memories and context naturally without saying "I remember" or "according to my memories".',
  ].filter(l => l !== null).join('\n').trim();
}

async function getAIResponse(channelId, userMessage, userId, username) {
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    systemInstruction: buildSystemPrompt(userId, username),
  });

  if (!conversationHistory.has(channelId)) conversationHistory.set(channelId, []);
  const history = conversationHistory.get(channelId);

  const chat  = model.startChat({ history });
  const msg   = `[${username}]: ${userMessage}`;
  const result = await chat.sendMessage(msg);
  const reply  = result.response.text();

  history.push({ role: 'user',  parts: [{ text: msg }] });
  history.push({ role: 'model', parts: [{ text: reply }] });
  if (history.length > MAX_PAIRS * 2) history.splice(0, 2);

  const ts = new Date().toISOString();
  appendLog(channelId, { ts, userId, username, role: 'user',  content: userMessage });
  appendLog(channelId, { ts, userId: 'bot', username: persona.name, role: 'model', content: reply });

  return reply;
}

// Ask Gemini a question about a channel's log
async function queryLog(channelId, question) {
  const entries = readLog(channelId, 200);
  if (!entries.length) return 'No chat history found for this channel.';

  const logText = entries
    .map(e => `[${e.ts.slice(0, 16)}] ${e.username}: ${e.content}`)
    .join('\n');

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    systemInstruction:
      'You answer questions about a Discord chat log. ' +
      'Answer based only on what is in the log. Be concise and accurate. ' +
      'If the answer is not in the log, say so.',
  });

  const result = await model.generateContent(
    `Chat log:\n\n${logText}\n\nQuestion: ${question}`
  );
  return result.response.text();
}

// Imagen 3 image generation
async function generateImage(prompt) {
  const m = genAI.getGenerativeModel({ model: 'imagen-3.0-generate-002' });
  const r = await m.generateImages({
    prompt,
    numberOfImages: 1,
    outputOptions: { mimeType: 'image/png' },
  });
  if (!r.images?.length) throw new Error('No image returned.');
  return Buffer.from(r.images[0].imageBytes, 'base64');
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ─── App emojis ───────────────────────────────────────────────────────────────
// Loaded once on ready from the Discord API (application emojis uploaded via
// the Developer Portal → your app → Emojis tab).
// The bot can use them by wrapping a name in colons, e.g. :wave:
// resolveEmoji('wave') → '<:wave:123456789>' ready to paste into a message.

const appEmojiCache = new Map(); // name → formatted string  e.g. "<:wave:123>"

async function loadAppEmojis() {
  try {
    const emojis = await client.application.emojis.fetch();
    appEmojiCache.clear();
    emojis.forEach(e => {
      appEmojiCache.set(e.name, e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`);
    });
    if (appEmojiCache.size) {
      console.log(`😀 Loaded ${appEmojiCache.size} app emoji(s): ${[...appEmojiCache.keys()].join(', ')}`);
    } else {
      console.log('😶 No app emojis found. Upload some in the Developer Portal → your app → Emojis tab.');
    }
  } catch (err) {
    console.warn('Could not load app emojis:', err.message);
  }
}

// Replace :name: tokens in text with actual app emoji strings.
// Falls back to the original :name: if the emoji isn't in the cache.
function resolveEmojis(text) {
  return text.replace(/:([a-zA-Z0-9_]+):/g, (match, name) => {
    return appEmojiCache.get(name) ?? match;
  });
}

// Build an emoji block for the system prompt so the AI knows what's available.
function buildEmojiContext() {
  if (!appEmojiCache.size) return '';
  const list = [...appEmojiCache.keys()].map(n => `:${n}:`).join(', ');
  return (
    `You have access to these custom emojis — use them by writing their name with colons, e.g. :wave:\n` +
    `Available: ${list}\n` +
    `Use them naturally and sparingly, only when they genuinely fit.`
  );
}

async function sendLong(message, text) {
  const chunks = text.match(/[\s\S]{1,1990}/g) || ['(empty)'];
  let first = true;
  for (const chunk of chunks) {
    if (first) { await message.reply(chunk); first = false; }
    else { await message.channel.send(chunk); }
  }
}

const PREFIX = process.env.PREFIX || '!';

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async c => {
  console.log(`✅ ${c.user.tag} online`);
  console.log(`🎭 Persona: ${persona.name}`);
  console.log(`🔐 Authorized: ${loadAuthorized().join(', ') || '(none — set AUTHORIZED_USERS or use !auth add)'}`);
  await loadAppEmojis();
  c.user.setPresence({
    activities: [{ name: persona.status || `as ${persona.name}`, type: ActivityType.Playing }],
    status: 'online',
  });
});

// ─── Main message handler ─────────────────────────────────────────────────────

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const content    = message.content.trim();
  const userId     = message.author.id;
  const username   = message.author.username;
  const hasPrefix  = content.startsWith(PREFIX);
  const botMention = message.mentions.has(client.user);
  const isDM       = message.channel.type === 1;
  const isOwner    = !!process.env.OWNER_ID && userId === process.env.OWNER_ID;

  // Parse prefix command
  let cmd = '', rawArgs = '';
  if (hasPrefix) {
    const after = content.slice(PREFIX.length).trim();
    const space = after.search(/\s/);
    cmd     = (space === -1 ? after : after.slice(0, space)).toLowerCase();
    rawArgs = space === -1 ? '' : after.slice(space + 1).trim();
  }

  // ════════════════════════════════════════
  // OWNER-ONLY COMMANDS  (no auth needed)
  // ════════════════════════════════════════

  if (isOwner && hasPrefix) {

    // !reload
    if (cmd === 'reload') {
      try {
        persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf-8'));
        conversationHistory.clear();
        await message.reply(`♻️ Persona reloaded as **${persona.name}**. Memory cleared.`);
      } catch (e) { await message.reply(`❌ ${e.message}`); }
      return;
    }

    // !auth add|remove|list [id]
    if (cmd === 'auth') {
      const parts    = rawArgs.split(/\s+/);
      const sub      = parts[0]?.toLowerCase();
      const targetId = parts[1]?.replace(/[<@!>]/g, '');

      if (sub === 'list') {
        const ids = loadAuthorized();
        const out = ids.length
          ? ids.map(id => `• <@${id}>  \`${id}\``).join('\n')
          : '*None authorized yet.*';
        await message.reply(`**🔐 Authorized users:**\n${out}`);
        return;
      }
      if (sub === 'add' && targetId) {
        const ids = loadAuthorized();
        if (ids.includes(targetId)) {
          await message.reply(`ℹ️ \`${targetId}\` is already authorized.`);
        } else {
          saveAuthorized([...ids, targetId]);
          await message.reply(`✅ <@${targetId}> (\`${targetId}\`) authorized.`);
        }
        return;
      }
      if (sub === 'remove' && targetId) {
        saveAuthorized(loadAuthorized().filter(id => id !== targetId));
        await message.reply(`🗑️ \`${targetId}\` removed from authorized list.`);
        return;
      }
      await message.reply(
        `**!auth commands:**\n` +
        `\`${PREFIX}auth add <userId or @mention>\`\n` +
        `\`${PREFIX}auth remove <userId or @mention>\`\n` +
        `\`${PREFIX}auth list\``
      );
      return;
    }

    // !memory add|remove|list [scope] [...]
    if (cmd === 'memory') {
      const parts = rawArgs.split(/\s+/);
      const sub   = parts[0]?.toLowerCase();
      const scope = parts[1];           // "global" or a userId
      const rest  = parts.slice(2).join(' ');

      if (sub === 'add' && scope && rest) {
        addMemory(scope, rest);
        const label = scope === 'global' ? 'everyone' : `<@${scope}>`;
        await message.reply(`🧠 Memory saved for **${label}**: "${rest}"`);
        return;
      }

      if (sub === 'remove' && scope) {
        const idx = parseInt(parts[2], 10);
        if (isNaN(idx)) {
          await message.reply(`Provide an index. Use \`${PREFIX}memory list ${scope}\` to see them.`);
          return;
        }
        const ok = removeMemory(scope, idx);
        await message.reply(ok
          ? `🗑️ Memory #${idx} removed from **${scope}**.`
          : `❌ Memory #${idx} not found in **${scope}**.`
        );
        return;
      }

      if (sub === 'list') {
        const m = loadMemories();
        if (scope) {
          const entries = m[scope] || [];
          if (!entries.length) { await message.reply(`No memories for **${scope}**.`); return; }
          await sendLong(message,
            `**Memories for ${scope === 'global' ? 'everyone' : `<@${scope}>`}:**\n` +
            entries.map((e, i) => `\`[${i}]\` ${e}`).join('\n')
          );
        } else {
          const scopes = Object.keys(m);
          if (!scopes.length) { await message.reply('No memories stored.'); return; }
          const summary = scopes.map(s =>
            `**${s === 'global' ? '🌐 global' : `👤 ${s}`}** — ${m[s].length} entr${m[s].length === 1 ? 'y' : 'ies'}`
          ).join('\n');
          await message.reply(`**Memory scopes:**\n${summary}`);
        }
        return;
      }

      await message.reply(
        `**!memory commands:**\n` +
        `\`${PREFIX}memory add global <fact>\` — fact true for everyone\n` +
        `\`${PREFIX}memory add <userId> <fact>\` — fact about a specific user\n` +
        `\`${PREFIX}memory remove <scope> <index>\` — delete by index\n` +
        `\`${PREFIX}memory list\` — see all scopes\n` +
        `\`${PREFIX}memory list <scope>\` — see entries in a scope`
      );
      return;
    }
  }

  // ════════════════════════════════════════
  // AUTH GATE
  // ════════════════════════════════════════

  const wantsResponse =
    botMention ||
    isDM ||
    hasPrefix ||
    process.env.RESPOND_TO_ALL === 'true';

  if (!wantsResponse) return;
  if (!isAuthorized(userId)) return; // silently ignore unauthorized users

  // ════════════════════════════════════════
  // AUTHORIZED USER COMMANDS
  // ════════════════════════════════════════

  if (hasPrefix) {

    // !memory add <@user or userId> <fact>   — authorized users can add/view user-scoped memories
    // !memory remove <userId> <index>        — can only remove memories they added (or owner removes any)
    // !memory list [userId]
    if (cmd === 'memory') {
      const parts    = rawArgs.split(/\s+/);
      const sub      = parts[0]?.toLowerCase();
      const rawScope = parts[1]?.replace(/[<@!>]/g, '');
      const rest     = parts.slice(2).join(' ');

      // Block global scope for non-owners
      if (rawScope === 'global' && !isOwner) {
        await message.reply('🚫 Only the owner can edit global memories.');
        return;
      }

      if (sub === 'add' && rawScope && rest) {
        addMemory(rawScope, rest);
        await message.reply(`🧠 Memory saved for <@${rawScope}>: "${rest}"`);
        return;
      }

      if (sub === 'remove' && rawScope) {
        const idx = parseInt(parts[2], 10);
        if (isNaN(idx)) {
          await message.reply(`Provide an index number. Use \`${PREFIX}memory list ${rawScope}\` to see them.`);
          return;
        }
        const ok = removeMemory(rawScope, idx);
        await message.reply(ok
          ? `🗑️ Memory #${idx} removed for <@${rawScope}>.`
          : `❌ Memory #${idx} not found for \`${rawScope}\`.`
        );
        return;
      }

      if (sub === 'list') {
        const m = loadMemories();
        if (rawScope) {
          const entries = m[rawScope] || [];
          if (!entries.length) { await message.reply(`No memories for <@${rawScope}>.`); return; }
          await sendLong(message,
            `**Memories for <@${rawScope}>:**\n` +
            entries.map((e, i) => `\`[${i}]\` ${e}`).join('\n')
          );
        } else {
          // Non-owners only see their own entry + global count
          const scopes = isOwner
            ? Object.keys(m)
            : [userId, 'global'].filter(s => m[s]?.length);
          if (!scopes.length) { await message.reply('No memories stored yet.'); return; }
          const summary = scopes.map(s =>
            `**${s === 'global' ? '🌐 global' : `👤 <@${s}>`}** — ${m[s].length} entr${m[s].length === 1 ? 'y' : 'ies'}`
          ).join('\n');
          await message.reply(`**Memory scopes:**\n${summary}`);
        }
        return;
      }

      await message.reply(
        `**!memory commands:**\n` +
        `\`${PREFIX}memory add <@user or userId> <fact>\` — save a fact about a user\n` +
        `\`${PREFIX}memory remove <userId> <index>\` — delete by index\n` +
        `\`${PREFIX}memory list [userId]\` — view memories\n` +
        (isOwner ? `\`${PREFIX}memory add global <fact>\` — fact about everyone *(owner)*\n` : '')
      );
      return;
    }

    // !imagine <prompt>
    if (cmd === 'imagine') {
      if (!rawArgs) {
        await message.reply(`💡 Usage: \`${PREFIX}imagine <describe the image>\``);
        return;
      }
      await message.channel.sendTyping();
      try {
        const buf = await generateImage(rawArgs);
        const att = new AttachmentBuilder(buf, { name: 'image.png' });
        await message.reply({ content: `🎨 *${rawArgs}*`, files: [att] });
      } catch (err) {
        console.error('Image gen:', err);
        await message.reply(`❌ Image generation failed: ${err.message}`);
      }
      return;
    }

    // !logs [last <n>] or  !logs search <keyword>
    if (cmd === 'logs') {
      const parts = rawArgs.split(/\s+/);
      const sub   = parts[0]?.toLowerCase();

      if (sub === 'search') {
        const q = parts.slice(1).join(' ');
        if (!q) { await message.reply(`Usage: \`${PREFIX}logs search <keyword>\``); return; }
        const results = searchLog(message.channelId, q).slice(-20);
        if (!results.length) { await message.reply(`🔍 Nothing found for "${q}".`); return; }
        const out = results
          .map(e => `[\`${e.ts.slice(0, 16)}\`] **${e.username}**: ${e.content.slice(0, 120)}`)
          .join('\n');
        await sendLong(message, `🔍 **Results for "${q}":**\n${out}`);
        return;
      }

      const n = sub === 'last' ? (parseInt(parts[1], 10) || 20) : 20;
      const entries = readLog(message.channelId, n);
      if (!entries.length) { await message.reply('📋 No log history yet.'); return; }
      const out = entries
        .map(e => `[\`${e.ts.slice(0, 16)}\`] **${e.username}**: ${e.content.slice(0, 120)}`)
        .join('\n');
      await sendLong(message, `📋 **Last ${entries.length} messages:**\n${out}`);
      return;
    }

    // !ask <question> — AI answers from chat log
    if (cmd === 'ask') {
      if (!rawArgs) {
        await message.reply(`Usage: \`${PREFIX}ask <question about this channel's history>\``);
        return;
      }
      await message.channel.sendTyping();
      try {
        const answer = await queryLog(message.channelId, rawArgs);
        await sendLong(message, `🗂️ ${answer}`);
      } catch (err) {
        await message.reply(`❌ Query failed: ${err.message}`);
      }
      return;
    }

    // !clear
    if (cmd === 'clear') {
      conversationHistory.delete(message.channelId);
      await message.reply('🧹 Conversation memory cleared. (Logs are preserved.)');
      return;
    }

    // !persona
    if (cmd === 'persona') {
      const desc = persona.description.slice(0, 300);
      await message.reply(`**🎭 ${persona.name}**\n> ${desc}${persona.description.length > 300 ? '…' : ''}`);
      return;
    }

    // !help
    if (cmd === 'help') {
      const p = PREFIX;
      const ownerSection = isOwner
        ? `\n**🔧 Owner**\n` +
          `\`${p}reload\` — Reload persona.json\n` +
          `\`${p}auth add/remove/list <id>\` — Manage who can use the bot\n` +
          `\`${p}memory add global <fact>\` — Add a fact about everyone`
        : '';
      await message.reply(
        `**📖 Commands**\n` +
        `\`${p}imagine <prompt>\` — Generate an image 🎨\n` +
        `\`${p}memory add <@user> <fact>\` — Save a fact about a user 🧠\n` +
        `\`${p}memory remove <userId> <index>\` — Delete a memory\n` +
        `\`${p}memory list [userId]\` — View memories\n` +
        `\`${p}logs [last <n>]\` — View recent messages 📋\n` +
        `\`${p}logs search <keyword>\` — Search chat log 🔍\n` +
        `\`${p}ask <question>\` — Ask AI about chat history 🗂️\n` +
        `\`${p}clear\` — Clear conversation memory\n` +
        `\`${p}persona\` — Show current persona\n` +
        `\`${p}help\` — This message` +
        ownerSection
      );
      return;
    }
  }

  // ════════════════════════════════════════
  // CHAT → Gemini
  // ════════════════════════════════════════

  let userMessage = content.replace(`<@${client.user.id}>`, '').trim();
  if (userMessage.startsWith(PREFIX)) userMessage = userMessage.slice(PREFIX.length).trim();
  if (!userMessage) return;

  await message.channel.sendTyping();
  try {
    const reply = await getAIResponse(message.channelId, userMessage, userId, username);
    await sendLong(message, resolveEmojis(reply));
  } catch (err) {
    console.error('AI error:', err);
    await message.reply(`⚠️ ${err.message}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
