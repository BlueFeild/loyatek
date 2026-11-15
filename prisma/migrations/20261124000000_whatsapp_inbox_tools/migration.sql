-- Team Inbox: ردود جاهزة + توزيع المحادثات + رسالة برّه المواعيد + بيانات إضافية للعميل
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "awaySentAt" TIMESTAMP(3);
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3);
ALTER TABLE "whatsapp_contacts" ADD COLUMN IF NOT EXISTS "attributes" JSONB;
ALTER TABLE "whatsapp_contacts" ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE TABLE IF NOT EXISTS "whatsapp_quick_replies" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "shortcut" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_quick_replies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_quick_replies_tenantId_shortcut_key" ON "whatsapp_quick_replies"("tenantId", "shortcut");

CREATE TABLE IF NOT EXISTS "whatsapp_inbox_settings" (
  "tenantId" TEXT NOT NULL,
  "autoAssign" TEXT NOT NULL DEFAULT 'off',
  "assignUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "lastAssignedUserId" TEXT,
  "awayEnabled" BOOLEAN NOT NULL DEFAULT false,
  "awayText" TEXT NOT NULL DEFAULT '',
  "hours" JSONB,
  "timezone" TEXT,
  "awayEveryHours" INTEGER NOT NULL DEFAULT 12,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_inbox_settings_pkey" PRIMARY KEY ("tenantId")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_quick_replies_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_quick_replies" ADD CONSTRAINT "whatsapp_quick_replies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_inbox_settings_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_inbox_settings" ADD CONSTRAINT "whatsapp_inbox_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
