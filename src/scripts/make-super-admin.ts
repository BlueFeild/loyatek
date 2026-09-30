// سكريبت لتحويل حساب مستخدم موجود لصاحب منصة (Super Admin)
// الاستخدام: npm run make-super-admin -- someone@example.com
import { prisma } from "../config/db";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npm run make-super-admin -- <email>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
  console.log(`✔ ${email} is now a super admin. Log out and log back in to get the updated token.`);
  process.exit(0);
}

main();
