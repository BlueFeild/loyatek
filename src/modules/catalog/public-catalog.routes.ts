import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { getOrCreateCatalogSettings, createOrder, confirmOrderPaymentIfPaid } from "./catalog.service";
import { isModuleActive } from "../../utils/modules";

// راوتر عام بالكامل - مفيهوش requireAuth خالص، لأن العميل اللي بيسكان
// الـ QR على الترابيزة معندوش حساب ولا هيسجّل دخول. العزل هنا بيتم عن
// طريق الـ slug الفريد لكل شركة بدل التوكن.
export const publicCatalogRouter = Router();

async function findTenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug }, include: { branches: true } });
  // الرابط العام بيشتغل بس لو الكتالوج مشترك فيه فعليًا وماكانش انتهى
  // (مش وقت التجربة المجانية) - عشان محدش يستخدم حساب تجريبي أو اشتراك
  // منتهي كنظام طلبات حقيقي شغال
  if (!tenant || !isModuleActive(tenant, "catalog")) return null;
  return tenant;
}

publicCatalogRouter.get("/:slug/settings", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Menu not found" });

  const settings = await getOrCreateCatalogSettings(tenant.id);
  res.json({ ...settings, brandNameFromTenant: tenant.name });
});

publicCatalogRouter.get("/:slug/categories", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Menu not found" });

  const categories = await prisma.menuCategory.findMany({
    where: { tenantId: tenant.id },
    include: { items: { orderBy: { sortOrder: "asc" } } },
    orderBy: { sortOrder: "asc" },
  });
  res.json(categories);
});

const createOrderSchema = z.object({
  mode: z.enum(["DINE_IN", "PICKUP"]),
  tableLabel: z.string().min(1).optional(),
  readyTime: z.number().int().optional(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  items: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
});

// العميل الحقيقي بيبعت الطلب من هنا - بدون أي توكن، السعر بيتاخد من
// قاعدة البيانات فعليًا نفس منطق النسخة اللي محتاجة تسجيل دخول
publicCatalogRouter.post("/:slug/orders", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Menu not found" });

  const branch = tenant.branches[0];
  if (!branch) return res.status(400).json({ error: "This store has no branch set up yet" });

  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
    const order = await createOrder({
      tenantId: tenant.id,
      branchId: branch.id,
      ...parsed.data,
      redirectionUrlBase: `${frontendBase}/menu/${req.params.slug}`,
    });
    res.status(201).json(order);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// العميل بيرجع من MyFatoorah بعد الدفع - بنتأكد من الحالة الحقيقية
// بالسؤال المباشر لـ MyFatoorah (بمفتاح التاجر)
publicCatalogRouter.get("/:slug/orders/:id/payment-status", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Menu not found" });

  const order = await prisma.catalogOrder.findFirst({ where: { id: req.params.id, tenantId: tenant.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const paymentId = req.query.paymentId as string | undefined;
  if (order.paymentStatus === "AWAITING_PAYMENT" && paymentId) {
    try {
      const updated = await confirmOrderPaymentIfPaid(order.id, paymentId);
      return res.json(updated);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }

  res.json(order);
});
