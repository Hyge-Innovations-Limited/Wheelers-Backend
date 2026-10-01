import { loadWorkspaceEnv, validateNotificationEnv, validateSharedEnv } from '@wheleers/config';
import { prisma, userClient, type NotificationDevice } from '@wheleers/db';
import { createConsumer } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS, type PushSendEvent } from '@wheleers/kafka-schemas';
import { sendPush } from './expo-push';

const SERVICE_ID = 'notification-worker';

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

    // PUSH_SEND says for itself what happened (sent to how many phones, or none registered).
    if (event.eventType !== 'PUSH_SEND') console.log(`[${SERVICE_ID}] ${event.eventType} -> user=${event.userId}`);
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
  await sendPush(
    {
      fetch,
      accessToken: expoAccessToken,
      markDelivered: (token) => userClient.touchNotificationDeviceDelivery(token),
      disable: (token) => userClient.disableNotificationDevice(token),
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
      later: (fn, ms) => { setTimeout(() => void fn(), ms).unref(); },
    },
    event.userId,
    devices.map((device: NotificationDevice) => ({ expoPushToken: device.expoPushToken })),
    { title: event.title, body: event.body, data: event.data, priority: event.priority },
  );
}
