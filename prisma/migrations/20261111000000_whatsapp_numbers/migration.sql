-- واتساب: أرقام إضافية لنفس الشركة (فرع لكل رقم) + كل رسالة اتبعتت/وصلت على أنهي رقم
CREATE TABLE IF NOT EXISTS "whatsapp_numbers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "branchId" TEXT,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "displayPhoneNumber" TEXT,
    "accessToken" TEXT,
    "isConnected" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "whatsapp_numbers_tenantId_idx" ON "whatsapp_numbers"("tenantId");
CREATE INDEX IF NOT EXISTS "whatsapp_numbers_phoneNumberId_idx" ON "whatsapp_numbers"("phoneNumberId");

ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "phoneNumberId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_numbers_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
