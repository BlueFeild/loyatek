-- ERP: حسابات كل فرع لوحدها، فواتير متقدمة (مرفق، سداد بقيد، تعديل)، ومدة التجربة الافتراضية
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "branchId" TEXT;
CREATE INDEX IF NOT EXISTS "journal_entries_tenantId_date_idx" ON "journal_entries"("tenantId", "date");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_branchId_fkey') THEN
    ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "branchId" TEXT;
ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "paymentJournalEntryId" TEXT;
CREATE INDEX IF NOT EXISTS "vendor_bills_tenantId_issueDate_idx" ON "vendor_bills"("tenantId", "issueDate");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_bills_branchId_fkey') THEN
    ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "vendor_bill_attachments" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendor_bill_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_bill_attachments_billId_key" ON "vendor_bill_attachments"("billId");
CREATE INDEX IF NOT EXISTS "vendor_bill_attachments_tenantId_idx" ON "vendor_bill_attachments"("tenantId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_bill_attachments_billId_fkey') THEN
    ALTER TABLE "vendor_bill_attachments" ADD CONSTRAINT "vendor_bill_attachments_billId_fkey"
      FOREIGN KEY ("billId") REFERENCES "vendor_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "defaultTrialDays" INTEGER NOT NULL DEFAULT 1;

-- الفواتير اللي كانت "مدفوعة" قبل كده: تاريخ السداد = تاريخ الفاتورة (مالهاش قيد سداد قديم)
UPDATE "vendor_bills" SET "paidAt" = "issueDate" WHERE "status" = 'PAID' AND "paidAt" IS NULL;
-- قيود فواتير الإصدار القديمة: فرعها = فرع الفاتورة
UPDATE "journal_entries" je SET "branchId" = i."branchId"
FROM "invoices" i WHERE i."journalEntryId" = je."id" AND je."branchId" IS NULL;
