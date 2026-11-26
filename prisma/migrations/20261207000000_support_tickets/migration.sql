-- صندوق "محتاج مساعدة؟": رسايل التجار لفريق المنصة + ردود السوبر أدمن
-- (اسم الجداول help_* عشان support_tickets موجود قبل كده لتذاكر عملاء الـ ERP)
CREATE TABLE IF NOT EXISTS "help_tickets" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "subject" VARCHAR(120) NOT NULL,
  "message" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'question',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "pageUrl" VARCHAR(300),
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastFromSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "help_tickets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "help_tickets_tenantId_lastActivityAt_idx" ON "help_tickets"("tenantId", "lastActivityAt");
CREATE INDEX IF NOT EXISTS "help_tickets_status_lastActivityAt_idx" ON "help_tickets"("status", "lastActivityAt");

CREATE TABLE IF NOT EXISTS "help_replies" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "fromSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
  "authorUserId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "help_replies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "help_replies_ticketId_createdAt_idx" ON "help_replies"("ticketId", "createdAt");

-- نوع إشعار جديد: رد من فريق الدعم
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPORT_REPLY';
