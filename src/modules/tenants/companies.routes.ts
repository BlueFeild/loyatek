import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth } from "../../middleware/auth";
import { generateUniqueSlug } from "../../utils/slug";
import { signAccessToken } from "../../utils/jwt";
import { trackPlatformEvent } from "../analytics/analytics.service";

// "أكتر من شركة لنفس المالك" - أبسط شكل ممكن: كل شركة إضافية بتاخد
// User حقيقي مستقل جواها (isLinkedCompany: true)، وربط بسيط
// (CompanyMembership) بيوصل بينه وبين حساب الشخص الأساسي. مفيش أي
// تغيير في قاعدة "كل User تابع لشركة واحدة بس" - وده اللي بيخلي ده
// آمن ومتوافق مع باقي عزل البيانات بين الشركات في الباقي كله. الشركة
// الإضافية بتبدأ بتجربة مجانية 24 ساعة زي أي تسجيل جديد، وبعد كده
// السوبر أدمن بيفعّلها/يحاسب عليها بنفس آلية SubscriptionOrder
// الموجودة أصلًا - من غير أي نظام دفع جديد
export const companiesRouter = Router();

companiesRouter.use(requireAuth);

// كل الشركات اللي الشخص الحالي مالكها: شركته الأساسية + أي شركة
// إضافية مربوطة بيه عن طريق CompanyMembership
companiesRouter.get("/my-companies", async (req, res) => {
  const homeTenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { id: true, name: true, slug: true } });
  if (!homeTenant) return res.status(404).json({ error: "Tenant not found" });

  const memberships = await prisma.companyMembership.findMany({
    where: { ownerUserId: req.auth!.userId },
    include: { tenant: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    home: { tenantId: homeTenant.id, name: homeTenant.name, slug: homeTenant.slug },
    companies: memberships.map((m: (typeof memberships)[number]) => ({
      tenantId: m.tenant.id,
      name: m.tenant.name,
      slug: m.tenant.slug,
    })),
  });
});

const createCompanySchema = z.object({
  name: z.string().min(2),
  industry: z.enum(["RETAIL", "SERVICES", "HOSPITALITY", "REAL_ESTATE", "SALONS"]),
});

// إضافة شركة تانية لنفس صاحب الحساب - متاحة بس لمالك (OWNER) عنده
// حساب فعّال بالفعل؛ مقصود إنها بسيطة، الفوترة الفعلية بتتم يدويًا من
// السوبر أدمن زي أي اشتراك عادي (مفيش نظام "extra users" جديد لسه)
companiesRouter.post("/", async (req, res) => {
  if (req.auth!.role !== "OWNER") {
    return res.status(403).json({ error: "Only the owner of a company can add another company" });
  }

  const parsed = createCompanySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ownerUser = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!ownerUser) return res.status(404).json({ error: "User not found" });

  const slug = await generateUniqueSlug(parsed.data.name);
  const trialExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const tenant = await prisma.tenant.create({
    data: {
      name: parsed.data.name,
      industry: parsed.data.industry,
      slug,
      trialExpiresAt,
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

  res.status(201).json({ tenantId: tenant.id, name: tenant.name, slug: tenant.slug });
});

// السويتش من شركة لتانية من نفس المالك - بيطلع توكن حقيقي لليوزر
// (memberUser) بتاع الشركة التانية، بنفس آلية "Manage as this company"
// الموجودة أصلًا، عشان نفضل محافظين على قاعدة إن التوكن دايمًا يوزره
// وتينانته من نفس الشركة فعليًا
companiesRouter.post("/:tenantId/switch", async (req, res) => {
  const membership = await prisma.companyMembership.findUnique({
    where: { ownerUserId_tenantId: { ownerUserId: req.auth!.userId, tenantId: req.params.tenantId } },
    include: { memberUser: true, tenant: { select: { name: true } } },
  });
  if (!membership) return res.status(403).json({ error: "This company isn't linked to your account" });

  const accessToken = signAccessToken({
    userId: membership.memberUser.id,
    tenantId: membership.tenantId,
    role: membership.memberUser.role,
    branchId: membership.memberUser.branchId,
    isSuperAdmin: false,
    impersonatedBy: req.auth!.userId,
  });

  res.json({ accessToken, tenantId: membership.tenantId, tenantName: membership.tenant.name, role: membership.memberUser.role });
});
