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

  /** The newest answer for this check on this input since `since`, not counting ones that failed or are still running. */
  recent: (driverId: string, kind: string, input: string, since: Date) =>
    prisma.driverCheck.findFirst({
      where: { driverId, kind, input, createdAt: { gte: since }, outcome: { notIn: ['error', 'pending'] } },
      orderBy: { createdAt: 'desc' },
    }),

  /** This check on this input still running, started since `since`: pressing again joins it instead of paying twice. */
  running: (driverId: string, kind: string, input: string, since: Date) =>
    prisma.driverCheck.findFirst({
      where: { driverId, kind, input, outcome: 'pending', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    }),

  /** A running check's answer. */
  finish: (id: string, answer: { outcome: string; mismatches?: string[]; found?: Prisma.InputJsonValue | null; reference?: string | null; note?: string | null }) =>
    prisma.driverCheck.update({
      where: { id },
      data: {
        outcome: answer.outcome,
        mismatches: answer.mismatches ?? [],
        ...(answer.found ? { found: answer.found } : {}),
        reference: answer.reference ?? null,
        note: answer.note ?? null,
      },
    }),

  /** Checks still running from before `before` never got their answer (the server restarted): they become errors. */
  expireRunning: (driverId: string, before: Date, note: string) =>
    prisma.driverCheck.updateMany({
      where: { driverId, outcome: 'pending', createdAt: { lt: before } },
      data: { outcome: 'error', note },
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
