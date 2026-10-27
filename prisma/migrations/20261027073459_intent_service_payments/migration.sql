-- CreateTable
CREATE TABLE "ServicePayment" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "termsDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payloadCiphertext" TEXT NOT NULL,
    "txHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServicePayment_mode_cycleId_idx" ON "ServicePayment"("mode", "cycleId");
