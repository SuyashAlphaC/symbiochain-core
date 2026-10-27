-- AlterTable
ALTER TABLE "LiveLeg" ADD COLUMN     "broadcastAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastBroadcastAt" TIMESTAMP(3),
ADD COLUMN     "lastBroadcastError" TEXT;
