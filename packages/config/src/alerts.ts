import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';

/**
 * Alerts on Telegram: what goes wrong on the server reaches a person, instead
 * of waiting in `pm2 logs` for someone to look.
 *
 * Each service calls startAlerts() once at boot, after loadWorkspaceEnv().
 * From then on every console.error, and the console.warn lines named in
 * WATCHED_WARNINGS, is sent to Telegram as well as to the log:
 *
 *   grouped    the same problem (its first line, numbers and ids taken out)
 *              is sent once; repeats within REPEAT_WINDOW_MS are counted and
 *              sent as one "×N more" line
 *   capped     at most MAX_PER_WINDOW messages per process per CAP_WINDOW_MS,
 *              then one "muted" line: a storm cannot flood the phone
 *   masked     phone numbers, keys, tokens, PINs and codes are hidden before
 *              anything leaves the server (maskSecrets)
 *   crashes    a process that exits on an error writes it to a file first; the
 *              next start sends "crashed and restarted" with it (a send at the
 *              moment of exit would never leave). One per service per
 *              CRASH_QUIET_MS, so a crash loop is one message, not hundreds.
 *
 * Settings (.env):
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     the chat (or group) the bot writes to; several, comma-separated
 *   ALERTS=off           silences everything; ALERTS=on sends outside pm2 too (a test)
 *
 * Off unless the token and chat are set, and only under pm2 (pm_id), so tests,
 * scripts and a laptop never send. The watchdog (scripts/watchdog.mjs) and the
 * nightly backup send through sendAlert too.
 */

const REPEAT_WINDOW_MS = 30 * 60_000;
const SUMMARY_EVERY_MS = 5 * 60_000;
const CAP_WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;
const CRASH_QUIET_MS = 10 * 60_000;
const MAX_TEXT = 1500;

/** Warnings worth a message, by how their line starts or what it says. */
const WATCHED_WARNINGS: readonly RegExp[] = [
  /\[whatsapp\] Meta could not deliver/,
  /\[otp\]/,
  /\[backup\].*FAILED/,
];

const SPOOL_DIR = join(homedir(), '.wheelers-alerts');

type Group = { count: number; firstLine: string; sentAt: number; unsent: number };

let service = 'service';
let started = false;
const groups = new Map<string, Group>();
let windowStart = 0;
let sentInWindow = 0;
let mutedNoticeSent = false;
let lastError: string | null = null;

function settings(): { token: string; chats: string[] } | null {
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim();
  const chats = (process.env['TELEGRAM_CHAT_ID'] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!token || chats.length === 0 || process.env['ALERTS'] === 'off') return null;
  return { token, chats };
}

