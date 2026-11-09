-- Privacy-policy consent for WhatsApp riders. Additive.
-- Everyone starts PENDING, including existing riders: none of them was ever
-- asked, so the bot asks once on their next message.
CREATE TYPE "PrivacyConsent" AS ENUM ('PENDING', 'AGREED', 'DECLINED');

ALTER TABLE "User"
  ADD COLUMN "privacyConsent"   "PrivacyConsent" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "privacyConsentAt" TIMESTAMP(3);
