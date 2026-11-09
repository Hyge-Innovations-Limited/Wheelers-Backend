-- An admin can sign a person out of every phone: logins made before this
-- moment are refused. Empty for everyone until it is used.
ALTER TABLE "User" ADD COLUMN "sessionsEndedAt" TIMESTAMP(3);
