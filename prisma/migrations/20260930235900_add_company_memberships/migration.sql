-- AlterTable
ALTER TABLE "users" ADD COLUMN "isLinkedCompany" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "company_memberships" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_memberships_memberUserId_key" ON "company_memberships"("memberUserId");

-- CreateIndex
CREATE UNIQUE INDEX "company_memberships_ownerUserId_tenantId_key" ON "company_memberships"("ownerUserId", "tenantId");

-- AddForeignKey
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
