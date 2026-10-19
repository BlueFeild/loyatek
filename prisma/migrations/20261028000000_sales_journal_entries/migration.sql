-- المبيعات (Record a Sale) بقت بتعمل قيد: مدين الخزنة 1000 / دائن المبيعات 4000.
-- المبيعات القديمة مالهاش قيد (journalEntryId فاضي) وبتفضل محسوبة في الميزانية زي الأول
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "journalEntryId" TEXT;
