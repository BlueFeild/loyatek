ALTER TABLE "wallet_settings" ADD COLUMN IF NOT EXISTS "stampGlyph" TEXT NOT NULL DEFAULT '';
ALTER TABLE "wallet_settings" ADD COLUMN IF NOT EXISTS "stampIconDataUrl" TEXT;
