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
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env (npm run alerts).
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

const first = await processes();
for (const p of first ?? []) state.restarts.set(p.id, { count: p.restarts, times: [] });
await sendAlert(`👀 Wheelers alerts are on`, `Watching ${(first ?? []).filter((p) => p.name !== 'watchdog').length} services, the gateway, memory and disk. A summary every morning at 09:00.`);
setInterval(() => { pass().catch((error) => console.warn('[watchdog] pass failed', error instanceof Error ? error.message : error)); }, EVERY_MS);
