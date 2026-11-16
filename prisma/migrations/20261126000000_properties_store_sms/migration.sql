-- 3 خدمات جديدة: كتالوج العقارات (properties) + المتجر الإلكتروني (store) + رسايل SMS (sms)
-- جداول جديدة بس (مفيش تعديل على بيانات موجودة)، والأوامر آمنة لو اتشغلت مرتين
-- CreateTable
CREATE TABLE IF NOT EXISTS "property_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandName" TEXT,
    "about" TEXT,
    "logoDataUrl" TEXT,
    "coverDataUrl" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#0f766e',
    "whatsapp" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "showPrices" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "property_listings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'SALE',
    "propertyType" TEXT NOT NULL DEFAULT 'APARTMENT',
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "price" DECIMAL(18,6),
    "rentPeriod" TEXT,
    "areaSqm" INTEGER,
    "bedrooms" INTEGER,
    "bathrooms" INTEGER,
    "parking" INTEGER,
    "furnished" TEXT,
    "location" TEXT,
    "mapUrl" TEXT,
    "description" TEXT,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "property_photos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "property_inquiries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "listingId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "store_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandName" TEXT,
    "tagline" TEXT,
    "about" TEXT,
    "logoDataUrl" TEXT,
    "coverDataUrl" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#111827',
    "template" TEXT NOT NULL DEFAULT 'clean',
    "whatsapp" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "instagram" TEXT,
    "address" TEXT,
    "deliveryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "deliveryFee" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "freeDeliveryOver" DECIMAL(18,6),
    "deliveryAreas" JSONB,
    "pickupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pickupAddress" TEXT,
    "merchantEmail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "store_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "store_products" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(18,6) NOT NULL,
    "comparePrice" DECIMAL(18,6),
    "sku" TEXT,
    "stock" INTEGER,
    "options" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "store_product_photos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_product_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "store_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "fulfillment" TEXT NOT NULL DEFAULT 'DELIVERY',
    "address" TEXT,
    "area" TEXT,
    "items" JSONB NOT NULL,
    "subtotal" DECIMAL(18,6) NOT NULL,
    "deliveryFee" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,6) NOT NULL,
    "currency" TEXT,
    "payableAmount" DECIMAL(18,6),
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "paymentMethodType" TEXT,
    "paymentMethodLabel" TEXT,
    "myFatoorahInvoiceId" TEXT,
    "myFatoorahPaymentUrl" TEXT,
    "trackingUrl" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sms_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "senderName" TEXT,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sms_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audienceTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceMatch" TEXT NOT NULL DEFAULT 'any',
    "recipients" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "sendingAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "total" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "segmentsUsed" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sms_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sms_credit_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "property_settings_tenantId_key" ON "property_settings"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "property_listings_tenantId_status_idx" ON "property_listings"("tenantId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "property_photos_listingId_idx" ON "property_photos"("listingId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "property_inquiries_tenantId_createdAt_idx" ON "property_inquiries"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "store_settings_tenantId_key" ON "store_settings"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "store_categories_tenantId_idx" ON "store_categories"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "store_products_tenantId_active_idx" ON "store_products"("tenantId", "active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "store_product_photos_productId_idx" ON "store_product_photos"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "store_orders_tenantId_createdAt_idx" ON "store_orders"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "store_orders_tenantId_number_key" ON "store_orders"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sms_settings_tenantId_key" ON "sms_settings"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sms_campaigns_tenantId_status_idx" ON "sms_campaigns"("tenantId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sms_messages_tenantId_createdAt_idx" ON "sms_messages"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sms_messages_campaignId_idx" ON "sms_messages"("campaignId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sms_credit_transactions_tenantId_createdAt_idx" ON "sms_credit_transactions"("tenantId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_photos_listingId_fkey') THEN
    ALTER TABLE "property_photos" ADD CONSTRAINT "property_photos_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "property_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_product_photos_productId_fkey') THEN
    ALTER TABLE "store_product_photos" ADD CONSTRAINT "store_product_photos_productId_fkey" FOREIGN KEY ("productId") REFERENCES "store_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

