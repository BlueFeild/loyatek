import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { computeActual } from "./budget-actuals";

export const budgetRouter = Router();
budgetRouter.use(requireAuth, requireModule("erp"));

// الفعلي بيتحسب حسب نوع البند (مبيعات / حساب في الدليل / فواتير بنفس الفئة) - budget-actuals.ts
budgetRouter.get("/", async (req, res) => {
  const lines = await prisma.budgetLine.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  });

  const accounts = await prisma.account.findMany({
    where: { tenantId: req.auth!.tenantId },
    select: { id: true, code: true, name: true, type: true },
  });
  const withActuals = await Promise.all(
    lines.map(async (l: any) => {
      const { actual, source } = await computeActual(l, accounts);
      return { ...l, actualAmount: actual, actualSource: source };
    })
  );

  res.json(withActuals);
});

const createBudgetSchema = z.object({
  category: z.string().min(1),
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2020),
  budgetedAmount: z.number().min(0),
  // اختياري: فرع معيّن (غير كده أول فرع)
  branchId: z.string().uuid().optional(),
});

budgetRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createBudgetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { branchId, ...data } = parsed.data;
  const branch = await prisma.branch.findFirst({
    where: { tenantId: req.auth!.tenantId, ...(branchId ? { id: branchId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  if (!branch) return res.status(400).json({ error: branchId ? "Branch not found" : "No branch found for this company" });

  try {
    const line = await prisma.budgetLine.create({
      data: { tenantId: req.auth!.tenantId, branchId: branch.id, ...data, category: data.category.trim() },
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
