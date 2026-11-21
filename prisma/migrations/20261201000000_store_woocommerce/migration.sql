-- المتجر الإلكتروني زي WooCommerce (2026-11-21): أقسام جوه أقسام، خصائص عامة + قيمها، منتجات متغيّرة
-- (اختيارات بسعر/مخزون/صورة لكل واحد)، تاجز، سعر تخفيض بمواعيد، كوبونات، ضريبة، شكل المتجر، سلايدر.
-- idempotent: ينفع يتشغل أكتر من مرة.

-- ---------- الإعدادات ----------
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "taxEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "taxRate" DECIMAL(9,4) NOT NULL DEFAULT 0;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "taxLabel" TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "taxOnShipping" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "look" JSONB;

-- ---------- الأقسام ----------
ALTER TABLE "store_categories" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
ALTER TABLE "store_categories" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "store_categories" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "store_categories" ADD COLUMN IF NOT EXISTS "imageDataUrl" TEXT;

-- ---------- المنتجات ----------
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "categoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "tagIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'simple';
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "shortDescription" TEXT;
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "salePrice" DECIMAL(18,6);
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "saleStart" TIMESTAMP(3);
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "saleEnd" TIMESTAMP(3);
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "lowStockAt" INTEGER;
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "backorders" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "attributes" JSONB;
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "weightKg" DECIMAL(12,3);
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "lengthCm" DECIMAL(12,2);
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "widthCm" DECIMAL(12,2);
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "heightCm" DECIMAL(12,2);
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "relatedIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "upsellIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "purchaseNote" TEXT;
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "store_products" ADD COLUMN IF NOT EXISTS "soldCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "store_products_tenantId_status_idx" ON "store_products"("tenantId", "status");

-- المنتجات القديمة: القسم الواحد -> قايمة الأقسام
UPDATE "store_products" SET "categoryIds" = ARRAY["categoryId"]
WHERE "categoryId" IS NOT NULL AND cardinality("categoryIds") = 0;

-- المخفي القديم مكانش ينفع يتطلب ولا يتشاف = مسودة (بيفضل مقفول زي ما كان)
UPDATE "store_products" SET "status" = 'DRAFT' WHERE "active" = false AND "status" = 'PUBLISHED';

-- "السعر القديم" (comparePrice) كان هو السعر العادي والـ price هو سعر التخفيض -> نقلبهم لشكل WooCommerce
UPDATE "store_products"
SET "salePrice" = "price", "price" = "comparePrice", "comparePrice" = NULL
WHERE "comparePrice" IS NOT NULL AND "comparePrice" > "price" AND "salePrice" IS NULL;
UPDATE "store_products" SET "comparePrice" = NULL WHERE "comparePrice" IS NOT NULL AND "salePrice" IS NULL;

-- ---------- الاختيارات (variations) ----------
CREATE TABLE IF NOT EXISTS "store_product_variations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "attrs" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "price" DECIMAL(18,6),
    "salePrice" DECIMAL(18,6),
    "saleStart" TIMESTAMP(3),
    "saleEnd" TIMESTAMP(3),
    "sku" TEXT,
    "stock" INTEGER,
    "photoId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_product_variations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_product_variations_productId_signature_key" ON "store_product_variations"("productId", "signature");
