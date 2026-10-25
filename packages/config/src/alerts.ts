import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
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
 *   TELEGRAM_CHAT_ID     optional: chats that always get alerts (owners); several, comma-separated
 *   ALERTS=off           silences everything; ALERTS=on sends outside pm2 too (a test)
 *
 * Who gets alerts is otherwise kept by the bot (watchdog.mjs) in
 * ALERT_DIR/members.json: the first person to send it /start is its owner;
 * anyone after asks, and an owner taps Allow. Nobody types a chat id.
 *
 * Off unless the token is set, and only under pm2 (pm_id), so tests,
 * scripts and a laptop never send. The watchdog (scripts/watchdog.mjs) and the
 * nightly backup send through sendAlert too.
 *
 * Every alert, sent or held back, is written to ALERT_DIR/recent.jsonl, which
 * the bot's /alerts reads; /mute writes ALERT_DIR/muted-until, which holds
 * back every alert but a forced one until then.
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

/**
 * Errors that are the system working, not failing: Kafka moving a consumer
 * group's partitions around while services restart (every deploy) logs these
 * at ERROR and settles within seconds. A consumer that really cannot reach
 * Kafka still alerts (its retries run out, "Crash", "ECONNREFUSED").
 */
const ROUTINE_ERRORS: readonly RegExp[] = [
  /The group is rebalancing, so a rejoin is needed/,
  /The coordinator is not aware of this member/,
  /Specified group generation id is not valid/,
  /There is no leader for this topic-partition as we are in the middle of a leadership election/,
];

const SPOOL_DIR = join(homedir(), '.wheelers-alerts');
export const ALERT_DIR = SPOOL_DIR;
const RECENT = join(SPOOL_DIR, 'recent.jsonl');
const MUTED_UNTIL = join(SPOOL_DIR, 'muted-until');
const RECENT_KEEP = 200;

type Group = { count: number; firstLine: string; sentAt: number; unsent: number };

let service = 'service';
let started = false;
const groups = new Map<string, Group>();
let windowStart = 0;
let sentInWindow = 0;
let mutedNoticeSent = false;
let lastError: string | null = null;

export type AlertMember = { id: string; name: string; owner: boolean; addedAt: string };

const MEMBERS = join(SPOOL_DIR, 'members.json');

function savedMembers(): AlertMember[] {
  try {
    const list = JSON.parse(readFileSync(MEMBERS, 'utf8')) as AlertMember[];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
  } catch {
    return [];
  }
}

/** Everyone who gets alerts and may use the bot: TELEGRAM_CHAT_ID (owners), then those the bot let in. */
export function alertMembers(): AlertMember[] {
  const fromEnv = (process.env['TELEGRAM_CHAT_ID'] ?? '').split(',').map((c) => c.trim()).filter(Boolean)
    .map((id) => ({ id, name: 'set in .env', owner: true, addedAt: '' }));
  const saved = savedMembers().filter((m) => !fromEnv.some((e) => e.id === m.id));
  return [...fromEnv, ...saved];
}

/** Let a chat in (the first ever is an owner). Every process on this machine reads the same list. */
export function addAlertMember(id: string, name: string, owner = false): void {
  mkdirSync(SPOOL_DIR, { recursive: true });
  const list = savedMembers().filter((m) => m.id !== id);
  list.push({ id, name: name.slice(0, 80), owner, addedAt: new Date().toISOString() });
  writeFileSync(MEMBERS, JSON.stringify(list, null, 2));
}

export function removeAlertMember(id: string): void {
  if (!existsSync(MEMBERS)) return;
  writeFileSync(MEMBERS, JSON.stringify(savedMembers().filter((m) => m.id !== id), null, 2));
}

function settings(): { token: string; chats: string[] } | null {
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim();
  if (!token || process.env['ALERTS'] === 'off') return null;
  return { token, chats: alertMembers().map((m) => m.id) };
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
/** The chats alerts go to, which are also the only ones the bot answers. */
export function alertChats(): string[] {
  return alertMembers().map((m) => m.id);
}

/** Until when alerts are held back (ms), or 0. */
export function alertsMutedUntil(): number {
  try {
    const until = Number(readFileSync(MUTED_UNTIL, 'utf8'));
    return Number.isFinite(until) && until > Date.now() ? until : 0;
  } catch {
    return 0;
  }
}

/** Hold alerts back for `ms` (0 lets them through again). Every process on this machine reads it. */
export function muteAlerts(ms: number): void {
  mkdirSync(SPOOL_DIR, { recursive: true });
  if (ms > 0) writeFileSync(MUTED_UNTIL, String(Date.now() + ms));
  else if (existsSync(MUTED_UNTIL)) unlinkSync(MUTED_UNTIL);
}

/** The last alerts, newest first: when, from where, what, and whether it was sent or held back. */
export function recentAlerts(count = 10): Array<{ at: string; host: string; title: string; sent: boolean }> {
  try {
    return readFileSync(RECENT, 'utf8').trim().split('\n').filter(Boolean).slice(-count).reverse()
      .map((line) => JSON.parse(line) as { at: string; host: string; title: string; sent: boolean });
  } catch {
    return [];
  }
}

function remember(title: string, sent: boolean): void {
  try {
    mkdirSync(SPOOL_DIR, { recursive: true });
    appendFileSync(RECENT, `${JSON.stringify({ at: new Date().toISOString(), host: hostname(), title: maskSecrets(title).slice(0, 300), sent })}\n`);
    // Kept short: rewritten to the newest RECENT_KEEP now and then.
    if (Math.random() < 0.05) {
      const lines = readFileSync(RECENT, 'utf8').trim().split('\n');
      if (lines.length > RECENT_KEEP) writeFileSync(RECENT, `${lines.slice(-RECENT_KEEP).join('\n')}\n`);
    }
  } catch {
    // Nowhere to write: the alert itself still goes.
  }
}

/** One message to one chat, as it is (HTML). The bot's replies; alerts go through sendAlert. */
export async function sendTelegram(chat: string, html: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const s = settings();
  if (!s) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${s.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendAlert(title: string, body = '', options: { force?: boolean } = {}): Promise<boolean> {
  const s = settings();
  if (!s || s.chats.length === 0) return false;
  const now = Date.now();
  if (!options.force && alertsMutedUntil() > now) {
    remember(title, false);
    return false;
  }
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
  remember(title, results.some(Boolean));
  return results.some(Boolean);
}

function report(level: 'error' | 'warning', args: unknown[]): void {
  const text = describe(args);
  if (ROUTINE_ERRORS.some((pattern) => pattern.test(text))) return;
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
