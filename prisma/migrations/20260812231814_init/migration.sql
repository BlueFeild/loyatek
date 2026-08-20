-- CreateEnum
CREATE TYPE "WalletTier" AS ENUM ('SILVER', 'GOLD_VIP', 'PLATINUM');

-- CreateTable
CREATE TABLE "wallet_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'stamp',
    "stampCount" INTEGER NOT NULL DEFAULT 9,
    "pointsRate" INTEGER NOT NULL DEFAULT 10,
    "cashbackPct" INTEGER NOT NULL DEFAULT 5,
    "expirationDays" INTEGER NOT NULL DEFAULT 90,
    "allowOverrides" BOOLEAN NOT NULL DEFAULT true,
    "cardLayout" TEXT NOT NULL DEFAULT 'classic',
    "themeColor" TEXT NOT NULL DEFAULT '#0F172A',
    "logoDataUrl" TEXT,
    "centerLabel" TEXT NOT NULL DEFAULT 'Brand Icon',
    "centerIconDataUrl" TEXT,
    "centerBorderThickness" INTEGER NOT NULL DEFAULT 2,
    "centerRingColor" TEXT NOT NULL DEFAULT '#38BDF8',
    "centerInnerGlow" BOOLEAN NOT NULL DEFAULT true,
    "showDecorCircles" BOOLEAN NOT NULL DEFAULT false,
    "decorCircles" JSONB NOT NULL DEFAULT '[]',
    "termsText" TEXT NOT NULL DEFAULT 'By joining this loyalty program, you agree to receive points, offers, and updates via WhatsApp and SMS. Points expire per the schedule shown on your pass. Loyatek and the merchant may update these terms at any time.',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_customers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "tier" "WalletTier" NOT NULL DEFAULT 'SILVER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVisitAt" TIMESTAMP(3),

    CONSTRAINT "wallet_customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_settings_tenantId_key" ON "wallet_settings"("tenantId");

-- CreateIndex
CREATE INDEX "wallet_customers_tenantId_idx" ON "wallet_customers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_customers_tenantId_phone_key" ON "wallet_customers"("tenantId", "phone");

-- AddForeignKey
ALTER TABLE "wallet_settings" ADD CONSTRAINT "wallet_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_customers" ADD CONSTRAINT "wallet_customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
