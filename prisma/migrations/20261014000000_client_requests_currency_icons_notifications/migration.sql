-- طلبات العميل (2026-10-14)

-- عملة المنيو (USD = نفس العرض القديم بالدولار)
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';

-- أقسام المنيو التجريبي (زرار Add demo menu)
ALTER TABLE "menu_categories" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- أيقونة جنب كل لينك في Link-in-Bio (جاهزة أو صورة مرفوعة)
ALTER TABLE "linktree_links" ADD COLUMN IF NOT EXISTS "icon" TEXT;
ALTER TABLE "linktree_links" ADD COLUMN IF NOT EXISTS "iconDataUrl" TEXT;

-- إشعار التاجر بكل حجز (واتساب على رقمه / إيميل) + إيميل العميل الاختياري
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "merchantWhatsapp" TEXT NOT NULL DEFAULT '';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "merchantEmail" TEXT NOT NULL DEFAULT '';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "waMerchantTemplate" TEXT NOT NULL DEFAULT E'🔔 New booking\n{name} · {phone}\n{resource}\n{date} at {time}';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "askCustomerEmail" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "customerEmail" TEXT;
