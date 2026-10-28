-- النشر على السوشيال ميديا: الحسابات المتربطة، ملفات البوستات، البوستات وأهدافها (idempotent)

CREATE TABLE IF NOT EXISTS "social_accounts" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "username" TEXT,
  "pictureUrl" TEXT,
  "parentId" TEXT,
  "accessToken" TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastError" TEXT,
  "connectedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_accounts_tenantId_platform_externalId_key" ON "social_accounts"("tenantId", "platform", "externalId");

CREATE TABLE IF NOT EXISTS "social_media" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "publicKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_media_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_media_publicKey_key" ON "social_media"("publicKey");
CREATE INDEX IF NOT EXISTS "social_media_tenantId_createdAt_idx" ON "social_media"("tenantId", "createdAt");
-- الملفات الكبيرة من غير ضغط (قراءة أجزاء أسرع) زي ai_assets
ALTER TABLE "social_media" ALTER COLUMN "data" SET STORAGE EXTERNAL;

CREATE TABLE IF NOT EXISTS "social_posts" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdById" TEXT,
  "caption" TEXT NOT NULL DEFAULT '',
  "mediaId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "scheduledAt" TIMESTAMP(3),
  "publishingAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "social_posts_status_scheduledAt_idx" ON "social_posts"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "social_posts_tenantId_createdAt_idx" ON "social_posts"("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS "social_post_targets" (
  "id" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "externalPostId" TEXT,
  "permalink" TEXT,
  "error" TEXT,
  "publishedAt" TIMESTAMP(3),
  CONSTRAINT "social_post_targets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_post_targets_postId_accountId_key" ON "social_post_targets"("postId", "accountId");
CREATE INDEX IF NOT EXISTS "social_post_targets_accountId_idx" ON "social_post_targets"("accountId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_accounts_tenantId_fkey') THEN
    ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_media_tenantId_fkey') THEN
    ALTER TABLE "social_media" ADD CONSTRAINT "social_media_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_posts_tenantId_fkey') THEN
    ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_posts_mediaId_fkey') THEN
    ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "social_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_post_targets_postId_fkey') THEN
    ALTER TABLE "social_post_targets" ADD CONSTRAINT "social_post_targets_postId_fkey" FOREIGN KEY ("postId") REFERENCES "social_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_post_targets_accountId_fkey') THEN
    ALTER TABLE "social_post_targets" ADD CONSTRAINT "social_post_targets_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
