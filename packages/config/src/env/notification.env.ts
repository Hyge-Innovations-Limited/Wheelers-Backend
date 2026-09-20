import { z } from 'zod';

const NotificationEnvSchema = z.object({
  // Expo push notifications. OPTIONAL: Expo accepts pushes with no token at
  // all unless "enhanced security" is switched on for the project. What it
  // does NOT accept is a wrong one — a placeholder here gets every push
  // rejected with 401 "The bearer token is invalid".
  EXPO_ACCESS_TOKEN:     z.string().optional().transform((v) => {
    const token = v?.trim();
    return token && token !== 'dev' ? token : undefined;
  }),
  // Rate limiting — max pushes per user per minute
  PUSH_RATE_LIMIT:       z.string().default('10'),
});

export type NotificationEnv = z.infer<typeof NotificationEnvSchema>;

export function validateNotificationEnv(): NotificationEnv {
  const result = NotificationEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] notification-worker env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
