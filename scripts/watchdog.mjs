#!/usr/bin/env node
/**
 * The server watching itself, with alerts on Telegram (packages/config, alerts.ts).
 * Runs under pm2 as "watchdog" (ecosystem.config.cjs). Every minute:
 *
 *   the gateway   /health answers; two misses in a row: "not answering", then "back"
 *   each service  online in pm2; three restarts in ten minutes: a crash loop
 *   memory        under 8% free for three minutes in a row
 *   disk          85% full or more (once every six hours)
 *
 * And at 09:00 Lagos time, a line saying all is well: services up, restarts in
 * the last day, memory, disk and last night's backup. A service's own errors
 * are sent by that service; this is what a service cannot say about itself.
 *
 * It is also the bot's other half: it answers commands in Telegram, only from
 * the chats in TELEGRAM_CHAT_ID (anyone else is told the bot is private, and
 * the team is told who tried, with the id to add them):
 *
 *   /start, /help   what it can do
 *   /status         the gateway, every service, memory, disk, the last backup
 *   /alerts         the last alerts, sent or held back
 *   /logs NAME      the last error lines of a service (masked)
 *   /mute [MIN]     hold alerts back (an hour by default); /unmute
 *
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env (npm run alerts).
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('../packages/config/dist/index.js');
config.loadWorkspaceEnv();
const { sendAlert } = config;

const EVERY_MS = 60_000;
const PORT = process.env.PORT || '3000';
const LOOP_RESTARTS = 3;
const LOOP_WINDOW_MS = 10 * 60_000;
const MEMORY_FREE_MIN = 0.08;
const DISK_FULL = 85;
const HOUR = 60 * 60_000;

const state = {
  healthMisses: 0,
  healthDown: false,
  restarts: new Map(),        // pm_id → { count, times: [] }
  loopAlertedAt: new Map(),   // name → ms
  downAlerted: new Set(),     // names stopped or errored
  lowMemory: 0,
  memoryAlertedAt: 0,
  diskAlertedAt: 0,
  summaryDay: null,
  restartsToday: 0,
};

const sh = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => resolve(error ? null : stdout));
});

const lagos = () => {
  const local = new Date(Date.now() + HOUR);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
};

async function processes() {
  const out = await sh('pm2', ['jlist']);
  if (!out) return null;
  try {
    return JSON.parse(out).map((p) => ({
      id: p.pm_id,
      name: p.name,
      status: p.pm2_env?.status,
      restarts: Number(p.pm2_env?.restart_time ?? 0),
      memoryMb: Math.round((p.monit?.memory ?? 0) / 1048576),
    }));
  } catch {
    return null;
  }
}

function memoryFree() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (key) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    const total = kb('MemTotal');
    return total ? kb('MemAvailable') / total : null;
  } catch {
    return null;
  }
}

async function diskUsed() {
  const out = await sh('df', ['-Pk', '/']);
  const line = out?.trim().split('\n')[1];
  const pct = line?.split(/\s+/)[4];
  return pct ? Number(pct.replace('%', '')) : null;
}

function lastBackup() {
  const log = join(homedir(), 'backups', 'backup.log');
  if (!existsSync(log)) return 'no backup log yet';
  const lines = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('[backup]'));
  const last = [...lines].reverse().find((l) => / done$| FAILED/.test(l));
  return last ? last.replace(/^\[backup\]\s*/, '') : 'nothing logged';
}

async function checkHealth() {
  let ok = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(5000) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    if (state.healthDown) await sendAlert('✅ The gateway is answering again', `http://127.0.0.1:${PORT}/health`);
    state.healthMisses = 0;
    state.healthDown = false;
    return;
  }
  state.healthMisses += 1;
  if (state.healthMisses >= 2 && !state.healthDown) {
    state.healthDown = true;
    await sendAlert('🔴 The gateway is not answering', `/health has failed ${state.healthMisses} minutes in a row. Riders and drivers cannot reach Wheelers.\npm2 logs api-gateway --lines 50`);
  }
}

