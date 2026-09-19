import { prisma }   from '../prisma';
import type { UserRole, ConsentType } from '@prisma/client';

export const userClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findById: (userId: string) =>
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { wallet: true },
    }),

  /** Lightweight batch lookup for labelling ids in admin views. */
  findManyByIds: (userIds: string[]) =>
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, phone: true, email: true, role: true },
    }),

  findByPrivyDid: (privyDid: string) =>
    prisma.user.findUnique({
      where: { privyDid },
      include: { wallet: true },
    }),

  findByUsername: (username: string) =>
    prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      include: { wallet: true },
    }),

  findByEmail: (email: string) =>
    prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      include: { wallet: true },
    }),

  // Email is not unique: a social-auth or WhatsApp-created row can share the
  // email of a password account. Password sign-in must only ever see rows that
  // can actually verify a password, or the hashless row shadows the real one.
  findByEmailWithPassword: (email: string) =>
    prisma.user.findFirst({
      where: { email: email.toLowerCase(), passwordHash: { not: null } },
      orderBy: { createdAt: 'desc' },
      include: { wallet: true },
    }),

  // Phone is not unique in the schema (an app account can verify the same
  // number a WhatsApp account was created with), so callers decide precedence.
  findByProviderCustomerId: (providerCustomerId: string) =>
    prisma.user.findUnique({ where: { providerCustomerId } }),

  findByPhone: (phone: string) =>
    prisma.user.findFirst({
      where: { phone },
      orderBy: { createdAt: 'asc' },
    }),

  // ── Writes ─────────────────────────────────────────────────────────────────

  create: (data: {
    privyDid:      string;
    username?:     string;
    passwordHash?: string;
    email?:        string;
    role:          UserRole;
    name?:         string;
    phone?:        string;
  }) =>
    prisma.user.create({
      data: {
        privyDid: data.privyDid,
        username: data.username,
        passwordHash: data.passwordHash,
        email: data.email,
        role: data.role,
        name: data.name,
        phone: data.phone,
      },
    }),

  updateAuthIdentity: (userId: string, data: {
    username?:     string;
    passwordHash?: string;
    email?:        string;
    name?:         string;
    phone?:        string;
  }) =>
    prisma.user.update({
      where: { id: userId },
      data: {
        username: data.username,
        passwordHash: data.passwordHash,
        email: data.email,
        name: data.name,
        phone: data.phone,
      },
      include: { wallet: true },
    }),

  updateProfile: (userId: string, data: {
    username?: string;
    email?:    string;
    name?:     string;
    phone?:    string;
    photoUrl?: string;
  }) =>
    prisma.user.update({
      where: { id: userId },
      data,
      include: { wallet: true },
    }),

  updateProviderCustomerId: (userId: string, providerCustomerId: string) =>
    prisma.user.update({
      where: { id: userId },
      data: { providerCustomerId },
    }),

  updateBvn: (userId: string, bvn: string) =>
    prisma.user.update({
      where: { id: userId },
      data: { bvn },
    }),

  upsertNotificationDevice: (userId: string, data: {
    expoPushToken: string;
    platform?: string;
    deviceName?: string;
    appOwnership?: string;
    enabled?: boolean;
  }) =>
    prisma.notificationDevice.upsert({
      where: {
        expoPushToken: data.expoPushToken,
      },
      create: {
        userId,
        expoPushToken: data.expoPushToken,
        platform: data.platform,
        deviceName: data.deviceName,
        appOwnership: data.appOwnership,
        enabled: data.enabled ?? true,
        lastRegisteredAt: new Date(),
      },
      update: {
        userId,
        platform: data.platform,
        deviceName: data.deviceName,
        appOwnership: data.appOwnership,
        enabled: data.enabled ?? true,
        lastRegisteredAt: new Date(),
      },
    }),

  listActiveNotificationDevices: (userId: string) =>
    prisma.notificationDevice.findMany({
      where: {
        userId,
        enabled: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    }),

  disableNotificationDevice: (expoPushToken: string) =>
    prisma.notificationDevice.updateMany({
      where: { expoPushToken },
      data: { enabled: false },
    }),

  touchNotificationDeviceDelivery: (expoPushToken: string) =>
    prisma.notificationDevice.updateMany({
      where: { expoPushToken },
      data: { lastDeliveredAt: new Date() },
    }),

  updateRole: (userId: string, role: UserRole) =>
    prisma.user.update({
      where: { id: userId },
      data: { role },
    }),

  // ── Consent ────────────────────────────────────────────────────────────────

  findActiveConsent: (userId: string, consentType: ConsentType, consentVersion: string) =>
    prisma.userConsent.findFirst({
      where: {
        userId,
        consentType,
        consentVersion,
        revokedAt: null,
      },
    }),

  hasRecordingConsent: async (userId: string, consentVersion = 'v1.0') => {
    const consent = await prisma.userConsent.findFirst({
      where: {
        userId,
        consentType: 'RECORDING',
        consentVersion,
        revokedAt:   null,
      },
    });
    return consent !== null;
  },

  logConsent: (data: {
    userId:          string;
    consentType:     ConsentType;
    consentVersion:  string;
  }) =>
    prisma.userConsent.create({ data }),

  revokeConsent: (userId: string, consentType: ConsentType) =>
    prisma.userConsent.updateMany({
      where:  { userId, consentType, revokedAt: null },
      data:   { revokedAt: new Date() },
    }),

  /**
   * Soft-delete a user account by anonymizing PII and clearing auth credentials.
   * The row stays for referential integrity but is no longer usable.
   */
  softDelete: (userId: string) =>
    prisma.$transaction([
      // Anonymize user PII
      prisma.user.update({
        where: { id: userId },
        data: {
          username: null,
          passwordHash: null,
          name: 'Deleted User',
          email: null,
          phone: null,
          photoUrl: null,
          bvn: null,
          privyDid: `deleted:${userId}:${Date.now()}`,
        },
      }),
      // Disable all notification devices
      prisma.notificationDevice.updateMany({
        where: { userId },
        data: { enabled: false },
      }),
      // Revoke all active consents
      prisma.userConsent.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]),
};
