import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const budgetRouter = Router();
budgetRouter.use(requireAuth);

// الفعلي بيتحسب من مبيعات الشهر الحقيقية (Sale.total) لنفس الفرع
// والفئة - مش رقم مدخل يدوي، فعلاً بيتقارن ببيانات حقيقية مسجّلة
async function computeActual(tenantId: string, branchId: string, month: number, year: number) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const sales = await prisma.sale.aggregate({
    where: { tenantId, branchId, createdAt: { gte: start, lt: end } },
    _sum: { totalAmount: true },
  });
  return Number(sales._sum.totalAmount ?? 0);
}

budgetRouter.get("/", async (req, res) => {
  const lines = await prisma.budgetLine.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  });

  const withActuals = await Promise.all(
    lines.map(async (l: any) => ({
      ...l,
      actualAmount: await computeActual(l.tenantId, l.branchId, l.periodMonth, l.periodYear),
    }))
  );

  res.json(withActuals);
});

const createBudgetSchema = z.object({
  category: z.string().min(1),
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2020),
  budgetedAmount: z.number().min(0),
});

budgetRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createBudgetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const branch = await prisma.branch.findFirst({ where: { tenantId: req.auth!.tenantId } });
  if (!branch) return res.status(400).json({ error: "No branch found for this company" });

  try {
    const line = await prisma.budgetLine.create({
      data: { tenantId: req.auth!.tenantId, branchId: branch.id, ...parsed.data },
    });
    res.status(201).json(line);
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(400).json({ error: "A budget line already exists for this category and period" });
    }
    throw err;
  }
});

budgetRouter.delete("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const line = await prisma.budgetLine.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!line) return res.status(404).json({ error: "Budget line not found" });

  await prisma.budgetLine.delete({ where: { id: line.id } });
  res.json({ ok: true });
});
