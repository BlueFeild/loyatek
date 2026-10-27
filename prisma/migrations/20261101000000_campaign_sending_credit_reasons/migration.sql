-- حملات واتساب: الإرسال بقى في الخلفية (SENDING) وممكن يفشل كله (FAILED) + آخر تقدم (لو السيرفر اتعاد تشغيله)
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TABLE "whatsapp_campaigns" ADD COLUMN IF NOT EXISTS "sendingAt" TIMESTAMP(3);

-- ملفات الذكاء الاصطناعي: من غير ضغط Postgres عشان قراية جزء من الفيديو (Range) ماتحمّلش الملف كله
-- (بيسري على الملفات الجديدة بس، والقديمة شغالة عادي)
ALTER TABLE "ai_assets" ALTER COLUMN "data" SET STORAGE EXTERNAL;

-- سجل النقاط: النقاط اللي النظام أضافها كانت مسجلة باسم "system" - دلوقتي سبب واضح ومن غير يوزر
UPDATE "credit_transactions" SET "reason" = 'TRIAL', "createdById" = NULL
  WHERE "createdById" = 'system' AND "note" = 'Free trial credits';
UPDATE "credit_transactions" SET "reason" = 'AI_SUBSCRIPTION', "createdById" = NULL
  WHERE "createdById" = 'system' AND "note" LIKE 'AI Studio subscription (order %';
