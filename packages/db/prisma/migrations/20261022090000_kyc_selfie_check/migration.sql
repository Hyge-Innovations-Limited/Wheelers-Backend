-- How the driver's selfie was taken: "passed" (the phone's face check: look
-- straight, eyes, turning), "skipped" (they went on without it), "unavailable"
-- (the app or phone could not run it). Null: an app from before it existed.
ALTER TABLE "DriverKycSubmission" ADD COLUMN "selfieCheck" TEXT;
