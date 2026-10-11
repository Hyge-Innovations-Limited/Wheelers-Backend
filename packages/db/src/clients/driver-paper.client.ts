import { prisma } from '../prisma';

/** The papers a driver keeps for their car, and the name and licence details they typed. */
export const driverPaperClient = {
  listForDriver: (driverId: string) =>
    prisma.driverDocument.findMany({ where: { driverId }, orderBy: { uploadedAt: 'asc' } }),

  find: (driverId: string, type: string) =>
    prisma.driverDocument.findUnique({ where: { driverId_type: { driverId, type } } }),

  /**
   * A paper sent (or sent again): the new file replaces the old, and it goes
   * back to waiting for review whatever it was before.
   */
  save: (input: { driverId: string; type: string; fileKey: string; fileType: string; number: string | null; expiresOn: Date | null }) =>
    prisma.driverDocument.upsert({
      where: { driverId_type: { driverId: input.driverId, type: input.type } },
      create: { driverId: input.driverId, type: input.type, fileKey: input.fileKey, fileType: input.fileType, number: input.number, expiresOn: input.expiresOn },
      update: {
        fileKey: input.fileKey, fileType: input.fileType, number: input.number, expiresOn: input.expiresOn,
        status: 'PENDING', rejectionReason: null, uploadedAt: new Date(), reviewedAt: null, reviewedBy: null, remindedAt: null,
      },
    }),

  /** An admin's answer on one paper. */
  review: (driverId: string, type: string, decision: { status: 'APPROVED' | 'REJECTED'; reason: string | null; by: string }) =>
    prisma.driverDocument.update({
      where: { driverId_type: { driverId, type } },
      data: { status: decision.status, rejectionReason: decision.status === 'REJECTED' ? decision.reason : null, reviewedAt: new Date(), reviewedBy: decision.by.slice(0, 120) },
    }),

  details: (driverId: string) =>
    prisma.driver.findUnique({ where: { id: driverId }, select: { legalName: true, licenceNumber: true, licenceExpiresOn: true } }),

  saveDetails: (driverId: string, details: { legalName: string; licenceNumber: string; licenceExpiresOn: Date }) =>
    prisma.driver.update({ where: { id: driverId }, data: { ...details, licenceRemindedAt: null }, select: { legalName: true, licenceNumber: true, licenceExpiresOn: true } }),

  /**
   * The admin's lists. `waiting`: sent and not yet looked at, oldest first.
   * `expiring`: good, but running out on or before `soon`. `expired`: past
   * its date. `sentBack`: rejected and not yet sent again.
   */
  queue: (filter: 'waiting' | 'expiring' | 'expired' | 'sentBack', today: Date, soon: Date, limit = 200) =>
    prisma.driverDocument.findMany({
      where: filter === 'waiting' ? { status: 'PENDING', OR: [{ expiresOn: null }, { expiresOn: { gte: today } }] }
        : filter === 'expiring' ? { status: { not: 'REJECTED' }, expiresOn: { gte: today, lte: soon } }
          : filter === 'expired' ? { expiresOn: { lt: today } }
            : { status: 'REJECTED' },
      orderBy: filter === 'waiting' ? { uploadedAt: 'asc' } : filter === 'sentBack' ? { reviewedAt: 'desc' } : { expiresOn: 'asc' },
      take: limit,
      include: { driver: { select: { id: true, legalName: true, kycStatus: true, user: { select: { name: true, phone: true } } } } },
    }),

  counts: async (today: Date, soon: Date) => {
    const [waiting, expiring, expired, sentBack] = await Promise.all([
      prisma.driverDocument.count({ where: { status: 'PENDING', OR: [{ expiresOn: null }, { expiresOn: { gte: today } }] } }),
      prisma.driverDocument.count({ where: { status: { not: 'REJECTED' }, expiresOn: { gte: today, lte: soon } } }),
      prisma.driverDocument.count({ where: { expiresOn: { lt: today } } }),
      prisma.driverDocument.count({ where: { status: 'REJECTED' } }),
    ]);
    return { waiting, expiring, expired, sentBack };
  },

  /** Papers with a date on or before `until` (running out, or already out), with whose they are: what reminders are sent from. */
  dueForReminder: (until: Date) =>
    prisma.driverDocument.findMany({
      where: { expiresOn: { lte: until }, status: { not: 'REJECTED' } },
      select: { id: true, driverId: true, type: true, expiresOn: true, remindedAt: true, driver: { select: { userId: true } } },
    }),

  markReminded: (id: string, remindedAt: number) =>
    prisma.driverDocument.update({ where: { id }, data: { remindedAt } }),

  licencesDueForReminder: (until: Date) =>
    prisma.driver.findMany({
      where: { licenceExpiresOn: { lte: until } },
      select: { id: true, userId: true, licenceExpiresOn: true, licenceRemindedAt: true },
    }),

  markLicenceReminded: (driverId: string, remindedAt: number) =>
    prisma.driver.update({ where: { id: driverId }, data: { licenceRemindedAt: remindedAt } }),
};
