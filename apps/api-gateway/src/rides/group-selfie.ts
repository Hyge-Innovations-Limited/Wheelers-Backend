import { prisma } from '@wheleers/db';

/**
 * The rider's group ride selfie (Timi, 17 Nov 2026): taken on their first group ride, then reused. One that passed
 * the face check for the old group ride counts too, so nobody who already sent one is asked again.
 */
export async function hasGroupSelfie(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { groupSelfieAt: true } }).catch(() => null);
  if (user?.groupSelfieAt) return true;
  const old = await prisma.groupRideFaceVerification.findFirst({ where: { userId, uploadStatus: 'STORED' }, select: { id: true } }).catch(() => null);
  return Boolean(old);
}

/** The stored selfie's key (the new one, else the newest from the old group ride), for showing the face to the group. */
export async function groupSelfieKey(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { groupSelfieKey: true } }).catch(() => null);
  if (user?.groupSelfieKey) return user.groupSelfieKey;
  const old = await prisma.groupRideFaceVerification.findFirst({ where: { userId, uploadStatus: 'STORED' }, orderBy: { storedAt: 'desc' }, select: { objectKey: true } }).catch(() => null);
  return old?.objectKey ?? null;
}

export async function saveGroupSelfie(userId: string, objectKey: string, at: Date = new Date()): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { groupSelfieKey: objectKey, groupSelfieAt: at } });
}
