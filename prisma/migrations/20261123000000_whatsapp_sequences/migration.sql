-- سلاسل رسايل واتساب (Drip) + اللي مشتركين فيها
CREATE TABLE IF NOT EXISTS "whatsapp_sequences" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "triggerTag" TEXT,
  "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_sequences_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "whatsapp_sequences_tenantId_idx" ON "whatsapp_sequences"("tenantId");
CREATE INDEX IF NOT EXISTS "whatsapp_sequences_enabled_idx" ON "whatsapp_sequences"("enabled");

CREATE TABLE IF NOT EXISTS "whatsapp_sequence_enrollments" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sequenceId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "stepIndex" INTEGER NOT NULL DEFAULT 0,
  "nextAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "stopReason" TEXT,
  "lastError" TEXT,
  "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSentAt" TIMESTAMP(3),
  CONSTRAINT "whatsapp_sequence_enrollments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_sequence_enrollments_sequenceId_phone_key" ON "whatsapp_sequence_enrollments"("sequenceId", "phone");
CREATE INDEX IF NOT EXISTS "whatsapp_sequence_enrollments_status_nextAt_idx" ON "whatsapp_sequence_enrollments"("status", "nextAt");
CREATE INDEX IF NOT EXISTS "whatsapp_sequence_enrollments_tenantId_idx" ON "whatsapp_sequence_enrollments"("tenantId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_sequences_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_sequences" ADD CONSTRAINT "whatsapp_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_sequence_enrollments_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_sequence_enrollments" ADD CONSTRAINT "whatsapp_sequence_enrollments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_sequence_enrollments_sequenceId_fkey') THEN
    ALTER TABLE "whatsapp_sequence_enrollments" ADD CONSTRAINT "whatsapp_sequence_enrollments_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "whatsapp_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
