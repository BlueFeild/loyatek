-- قوالب واتساب: رأس فيديو/ملف PDF + سطر تحت الرسالة + لحد 3 أزرار
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "headerType" TEXT;
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "headerMediaDataUrl" TEXT;
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "headerFileName" TEXT;
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "footerText" TEXT;
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "buttons" JSONB;
