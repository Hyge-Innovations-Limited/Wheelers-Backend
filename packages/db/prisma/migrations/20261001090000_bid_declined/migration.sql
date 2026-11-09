-- A rider can decline every offer on the table ("Decline all"): those bids
-- are DECLINED, not left PENDING until the search times out.
ALTER TYPE "DriverBidStatus" ADD VALUE IF NOT EXISTS 'DECLINED';
