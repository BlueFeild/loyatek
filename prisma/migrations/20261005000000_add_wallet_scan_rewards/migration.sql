-- AlterTable
ALTER TABLE "wallet_settings" ADD COLUMN "rewardText" TEXT NOT NULL DEFAULT 'Free reward';

-- AlterTable
-- الأعمدة الجديدة بتاخد كود عشوائي مختلف لكل صف (بما فيهم العملاء القدام)
ALTER TABLE "wallet_customers" ADD COLUMN "memberCode" TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');

-- CreateTable
CREATE TABLE "wallet_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "delta" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_rewards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),
    "redeemedByName" TEXT,

    CONSTRAINT "wallet_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_customers_memberCode_key" ON "wallet_customers"("memberCode");

-- CreateIndex
CREATE INDEX "wallet_events_tenantId_createdAt_idx" ON "wallet_events"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_events_customerId_idx" ON "wallet_events"("customerId");

-- CreateIndex
CREATE INDEX "wallet_rewards_customerId_status_idx" ON "wallet_rewards"("customerId", "status");

-- CreateIndex
CREATE INDEX "wallet_rewards_tenantId_idx" ON "wallet_rewards"("tenantId");

-- AddForeignKey
ALTER TABLE "wallet_events" ADD CONSTRAINT "wallet_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_events" ADD CONSTRAINT "wallet_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "wallet_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_rewards" ADD CONSTRAINT "wallet_rewards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_rewards" ADD CONSTRAINT "wallet_rewards_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "wallet_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
