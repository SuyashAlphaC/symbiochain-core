-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('PAPER', 'LIVE', 'REPLAY');

-- CreateEnum
CREATE TYPE "CycleState" AS ENUM ('DISCOVERED', 'QUOTED', 'ASSESSED', 'RESERVED', 'SUBMITTED', 'SETTLING', 'RECONCILED', 'CLOSED', 'REJECTED', 'EXPIRED', 'REFUNDED', 'UNKNOWN', 'FAILED');

-- CreateTable
CREATE TABLE "Cycle" (
    "id" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "state" "CycleState" NOT NULL DEFAULT 'DISCOVERED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "proposal" JSONB NOT NULL,
    "quote" JSONB,
    "assessment" JSONB,
    "submission" JSONB,
    "settlement" JSONB,
    "rejection" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proof" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT,
    "requestHash" TEXT,
    "responseHash" TEXT,
    "signer" TEXT,
    "measurement" TEXT,
    "evidenceCiphertext" TEXT,
    "publicDetails" JSONB NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainTransaction" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amountAtoms" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "blockNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "mode" "ExecutionMode" NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "maxTradeAtoms" DECIMAL(78,0) NOT NULL,
    "maxDailySpendAtoms" DECIMAL(78,0) NOT NULL,
    "minReserveAtoms" DECIMAL(78,0) NOT NULL,
    "minNetProfitAtoms" DECIMAL(78,0) NOT NULL,
    "maxSlippageBps" INTEGER NOT NULL,
    "allowedAssets" TEXT[],
    "allowedChains" TEXT[],
    "allowedRecipients" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("mode")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "amountAtoms" DECIMAL(78,0) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Journal" (
    "id" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cycleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Posting" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amountAtoms" DECIMAL(78,0) NOT NULL,

    CONSTRAINT "Posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputeUsage" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "requestId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsdMicros" TEXT NOT NULL,
    "billingSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComputeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerControl" (
    "role" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "heartbeat" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerControl_pkey" PRIMARY KEY ("role")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "seq" BIGSERIAL NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "topic" TEXT NOT NULL,
    "cycleId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "Cycle_mode_state_createdAt_idx" ON "Cycle"("mode", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Cycle_mode_idempotencyKey_key" ON "Cycle"("mode", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Decision_cycleId_createdAt_idx" ON "Decision"("cycleId", "createdAt");

-- CreateIndex
CREATE INDEX "Proof_cycleId_idx" ON "Proof"("cycleId");

-- CreateIndex
CREATE INDEX "ChainTransaction_cycleId_idx" ON "ChainTransaction"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "ChainTransaction_chainId_txHash_operation_key" ON "ChainTransaction"("chainId", "txHash", "operation");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_cycleId_key" ON "Reservation"("cycleId");

-- CreateIndex
CREATE INDEX "Reservation_mode_status_createdAt_idx" ON "Reservation"("mode", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Journal_mode_kind_idx" ON "Journal"("mode", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Journal_mode_reference_key" ON "Journal"("mode", "reference");

-- CreateIndex
CREATE INDEX "Posting_account_asset_idx" ON "Posting"("account", "asset");

-- CreateIndex
CREATE UNIQUE INDEX "ComputeUsage_requestId_key" ON "ComputeUsage"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupKey_key" ON "Job"("dedupKey");

-- CreateIndex
CREATE INDEX "Job_lane_availableAt_leaseUntil_idx" ON "Job"("lane", "availableAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "OutboxEvent_mode_seq_idx" ON "OutboxEvent"("mode", "seq");

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChainTransaction" ADD CONSTRAINT "ChainTransaction_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journal" ADD CONSTRAINT "Journal_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Posting" ADD CONSTRAINT "Posting_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeUsage" ADD CONSTRAINT "ComputeUsage_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
