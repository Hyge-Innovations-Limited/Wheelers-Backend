-- Waiting time: four nullable columns on Ride and a new value in two enums. Nothing existing changes.
-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'WAITING_FEE';

-- AlterEnum
ALTER TYPE "WalletReservationKind" ADD VALUE 'WAITING_FEE';

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "waitingFeeNgn" DECIMAL(18,2),
ADD COLUMN     "waitingMinutes" INTEGER,
ADD COLUMN     "waitingPaid" BOOLEAN,
ADD COLUMN     "waitingStoppedAt" TIMESTAMP(3);