async function checkProcesses(list) {
  const now = Date.now();
  for (const p of list) {
    if (p.name === 'watchdog') continue;
    const seen = state.restarts.get(p.id);
    if (seen && p.restarts > seen.count) {
      const added = p.restarts - seen.count;
      state.restartsToday += added;
      for (let i = 0; i < added; i += 1) seen.times.push(now);
    }
    const times = (seen?.times ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
    state.restarts.set(p.id, { count: p.restarts, times });
    if (times.length >= LOOP_RESTARTS && now - (state.loopAlertedAt.get(p.name) ?? 0) > 3 * LOOP_WINDOW_MS) {
      state.loopAlertedAt.set(p.name, now);
      await sendAlert(`🔁 ${p.name} keeps crashing`, `${times.length} restarts in the last ${LOOP_WINDOW_MS / 60_000} minutes.\npm2 logs ${p.name} --lines 80`);
    }
    if (p.status !== 'online' && !state.downAlerted.has(p.name)) {
      state.downAlerted.add(p.name);
      await sendAlert(`🔴 ${p.name} is ${p.status}`, `pm2 restart ${p.name}   (or npm run pm2:restart)`);
    } else if (p.status === 'online' && state.downAlerted.delete(p.name)) {
      await sendAlert(`✅ ${p.name} is back online`);
    }
  }
}

async function checkMachine() {
  const now = Date.now();
  const free = memoryFree();
  if (free !== null) {
    state.lowMemory = free < MEMORY_FREE_MIN ? state.lowMemory + 1 : 0;
    if (state.lowMemory >= 3 && now - state.memoryAlertedAt > HOUR) {
      state.memoryAlertedAt = now;
      const list = await processes();
      const top = (list ?? []).sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 4).map((p) => `${p.name} ${p.memoryMb} MB`).join('\n');
      await sendAlert(`🟠 Memory is almost full: ${Math.round(free * 100)}% free`, `${top}\nfree -h   ·   a bigger instance (t3.medium) gives 4 GB`);
    }
  }
  const disk = await diskUsed();
  if (disk !== null && disk >= DISK_FULL && now - state.diskAlertedAt > 6 * HOUR) {
    state.diskAlertedAt = now;
    await sendAlert(`🟠 The disk is ${disk}% full`, 'pm2 flush (old logs) · docker system prune · ls -lh ~/backups');
  }
}

async function dailySummary(list) {
  const { day, hour } = lagos();
  if (hour !== 9 || state.summaryDay === day) return;
  state.summaryDay = day;
  const services = (list ?? []).filter((p) => p.name !== 'watchdog');
  const up = services.filter((p) => p.status === 'online').length;
  const free = memoryFree();
  const disk = await diskUsed();
  await sendAlert(
    `${up === services.length ? '☀️ Wheelers is up' : '⚠️ Wheelers: not every service is up'}: ${up} of ${services.length} services`,
    [
      `restarts since yesterday: ${state.restartsToday}`,
      free !== null ? `memory free: ${Math.round(free * 100)}%` : null,
      disk !== null ? `disk used: ${disk}%` : null,
      `last backup: ${lastBackup()}`,
    ].filter(Boolean).join('\n'),
  );
  state.restartsToday = 0;
}

async function pass() {
  const list = await processes();
  await checkHealth();
  if (list) await checkProcesses(list);
  await checkMachine();
  await dailySummary(list);
}

/* ── the bot: commands from the team's chats ───────────────────────────── */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const say = (chat, html) => config.sendTelegram(String(chat), html);
const lagosClock = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const strangersSeen = new Map(); // chat id → day told

const MENU = [
  '<b>Wheelers ops</b>: just for the team.',
  '/status  the gateway, every service, memory, disk, the last backup',
  '/alerts  the last alerts',
  '/logs api-gateway  the last error lines of a service',
  '/mute 60  hold alerts back for 60 minutes · /unmute',
].join('\n');

async function statusText() {
  let health = 'not answering';
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(5000) });
    health = res.ok ? `answering (${Date.now() - started} ms)` : `HTTP ${res.status}`;
  } catch { /* stays "not answering" */ }
  const list = (await processes()) ?? [];
  const services = list
    .filter((p) => p.name !== 'watchdog')
    .map((p) => `${p.status === 'online' ? '🟢' : '🔴'} ${p.name}  ↺${p.restarts}  ${p.memoryMb} MB`)
    .join('\n');
  const free = memoryFree();
  const disk = await diskUsed();
  const muted = config.alertsMutedUntil();
  return [
    `<b>${health.startsWith('answering') && list.every((p) => p.status === 'online') ? '🟢' : '⚠️'} Wheelers now</b>`,
    `Gateway: ${esc(health)}`,
    `<pre>${esc(services || 'pm2 did not answer')}</pre>`,
    `Memory free: ${free === null ? '?' : `${Math.round(free * 100)}%`} · Disk used: ${disk ?? '?'}% · Up ${Math.round(uptime() / 86400)} days`,
    `Last backup: ${esc(lastBackup())}`,
    `Alerts: ${muted ? `muted until ${lagosClock(new Date(muted).toISOString())}` : 'on'}`,
  ].join('\n');
}

