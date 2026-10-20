-- A dashboard role for the support team: the inbox, people's app activity
-- and trips, with no money, bank details or identity documents.
ALTER TYPE "AdminRole" ADD VALUE IF NOT EXISTS 'SUPPORT';
