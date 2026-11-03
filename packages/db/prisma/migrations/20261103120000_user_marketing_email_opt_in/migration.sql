-- The Welcome form's optional tick: news and offers by email. Expand only.
ALTER TABLE "User" ADD COLUMN "marketingEmailOptIn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "marketingEmailOptInAt" TIMESTAMP(3);
