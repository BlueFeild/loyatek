-- استوديو الذكاء الاصطناعي: حالة العملية (الفيديو بياخد وقت) + الصور والفيديوهات المتولّدة
ALTER TABLE "ai_generations" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DONE';
ALTER TABLE "ai_generations" ADD COLUMN IF NOT EXISTS "error" TEXT;
ALTER TABLE "ai_generations" ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ai_generations_tenantId_tool_createdAt_idx" ON "ai_generations"("tenantId", "tool", "createdAt");

CREATE TABLE IF NOT EXISTS "ai_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "generationId" TEXT,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ai_assets_tenantId_createdAt_idx" ON "ai_assets"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_assets_generationId_idx" ON "ai_assets"("generationId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_assets_tenantId_fkey') THEN
    ALTER TABLE "ai_assets" ADD CONSTRAINT "ai_assets_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_assets_generationId_fkey') THEN
    ALTER TABLE "ai_assets" ADD CONSTRAINT "ai_assets_generationId_fkey"
      FOREIGN KEY ("generationId") REFERENCES "ai_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- أسعار رسايل واتساب عند Meta (تقديرية، السوبر أدمن يقدر يعدّلها) - عشان التاجر يعرف هيدفع كام لـ Meta
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "whatsappMetaRates" JSONB NOT NULL DEFAULT '{}';

-- نقاط ببلاش لكل شركة جديدة (تجربة استوديو الذكاء الاصطناعي) - السوبر أدمن بيغيّر العدد
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "defaultTrialCredits" INTEGER NOT NULL DEFAULT 20;

-- نقاط اشتراك استوديو الذكاء الاصطناعي (الشهري / السنوي) - السوبر أدمن بيغيّرها
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "aiMonthlyCredits" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "aiYearlyCredits" INTEGER NOT NULL DEFAULT 1200;
