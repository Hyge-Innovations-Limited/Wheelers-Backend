import type { DeviceReport } from '@wheleers/db';

/**
 * Turning what a browser, the app or a WhatsApp number tells us into a device row (UserDevice).
 * Everything here is cleaned and capped: a report is user input.
 */

const text = (v: unknown, max = 40): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/[^\p{L}\p{N} ._()\-/+:]/gu, '').trim().slice(0, max);
  return s || null;
};
const number = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** What a browser's User-Agent says: system and version, browser, phone or computer, and an older Android's model. */
export function parseUserAgent(ua: string | undefined | null) {
  const s = (ua ?? '').slice(0, 512);
  let platform: string | null = null;
  let osVersion: string | null = null;
  let formFactor: string | null = null;
  let model: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/Android (\d+(?:\.\d+)*)/))) {
    platform = 'android';
    osVersion = m[1]!;
    formFactor = /Mobile/.test(s) ? 'phone' : 'tablet';
    // Older Chrome and other browsers still name the phone: "Android 10; SM-A107F Build/…" ("K" is the reduced, nameless one).
    const named = s.match(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/);
    if (named && named[1] && named[1] !== 'K' && !/^wv$/.test(named[1])) model = named[1].trim();
  } else if ((m = s.match(/(iPhone|iPad|iPod).*? OS (\d+(?:_\d+)*)/))) {
    platform = 'ios';
    osVersion = m[2]!.replace(/_/g, '.');
    formFactor = m[1] === 'iPad' ? 'tablet' : 'phone';
    model = m[1]!;
  } else if ((m = s.match(/Windows NT (\d+\.\d+)/))) {
    platform = 'windows';
    osVersion = m[1]!;
    formFactor = 'computer';
  } else if ((m = s.match(/Mac OS X (\d+(?:[._]\d+)*)/))) {
    platform = 'mac';
    osVersion = m[1]!.replace(/_/g, '.');
    formFactor = 'computer';
  } else if (/CrOS/.test(s)) {
    platform = 'chromeos';
    formFactor = 'computer';
  } else if (/Linux/.test(s)) {
    platform = 'linux';
    formFactor = 'computer';
  }
  const browsers: Array<[string, RegExp]> = [
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/], ['Opera', /(?:OPR|OPT|Opera)\/([\d.]+)/], ['Edge', /Edg(?:A|iOS)?\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/], ['UC Browser', /UCBrowser\/([\d.]+)/], ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ];
  let browser: string | null = null;
  let browserVersion: string | null = null;
  for (const [name, re] of browsers) {
    const b = s.match(re);
    if (b) { browser = name; browserVersion = b[1]!.split('.')[0]!; break; }
  }
  if (/; wv\)/.test(s)) browser = `${browser ?? 'Browser'} (in-app)`;
  return { platform, osVersion: osVersion?.slice(0, 20) ?? null, formFactor, model: model ? text(model, 40) : null, browser, browserVersion };
}

/** A web page's report (from shared/device-report.js) plus the request's User-Agent. */
export function webReport(body: unknown, userAgent: string | undefined): DeviceReport {
  const b = (body ?? {}) as Record<string, unknown>;
  const ua = parseUserAgent(userAgent);
  const hintPlatform = text(b.platform, 20)?.toLowerCase() ?? null;
  const platform = ua.platform ?? (hintPlatform === 'android' ? 'android' : hintPlatform === 'ios' ? 'ios' : hintPlatform === 'windows' ? 'windows' : hintPlatform === 'macos' ? 'mac' : null);
  const width = number(b.screenW, 100, 10_000);
  const height = number(b.screenH, 100, 10_000);
  const dpr = number(b.dpr, 0.5, 8);
  const network = text(b.network, 10)?.toLowerCase() ?? null;
  return {
    source: 'web',
    platform,
    // Chrome's device hints are exact (model, full system version); the User-Agent is the fallback.
    osVersion: text(b.platformVersion, 20) ?? ua.osVersion,
    model: text(b.model, 40) ?? ua.model,
    formFactor: ua.formFactor ?? (bool(b.mobile) ? 'phone' : null),
    browser: ua.browser,
    browserVersion: ua.browserVersion,
    ramGb: number(b.ramGb, 0.1, 64),
    cpuCores: number(b.cores, 1, 128) === null ? null : Math.round(number(b.cores, 1, 128)!),
    network: network && ['slow-2g', '2g', '3g', '4g'].includes(network) ? network : null,
    saveData: bool(b.saveData),
    fromWhatsapp: bool(b.fromWhatsapp),
    language: text(b.language, 20),
    timeZone: text(b.timeZone, 40),
    screen: width && height ? `${Math.round(width)}x${Math.round(height)}${dpr ? `@${Math.round(dpr * 100) / 100}` : ''}` : null,
  };
}

/** The app's report (lib/device-report.ts in the app). */
export function appReport(body: unknown): DeviceReport {
  const b = (body ?? {}) as Record<string, unknown>;
  const platform = text(b.platform, 10)?.toLowerCase() ?? null;
  return {
    source: 'app',
    platform: platform === 'android' || platform === 'ios' ? platform : null,
    osVersion: text(b.osVersion, 20),
    maker: text(b.maker, 30),
    model: text(b.model, 40),
    formFactor: 'phone',
    appVersion: text(b.appVersion, 20),
    appBuild: text(b.appBuild, 20),
    language: text(b.language, 20),
    timeZone: text(b.timeZone, 40),
  };
}

/**
 * A Nigerian number's network from its prefix (approximate: numbers can be moved to another network).
 * +234 803… → MTN. Unknown prefixes and other countries: null.
 */
const PREFIXES: Array<[string, string[]]> = [
  ['MTN', ['0703', '0704', '0706', '07025', '07026', '0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916']],
  ['Airtel', ['0701', '0708', '0802', '0808', '0812', '0901', '0902', '0904', '0907', '0912', '0911']],
  ['Glo', ['0705', '0805', '0807', '0811', '0815', '0905', '0915']],
  ['9mobile', ['0809', '0817', '0818', '0908', '0909']],
];
export function phoneNetworkOf(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  const local = digits.startsWith('234') ? `0${digits.slice(3)}` : digits.startsWith('0') ? digits : null;
  if (!local || local.length !== 11) return null;
  for (const [name, list] of PREFIXES) if (list.some((p) => local.startsWith(p))) return name;
  return null;
}

/** One write per person per device every 10 minutes at most (a page reloaded ten times is one visit). */
const lastWrite = new Map<string, number>();
export function shouldRecord(userId: string, key: string, now = Date.now()): boolean {
  const k = `${userId}|${key}`;
  const last = lastWrite.get(k);
  if (last !== undefined && now - last < 10 * 60_000) return false;
  lastWrite.set(k, now);
  if (lastWrite.size > 50_000) lastWrite.clear();
  return true;
}
