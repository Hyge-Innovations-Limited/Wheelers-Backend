import { loadWorkspaceEnv, validateNotificationEnv, validateSharedEnv } from '@wheleers/config';
import { prisma, userClient, type NotificationDevice } from '@wheleers/db';
import { createConsumer } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS, type PushSendEvent } from '@wheleers/kafka-schemas';

const SERVICE_ID = 'notification-worker';
const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:9092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  const notificationEnv = validateNotificationEnv();

  const consumer = await createConsumer({ groupId: SERVICE_ID });

  await consumer.subscribe([TOPICS.NOTIFICATION_EVENTS], async (value) => {
    const event = safeParseKafkaEvent(TOPICS.NOTIFICATION_EVENTS, value);
    if (!event) return;

    if (event.eventType === 'PUSH_SEND') {
      await handlePushSend(event, notificationEnv.EXPO_ACCESS_TOKEN);
    }

    if (event.eventType === 'IN_APP_SEND') {
      try {
        await prisma.notification.create({
          data: {
            id: event.notificationId,
            userId: event.userId,
            title: event.title,
            body: event.body,
            category: categoryToDb(event.category),
            referenceId: event.referenceId ?? null,
            referenceType: event.referenceType ?? null,
            read: event.read ?? false,
          } as any,
        });
      } catch (err) {
        console.warn(`[${SERVICE_ID}] notification create failed:`, (err as any)?.message ?? err);
      }
    }

    console.log(`[${SERVICE_ID}] ${event.eventType} -> user=${event.userId}`);
  });

  console.log(`[${SERVICE_ID}] consuming — Expo pushes ${notificationEnv.EXPO_ACCESS_TOKEN ? 'WITH an access token' : 'without an access token (fine unless Expo enhanced security is on)'}`);
}

function categoryToDb(category: string): any {
  // Prisma enum is NotificationCategory (RIDE, PAYMENT, ...)
  switch (category) {
    case 'ride':
      return 'RIDE';
    case 'payment':
      return 'PAYMENT';
    case 'wallet':
      return 'WALLET';
    case 'dispute':
      return 'DISPUTE';
    case 'kyc':
      return 'KYC';
    case 'system':
    default:
      return 'SYSTEM';
  }
}

async function handlePushSend(
  event: PushSendEvent,
  expoAccessToken: string | undefined,
): Promise<void> {
  const devices = await userClient.listActiveNotificationDevices(event.userId);
  if (devices.length === 0) {
    return;
  }

  const messages = devices.map((device: NotificationDevice) => ({
    to: device.expoPushToken,
    title: event.title,
    body: event.body,
    data: event.data,
    priority: event.priority === 'high' ? 'high' : 'default',
    sound: 'default',
  }));

  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      // Only a REAL token. This used to default to "Bearer dev", which Expo
      // rejects outright — so with no token configured, every push to every
      // driver and rider failed with 401. No header at all is accepted.
      ...(expoAccessToken ? { authorization: `Bearer ${expoAccessToken}` } : {}),
    },
    body: JSON.stringify(messages),
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        data?: Array<{
          status?: string;
          details?: {
            error?: string;
          };
        }>;
        errors?: Array<{ message?: string }>;
      }
    | null;

  if (!response.ok) {
    const message =
      payload?.errors?.map((error) => error.message).filter(Boolean).join('; ') ||
      `Expo push send failed with status ${response.status}`;
    throw new Error(message);
  }

  const results = Array.isArray(payload?.data) ? payload.data : [];
  await Promise.all(
    devices.map(async (device: NotificationDevice, index: number) => {
      const result = results[index];
      if (!result) {
        return;
      }

      if (result.status === 'ok') {
        await userClient.touchNotificationDeviceDelivery(device.expoPushToken);
        return;
      }

      if (result.details?.error === 'DeviceNotRegistered') {
        await userClient.disableNotificationDevice(device.expoPushToken);
        return;
      }

      console.warn(
        `[${SERVICE_ID}] push delivery warning token=${device.expoPushToken} status=${result.status ?? 'unknown'} error=${result.details?.error ?? 'unknown'}`,
      );
    }),
  );
}
