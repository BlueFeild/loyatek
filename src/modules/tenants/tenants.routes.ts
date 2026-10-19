import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { periodFilter } from "../../utils/period";
import { getProfitAndLoss } from "../accounting/journal.service";
import { requireAuth, requireRole } from "../../middleware/auth";
import { generateUniqueSlug } from "../../utils/slug";
import { ALL_MODULES, getEffectiveModules, isInGrace, isTrialActive, moduleExpiry } from "../../utils/modules";
import { tenantGraceDays } from "../../utils/platform-config";
import { CURRENCY_CODES, getRates } from "../../utils/money";

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

  // شركة صاحب المنصة (السوبر أدمن): مفيش تجربة - كل حاجة مجانية ودايمة
  const trialActive = isTrialActive(tenant);
  const now = new Date();
  const graceDays = await tenantGraceDays(tenant);
  const effectiveModules = getEffectiveModules(tenant, now, graceDays);
  // خدمات خلص اشتراكها ولسه شغالة في فترة السماح - الفرونت بيعرض تنبيه "جدّد قبل ..."
  const graceModules = ALL_MODULES.filter((m) => isInGrace(tenant!, m, now, graceDays)).map((m) => {
    const exp = moduleExpiry(tenant!, m)!;
    return { module: m, expiredAt: exp, graceEndsAt: new Date(exp.getTime() + graceDays * 86400000) };
  });
  // أسعار الصرف الحالية - الفرونت بيحوّل بيها كل المبالغ (المتخزنة بالدولار)
  // لعملة الشركة، وبيحوّل اللي التاجر بيكتبه لدولار قبل الحفظ
  const rates = await getRates();

  res.json({ ...tenant, trialActive, effectiveModules, graceModules, rates });
});

// عملة الشركة: كل المبالغ في اللوحة والمنيو والحجز والفواتير والرسايل
// بتتعرض بيها (المخزّن نفسه بيفضل بالدولار)
const currencySchema = z.object({ displayCurrency: z.enum(CURRENCY_CODES) });
tenantsRouter.patch("/me/currency", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = currencySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Unsupported currency" });
  const tenant = await prisma.tenant.update({ where: { id: req.auth!.tenantId }, data: { displayCurrency: parsed.data.displayCurrency } });
  res.json({ displayCurrency: tenant.displayCurrency, rates: await getRates() });
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
// حسابات كل فرع لوحدها: مبيعات، إيرادات ومصروفات من القيود (أرباح وخسائر الفرع)،
// وفواتير الموردين اللي لسه مش مدفوعة. ?month=2026-10 = الشهر ده بس
tenantsRouter.get("/branches/summary", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const branches = await prisma.branch.findMany({ where: { tenantId } });
  const period = periodFilter(req.query as Record<string, unknown>);

  const summary = await Promise.all(
    branches.map(async (b: any) => {
      const [salesAgg, employeeCount, inventoryItems, pl, unpaidBills] = await Promise.all([
        prisma.sale.aggregate({ where: { tenantId, branchId: b.id, ...(period ? { createdAt: period } : {}) }, _sum: { totalAmount: true }, _count: true }),
        prisma.employee.count({ where: { branchId: b.id } }),
        prisma.inventoryItem.findMany({ where: { branchId: b.id }, select: { quantity: true, costPrice: true } }),
        getProfitAndLoss(tenantId, { period, branchId: b.id }),
        prisma.vendorBill.aggregate({ where: { tenantId, branchId: b.id, status: { not: "PAID" }, ...(period ? { issueDate: period } : {}) }, _sum: { amount: true }, _count: true }),
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
        revenue: pl.totalRevenue,
        expenses: pl.totalExpenses,
        net: pl.net,
        unpaidBills: Number(unpaidBills._sum.amount ?? 0),
        unpaidBillCount: unpaidBills._count,
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
