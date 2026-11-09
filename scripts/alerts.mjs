#!/usr/bin/env node
/**
 * Telegram alerts, set up and tested from the server (packages/config, alerts.ts).
 *
 *   npm run alerts          whether alerts are set up, and the bot's name
 *   npm run alerts chat     the chats that have written to the bot: the id to put in TELEGRAM_CHAT_ID
 *                           (once the watchdog runs it reads the bot's messages itself: a new person
 *                           who writes to the bot is then sent to the team with their id instead)
 *   npm run alerts test     send one test alert
 *
 * Setting up: in Telegram, open @BotFather, send /newbot, give it a name; it
 * answers with a token. Put TELEGRAM_BOT_TOKEN=<token> in .env, send your new
 * bot any message (or add it to a group and write there), run "npm run alerts
 * chat", and put the id it shows in .env as TELEGRAM_CHAT_ID. Restart.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sendAlert } = require('../packages/config/dist/index.js');

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chat = process.env.TELEGRAM_CHAT_ID?.trim();
const word = process.argv[2] ?? 'status';

async function telegram(method) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram refused ${method}: ${body.description ?? res.status}`);
  return body.result;
}

try {
  if (!token) {
    console.log('No TELEGRAM_BOT_TOKEN in .env. In Telegram: @BotFather → /newbot → copy the token into .env, then "npm run alerts chat".');
    process.exit(word === 'status' ? 0 : 1);
  }
  if (word === 'status') {
    const me = await telegram('getMe');
    console.log(`Bot: @${me.username} (${me.first_name})`);
    console.log(chat ? `Alerts go to chat ${chat}${process.env.ALERTS === 'off' ? ', but ALERTS=off silences them' : ''}.` : 'No TELEGRAM_CHAT_ID yet: send the bot a message, then "npm run alerts chat".');
  } else if (word === 'chat') {
    const updates = await telegram('getUpdates');
    const chats = new Map();
    for (const u of updates) {
      const c = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
      if (c) chats.set(c.id, c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || c.type);
    }
    if (chats.size === 0) console.log('Nobody has written to the bot yet. Open it in Telegram, send "hi", and run this again.');
    for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}    (${name})`);
  } else if (word === 'test') {
    if (!chat) throw new Error('No TELEGRAM_CHAT_ID in .env: "npm run alerts chat" shows it.');
    const ok = await sendAlert('🧪 Test alert from Wheelers', 'If you can read this, alerts reach you. Errors, crashes, a gateway that stops answering, low memory or disk, and a failed backup will arrive here.', { force: true });
    console.log(ok ? 'Sent. Check Telegram.' : 'Not sent: check the token and chat id (and that ALERTS is not off).');
  } else {
    console.log('usage: npm run alerts [status | chat | test]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
