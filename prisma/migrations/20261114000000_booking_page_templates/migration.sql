-- قوالب صفحة الحجز: شكل جاهز + لون + خط + غلاف + صور وتفاصيل الخدمات، وصورة ولقب لكل أخصائي/مكان
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "pageTemplate" TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "pageStyle" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "coverDataUrl" TEXT;
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "heroTitle" TEXT NOT NULL DEFAULT '';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "heroSubtitle" TEXT NOT NULL DEFAULT '';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "serviceDetails" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "photoDataUrl" TEXT;
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "title" TEXT;
