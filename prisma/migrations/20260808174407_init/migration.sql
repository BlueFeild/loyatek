-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID');

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "leadTimeDays" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "rfq_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_quotes" (
    "id" TEXT NOT NULL,
    "rfqRequestId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "rating" DECIMAL(2,1) NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rfq_requests_tenantId_branchId_idx" ON "rfq_requests"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "rfq_quotes_rfqRequestId_idx" ON "rfq_quotes"("rfqRequestId");

-- AddForeignKey
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_rfqRequestId_fkey" FOREIGN KEY ("rfqRequestId") REFERENCES "rfq_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
