import { Router } from "express";
import { prisma } from "../../config/db";
import { requireAuth } from "../../middleware/auth";
import { signAccessToken } from "../../utils/jwt";
import { z } from "zod";
import { createLinkedCompany } from "./company-creation.service";
import { ALL_MODULES } from "../../utils/modules";

// "أكتر من شركة لنفس المالك" - كل شركة إضافية بتاخد User حقيقي مستقل
// جواها (isLinkedCompany: true)، وربط بسيط (CompanyMembership) بيوصل
// بينه وبين حساب الشخص الأساسي. مفيش أي تغيير في قاعدة "كل User تابع
// لشركة واحدة بس" - وده اللي بيخلي ده آمن ومتوافق مع باقي عزل
// البيانات بين الشركات في الباقي كله.
//
// ملحوظة مهمة: إنشاء الشركة الإضافية نفسه بقى بيتم بس عن طريق
// checkout.routes.ts (POST /api/checkout/extra-company-orders) + تفعيل
// السوبر أدمن للطلب بعد التأكد من الدفع - مش من هنا مباشرة؛ الراوتر
// ده دلوقتي بيتعامل بس مع عرض الشركات الموجودة والسويتش بينهم
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

// السوبر أدمن (صاحب المنصة) بيضيف شركة إضافية مجانًا من غير checkout:
// الشركة بتتعلّم isPlatformOwner فكل الخدمات مفتوحة ليها
const freeCompanySchema = z.object({ name: z.string().trim().min(2), industry: z.enum(["RETAIL", "SERVICES", "HOSPITALITY", "REAL_ESTATE", "SALONS"]) });
companiesRouter.post("/free", async (req, res) => {
  if (!req.auth!.isSuperAdmin) return res.status(403).json({ error: "Only the platform owner can add free companies" });
  const parsed = freeCompanySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const tenant = await createLinkedCompany(req.auth!.userId, parsed.data.name, parsed.data.industry, { free: true });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { subscribedModules: [...ALL_MODULES] } });
  res.status(201).json({ tenantId: tenant.id, name: tenant.name });
});