function alertsText() {
  const recent = config.recentAlerts(12);
  if (recent.length === 0) return 'No alerts yet.';
  return ['<b>Last alerts</b>', ...recent.map((a) => `${lagosClock(a.at)} ${a.sent ? '' : '✋ held · '}${esc(a.title)}`)].join('\n');
}

async function logsText(name) {
  const list = (await processes()) ?? [];
  const known = [...new Set(list.map((p) => p.name))];
  if (!known.includes(name)) return `No service called ${esc(name)}. The services: ${esc(known.join(', '))}`;
  for (const kind of ['error', 'out']) {
    const file = join(homedir(), '.pm2', 'logs', `${name}-${kind}.log`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-15);
    if (lines.length === 0) continue;
    return `<b>${esc(name)}, last ${kind === 'error' ? 'errors' : 'lines'}</b>\n<pre>${esc(config.maskSecrets(lines.join('\n'))).slice(-3500)}</pre>`;
  }
  return `${esc(name)} has written nothing yet.`;
}

async function answer(message) {
  const chat = String(message.chat?.id ?? '');
  const text = String(message.text ?? '').trim();
  if (!chat || !text) return;
  if (!config.alertChats().includes(chat)) {
    await say(chat, 'This bot is private to the Wheelers team.');
    const day = new Date().toISOString().slice(0, 10);
    if (strangersSeen.get(chat) !== day) {
      strangersSeen.set(chat, day);
      const who = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || message.chat?.title || 'Someone';
      await config.sendAlert(`🙋 ${who}${message.from?.username ? ` (@${message.from.username})` : ''} tried the bot`, `To let them use it and get alerts, add ${chat} to TELEGRAM_CHAT_ID (comma-separated) and restart the watchdog.`, { force: true });
    }
    return;
  }
  const [command, ...args] = text.split(/\s+/);
  const word = command.toLowerCase().replace(/@.*$/, '');
  if (word === '/status') await say(chat, await statusText());
  else if (word === '/alerts') await say(chat, alertsText());
  else if (word === '/logs') await say(chat, await logsText(args[0] ?? 'api-gateway'));
  else if (word === '/mute') {
    const minutes = Math.min(24 * 60, Math.max(5, Number(args[0]) || 60));
    config.muteAlerts(minutes * 60_000);
    await say(chat, `🔇 Alerts held back for ${minutes} minutes. /unmute to have them again; /alerts still lists them.`);
  } else if (word === '/unmute') {
    config.muteAlerts(0);
    await say(chat, '🔔 Alerts are on again.');
  } else await say(chat, MENU);
}

async function listen() {
  if (!TOKEN) return;
  const api = (method, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  }).then((r) => r.json());
  await api('setMyCommands', { commands: [
    { command: 'status', description: 'The gateway, every service, memory, disk, the last backup' },
    { command: 'alerts', description: 'The last alerts' },
    { command: 'logs', description: 'The last error lines of a service, e.g. /logs api-gateway' },
    { command: 'mute', description: 'Hold alerts back, e.g. /mute 60' },
    { command: 'unmute', description: 'Alerts on again' },
    { command: 'help', description: 'What this bot does' },
  ] }).catch(() => undefined);
  let offset = 0;
  for (;;) {
    try {
      const res = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const update of res.result ?? []) {
        offset = update.update_id + 1;
        if (update.message) await answer(update.message).catch((error) => console.warn('[watchdog] command failed', error instanceof Error ? error.message : error));
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

const first = await processes();
for (const p of first ?? []) state.restarts.set(p.id, { count: p.restarts, times: [] });
await sendAlert(`👀 Wheelers alerts are on`, `Watching ${(first ?? []).filter((p) => p.name !== 'watchdog').length} services, the gateway, memory and disk. A summary every morning at 09:00. Send /status any time.`);
setInterval(() => { pass().catch((error) => console.warn('[watchdog] pass failed', error instanceof Error ? error.message : error)); }, EVERY_MS);
void listen();
