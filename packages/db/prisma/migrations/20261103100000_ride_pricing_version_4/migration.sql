-- New rides settle by pricing version 4 (no booking fee; the WhatsApp fee off the fare, then VAT, levy and commission from the rest).
-- Only the default for new rows changes; every existing ride keeps its version. The app names the version on create anyway.
ALTER TABLE "Ride" ALTER COLUMN "pricingVersion" SET DEFAULT 4;
