-- A rider can pay for a ride from their Stellar (testnet) XLM balance, at the
-- live XLM→naira rate. The ride keeps the rate it was accepted at and the fare
-- in XLM, so the payment on Stellar and the receipt always agree. An XLM ride
-- moves no naira: the driver is paid in XLM on Stellar.

ALTER TYPE "RidePaymentMethod" ADD VALUE IF NOT EXISTS 'XLM';

ALTER TABLE "Ride"
  ADD COLUMN "xlmRateNgn" DECIMAL(18,2),
  ADD COLUMN "fareXlm"    DECIMAL(18,7);
