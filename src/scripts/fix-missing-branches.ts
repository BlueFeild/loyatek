// سكريبت لإصلاح الشركات اللي اتسجّلت قبل إصلاح إنشاء الفرع التلقائي -
// بيعمل فرع "Main Branch" لأي شركة معندهاش فرع، ويربط كل مستخدميها بيه
// الاستخدام: npm run fix-missing-branches
import { prisma } from "../config/db";

async function main() {
  const tenantsWithoutBranch = await prisma.tenant.findMany({
    where: { branches: { none: {} } },
    include: { users: true },
  });

  if (tenantsWithoutBranch.length === 0) {
    console.log("✔ All tenants already have a branch. Nothing to fix.");
    process.exit(0);
  }

  for (const tenant of tenantsWithoutBranch) {
    const branch = await prisma.branch.create({ data: { tenantId: tenant.id, name: "Main Branch" } });
    await prisma.user.updateMany({
      where: { tenantId: tenant.id, branchId: null },
      data: { branchId: branch.id },
    });
    console.log(`✔ Created "Main Branch" for "${tenant.name}" and linked ${tenant.users.length} user(s).`);
  }

  console.log(`\n✔ Fixed ${tenantsWithoutBranch.length} tenant(s). Log out and log back in for the token to update.`);
  process.exit(0);
}

main();
