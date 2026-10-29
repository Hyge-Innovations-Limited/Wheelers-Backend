-- The Android notification channel a phone created ("rides"); null for apps that did not say. Additive.
ALTER TABLE "NotificationDevice" ADD COLUMN "androidChannelId" TEXT;
