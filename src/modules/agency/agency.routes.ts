import { Router } from "express";
import { prisma } from "../../config/db";
import { requireAuth } from "../../middleware/auth";
import { signAccessToken } from "../../utils/jwt";

export const agencyRouter = Router();

agencyRouter.use(requireAuth);

// شركات العميل المخصّصة لموظف الأجنسي (BlueField team) اللي عمل
// login دلوقتي - مش هيشوف غير اللي اتحدد له بالظبط، عكس السوبر أدمن
// اللي بيشوف كل الشركات المسجّلة على المنصة
agencyRouter.get("/my-clients", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.isAgencyStaff && !req.auth!.isSuperAdmin) {
    return res.status(403).json({ error: "This account isn't set up as agency staff" });
  }

  const assignments = await prisma.agencyAssignment.findMany({
    where: { staffUserId: user.id },
    include: { clientTenant: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "desc" },
  });

  res.json(
    assignments.map((a: (typeof assignments)[number]) => ({
      tenantId: a.clientTenant.id,
      name: a.clientTenant.name,
      slug: a.clientTenant.slug,
    }))
  );
});

// "إدارة نيابة عن شركة عميل" - نفس آلية انتحال السوبر أدمن بالظبط،
// بس هنا مسموحة كمان لموظف أجنسي لو الشركة دي فعليًا متكلّف بيها
// (AgencyAssignment)، مش أي شركة على المنصة زي السوبر أدمن
agencyRouter.post("/tenants/:id/manage", async (req, res) => {
  const isSuperAdmin = req.auth!.isSuperAdmin;

  if (!isSuperAdmin) {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!user?.isAgencyStaff) {
      return res.status(403).json({ error: "You don't have access to manage other companies" });
    }
    const assignment = await prisma.agencyAssignment.findUnique({
      where: { staffUserId_clientTenantId: { staffUserId: user.id, clientTenantId: req.params.id } },
    });
    if (!assignment) {
      return res.status(403).json({ error: "This client isn't assigned to you" });
    }
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, include: { users: true } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const owner = tenant.users.find((u: (typeof tenant.users)[number]) => u.role === "OWNER") ?? tenant.users[0];
  if (!owner) return res.status(400).json({ error: "This company has no users to manage as" });

  const accessToken = signAccessToken({
    userId: owner.id,
    tenantId: tenant.id,
    role: owner.role,
    branchId: owner.branchId,
    isSuperAdmin: false, // مهم - وقت الإدارة نيابةً بيتصرف كتاجر عادي
    impersonatedBy: req.auth!.userId,
  });

  res.json({ accessToken, tenantId: tenant.id, tenantName: tenant.name, role: owner.role });
});
