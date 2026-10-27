-- CreateTable
CREATE TABLE "ComputeAccount" (
    "mode" "ExecutionMode" NOT NULL,
    "remainingNanoUsd" TEXT NOT NULL,
    "providerEvidence" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComputeAccount_pkey" PRIMARY KEY ("mode")
);
