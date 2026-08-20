-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('STAFF', 'LOCATION');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'PENDING', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "booking_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "industry" TEXT NOT NULL DEFAULT 'salon',
    "brandName" TEXT NOT NULL DEFAULT 'My Business',
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openHour" INTEGER NOT NULL DEFAULT 9,
    "closeHour" INTEGER NOT NULL DEFAULT 21,
    "disabledHours" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "slotDurationMin" INTEGER NOT NULL DEFAULT 60,
    "bufferMin" INTEGER NOT NULL DEFAULT 15,
    "peakFlag" BOOLEAN NOT NULL DEFAULT true,
    "waAutomation" BOOLEAN NOT NULL DEFAULT true,
    "waTemplate" TEXT NOT NULL DEFAULT 'Hi! Your slot is confirmed for today. Show this ticket at check-in — no payment needed in advance.',
    "allocationMode" TEXT NOT NULL DEFAULT 'staff',
    "themeColor" TEXT NOT NULL DEFAULT '#082f49',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_settings_tenantId_key" ON "booking_settings"("tenantId");

-- CreateIndex
CREATE INDEX "resources_tenantId_branchId_idx" ON "resources"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "bookings_tenantId_branchId_idx" ON "bookings"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_resourceId_date_hour_key" ON "bookings"("resourceId", "date", "hour");

-- AddForeignKey
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
