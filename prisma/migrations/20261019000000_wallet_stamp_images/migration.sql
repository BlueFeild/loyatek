-- أيقونات الأختام: أكتر من صورة مرفوعة + خليط مع الرموز الجاهزة
ALTER TABLE "wallet_settings" ADD COLUMN IF NOT EXISTS "stampIconImages" JSONB NOT NULL DEFAULT '[]';

-- الصورة القديمة الواحدة (stampIconDataUrl) بتتنقل للقايمة الجديدة وبتبقى هي
-- الأيقونة المختارة - بيتعمل مرة واحدة بس (بعدها stampIconDataUrl = NULL)
UPDATE "wallet_settings"
SET "stampIconImages" = jsonb_build_array(jsonb_build_object('id', 'legacy', 'dataUrl', "stampIconDataUrl")),
    "stampGlyph" = 'img:legacy',
    "stampIconDataUrl" = NULL
WHERE "stampIconDataUrl" IS NOT NULL;
