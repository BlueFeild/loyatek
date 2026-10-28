-- تيك توك: تجديد التوكن + إعدادات البوست لكل منصة (idempotent)
ALTER TABLE "social_accounts" ADD COLUMN IF NOT EXISTS "refreshToken" TEXT;
ALTER TABLE "social_accounts" ADD COLUMN IF NOT EXISTS "refreshExpiresAt" TIMESTAMP(3);
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "options" JSONB;
