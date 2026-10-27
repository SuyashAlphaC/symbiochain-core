-- CreateTable
CREATE TABLE "InferenceAttempt" (
    "cycleId" TEXT NOT NULL,
    "proposalDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evidenceCiphertext" TEXT NOT NULL,
    "resultCiphertext" TEXT,
    "billingRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InferenceAttempt_pkey" PRIMARY KEY ("cycleId")
);

-- AddForeignKey
ALTER TABLE "InferenceAttempt" ADD CONSTRAINT "InferenceAttempt_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
