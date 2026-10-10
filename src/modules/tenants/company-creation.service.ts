import { prisma } from "../../config/db";
import { generateUniqueSlug } from "../../utils/slug";
import { trackPlatformEvent } from "../analytics/analytics.service";

// إنشاء شركة إضافية حقيقية لنفس صاحب حساب موجود بالفعل - مشترك بين
// تفعيل طلب "EXTRA_COMPANY" من السوبر أدمن (المسار الوحيد المتاح
// دلوقتي، بعد ما بقى لازم دفع فعلي عن طريق الـ checkout). نفس
// الميكانيزم القديم (User حقيقي مستقل isLinkedCompany:true + ربط
// CompanyMembership) - من غير أي تغيير في قاعدة "كل User تابع لشركة
// واحدة بس"
export async function createLinkedCompany(ownerUserId: string, name: string, industry: string, opts: { free?: boolean } = {}) {
  const ownerUser = await prisma.user.findUnique({ where: { id: ownerUserId } });
  if (!ownerUser) throw new Error("Owner user not found");

  const slug = await generateUniqueSlug(name);
  const trialExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const tenant = await prisma.tenant.create({
    data: {
      name,
      industry: industry as any,
      slug,
      trialExpiresAt,
      ...(opts.free ? { isPlatformOwner: true } : {}),
      users: {
        create: {
          name: ownerUser.name,
          email: ownerUser.email,
          passwordHash: null, // بيدخلها بس عن طريق السويتش، مش بتسجيل دخول منفصل
          role: "OWNER",
          isLinkedCompany: true,
        },
      },
    },
    include: { users: true },
  });

  const branch = await prisma.branch.create({ data: { tenantId: tenant.id, name: "Main Branch" } });
  const memberUser = await prisma.user.update({ where: { id: tenant.users[0].id }, data: { branchId: branch.id } });

  await prisma.companyMembership.create({
    data: { ownerUserId: ownerUser.id, tenantId: tenant.id, memberUserId: memberUser.id },
  });

  await trackPlatformEvent({ type: "SIGNUP", tenantId: tenant.id });

  return tenant;
}
