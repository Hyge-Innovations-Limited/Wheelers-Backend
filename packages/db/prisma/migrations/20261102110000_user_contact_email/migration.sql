-- Expand only: a contact email typed on WhatsApp. Unverified; never used to sign in or link accounts.
ALTER TABLE "User" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "User" ADD COLUMN "contactEmailAt" TIMESTAMP(3);
