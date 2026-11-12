-- حجز الكراسي (مسرح / سينما / VIP) جوه خدمة الحجز
CREATE TABLE IF NOT EXISTS "seat_venues" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "layout" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seat_venues_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "seat_venues_tenantId_idx" ON "seat_venues"("tenantId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_venues_tenantId_fkey') THEN
    ALTER TABLE "seat_venues" ADD CONSTRAINT "seat_venues_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "seat_events" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "venueId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "imageDataUrl" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "layout" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
  "holdMinutes" INTEGER NOT NULL DEFAULT 10,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seat_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "seat_events_tenantId_startsAt_idx" ON "seat_events"("tenantId", "startsAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_events_tenantId_fkey') THEN
    ALTER TABLE "seat_events" ADD CONSTRAINT "seat_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_events_venueId_fkey') THEN
    ALTER TABLE "seat_events" ADD CONSTRAINT "seat_events_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "seat_venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "seat_orders" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'HELD',
  "holdTokenHash" TEXT,
  "holdExpiresAt" TIMESTAMP(3),
  "seatIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "amount" DECIMAL(18,6) NOT NULL DEFAULT 0,
  "customerName" TEXT,
  "customerPhone" TEXT,
  "customerEmail" TEXT,
  "paymentStatus" "PaymentGateStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "paymentMethodType" TEXT,
  "paymentMethodLabel" TEXT,
  "myFatoorahInvoiceId" TEXT,
  "myFatoorahPaymentId" TEXT,
  "myFatoorahPaymentUrl" TEXT,
  "ticketCode" TEXT NOT NULL,
  "checkedInAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seat_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "seat_orders_ticketCode_key" ON "seat_orders"("ticketCode");
CREATE INDEX IF NOT EXISTS "seat_orders_tenantId_eventId_idx" ON "seat_orders"("tenantId", "eventId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_orders_tenantId_fkey') THEN
    ALTER TABLE "seat_orders" ADD CONSTRAINT "seat_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_orders_eventId_fkey') THEN
    ALTER TABLE "seat_orders" ADD CONSTRAINT "seat_orders_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "seat_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "seat_reservations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "seatId" TEXT NOT NULL,
  CONSTRAINT "seat_reservations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "seat_reservations_eventId_seatId_key" ON "seat_reservations"("eventId", "seatId");
CREATE INDEX IF NOT EXISTS "seat_reservations_orderId_idx" ON "seat_reservations"("orderId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_reservations_tenantId_fkey') THEN
    ALTER TABLE "seat_reservations" ADD CONSTRAINT "seat_reservations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_reservations_eventId_fkey') THEN
    ALTER TABLE "seat_reservations" ADD CONSTRAINT "seat_reservations_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "seat_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_reservations_orderId_fkey') THEN
    ALTER TABLE "seat_reservations" ADD CONSTRAINT "seat_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "seat_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
