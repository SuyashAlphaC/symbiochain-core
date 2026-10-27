-- CreateTable
CREATE TABLE "LiveLeg" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "leg" INTEGER NOT NULL,
    "termsDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payloadCiphertext" TEXT NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveLeg_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveLeg_cycleId_leg_key" ON "LiveLeg"("cycleId", "leg");

-- AddForeignKey
ALTER TABLE "LiveLeg" ADD CONSTRAINT "LiveLeg_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
