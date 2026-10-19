-- فواتير المصروفات كانت بتتسجل على حساب 5000 باسم "General Expenses"، ونفس الكود 5000
-- في دليل الحسابات المبدئي = "Cost of Goods Sold" فالاتنين كانوا بيختلطوا.
-- من دلوقتي الفواتير على 5100 "General Expenses". الـ migration دي بتنقل سطور المصروف
-- بتاعة قيود الفواتير القديمة (مدين 5000) لـ 5100 - من غير ما تغيّر أي مبلغ، فميزان
-- المراجعة بيفضل متوازن. بتتعاد بأمان (idempotent).

-- 1) حساب 5100 لكل شركة عندها قيود فواتير على 5000 (لو مش موجود)
INSERT INTO "accounts" ("id", "tenantId", "code", "name", "type", "createdAt")
SELECT gen_random_uuid()::text, t."tenantId", '5100', 'General Expenses', 'EXPENSE'::"AccountType", CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT je."tenantId"
  FROM "journal_entries" je
  JOIN "journal_entry_lines" l ON l."journalEntryId" = je."id"
  JOIN "accounts" a ON a."id" = l."accountId" AND a."code" = '5000'
  WHERE je."id" IN (SELECT "journalEntryId" FROM "vendor_bills" WHERE "journalEntryId" IS NOT NULL)
     OR je."description" LIKE 'Vendor bill — %'
) t
ON CONFLICT ("tenantId", "code") DO NOTHING;

-- 2) نقل سطور المصروف (مدين 5000) في قيود الفواتير لـ 5100 من نفس الشركة
--    (قيود الفواتير اللي اتمسحت قبل إصلاح المسح بتتعرف من الوصف "Vendor bill — ")
UPDATE "journal_entry_lines" l
SET "accountId" = a5100."id"
FROM "journal_entries" je, "accounts" a5000, "accounts" a5100
WHERE l."journalEntryId" = je."id"
  AND a5000."id" = l."accountId" AND a5000."code" = '5000'
  AND a5100."tenantId" = je."tenantId" AND a5100."code" = '5100' AND a5100."type" = 'EXPENSE'
  AND l."debit" > 0
  AND (
    je."id" IN (SELECT "journalEntryId" FROM "vendor_bills" WHERE "journalEntryId" IS NOT NULL)
    OR je."description" LIKE 'Vendor bill — %'
  );

-- 3) حساب 5000 اللي اتعمل تلقائيًا من الفواتير باسم "General Expenses" ومبقاش عليه
--    أي سطر: يرجع اسمه "Cost of Goods Sold" زي دليل الحسابات. لو التاجر سجّل عليه قيود
--    يدوي بنفسه بنسيبه زي ما هو (منغيّرش معنى قيوده)
UPDATE "accounts" a
SET "name" = 'Cost of Goods Sold'
WHERE a."code" = '5000' AND a."name" = 'General Expenses'
  AND NOT EXISTS (SELECT 1 FROM "journal_entry_lines" l WHERE l."accountId" = a."id");
