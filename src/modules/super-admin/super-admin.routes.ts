import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";

export const superAdminRouter = Router();

superAdminRouter.use(requireAuth, requireSuperAdmin);

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
  subscribedModules: z.array(z.enum(["erp", "booking", "wallet", "whatsapp", "catalog"])),
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

  await prisma.$transaction([
    prisma.tenant.update({ where: { id: tenant.id }, data: { subscribedModules: merged } }),
    prisma.subscriptionOrder.update({ where: { id: order.id }, data: { status: "ACTIVATED" } }),
  ]);

  res.json({ ok: true, subscribedModules: merged });
});

superAdminRouter.post("/orders/:id/cancel", async (req, res) => {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const updated = await prisma.subscriptionOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
  res.json(updated);
});
