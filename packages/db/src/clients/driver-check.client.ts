import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export type DriverCheckInput = {
  driverId: string;
  kind: string;
  paperType?: string | null;
  source: string;
  input?: string | null;
  outcome: string;
  mismatches?: string[];
  found?: Prisma.InputJsonValue | null;
  reference?: string | null;
  note?: string | null;
  byId?: string | null;
  byName: string;
};

/** Checks of drivers' licences and cars: Prembly's, and the ones admins did by hand. */
export const driverCheckClient = {
  record: (input: DriverCheckInput) =>
    prisma.driverCheck.create({
      data: {
        driverId: input.driverId,
        kind: input.kind,
        paperType: input.paperType ?? null,
        source: input.source,
        input: input.input ?? null,
        outcome: input.outcome,
        mismatches: input.mismatches ?? [],
        ...(input.found ? { found: input.found } : {}),
        reference: input.reference ?? null,
        note: input.note ?? null,
        byId: input.byId ?? null,
        byName: input.byName.slice(0, 120),
      },
    }),

  listForDriver: (driverId: string, limit = 50) =>
    prisma.driverCheck.findMany({ where: { driverId }, orderBy: { createdAt: 'desc' }, take: limit }),

  /** The newest answer for this check on this input since `since`, not counting ones that failed to reach the provider. */
  recent: (driverId: string, kind: string, input: string, since: Date) =>
    prisma.driverCheck.findFirst({
      where: { driverId, kind, input, createdAt: { gte: since }, outcome: { not: 'error' } },
      orderBy: { createdAt: 'desc' },
    }),

  /** Checks from one source since a date: what has been spent on Prembly this month. */
  countSince: (source: string, since: Date) =>
    prisma.driverCheck.count({ where: { source, createdAt: { gte: since }, outcome: { not: 'error' } } }),

  /** Each driver's checks, newest first: the lists show the latest of each kind. */
  forDrivers: (driverIds: string[]) =>
    driverIds.length === 0 ? Promise.resolve([]) : prisma.driverCheck.findMany({
      where: { driverId: { in: driverIds } },
      orderBy: { createdAt: 'desc' },
      select: { driverId: true, kind: true, paperType: true, source: true, outcome: true, createdAt: true },
    }),
};
