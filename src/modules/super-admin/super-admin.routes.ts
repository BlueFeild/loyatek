import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../../config/db";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";
import { computeExpiryDate } from "../../utils/modules";
import { signAccessToken } from "../../utils/jwt";
import { generateUniqueSlug } from "../../utils/slug";
import { getPlatformAnalytics } from "../analytics/analytics.service";

// كل موظفين الأجنسي (BlueField team) بيتسجلوا كـ Users جوه شركة
// داخلية واحدة ثابتة (مش شركة عميل حقيقية) - بننشئها أول مرة لو
// مش موجودة، وبعد كده بنعيد استخدام نفسها
async function getOrCreateAgencyHomeTenant() {
  const existing = await prisma.tenant.findFirst({ where: { slug: "bluefield-agency-team" } });
  if (existing) return existing;
  return prisma.tenant.create({
    data: {
      name: "BlueField Agency Team",
      industry: "SERVICES",
      slug: "bluefield-agency-team",
    },
  });
}

export const superAdminRouter = Router();

superAdminRouter.use(requireAuth, requireSuperAdmin);

// إيرادات حقيقية، أوردرات، وزيارات/تسجيلات/دخول حقيقية على مستوى
// المنصة كلها - آخر 30 يوم + إجمالي كل الوقت
superAdminRouter.get("/analytics", async (_req, res) => {
  const analytics = await getPlatformAnalytics();
  res.json(analytics);
});

// "إدارة نيابة عن شركة عميل" - بيدّي السوبر أدمن توكن حقيقي مربوط
// بشركة العميل نفسها (مش بشركة السوبر أدمن)، عشان أي حاجة يعملها
// (يضيف منيو، يضيف موعد...) تتسجّل فعليًا تحت شركة العميل الصح، مش
// تحت حساب السوبر أدمن بالغلط
superAdminRouter.post("/tenants/:id/impersonate", async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, include: { users: true } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const owner = tenant.users.find((u: (typeof tenant.users)[number]) => u.role === "OWNER") ?? tenant.users[0];
  if (!owner) return res.status(400).json({ error: "This company has no users to manage as" });

  const accessToken = signAccessToken({
    userId: owner.id,
    tenantId: tenant.id,
    role: owner.role,
    branchId: owner.branchId,
    isSuperAdmin: false, // مهم - وقت الانتحال بيتصرف كتاجر عادي، مش سوبر أدمن
    impersonatedBy: req.auth!.userId,
  });

  res.json({ accessToken, tenantId: tenant.id, tenantName: tenant.name, role: owner.role });
});

