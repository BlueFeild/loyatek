-- تدقيق أمني SEC-002: الـ refresh tokens بتتخزن كبصمة sha256 (hex) بدل التوكن نفسه.
-- بيحوّل الصفوف القديمة بس (JWT بيبدأ بـ "eyJ")، فتشغيله أكتر من مرة آمن. محدش بيخرج من حسابه.
UPDATE "refresh_tokens"
SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" LIKE 'eyJ%';

-- توكنات منتهية ملهاش لازمة
DELETE FROM "refresh_tokens" WHERE "expiresAt" < NOW() - INTERVAL '1 day';
