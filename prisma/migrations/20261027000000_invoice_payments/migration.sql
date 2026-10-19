-- فواتير العملاء: ميعاد سداد + ملاحظات، ودفعات (كاملة أو على أجزاء) كل دفعة بقيدها
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE TABLE IF NOT EXISTS "invoice_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "notes" TEXT,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "invoice_payments_tenantId_idx" ON "invoice_payments"("tenantId");
CREATE INDEX IF NOT EXISTS "invoice_payments_invoiceId_idx" ON "invoice_payments"("invoiceId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_tenantId_fkey') THEN
    ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_invoiceId_fkey') THEN
    ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