// قائمة كل الشركات المسجّلة على المنصة - مع كل المستخدمين، الرابط العام،
// وإحصائيات استخدام حقيقية لكل خدمة (مش بس عدد المستخدمين)
superAdminRouter.get("/tenants", async (_req, res) => {
  const tenants = await prisma.tenant.findMany({
    include: {
      users: { orderBy: { createdAt: "asc" } },
      branches: true,
      _count: {
        select: {
          users: true,
          branches: true,
          bookings: true,
          walletCustomers: true,
          catalogOrders: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const result = tenants.map((t: any) => ({
    id: t.id,
    name: t.name,
    industry: t.industry,
    currency: t.currency,
    slug: t.slug,
    subscribedModules: t.subscribedModules,
    moduleExpirations: t.moduleExpirations,
    createdAt: t.createdAt,
    owner: t.users.find((u: any) => u.role === "OWNER")
      ? { name: t.users.find((u: any) => u.role === "OWNER").name, email: t.users.find((u: any) => u.role === "OWNER").email }
      : null,
    users: t.users.map((u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive })),
    userCount: t._count.users,
    branchCount: t._count.branches,
    usage: {
      bookings: t._count.bookings,
      walletCustomers: t._count.walletCustomers,
      catalogOrders: t._count.catalogOrders,
    },
  }));

  res.json(result);
});

const updateUserActiveSchema = z.object({ isActive: z.boolean() });

// تفعيل/تعطيل أي مستخدم في أي شركة - مفيد لو حساب فيه مشكلة أو محتاج توقيف
superAdminRouter.patch("/users/:id/active", async (req, res) => {
  const parsed = updateUserActiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const updated = await prisma.user.update({ where: { id: user.id }, data: { isActive: parsed.data.isActive } });
  res.json({ id: updated.id, isActive: updated.isActive });
});
const updateModulesSchema = z.object({
  subscribedModules: z.array(z.enum(["erp", "booking", "wallet", "whatsapp", "catalog", "linktree"])),
});

// تعديل الموديولات المشترك فيها شركة معيّنة
superAdminRouter.patch("/tenants/:id/modules", async (req, res) => {
  const parsed = updateModulesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const updated = await prisma.tenant.update({
    where: { id: req.params.id },
    data: { subscribedModules: parsed.data.subscribedModules },
  });
  res.json(updated);
});

// رسائل "Let's Talk Business" الحقيقية اللي بعتها زوار الموقع من صفحة Contact
superAdminRouter.get("/contact-messages", async (_req, res) => {
  const messages = await prisma.contactMessage.findMany({ orderBy: { createdAt: "desc" } });
  res.json(messages);
});

// كل طلبات الاشتراك الحقيقية - عشان السوبر أدمن يراجعها ويفعّل الخدمات
// بعد ما يتأكد إن الدفع اتم فعليًا
superAdminRouter.get("/orders", async (_req, res) => {
  const orders = await prisma.subscriptionOrder.findMany({
    include: { tenant: { select: { name: true, slug: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

// تفعيل طلب اشتراك - بيضيف الخدمات المطلوبة لقائمة اشتراكات الشركة
// فعليًا، وميحصلش أوتوماتيك حتى لو الدفع نجح، السوبر أدمن لازم يدوسه بنفسه
superAdminRouter.post("/orders/:id/activate", async (req, res) => {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status === "CANCELLED") return res.status(400).json({ error: "This order was cancelled" });

  const tenant = await prisma.tenant.findUnique({ where: { id: order.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const merged = Array.from(new Set([...tenant.subscribedModules, ...order.selectedModules]));

  // لو الموديول عنده اشتراك سابق لسه شغال، بنمدّ من تاريخ انتهائه (مش
  // من دلوقتي) عشان مالوش ضياع مدة؛ لو منتهي أو مفيش، بنبدأ من دلوقتي
  const existingExpirations = (tenant.moduleExpirations as Record<string, string>) ?? {};
  const nextExpirations: Record<string, string> = { ...existingExpirations };
  for (const moduleId of order.selectedModules) {
    const currentExpiry = existingExpirations[moduleId] ? new Date(existingExpirations[moduleId]) : null;
    const startFrom = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date();
    nextExpirations[moduleId] = computeExpiryDate(order.billingCycle, startFrom).toISOString();
  }

  await prisma.$transaction([
    prisma.tenant.update({
      where: { id: tenant.id },
      data: { subscribedModules: merged, moduleExpirations: nextExpirations },
    }),
    prisma.subscriptionOrder.update({ where: { id: order.id }, data: { status: "ACTIVATED" } }),
  ]);

  res.json({ ok: true, subscribedModules: merged, moduleExpirations: nextExpirations });
});

superAdminRouter.post("/orders/:id/cancel", async (req, res) => {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const updated = await prisma.subscriptionOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
  res.json(updated);
});

// --- Agency Staff (موظفين BlueField اللي بيديروا حسابات عملاء نيابةً عنهم) ---

superAdminRouter.get("/agency-staff", async (_req, res) => {
  const staff = await prisma.user.findMany({
    where: { isAgencyStaff: true },
    include: { agencyAssignments: { include: { clientTenant: { select: { id: true, name: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  res.json(
    staff.map((s: (typeof staff)[number]) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      isActive: s.isActive,
      assignedClients: s.agencyAssignments.map((a: (typeof s.agencyAssignments)[number]) => ({
        tenantId: a.clientTenant.id,
        name: a.clientTenant.name,
      })),
    }))
  );
});

const createAgencyStaffSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

superAdminRouter.post("/agency-staff", async (req, res) => {
  const parsed = createAgencyStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.user.findFirst({ where: { email: parsed.data.email } });
  if (existing) return res.status(400).json({ error: "Email already in use" });

  const homeTenant = await getOrCreateAgencyHomeTenant();
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  const staff = await prisma.user.create({
    data: {
      tenantId: homeTenant.id,
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash,
      role: "STAFF",
      isAgencyStaff: true,
    },
  });

  res.status(201).json({ id: staff.id, name: staff.name, email: staff.email, isActive: staff.isActive, assignedClients: [] });
});

const assignClientSchema = z.object({ tenantId: z.string().uuid() });

superAdminRouter.post("/agency-staff/:id/assign", async (req, res) => {
  const parsed = assignClientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const staff = await prisma.user.findFirst({ where: { id: req.params.id, isAgencyStaff: true } });
  if (!staff) return res.status(404).json({ error: "Agency staff member not found" });

  const tenant = await prisma.tenant.findUnique({ where: { id: parsed.data.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Client company not found" });

  await prisma.agencyAssignment.upsert({
    where: { staffUserId_clientTenantId: { staffUserId: staff.id, clientTenantId: tenant.id } },
    create: { staffUserId: staff.id, clientTenantId: tenant.id },
    update: {},
  });

  res.status(201).json({ ok: true });
});

superAdminRouter.delete("/agency-staff/:id/assign/:tenantId", async (req, res) => {
  await prisma.agencyAssignment.deleteMany({
    where: { staffUserId: req.params.id, clientTenantId: req.params.tenantId },
  });
  res.json({ ok: true });
});
