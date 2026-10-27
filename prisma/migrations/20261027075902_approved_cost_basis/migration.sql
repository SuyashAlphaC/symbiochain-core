-- CreateTable
CREATE TABLE "CostBasis" (
    "cycleId" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "termsDigest" TEXT NOT NULL,
    "settlementDigest" TEXT NOT NULL,
    "inferenceCostUsdMicros" TEXT NOT NULL,
    "computeBaseAtoms" TEXT NOT NULL,
    "nativeGasBaseAtoms" TEXT NOT NULL,
    "hostingBaseAtoms" TEXT NOT NULL,
    "otherBaseAtoms" TEXT NOT NULL,
    "receiptBudgetBaseAtoms" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "sourceEvidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostBasis_pkey" PRIMARY KEY ("cycleId")
);

-- AddForeignKey
ALTER TABLE "CostBasis" ADD CONSTRAINT "CostBasis_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
