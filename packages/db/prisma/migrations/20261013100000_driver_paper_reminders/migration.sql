-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "licenceRemindedAt" INTEGER;

-- AlterTable
ALTER TABLE "DriverDocument" ADD COLUMN     "remindedAt" INTEGER;
