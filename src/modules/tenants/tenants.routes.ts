import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { generateUniqueSlug } from "../../utils/slug";
import { getEffectiveModules } from "../../utils/modules";

export const tenantsRouter = Router();

// كل الراوتس هنا محتاجة تسجيل دخول
tenantsRouter.use(requireAuth);

// جلب بيانات الشركة الحالية + الفروع (معزولة تلقائيًا حسب tenantId من الـ token)
tenantsRouter.get("/me", async (req, res) => {
  let tenant = await prisma.tenant.findUnique({
    where: { id: req.auth!.tenantId },
    include: { branches: true },
  });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  // شركات اتسجّلت قبل ما نضيف الرابط العام - نولّدها أول مرة بيدخلوا فيها
  if (!tenant.slug) {
    const slug = await generateUniqueSlug(tenant.name);
    tenant = await prisma.tenant.update({ where: { id: tenant.id }, data: { slug }, include: { branches: true } });
  }

  const trialActive = Boolean(tenant.trialExpiresAt && tenant.trialExpiresAt > new Date());
  const effectiveModules = getEffectiveModules(tenant);

  res.json({ ...tenant, trialActive, effectiveModules });
});

const createBranchSchema = z.object({
  name: z.string().min(2),
  location: z.string().optional(),
  currency: z.string().min(3).max(3).optional(),
});

// إضافة فرع جديد - يتطلب صلاحية OWNER أو ADMIN فقط
tenantsRouter.post("/branches", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createBranchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const branch = await prisma.branch.create({
    data: {
      tenantId: req.auth!.tenantId, // العزل التلقائي بين الشركات
      name: parsed.data.name,
      location: parsed.data.location,
      currency: parsed.data.currency ?? "USD",
    },
  });
  res.status(201).json(branch);
});

const updateBranchSchema = z.object({
  name: z.string().min(2).optional(),
  location: z.string().optional(),
  currency: z.string().min(3).max(3).optional(),
});

// تعديل بيانات فرع موجود - اسم، موقع، أو عملة مستقلة عن باقي الفروع
tenantsRouter.patch("/branches/:id", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = updateBranchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const branch = await prisma.branch.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!branch) return res.status(404).json({ error: "Branch not found" });

  const updated = await prisma.branch.update({ where: { id: branch.id }, data: parsed.data });
  res.json(updated);
});

tenantsRouter.get("/branches", async (req, res) => {
  const branches = await prisma.branch.findMany({
    where: { tenantId: req.auth!.tenantId },
  });
  res.json(branches);
});

// ملخص حقيقي لكل فرع - مبيعات، عدد موظفين، وقيمة مخزون فعلية، كل واحد
// بعملة فرعه الخاصة (مفيش تحويل عملة تلقائي هنا لأنه محتاج سعر صرف
// حقيقي مباشر مش متوفر عندنا - كل رقم بيتعرض بعملة فرعه الأصلية)
tenantsRouter.get("/branches/summary", async (req, res) => {
  const branches = await prisma.branch.findMany({ where: { tenantId: req.auth!.tenantId } });

  const summary = await Promise.all(
    branches.map(async (b: any) => {
      const [salesAgg, employeeCount, inventoryItems] = await Promise.all([
        prisma.sale.aggregate({ where: { branchId: b.id }, _sum: { totalAmount: true }, _count: true }),
        prisma.employee.count({ where: { branchId: b.id } }),
        prisma.inventoryItem.findMany({ where: { branchId: b.id }, select: { quantity: true, costPrice: true } }),
      ]);

      const inventoryValue = inventoryItems.reduce((sum: number, i: any) => sum + i.quantity * Number(i.costPrice), 0);

      return {
        branchId: b.id,
        name: b.name,
        location: b.location,
        currency: b.currency,
        totalSales: Number(salesAgg._sum.totalAmount ?? 0),
        saleCount: salesAgg._count,
        employeeCount,
        inventoryValue,
      };
    })
  );

  res.json(summary);
});

const updateVatSchema = z.object({ vatNumber: z.string().min(1) });

// تحديث الرقم الضريبي - مطلوب قبل ما تقدري تصدري فاتورة (بيدخل في QR الفاتورة)
tenantsRouter.patch("/vat-number", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = updateVatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tenant = await prisma.tenant.update({
    where: { id: req.auth!.tenantId },
    data: { vatNumber: parsed.data.vatNumber },
  });
  res.json(tenant);
});
