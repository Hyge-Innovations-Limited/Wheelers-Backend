import { prisma } from '../prisma';

/**
 * The devices a person uses (UserDevice): one row per kind of device, the latest details kept, how often
 * and when it was seen. Collected only, for their admin profile.
 */
export type DeviceReport = {
  source: 'app' | 'web' | 'whatsapp';
  platform?: string | null;
  osVersion?: string | null;
  maker?: string | null;
  model?: string | null;
  formFactor?: string | null;
  browser?: string | null;
  browserVersion?: string | null;
  appVersion?: string | null;
  appBuild?: string | null;
  ramGb?: number | null;
  cpuCores?: number | null;
  network?: string | null;
  saveData?: boolean | null;
  fromWhatsapp?: boolean | null;
  language?: string | null;
  timeZone?: string | null;
  screen?: string | null;
  phoneNetwork?: string | null;
  formsOpen?: boolean | null;
};

/** Which row a report belongs to: the same phone and browser (or app) is one row however often it is seen. */
export function deviceKey(r: DeviceReport): string {
  if (r.source === 'whatsapp') return 'whatsapp';
  const what = r.source === 'app' ? 'app' : (r.browser ?? 'browser');
  return [r.source, r.platform ?? 'other', r.model ?? r.formFactor ?? '', what].join(':').toLowerCase().slice(0, 190);
}

/** Only the fields the report has: a later report without a field never blanks one already known. */
function known(r: DeviceReport): Record<string, unknown> {
  const { source: _source, ...rest } = r;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export const userDeviceClient = {
  async record(userId: string, report: DeviceReport, now = new Date()) {
    const key = deviceKey(report);
    const fields = known(report);
    return prisma.userDevice.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, source: report.source, key, ...fields, firstSeenAt: now, lastSeenAt: now },
      update: { ...fields, lastSeenAt: now, timesSeen: { increment: 1 } },
    });
  },

  listByUser(userId: string) {
    return prisma.userDevice.findMany({ where: { userId }, orderBy: { lastSeenAt: 'desc' }, take: 20 });
  },

  /** People's main system for the Users list (their most recent app or web device). */
  async platformsFor(userIds: string[]): Promise<Map<string, { platform: string | null; model: string | null; source: string }>> {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.userDevice.findMany({
      where: { userId: { in: userIds }, source: { in: ['app', 'web'] } },
      orderBy: { lastSeenAt: 'desc' },
      select: { userId: true, platform: true, model: true, source: true },
    });
    const out = new Map<string, { platform: string | null; model: string | null; source: string }>();
    for (const r of rows) if (!out.has(r.userId)) out.set(r.userId, { platform: r.platform, model: r.model, source: r.source });
    return out;
  },

  /** Ids of people whose latest app or web device is on this system (the Users list filter). */
  async userIdsOnPlatform(platform: 'android' | 'ios' | 'computer'): Promise<string[]> {
    const where = platform === 'computer' ? { formFactor: 'computer' } : { platform, NOT: { formFactor: 'computer' } };
    const rows = await prisma.userDevice.findMany({ where: { ...where, source: { in: ['app', 'web'] } }, select: { userId: true }, distinct: ['userId'] });
    return rows.map((r) => r.userId);
  },
};
