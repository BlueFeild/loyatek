-- قوالب واتساب كاروسيل (كروت بصور وأزرار) - النوع + الكروت
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "format" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "cards" JSONB;
