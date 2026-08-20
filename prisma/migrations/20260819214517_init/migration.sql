-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'READY');

-- CreateTable
CREATE TABLE "whatsapp_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metaAccessToken" TEXT,
    "metaPhoneNumberId" TEXT,
    "isConnected" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_flow_nodes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "badge" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "desc" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_flow_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_contact_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_contact_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segmentDesc" TEXT NOT NULL,
    "templateText" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_settings_tenantId_key" ON "whatsapp_settings"("tenantId");

-- CreateIndex
CREATE INDEX "bot_flow_nodes_tenantId_idx" ON "bot_flow_nodes"("tenantId");

-- CreateIndex
CREATE INDEX "whatsapp_contact_notes_tenantId_phone_idx" ON "whatsapp_contact_notes"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_tenantId_idx" ON "whatsapp_campaigns"("tenantId");

-- AddForeignKey
ALTER TABLE "whatsapp_settings" ADD CONSTRAINT "whatsapp_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_flow_nodes" ADD CONSTRAINT "bot_flow_nodes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_contact_notes" ADD CONSTRAINT "whatsapp_contact_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaigns" ADD CONSTRAINT "whatsapp_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
