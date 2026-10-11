import { prisma } from '../prisma';

/** The papers a driver keeps for their car, and the name and licence details they typed. */
export const driverPaperClient = {
  listForDriver: (driverId: string) =>
    prisma.driverDocument.findMany({ where: { driverId }, orderBy: { uploadedAt: 'asc' } }),

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
        status: 'PENDING', rejectionReason: null, uploadedAt: new Date(), reviewedAt: null, reviewedBy: null,
      },
    }),

  details: (driverId: string) =>
    prisma.driver.findUnique({ where: { id: driverId }, select: { legalName: true, licenceNumber: true, licenceExpiresOn: true } }),

  saveDetails: (driverId: string, details: { legalName: string; licenceNumber: string; licenceExpiresOn: Date }) =>
    prisma.driver.update({ where: { id: driverId }, data: details, select: { legalName: true, licenceNumber: true, licenceExpiresOn: true } }),
};
