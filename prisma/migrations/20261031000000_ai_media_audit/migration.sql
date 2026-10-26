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
