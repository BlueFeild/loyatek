import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { getOrCreateCatalogSettings, createOrder } from "./catalog.service";

// راوتر عام بالكامل - مفيهوش requireAuth خالص، لأن العميل اللي بيسكان
// الـ QR على الترابيزة معندوش حساب ولا هيسجّل دخول. العزل هنا بيتم عن
// طريق الـ slug الفريد لكل شركة بدل التوكن.
export const publicCatalogRouter = Router();

async function findTenantBySlug(slug: string) {
  return prisma.tenant.findUnique({ where: { slug }, include: { branches: true } });
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
  tableNumber: z.number().int().optional(),
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
    const order = await createOrder({ tenantId: tenant.id, branchId: branch.id, ...parsed.data });
    res.status(201).json(order);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
