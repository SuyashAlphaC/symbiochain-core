BEGIN;
-- CreateTable
CREATE TABLE "BusinessEntry" (
    "id" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amountAtoms" DECIMAL(78,0) NOT NULL,
    "termsDigest" TEXT NOT NULL,
    "sourceKey" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEntry_sourceKey_key" ON "BusinessEntry"("sourceKey");

-- CreateIndex
CREATE INDEX "BusinessEntry_mode_kind_createdAt_idx" ON "BusinessEntry"("mode", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEntry_mode_reference_key" ON "BusinessEntry"("mode", "reference");

ALTER TABLE "BusinessEntry" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "BusinessEntry" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "BusinessEntry" FROM %I', r);
    END IF;
  END LOOP;
END $$;
COMMIT;