CREATE INDEX IF NOT EXISTS "store_product_variations_tenantId_idx" ON "store_product_variations"("tenantId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_product_variations_productId_fkey') THEN
    ALTER TABLE "store_product_variations" ADD CONSTRAINT "store_product_variations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "store_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------- الخصائص العامة + القيم ----------
CREATE TABLE IF NOT EXISTS "store_attributes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "display" TEXT NOT NULL DEFAULT 'button',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_attributes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_attributes_tenantId_slug_key" ON "store_attributes"("tenantId", "slug");

CREATE TABLE IF NOT EXISTS "store_attribute_terms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "imageDataUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_attribute_terms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_attribute_terms_attributeId_slug_key" ON "store_attribute_terms"("attributeId", "slug");
CREATE INDEX IF NOT EXISTS "store_attribute_terms_tenantId_idx" ON "store_attribute_terms"("tenantId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_attribute_terms_attributeId_fkey') THEN
    ALTER TABLE "store_attribute_terms" ADD CONSTRAINT "store_attribute_terms_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "store_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------- التاجز ----------
CREATE TABLE IF NOT EXISTS "store_tags" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_tags_tenantId_slug_key" ON "store_tags"("tenantId", "slug");

-- ---------- الكوبونات ----------
CREATE TABLE IF NOT EXISTS "store_coupons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "minSpend" DECIMAL(18,6),
    "maxUses" INTEGER,
    "maxPerCustomer" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "productIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "categoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "freeShipping" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_coupons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_coupons_tenantId_code_key" ON "store_coupons"("tenantId", "code");

CREATE TABLE IF NOT EXISTS "store_coupon_uses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_coupon_uses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_coupon_uses_couponId_orderId_key" ON "store_coupon_uses"("couponId", "orderId");
CREATE INDEX IF NOT EXISTS "store_coupon_uses_couponId_phoneKey_idx" ON "store_coupon_uses"("couponId", "phoneKey");

-- ---------- السلايدر ----------
CREATE TABLE IF NOT EXISTS "store_banners" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "buttonText" TEXT,
    "link" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_banners_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "store_banners_tenantId_idx" ON "store_banners"("tenantId");

-- ---------- الطلبات ----------
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "discount" DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "couponId" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "couponCode" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "tax" DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "taxLabel" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "merchantNote" TEXT;

-- ---------- الاختيارات القديمة (options) -> خصائص خاصة بالمنتج + كل التوافيق ----------
-- مفتاح كل خاصية خاصة: "c:" + أول 10 حروف من md5(اسمها بالحروف الصغيرة). القيمة = النص نفسه.
-- السعر والمخزون فاضيين في الاختيارات = سعر المنتج والمخزون المشترك بتاعه (نفس اللي كان شغال قبل كده).
UPDATE "store_products" p
SET "attributes" = (
  SELECT jsonb_agg(jsonb_build_object(
           'key', 'c:' || left(md5(lower(o.val->>'name')), 10),
           'name', o.val->>'name',
           'values', o.val->'values',
           'visible', true,
           'forVariations', true) ORDER BY o.ord)
  FROM jsonb_array_elements(p."options") WITH ORDINALITY AS o(val, ord)
),
"type" = 'variable'
WHERE p."options" IS NOT NULL AND jsonb_typeof(p."options") = 'array' AND jsonb_array_length(p."options") > 0
  AND p."attributes" IS NULL AND p."type" = 'simple';

WITH RECURSIVE opts AS (
  SELECT p."id" AS pid, p."tenantId" AS tid, o.ord, 'c:' || left(md5(lower(o.val->>'name')), 10) AS k, o.val->'values' AS vals,
         jsonb_array_length(p."options") AS n
  FROM "store_products" p, jsonb_array_elements(p."options") WITH ORDINALITY AS o(val, ord)
  WHERE p."type" = 'variable' AND p."options" IS NOT NULL AND jsonb_typeof(p."options") = 'array'
    AND NOT EXISTS (SELECT 1 FROM "store_product_variations" v WHERE v."productId" = p."id")
),
combos AS (
  SELECT pid, tid, ord, n, jsonb_build_object(k, v.value) AS attrs, v.ordinality::int AS pos
  FROM opts, jsonb_array_elements_text(vals) WITH ORDINALITY AS v(value, ordinality)
  WHERE ord = 1
  UNION ALL
  SELECT c.pid, c.tid, o.ord, c.n, c.attrs || jsonb_build_object(o.k, v.value), c.pos * 100 + v.ordinality::int
  FROM combos c
  JOIN opts o ON o.pid = c.pid AND o.ord = c.ord + 1
  CROSS JOIN LATERAL jsonb_array_elements_text(o.vals) WITH ORDINALITY AS v(value, ordinality)
)
INSERT INTO "store_product_variations" ("id", "tenantId", "productId", "attrs", "signature", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c.tid, c.pid, c.attrs,
       (SELECT string_agg(e.key || '=' || e.value, '|' ORDER BY e.key) FROM jsonb_each_text(c.attrs) e),
       true, row_number() OVER (PARTITION BY c.pid ORDER BY c.pos)::int, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM combos c
WHERE c.ord = c.n
ON CONFLICT ("productId", "signature") DO NOTHING;

-- خلاص اتنقلت (المنتج المتغيّر بيقرا attributes + variations بس)
UPDATE "store_products" SET "options" = NULL WHERE "type" = 'variable' AND "options" IS NOT NULL AND "attributes" IS NOT NULL;
