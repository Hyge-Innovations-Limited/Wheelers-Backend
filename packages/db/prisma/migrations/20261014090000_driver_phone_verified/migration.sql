-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "verifiedPhone" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Driver_verifiedPhone_idx" ON "Driver"("verifiedPhone");