/** Phone numbers, keys, tokens and secrets out of a line, before it leaves the server. */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_[hidden]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [hidden]')
    .replace(/\b(EAA[A-Za-z0-9]{20,}|tlv_[A-Za-z0-9]+|tsk_[A-Za-z0-9]+|AC[0-9a-f]{32})\b/g, '[hidden]')
    .replace(/((?:password|passcode|pin|otp|secret|token|api_key|apikey|seed|codeHash)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[hidden]')
    // A one-time code in a message ("Your Wheelers code is 123456"); an error's "code": 131042 stays.
    .replace(/(\bcode (?:is|in it is)\s*)\d{4,8}/gi, '$1[hidden]')
    .replace(/\+?234(\d{3})\d{5}(\d{2})\b/g, '+234$1•••••$2')
    .replace(/\b0([789][01]\d)\d{5}(\d{2})\b/g, '0$1•••••$2')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[hidden]');
}

/** What makes two lines the same problem: the first line, without numbers, ids or quoted values. */
export function fingerprint(text: string): string {
  return (text.split('\n')[0] ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/(['"`]).*?\1/g, '#')
    .replace(/\d+/g, '#')
    .slice(0, 160);
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function lagosTime(at = new Date()): string {
  return at.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function describe(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a, (_key, value) => (value instanceof Error ? (value.stack ?? value.message) : value), 2);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/**
 * One message to the alert chat(s), masked. `title` is its bold first line;
 * `body`, if any, goes under it as preformatted text. Answers whether it went.
 * Exported for the watchdog, the backup and `npm run alerts test`.
 */
export async function sendAlert(title: string, body = '', options: { force?: boolean } = {}): Promise<boolean> {
  const s = settings();
  if (!s) return false;
  const now = Date.now();
  if (!options.force) {
    if (now - windowStart > CAP_WINDOW_MS) {
      windowStart = now;
      sentInWindow = 0;
      mutedNoticeSent = false;
    }
    if (sentInWindow >= MAX_PER_WINDOW) {
      if (mutedNoticeSent) return false;
      mutedNoticeSent = true;
      title = `🔇 ${service}: too many alerts, quiet for ${Math.round(CAP_WINDOW_MS / 60_000)} minutes. Look at pm2 logs ${service}.`;
      body = '';
    }
    sentInWindow += 1;
  }
  const text = [
    `<b>${escapeHtml(maskSecrets(title)).slice(0, 300)}</b>`,
    body ? `<pre>${escapeHtml(maskSecrets(body)).slice(0, MAX_TEXT)}</pre>` : '',
    `<i>${escapeHtml(hostname())} · ${lagosTime()}</i>`,
  ].filter(Boolean).join('\n');
  const results = await Promise.all(s.chats.map(async (chat) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${s.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
}

function report(level: 'error' | 'warning', args: unknown[]): void {
  const text = describe(args);
  if (level === 'error') lastError = text.slice(0, MAX_TEXT);
  const key = fingerprint(text);
  const now = Date.now();
  const group = groups.get(key);
  if (group && now - group.sentAt < REPEAT_WINDOW_MS) {
    group.count += 1;
    group.unsent += 1;
    return;
  }
  groups.set(key, { count: 1, firstLine: text.split('\n')[0] ?? text, sentAt: now, unsent: 0 });
  const icon = level === 'error' ? '🔴' : '🟠';
  void sendAlert(`${icon} ${service}: ${text.split('\n')[0]?.slice(0, 200) ?? 'error'}`, text);
}

/** "×N more" for problems that kept happening since they were sent. */
function sendSummaries(): void {
  for (const [key, group] of groups) {
    if (group.unsent > 0) {
      void sendAlert(`↻ ${service}: ×${group.unsent} more in the last ${Math.round((Date.now() - group.sentAt) / 60_000)} min`, group.firstLine);
      group.unsent = 0;
    }
    if (Date.now() - group.sentAt > REPEAT_WINDOW_MS) groups.delete(key);
  }
}

function spoolPath(): string {
  return join(SPOOL_DIR, `crash-${service.replace(/[^a-z0-9-]/gi, '_')}.json`);
}

/** A crash before this start: say so, once per CRASH_QUIET_MS. */
function reportLastCrash(): void {
  const path = spoolPath();
  if (!existsSync(path)) return;
  try {
    const crash = JSON.parse(readFileSync(path, 'utf8')) as { at: string; code: number; error: string | null; alertedAt?: number };
    unlinkSync(path);
    const marker = join(SPOOL_DIR, `crash-alerted-${service.replace(/[^a-z0-9-]/gi, '_')}`);
    const alertedAt = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
    if (Date.now() - alertedAt < CRASH_QUIET_MS) return;
    writeFileSync(marker, String(Date.now()));
    void sendAlert(`💥 ${service} crashed (exit ${crash.code}) and was restarted`, crash.error ?? 'No error was logged before it stopped.');
  } catch {
    // An unreadable spool says nothing useful.
  }
}

/**
 * Send this process's errors to Telegram (see the top of this file). Safe to
 * call more than once; does nothing without the settings or outside pm2.
 */
export function startAlerts(name = process.env['name'] ?? process.env['npm_package_name'] ?? 'service'): void {
  if (started) return;
  const underPm2 = process.env['pm_id'] !== undefined || process.env['ALERTS'] === 'on';
  if (!settings() || !underPm2) return;
  started = true;
  service = name;

  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    error(...args);
    try { report('error', args); } catch { /* never let an alert break the log */ }
  };
  console.warn = (...args: unknown[]) => {
    warn(...args);
    try {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (WATCHED_WARNINGS.some((pattern) => pattern.test(first))) report('warning', args);
    } catch { /* as above */ }
  };

  // The error behind an exit, written before the process is gone.
  process.on('uncaughtExceptionMonitor', (err) => { lastError = (err.stack ?? err.message).slice(0, MAX_TEXT); });
  process.on('exit', (code) => {
    if (code === 0) return;
    try {
      mkdirSync(SPOOL_DIR, { recursive: true });
      writeFileSync(spoolPath(), JSON.stringify({ at: new Date().toISOString(), code, error: lastError }));
    } catch { /* nowhere to write: the watchdog still sees the restart */ }
  });

  reportLastCrash();
  setInterval(sendSummaries, SUMMARY_EVERY_MS).unref();
}
