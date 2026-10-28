-- صندوق تعليقات ورسايل فيسبوك/انستجرام (idempotent)

CREATE TABLE IF NOT EXISTS "social_messages" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "externalId" TEXT,
  "threadKey" TEXT NOT NULL,
  "parentExternalId" TEXT,
  "postExternalId" TEXT,
  "postCaption" TEXT,
  "authorId" TEXT,
  "authorName" TEXT,
  "text" TEXT NOT NULL,
  "sentById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "social_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_messages_accountId_externalId_key" ON "social_messages"("accountId", "externalId");
CREATE INDEX IF NOT EXISTS "social_messages_tenantId_createdAt_idx" ON "social_messages"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "social_messages_accountId_threadKey_createdAt_idx" ON "social_messages"("accountId", "threadKey", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_messages_tenantId_fkey') THEN
    ALTER TABLE "social_messages" ADD CONSTRAINT "social_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_messages_accountId_fkey') THEN
    ALTER TABLE "social_messages" ADD CONSTRAINT "social_messages_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
