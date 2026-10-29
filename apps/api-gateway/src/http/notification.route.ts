import type { IncomingMessage, ServerResponse } from 'http';
import { complianceClient, userClient } from '@wheleers/db';
import { authenticateHttpUser } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import { getString, isRecord } from '../utils/object';
import { logActivity } from '../analytics/log-activity';

interface NotificationRouteDeps {
  jwtSecret: string;
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 50;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 50;
  }

  return Math.min(parsed, 100);
}

function serializeNotification(item: Awaited<ReturnType<typeof complianceClient.listNotifications>>[number]) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    category: item.category.toLowerCase(),
    referenceId: item.referenceId ?? null,
    referenceType: item.referenceType ?? null,
    read: item.read,
    createdAt: item.createdAt.toISOString(),
  };
}

function normalizePushToken(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('expoPushToken is required.');
  }

  const trimmed = value.trim();
  if (!/^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/i.test(trimmed)) {
    throw new Error('expoPushToken must be a valid Expo push token.');
  }

  return trimmed;
}

function getNotificationIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

export async function handleListNotificationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: NotificationRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const limit = parseLimit(url.searchParams.get('limit'));
    const items = await complianceClient.listNotifications(user.id, limit);

    sendJson(res, 200, {
      items: items.map((item) => serializeNotification(item)),
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not load notifications.',
    });
  }
}

export async function handleMarkNotificationsReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: NotificationRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req).catch(() => ({}));
    const notificationIds = isRecord(rawBody)
      ? getNotificationIds(rawBody['notificationIds'])
      : [];

    const result =
      notificationIds.length > 0
        ? await complianceClient.markNotificationsRead(user.id, notificationIds)
        : await complianceClient.markAllNotificationsRead(user.id);

    logActivity({
      userId: user.id,
      eventType: 'notifications_read',
      metadata: { count: result.count },
    });

    sendJson(res, 200, {
      updatedCount: result.count,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not mark notifications as read.',
    });
  }
}

export async function handleRegisterPushTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: NotificationRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);

    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const expoPushToken = normalizePushToken(rawBody['expoPushToken']);
    const enabled = rawBody['enabled'] !== false;
    const platform = getString(rawBody, 'platform');
    const deviceName = getString(rawBody, 'deviceName');
    const appOwnership = getString(rawBody, 'appOwnership');
    // A bad channel name is dropped, never a reason to lose the token.
    const channelRaw = getString(rawBody, 'androidChannel')?.trim();
    const androidChannel = channelRaw && /^[A-Za-z0-9_.-]{1,64}$/.test(channelRaw) ? channelRaw : undefined;

    const device = await userClient.upsertNotificationDevice(user.id, {
      expoPushToken,
      enabled,
      platform,
      deviceName,
      appOwnership,
      ...(androidChannel ? { androidChannelId: androidChannel } : {}),
    });

    sendJson(res, 200, {
      device: {
        id: device.id,
        expoPushToken: device.expoPushToken,
        enabled: device.enabled,
        platform: device.platform ?? null,
        deviceName: device.deviceName ?? null,
        appOwnership: device.appOwnership ?? null,
        lastRegisteredAt: device.lastRegisteredAt.toISOString(),
      },
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not register the push token.',
    });
  }
}
