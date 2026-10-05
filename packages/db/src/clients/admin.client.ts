import { prisma } from '../prisma';
import type { AdminRole } from '@prisma/client';

export const adminClient = {
  findByUsername: (username: string) =>
    prisma.adminUser.findUnique({ where: { username } }),

  findById: (id: string) =>
    prisma.adminUser.findUnique({ where: { id } }),

  create: (data: { username: string; passwordHash: string; name: string; role?: AdminRole }) =>
    prisma.adminUser.create({ data }),

  list: () =>
    prisma.adminUser.findMany({
      where: { active: true },
      select: { id: true, username: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),

  /**
   * Changes an admin's role, refusing to leave the dashboard with no owner:
   * the last active owner cannot be made staff. Null when refused.
   */
  setRole: (id: string, role: AdminRole) =>
    prisma.$transaction(async (tx) => {
      if (role === 'STAFF') {
        const owners = await tx.adminUser.count({ where: { role: 'OWNER', active: true, id: { not: id } } });
        if (owners === 0) return null;
      }
      return tx.adminUser.update({ where: { id }, data: { role } });
    }),

  deactivate: (id: string) =>
    prisma.adminUser.update({ where: { id }, data: { active: false } }),

  updatePassword: (id: string, passwordHash: string) =>
    prisma.adminUser.update({ where: { id }, data: { passwordHash } }),
};
