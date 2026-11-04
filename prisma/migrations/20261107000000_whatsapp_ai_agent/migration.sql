-- واتساب: موظف ذكاء اصطناعي + حالة المحادثات (مفتوحة / محتاجة موظف / اتقفلت، مسؤول، إيقاف الذكاء الاصطناعي)
CREATE TABLE IF NOT EXISTS "whatsapp_ai_agents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "knowledge" TEXT NOT NULL DEFAULT '',
    "dialect" TEXT NOT NULL DEFAULT 'auto',
    "maxRepliesPerHour" INTEGER NOT NULL DEFAULT 8,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_ai_agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_ai_agents_tenantId_key" ON "whatsapp_ai_agents"("tenantId");

CREATE TABLE IF NOT EXISTS "whatsapp_conversations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedToUserId" TEXT,
    "handoffReason" TEXT,
    "aiPausedUntil" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_conversations_tenantId_phone_key" ON "whatsapp_conversations"("tenantId", "phone");
CREATE INDEX IF NOT EXISTS "whatsapp_conversations_tenantId_status_idx" ON "whatsapp_conversations"("tenantId", "status");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_ai_agents_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_ai_agents" ADD CONSTRAINT "whatsapp_ai_agents_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_conversations_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
